import type { Timeframe } from '../domain.js';
import { timeframeMinutes } from '../domain.js';
import type { Bar } from '../marketdata.js';

/** Start (ms) of the bucket of `minutes` length containing `t`, aligned to the clock. */
export function bucketStart(t: number, minutes: number): number {
  const size = minutes * 60_000;
  return Math.floor(t / size) * size;
}

/**
 * Aggregate 1-minute bars (sorted ascending) into a higher timeframe.
 *
 * Buckets are aligned to clock time, which for US equities coincides with
 * the 09:30 session open for 5 and 15 minute bars. A higher-timeframe bar
 * is `final` once `asOfMs` has passed the end of its bucket and every
 * constituent 1-minute bar is final.
 */
export function aggregateBars(bars1m: readonly Bar[], timeframe: Timeframe, asOfMs: number): Bar[] {
  const minutes = timeframeMinutes(timeframe);
  if (minutes === 1) return bars1m.map((b) => ({ ...b }));
  const out: Bar[] = [];
  let cur: Bar | null = null;
  let curEnd = 0;
  let pv = 0;
  let pvKnown = true;
  let allFinal = true;

  const flush = () => {
    if (!cur) return;
    cur.vw = pvKnown && cur.v > 0 ? pv / cur.v : null;
    cur.final = allFinal && asOfMs >= curEnd;
    out.push(cur);
  };

  for (const b of bars1m) {
    const start = bucketStart(b.t, minutes);
    if (!cur || start !== cur.t) {
      flush();
      cur = {
        symbol: b.symbol,
        timeframe,
        t: start,
        o: b.o,
        h: b.h,
        l: b.l,
        c: b.c,
        v: b.v,
        n: b.n,
        vw: null,
        final: false,
        source: 'aggregated',
      };
      curEnd = start + minutes * 60_000;
      pv = 0;
      pvKnown = true;
      allFinal = true;
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
      cur.n = cur.n !== null && b.n !== null ? cur.n + b.n : null;
    }
    if (b.vw !== null && b.vw > 0) pv += b.vw * b.v;
    else pvKnown = false;
    if (!b.final) allFinal = false;
  }
  flush();
  return out;
}
