import { DateTime } from 'luxon';
import type { MarketStatusView, SessionPolicy } from '@scalp-city/shared';
import type { BrokerAdapter, BrokerCalendarDay, BrokerClock } from '../broker/types.js';
import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import type { Db } from '../db/db.js';
import { iso } from '../db/db.js';

const NY = 'America/New_York';
const HOUR = 3_600_000;

export interface Session {
  date: string;
  openMs: number;
  closeMs: number;
  /** Extended-hours session: pre-market open to after-hours close (04:00–20:00, earlier on half days). */
  extOpenMs: number;
  extCloseMs: number;
}

/** A stretch of time the deployment trades. `night` is the overnight session between two trading days. */
type IntervalKind = 'pre' | 'regular' | 'post' | 'night';
interface Interval {
  start: number;
  end: number;
  kind: IntervalKind;
}

/** New York calendar date (YYYY-MM-DD) of an instant. */
export function nyDate(t: number): string {
  return DateTime.fromMillis(t, { zone: NY }).toISODate()!;
}

/**
 * The date of the trading day an instant falls in when the day runs 04:00 to 04:00 New York time: before 04:00 it is
 * still the day before. Read off the local clock, not by subtracting four hours, which is an hour out on the two days
 * a year the clocks change.
 */
export function nightDate(t: number): string {
  const l = DateTime.fromMillis(t, { zone: NY });
  return (l.hour < 4 ? l.minus({ days: 1 }) : l).toISODate()!;
}

function nyAt(date: string, hour: number): number {
  return DateTime.fromISO(date, { zone: NY }).set({ hour, minute: 0, second: 0, millisecond: 0 }).toMillis();
}

function addDays(date: string, n: number): string {
  return DateTime.fromISO(date, { zone: NY }).plus({ days: n }).toISODate()!;
}

/**
 * Trading calendar and clock (spec §63, §91). Alpaca: the broker's exchange
 * calendar is the source of holidays and early closes — weekdays are never
 * assumed to be trading days. OANDA: instruments trade around the clock, so
 * sessions are the configured strategy window (see oanda/calendar.ts). The
 * broker clock is polled to detect server clock skew.
 *
 * Which part of the day may be traded is the SESSION POLICY (Alpaca only):
 *   regular   09:30–16:00, the default
 *   extended  pre-market, regular and after-hours (the broker's extended session, normally 04:00–20:00)
 *   all       also the overnight session: Sunday 20:00 to Friday 20:00 without a break
 * `isOpen` means "the bot may trade now" under the policy. `isRegularOpen` is the regular session alone: outside it
 * Alpaca accepts only limit orders flagged as extended-hours.
 *
 * The overnight session is only assumed to exist on a night between two trading days (and the Sunday night before
 * a trading Monday), and only after a full 20:00 close. Anything unclear is treated as closed.
 */
