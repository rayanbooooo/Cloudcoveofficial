import type { Bar, OptionsFeed, StockFeed } from '@scalp-city/shared';
import { AlpacaHttp, num } from '../../broker/alpaca/AlpacaHttp.js';
import type { StreamStatus, Unsubscribe } from '../../broker/types.js';
import type { Credentials } from '../../config/env.js';
import type { Logger } from '../../core/logger.js';
import type {
  DataStreamName,
  MarketDataProvider,
  OptionChainQuery,
  OptionSnapshot,
  ProviderEvent,
  StockSnapshot,
} from '../types.js';
import { AlpacaDataStream, streamTime, type RawDataMessage } from './AlpacaDataStream.js';

export interface AlpacaMarketDataOptions {
  dataUrl: string;
  dataStreamUrl: string;
  stockFeed: StockFeed;
  optionsFeed: OptionsFeed;
  credentials: Credentials;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = Record<string, any>;

function minuteBar(symbol: string, r: Raw, source: Bar['source']): Bar | null {
  const t = streamTime(r.t);
  const o = num(r.o);
  const h = num(r.h);
  const l = num(r.l);
  const c = num(r.c);
  const v = num(r.v);
  if (t === null || o === null || h === null || l === null || c === null || v === null) return null;
  return { symbol, timeframe: '1Min', t, o, h, l, c, v, n: num(r.n), vw: num(r.vw), final: true, source };
}

function optionSnapshot(symbol: string, r: Raw): OptionSnapshot {
  const q = r.latestQuote ?? {};
  const tr = r.latestTrade ?? {};
  const g = r.greeks;
  return {
    symbol,
    bid: num(q.bp),
    ask: num(q.ap),
    bidSize: num(q.bs),
    askSize: num(q.as),
    quoteTime: streamTime(q.t),
    lastPrice: num(tr.p),
    lastTime: streamTime(tr.t),
    volume: num(r.dailyBar?.v),
    impliedVolatility: num(r.impliedVolatility),
    greeks:
      g && typeof g === 'object'
        ? { delta: num(g.delta) ?? NaN, gamma: num(g.gamma) ?? NaN, theta: num(g.theta) ?? NaN, vega: num(g.vega) ?? NaN, rho: num(g.rho) ?? NaN }
        : null,
  };
}

export class AlpacaMarketDataProvider implements MarketDataProvider {
  readonly name = 'alpaca';
  readonly stockFeed: StockFeed;
  readonly optionsFeed: OptionsFeed;
  private readonly http: AlpacaHttp;
  private readonly stockStream: AlpacaDataStream;
  private readonly optionStream: AlpacaDataStream;
  private handlers = new Set<(e: ProviderEvent) => void>();
  private statusHandlers = new Set<(s: DataStreamName, st: StreamStatus) => void>();
  private started = false;

  constructor(private readonly opts: AlpacaMarketDataOptions) {
    this.stockFeed = opts.stockFeed;
    this.optionsFeed = opts.optionsFeed;
    this.http = new AlpacaHttp({
      baseUrl: opts.dataUrl,
      credentials: opts.credentials,
      logger: opts.logger.child({ component: 'alpaca-data-rest' }),
      requestsPerMinute: 180,
      fetchImpl: opts.fetchImpl,
    });
    this.stockStream = new AlpacaDataStream(
      'alpaca-stock-data',
      `${opts.dataStreamUrl}/v2/${opts.stockFeed}`,
      opts.credentials,
      ['trades', 'quotes', 'bars', 'updatedBars'],
      opts.logger.child({ component: 'alpaca-stock-stream' }),
    );
    this.optionStream = new AlpacaDataStream(
      'alpaca-option-data',
      `${opts.dataStreamUrl}/v1beta1/${opts.optionsFeed}`,
      opts.credentials,
      ['trades', 'quotes'],
      opts.logger.child({ component: 'alpaca-option-stream' }),
    );
    this.stockStream.onMessage((m) => this.handleStock(m));
    this.optionStream.onMessage((m) => this.handleOption(m));
    this.stockStream.onStatus((s) => this.emitStatus('stock', s));
    this.optionStream.onStatus((s) => this.emitStatus('options', s));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stockStream.start();
    // The options stream only connects once there is something to watch,
    // so an account without options data doesn't hold an idle connection.
    if (this.optionStream.symbolCount > 0) this.optionStream.start();
  }

  async stop(): Promise<void> {
    this.started = false;
    await Promise.all([this.stockStream.stop(), this.optionStream.stop()]);
  }

  setStockSubscriptions(symbols: string[]): void {
    this.stockStream.setSymbols(symbols);
  }

  setOptionSubscriptions(contracts: string[]): void {
    this.optionStream.setSymbols(contracts);
    if (this.started && contracts.length > 0) this.optionStream.start();
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
    return { stock: this.stockStream.getStatus(), options: this.optionStream.getStatus() };
  }

  forceReconnect(stream: DataStreamName, reason: string): void {
    (stream === 'stock' ? this.stockStream : this.optionStream).forceReconnect(reason);
  }

