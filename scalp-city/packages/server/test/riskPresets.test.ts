import { describe, expect, it } from 'vitest';
import { AGGRESSIVE_BOUNDS, AGGRESSIVE_DEFAULTS, aggressiveAccountLimits, aggressiveWorkerLimits, presetBlocker } from '../src/risk/presets.js';

/**
 * The Aggressive preset sizes the share scalpers from the account instead of the small dollar limits they ship with
 * ($5 a trade, about $5,000 a position: a $100,000 account barely moves).
 */

const hundredK = { equity: 100_000, positionPct: AGGRESSIVE_DEFAULTS.positionPct, dailyLossPct: AGGRESSIVE_DEFAULTS.dailyLossPct, workers: 5 };

describe('the Aggressive preset: sizes from the account', () => {
  it('on $100,000: positions of $30,000, a $250 stop-out, a $5,000 daily-loss stop', () => {
    expect(aggressiveAccountLimits(hundredK)).toEqual({
      maxDailyLoss: 5_000,
      maxPositionNotional: 30_000,
      maxOrderNotional: 30_000,
      maxShares: 2_000,
      maxRiskPerTrade: 500,
      maxConcurrentPositions: 5,
      maxTradesPerDay: 1_000,
      maxOrdersPerMinute: 120,
    });
    expect(aggressiveWorkerLimits(hundredK)).toEqual({
      riskPerTrade: 250,
      maxPositionNotional: 30_000,
      maxShares: 2_000,
      maxTradesPerDay: 1_000,
      dailyLossLimit: 1_500,
    });
  });

  it('keeps all five positions inside two-times buying power at the default size', () => {
    const a = aggressiveAccountLimits(hundredK);
    expect(a.maxPositionNotional! * a.maxConcurrentPositions!).toBeLessThanOrEqual(2 * hundredK.equity);
  });

  it('scales with the account and with the two knobs', () => {
    const big = { ...hundredK, equity: 250_000 };
    expect(aggressiveAccountLimits(big)).toMatchObject({ maxPositionNotional: 75_000, maxDailyLoss: 12_500, maxRiskPerTrade: 1_250 });
    expect(aggressiveWorkerLimits(big)).toMatchObject({ riskPerTrade: 625, maxPositionNotional: 75_000, dailyLossLimit: 3_750 });
    const custom = { ...hundredK, positionPct: 50, dailyLossPct: 2 };
    expect(aggressiveAccountLimits(custom)).toMatchObject({ maxPositionNotional: 50_000, maxOrderNotional: 50_000, maxDailyLoss: 2_000 });
    expect(aggressiveWorkerLimits(custom)).toMatchObject({ maxPositionNotional: 50_000, dailyLossLimit: 600 });
  });

  it('rounds to tidy numbers and never to zero, however small the account', () => {
    const small = aggressiveAccountLimits({ ...hundredK, equity: 2_000 });
    expect(small.maxPositionNotional).toBe(600);
    expect(small.maxDailyLoss).toBe(100);
    expect(aggressiveWorkerLimits({ ...hundredK, equity: 2_000 }).riskPerTrade).toBe(25);
    for (const v of Object.values({ ...aggressiveAccountLimits({ ...hundredK, equity: 1_000 }), ...aggressiveWorkerLimits({ ...hundredK, equity: 1_000 }) })) {
      expect(v).toBeGreaterThan(0);
    }
  });

  it('lets the account hold a position in every worker at once, however many there are', () => {
    expect(aggressiveAccountLimits({ ...hundredK, workers: 8 }).maxConcurrentPositions).toBe(8);
    expect(aggressiveAccountLimits({ ...hundredK, workers: 3 }).maxConcurrentPositions).toBe(5);
  });

  it('never removes the brakes: every number is a positive whole limit, and the daily-loss stop is a fraction of the account', () => {
    const all = { ...aggressiveAccountLimits(hundredK), ...aggressiveWorkerLimits(hundredK) };
    for (const [k, v] of Object.entries(all)) {
      expect(Number.isFinite(v), k).toBe(true);
      expect(v as number, k).toBeGreaterThan(0);
    }
    expect(aggressiveAccountLimits(hundredK).maxDailyLoss!).toBeLessThan(hundredK.equity * 0.1);
    // One worker alone may lose less than the account as a whole.
    expect(aggressiveWorkerLimits(hundredK).dailyLossLimit!).toBeLessThan(aggressiveAccountLimits(hundredK).maxDailyLoss!);
  });

  it('keeps its default knobs inside its own bounds', () => {
    expect(AGGRESSIVE_DEFAULTS.positionPct).toBeGreaterThanOrEqual(AGGRESSIVE_BOUNDS.positionPct.min);
    expect(AGGRESSIVE_DEFAULTS.positionPct).toBeLessThanOrEqual(AGGRESSIVE_BOUNDS.positionPct.max);
    expect(AGGRESSIVE_DEFAULTS.dailyLossPct).toBeGreaterThanOrEqual(AGGRESSIVE_BOUNDS.dailyLossPct.min);
    expect(AGGRESSIVE_DEFAULTS.dailyLossPct).toBeLessThanOrEqual(AGGRESSIVE_BOUNDS.dailyLossPct.max);
  });
});

describe('where the preset may be applied', () => {
  const ok = { env: 'paper' as const, venue: 'alpaca' as const, equity: 100_000, workers: 5 };

  it('on a paper Alpaca account with share workers and a known account size', () => {
    expect(presetBlocker(ok)).toBeNull();
  });

  it('never on a live account: real money gets its limits set by hand', () => {
    expect(presetBlocker({ ...ok, env: 'live' })).toMatch(/PAPER account only/);
  });

  it('not for OANDA, which sizes each trade from its stop, and not without share workers', () => {
    expect(presetBlocker({ ...ok, venue: 'oanda' })).toMatch(/Alpaca/);
    expect(presetBlocker({ ...ok, workers: 0 })).toMatch(/no share workers/);
  });

  it('not while the account size is unknown or tiny: there is nothing to scale from', () => {
    for (const equity of [null, NaN, 0, 999]) expect(presetBlocker({ ...ok, equity }), String(equity)).toMatch(/account size is not known/);
    expect(presetBlocker({ ...ok, equity: 1_000 })).toBeNull();
  });
});
