import type { Logger } from '../../core/logger.js';
import { TokenBucket } from '../alpaca/AlpacaHttp.js';
import { BrokerError } from '../types.js';

export interface OandaHttpOptions {
  baseUrl: string;
  /** Personal access token. Sent only as an Authorization header; never logged. */
  token: string;
  logger: Logger;
  /** OANDA allows far more; this keeps polling polite and bounded. */
  requestsPerMinute?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type Query = Record<string, string | number | boolean | undefined | null>;

interface RequestOpts {
  query?: Query;
  body?: unknown;
  timeoutMs?: number;
  /** Retry transient failures. Only ever true for idempotent reads. */
  retry?: boolean;
}

export interface OandaResponse<T> {
  body: T;
  /** Server time from the HTTP Date header (second resolution), if present. */
  date: number | null;
}

/** Pull the most useful explanation out of an OANDA error body. */
export function oandaErrorMessage(body: unknown, status: number): { message: string; code: string | null } {
  const b = (body ?? {}) as Record<string, unknown>;
  const reject = (b.orderRejectTransaction ?? b.orderCancelRejectTransaction ?? b.transaction) as Record<string, unknown> | undefined;
  const reason = typeof reject?.rejectReason === 'string' ? reject.rejectReason : null;
  const code = typeof b.errorCode === 'string' ? b.errorCode : reason;
  const msg = typeof b.errorMessage === 'string' ? b.errorMessage : null;
  if (msg && reason && !msg.includes(reason)) return { message: `${reason}: ${msg}`, code };
  return { message: msg ?? reason ?? `HTTP ${status}`, code };
}

/**
 * OANDA v20 REST client. Reads may be retried; writes never are (an order
 * POST that may have reached OANDA is resolved by its client id instead).
 */
export class OandaHttp {
  private readonly bucket: TokenBucket;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: OandaHttpOptions) {
    const rpm = opts.requestsPerMinute ?? 600;
    this.bucket = new TokenBucket(Math.max(1, Math.floor(rpm / 6)), rpm);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  async get<T>(path: string, query?: Query, opts: Omit<RequestOpts, 'query' | 'body'> = {}): Promise<T> {
    return (await this.request<T>('GET', path, { query, retry: true, ...opts })).body;
  }

  /** GET that also returns the server's Date header (clock checks). */
  getWithDate<T>(path: string, query?: Query): Promise<OandaResponse<T>> {
    return this.request<T>('GET', path, { query, retry: false });
  }

  /** Never retried: a POST that may have reached the broker must be resolved, not repeated. */
  async post<T>(path: string, body: unknown, opts: Omit<RequestOpts, 'body' | 'retry'> = {}): Promise<T> {
    return (await this.request<T>('POST', path, { ...opts, body, retry: false })).body;
  }

  async put<T>(path: string, body?: unknown, opts: Omit<RequestOpts, 'body' | 'retry'> = {}): Promise<T> {
    return (await this.request<T>('PUT', path, { ...opts, body, retry: false })).body;
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

  async request<T>(method: 'GET' | 'POST' | 'PUT', path: string, opts: RequestOpts = {}): Promise<OandaResponse<T>> {
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
        this.opts.logger.warn({ method, path, attempt, kind: err.kind, backoff }, 'oanda request failed; retrying read');
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw lastErr ?? new BrokerError('NETWORK', 'request failed');
  }

  private async once<T>(method: string, path: string, opts: RequestOpts): Promise<OandaResponse<T>> {
    await this.waitForToken();
    const url = this.buildUrl(path, opts.query);
    const started = Date.now();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.token}`,
      Accept: 'application/json',
      'Accept-Datetime-Format': 'RFC3339',
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

    const text = await res.text().catch(() => '');
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const dateHeader = res.headers.get('date');
    const date = dateHeader ? Date.parse(dateHeader) : NaN;
    this.opts.logger.debug({ method, path, status: res.status, durationMs: Date.now() - started }, 'oanda http');

    if (res.ok) return { body: body as T, date: Number.isFinite(date) ? date : null };

    const { message, code } = oandaErrorMessage(body, res.status);
    const meta = { status: res.status, code: null, body };
    if (res.status === 401) throw new BrokerError('AUTH', `OANDA rejected the API token (${message})`, meta);
    if (res.status === 403) throw new BrokerError(method === 'GET' ? 'AUTH' : 'REJECTED', message, meta);
    if (res.status === 404) throw new BrokerError(method === 'GET' ? 'NOT_FOUND' : 'REJECTED', message, meta);
    if (res.status === 429) throw new BrokerError('RATE_LIMITED', message, meta);
    if (res.status >= 500) throw new BrokerError('SERVER', message, meta);
    throw new BrokerError('REJECTED', code && !message.startsWith(code) ? `${code}: ${message}` : message, meta);
  }
}
