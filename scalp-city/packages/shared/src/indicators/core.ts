import type { Bar } from '../marketdata.js';

/**
 * Pure indicator math. Every function returns a series aligned with its
 * input (index i of the output describes index i of the input) and uses
 * `null` where the indicator is not yet defined — never a made-up value.
 */

function assertPeriod(period: number): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`period must be a positive integer, got ${period}`);
  }
}

/** Simple moving average. */
export function sma(values: readonly number[], period: number): (number | null)[] {
  assertPeriod(period);
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average, seeded with the SMA of the first `period`
 * values (the conventional definition used by charting platforms).
 */
export function ema(values: readonly number[], period: number): (number | null)[] {
  assertPeriod(period);
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i]!;
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** True range of a bar given the previous close (null for the first bar). */
export function trueRange(bar: Pick<Bar, 'h' | 'l'>, prevClose: number | null): number {
  const hl = bar.h - bar.l;
  if (prevClose === null) return hl;
  return Math.max(hl, Math.abs(bar.h - prevClose), Math.abs(bar.l - prevClose));
}

/**
 * Average True Range using Wilder's smoothing:
 *   ATR[p-1] = mean(TR[0..p-1]);  ATR[i] = (ATR[i-1] * (p-1) + TR[i]) / p
 */
export function atr(bars: readonly Pick<Bar, 'h' | 'l' | 'c'>[], period: number): (number | null)[] {
  assertPeriod(period);
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length < period) return out;
  const tr: number[] = bars.map((b, i) => trueRange(b, i === 0 ? null : bars[i - 1]!.c));
  let seed = 0;
  for (let i = 0; i < period; i++) seed += tr[i]!;
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < bars.length; i++) {
    prev = (prev * (period - 1) + tr[i]!) / period;
    out[i] = prev;
  }
  return out;
}

/**
 * Session-anchored VWAP. `sessionKey(t)` returns an identifier for the
 * trading session a bar belongs to (e.g. its New York date), or `null` for
 * bars outside the regular session, which are excluded and get `null`.
 * The cumulative sums reset whenever the session key changes.
 *
 * Each bar contributes `vw * v` when the provider reported a bar VWAP,
 * otherwise `typical price * v` with typical = (h + l + c) / 3.
 */
export function vwapSeries(
  bars: readonly Bar[],
  sessionKey: (t: number) => string | null,
): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  let currentKey: string | null = null;
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const key = sessionKey(b.t);
    if (key === null) continue;
    if (key !== currentKey) {
      currentKey = key;
      pv = 0;
      vol = 0;
    }
    const price = b.vw !== null && b.vw > 0 ? b.vw : (b.h + b.l + b.c) / 3;
    pv += price * b.v;
    vol += b.v;
    out[i] = vol > 0 ? pv / vol : null;
  }
  return out;
}

export interface OpeningRange {
  high: number;
  low: number;
  startMs: number;
  endMs: number;
  /** True once `asOfMs` has reached the end of the range window. */
  complete: boolean;
  barsUsed: number;
}

/**
 * High/low of the bars whose start time falls inside
 * [sessionOpenMs, sessionOpenMs + minutes). Returns null when no bar has
 * printed inside the window yet.
 */
export function openingRange(
  bars: readonly Bar[],
  sessionOpenMs: number,
  minutes: number,
  asOfMs: number,
): OpeningRange | null {
  assertPeriod(minutes);
  const endMs = sessionOpenMs + minutes * 60_000;
  let high = -Infinity;
  let low = Infinity;
  let used = 0;
  for (const b of bars) {
    if (b.t < sessionOpenMs || b.t >= endMs) continue;
    if (b.h > high) high = b.h;
    if (b.l < low) low = b.l;
    used++;
  }
  if (used === 0) return null;
  return { high, low, startMs: sessionOpenMs, endMs, complete: asOfMs >= endMs, barsUsed: used };
}

/**
 * Momentum expressed in ATR units: (close[i] - close[i - lookback]) / ATR[i].
 * Normalising by ATR makes thresholds comparable across symbols.
 */
export function atrMomentum(
  closes: readonly number[],
  atrValues: readonly (number | null)[],
  lookback: number,
): (number | null)[] {
  assertPeriod(lookback);
  const out: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = lookback; i < closes.length; i++) {
    const a = atrValues[i];
    if (a === null || a === undefined || a <= 0) continue;
    out[i] = (closes[i]! - closes[i - lookback]!) / a;
  }
  return out;
}

export type PriceStructure = 'BULLISH' | 'BEARISH' | 'RANGE';

/**
 * Compares the two halves of the last `lookback` bars. Higher high AND
 * higher low in the recent half = BULLISH; lower high AND lower low =
 * BEARISH; anything else = RANGE. Returns null with too few bars.
 */
export function priceStructure(bars: readonly Pick<Bar, 'h' | 'l'>[], lookback: number): PriceStructure | null {
  if (!Number.isInteger(lookback) || lookback < 2 || lookback % 2 !== 0) {
    throw new RangeError(`structure lookback must be an even integer >= 2, got ${lookback}`);
  }
  if (bars.length < lookback) return null;
  const window = bars.slice(bars.length - lookback);
  const half = lookback / 2;
  const older = window.slice(0, half);
  const newer = window.slice(half);
  const olderHigh = Math.max(...older.map((b) => b.h));
  const olderLow = Math.min(...older.map((b) => b.l));
  const newerHigh = Math.max(...newer.map((b) => b.h));
  const newerLow = Math.min(...newer.map((b) => b.l));
  if (newerHigh > olderHigh && newerLow > olderLow) return 'BULLISH';
  if (newerHigh < olderHigh && newerLow < olderLow) return 'BEARISH';
  return 'RANGE';
}

/**
 * Volume of the last bar relative to the mean volume of the `lookback` bars
 * before it. Null when there is not enough history or the baseline is zero.
 */
export function relativeVolume(bars: readonly Pick<Bar, 'v'>[], lookback: number): number | null {
  assertPeriod(lookback);
  if (bars.length < lookback + 1) return null;
  const last = bars[bars.length - 1]!;
  let sum = 0;
  for (let i = bars.length - 1 - lookback; i < bars.length - 1; i++) sum += bars[i]!.v;
  const avg = sum / lookback;
  if (avg <= 0) return null;
  return last.v / avg;
}
