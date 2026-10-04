import { decode, encode } from '@msgpack/msgpack';
import type { Credentials } from '../../config/env.js';
import type { Logger } from '../../core/logger.js';
import { ReconnectingStream } from '../../core/ReconnectingStream.js';

export type Channel = 'trades' | 'quotes' | 'bars' | 'updatedBars';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type RawDataMessage = Record<string, any>;

/**
 * Alpaca market data WebSocket (stocks: /v2/{feed}, options: /v1beta1/{feed}).
 * Speaks msgpack — required for options and supported for stocks — so one
 * code path serves both. Re-sends the full subscription set after every
 * reconnect.
 */
export class AlpacaDataStream extends ReconnectingStream {
  private desired: Record<Channel, Set<string>>;
  private authenticated = false;
  private handlers = new Set<(m: RawDataMessage) => void>();

  constructor(
    name: string,
    url: string,
    private readonly credentials: Credentials,
    private readonly channels: readonly Channel[],
    logger: Logger,
  ) {
    super({
      name,
      url,
      logger,
      headers: { 'Content-Type': 'application/msgpack' },
      minBackoffMs: 1000,
      maxBackoffMs: 30_000,
    });
    this.desired = { trades: new Set(), quotes: new Set(), bars: new Set(), updatedBars: new Set() };
  }

  onMessage(handler: (m: RawDataMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Replace the subscribed symbol set on every configured channel. */
  setSymbols(symbols: string[]): void {
    const next = new Set(symbols);
    const add: string[] = [];
    const remove: string[] = [];
    const current = this.desired[this.channels[0]!];
    for (const s of next) if (!current.has(s)) add.push(s);
    for (const s of current) if (!next.has(s)) remove.push(s);
    for (const ch of this.channels) this.desired[ch] = new Set(next);
    if (!this.authenticated) return;
    if (add.length) this.sendAction('subscribe', add);
    if (remove.length) this.sendAction('unsubscribe', remove);
  }

  get symbolCount(): number {
    return this.desired[this.channels[0]!].size;
  }

  private sendAction(action: 'subscribe' | 'unsubscribe', symbols: string[]): void {
    const msg: Record<string, unknown> = { action };
    for (const ch of this.channels) msg[ch] = symbols;
    this.send(encode(msg));
  }

  protected onOpen(): void {
    this.authenticated = false;
    // The server greets with {T:"success",msg:"connected"}; auth is sent on that.
  }

  protected onData(data: Buffer, isBinary: boolean): void {
    let msgs: unknown;
    try {
      msgs = isBinary ? decode(data) : JSON.parse(data.toString('utf8'));
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'data stream: undecodable frame ignored');
      return;
    }
    if (!Array.isArray(msgs)) msgs = [msgs];
    for (const m of msgs as RawDataMessage[]) {
      if (!m || typeof m !== 'object') continue;
      switch (m.T) {
        case 'success':
          if (m.msg === 'connected') {
            this.send(encode({ action: 'auth', key: this.credentials.keyId, secret: this.credentials.secretKey }));
          } else if (m.msg === 'authenticated') {
            this.authenticated = true;
            const symbols = [...this.desired[this.channels[0]!]];
            if (symbols.length) this.sendAction('subscribe', symbols);
            else this.markReady();
          }
          break;
        case 'subscription':
          this.markReady();
          break;
        case 'error':
          this.handleError(Number(m.code), String(m.msg ?? 'error'));
          break;
        default:
          for (const h of this.handlers) {
            try {
              h(m);
            } catch (err) {
              this.log.error({ err }, 'data stream handler failed');
            }
          }
      }
    }
  }

  private handleError(code: number, msg: string): void {
    this.log.error({ stream: this.opts.name, code, msg }, 'data stream error');
    this.status.lastError = `${code}: ${msg}`;
    switch (code) {
      case 402: // auth failed
      case 401:
      case 404: // auth timeout
        this.nextBackoffFloorMs = 30_000;
        this.ws?.close(4000 + code, msg);
        break;
      case 406: // connection limit exceeded — a stale session may still hold the slot
        this.nextBackoffFloorMs = 15_000;
        this.ws?.close(4406, msg);
        break;
      case 409: // insufficient subscription — retrying cannot fix this
        this.fatalError = `insufficient subscription for this feed (${msg}). Check ALPACA_STOCK_FEED / ALPACA_OPTIONS_FEED against your Alpaca data plan.`;
        this.ws?.close(4409, msg);
        break;
      default:
        break;
    }
  }
}

/** msgpack timestamps decode to Date; JSON frames carry RFC3339 strings. */
export function streamTime(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}
