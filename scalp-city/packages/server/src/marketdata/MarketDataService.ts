import type {
  Bar,
  MarketDataStatusView,
  OptionQuoteView,
  OptionsFeed,
  StockFeed,
  TradingEnvironment,
} from '@scalp-city/shared';
import type { StreamStatus } from '../broker/types.js';
import type { Clock } from '../core/clock.js';
import type { EventBus } from '../core/eventBus.js';
import type { Logger } from '../core/logger.js';
import type { MarketCalendar } from '../market/MarketCalendar.js';
import { BarStore, type BarEvent } from './BarStore.js';
import type { DataStreamName, MarketDataProvider, ProviderEvent } from './types.js';

/** Bounded set for duplicate suppression. */
export class LruSet {
  private map = new Map<string, true>();
  constructor(private readonly max: number) {}
  /** Returns true if the key was newly added, false if it was already present. */
  add(key: string): boolean {
    if (this.map.has(key)) return false;
    this.map.set(key, true);
    if (this.map.size > this.max) {
      const first = this.map.keys().next().value as string;
      this.map.delete(first);
    }
    return true;
  }
}

export interface SymbolLiveState {
  symbol: string;
  last: number | null;
  lastTradeAt: number | null;
  bid: number | null;
  ask: number | null;
  quoteAt: number | null;
  /** OANDA: broker's tradeable flag on the latest price (null when the feed doesn't say). */
  tradeable: boolean | null;
  /** Latest exchange timestamp of any event for this symbol. */
  lastEventAt: number | null;
  prevClose: number | null;
}

interface OptionLiveState {
  symbol: string;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  quoteAt: number | null;
  last: number | null;
  lastAt: number | null;
}

export interface Freshness {
  lastEventAt: number | null;
  ageMs: number | null;
  stale: boolean;
  reason: string | null;
}

export interface MarketDataServiceOptions {
  env: TradingEnvironment;
  symbols: string[];
  maxDataAgeMs: number;
  maxOptionQuoteAgeMs: number;
  paperAllowIndicativeOptions: boolean;
  /** Grace after a minute ends before our own aggregate is finalized. */
  barGraceMs?: number;
  /** Reconnect a connected stream that has been silent this long during market hours. */
  muteTimeoutMs?: number;
}

export function stockFeedLabel(feed: StockFeed): { label: string; realtime: boolean; partialVolume: boolean; tickVolume: boolean; priceBasis: 'trades' | 'mid' } {
  switch (feed) {
    case 'sip':
      return { label: 'LIVE · SIP', realtime: true, partialVolume: false, tickVolume: false, priceBasis: 'trades' };
    case 'iex':
      return { label: 'LIVE · IEX ONLY', realtime: true, partialVolume: true, tickVolume: false, priceBasis: 'trades' };
    case 'delayed_sip':
      return { label: 'DELAYED 15 MIN', realtime: false, partialVolume: false, tickVolume: false, priceBasis: 'trades' };
    case 'oanda':
      return { label: 'LIVE · OANDA PRICES', realtime: true, partialVolume: false, tickVolume: true, priceBasis: 'mid' };
  }
}

export function optionsFeedLabel(feed: OptionsFeed): { label: string; realtimeNbbo: boolean } {
  return feed === 'opra' ? { label: 'LIVE · OPRA', realtimeNbbo: true } : { label: 'INDICATIVE · NOT NBBO', realtimeNbbo: false };
}

/**
 * Owns the live market picture. Everything here comes from the provider:
 * there is no synthetic price path. When the feed is down, data goes stale
 * and the risk engine refuses new orders (spec §10, §65).
 */
