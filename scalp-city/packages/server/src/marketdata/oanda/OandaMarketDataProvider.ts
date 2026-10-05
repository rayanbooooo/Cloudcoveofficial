import type { Bar, OptionsFeed, StockFeed } from '@scalp-city/shared';
import { num, oandaTime, priceTradeable, type Raw } from '../../broker/oanda/mappers.js';
import { OandaHttp } from '../../broker/oanda/OandaHttp.js';
import { OandaStream } from '../../broker/oanda/OandaStream.js';
import type { StreamStatus, Unsubscribe } from '../../broker/types.js';
import type { OandaCredentials } from '../../config/env.js';
import { systemClock, type Clock } from '../../core/clock.js';
import type { Logger } from '../../core/logger.js';
import type { DataStreamName, MarketDataProvider, OptionSnapshot, ProviderEvent, StockSnapshot } from '../types.js';

export interface OandaMarketDataOptions {
  apiUrl: string;
  streamUrl: string;
  credentials: OandaCredentials;
  logger: Logger;
  clock?: Clock;
  fetchImpl?: typeof fetch;
  /** How long after a minute ends the official candle is first requested. */
  candleDelayMs?: number;
}

const MINUTE = 60_000;
const NOT_USED: StreamStatus = { state: 'DISCONNECTED', since: 0, lastMessageAt: null, reconnectAttempts: 0, lastError: 'not used with OANDA' };

/** An OANDA mid candle as a 1-minute bar. Volume is OANDA's count of price updates. */
export function candleToBar(symbol: string, c: Raw, source: Bar['source']): Bar | null {
  const t = oandaTime(c.time);
  const m = c.mid as Raw | undefined;
  const o = num(m?.o);
  const h = num(m?.h);
  const l = num(m?.l);
  const cl = num(m?.c);
  const v = num(c.volume);
  if (t === null || o === null || h === null || l === null || cl === null || v === null) return null;
  return { symbol, timeframe: '1Min', t, o, h, l, c: cl, v, n: v, vw: null, final: true, source };
}

/**
 * OANDA market data: real prices only.
 *
 *  - The pricing stream delivers OANDA's live bid/ask for every instrument.
 *    Each tradeable price becomes a quote plus a mid-price tick (OTC FX/CFDs
 *    have no exchange "last trade"; the mid is labeled as such in the UI).
 *  - The official 1-minute candles (mid, tick volume) are fetched from
 *    OANDA right after each minute closes and replace the live forming bar;
 *    only those official bars drive signals.
 *  - History for indicator warm-up and charts comes from the same candles.
 */
export class OandaMarketDataProvider implements MarketDataProvider {
  readonly name = 'oanda';
  readonly stockFeed: StockFeed = 'oanda';
  readonly optionsFeed: OptionsFeed = 'indicative';
  private readonly http: OandaHttp;
  private readonly stream: OandaStream;
  private readonly clock: Clock;
  private readonly acct: string;
  private symbols: string[] = [];
  private handlers = new Set<(e: ProviderEvent) => void>();
  private statusHandlers = new Set<(s: DataStreamName, st: StreamStatus) => void>();
  private started = false;
  private timer: NodeJS.Timeout | null = null;
  /** Start time of the newest official candle emitted, per instrument. */
  private lastBar = new Map<string, number>();
  /** Minute (start ms) whose candles are still awaited, and when to ask next. */
  private pending: { minute: number; attempt: number; nextAt: number } | null = null;
  private polling = false;

