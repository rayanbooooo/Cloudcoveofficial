import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { mapCalendarDay } from '../src/broker/alpaca/mappers.js';
import { ConfigError, parseConfig } from '../src/config/env.js';
import { feedAt, feedSegments, isOvernightHour, nextFeedChange, streamPath, type FeedPlan } from '../src/marketdata/alpaca/feedPlan.js';

const NY = 'America/New_York';
const at = (iso: string): number => DateTime.fromISO(iso, { zone: NY }).toMillis();

describe('which data feed carries which hour', () => {
  const plan: FeedPlan = { primary: 'iex', overnight: 'overnight' };

  it('the overnight session is 20:00 up to 04:00 New York', () => {
    for (const h of ['2026-10-05T19:59:59']) expect(isOvernightHour(at(h))).toBe(false);
    for (const h of ['2026-10-05T20:00:00', '2026-10-05T23:59:59', '2026-10-06T00:00:00', '2026-10-06T03:59:59']) expect(isOvernightHour(at(h))).toBe(true);
    expect(isOvernightHour(at('2026-10-06T04:00:00'))).toBe(false);
  });

  it('the primary feed by day, the overnight feed at night', () => {
    expect(feedAt(plan, at('2026-10-05T12:00:00'))).toBe('iex');
    expect(feedAt(plan, at('2026-10-05T21:00:00'))).toBe('overnight');
    expect(feedAt({ primary: 'sip', overnight: 'boats' }, at('2026-10-06T02:00:00'))).toBe('boats');
  });

  it('with no overnight feed (regular or extended sessions) the primary feed is the only one', () => {
    const none: FeedPlan = { primary: 'sip', overnight: null };
    expect(feedAt(none, at('2026-10-05T02:00:00'))).toBe('sip');
    expect(feedAt(none, at('2026-10-05T12:00:00'))).toBe('sip');
  });

  it('finds the next changeover, strictly after now', () => {
    expect(nextFeedChange(at('2026-10-05T12:00:00'))).toBe(at('2026-10-05T20:00:00'));
    expect(nextFeedChange(at('2026-10-05T20:00:00'))).toBe(at('2026-10-06T04:00:00'));
    expect(nextFeedChange(at('2026-10-05T21:00:00'))).toBe(at('2026-10-06T04:00:00'));
    expect(nextFeedChange(at('2026-10-06T01:00:00'))).toBe(at('2026-10-06T04:00:00'));
    expect(nextFeedChange(at('2026-10-06T04:00:00'))).toBe(at('2026-10-06T20:00:00'));
  });

  it('follows the clock across the autumn change to standard time', () => {
    // 1 November 2026: clocks go back at 02:00, so that night is an hour longer.
    const before = DateTime.fromISO('2026-11-01T00:30:00', { zone: NY }).toMillis();
    expect(nextFeedChange(before)).toBe(DateTime.fromISO('2026-11-01T04:00:00', { zone: NY }).toMillis());
    expect(isOvernightHour(DateTime.fromISO('2026-11-01T03:59:00', { zone: NY }).toMillis())).toBe(true);
    expect(isOvernightHour(DateTime.fromISO('2026-11-01T04:00:00', { zone: NY }).toMillis())).toBe(false);
  });

  it('splits a stretch of history at each changeover and names the feed for each piece', () => {
    const segs = feedSegments(plan, at('2026-10-05T02:00:00'), at('2026-10-05T22:00:00'));
    expect(segs).toEqual([
      { feed: 'overnight', from: at('2026-10-05T02:00'), to: at('2026-10-05T04:00') },
      { feed: 'iex', from: at('2026-10-05T04:00'), to: at('2026-10-05T20:00') },
      { feed: 'overnight', from: at('2026-10-05T20:00'), to: at('2026-10-05T22:00') },
    ]);
  });

  it('does not split when there is one feed, and does not return empty pieces', () => {
    expect(feedSegments({ primary: 'sip', overnight: null }, at('2026-10-05T02:00:00'), at('2026-10-05T22:00:00'))).toEqual([{ feed: 'sip', from: at('2026-10-05T02:00'), to: at('2026-10-05T22:00') }]);
    expect(feedSegments(plan, at('2026-10-05T12:00:00'), at('2026-10-05T12:00:00'))).toEqual([]);
    expect(feedSegments(plan, at('2026-10-05T12:00:00'), at('2026-10-05T11:00:00'))).toEqual([]);
  });

  it('covers several days of warm-up history without gaps or overlaps', () => {
    const start = at('2026-10-05T20:00:00');
    const end = at('2026-10-08T11:00:00');
    const segs = feedSegments(plan, start, end);
    expect(segs[0]!.from).toBe(start);
    expect(segs[segs.length - 1]!.to).toBe(end);
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i]!.from).toBe(segs[i - 1]!.to);
      expect(segs[i]!.feed).not.toBe(segs[i - 1]!.feed);
    }
    expect(segs.map((s) => s.feed)).toEqual(['overnight', 'iex', 'overnight', 'iex', 'overnight', 'iex']);
  });

  it('knows each feed’s WebSocket path', () => {
    expect(streamPath('iex')).toBe('/v2/iex');
    expect(streamPath('sip')).toBe('/v2/sip');
    expect(streamPath('delayed_sip')).toBe('/v2/delayed_sip');
    expect(streamPath('overnight')).toBe('/v1beta1/overnight');
    expect(streamPath('boats')).toBe('/v1beta1/boats');
  });
});