export class MarketDataService {
  private stores = new Map<string, BarStore>();
  private live = new Map<string, SymbolLiveState>();
  private options = new Map<string, OptionLiveState>();
  private optionOwners = new Map<string, Set<string>>();
  private tradeKeys = new LruSet(50_000);
  private quoteKeys = new LruSet(20_000);
  private optionKeys = new LruSet(20_000);
  private timers: NodeJS.Timeout[] = [];
  private offs: (() => void)[] = [];
  private lastStockMessageAt: number | null = null;
  private stockConnectedAt: number | null = null;
  private wasConnected = false;
  private backfilling = false;
  readonly stockFeed: StockFeed;
  readonly optionsFeed: OptionsFeed;

  constructor(
    private readonly provider: MarketDataProvider,
    private readonly calendar: MarketCalendar,
    private readonly bus: EventBus,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly opts: MarketDataServiceOptions,
  ) {
    this.stockFeed = provider.stockFeed;
    this.optionsFeed = provider.optionsFeed;
    for (const s of opts.symbols) {
      this.stores.set(s, new BarStore(s));
      this.live.set(s, { symbol: s, last: null, lastTradeAt: null, bid: null, ask: null, quoteAt: null, tradeable: null, lastEventAt: null, prevClose: null });
    }
  }

  get symbols(): string[] {
    return [...this.stores.keys()];
  }

  /**
   * Stop tracking symbols the broker does not offer this account. They will never have data, so they must not
   * count as stale (which would block trading in the markets that do work). Call before start().
   */
  restrictTo(symbols: string[]): void {
    const keep = new Set(symbols);
    for (const s of [...this.stores.keys()]) {
      if (keep.has(s)) continue;
      this.stores.delete(s);
      this.live.delete(s);
    }
  }

