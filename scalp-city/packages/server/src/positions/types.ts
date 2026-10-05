import type { AssetClass, DirectionOrNeutral, TradingEnvironment, Venue } from '@scalp-city/shared';

/** What Scalp City believes it holds in one symbol (signed qty: + long, − short). */
export interface LedgerPosition {
  venue: Venue;
  env: TradingEnvironment;
  symbol: string;
  workerId: string | null;
  tradeId: string | null;
  assetClass: AssetClass;
  underlying: string | null;
  direction: DirectionOrNeutral;
  qty: number;
  avgPrice: number;
  multiplier: number;
  /** Adopted from the broker rather than opened by Scalp City. */
  external: boolean;
  openedAt: number;
  updatedAt: number;
}

/** One round trip in the trade journal (spec §117). */
export interface TradeRecord {
  id: string;
  venue: Venue;
  env: TradingEnvironment;
  workerId: string | null;
  strategyId: string | null;
  symbol: string;
  underlying: string | null;
  assetClass: AssetClass;
  direction: DirectionOrNeutral;
  status: 'OPEN' | 'CLOSED';
  qtyOpened: number;
  qtyClosed: number;
  /** Σ entry fill price × qty × multiplier. */
  entryValue: number;
  /** Σ exit fill price × qty × multiplier. */
  exitValue: number;
  multiplier: number;
  /** Realized P&L from actual fills; null when it can't be known (closed outside Scalp City). */
  realizedPnl: number | null;
  signalId: string | null;
  signalSnapshot: { charge: number; conditions: unknown[] } | null;
  riskSnapshot: Record<string, unknown> | null;
  exitReason: string | null;
  dailyPnlBefore: number | null;
  dailyPnlAfter: number | null;
  tradingDay: string;
  openedAt: number;
  closedAt: number | null;
}
