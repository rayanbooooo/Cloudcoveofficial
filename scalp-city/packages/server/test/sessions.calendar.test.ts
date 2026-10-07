import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import type { SessionPolicy } from '@scalp-city/shared';
import type { BrokerAdapter, BrokerCalendarDay, BrokerClock } from '../src/broker/types.js';
import { ManualClock } from '../src/core/clock.js';
import { createTestLogger } from '../src/core/logger.js';
import type { Db } from '../src/db/db.js';
import { MarketCalendar } from '../src/market/MarketCalendar.js';

/**
 * The trading windows the session policy gives (regular / extended / all), against a calendar with the cases that
 * matter: a normal week, a midweek holiday, a half day, and a weekend between two trading days.
 *
 *   Mon 5 Oct   full day            Thu 8 Oct   full day
 *   Tue 6 Oct   full day            Fri 9 Oct   half day: 09:30–13:00, after-hours until 17:00
 *   Wed 7 Oct   HOLIDAY             Mon 12 Oct, Tue 13 Oct  full days
 */

const NY = 'America/New_York';
const at = (iso: string): number => DateTime.fromISO(iso, { zone: NY }).toMillis();

function day(date: string, o: { open?: string; close?: string; extOpen?: string; extClose?: string } = {}): BrokerCalendarDay {
  return {
    date,
    openMs: at(`${date}T${o.open ?? '09:30'}`),
    closeMs: at(`${date}T${o.close ?? '16:00'}`),
    extOpenMs: at(`${date}T${o.extOpen ?? '04:00'}`),
    extCloseMs: at(`${date}T${o.extClose ?? '20:00'}`),
  };
}

const DAYS: BrokerCalendarDay[] = [
  day('2026-10-05'),
  day('2026-10-06'),
  day('2026-10-08'),
  day('2026-10-09', { close: '13:00', extClose: '17:00' }),
  day('2026-10-12'),
  day('2026-10-13'),
];

function calendar(policy: SessionPolicy, now: string, days: BrokerCalendarDay[] = DAYS, brokerClock?: (c: ManualClock) => BrokerClock): MarketCalendar {
  const clock = new ManualClock(at(now));
  const broker = {
    calendarSource: 'exchange',
    getClock: async () => brokerClock!(clock),
  } as unknown as BrokerAdapter;
  const cal = new MarketCalendar(broker, {} as Db, clock, createTestLogger(), 2000, policy);
  cal.setSessions(days);
  return cal;
}

/** The calendar as of an instant, whatever the clock it was built with. */
const open = (policy: SessionPolicy, iso: string): boolean => calendar(policy, iso).isOpen(at(iso));
const regularOpen = (policy: SessionPolicy, iso: string): boolean => calendar(policy, iso).isRegularOpen(at(iso));

