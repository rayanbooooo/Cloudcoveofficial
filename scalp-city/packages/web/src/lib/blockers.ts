import type { HaltReason, SymbolQuoteView, SystemView, WorkerView } from '@scalp-city/shared';
import { age, countdown, hmET } from './format';
import { sessionWords } from './sessions';

/**
 * Why a worker is not placing an order right now, in plain words, from the state the server already
 * publishes. The signal can say READY while an order is still impossible (switches off, market closed,
 * stale data, a tripped breaker): this is the list a person needs to see next to it.
 */

/** What the person can do about a blocker from where they are looking. */
export type BlockerAction = 'autotrading' | 'worker' | 'resume' | 'release' | 'reset-breaker' | 'accept-reconciliation';

export interface Blocker {
  code: string;
  text: string;
  detail?: string;
  action?: BlockerAction;
  /** What the action applies to: the id of the breaker to reset. */
  target?: string;
}

export function timeframeMs(tf: string): number {
  const m = /^(\d+)(Min|Hour|Day)$/.exec(tf);
  if (!m) return 60_000;
  return Number(m[1]) * (m[2] === 'Min' ? 60_000 : m[2] === 'Hour' ? 3_600_000 : 86_400_000);
}

/**
 * The confirmed signal describes the last closed bar. When the market is closed, or no bar has closed for a
 * few bars, that is old news (a READY from yesterday's last bar is still READY on screen the next morning).
 */
export function signalIsStale(w: WorkerView, system: SystemView, now: number): boolean {
  if (!system.market.isOpen) return true;
  const t = w.signal.barTime;
  return t !== null && now - t > 3 * timeframeMs(w.config.timeframe) + 5_000;
}

const MARKET_WORDS: Record<string, string> = { PRE_MARKET: 'pre-market', AFTER_HOURS: 'after hours', OVERNIGHT: 'overnight', HOLIDAY: 'holiday', UNKNOWN: 'status unknown' };

function marketBlocker(system: SystemView, now: number): Blocker {
  const m = system.market;
  const opens = m.nextOpen !== null ? `Opens in ${countdown(m.nextOpen - now)} (${hmET(m.nextOpen)} ET).` : undefined;
  if (system.venue === 'oanda') return { code: 'MARKET_CLOSED', text: 'Outside the trading window', detail: opens };
  const policy = m.sessions ?? 'regular';
  const word = MARKET_WORDS[m.label];
  return {
    code: 'MARKET_CLOSED',
    text: word ? `Market closed (${word})` : 'Market closed',
    // Under the regular policy the other hours are a setting away: say which one, rather than leave it a mystery.
    detail: `${opens ? `${opens} ` : ''}Workers trade ${sessionWords(m)}.${policy === 'regular' ? ' To trade other hours, set ALPACA_SESSIONS to extended or all on the server.' : ''}`,
  };
}

/** Codes the first rules below cover themselves; the system's own list repeats them. */
const HANDLED = new Set(['KILL_SWITCH', 'AUTOTRADING_OFF', 'ENTRIES_PAUSED', 'MARKET_CLOSED']);

/**
 * Breakers a person can sensibly reset once the cause is gone. The others (daily loss, clock, account change)
 * come straight back until the cause really is fixed, so a reset button would only mislead.
 */
const RESETTABLE_BREAKERS = new Set(['ACCOUNT_MISMATCH', 'UNEXPECTED_POSITION', 'REJECTED_ORDERS', 'API_ERRORS']);

/** A worker's own halt text that only repeats a system reason ("HALTED · ACCOUNT MISMATCH"): the system list has it. */
const SYSTEM_HALT_TEXT = /^(HALTED · |SYSTEM |RECONCILIATION MISMATCH|KILL SWITCH)/;