  async start(): Promise<void> {
    this.offs.push(this.provider.onEvent((e) => this.handle(e)));
    this.offs.push(this.provider.onStatus((stream, status) => this.onStreamStatus(stream, status)));
    this.provider.setStockSubscriptions(this.symbols);
    this.provider.start();
    await Promise.allSettled([this.warmUp(), this.loadSnapshots()]);
    this.timers.push(setInterval(() => this.tick(), 1000));
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const off of this.offs) off();
    this.offs = [];
    await this.provider.stop();
  }

  // ── Ingestion ────────────────────────────────────────────────────────────

  /** Exposed for tests; production events arrive via the provider. */
  handle(e: ProviderEvent): void {
    switch (e.kind) {
      case 'trade': {
        const st = this.live.get(e.symbol);
        const store = this.stores.get(e.symbol);
        if (!st || !store) return;
        const key = `${e.symbol}|${e.exchange ?? ''}|${e.id ?? ''}|${e.t}|${e.price}|${e.size}`;
        if (!this.tradeKeys.add(key)) return; // duplicate delivery (e.g. after reconnect)
        this.lastStockMessageAt = this.clock.now();
        if (st.lastTradeAt === null || e.t >= st.lastTradeAt) {
          st.last = e.price;
          st.lastTradeAt = e.t;
        }
        st.lastEventAt = Math.max(st.lastEventAt ?? 0, e.t);
        this.emitBars(store.onTrade(e.price, e.size, e.t));
        this.bus.emit('MARKET_TICK', e);
        return;
      }
      case 'quote': {
        const st = this.live.get(e.symbol);
        if (!st) return;
        // `tradeable` is part of the key: a halt flag flipping on an otherwise identical price must not be dropped as a duplicate.
        const key = `${e.symbol}|${e.t}|${e.bid}|${e.ask}|${e.bidSize}|${e.askSize}|${e.tradeable ?? ''}`;
        if (!this.quoteKeys.add(key)) return;
        this.lastStockMessageAt = this.clock.now();
        if (st.quoteAt === null || e.t >= st.quoteAt) {
          st.bid = e.bid;
          st.ask = e.ask;
          st.quoteAt = e.t;
          if (e.tradeable !== undefined) st.tradeable = e.tradeable;
        }
        st.lastEventAt = Math.max(st.lastEventAt ?? 0, e.t);
        this.bus.emit('MARKET_TICK', e);
        return;
      }
      case 'bar': {
        const store = this.stores.get(e.bar.symbol);
        if (!store) return;
        this.lastStockMessageAt = this.clock.now();
        this.emitBars(store.onProviderBar(e.bar, e.updated));
        return;
      }
      case 'option_quote': {
        const key = `${e.symbol}|${e.t}|${e.bid}|${e.ask}|${e.bidSize}|${e.askSize}`;
        if (!this.optionKeys.add(key)) return;
        const st = this.optionState(e.symbol);
        if (st.quoteAt === null || e.t >= st.quoteAt) {
          st.bid = e.bid;
          st.ask = e.ask;
          st.bidSize = e.bidSize;
          st.askSize = e.askSize;
          st.quoteAt = e.t;
        }
        this.bus.emit('MARKET_TICK', e);
        return;
      }
      case 'option_trade': {
        const key = `${e.symbol}|t|${e.t}|${e.price}|${e.size}`;
        if (!this.optionKeys.add(key)) return;
        const st = this.optionState(e.symbol);
        if (st.lastAt === null || e.t >= st.lastAt) {
          st.last = e.price;
          st.lastAt = e.t;
        }
        this.bus.emit('MARKET_TICK', e);
        return;
      }
    }
  }

  private optionState(symbol: string): OptionLiveState {
    let st = this.options.get(symbol);
    if (!st) {
      st = { symbol, bid: null, ask: null, bidSize: null, askSize: null, quoteAt: null, last: null, lastAt: null };
      this.options.set(symbol, st);
    }
    return st;
  }

  private emitBars(events: BarEvent[]): void {
    for (const ev of events) this.bus.emit('MARKET_BAR', { bar: ev.bar, kind: ev.kind });
  }

  private tick(): void {
    const now = this.clock.now();
    for (const store of this.stores.values()) this.emitBars(store.tick(now, this.opts.barGraceMs ?? 5000));
    // A socket can stay "connected" yet deliver nothing. During market hours
    // that is treated as a failure and the stream is rebuilt.
    const status = this.provider.status().stock;
    const mute = this.opts.muteTimeoutMs ?? 60_000;
    if (
      status.state === 'CONNECTED' &&
      this.calendar.isOpen(now) &&
      this.lastStockMessageAt !== null &&
      this.stockConnectedAt !== null &&
      now - this.lastStockMessageAt > mute &&
      now - this.stockConnectedAt > mute
    ) {
      this.lastStockMessageAt = now;
      this.provider.forceReconnect('stock', `no market data for ${Math.round(mute / 1000)}s during market hours`);
    }
  }

  private onStreamStatus(stream: DataStreamName, status: StreamStatus): void {
    this.bus.emit('MARKET_DATA_STATUS', { stream, status });
    if (stream !== 'stock') return;
    if (status.state === 'CONNECTED') {
      if (this.wasConnected) void this.backfillGap();
      this.wasConnected = true;
      this.stockConnectedAt = this.clock.now();
      this.lastStockMessageAt = this.clock.now();
    } else {
      this.stockConnectedAt = null;
    }
  }

  // ── History ──────────────────────────────────────────────────────────────

  /** Load real historical 1-minute bars so indicators are warm at startup (spec §86). */
  async warmUp(): Promise<void> {
    const now = this.clock.now();
    const sessions = this.calendar.recentSessions(3, now);
    const start = sessions[0]?.openMs ?? now - 4 * 86_400_000;
    try {
      const bars = await this.provider.getHistoricalBars(this.symbols, start, now);
      for (const store of this.stores.values()) {
        const mine = bars.filter((b) => b.symbol === store.symbol && b.t + 60_000 <= now);
        this.emitBars(store.mergeHistorical(mine));
      }
      this.logger.info({ bars: bars.length, from: new Date(start).toISOString() }, 'historical bars loaded');
    } catch (err) {
      this.logger.error({ err: (err as Error).message }, 'historical bar warm-up failed; indicators will warm up from the live feed');
    }
  }

  /** After a reconnect, fetch the bars missed while disconnected. */
  private async backfillGap(): Promise<void> {
    if (this.backfilling) return;
    this.backfilling = true;
    try {
      const now = this.clock.now();
      let from = now - 30 * 60_000;
      for (const s of this.stores.values()) {
        const last = s.lastFinal();
        if (last) from = Math.min(Math.max(from, last.t), now);
      }
      const bars = await this.provider.getHistoricalBars(this.symbols, from, now);
      for (const store of this.stores.values()) {
        this.emitBars(store.mergeHistorical(bars.filter((b) => b.symbol === store.symbol && b.t + 60_000 <= now)));
      }
      this.logger.info({ bars: bars.length }, 'gap backfilled after reconnect');
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'gap backfill failed');
    } finally {
      this.backfilling = false;
    }
  }

  private async loadSnapshots(): Promise<void> {
    try {
      const snaps = await this.provider.getStockSnapshots(this.symbols);
      for (const [symbol, s] of Object.entries(snaps)) {
        const st = this.live.get(symbol);
        if (!st) continue;
        st.prevClose = s.prevClose;
        // Real last prints with their real timestamps — shown with their age, never as "live".
        if (s.latestTrade && (st.lastTradeAt === null || s.latestTrade.t > st.lastTradeAt)) {
          st.last = s.latestTrade.price;
          st.lastTradeAt = s.latestTrade.t;
        }
        if (s.latestQuote && (st.quoteAt === null || s.latestQuote.t > st.quoteAt)) {
          st.bid = s.latestQuote.bid;
          st.ask = s.latestQuote.ask;
          st.quoteAt = s.latestQuote.t;
          if (s.latestQuote.tradeable !== undefined) st.tradeable = s.latestQuote.tradeable;
        }
        const latest = Math.max(st.lastTradeAt ?? 0, st.quoteAt ?? 0);
        if (latest > 0) st.lastEventAt = Math.max(st.lastEventAt ?? 0, latest);
      }
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'snapshot load failed');
    }
  }

  // ── Options ──────────────────────────────────────────────────────────────

  /** Declare which contracts `owner` needs streamed; the union is subscribed. */
  watchOptions(owner: string, contracts: string[]): void {
    if (contracts.length === 0) this.optionOwners.delete(owner);
    else this.optionOwners.set(owner, new Set(contracts));
    const all = new Set<string>();
    for (const set of this.optionOwners.values()) for (const c of set) all.add(c);
    this.provider.setOptionSubscriptions([...all].sort());
  }

  /** Seed an option's quote from a REST snapshot (real data with its real timestamp). */
  seedOptionQuote(symbol: string, q: { bid: number | null; ask: number | null; bidSize: number | null; askSize: number | null; quoteTime: number | null; lastPrice: number | null; lastTime: number | null }): void {
    const st = this.optionState(symbol);
    if (q.quoteTime !== null && (st.quoteAt === null || q.quoteTime > st.quoteAt)) {
      st.bid = q.bid;
      st.ask = q.ask;
      st.bidSize = q.bidSize;
      st.askSize = q.askSize;
      st.quoteAt = q.quoteTime;
    }
    if (q.lastTime !== null && (st.lastAt === null || q.lastTime > st.lastAt)) {
      st.last = q.lastPrice;
      st.lastAt = q.lastTime;
    }
  }

  optionQuote(symbol: string): OptionQuoteView | null {
    const st = this.options.get(symbol);
    if (!st) return null;
    const now = this.clock.now();
    const ageMs = st.quoteAt === null ? null : now - st.quoteAt;
    const mid = st.bid !== null && st.ask !== null && st.bid > 0 && st.ask > 0 ? (st.bid + st.ask) / 2 : null;
    const streaming = this.provider.status().options.state === 'CONNECTED';
    return {
      symbol,
      bid: st.bid,
      ask: st.ask,
      mid,
      last: st.last,
      quoteAt: st.quoteAt,
      ageMs,
      stale: !streaming || ageMs === null || ageMs > this.opts.maxOptionQuoteAgeMs,
    };
  }

  optionQuotes(): OptionQuoteView[] {
    return [...this.options.keys()].map((s) => this.optionQuote(s)!).filter(Boolean);
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  state(symbol: string): SymbolLiveState | null {
    const st = this.live.get(symbol);
    return st ? { ...st } : null;
  }

  freshness(symbol: string): Freshness {
    const st = this.live.get(symbol);
    const now = this.clock.now();
    if (!st) return { lastEventAt: null, ageMs: null, stale: true, reason: `${symbol} is not subscribed` };
    const stream = this.provider.status().stock;
    const ageMs = st.lastEventAt === null ? null : now - st.lastEventAt;
    if (stream.state !== 'CONNECTED') return { lastEventAt: st.lastEventAt, ageMs, stale: true, reason: `market data ${stream.state.toLowerCase()}` };
    if (!stockFeedLabel(this.stockFeed).realtime) return { lastEventAt: st.lastEventAt, ageMs, stale: true, reason: 'feed is delayed' };
    if (ageMs === null) return { lastEventAt: null, ageMs: null, stale: true, reason: 'no data received yet' };
    if (ageMs > this.opts.maxDataAgeMs) return { lastEventAt: st.lastEventAt, ageMs, stale: true, reason: `last event ${(ageMs / 1000).toFixed(1)}s ago` };
    return { lastEventAt: st.lastEventAt, ageMs, stale: false, reason: null };
  }

  /** Closed 1-minute bars plus the forming bar. */
  bars(symbol: string): Bar[] {
    return this.stores.get(symbol)?.all() ?? [];
  }

  finalBars(symbol: string): Bar[] {
    return this.stores.get(symbol)?.finalBars() ?? [];
  }

  formingBar(symbol: string): Bar | null {
    return this.stores.get(symbol)?.formingBar() ?? null;
  }

  streamStatus(): Record<DataStreamName, StreamStatus> {
    return this.provider.status();
  }

  optionsAutotradePolicy(): { allowed: boolean; reason: string | null } {
    const { realtimeNbbo } = optionsFeedLabel(this.optionsFeed);
    if (realtimeNbbo) return { allowed: true, reason: null };
    if (this.opts.env === 'paper' && this.opts.paperAllowIndicativeOptions) {
      return { allowed: true, reason: 'PAPER: trading on indicative (non-NBBO) option quotes by configuration' };
    }
    return { allowed: false, reason: 'OPTIONS DATA UNAVAILABLE — indicative feed is not real-time NBBO; automated options trading blocked' };
  }

  status(): MarketDataStatusView {
    const s = this.provider.status();
    const stock = stockFeedLabel(this.stockFeed);
    const opt = optionsFeedLabel(this.optionsFeed);
    const policy = this.optionsAutotradePolicy();
    const symbols: MarketDataStatusView['symbols'] = {};
    for (const sym of this.symbols) {
      const f = this.freshness(sym);
      symbols[sym] = { lastEventAt: f.lastEventAt, ageMs: f.ageMs, stale: f.stale };
    }
    return {
      stock: { ...s.stock },
      options: { ...s.options },
      stockFeed: this.stockFeed,
      stockFeedLabel: stock.label,
      stockRealtime: stock.realtime,
      stockPartialVolume: stock.partialVolume,
      optionsFeed: this.optionsFeed,
      optionsFeedLabel: opt.label,
      optionsRealtimeNbbo: opt.realtimeNbbo,
      optionsAutotradeAllowed: policy.allowed,
      optionsBlockReason: policy.allowed ? null : policy.reason,
      tickVolume: stock.tickVolume,
      priceBasis: stock.priceBasis,
      maxDataAgeMs: this.opts.maxDataAgeMs,
      symbols,
    };
  }
}
