import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STRATEGY_PARAMS,
  INITIAL_SIGNAL_STATE,
  advanceSignal,
  computeCharge,
  computeIndicatorSnapshot,
  evaluateDirection,
  evaluateSignal,
  parseOccSymbol,
} from '../src/index.js';
import type { Bar, IndicatorSnapshot, SignalState, StrategyParams } from '../src/index.js';

const P: StrategyParams = DEFAULT_STRATEGY_PARAMS;
const T0 = Date.UTC(2026, 9, 5, 14, 0);

function snap(over: Partial<IndicatorSnapshot>): IndicatorSnapshot {
  return {
    symbol: 'QQQ',
    timeframe: '1Min',
    barTime: T0,
    barFinal: true,
    barsAvailable: 120,
    close: 600,
    vwap: 599,
    ema: 598,
    emaPrev: 597.5,
    atr: 0.5,
    momentum: 0.8,
    orHigh: 599.5,
    orLow: 596,
    orComplete: true,
    structure: 'BULLISH',
    rvol: 1.6,
    barsSinceCrossUp: 2,
    barsSinceCrossDown: null,
    ...over,
  };
}

const fullCall = snap({});
const fullPut = snap({
  close: 594,
  vwap: 597,
  ema: 598,
  emaPrev: 598.6,
  momentum: -0.9,
  orHigh: 600,
  orLow: 595,
  structure: 'BEARISH',
  barsSinceCrossUp: null,
  barsSinceCrossDown: 1,
});

describe('signal conditions', () => {
  it('produces a fully charged CALL from bullish conditions', () => {
    const e = evaluateSignal(fullCall, P);
    expect(e.direction).toBe('CALL');
    expect(e.callCharge).toBe(100);
    expect(e.requiredMet).toBe(true);
    expect(e.conditions.every((c) => c.met)).toBe(true);
  });

  it('produces a fully charged PUT from bearish conditions', () => {
    const e = evaluateSignal(fullPut, P);
    expect(e.direction).toBe('PUT');
    expect(e.putCharge).toBe(100);
    expect(e.callCharge).toBeLessThan(e.putCharge);
  });

  it('charges by condition weight — never forced', () => {
    // Only VWAP (20) + EMA50 (20) + VOLUME (10) met → 50%
    const s = snap({ momentum: 0.1, orComplete: true, orHigh: 610, structure: 'RANGE' });
    const call = evaluateDirection(s, P, 'CALL');
    expect(call.filter((c) => c.met).map((c) => c.id).sort()).toEqual(['EMA50', 'VOLUME', 'VWAP']);
    expect(computeCharge(call)).toBe(50);
  });

  it('requires a recent VWAP cross in cross mode', () => {
    const noCross = snap({ barsSinceCrossUp: null });
    const vwap = evaluateDirection(noCross, P, 'CALL').find((c) => c.id === 'VWAP')!;
    expect(vwap.met).toBe(false);
    const sideMode = evaluateDirection(noCross, { ...P, vwapMode: 'side' }, 'CALL').find((c) => c.id === 'VWAP')!;
    expect(sideMode.met).toBe(true);
  });

  it('treats unavailable inputs as not met and says so', () => {
    const s = snap({ ema: null, emaPrev: null, barsAvailable: 12 });
    const ema = evaluateDirection(s, P, 'CALL').find((c) => c.id === 'EMA50')!;
    expect(ema.met).toBe(false);
    expect(ema.unavailable).toBe(true);
    expect(ema.detail).toContain('warming up');
  });

  it('does not count an incomplete opening range', () => {
    const s = snap({ orComplete: false });
    const or = evaluateDirection(s, P, 'CALL').find((c) => c.id === 'OPENING_RANGE')!;
    expect(or.met).toBe(false);
    expect(or.unavailable).toBe(false);
  });
});

