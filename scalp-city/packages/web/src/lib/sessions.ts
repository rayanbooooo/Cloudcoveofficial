import type { MarketStatusView, SessionPolicy } from '@scalp-city/shared';

/**
 * Which hours the deployment trades (ALPACA_SESSIONS on the server) in words, and which minute bars belong on a
 * live chart under that policy.
 */

/** Finishes "Workers trade …". */
export const SESSION_WORDS: Record<SessionPolicy, string> = {
  regular: 'the regular session only (09:30–16:00 New York)',
  extended: 'pre-market, regular hours and after-hours (04:00–20:00 New York, weekdays)',
  all: 'around the clock, from Sunday 20:00 to Friday 20:00 New York time',
};

export function sessionWords(m: Pick<MarketStatusView, 'sessions'> | null | undefined): string {
  return SESSION_WORDS[m?.sessions ?? 'regular'];
}

/**
 * A live minute bar is added to a chart only when the server's history for it would have included it. Under the
 * regular policy that is the regular session. With extended or overnight trading the server already leaves out
 * the hours it does not trade, and every bar it publishes is one it does.
 */
export function barInTradedWindow(m: Pick<MarketStatusView, 'sessions' | 'sessionOpen' | 'sessionClose'> | null | undefined, t: number): boolean {
  if (!m || (m.sessions ?? 'regular') !== 'regular') return true;
  if (m.sessionOpen === null) return true;
  return t >= m.sessionOpen && (m.sessionClose === null || t < m.sessionClose);
}