describe('session policy: when the bot may trade', () => {
  it('regular trades 09:30–16:00 on trading days and nothing else', () => {
    expect(open('regular', '2026-10-05T09:29:59')).toBe(false);
    expect(open('regular', '2026-10-05T09:30:00')).toBe(true);
    expect(open('regular', '2026-10-05T15:59:59')).toBe(true);
    expect(open('regular', '2026-10-05T16:00:00')).toBe(false);
    expect(open('regular', '2026-10-05T22:00:00')).toBe(false);
    expect(open('regular', '2026-10-07T12:00:00')).toBe(false); // holiday
    expect(open('regular', '2026-10-10T12:00:00')).toBe(false); // Saturday
  });

  it('extended adds pre-market and after-hours (04:00–20:00) but never the night', () => {
    expect(open('extended', '2026-10-05T03:59:59')).toBe(false);
    expect(open('extended', '2026-10-05T04:00:00')).toBe(true);
    expect(open('extended', '2026-10-05T06:30:00')).toBe(true);
    expect(open('extended', '2026-10-05T17:30:00')).toBe(true);
    expect(open('extended', '2026-10-05T19:59:59')).toBe(true);
    expect(open('extended', '2026-10-05T20:00:00')).toBe(false);
    expect(open('extended', '2026-10-06T02:00:00')).toBe(false);
  });

  it('all trades through the night: Sunday 20:00 to Friday 20:00 without a break', () => {
    expect(open('all', '2026-10-04T19:59:59')).toBe(false); // Sunday evening, before the session starts
    expect(open('all', '2026-10-04T20:00:00')).toBe(true);
    expect(open('all', '2026-10-05T01:30:00')).toBe(true); // Monday small hours
    expect(open('all', '2026-10-05T03:59:59')).toBe(true);
    expect(open('all', '2026-10-05T04:00:00')).toBe(true); // straight into pre-market
    expect(open('all', '2026-10-05T20:00:00')).toBe(true); // after-hours into the night
    expect(open('all', '2026-10-06T02:00:00')).toBe(true);
    expect(open('all', '2026-10-06T12:00:00')).toBe(true);
  });

  it('all is closed from Friday evening until Sunday 20:00', () => {
    // Thursday 8 Oct is a full day: its night runs into Friday 9 Oct, a half day that ends at 17:00.
    expect(open('all', '2026-10-09T02:00:00')).toBe(true);
    expect(open('all', '2026-10-09T16:59:59')).toBe(true);
    expect(open('all', '2026-10-09T17:00:00')).toBe(false);
    expect(open('all', '2026-10-09T23:00:00')).toBe(false);
    expect(open('all', '2026-10-10T03:00:00')).toBe(false);
    expect(open('all', '2026-10-10T12:00:00')).toBe(false);
    expect(open('all', '2026-10-11T19:59:00')).toBe(false);
    expect(open('all', '2026-10-11T20:00:00')).toBe(true); // Sunday night before a trading Monday
  });

  it('all has no night around a holiday', () => {
    // Tuesday 6 Oct closes at 20:00, but Wednesday is a holiday: no night follows, none precedes Thursday.
    expect(open('all', '2026-10-06T19:59:59')).toBe(true);
    expect(open('all', '2026-10-06T20:00:00')).toBe(false);
    expect(open('all', '2026-10-07T02:00:00')).toBe(false);
    expect(open('all', '2026-10-07T12:00:00')).toBe(false);
    expect(open('all', '2026-10-07T21:00:00')).toBe(false);
    expect(open('all', '2026-10-08T03:59:59')).toBe(false);
    expect(open('all', '2026-10-08T04:00:00')).toBe(true);
  });

  it('a half day shortens the extended session with it, and no night follows the early close', () => {
    expect(open('extended', '2026-10-09T16:59:59')).toBe(true);
    expect(open('extended', '2026-10-09T17:00:00')).toBe(false);
    expect(open('all', '2026-10-09T18:00:00')).toBe(false);
  });

  it('is closed when the calendar is not loaded (fail closed)', () => {
    for (const p of ['regular', 'extended', 'all'] as const) {
      const cal = calendar(p, '2026-10-05T11:00:00', []);
      expect(cal.isOpen(at('2026-10-05T11:00:00'))).toBe(false);
      expect(cal.isRegularOpen(at('2026-10-05T11:00:00'))).toBe(false);
    }
  });

  it('derives the extended session from the regular one when the broker gives no extended times', () => {
    const bare: BrokerCalendarDay[] = DAYS.map(({ date, openMs, closeMs }) => ({ date, openMs, closeMs }));
    const cal = calendar('extended', '2026-10-05T11:00:00', bare);
    expect(cal.isOpen(at('2026-10-05T04:00:00'))).toBe(true);
    expect(cal.isOpen(at('2026-10-05T19:59:00'))).toBe(true);
    expect(cal.isOpen(at('2026-10-05T20:00:00'))).toBe(false);
    // Half day: four hours after the early close.
    expect(cal.isOpen(at('2026-10-09T16:59:00'))).toBe(true);
    expect(cal.isOpen(at('2026-10-09T17:00:00'))).toBe(false);
  });
});