describe('session configuration', () => {
  const base = { NODE_ENV: 'test', ALPACA_PAPER_API_KEY: 'k', ALPACA_PAPER_API_SECRET: 's' };

  it('trades the regular session only unless told otherwise', () => {
    const c = parseConfig(base);
    expect(c.sessions).toBe('regular');
    expect(c.offHoursExitBufferPct).toBe(0.5);
    expect(c.thresholds.offHoursMaxDataAgeMs).toBe(30_000);
  });

  it('accepts extended and all with the fast scalpers', () => {
    expect(parseConfig({ ...base, ALPACA_SESSIONS: 'extended' }).sessions).toBe('extended');
    expect(parseConfig({ ...base, ALPACA_SESSIONS: ' ALL ' }).sessions).toBe('all');
    expect(() => parseConfig({ ...base, ALPACA_SESSIONS: 'weekends' })).toThrow(ConfigError);
  });

  it('refuses extended hours for the options and the patient workers, which are built around the regular open', () => {
    for (const s of ['extended', 'all']) {
      expect(() => parseConfig({ ...base, ALPACA_SESSIONS: s, ALPACA_WORKER_SET: 'options' })).toThrow(/needs ALPACA_WORKER_SET=scalp/);
      expect(() => parseConfig({ ...base, ALPACA_SESSIONS: s, ALPACA_WORKER_SET: 'etf' })).toThrow(/needs ALPACA_WORKER_SET=scalp/);
    }
    expect(parseConfig({ ...base, ALPACA_WORKER_SET: 'options' }).sessions).toBe('regular');
  });

  it('is for Alpaca only', () => {
    const oanda = { NODE_ENV: 'test', BROKER: 'oanda', SESSION_SECRET: 'x'.repeat(40), OANDA_PRACTICE_TOKEN: 'abcdef0123456789-abcdef0123456789', OANDA_PRACTICE_ACCOUNT_ID: '101-004-12345678-001' };
    expect(() => parseConfig({ ...oanda, ALPACA_SESSIONS: 'all' })).toThrow(/only for BROKER=alpaca/);
    expect(parseConfig(oanda).sessions).toBe('regular');
  });

  it('picks the overnight feed that goes with the daytime one', () => {
    expect(parseConfig(base).overnightFeed).toBe('overnight'); // free plan: IEX by day, the overnight feed at night
    expect(parseConfig({ ...base, ALPACA_STOCK_FEED: 'sip' }).overnightFeed).toBe('boats');
    expect(parseConfig({ ...base, ALPACA_OVERNIGHT_FEED: 'boats' }).overnightFeed).toBe('boats');
    expect(parseConfig({ ...base, ALPACA_STOCK_FEED: 'sip', ALPACA_OVERNIGHT_FEED: 'overnight' }).overnightFeed).toBe('overnight');
    expect(() => parseConfig({ ...base, ALPACA_OVERNIGHT_FEED: 'moon' })).toThrow(ConfigError);
  });

  it('bounds the exit buffer and keeps the off-hours data age at least the regular one', () => {
    expect(parseConfig({ ...base, ALPACA_OFFHOURS_EXIT_BUFFER_PCT: '1.25' }).offHoursExitBufferPct).toBe(1.25);
    expect(() => parseConfig({ ...base, ALPACA_OFFHOURS_EXIT_BUFFER_PCT: '6' })).toThrow(/5 or less/);
    expect(() => parseConfig({ ...base, ALPACA_OFFHOURS_EXIT_BUFFER_PCT: '-1' })).toThrow(ConfigError);
    // A looser regular-hours limit is never undercut by the off-hours one.
    expect(parseConfig({ ...base, MAX_DATA_AGE_MS: '60000' }).thresholds.offHoursMaxDataAgeMs).toBe(60_000);
    expect(parseConfig({ ...base, ALPACA_OFFHOURS_MAX_DATA_AGE_MS: '90000' }).thresholds.offHoursMaxDataAgeMs).toBe(90_000);
  });
});

describe('Alpaca calendar rows', () => {
  it('carry the extended session when the broker gives one, with its early close', () => {
    const full = mapCalendarDay({ date: '2026-10-05', open: '09:30', close: '16:00', session_open: '0400', session_close: '2000' });
    expect(full).toEqual({ date: '2026-10-05', openMs: at('2026-10-05T09:30'), closeMs: at('2026-10-05T16:00'), extOpenMs: at('2026-10-05T04:00'), extCloseMs: at('2026-10-05T20:00') });
    const half = mapCalendarDay({ date: '2026-11-27', open: '09:30', close: '13:00', session_open: '0400', session_close: '1700' });
    expect(half.closeMs).toBe(at('2026-11-27T13:00'));
    expect(half.extCloseMs).toBe(at('2026-11-27T17:00'));
  });

  it('leave the extended session out when it is absent or unreadable, so it is derived from the regular one', () => {
    const bare = mapCalendarDay({ date: '2026-10-05', open: '09:30', close: '16:00' });
    expect(bare.extOpenMs).toBeUndefined();
    expect(bare.extCloseMs).toBeUndefined();
    const odd = mapCalendarDay({ date: '2026-10-05', open: '09:30', close: '16:00', session_open: 'soon', session_close: 'later' });
    expect(odd.extOpenMs).toBeUndefined();
    expect(odd.extCloseMs).toBeUndefined();
  });
});
