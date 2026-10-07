import { DateTime } from 'luxon';
import type { StockFeed } from '@scalp-city/shared';

const NY = 'America/New_York';

/**
 * Which Alpaca stock feed carries which hours. By day (04:00–20:00 New York) it is the configured primary feed
 * (IEX on the free plan, SIP on the paid one). The overnight session (20:00–04:00, Blue Ocean ATS) is a separate
 * feed with its own WebSocket and its own history: `boats` on the paid plan, `overnight` on the free one.
 */
export interface FeedPlan {
  primary: StockFeed;
  /** The overnight feed, or null when the deployment does not trade overnight. */
  overnight: 'overnight' | 'boats' | null;
}

/** 20:00 up to (not including) 04:00 New York. */
export function isOvernightHour(t: number): boolean {
  const h = DateTime.fromMillis(t, { zone: NY }).hour;
  return h >= 20 || h < 4;
}

export function feedAt(plan: FeedPlan, t: number): StockFeed {
  return plan.overnight !== null && isOvernightHour(t) ? plan.overnight : plan.primary;
}

/** The next 04:00 or 20:00 New York strictly after `t`: where the feed changes. */
export function nextFeedChange(t: number): number {
  const local = DateTime.fromMillis(t, { zone: NY });
  const at = (d: DateTime, hour: number) => d.set({ hour, minute: 0, second: 0, millisecond: 0 }).toMillis();
  const candidates = [at(local, 4), at(local, 20), at(local.plus({ days: 1 }), 4)].filter((c) => c > t);
  return Math.min(...candidates);
}

export interface FeedSegment {
  feed: StockFeed;
  from: number;
  to: number;
}

/** Split [start, end) at the feed changes, naming the feed for each piece; neighbours on the same feed are joined. */
export function feedSegments(plan: FeedPlan, start: number, end: number): FeedSegment[] {
  const out: FeedSegment[] = [];
  for (let t = start; t < end; ) {
    const to = Math.min(end, nextFeedChange(t));
    const feed = feedAt(plan, t);
    const last = out[out.length - 1];
    if (last && last.feed === feed && last.to === t) last.to = to;
    else out.push({ feed, from: t, to });
    t = to;
  }
  return out;
}

/** Path of a stock feed's market data WebSocket: /v2/{iex|sip|delayed_sip}, /v1beta1/{overnight|boats}. */
export function streamPath(feed: StockFeed): string {
  return feed === 'overnight' || feed === 'boats' ? `/v1beta1/${feed}` : `/v2/${feed}`;
}