/** A system-level reason entries are blocked, with what tripped it and, where one helps, the button that clears it. */
function systemReason(r: HaltReason, system: SystemView): Blocker {
  if (r.code.startsWith('BREAKER_')) {
    const id = r.code.slice('BREAKER_'.length);
    const why = system.breakers?.find((b) => b.id === id)?.detail ?? null;
    if (RESETTABLE_BREAKERS.has(id)) {
      return {
        code: r.code,
        text: r.message,
        detail: `${why ? `${why}. ` : ''}It stays on until you reset it, even after a restart. Once the cause is gone, reset it.`,
        action: 'reset-breaker',
        target: id,
      };
    }
    return { code: r.code, text: r.message, detail: why ?? undefined };
  }
  if (r.code === 'RECONCILIATION') {
    const found = system.reconciliation?.mismatches ?? [];
    if (found.length === 0) return { code: r.code, text: r.message };
    const what = found.map((m) => m.detail).join('; ');
    // Accepting the broker's state adopts positions; a stray order has to be cancelled at the broker.
    const acceptable = found.some((m) => m.kind !== 'UNEXPECTED_ORDER');
    return {
      code: r.code,
      text: r.message,
      detail: `${what ? `${what}. ` : ''}${acceptable ? 'Fix it at the broker, or accept the broker’s numbers.' : 'Cancel it at the broker; the check re-runs every 15 seconds.'}`,
      action: acceptable ? 'accept-reconciliation' : undefined,
    };
  }
  return { code: r.code, text: r.message };
}

export function entryBlockers(w: WorkerView, system: SystemView, quote: SymbolQuoteView | null | undefined, now: number): Blocker[] {
  // Holding a position or waiting on an order: it is not looking for an entry, so there is nothing to explain.
  if (w.position || w.activeOrderId) return [];
  const out: Blocker[] = [];
  const c = system.controls;
  if (c.killSwitch.active) out.push({ code: 'KILL_SWITCH', text: 'Kill switch is engaged', detail: 'All workers are stopped until it is released.', action: 'release' });
  if (!c.autotrading) out.push({ code: 'AUTOTRADING_OFF', text: 'Autotrading is off', detail: 'The switch in the top bar. It is off after every restart.', action: 'autotrading' });
  if (!w.autotradeEnabled) out.push({ code: 'WORKER_OFF', text: 'This worker is switched off', detail: 'Each worker has its own switch, off after every restart.', action: 'worker' });
  if (c.entriesPaused) out.push({ code: 'ENTRIES_PAUSED', text: 'Entries are paused', detail: 'PAUSE ENTRIES in the top bar: exits keep running.', action: 'resume' });
  if (!system.market.isOpen) out.push(marketBlocker(system, now));
  for (const r of system.trading.haltReasons) if (!HANDLED.has(r.code)) out.push(systemReason(r, system));
  if (w.market && w.market.listed === false) out.push({ code: 'NOT_OFFERED', text: 'Not offered to this account by the broker' });
  if (w.haltReason && !SYSTEM_HALT_TEXT.test(w.haltReason) && !out.some((b) => b.text === w.haltReason)) out.push({ code: 'WORKER_HALT', text: w.haltReason });
  // Data that went quiet while the market is open (when it is closed, that is the explanation already).
  if (system.market.isOpen && quote?.stale && !out.some((b) => b.code === 'DATA_STALE')) {
    out.push({ code: 'DATA_STALE', text: `No fresh ${w.config.symbol} price`, detail: quote.ageMs !== null ? `Last update ${age(quote.ageMs)} ago.` : undefined });
  }
  if (out.length === 0) {
    // Nothing is switched off or closed: the last risk check, if it is recent, is the reason.
    const r = w.signal.lastRisk;
    if (r && !r.approved && r.blockedBy && now - r.evaluatedAt < 3 * timeframeMs(w.config.timeframe) + 5_000) {
      out.push({ code: `RISK_${r.blockedBy.id}`, text: `Risk check: ${r.blockedBy.label}`, detail: r.blockedBy.detail });
    } else if (w.signal.consumed && w.signal.phase === 'READY') {
      out.push({ code: 'SIGNAL_USED', text: 'This setup already produced an order', detail: 'The worker waits for the next setup.' });
    }
  }
  return out;
}
