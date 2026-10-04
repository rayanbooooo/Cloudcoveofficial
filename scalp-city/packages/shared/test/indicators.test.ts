import { describe, expect, it } from 'vitest';
import {
  aggregateBars,
  atr,
  atrMomentum,
  ema,
  openingRange,
  priceStructure,
  relativeVolume,
  sma,
  trueRange,
  vwapSeries,
} from '../src/index.js';
import type { Bar } from '../src/index.js';

const MIN = 60_000;
const OPEN = Date.UTC(2026, 9, 5, 13, 30); // 09:30 New York (EDT)

function bar(i: number, o: number, h: number, l: number, c: number, v = 1000, vw: number | null = null): Bar {
  return { symbol: 'QQQ', timeframe: '1Min', t: OPEN + i * MIN, o, h, l, c, v, n: null, vw, final: true, source: 'historical' };
}

describe('SMA / EMA', () => {
  it('computes a simple moving average', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('seeds the EMA with the SMA of the first period values', () => {
    // period 3 → k = 0.5; seed = mean(1,2,3) = 2; then 4·.5+2·.5 = 3, 5·.5+3·.5 = 4 …
    expect(ema([1, 2, 3, 4, 5, 6], 3)).toEqual([null, null, 2, 3, 4, 5]);
  });

  it('returns all nulls when there is not enough data', () => {
    expect(ema([1, 2], 3)).toEqual([null, null]);
  });

  it('matches a hand-computed EMA with k = 2/(n+1)', () => {
    const values = [10, 11, 12, 13, 20];
    const out = ema(values, 4); // k = 0.4, seed = 11.5
    expect(out[3]).toBeCloseTo(11.5, 10);
    expect(out[4]).toBeCloseTo(20 * 0.4 + 11.5 * 0.6, 10); // 14.9
  });

  it('rejects invalid periods', () => {
    expect(() => ema([1, 2, 3], 0)).toThrow(RangeError);
    expect(() => ema([1, 2, 3], 2.5)).toThrow(RangeError);
  });
});

describe('ATR', () => {
  it('true range accounts for gaps against the previous close', () => {
    expect(trueRange({ h: 12, l: 11 }, null)).toBe(1);
    expect(trueRange({ h: 12, l: 11 }, 9)).toBe(3); // gap up: |12 - 9|
    expect(trueRange({ h: 12, l: 11 }, 14)).toBe(3); // gap down: |11 - 14|
  });

  it('is constant for constant-range bars', () => {
    const bars = Array.from({ length: 20 }, (_, i) => bar(i, 100, 101, 99, 100));
    const out = atr(bars, 14);
    expect(out.slice(0, 13).every((v) => v === null)).toBe(true);
    expect(out[13]).toBeCloseTo(2, 10);
    expect(out[19]).toBeCloseTo(2, 10);
  });

  it("applies Wilder's smoothing after the seed", () => {
    const bars = [bar(0, 10, 11, 9, 10), bar(1, 10, 11, 9, 10), bar(2, 10, 14, 10, 13)];
    // TR: 2, 2, max(4, |14-10|, |10-10|) = 4. Period 2: seed = 2 at i=1; i=2: (2·1 + 4)/2 = 3
    const out = atr(bars, 2);
    expect(out).toEqual([null, 2, 3]);
  });
});

describe('VWAP', () => {
  const key = (t: number) => (t >= OPEN ? 'S1' : null);

  it('uses provider bar VWAP weighted by volume', () => {
    const bars = [bar(0, 10, 10, 10, 10, 100, 10), bar(1, 12, 12, 12, 12, 300, 12)];
    const out = vwapSeries(bars, key);
    expect(out[0]).toBeCloseTo(10, 10);
    expect(out[1]).toBeCloseTo((10 * 100 + 12 * 300) / 400, 10); // 11.5
  });

  it('falls back to typical price when the provider has no bar VWAP', () => {
    const bars = [bar(0, 10, 12, 9, 12, 100, null)];
    expect(vwapSeries(bars, key)[0]).toBeCloseTo((12 + 9 + 12) / 3, 10);
  });

  it('excludes bars outside the session and resets on a new session', () => {
    const pre: Bar = { ...bar(0, 50, 50, 50, 50, 1000, 50), t: OPEN - 5 * MIN };
    const s1 = bar(0, 10, 10, 10, 10, 100, 10);
    const s2: Bar = { ...bar(0, 20, 20, 20, 20, 100, 20), t: OPEN + 24 * 60 * MIN };
    const sessionKey = (t: number) => (t < OPEN ? null : t < OPEN + 24 * 60 * MIN ? 'S1' : 'S2');
    const out = vwapSeries([pre, s1, s2], sessionKey);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeCloseTo(10, 10);
    expect(out[2]).toBeCloseTo(20, 10); // reset — not blended with S1
  });

  it('returns null while cumulative volume is zero', () => {
    expect(vwapSeries([bar(0, 10, 10, 10, 10, 0, 10)], key)[0]).toBeNull();
  });
});

describe('Opening range', () => {
  const bars = Array.from({ length: 20 }, (_, i) => bar(i, 100 + i, 101 + i, 99 - (i === 3 ? 2 : 0), 100 + i));

  it('takes the high/low of the first N minutes only', () => {
    const or = openingRange(bars, OPEN, 15, OPEN + 20 * MIN)!;
    expect(or.high).toBe(101 + 14); // bar 14 is the last inside [open, open+15m)
    expect(or.low).toBe(97); // bar 3's low
    expect(or.barsUsed).toBe(15);
    expect(or.complete).toBe(true);
  });

  it('is incomplete until the window has elapsed', () => {
    const or = openingRange(bars.slice(0, 5), OPEN, 15, OPEN + 5 * MIN)!;
    expect(or.complete).toBe(false);
    expect(or.barsUsed).toBe(5);
  });

  it('is null before any bar prints in the window', () => {
    expect(openingRange([], OPEN, 15, OPEN)).toBeNull();
  });
});

describe('Momentum / structure / volume', () => {
  it('normalises momentum by ATR', () => {
    const closes = [100, 101, 102, 103];
    const atrs = [null, 1, 1, 2];
    expect(atrMomentum(closes, atrs, 2)).toEqual([null, null, 2, 1]);
  });

  it('detects bullish and bearish structure', () => {
    const up = [bar(0, 1, 10, 5, 1), bar(1, 1, 11, 6, 1), bar(2, 1, 12, 7, 1), bar(3, 1, 13, 8, 1)];
    const down = [bar(0, 1, 13, 8, 1), bar(1, 1, 12, 7, 1), bar(2, 1, 11, 6, 1), bar(3, 1, 10, 5, 1)];
    const range = [bar(0, 1, 13, 5, 1), bar(1, 1, 12, 6, 1), bar(2, 1, 14, 4, 1), bar(3, 1, 12, 6, 1)];
    expect(priceStructure(up, 4)).toBe('BULLISH');
    expect(priceStructure(down, 4)).toBe('BEARISH');
    expect(priceStructure(range, 4)).toBe('RANGE');
    expect(priceStructure(up.slice(0, 2), 4)).toBeNull();
  });

  it('computes relative volume against the prior bars', () => {
    const bars = [bar(0, 1, 1, 1, 1, 100), bar(1, 1, 1, 1, 1, 300), bar(2, 1, 1, 1, 1, 400)];
    expect(relativeVolume(bars, 2)).toBeCloseTo(400 / 200, 10);
    expect(relativeVolume(bars, 3)).toBeNull();
  });
});

describe('Bar aggregation', () => {
  it('aggregates 1m bars into clock-aligned 5m bars', () => {
    const bars = Array.from({ length: 7 }, (_, i) => bar(i, 100 + i, 101 + i, 99 + i, 100.5 + i, 10 * (i + 1), 100 + i));
    const out = aggregateBars(bars, '5Min', OPEN + 7 * MIN);
    expect(out).toHaveLength(2);
    const [a, b] = out as [Bar, Bar];
    expect(a.t).toBe(OPEN);
    expect(a.o).toBe(100);
    expect(a.h).toBe(105);
    expect(a.l).toBe(99);
    expect(a.c).toBe(104.5);
    expect(a.v).toBe(10 + 20 + 30 + 40 + 50);
    expect(a.vw).toBeCloseTo((100 * 10 + 101 * 20 + 102 * 30 + 103 * 40 + 104 * 50) / 150, 10);
    expect(a.final).toBe(true);
    expect(b.t).toBe(OPEN + 5 * MIN);
    expect(b.final).toBe(false); // bucket ends at +10m, asOf is +7m
  });
});