describe('the regular session on its own (decides limit-only orders)', () => {
  it('is 09:30–16:00 whatever the policy', () => {
    for (const p of ['regular', 'extended', 'all'] as const) {
      expect(regularOpen(p, '2026-10-05T09:29:59')).toBe(false);
      expect(regularOpen(p, '2026-10-05T09:30:00')).toBe(true);
      expect(regularOpen(p, '2026-10-05T15:59:59')).toBe(true);
      expect(regularOpen(p, '2026-10-05T16:00:00')).toBe(false);
      expect(regularOpen(p, '2026-10-05T03:00:00')).toBe(false);
      expect(regularOpen(p, '2026-10-07T12:00:00')).toBe(false);
    }
  });

  it('ends at the early close on a half day', () => {
    expect(regularOpen('all', '2026-10-09T12:59:59')).toBe(true);
    expect(regularOpen('all', '2026-10-09T13:00:00')).toBe(false);
    expect(open('all', '2026-10-09T13:00:00')).toBe(true); // still tradable, as after-hours
  });
});

describe('a broker clock reading of "closed"', () => {
  const closedClock = (c: ManualClock): BrokerClock => ({ timestamp: c.now(), isOpen: false, nextOpen: c.now() + 1000, nextClose: c.now() + 2000, receivedAt: c.now(), rttMs: 10 });

  it('vetoes the regular session (an unscheduled closure) but cannot veto extended hours', async () => {
    const now = '2026-10-05T11:00:00';
    const cal = calendar('all', now, DAYS, closedClock);
    await cal.refreshClock();
    expect(cal.isOpen(at(now))).toBe(false);
    expect(cal.isRegularOpen(at(now))).toBe(false);
    // The broker's clock only speaks for the regular session: pre-market and the night are not its call.
    expect(cal.isOpen(at('2026-10-05T04:30:00'))).toBe(true);
    expect(cal.isOpen(at('2026-10-05T17:00:00'))).toBe(true);
  });

  it('does not veto right at the open, where the clock and the calendar race', async () => {
    const now = '2026-10-05T09:30:20';
    const cal = calendar('all', now, DAYS, closedClock);
    await cal.refreshClock();
    expect(cal.isOpen(at(now))).toBe(true);
  });
});

describe('time to the end of the trading run', () => {
  const mins = (p: SessionPolicy, iso: string) => calendar(p, iso).minutesToClose(at(iso));

  it('regular: minutes to 16:00', () => {
    expect(mins('regular', '2026-10-05T15:30:00')).toBe(30);
    expect(mins('regular', '2026-10-05T10:00:00')).toBe(360);
    expect(mins('regular', '2026-10-05T17:00:00')).toBeNull();
  });

  it('extended: minutes to the 20:00 close of the extended session', () => {
    expect(mins('extended', '2026-10-05T19:30:00')).toBe(30);
    expect(mins('extended', '2026-10-05T10:00:00')).toBe(600);
    expect(mins('extended', '2026-10-05T22:00:00')).toBeNull();
  });

  it('all: minutes to the end of the whole unbroken run, not to tonight', () => {
    // Monday 10:00 → Tuesday 20:00 (Wednesday is a holiday, so the run stops there).
    expect(mins('all', '2026-10-05T10:00:00')).toBe(34 * 60);
    expect(mins('all', '2026-10-06T19:30:00')).toBe(30);
    // Thursday 04:00 → Friday 17:00 (half day).
    expect(mins('all', '2026-10-08T10:00:00')).toBe(31 * 60);
    expect(mins('all', '2026-10-09T16:30:00')).toBe(30);
    // Sunday night 20:00 → Tuesday 20:00 (Mon and Tue are full days, Wed is a holiday).
    expect(mins('all', '2026-10-11T21:00:00')).toBe(47 * 60);
    expect(mins('all', '2026-10-10T12:00:00')).toBeNull();
  });
});

