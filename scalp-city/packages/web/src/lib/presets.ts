/** Words for the limits the Aggressive preset changes, and how to show their values. */

export const ACCOUNT_LIMIT_LABELS: Record<string, string> = {
  maxDailyLoss: 'Max daily loss',
  maxPositionNotional: 'Max position',
  maxOrderNotional: 'Max order value',
  maxShares: 'Max shares',
  maxRiskPerTrade: 'Max loss per trade',
  maxConcurrentPositions: 'Max positions',
  maxTradesPerDay: 'Max trades / day',
  maxOrdersPerMinute: 'Max orders / minute',
};

export const WORKER_LIMIT_LABELS: Record<string, string> = {
  riskPerTrade: 'Risk per trade',
  maxPositionNotional: 'Max position',
  maxShares: 'Max shares',
  maxTradesPerDay: 'Max trades / day',
  dailyLossLimit: 'Daily loss limit',
};

/** Limits that are money (everything else is a count). */
const MONEY = new Set(['maxDailyLoss', 'maxPositionNotional', 'maxOrderNotional', 'maxRiskPerTrade', 'riskPerTrade', 'dailyLossLimit']);

export function describeLimit(key: string, v: number | boolean): string {
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  return MONEY.has(key) ? `$${Math.round(v).toLocaleString('en-US')}` : Math.round(v).toLocaleString('en-US');
}