  constructor(private readonly opts: OandaMarketDataOptions) {
    this.clock = opts.clock ?? systemClock;
    this.acct = `/v3/accounts/${encodeURIComponent(opts.credentials.accountId)}`;
    this.http = new OandaHttp({ baseUrl: opts.apiUrl, token: opts.credentials.token, logger: opts.logger.child({ component: 'oanda-data-rest' }), fetchImpl: opts.fetchImpl });
    this.stream = new OandaStream({
      name: 'oanda-pricing',
      url: () => {
        const q = new URLSearchParams({ instruments: this.symbols.join(','), snapshot: 'true' });
        return `${opts.streamUrl}${this.acct}/pricing/stream?${q.toString()}`;
      },
      token: opts.credentials.token,
      logger: opts.logger.child({ component: 'oanda-pricing-stream' }),
      fetchImpl: opts.fetchImpl,
    });
    this.stream.onMessage((m) => this.onPrice(m));
    this.stream.onStatus((s) => {
      for (const h of this.statusHandlers) h('stock', s);
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.symbols.length) this.stream.start();
    this.timer = setInterval(() => void this.tick(), 500);
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.stream.stop();
  }

  setStockSubscriptions(symbols: string[]): void {
    const next = [...new Set(symbols)].sort();
    if (next.join(',') === this.symbols.join(',')) return;
    this.symbols = next;
    if (!this.started) return;
    if (next.length === 0) void this.stream.stop();
    else if (this.stream.getStatus().state === 'DISCONNECTED') this.stream.start();
    else this.stream.forceReconnect('subscription changed');
  }

  setOptionSubscriptions(): void {
    /* no options at OANDA */
  }

  onEvent(handler: (e: ProviderEvent) => void): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onStatus(handler: (stream: DataStreamName, status: StreamStatus) => void): Unsubscribe {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  status(): Record<DataStreamName, StreamStatus> {
    return { stock: this.stream.getStatus(), options: { ...NOT_USED } };
  }

  forceReconnect(stream: DataStreamName, reason: string): void {
    if (stream === 'stock') this.stream.forceReconnect(reason);
  }

  private emit(e: ProviderEvent): void {
    for (const h of this.handlers) {
      try {
        h(e);
      } catch (err) {
        this.opts.logger.error({ err }, 'market data handler failed');
      }
    }
  }

  private onPrice(m: Raw): void {
    if (m.type !== 'PRICE') return; // HEARTBEAT keeps the stream alive; nothing to emit
    const symbol = String(m.instrument ?? '');
    const t = oandaTime(m.time);
    const bid = num(m.bids?.[0]?.price);
    const ask = num(m.asks?.[0]?.price);
    if (!symbol || t === null || bid === null || ask === null) return;
    const tradeable = priceTradeable(m);
    this.emit({
      kind: 'quote',
      symbol,
      t,
      bid,
      ask,
      bidSize: num(m.bids?.[0]?.liquidity) ?? 0,
      askSize: num(m.asks?.[0]?.liquidity) ?? 0,
      bidExchange: null,
      askExchange: null,
      tradeable,
    });
    if (!tradeable) return;
    // One price update = one tick of volume, as in OANDA's own candles.
    this.emit({ kind: 'trade', symbol, t, price: Number(((bid + ask) / 2).toFixed(8)), size: 1, exchange: 'OANDA', id: null, conditions: ['MID'], tape: null });
  }

  // ── Official candles ─────────────────────────────────────────────────────

  /** Exposed for tests: fetch the candles of the minute that just closed. */
  async tick(): Promise<void> {
    if (this.polling || this.symbols.length === 0) return;
    const now = this.clock.now();
    const delay = this.opts.candleDelayMs ?? 1500;
    const closed = Math.floor((now - delay) / MINUTE) * MINUTE - MINUTE; // start of the newest closed minute
    if (!this.pending || closed > this.pending.minute) this.pending = { minute: closed, attempt: 0, nextAt: 0 };
    const p = this.pending;
    if (p.attempt > 4 || now < p.nextAt) return;
    if (this.symbols.every((s) => (this.lastBar.get(s) ?? -1) >= p.minute)) return;
    this.polling = true;
    try {
      let missing = 0;
      for (const s of this.symbols) {
        if ((this.lastBar.get(s) ?? -1) >= p.minute) continue;
        const got = await this.pollSymbol(s, p.minute).catch((err) => {
          this.opts.logger.warn({ symbol: s, err: (err as Error).message }, 'candle poll failed');
          return false;
        });
        if (!got) missing++;
      }
      p.attempt++;
      // A quiet minute can have no candle at all; stop asking after a few tries.
      p.nextAt = missing ? now + 2000 * p.attempt : Number.POSITIVE_INFINITY;
    } finally {
      this.polling = false;
    }
  }

  /** Emit every complete candle newer than the last one sent. True once `minute` is covered. */
  private async pollSymbol(symbol: string, minute: number): Promise<boolean> {
    const r = await this.http.get<Raw>(`/v3/instruments/${encodeURIComponent(symbol)}/candles`, { price: 'M', granularity: 'M1', count: 5 });
    let covered = false;
    for (const c of ((r.candles ?? []) as Raw[]).filter((x) => x.complete === true)) {
      const bar = candleToBar(symbol, c, 'provider');
      if (!bar) continue;
      if (bar.t >= minute) covered = true;
      const last = this.lastBar.get(symbol) ?? -1;
      if (bar.t <= last) continue;
      this.lastBar.set(symbol, bar.t);
      this.emit({ kind: 'bar', bar, updated: false });
    }
    return covered;
  }

  // ── History & snapshots ──────────────────────────────────────────────────

  async getHistoricalBars(symbols: string[], startMs: number, endMs: number): Promise<Bar[]> {
    const out: Bar[] = [];
    for (const symbol of symbols) {
      let from = Math.floor(startMs / MINUTE) * MINUTE;
      for (let page = 0; page < 20 && from < endMs; page++) {
        const r = await this.http.get<Raw>(`/v3/instruments/${encodeURIComponent(symbol)}/candles`, {
          price: 'M',
          granularity: 'M1',
          from: new Date(from).toISOString(),
          count: 5000,
        });
        const bars = ((r.candles ?? []) as Raw[])
          .filter((c) => c.complete === true)
          .map((c) => candleToBar(symbol, c, 'historical'))
          .filter((b): b is Bar => b !== null && b.t < endMs);
        if (bars.length === 0) break;
        out.push(...bars);
        const last = bars[bars.length - 1]!.t;
        this.lastBar.set(symbol, Math.max(this.lastBar.get(symbol) ?? -1, last));
        if (bars.length < 4000) break;
        from = last + MINUTE;
      }
    }
    out.sort((a, b) => a.t - b.t || a.symbol.localeCompare(b.symbol));
    return out;
  }

  async getStockSnapshots(symbols: string[]): Promise<Record<string, StockSnapshot>> {
    const out: Record<string, StockSnapshot> = {};
    if (symbols.length === 0) return out;
    const r = await this.http.get<Raw>(`${this.acct}/pricing`, { instruments: symbols.join(',') });
    for (const p of (r.prices ?? []) as Raw[]) {
      const symbol = String(p.instrument);
      const t = oandaTime(p.time);
      const bid = num(p.bids?.[0]?.price);
      const ask = num(p.asks?.[0]?.price);
      out[symbol] = {
        symbol,
        prevClose: null,
        latestTrade: bid !== null && ask !== null && t !== null ? { price: (bid + ask) / 2, t } : null,
        latestQuote: bid !== null && ask !== null && t !== null ? { bid, ask, t, tradeable: priceTradeable(p) } : null,
      };
    }
    // Previous close: the last complete daily candle (17:00 New York roll, as OANDA's day is defined).
    for (const symbol of symbols) {
      const d = await this.http
        .get<Raw>(`/v3/instruments/${encodeURIComponent(symbol)}/candles`, { price: 'M', granularity: 'D', count: 3, dailyAlignment: 17, alignmentTimezone: 'America/New_York' })
        .catch(() => null);
      const complete = ((d?.candles ?? []) as Raw[]).filter((c) => c.complete === true);
      const prev = complete[complete.length - 1];
      if (prev && out[symbol]) out[symbol]!.prevClose = num((prev.mid as Raw | undefined)?.c);
    }
    return out;
  }

  async getOptionChain(): Promise<OptionSnapshot[]> {
    return [];
  }

  async getOptionSnapshots(): Promise<OptionSnapshot[]> {
    return [];
  }
}
