import { DateTime } from 'luxon';
import type { MarketStatusView } from '@scalp-city/shared';
import type { BrokerAdapter, BrokerCalendarDay, BrokerClock } from '../broker/types.js';
import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import type { Db } from '../db/db.js';
import { iso } from '../db/db.js';

const NY = 'America/New_York';

export interface Session {
  date: string;
  openMs: number;
  closeMs: number;
}

/** New York calendar date (YYYY-MM-DD) of an instant. */
export function nyDate(t: number): string {
  return DateTime.fromMillis(t, { zone: NY }).toISODate()!;
}

/**
 * US market calendar and clock (spec §63, §91). The broker's calendar is
 * the source of holidays and early closes — weekdays are never assumed to
 * be trading days. The broker clock is polled to detect server clock skew.
 */
export class MarketCalendar {
  private sessions = new Map<string, Session>();
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
    try {
      const days = await this.broker.getCalendar(start, end);
      this.setSessions(days);
      this.calendarLoadedAt = this.clock.now();
      for (const d of days) {
        await this.db.query(
          `INSERT INTO market_sessions(date, open_at, close_at, fetched_at) VALUES ($1,$2,$3,now())
           ON CONFLICT (date) DO UPDATE SET open_at = EXCLUDED.open_at, close_at = EXCLUDED.close_at, fetched_at = now()`,
          [d.date, iso(d.openMs), iso(d.closeMs)],
        );
      }
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'calendar fetch failed; using cached sessions');
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
    for (const d of days) this.sessions.set(d.date, { date: d.date, openMs: d.openMs, closeMs: d.closeMs });
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

  /** Today's session (New York), or null if today is not a trading day. */
  today(now = this.clock.now()): Session | null {
    return this.sessionFor(nyDate(now));
  }

  /** The session in progress, or the most recent one that has started. */
  currentOrLast(now = this.clock.now()): Session | null {
    let best: Session | null = null;
    for (const s of this.sessions.values()) {
      if (s.openMs <= now && (!best || s.openMs > best.openMs)) best = s;
    }
    return best;
  }

  /** Up to `n` most recent sessions that have started, oldest first. */
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

  /** Session key for indicator anchoring: the date if `t` is inside that date's regular session. */
  sessionKey = (t: number): string | null => {
    const s = this.sessions.get(nyDate(t));
    return s && t >= s.openMs && t < s.closeMs ? s.date : null;
  };

  /**
   * Regular session open right now? Unknown calendar → false (fail closed).
   * A recent broker clock reading of "closed" vetoes the calendar (e.g. an
   * unscheduled closure), except right at the open where the two can race.
   */
  isOpen(now = this.clock.now()): boolean {
    const s = this.today(now);
    if (!s) return false;
    if (now < s.openMs || now >= s.closeMs) return false;
    const c = this.lastClock;
    if (c && this.clockCheckedAt !== null && now - this.clockCheckedAt < 60_000 && c.timestamp > s.openMs + 60_000 && c.isOpen === false) {
      return false;
    }
    return true;
  }

  minutesToClose(now = this.clock.now()): number | null {
    const s = this.today(now);
    if (!s || now >= s.closeMs || now < s.openMs) return null;
    return (s.closeMs - now) / 60_000;
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
    const closeLocal = today ? DateTime.fromMillis(today.closeMs, { zone: NY }) : null;
    const earlyClose = closeLocal !== null && closeLocal.hour < 16;
    return {
      isOpen: label === 'OPEN',
      label,
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
