import { describe, expect, it } from 'vitest';
import { ACCOUNT_LIMIT_LABELS, WORKER_LIMIT_LABELS, describeLimit } from '../src/lib/presets';

describe('showing the limits the Aggressive preset changes', () => {
  it('writes money as dollars with thousands separators and counts as plain numbers', () => {
    expect(describeLimit('maxPositionNotional', 30000)).toBe('$30,000');
    expect(describeLimit('riskPerTrade', 250)).toBe('$250');
    expect(describeLimit('maxDailyLoss', 5000)).toBe('$5,000');
    expect(describeLimit('maxTradesPerDay', 1000)).toBe('1,000');
    expect(describeLimit('maxShares', 2000)).toBe('2,000');
    expect(describeLimit('pdtGuard', true)).toBe('on');
  });

  it('has words for every limit the preset touches', () => {
    for (const k of ['maxDailyLoss', 'maxPositionNotional', 'maxOrderNotional', 'maxShares', 'maxRiskPerTrade', 'maxConcurrentPositions', 'maxTradesPerDay', 'maxOrdersPerMinute']) {
      expect(ACCOUNT_LIMIT_LABELS[k], k).toBeTruthy();
    }
    for (const k of ['riskPerTrade', 'maxPositionNotional', 'maxShares', 'maxTradesPerDay', 'dailyLossLimit']) {
      expect(WORKER_LIMIT_LABELS[k], k).toBeTruthy();
    }
  });
});
