import type { Bar } from '@scalp-city/shared';

export type BarEventKind = 'forming' | 'closed' | 'updated';
export interface BarEvent {
  kind: BarEventKind;
  bar: Bar;
}

const MINUTE = 60_000;

/**
 * 1-minute bars for one symbol.
 *
 * Lifecycle of minute M:
 *   trades in M      → forming bar (aggregated from real trades)
 *   M ends           → provisional bar (closed in time, not yet official)
 *   provider bar     → official, final  → 'closed' (exactly once per minute)
 *   no provider bar
 *   within grace     → our aggregate is finalized → 'closed'
 *   later correction → replaced → 'updated' (never re-emits 'closed')
 */
export class BarStore {
  private bars: Bar[] = [];
  private forming: Bar | null = null;
  private closedEmitted = new Set<number>();

  constructor(
    readonly symbol: string,
    private readonly maxBars = 3000,
  ) {}

  /** Seed/merge historical bars (all final). Never emits 'closed' — history is not a signal. */
  mergeHistorical(bars: readonly Bar[]): BarEvent[] {
    const events: BarEvent[] = [];
    for (const b of bars) {
      if (b.symbol !== this.symbol) continue;
      const bar: Bar = { ...b, final: true };
      this.upsert(bar);
      this.closedEmitted.add(bar.t);
      events.push({ kind: 'updated', bar });
    }
    this.trim();
    return events;
  }

  onTrade(price: number, size: number, t: number): BarEvent[] {
    if (!(size > 0) || !(price > 0)) return [];
    const minute = Math.floor(t / MINUTE) * MINUTE;
    const events: BarEvent[] = [];
    if (this.forming && minute > this.forming.t) {
      this.retireForming();
    }
    if (!this.forming) {
      // Late trade for a minute already closed: the provider's bar (or its correction) is authoritative.
      if (this.closedEmitted.has(minute) || this.find(minute)) return events;
      this.forming = {
        symbol: this.symbol,
        timeframe: '1Min',
        t: minute,
        o: price,
        h: price,
        l: price,
        c: price,
        v: size,
        n: 1,
        vw: price,
        final: false,
        source: 'aggregated',
      };
    } else if (minute === this.forming.t) {
      const f = this.forming;
      const pv = (f.vw ?? f.c) * f.v + price * size;
      f.h = Math.max(f.h, price);
      f.l = Math.min(f.l, price);
      f.c = price;
      f.v += size;
      f.n = (f.n ?? 0) + 1;
      f.vw = pv / f.v;
    } else {
      return events; // trade older than the forming minute
    }
    events.push({ kind: 'forming', bar: { ...this.forming } });
    return events;
  }

  onProviderBar(bar: Bar, updated: boolean): BarEvent[] {
    if (bar.symbol !== this.symbol) return [];
    const official: Bar = { ...bar, final: true, source: 'provider' };
    if (this.forming && this.forming.t === official.t) this.forming = null;
    if (this.forming && this.forming.t < official.t) this.retireForming();
    this.upsert(official);
    this.trim();
    if (!updated && !this.closedEmitted.has(official.t)) {
      this.closedEmitted.add(official.t);
      return [{ kind: 'closed', bar: official }];
    }
    this.closedEmitted.add(official.t);
    return [{ kind: 'updated', bar: official }];
  }

  /**
   * Time-driven transitions: retire the forming bar once its minute ends and
   * finalize provisional bars that received no provider bar within `graceMs`.
   */
  tick(now: number, graceMs: number): BarEvent[] {
    const events: BarEvent[] = [];
    if (this.forming && now >= this.forming.t + MINUTE) this.retireForming();
    for (const b of this.bars) {
      if (!b.final && now >= b.t + MINUTE + graceMs) {
        b.final = true;
        if (!this.closedEmitted.has(b.t)) {
          this.closedEmitted.add(b.t);
          events.push({ kind: 'closed', bar: { ...b } });
        }
      }
    }
    return events;
  }

  /** Closed bars (final or provisional), ascending. */
  closed(): Bar[] {
    return this.bars;
  }

  /** Final bars only. */
  finalBars(): Bar[] {
    return this.bars.filter((b) => b.final);
  }

  /** Closed bars plus the forming bar, ascending. */
  all(): Bar[] {
    return this.forming ? [...this.bars, { ...this.forming }] : this.bars.slice();
  }

  formingBar(): Bar | null {
    return this.forming ? { ...this.forming } : null;
  }

  lastFinal(): Bar | null {
    for (let i = this.bars.length - 1; i >= 0; i--) if (this.bars[i]!.final) return this.bars[i]!;
    return null;
  }

  private retireForming(): void {
    if (!this.forming) return;
    const f = this.forming;
    this.forming = null;
    if (!this.find(f.t)) this.upsert({ ...f, final: false });
  }

  private find(t: number): Bar | undefined {
    // Recent bars are at the end; scan backwards.
    for (let i = this.bars.length - 1; i >= 0; i--) {
      const b = this.bars[i]!;
      if (b.t === t) return b;
      if (b.t < t) return undefined;
    }
    return undefined;
  }

  private upsert(bar: Bar): void {
    const arr = this.bars;
    if (arr.length === 0 || arr[arr.length - 1]!.t < bar.t) {
      arr.push(bar);
      return;
    }
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid]!.t < bar.t) lo = mid + 1;
      else hi = mid;
    }
    if (arr[lo] && arr[lo]!.t === bar.t) arr[lo] = bar;
    else arr.splice(lo, 0, bar);
  }

  private trim(): void {
    if (this.bars.length > this.maxBars) {
      const drop = this.bars.splice(0, this.bars.length - this.maxBars);
      for (const b of drop) this.closedEmitted.delete(b.t);
    }
  }
}
