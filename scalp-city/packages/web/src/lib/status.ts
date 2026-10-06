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
}

/** Reasons that only mean "not yet": the market is shut, or a person asked entries to wait. */
const WAITING_CODES = new Set(['MARKET_CLOSED', 'ENTRIES_PAUSED']);

/** True for a reason that is a fault to fix; false for one that only needs time (or the person's own say-so). */
export function isFault(reason: HaltReason): boolean {
  return !WAITING_CODES.has(reason.code);
}

function localHM(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(ms);
}

export function autotradingState(system: SystemView, localTime: (ms: number) => string = localHM): AutotradingState {
  const reasons = system.trading.haltReasons.filter((r) => r.code !== 'AUTOTRADING_OFF');
  if (system.controls.killSwitch.active) return { label: 'KILL SWITCH ACTIVE', tone: 'halted', reasons, detail: null };
  if (!system.controls.autotrading) return { label: 'AUTOTRADING OFF', tone: 'off', reasons, detail: null };
  if (reasons.some(isFault)) return { label: 'AUTOTRADING HALTED', tone: 'halted', reasons, detail: null };
  if (reasons.some((r) => r.code === 'ENTRIES_PAUSED')) return { label: 'ENTRIES PAUSED', tone: 'waiting', reasons, detail: null };
  if (reasons.length === 0) return { label: 'AUTOTRADING ENABLED', tone: 'on', reasons, detail: null };

  const next = system.market.nextOpen;
  let detail: string | null = null;
  if (next !== null && next !== undefined) {
    const ny = hmET(next);
    const mine = localTime(next);
    detail = mine === ny ? `Opens ${ny}` : `Opens ${ny} ET · ${mine} your time`;
  }
  return { label: `AUTOTRADING ON · WAITING FOR THE ${system.venue === 'alpaca' ? 'MARKET' : 'SESSION'}`, tone: 'waiting', reasons, detail };
}