describe('setup lifecycle', () => {
  const step = (prev: SignalState, s: IndicatorSnapshot) => advanceSignal(prev, evaluateSignal(s, P), P, 'qqq-og');

  it('goes FORMING → CHARGING → READY with a stable setup id', () => {
    const forming = step(INITIAL_SIGNAL_STATE, snap({ momentum: 0.1, orHigh: 610, structure: 'RANGE', rvol: 1.0 })); // 40%
    expect(forming.phase).toBe('FORMING');
    expect(forming.setupId).toBe(`qqq-og:CALL:${T0}`);

    const charging = step(forming, snap({ barTime: T0 + 60_000, orHigh: 610, structure: 'RANGE' })); // 70%
    expect(charging.phase).toBe('CHARGING');
    expect(charging.setupId).toBe(forming.setupId);

    const ready = step(charging, snap({ barTime: T0 + 120_000 }));
    expect(ready.phase).toBe('READY');
    expect(ready.setupId).toBe(forming.setupId);
    expect(ready.readySince).toBe(T0 + 120_000);
    expect(ready.formingSince).toBe(T0);
  });

  it('fades when a charged setup loses its conditions', () => {
    const charging = step(INITIAL_SIGNAL_STATE, snap({ orHigh: 610, structure: 'RANGE' })); // 70%
    expect(charging.phase).toBe('CHARGING');
    const faded = step(charging, snap({ barTime: T0 + 60_000, momentum: 0.1, orHigh: 610, structure: 'RANGE', rvol: 1 }));
    expect(faded.phase).toBe('FADED');
    expect(faded.setupId).toBeNull();
    expect(faded.fadedSetupId).toBe(charging.setupId);
    // The next forming bar starts a brand-new setup id.
    const reform = step(faded, snap({ barTime: T0 + 120_000, momentum: 0.1, orHigh: 610, structure: 'RANGE', rvol: 1 }));
    expect(reform.phase).toBe('FORMING');
    expect(reform.setupId).toBe(`qqq-og:CALL:${T0 + 120_000}`);
  });

  it('starts the opposite setup immediately when direction flips', () => {
    const call = step(INITIAL_SIGNAL_STATE, snap({}));
    expect(call.phase).toBe('READY');
    const put = step(call, { ...fullPut, barTime: T0 + 60_000 });
    expect(put.direction).toBe('PUT');
    expect(put.phase).toBe('READY');
    expect(put.fadedSetupId).toBe(call.setupId);
    expect(put.setupId).toBe(`qqq-og:PUT:${T0 + 60_000}`);
  });

  it('a re-arming strategy gives every READY bar its own setup id, a patient one keeps a single id', () => {
    const fast: StrategyParams = { ...P, rearmEachBar: true };
    const stepFast = (prev: SignalState, s: IndicatorSnapshot) => advanceSignal(prev, evaluateSignal(s, fast), fast, 'qqq-og');
    const first = stepFast(INITIAL_SIGNAL_STATE, snap({}));
    const second = stepFast(first, snap({ barTime: T0 + 60_000 }));
    const third = stepFast(second, snap({ barTime: T0 + 120_000 }));
    expect([first.phase, second.phase, third.phase]).toEqual(['READY', 'READY', 'READY']);
    expect(new Set([first.setupId, second.setupId, third.setupId]).size).toBe(3);
    expect(second.setupId).toBe(`qqq-og:CALL:${T0 + 60_000}`);
    expect(third.formingSince).toBe(T0); // it is still the same run of momentum
    // The default keeps one id for the whole run, which is why it trades rarely.
    const p1 = step(INITIAL_SIGNAL_STATE, snap({}));
    const p3 = step(step(p1, snap({ barTime: T0 + 60_000 })), snap({ barTime: T0 + 120_000 }));
    expect(p3.setupId).toBe(p1.setupId);
    // Not READY: no re-arming, the id is kept until the setup fades.
    const charging = stepFast(INITIAL_SIGNAL_STATE, snap({ orHigh: 610, structure: 'RANGE' }));
    const stillCharging = stepFast(charging, snap({ barTime: T0 + 60_000, orHigh: 610, structure: 'RANGE' }));
    expect(stillCharging.setupId).toBe(charging.setupId);
  });

  it('is deterministic — replaying the same bars yields the same setup id', () => {
    const a = step(step(INITIAL_SIGNAL_STATE, snap({ orHigh: 610 })), snap({ barTime: T0 + 60_000 }));
    const b = step(step(INITIAL_SIGNAL_STATE, snap({ orHigh: 610 })), snap({ barTime: T0 + 60_000 }));
    expect(a.setupId).toBe(b.setupId);
  });
});

describe('indicator snapshot from bars', () => {
  it('computes a snapshot from a realistic intraday uptrend', () => {
    const open = Date.UTC(2026, 9, 5, 13, 30);
    const bars: Bar[] = [];
    // 60 bars of a slow grind, a dip under VWAP, then a reclaim with volume.
    for (let i = 0; i < 70; i++) {
      const base = 600 + i * 0.05 + (i >= 63 && i <= 65 ? -2.0 : 0) + (i >= 66 ? 0.8 + (i - 66) * 0.3 : 0);
      bars.push({
        symbol: 'QQQ',
        timeframe: '1Min',
        t: open + i * 60_000,
        o: base - 0.05,
        h: base + 0.1,
        l: base - 0.1,
        c: base,
        v: i >= 66 ? 30_000 : 10_000,
        n: null,
        vw: base,
        final: true,
        source: 'historical',
      });
    }
    const session = { openMs: open, closeMs: open + 390 * 60_000, sessionKey: () => '2026-10-05' };
    const s = computeIndicatorSnapshot(bars, P, session, open + 70 * 60_000)!;
    expect(s.barTime).toBe(open + 69 * 60_000);
    expect(s.ema).not.toBeNull();
    expect(s.atr).not.toBeNull();
    expect(s.orComplete).toBe(true);
    expect(s.close).toBeGreaterThan(s.vwap!);
    expect(s.barsSinceCrossUp).not.toBeNull();
    const e = evaluateSignal(s, P);
    expect(e.direction).toBe('CALL');
    expect(e.charge).toBeGreaterThanOrEqual(60);
  });
});

describe('OCC symbols', () => {
  it('parses contract symbols for display', () => {
    expect(parseOccSymbol('QQQ251017C00600000')).toEqual({ root: 'QQQ', expiration: '2025-10-17', type: 'call', strike: 600 });
    expect(parseOccSymbol('SPY260116P00512500')).toEqual({ root: 'SPY', expiration: '2026-01-16', type: 'put', strike: 512.5 });
    expect(parseOccSymbol('QQQ')).toBeNull();
  });
});
