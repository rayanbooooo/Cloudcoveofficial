import type { RiskLimits, Venue, WorkerLimits } from '@scalp-city/shared';

/**
 * The Aggressive preset: limits scaled to the size of the account, for the 1-minute share scalpers on a PAPER account.
 *
 * The fast scalpers ship with dollar limits that suit a tiny account: each trade risks $5 and a position is capped
 * near $5,000, so on $100,000 a whole day moves a few dollars. This sizes them from the account instead: a position
 * is a share of equity, a stop-out risks a fraction of a percent, and the account keeps a daily-loss stop (a hard
 * brake the preset never removes: limits cannot be disabled).
 *
 * It only ever changes numbers the person can already change by hand in the Risk drawer and the worker settings; every
 * order still goes through the risk engine with the new limits.
 */

export interface AggressiveInput {
  /** Account equity when the preset is applied. */
  equity: number;
  /** The largest position (and order) as a percent of equity. */
  positionPct: number;
  /** The account-wide daily-loss stop as a percent of equity: new entries stop for the day at this loss. */
  dailyLossPct: number;
  /** How many share workers there are (the account may hold a position in each at once). */
  workers: number;
}

export const AGGRESSIVE_DEFAULTS = { positionPct: 30, dailyLossPct: 5 } as const;
export const AGGRESSIVE_BOUNDS = { positionPct: { min: 1, max: 100 }, dailyLossPct: { min: 0.5, max: 25 } } as const;

/** Round to a step, never below one step. */
const roundTo = (v: number, step: number): number => Math.max(step, Math.round(v / step) * step);

/** What a stop-out of one trade may cost, as a share of equity, at the account and at the worker. */
const ACCOUNT_RISK_PER_TRADE_PCT = 0.5;
const WORKER_RISK_PER_TRADE_PCT = 0.25;
/** One worker may lose this share of the account's daily-loss stop before it stands down alone. */
const WORKER_SHARE_OF_DAILY_LOSS = 0.3;

/** The account-wide limits (Risk drawer). */
export function aggressiveAccountLimits(i: AggressiveInput): Partial<RiskLimits> {
  const position = roundTo((i.equity * i.positionPct) / 100, 100);
  return {
    maxDailyLoss: roundTo((i.equity * i.dailyLossPct) / 100, 100),
    maxPositionNotional: position,
    maxOrderNotional: position,
    maxShares: 2000,
    maxRiskPerTrade: roundTo((i.equity * ACCOUNT_RISK_PER_TRADE_PCT) / 100, 50),
    maxConcurrentPositions: Math.max(5, i.workers),
    maxTradesPerDay: 1000,
    maxOrdersPerMinute: 120,
  };
}

/** The limits of each share worker (worker settings). */
export function aggressiveWorkerLimits(i: AggressiveInput): Partial<WorkerLimits> {
  return {
    riskPerTrade: roundTo((i.equity * WORKER_RISK_PER_TRADE_PCT) / 100, 25),
    maxPositionNotional: roundTo((i.equity * i.positionPct) / 100, 100),
    maxShares: 2000,
    maxTradesPerDay: 1000,
    dailyLossLimit: roundTo((i.equity * i.dailyLossPct * WORKER_SHARE_OF_DAILY_LOSS) / 100, 50),
  };
}

/**
 * Why the preset cannot be applied here, or null. Paper only: bigger sizes are a decision for a practice account,
 * and a real one gets its limits set by hand, small. It sizes share workers (Alpaca), from a known account size.
 */
export function presetBlocker(c: { env: 'paper' | 'live'; venue: Venue; equity: number | null; workers: number }): string | null {
  if (c.env === 'live') return 'The aggressive preset is for the PAPER account only. Set LIVE limits by hand, small.';
  if (c.venue !== 'alpaca') return 'The aggressive preset sizes the share workers (Alpaca). OANDA sizes each trade from its stop and has its own limits.';
  if (c.workers === 0) return 'There are no share workers to size.';
  if (c.equity === null || !Number.isFinite(c.equity) || c.equity < 1000) return 'The account size is not known yet (or is under $1,000), so there is nothing to scale from.';
  return null;
}