describe('trading-day key (VWAP restarts when it changes)', () => {
  const key = (p: SessionPolicy, iso: string) => calendar(p, iso).sessionKey(at(iso));

  it('regular: the date, and only inside the session', () => {
    expect(key('regular', '2026-10-05T09:29:00')).toBeNull();
    expect(key('regular', '2026-10-05T09:30:00')).toBe('2026-10-05');
    expect(key('regular', '2026-10-05T15:59:00')).toBe('2026-10-05');
    expect(key('regular', '2026-10-05T17:00:00')).toBeNull();
  });

  it('extended: the day runs 04:00–20:00 and is one key', () => {
    expect(key('extended', '2026-10-05T03:59:00')).toBeNull();
    expect(key('extended', '2026-10-05T04:00:00')).toBe('2026-10-05');
    expect(key('extended', '2026-10-05T19:59:00')).toBe('2026-10-05');
    expect(key('extended', '2026-10-05T20:00:00')).toBeNull();
  });

  it('all: the day runs 04:00 to 04:00, so a night belongs to the day before it', () => {
    expect(key('all', '2026-10-04T21:00:00')).toBe('2026-10-04'); // Sunday night
    expect(key('all', '2026-10-05T03:59:00')).toBe('2026-10-04');
    expect(key('all', '2026-10-05T04:00:00')).toBe('2026-10-05'); // VWAP restarts at 04:00
    expect(key('all', '2026-10-05T21:00:00')).toBe('2026-10-05');
    expect(key('all', '2026-10-06T03:59:00')).toBe('2026-10-05');
    expect(key('all', '2026-10-06T04:00:00')).toBe('2026-10-06');
    expect(key('all', '2026-10-10T12:00:00')).toBeNull(); // weekend: not traded, so not part of any indicator
  });
});

describe('indicator window', () => {
  const win = (p: SessionPolicy, iso: string) => calendar(p, iso).indicatorWindow(at(iso));

  it('is the regular session of the bar’s trading day', () => {
    expect(win('all', '2026-10-05T10:00:00')).toEqual({ openMs: at('2026-10-05T09:30'), closeMs: at('2026-10-05T16:00') });
    expect(win('all', '2026-10-06T02:00:00')).toEqual({ openMs: at('2026-10-05T09:30'), closeMs: at('2026-10-05T16:00') }); // Monday’s night
    expect(win('extended', '2026-10-05T06:00:00')).toEqual({ openMs: at('2026-10-05T09:30'), closeMs: at('2026-10-05T16:00') });
    expect(win('regular', '2026-10-05T10:00:00')).toEqual({ openMs: at('2026-10-05T09:30'), closeMs: at('2026-10-05T16:00') });
  });

  it('is the run of trading time itself on the Sunday night, which has no regular session', () => {
    const w = win('all', '2026-10-05T01:00:00')!;
    expect(w.openMs).toBe(at('2026-10-04T20:00'));
    expect(w.closeMs).toBe(at('2026-10-06T20:00'));
  });

  it('is null when the deployment does not trade then', () => {
    expect(win('all', '2026-10-10T12:00:00')).toBeNull();
    expect(win('extended', '2026-10-05T22:00:00')).toBeNull();
  });
});

describe('indicator warm-up start', () => {
  it('regular: the open of the third most recent session', () => {
    const cal = calendar('regular', '2026-10-09T11:00:00');
    expect(cal.warmUpFrom(at('2026-10-09T11:00:00'))).toBe(at('2026-10-06T09:30'));
  });

  it('extended: from that day’s pre-market', () => {
    const cal = calendar('extended', '2026-10-09T11:00:00');
    expect(cal.warmUpFrom(at('2026-10-09T11:00:00'))).toBe(at('2026-10-06T04:00'));
  });

  it('all: starts a night earlier so the overnight bars before it are in', () => {
    const cal = calendar('all', '2026-10-09T11:00:00');
    expect(cal.warmUpFrom(at('2026-10-09T11:00:00'))).toBe(at('2026-10-05T20:00'));
  });
});