  private emitStatus(stream: DataStreamName, s: StreamStatus): void {
    for (const h of this.statusHandlers) h(stream, s);
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

  private handleStock(m: RawDataMessage): void {
    const symbol = typeof m.S === 'string' ? m.S : null;
    if (!symbol) return;
    switch (m.T) {
      case 't': {
        const t = streamTime(m.t);
        const price = num(m.p);
        const size = num(m.s);
        if (t === null || price === null || size === null) return;
        this.emit({
          kind: 'trade',
          symbol,
          t,
          price,
          size,
          exchange: m.x ?? null,
          id: m.i === undefined || m.i === null ? null : String(m.i),
          conditions: Array.isArray(m.c) ? m.c.map(String) : [],
          tape: m.z ?? null,
        });
        return;
      }
      case 'q': {
        const t = streamTime(m.t);
        const bid = num(m.bp);
        const ask = num(m.ap);
        if (t === null || bid === null || ask === null) return;
        this.emit({
          kind: 'quote',
          symbol,
          t,
          bid,
          ask,
          bidSize: num(m.bs) ?? 0,
          askSize: num(m.as) ?? 0,
          bidExchange: m.bx ?? null,
          askExchange: m.ax ?? null,
        });
        return;
      }
      case 'b':
      case 'u': {
        const bar = minuteBar(symbol, m, 'provider');
        if (bar) this.emit({ kind: 'bar', bar, updated: m.T === 'u' });
        return;
      }
      default:
        return;
    }
  }

  private handleOption(m: RawDataMessage): void {
    const symbol = typeof m.S === 'string' ? m.S : null;
    if (!symbol) return;
    const t = streamTime(m.t);
    if (t === null) return;
    if (m.T === 'q') {
      const bid = num(m.bp);
      const ask = num(m.ap);
      if (bid === null || ask === null) return;
      this.emit({ kind: 'option_quote', symbol, t, bid, ask, bidSize: num(m.bs) ?? 0, askSize: num(m.as) ?? 0 });
    } else if (m.T === 't') {
      const price = num(m.p);
      const size = num(m.s);
      if (price === null || size === null) return;
      this.emit({ kind: 'option_trade', symbol, t, price, size });
    }
  }

  async getHistoricalBars(symbols: string[], startMs: number, endMs: number): Promise<Bar[]> {
    const out: Bar[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await this.http.get<{ bars?: Record<string, Raw[]>; next_page_token?: string | null }>('/v2/stocks/bars', {
        symbols: symbols.join(','),
        timeframe: '1Min',
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        limit: 10_000,
        adjustment: 'raw',
        feed: this.stockFeed,
        sort: 'asc',
        page_token: pageToken,
      });
      for (const [sym, rows] of Object.entries(res.bars ?? {})) {
        for (const r of rows ?? []) {
          const b = minuteBar(sym, r, 'historical');
          if (b) out.push(b);
        }
      }
      pageToken = res.next_page_token ?? undefined;
      if (!pageToken) break;
    }
    out.sort((a, b) => a.t - b.t || a.symbol.localeCompare(b.symbol));
    return out;
  }

  async getStockSnapshots(symbols: string[]): Promise<Record<string, StockSnapshot>> {
    const res = await this.http.get<Record<string, Raw | null>>('/v2/stocks/snapshots', {
      symbols: symbols.join(','),
      feed: this.stockFeed,
    });
    const out: Record<string, StockSnapshot> = {};
    for (const [symbol, r] of Object.entries(res ?? {})) {
      if (!r) continue;
      const lt = r.latestTrade;
      const lq = r.latestQuote;
      const ltT = lt ? streamTime(lt.t) : null;
      const lqT = lq ? streamTime(lq.t) : null;
      out[symbol] = {
        symbol,
        prevClose: num(r.prevDailyBar?.c),
        latestTrade: lt && num(lt.p) !== null && ltT !== null ? { price: num(lt.p)!, t: ltT } : null,
        latestQuote:
          lq && num(lq.bp) !== null && num(lq.ap) !== null && lqT !== null ? { bid: num(lq.bp)!, ask: num(lq.ap)!, t: lqT } : null,
      };
    }
    return out;
  }

  async getOptionChain(q: OptionChainQuery): Promise<OptionSnapshot[]> {
    const out: OptionSnapshot[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await this.http.get<{ snapshots?: Record<string, Raw>; next_page_token?: string | null }>(
        `/v1beta1/options/snapshots/${encodeURIComponent(q.underlying)}`,
        {
          feed: this.optionsFeed,
          type: q.type,
          expiration_date_gte: q.expirationDateGte,
          expiration_date_lte: q.expirationDateLte,
          strike_price_gte: q.strikeGte,
          strike_price_lte: q.strikeLte,
          limit: 1000,
          page_token: pageToken,
        },
      );
      for (const [symbol, r] of Object.entries(res.snapshots ?? {})) out.push(optionSnapshot(symbol, r));
      pageToken = res.next_page_token ?? undefined;
      if (!pageToken) break;
    }
    return out;
  }

  async getOptionSnapshots(symbols: string[]): Promise<OptionSnapshot[]> {
    if (symbols.length === 0) return [];
    const res = await this.http.get<{ snapshots?: Record<string, Raw> }>('/v1beta1/options/snapshots', {
      symbols: symbols.join(','),
      feed: this.optionsFeed,
    });
    return Object.entries(res.snapshots ?? {}).map(([s, r]) => optionSnapshot(s, r));
  }
}
