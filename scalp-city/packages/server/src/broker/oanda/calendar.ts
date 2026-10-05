import { DateTime } from 'luxon';
import type { BrokerCalendarDay } from '../types.js';

const NY = 'America/New_York';

/**
 * Trading sessions for OANDA instruments.
 *
 * FX, gold and index CFDs trade nearly around the clock, so "the session"
 * is the strategy's chosen window (default 09:30–16:00 New York, when the US
 * indices are open and liquidity is deepest) on weekdays. Optionally US
 * exchange holidays are skipped — index CFDs trade thin or halt then — and
 * half-days end at 13:00. These are rules of this installation, not facts
 * from the broker: OANDA's own "tradeable" flag on every price still has the
 * last word on whether an order can be placed.
 */

function nthWeekday(year: number, month: number, weekday: number, n: number): DateTime {
  let d = DateTime.fromObject({ year, month, day: 1 }, { zone: NY });
  while (d.weekday !== weekday) d = d.plus({ days: 1 });
  return d.plus({ weeks: n - 1 });
}

function lastWeekday(year: number, month: number, weekday: number): DateTime {
  let d = DateTime.fromObject({ year, month, day: 1 }, { zone: NY }).endOf('month').startOf('day');
  while (d.weekday !== weekday) d = d.minus({ days: 1 });
  return d;
}

/** Western Easter Sunday (anonymous Gregorian algorithm). */
function easter(year: number): DateTime {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return DateTime.fromObject({ year, month, day }, { zone: NY });
}

/** Saturday holidays are observed Friday, Sunday holidays Monday. */
function observed(d: DateTime): DateTime {
  if (d.weekday === 6) return d.minus({ days: 1 });
  if (d.weekday === 7) return d.plus({ days: 1 });
  return d;
}

/** NYSE full-day holidays for a year (YYYY-MM-DD). */
export function usMarketHolidays(year: number): Set<string> {
  const out = new Set<string>();
  const add = (d: DateTime) => out.add(d.toISODate()!);
  // New Year's Day: a Saturday New Year is NOT observed on the prior Friday (NYSE rule).
  const ny = DateTime.fromObject({ year, month: 1, day: 1 }, { zone: NY });
  if (ny.weekday !== 6) add(observed(ny));
  add(nthWeekday(year, 1, 1, 3)); // Martin Luther King Jr. Day
  add(nthWeekday(year, 2, 1, 3)); // Washington's Birthday
  add(easter(year).minus({ days: 2 })); // Good Friday
  add(lastWeekday(year, 5, 1)); // Memorial Day
  if (year >= 2022) add(observed(DateTime.fromObject({ year, month: 6, day: 19 }, { zone: NY }))); // Juneteenth
  add(observed(DateTime.fromObject({ year, month: 7, day: 4 }, { zone: NY }))); // Independence Day
  add(nthWeekday(year, 9, 1, 1)); // Labor Day
  add(nthWeekday(year, 11, 4, 4)); // Thanksgiving
  add(observed(DateTime.fromObject({ year, month: 12, day: 25 }, { zone: NY }))); // Christmas
  return out;
}

/** NYSE 13:00 early closes for a year (YYYY-MM-DD). */
export function usEarlyCloses(year: number): Set<string> {
  const out = new Set<string>();
  const weekday = (d: DateTime) => d.weekday <= 5;
  const july3 = DateTime.fromObject({ year, month: 7, day: 3 }, { zone: NY });
  const july4 = DateTime.fromObject({ year, month: 7, day: 4 }, { zone: NY });
  // The day before Independence Day, when the 4th itself falls Tuesday–Friday.
  if (weekday(july3) && july4.weekday >= 2 && july4.weekday <= 5) out.add(july3.toISODate()!);
  out.add(nthWeekday(year, 11, 4, 4).plus({ days: 1 }).toISODate()!); // day after Thanksgiving
  const dec24 = DateTime.fromObject({ year, month: 12, day: 24 }, { zone: NY });
  if (dec24.weekday <= 4) out.add(dec24.toISODate()!); // Christmas Eve, Mon–Thu
  return out;
}

export interface SessionRules {
  open: string; // "09:30"
  close: string; // "16:00"
  skipUsHolidays: boolean;
}

function atTime(date: DateTime, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return date.set({ hour: h, minute: m, second: 0, millisecond: 0 }).toMillis();
}

/** Sessions between two New York dates (inclusive). */
export function configuredSessions(startDate: string, endDate: string, rules: SessionRules): BrokerCalendarDay[] {
  const out: BrokerCalendarDay[] = [];
  let d = DateTime.fromISO(startDate, { zone: NY }).startOf('day');
  const end = DateTime.fromISO(endDate, { zone: NY }).startOf('day');
  const holidays = new Map<number, Set<string>>();
  const early = new Map<number, Set<string>>();
  for (let guard = 0; d <= end && guard < 400; guard++, d = d.plus({ days: 1 })) {
    if (d.weekday > 5) continue;
    const date = d.toISODate()!;
    if (rules.skipUsHolidays) {
      if (!holidays.has(d.year)) holidays.set(d.year, usMarketHolidays(d.year));
      if (holidays.get(d.year)!.has(date)) continue;
    }
    const openMs = atTime(d, rules.open);
    let closeMs = atTime(d, rules.close);
    if (rules.skipUsHolidays) {
      if (!early.has(d.year)) early.set(d.year, usEarlyCloses(d.year));
      if (early.get(d.year)!.has(date)) closeMs = Math.min(closeMs, atTime(d, '13:00'));
    }
    if (closeMs > openMs) out.push({ date, openMs, closeMs });
  }
  return out;
}

/** Whether `now` falls inside a session, plus the next open/close around it. */
export function sessionClock(now: number, rules: SessionRules): { isOpen: boolean; nextOpen: number; nextClose: number } {
  const today = DateTime.fromMillis(now, { zone: NY }).startOf('day');
  const sessions = configuredSessions(today.minus({ days: 1 }).toISODate()!, today.plus({ days: 14 }).toISODate()!, rules);
  const current = sessions.find((s) => now >= s.openMs && now < s.closeMs) ?? null;
  const next = sessions.find((s) => s.openMs > now) ?? null;
  const nextClose = current?.closeMs ?? next?.closeMs ?? now;
  return { isOpen: current !== null, nextOpen: next?.openMs ?? now, nextClose };
}