describe('market status for the UI', () => {
  const st = (p: SessionPolicy, iso: string) => calendar(p, iso).status(at(iso));

  it('names the session the market is in', () => {
    expect(st('all', '2026-10-05T01:00:00')).toMatchObject({ label: 'OVERNIGHT', isOpen: true, sessions: 'all' });
    expect(st('all', '2026-10-05T06:00:00')).toMatchObject({ label: 'PRE_MARKET', isOpen: true });
    expect(st('all', '2026-10-05T11:00:00')).toMatchObject({ label: 'OPEN', isOpen: true });
    expect(st('all', '2026-10-05T17:00:00')).toMatchObject({ label: 'AFTER_HOURS', isOpen: true });
    expect(st('all', '2026-10-05T21:00:00')).toMatchObject({ label: 'OVERNIGHT', isOpen: true });
  });

  it('says closed where nothing is traded, and holiday on a weekday without a session', () => {
    expect(st('all', '2026-10-10T12:00:00')).toMatchObject({ label: 'CLOSED', isOpen: false });
    expect(st('all', '2026-10-07T12:00:00')).toMatchObject({ label: 'HOLIDAY', isOpen: false });
    expect(st('extended', '2026-10-05T22:00:00')).toMatchObject({ label: 'CLOSED', isOpen: false, sessions: 'extended' });
  });

  it('regular keeps its labels, and is open only in the regular session', () => {
    expect(st('regular', '2026-10-05T06:00:00')).toMatchObject({ label: 'PRE_MARKET', isOpen: false, sessions: 'regular' });
    expect(st('regular', '2026-10-05T11:00:00')).toMatchObject({ label: 'OPEN', isOpen: true });
    expect(st('regular', '2026-10-05T17:00:00')).toMatchObject({ label: 'AFTER_HOURS', isOpen: false });
    expect(st('regular', '2026-10-05T22:00:00')).toMatchObject({ label: 'CLOSED', isOpen: false });
  });

  it('points at the start of the next run and the end of the one in progress', () => {
    // Friday evening: closed until Sunday 20:00.
    const fri = st('all', '2026-10-09T21:00:00');
    expect(fri.nextOpen).toBe(at('2026-10-11T20:00'));
    expect(fri.nextClose).toBe(at('2026-10-13T20:00')); // the run that follows: Sun night → Tue 20:00
    // Mid-run: the close is the end of the whole run, not tonight's 20:00.
    const mon = st('all', '2026-10-05T11:00:00');
    expect(mon.nextClose).toBe(at('2026-10-06T20:00'));
    expect(st('all', '2026-10-09T11:00:00').earlyClose).toBe(true);
  });
});

describe('the trading day behind "per day" limits', () => {
  const day = (p: SessionPolicy, iso: string) => calendar(p, iso).tradingDay(at(iso));
  const start = (p: SessionPolicy, iso: string) => calendar(p, iso).tradingDayStart(at(iso));

  it('is the New York date under the regular and extended policies, turning over at midnight', () => {
    for (const p of ['regular', 'extended'] as const) {
      expect(day(p, '2026-10-05T23:59:00')).toBe('2026-10-05');
      expect(day(p, '2026-10-06T00:00:00')).toBe('2026-10-06');
      expect(start(p, '2026-10-05T15:00:00')).toBe(at('2026-10-05T00:00'));
    }
  });

  it('with overnight trading runs 04:00 to 04:00, so the night is not split in two at midnight', () => {
    expect(day('all', '2026-10-05T03:59:00')).toBe('2026-10-04');
    expect(day('all', '2026-10-05T04:00:00')).toBe('2026-10-05');
    expect(day('all', '2026-10-05T23:30:00')).toBe('2026-10-05');
    expect(day('all', '2026-10-06T01:00:00')).toBe('2026-10-05'); // same day as 23:30 the evening before
    expect(day('all', '2026-10-06T04:00:00')).toBe('2026-10-06');
    expect(start('all', '2026-10-06T01:00:00')).toBe(at('2026-10-05T04:00'));
    expect(start('all', '2026-10-05T15:00:00')).toBe(at('2026-10-05T04:00'));
  });

  it('follows the clock through the change to standard time', () => {
    // 1 November 2026: the night of the change has 25 hours; the day still starts at 04:00 local.
    const cal = calendar('all', '2026-11-01T12:00:00');
    expect(cal.tradingDayStart(at('2026-11-01T12:00:00'))).toBe(at('2026-11-01T04:00'));
    expect(cal.tradingDay(at('2026-11-01T03:00:00'))).toBe('2026-10-31');
  });
});
