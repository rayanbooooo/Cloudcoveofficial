import type { Bar, OptionQuote, OptionsFeed, OptionTrade, Quote, StockFeed, Trade } from '@scalp-city/shared';
import type { StreamStatus, Unsubscribe } from '../broker/types.js';

/** A provider minute bar; `updated` marks a late correction of an already-sent bar. */
export interface ProviderBarEvent {
  kind: 'bar';
  bar: Bar;
  updated: boolean;
}

export type ProviderEvent = Trade | Quote | ProviderBarEvent | OptionQuote | OptionTrade;

export type DataStreamName = 'stock' | 'options';

export interface StockSnapshot {
  symbol: string;
  prevClose: number | null;
  latestTrade: { price: number; t: number } | null;
  latestQuote: { bid: number; ask: number; t: number } | null;
}

export interface OptionSnapshot {
  symbol: string;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  quoteTime: number | null;
  lastPrice: number | null;
  lastTime: number | null;
  /** Today's volume when the provider includes a daily bar, else null. */
  volume: number | null;
  impliedVolatility: number | null;
  greeks: { delta: number; gamma: number; theta: number; vega: number; rho: number } | null;
}

export interface OptionChainQuery {
  underlying: string;
  type?: 'call' | 'put';
  expirationDateGte?: string;
  expirationDateLte?: string;
  strikeGte?: number;
  strikeLte?: number;
}

/**
 * Market data abstraction (spec §71). The strategy engine consumes the
 * normalized events this emits and never sees a provider payload.
 */
export interface MarketDataProvider {
  readonly name: string;
  readonly stockFeed: StockFeed;
  readonly optionsFeed: OptionsFeed;

  start(): void;
  stop(): Promise<void>;
  /** Replace the set of streamed equity symbols (trades, quotes, minute bars). */
  setStockSubscriptions(symbols: string[]): void;
  /** Replace the set of streamed option contracts (quotes, trades). */
  setOptionSubscriptions(contracts: string[]): void;
  onEvent(handler: (e: ProviderEvent) => void): Unsubscribe;
  onStatus(handler: (stream: DataStreamName, status: StreamStatus) => void): Unsubscribe;
  status(): Record<DataStreamName, StreamStatus>;
  forceReconnect(stream: DataStreamName, reason: string): void;

  /** Historical 1-minute bars (ascending) for the given window. */
  getHistoricalBars(symbols: string[], startMs: number, endMs: number): Promise<Bar[]>;
  getStockSnapshots(symbols: string[]): Promise<Record<string, StockSnapshot>>;
  getOptionChain(query: OptionChainQuery): Promise<OptionSnapshot[]>;
  getOptionSnapshots(symbols: string[]): Promise<OptionSnapshot[]>;
}
