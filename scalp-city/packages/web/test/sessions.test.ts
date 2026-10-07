import { describe, expect, it } from 'vitest';
import { SESSION_WORDS, barInTradedWindow, sessionWords } from '../src/lib/sessions';

const OPEN = Date.UTC(2026, 9, 5, 13, 30); // 09:30 New York
const CLOSE = Date.UTC(2026, 9, 5, 20, 0); // 16:00 New York
const MIN = 60_000;

describe('which hours are traded, in words', () => {
  it('has words for every policy, and defaults to the regular session', () => {
    expect(sessionWords({ sessions: 'regular' })).toBe(SESSION_WORDS.regular);
    expect(sessionWords({ sessions: 'extended' })).toContain('04:00–20:00');
    expect(sessionWords({ sessions: 'all' })).toContain('Sunday 20:00 to Friday 20:00');
    expect(sessionWords(null)).toBe(SESSION_WORDS.regular);
    expect(sessionWords({} as { sessions: 'regular' })).toBe(SESSION_WORDS.regular);
  });
});

describe('which live bars go on a chart', () => {
  const regular = { sessions: 'regular' as const, sessionOpen: OPEN, sessionClose: CLOSE };

  it('under the regular policy only the regular session’s bars', () => {
    expect(barInTradedWindow(regular, OPEN - MIN)).toBe(false);
    expect(barInTradedWindow(regular, OPEN)).toBe(true);
    expect(barInTradedWindow(regular, CLOSE - MIN)).toBe(true);
    expect(barInTradedWindow(regular, CLOSE)).toBe(false);
  });

  it('keeps the old behaviour when there is no session today (every bar is accepted; the server sends none)', () => {
    expect(barInTradedWindow({ sessions: 'regular', sessionOpen: null, sessionClose: null }, OPEN - 5 * MIN)).toBe(true);
  });

  it('with extended or overnight trading every bar the server publishes is one it trades', () => {
    for (const sessions of ['extended', 'all'] as const) {
      expect(barInTradedWindow({ sessions, sessionOpen: OPEN, sessionClose: CLOSE }, OPEN - 3 * 3_600_000)).toBe(true);
      expect(barInTradedWindow({ sessions, sessionOpen: OPEN, sessionClose: CLOSE }, CLOSE + 2 * 3_600_000)).toBe(true);
      expect(barInTradedWindow({ sessions, sessionOpen: null, sessionClose: null }, OPEN)).toBe(true);
    }
  });

  it('accepts everything while the market status is not known yet', () => {
    expect(barInTradedWindow(null, OPEN - MIN)).toBe(true);
    expect(barInTradedWindow(undefined, CLOSE + MIN)).toBe(true);
  });
});

import { dayHmET } from '../src/lib/format';

describe('a far-off moment as a weekday and time', () => {
  it('is in New York time', () => {
    expect(dayHmET(Date.UTC(2026, 9, 10, 0, 0))).toBe('Fri 20:00'); // Friday 20:00 EDT
    expect(dayHmET(Date.UTC(2026, 9, 12, 0, 0))).toBe('Sun 20:00');
    expect(dayHmET(null)).toBe('—');
  });
});
