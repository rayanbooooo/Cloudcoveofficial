import type { Timeframe } from './domain.js';

/**
 * Normalized market data (spec §72). Provider adapters convert their wire
 * formats into these shapes; nothing downstream knows about Alpaca payloads.
 *
 * All timestamps are epoch milliseconds (UTC) taken from the provider's own
 * event timestamp — never from the receiving clock.
 */

export interface Trade {
  kind: 'trade';
  symbol: string;
  /** Exchange event time (ms). */
  t: number;
  price: number;
  size: number;
  exchange: string | null;
  /** Provider trade id, used for duplicate suppression. */
  id: string | null;
  conditions: string[];
  tape: string | null;
}

export interface Quote {
  kind: 'quote';
  symbol: string;
  t: number;
  bid: number;
  bidSize: number;
  ask: number;
  askSize: number;
  bidExchange: string | null;
  askExchange: string | null;
}

export interface Bar {
  symbol: string;
  timeframe: Timeframe;
  /** Bar start time (ms). */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** Number of trades, when the provider reports it. */
  n: number | null;
  /** Volume-weighted average price of the bar, when the provider reports it. */
  vw: number | null;
  /**
   * `true` once the bar interval has closed and the provider's official bar
   * has been applied (or the interval ended and no official bar is expected).
   */
  final: boolean;
  source: 'provider' | 'aggregated' | 'historical';
}

export interface OptionQuote {
  kind: 'option_quote';
  /** OCC contract symbol, e.g. QQQ251017C00600000 */
  symbol: string;
  t: number;
  bid: number;
  bidSize: number;
  ask: number;
  askSize: number;
}

export interface OptionTrade {
  kind: 'option_trade';
  symbol: string;
  t: number;
  price: number;
  size: number;
}

export type MarketTick = Trade | Quote | OptionQuote | OptionTrade;

/** Per-symbol live state the UI renders. */
export interface SymbolQuoteView {
  symbol: string;
  last: number | null;
  lastTradeAt: number | null;
  bid: number | null;
  ask: number | null;
  quoteAt: number | null;
  /** Most recent event timestamp of any kind (exchange time). */
  lastEventAt: number | null;
  /** serverNow - lastEventAt at the moment the view was produced. */
  ageMs: number | null;
  stale: boolean;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  sessionVolume: number | null;
  vwap: number | null;
  ema50: number | null;
  atr: number | null;
}

export interface OptionQuoteView {
  symbol: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  last: number | null;
  quoteAt: number | null;
  ageMs: number | null;
  stale: boolean;
}
