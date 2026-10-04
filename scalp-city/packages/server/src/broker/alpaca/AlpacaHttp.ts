import type { Credentials } from '../../config/env.js';
import type { Clock } from '../../core/clock.js';
import { systemClock } from '../../core/clock.js';
import type { Logger } from '../../core/logger.js';
import { BrokerError } from '../types.js';

/** Token bucket so polling can never exceed the broker's request budget (spec §67). */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly perMs: number;

  constructor(
    private readonly capacity: number,
    perMinute: number,
    private readonly clock: Clock = systemClock,
  ) {
    this.tokens = capacity;
    this.perMs = perMinute / 60_000;
    this.last = clock.now();
  }

  private refill(): void {
    const now = this.clock.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.perMs);
    this.last = now;
  }

  /** Milliseconds to wait before a token is available (0 = take one now). */
  take(): number {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - this.tokens) / this.perMs);
  }
}

export interface AlpacaHttpOptions {
  baseUrl: string;
  credentials: Credentials;
  logger: Logger;
  requestsPerMinute: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type Query = Record<string, string | number | boolean | undefined | null>;

interface RequestOpts {
  query?: Query;
  body?: unknown;
  timeoutMs?: number;
  /** Retry on transient failures. Only ever true for idempotent reads. */
  retry?: boolean;
}

export class AlpacaHttp {
  private readonly bucket: TokenBucket;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: AlpacaHttpOptions) {
    this.bucket = new TokenBucket(Math.max(1, Math.floor(opts.requestsPerMinute / 4)), opts.requestsPerMinute);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  get<T>(path: string, query?: Query, opts: Omit<RequestOpts, 'query' | 'body'> = {}): Promise<T> {
    return this.request<T>('GET', path, { query, retry: true, ...opts });
  }

  /** Never retried: a POST that may have reached the broker must be resolved, not repeated. */
  post<T>(path: string, body: unknown, opts: Omit<RequestOpts, 'body' | 'retry'> = {}): Promise<T> {
    return this.request<T>('POST', path, { ...opts, body, retry: false });
  }

  delete<T>(path: string, opts: Omit<RequestOpts, 'body'> = {}): Promise<T> {
    return this.request<T>('DELETE', path, { retry: false, ...opts });
  }

  private async waitForToken(): Promise<void> {
    for (;;) {
      const wait = this.bucket.take();
      if (wait === 0) return;
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  private buildUrl(path: string, query?: Query): string {
    const url = new URL(this.opts.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  async request<T>(method: 'GET' | 'POST' | 'DELETE' | 'PATCH', path: string, opts: RequestOpts = {}): Promise<T> {
    const maxAttempts = opts.retry ? 3 : 1;
    let lastErr: BrokerError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.once<T>(method, path, opts);
      } catch (err) {
        if (!(err instanceof BrokerError)) throw err;
        lastErr = err;
        const transient = err.kind === 'NETWORK' || err.kind === 'TIMEOUT' || err.kind === 'SERVER' || err.kind === 'RATE_LIMITED';
        if (!opts.retry || !transient || attempt === maxAttempts) throw err;
        const backoff = err.kind === 'RATE_LIMITED' ? 2000 * attempt : 400 * 2 ** (attempt - 1);
        this.opts.logger.warn({ method, path, attempt, kind: err.kind, backoff }, 'alpaca request failed; retrying read');
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw lastErr ?? new BrokerError('NETWORK', 'request failed');
  }

  private async once<T>(method: string, path: string, opts: RequestOpts): Promise<T> {
    await this.waitForToken();
    const url = this.buildUrl(path, opts.query);
    const started = Date.now();
    const headers: Record<string, string> = {
      'APCA-API-KEY-ID': this.opts.credentials.keyId,
      'APCA-API-SECRET-KEY': this.opts.credentials.secretKey,
      Accept: 'application/json',
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      const timeout = e.name === 'TimeoutError' || e.name === 'AbortError';
      throw new BrokerError(timeout ? 'TIMEOUT' : 'NETWORK', `${method} ${path}: ${timeout ? 'timed out' : e.message}`);
    }

    const durationMs = Date.now() - started;
    const text = await res.text().catch(() => '');
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    this.opts.logger.debug({ method, path, status: res.status, durationMs }, 'alpaca http');

    if (res.ok) return body as T;

    const b = (body ?? {}) as { message?: string; code?: number };
    const message = typeof b === 'object' && b && typeof b.message === 'string' ? b.message : `HTTP ${res.status}`;
    const code = typeof b === 'object' && b && typeof b.code === 'number' ? b.code : null;
    const meta = { status: res.status, code, body };
    if (res.status === 401) throw new BrokerError('AUTH', message, meta);
    if (res.status === 403) {
      // On reads a 403 means our credentials can't access the resource; on
      // writes it is a business rejection (e.g. insufficient buying power).
      throw new BrokerError(method === 'GET' ? 'AUTH' : 'REJECTED', message, meta);
    }
    if (res.status === 404) throw new BrokerError('NOT_FOUND', message, meta);
    if (res.status === 429) throw new BrokerError('RATE_LIMITED', message, meta);
    if (res.status >= 500) throw new BrokerError('SERVER', message, meta);
    throw new BrokerError('REJECTED', message, meta);
  }
}

/** Parse Alpaca's numeric strings; missing or malformed values become null, never 0. */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function ts(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.getTime();
  const n = Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
}