export class MarketCalendar {
  private sessions = new Map<string, Session>();
  private ivCache: Interval[] | null = null;
  private lastClock: BrokerClock | null = null;
  private skewMs: number | null = null;
  private clockCheckedAt: number | null = null;
  private calendarLoadedAt: number | null = null;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly broker: BrokerAdapter,
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly maxClockSkewMs: number,
    readonly policy: SessionPolicy = 'regular',
  ) {}

  async start(): Promise<void> {
    await Promise.allSettled([this.refreshCalendar(), this.refreshClock()]);
    this.timers.push(setInterval(() => void this.refreshClock().catch(() => undefined), 30_000));
    this.timers.push(setInterval(() => void this.refreshCalendar().catch(() => undefined), 6 * 3_600_000));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Load sessions from 10 days back to 10 days ahead; falls back to the DB cache. */
  async refreshCalendar(): Promise<void> {
    const now = DateTime.fromMillis(this.clock.now(), { zone: NY });
    const start = now.minus({ days: 10 }).toISODate()!;
    const end = now.plus({ days: 10 }).toISODate()!;
    const exchange = this.broker.calendarSource === 'exchange';
    try {
      const days = await this.broker.getCalendar(start, end);
      this.setSessions(days);
      this.calendarLoadedAt = this.clock.now();
      // Only an exchange calendar is worth caching; a configured window is recomputed anyway.
      if (!exchange) return;
      for (const d of days) {
        await this.db.query(
          `INSERT INTO market_sessions(date, open_at, close_at, fetched_at) VALUES ($1,$2,$3,now())
           ON CONFLICT (date) DO UPDATE SET open_at = EXCLUDED.open_at, close_at = EXCLUDED.close_at, fetched_at = now()`,
          [d.date, iso(d.openMs), iso(d.closeMs)],
        );
      }
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'calendar fetch failed; using cached sessions');
      if (!exchange) throw err;
      const { rows } = await this.db.query<{ date: string | Date; open_at: Date; close_at: Date }>(
        `SELECT date, open_at, close_at FROM market_sessions WHERE date BETWEEN $1 AND $2`,
        [start, end],
      );
      if (rows.length) {
        this.setSessions(
          rows.map((r) => ({
            date: typeof r.date === 'string' ? r.date.slice(0, 10) : nyDate(new Date(r.date).getTime() + 12 * 3_600_000),
            openMs: new Date(r.open_at).getTime(),
            closeMs: new Date(r.close_at).getTime(),
          })),
        );
      }
      throw err;
    }
  }

  setSessions(days: BrokerCalendarDay[]): void {
    this.sessions.clear();
    for (const d of days) {
      // The extended session always contains the regular one; without the broker's times it is derived (04:00 to
      // four hours after the close: 20:00, or 17:00 on a half day).
      const extOpenMs = Math.min(d.extOpenMs ?? nyAt(d.date, 4), d.openMs);
      const extCloseMs = Math.max(d.extCloseMs ?? d.closeMs + 4 * HOUR, d.closeMs);
      this.sessions.set(d.date, { date: d.date, openMs: d.openMs, closeMs: d.closeMs, extOpenMs, extCloseMs });
    }
    this.ivCache = null;
  }

  async refreshClock(): Promise<void> {
    const c = await this.broker.getClock();
    this.lastClock = c;
    // Broker time ≈ local time at the midpoint of the request.
    this.skewMs = c.timestamp - (c.receivedAt - c.rttMs / 2);
    this.clockCheckedAt = this.clock.now();
    if (Math.abs(this.skewMs) > this.maxClockSkewMs) {
      this.logger.error({ skewMs: Math.round(this.skewMs) }, 'server clock differs from broker clock');
    }
  }

  get loaded(): boolean {
    return this.sessions.size > 0;
  }

  sessionFor(date: string): Session | null {
    return this.sessions.get(date) ?? null;
  }

  /** Today's regular session (New York), or null if today is not a trading day. */
  today(now = this.clock.now()): Session | null {
    return this.sessionFor(nyDate(now));
  }

  /** The regular session in progress, or the most recent one that has started. */
  currentOrLast(now = this.clock.now()): Session | null {
    let best: Session | null = null;
    for (const s of this.sessions.values()) {
      if (s.openMs <= now && (!best || s.openMs > best.openMs)) best = s;
    }
    return best;
  }

  /** Up to `n` most recent regular sessions that have started, oldest first. */
  recentSessions(n: number, now = this.clock.now()): Session[] {
    return [...this.sessions.values()]
      .filter((s) => s.openMs <= now)
      .sort((a, b) => a.openMs - b.openMs)
      .slice(-n);
  }

  nextSession(now = this.clock.now()): Session | null {
    let best: Session | null = null;
    for (const s of this.sessions.values()) {
      if (s.openMs > now && (!best || s.openMs < best.openMs)) best = s;
    }
    return best;
  }

  // ── Trading windows under the session policy ────────────────────────────

  /** Every stretch the deployment trades, in order (see the class comment for the overnight rule). */
  private intervals(): Interval[] {
    if (this.ivCache) return this.ivCache;
    const days = [...this.sessions.values()].sort((a, b) => a.openMs - b.openMs);
    const out: Interval[] = [];
    for (const s of days) {
      if (this.policy === 'regular') {
        out.push({ start: s.openMs, end: s.closeMs, kind: 'regular' });
        continue;
      }
      if (s.extOpenMs < s.openMs) out.push({ start: s.extOpenMs, end: s.openMs, kind: 'pre' });
      out.push({ start: s.openMs, end: s.closeMs, kind: 'regular' });
      if (s.closeMs < s.extCloseMs) out.push({ start: s.closeMs, end: s.extCloseMs, kind: 'post' });
    }
    if (this.policy === 'all' && days.length > 0) {
      let x = addDays(days[0]!.date, -1);
      const last = days[days.length - 1]!.date;
      for (; x < last; x = addDays(x, 1)) {
        const tomorrow = this.sessions.get(addDays(x, 1));
        if (!tomorrow) continue; // no trading day follows: no night
        const today = this.sessions.get(x);
        const sunday = DateTime.fromISO(x, { zone: NY }).weekday === 7;
        // A night follows a full trading day (closing at 20:00), or is the Sunday night before a trading Monday.
        const full = today !== undefined && today.extCloseMs === nyAt(x, 20);
        if (!full && !(sunday && today === undefined)) continue;
        out.push({ start: nyAt(x, 20), end: tomorrow.extOpenMs, kind: 'night' });
      }
    }
    out.sort((a, b) => a.start - b.start);
    this.ivCache = out;
    return out;
  }

  /** Index of the interval containing `t`, or -1. */
  private indexAt(t: number): number {
    const ivs = this.intervals();
    let lo = 0;
    let hi = ivs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const iv = ivs[mid]!;
      if (t < iv.start) hi = mid - 1;
      else if (t >= iv.end) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  /** End of the unbroken run of trading time that interval `i` belongs to (Friday 20:00 for a week of nights). */
  private runEnd(i: number): number {
    const ivs = this.intervals();
    let end = ivs[i]!.end;
    for (let j = i + 1; j < ivs.length && ivs[j]!.start === end; j++) end = ivs[j]!.end;
    return end;
  }

  /** The broker clock saying "closed" shortly after the scheduled open (an unscheduled closure) vetoes the regular session. */
  private regularVetoed(now: number, iv: Interval): boolean {
    const c = this.lastClock;
    return !!c && this.clockCheckedAt !== null && now - this.clockCheckedAt < 60_000 && c.timestamp > iv.start + 60_000 && c.isOpen === false;
  }

  /**
   * May the bot trade now, under the session policy? Unknown calendar → false (fail closed). A recent broker clock
   * reading of "closed" vetoes the regular session (e.g. an unscheduled closure), except right at the open where
   * the two can race. The broker clock says nothing about extended hours, so it cannot veto those.
   */
  isOpen(now = this.clock.now()): boolean {
    const i = this.indexAt(now);
    if (i < 0) return false;
    const iv = this.intervals()[i]!;
    return iv.kind === 'regular' ? !this.regularVetoed(now, iv) : true;
  }

  /** Is the REGULAR session open? Outside it, Alpaca takes only limit orders marked as extended-hours. */
  isRegularOpen(now = this.clock.now()): boolean {
    const t = this.today(now);
    if (!t || now < t.openMs || now >= t.closeMs) return false;
    return !this.regularVetoed(now, { start: t.openMs, end: t.closeMs, kind: 'regular' });
  }

  minutesToClose(now = this.clock.now()): number | null {
    const i = this.indexAt(now);
    if (i < 0) return null;
    return (this.runEnd(i) - now) / 60_000;
  }

  /**
   * Identifier of the trading day a bar belongs to, or null if the deployment does not trade at that time (such
   * bars are left out of indicators). VWAP restarts when it changes. Regular: the New York date. Extended and all:
   * the day runs from 04:00 to 04:00, so the overnight session belongs to the day before it.
   */
  sessionKey = (t: number): string | null => {
    if (this.policy === 'regular') {
      const s = this.sessions.get(nyDate(t));
      return s && t >= s.openMs && t < s.closeMs ? s.date : null;
    }
    return this.indexAt(t) >= 0 ? nightDate(t) : null;
  };

  /**
   * The trading day an instant belongs to, as a date: what "per day" limits and day counters mean. The New York date;
   * with overnight trading the day runs 04:00 to 04:00 (as it does for VWAP), so a night is not split at midnight
   * into two days with a fresh allowance each.
   */
  tradingDay = (t: number): string => (this.policy === 'all' ? nightDate(t) : nyDate(t));

  /** When the trading day containing `t` began. */
  tradingDayStart = (t: number): number => {
    const key = this.tradingDay(t);
    return this.policy === 'all' ? nyAt(key, 4) : DateTime.fromISO(key, { zone: NY }).startOf('day').toMillis();
  };

  /**
   * The window the indicators measure a bar against (the opening range hangs off its open): the regular session of
   * the bar's trading day, or, when that day has none (the Sunday night), the run of trading time the bar is in.
   */
  indicatorWindow(t: number): { openMs: number; closeMs: number } | null {
    if (this.policy === 'regular') {
      const s = this.sessions.get(nyDate(t));
      return s ? { openMs: s.openMs, closeMs: s.closeMs } : null;
    }
    const i = this.indexAt(t);
    if (i < 0) return null;
    const s = this.sessions.get(nightDate(t));
    if (s) return { openMs: s.openMs, closeMs: s.closeMs };
    return { openMs: this.intervals()[i]!.start, closeMs: this.runEnd(i) };
  }

  /** Where history for indicator warm-up should start: the start of the third most recent trading day. */
  warmUpFrom(now = this.clock.now()): number {
    const first = this.recentSessions(3, now)[0];
    if (!first) return now - 4 * 86_400_000;
    if (this.policy === 'regular') return first.openMs;
    return this.policy === 'all' ? first.extOpenMs - 8 * HOUR : first.extOpenMs;
  }

  clockStatus(): { brokerSkewMs: number | null; ok: boolean; checkedAt: number | null } {
    const fresh = this.clockCheckedAt !== null && this.clock.now() - this.clockCheckedAt < 120_000;
    const ok = fresh && this.skewMs !== null && Math.abs(this.skewMs) <= this.maxClockSkewMs;
    return { brokerSkewMs: this.skewMs === null ? null : Math.round(this.skewMs), ok, checkedAt: this.clockCheckedAt };
  }

  status(now = this.clock.now()): MarketStatusView {
    if (!this.loaded) {
      return {
        isOpen: false,
        label: 'UNKNOWN',
        sessions: this.policy,
        sessionOpen: null,
        sessionClose: null,
        nextOpen: this.lastClock?.nextOpen ?? null,
        nextClose: this.lastClock?.nextClose ?? null,
        earlyClose: false,
        checkedAt: this.clockCheckedAt,
      };
    }
    const today = this.today(now);
    const next = this.nextSession(now);
    const local = DateTime.fromMillis(now, { zone: NY });
    const closeLocal = today ? DateTime.fromMillis(today.closeMs, { zone: NY }) : null;
    const earlyClose = closeLocal !== null && closeLocal.hour < 16;

    if (this.policy !== 'regular') {
      const i = this.indexAt(now);
      const ivs = this.intervals();
      const iv = i >= 0 ? ivs[i]! : null;
      const open = this.isOpen(now);
      let label: MarketStatusView['label'];
      if (iv && open) label = iv.kind === 'regular' ? 'OPEN' : iv.kind === 'pre' ? 'PRE_MARKET' : iv.kind === 'post' ? 'AFTER_HOURS' : 'OVERNIGHT';
      else if (!today) label = local.weekday <= 5 ? 'HOLIDAY' : 'CLOSED';
      else label = 'CLOSED';
      // The next opening is the start of the next run; the next closing the end of the run in progress (or the next one).
      const startsAfter = i >= 0 ? this.runEnd(i) : now;
      const nextStart = ivs.find((x) => x.start >= startsAfter && x.start > now);
      const nextRunStart = nextStart ? nextStart.start : null;
      const nextIdx = nextStart ? ivs.indexOf(nextStart) : -1;
      return {
        isOpen: open,
        label,
        sessions: this.policy,
        sessionOpen: today?.openMs ?? null,
        sessionClose: today?.closeMs ?? null,
        nextOpen: nextRunStart,
        nextClose: open && i >= 0 ? this.runEnd(i) : nextIdx >= 0 ? this.runEnd(nextIdx) : null,
        earlyClose,
        checkedAt: this.clockCheckedAt,
      };
    }

    let label: MarketStatusView['label'];
    if (!today) {
      label = local.weekday <= 5 ? 'HOLIDAY' : 'CLOSED';
    } else if (this.isOpen(now)) {
      label = 'OPEN';
    } else if (now >= today.openMs && now < today.closeMs) {
      label = 'CLOSED';
    } else if (now < today.openMs && local.hour >= 4) {
      label = 'PRE_MARKET';
    } else if (now >= today.closeMs && local.hour < 20) {
      label = 'AFTER_HOURS';
    } else {
      label = 'CLOSED';
    }
    return {
      isOpen: label === 'OPEN',
      label,
      sessions: this.policy,
      sessionOpen: today?.openMs ?? null,
      sessionClose: today?.closeMs ?? null,
      nextOpen: label === 'OPEN' ? (next?.openMs ?? null) : today && now < today.openMs ? today.openMs : (next?.openMs ?? null),
      nextClose: today && now < today.closeMs ? today.closeMs : (next?.closeMs ?? null),
      earlyClose,
      checkedAt: this.clockCheckedAt,
    };
  }

  get calendarFetchedAt(): number | null {
    return this.calendarLoadedAt;
  }

  /** Broker clock's open flag at the last poll — used to cross-check the calendar. */
  brokerSaysOpen(): boolean | null {
    return this.lastClock?.isOpen ?? null;
  }
}
