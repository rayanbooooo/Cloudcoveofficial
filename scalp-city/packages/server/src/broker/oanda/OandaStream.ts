import type { ConnectionState } from '@scalp-city/shared';
import type { Logger } from '../../core/logger.js';
import { oandaErrorMessage } from './OandaHttp.js';
import type { StreamStatus } from '../types.js';

export interface OandaStreamOptions {
  name: string;
  /** Full stream URL; called on every (re)connect so subscriptions can change. */
  url: () => string;
  token: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** OANDA sends a heartbeat every 5s; silence this long means the stream is dead. */
  silenceTimeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * One OANDA streaming endpoint (pricing or transactions): a long-lived HTTP
 * response of newline-delimited JSON. Stays connected like the WebSocket
 * streams do — a silent stream is torn down and rebuilt with exponential
 * backoff and jitter — and publishes its state for the UI and risk engine.
 */
export class OandaStream {
  private stopped = true;
  private attempts = 0;
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private lineHandlers = new Set<(msg: Record<string, unknown>) => void>();
  private statusHandlers = new Set<(s: StreamStatus) => void>();
  private connectedHandlers = new Set<() => void>();
  private nextBackoffFloorMs = 0;
  private wake: (() => void) | null = null;
  private status: StreamStatus = { state: 'DISCONNECTED', since: Date.now(), lastMessageAt: null, reconnectAttempts: 0, lastError: null };

  constructor(private readonly opts: OandaStreamOptions) {}

  getStatus(): StreamStatus {
    return { ...this.status };
  }

  onMessage(cb: (msg: Record<string, unknown>) => void): () => void {
    this.lineHandlers.add(cb);
    return () => this.lineHandlers.delete(cb);
  }

  onStatus(cb: (s: StreamStatus) => void): () => void {
    this.statusHandlers.add(cb);
    return () => this.statusHandlers.delete(cb);
  }

  /** Runs after every successful (re)connect — used to catch up on anything missed. */
  onConnected(cb: () => void): () => void {
    this.connectedHandlers.add(cb);
    return () => this.connectedHandlers.delete(cb);
  }

  private setState(state: ConnectionState, error: string | null = this.status.lastError): void {
    if (state === this.status.state && error === this.status.lastError) return;
    this.status = { ...this.status, state, since: Date.now(), lastError: error, reconnectAttempts: this.attempts };
    this.opts.logger.info({ stream: this.opts.name, state, error: error ?? undefined }, 'stream state');
    for (const h of this.statusHandlers) {
      try {
        h(this.getStatus());
      } catch (err) {
        this.opts.logger.error({ err, stream: this.opts.name }, 'stream status listener failed');
      }
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort?.abort();
    this.wake?.();
    await this.loop?.catch(() => undefined);
    this.loop = null;
    this.setState('DISCONNECTED', null);
  }

  /** Drop the connection and reconnect (silent feed, or a new subscription list). */
  forceReconnect(reason: string): void {
    if (this.stopped) return;
    this.opts.logger.warn({ stream: this.opts.name, reason }, 'forcing reconnect');
    this.attempts = 0;
    this.abort?.abort();
    this.wake?.();
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectOnce();
        if (!this.stopped) throw new Error('stream closed by server');
      } catch (err) {
        if (this.stopped) break;
        this.attempts++;
        const min = this.opts.minBackoffMs ?? 1000;
        const max = this.opts.maxBackoffMs ?? 30_000;
        const base = Math.min(max, min * 2 ** (this.attempts - 1));
        const delay = Math.max(base * (0.8 + Math.random() * 0.4), this.nextBackoffFloorMs);
        this.nextBackoffFloorMs = 0;
        this.status.reconnectAttempts = this.attempts;
        this.setState('RECONNECTING', (err as Error).message);
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, delay);
          this.wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        this.wake = null;
      }
    }
  }

  private async connectOnce(): Promise<void> {
    const ctrl = new AbortController();
    this.abort = ctrl;
    this.setState(this.attempts === 0 ? 'CONNECTING' : 'RECONNECTING');
    const res = await (this.opts.fetchImpl ?? fetch)(this.opts.url(), {
      headers: { Authorization: `Bearer ${this.opts.token}`, Accept: 'application/octet-stream', 'Accept-Datetime-Format': 'RFC3339' },
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* plain text */
      }
      const { message } = oandaErrorMessage(body, res.status);
      if (res.status === 401 || res.status === 403) {
        // Retrying a bad token every second achieves nothing; back off hard.
        this.nextBackoffFloorMs = 60_000;
        throw new Error(`authentication failed (${message})`);
      }
      if (res.status === 400) this.nextBackoffFloorMs = 30_000;
      throw new Error(`HTTP ${res.status}: ${message}`);
    }

    this.attempts = 0;
    this.setState('CONNECTED', null);
    for (const h of this.connectedHandlers) {
      try {
        h();
      } catch (err) {
        this.opts.logger.error({ err, stream: this.opts.name }, 'stream connected handler failed');
      }
    }

    let lastDataAt = Date.now();
    const silence = this.opts.silenceTimeoutMs ?? 20_000;
    const watchdog = setInterval(() => {
      if (Date.now() - lastDataAt > silence) {
        this.status.lastError = `no data or heartbeat for ${Math.round(silence / 1000)}s`;
        ctrl.abort();
      }
    }, 1000);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        lastDataAt = Date.now();
        this.status.lastMessageAt = lastDataAt;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) this.dispatch(line);
        }
      }
    } catch (err) {
      if (ctrl.signal.aborted) throw new Error(this.status.lastError ?? 'stream aborted');
      throw err;
    } finally {
      clearInterval(watchdog);
      reader.releaseLock();
    }
  }

  private dispatch(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.opts.logger.warn({ stream: this.opts.name }, 'non-JSON line ignored');
      return;
    }
    for (const h of this.lineHandlers) {
      try {
        h(msg);
      } catch (err) {
        this.opts.logger.error({ err, stream: this.opts.name }, 'stream message handler failed');
      }
    }
  }
}
