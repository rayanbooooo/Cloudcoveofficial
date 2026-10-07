import type { HaltReason, SystemView } from '@scalp-city/shared';
import { hmET } from './format';

/**
 * What the status line says about autotrading. The server lists every reason a new entry is blocked right now,
 * and a closed market is one of them: but a closed market is not a fault. Calling it "halted" in red told people
 * something was broken when the bot was simply waiting for the open. Only reasons that mean the system cannot be
 * trusted (a tripped breaker, an account mismatch, a lost feed, the kill switch …) read as halted.
 */

export type AutotradingTone = 'off' | 'on' | 'waiting' | 'halted';

export interface AutotradingState {
  label: string;
  tone: AutotradingTone;
  /** Every reason entries are blocked, apart from the autotrading switch itself (that is the label). */
  reasons: HaltReason[];
  /** While waiting for the market: when it opens, in New York time and in the viewer's own. */
  detail: string | null;
  /**
   * Markets that have no fresh price while the others do (a thin ETF on the free feed is often one). Not a reason
   * to call anything halted: their own workers wait and the rest trade.
   */
  quiet: string[];
}

/**
 * Reasons that only mean "not yet": the market is shut, no market has a price yet (the server only says so when
 * EVERY market is quiet: a feed that is down is a phase reason, which is a fault), or a person asked entries to wait.
 */
const WAITING_CODES = new Set(['MARKET_CLOSED', 'DATA_STALE', 'ENTRIES_PAUSED']);

/** True for a reason that is a fault to fix; false for one that only needs time (or the person's own say-so). */
export function isFault(reason: HaltReason): boolean {
  return !WAITING_CODES.has(reason.code);
}

function localHM(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(ms);
}

/**
 * `watched`: the markets whose workers are switched on. A quiet market whose worker is off is nobody's problem, so
 * it is left out of the note (switching a thin market's worker off is how a person makes the note go away).
 */
export function autotradingState(system: SystemView, localTime: (ms: number) => string = localHM, watched?: ReadonlySet<string>): AutotradingState {
  const reasons = system.trading.haltReasons.filter((r) => r.code !== 'AUTOTRADING_OFF');
  const allQuiet = system.trading.quietMarkets ?? [];
  const quiet = reasons.some((r) => r.code === 'DATA_STALE') ? [] : watched ? allQuiet.filter((s) => watched.has(s)) : allQuiet;
  if (system.controls.killSwitch.active) return { label: 'KILL SWITCH ACTIVE', tone: 'halted', reasons, detail: null, quiet };
  if (!system.controls.autotrading) return { label: 'AUTOTRADING OFF', tone: 'off', reasons, detail: null, quiet };
  if (reasons.some(isFault)) return { label: 'AUTOTRADING HALTED', tone: 'halted', reasons, detail: null, quiet };
  if (reasons.some((r) => r.code === 'ENTRIES_PAUSED')) return { label: 'ENTRIES PAUSED', tone: 'waiting', reasons, detail: null, quiet };
  if (reasons.length === 0) return { label: 'AUTOTRADING ENABLED', tone: 'on', reasons, detail: null, quiet };

  if (!reasons.some((r) => r.code === 'MARKET_CLOSED')) {
    // Only "no market has a price": waiting for data, not for the open.
    return { label: 'AUTOTRADING ON · WAITING FOR MARKET DATA', tone: 'waiting', reasons, detail: 'No market has a fresh price right now.', quiet };
  }
  const next = system.market.nextOpen;
  let detail: string | null = null;
  if (next !== null && next !== undefined) {
    const ny = hmET(next);
    const mine = localTime(next);
    detail = mine === ny ? `Opens ${ny}` : `Opens ${ny} ET · ${mine} your time`;
  }
  return { label: `AUTOTRADING ON · WAITING FOR THE ${system.venue === 'alpaca' ? 'MARKET' : 'SESSION'}`, tone: 'waiting', reasons, detail, quiet };
}

/** The data chip in the top bar: is the feed up, real time, and how many markets have a fresh price. */
export function dataChip(system: SystemView): { label: string; tone: 'ok' | 'warn' | 'error' } {
  const md = system.marketData;
  if (md.stock.state !== 'CONNECTED') return { label: md.stock.state, tone: 'error' };
  if (!md.stockRealtime) return { label: 'DELAYED', tone: 'warn' };
  // The free plan's overnight feed: quotes in real time, trades (so bars, so signals) 15 minutes late.
  if (md.stockFeed === 'overnight') return { label: 'QUOTES ONLY', tone: 'warn' };
  const total = Object.keys(md.symbols).length;
  const quiet = system.market.isOpen ? (system.trading.quietMarkets ?? []).length : 0;
  if (total > 0 && quiet === total) return { label: 'STALE', tone: 'warn' };
  if (quiet > 0) return { label: `${total - quiet}/${total} LIVE`, tone: 'warn' };
  return { label: 'LIVE', tone: 'ok' };
}
