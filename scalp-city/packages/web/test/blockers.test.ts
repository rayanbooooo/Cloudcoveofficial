import { describe, expect, it } from 'vitest';
import type { SymbolQuoteView, SystemView, WorkerView } from '@scalp-city/shared';
import { entryBlockers, signalIsStale, timeframeMs } from '../src/lib/blockers';

/** 11:30 New York on a weekday; the US session opens two hours later. */
const NOW = Date.UTC(2026, 9, 6, 11, 30);
const OPEN_AT = Date.UTC(2026, 9, 6, 13, 30);

function worker(over: Record<string, unknown> = {}, signal: Record<string, unknown> = {}): WorkerView {
  return {
    config: { id: 'scalp-nasdaq', symbol: 'QQQ', timeframe: '1Min', params: { readyThreshold: 60 } },
    autotradeEnabled: true,
    haltReason: null,
    position: null,
    activeOrderId: null,
    market: null,
    signal: { phase: 'READY', charge: 100, barTime: NOW - 60_000, consumed: false, lastRisk: null, ...signal },
    ...over,
  } as unknown as WorkerView;
}

function system(over: Record<string, unknown> = {}, market: Record<string, unknown> = {}, controls: Record<string, unknown> = {}, haltReasons: { code: string; message: string }[] = []): SystemView {
  return {
    venue: 'alpaca',
    controls: { autotrading: true, entriesPaused: false, killSwitch: { active: false }, ...controls },
    market: { isOpen: true, label: 'OPEN', nextOpen: null, ...market },
    trading: { haltReasons },
    ...over,
  } as unknown as SystemView;
}

const codes = (b: { code: string }[]) => b.map((x) => x.code);

describe('why a READY signal is not placing', () => {
  it('says all three things in the way before the open: autotrading off, worker off, market closed', () => {
    // The pre-market screen of a worker that had been switched on a moment ago, with the master switch still off.
    const sys = system(
      {},
      { isOpen: false, label: 'PRE_MARKET', nextOpen: OPEN_AT },
      { autotrading: false },
      [
        { code: 'AUTOTRADING_OFF', message: 'Autotrading off' },
        { code: 'MARKET_CLOSED', message: 'Market pre market' },
      ],
    );
    const b = entryBlockers(worker({ autotradeEnabled: false }), sys, null, NOW);
    expect(codes(b)).toEqual(['AUTOTRADING_OFF', 'WORKER_OFF', 'MARKET_CLOSED']);
    expect(b[0]!.action).toBe('autotrading');
    expect(b[1]!.action).toBe('worker');
    expect(b[2]!.action).toBeUndefined();
    expect(b[2]!.text).toContain('pre-market');
    expect(b[2]!.detail).toContain('Opens in 2h 00m (09:30 ET)');
    expect(b[2]!.detail).toContain('regular session');
  });

  it('is silent when nothing is in the way', () => {
    expect(entryBlockers(worker(), system(), null, NOW)).toEqual([]);
  });

  it('is silent while holding a position or waiting for an order: it is not looking for an entry', () => {
    const sys = system({}, {}, { autotrading: false });
    expect(entryBlockers(worker({ position: { qty: 3 } }), sys, null, NOW)).toEqual([]);
    expect(entryBlockers(worker({ activeOrderId: 'o1' }), sys, null, NOW)).toEqual([]);
  });

  it('puts the kill switch first and offers to release it', () => {
    const b = entryBlockers(worker(), system({}, {}, { killSwitch: { active: true } }, [{ code: 'KILL_SWITCH', message: 'Kill switch active' }]), null, NOW);
    expect(codes(b)).toEqual(['KILL_SWITCH']);
    expect(b[0]!.action).toBe('release');
  });

  it('offers to resume paused entries', () => {
    const b = entryBlockers(worker(), system({}, {}, { entriesPaused: true }, [{ code: 'ENTRIES_PAUSED', message: 'Entries paused' }]), null, NOW);
    expect(codes(b)).toEqual(['ENTRIES_PAUSED']);
    expect(b[0]!.action).toBe('resume');
  });

  it('passes the system’s other halt reasons through once (breakers, reconciliation, the broker)', () => {
    const halts = [
      { code: 'BREAKER_DAILY_LOSS', message: 'Daily loss limit' },
      { code: 'RECONCILIATION', message: 'Account reconciliation mismatch' },
    ];
    expect(codes(entryBlockers(worker(), system({}, {}, {}, halts), null, NOW))).toEqual(['BREAKER_DAILY_LOSS', 'RECONCILIATION']);
  });

  it('reports a worker’s own halt, and an instrument the broker does not offer', () => {
    const b = entryBlockers(worker({ haltReason: 'DAILY LIMIT REACHED', market: { listed: false } }), system(), null, NOW);
    expect(codes(b)).toEqual(['NOT_OFFERED', 'WORKER_HALT']);
  });

  it('flags a price that went quiet while the market is open, once', () => {
    const quiet = { stale: true, ageMs: 95_000 } as SymbolQuoteView;
    const b = entryBlockers(worker(), system(), quiet, NOW);
    expect(codes(b)).toEqual(['DATA_STALE']);
    expect(b[0]!.detail).toContain('1m');
    // The system already said so: not repeated.
    expect(codes(entryBlockers(worker(), system({}, {}, {}, [{ code: 'DATA_STALE', message: 'Market data stale: QQQ' }]), quiet, NOW))).toEqual(['DATA_STALE']);
    // Closed market: that is the explanation, the stale price is not added.
    expect(codes(entryBlockers(worker(), system({}, { isOpen: false, label: 'CLOSED' }), quiet, NOW))).toEqual(['MARKET_CLOSED']);
  });

  it('falls back to the last risk check, if it is recent, when nothing is switched off or closed', () => {
    const blocked = { approved: false, evaluatedAt: NOW - 30_000, blockedBy: { id: 'max_positions', label: 'Position limit', passed: false, detail: '2 open, limit 2' }, checks: [] };
    const b = entryBlockers(worker({}, { lastRisk: blocked }), system(), null, NOW);
    expect(codes(b)).toEqual(['RISK_max_positions']);
    expect(b[0]!.detail).toBe('2 open, limit 2');
    expect(entryBlockers(worker({}, { lastRisk: { ...blocked, evaluatedAt: NOW - 3_600_000 } }), system(), null, NOW)).toEqual([]);
  });

  it('notes a used setup when that is all there is to say', () => {
    expect(codes(entryBlockers(worker({}, { consumed: true }), system(), null, NOW))).toEqual(['SIGNAL_USED']);
  });

  it('words the closed OANDA session as a trading window', () => {
    const b = entryBlockers(worker(), system({ venue: 'oanda' }, { isOpen: false, label: 'CLOSED', nextOpen: OPEN_AT }), null, NOW);
    expect(b[0]!.text).toBe('Outside the trading window');
    expect(b[0]!.detail).toBe('Opens in 2h 00m (09:30 ET).');
  });
});

describe('clearing what is in the way from the same list', () => {
  const tripped = (id: string, label: string, detail: string | null) => ({ id, label, tripped: true, trippedAt: NOW - 3_600_000, detail, latched: true });
  const mismatch = (kind: string, detail: string) => ({ kind, symbol: 'QQQ', local: 0, broker: -100, detail });

  it('offers to reset a latched account-mismatch breaker, and says what tripped it', () => {
    // What the live screen showed: the account is clean again, but the breaker from the mismatch is still latched.
    const sys = system(
      { breakers: [tripped('ACCOUNT_MISMATCH', 'Account mismatch', 'open sell order for 100 QQQ not placed by Scalp City')], reconciliation: { status: 'RECONCILED', mismatches: [] } },
      { isOpen: false, label: 'PRE_MARKET', nextOpen: OPEN_AT },
      {},
      [
        { code: 'BREAKER_ACCOUNT_MISMATCH', message: 'Account mismatch' },
        { code: 'MARKET_CLOSED', message: 'Market pre market' },
      ],
    );
    const b = entryBlockers(worker({ haltReason: 'HALTED · ACCOUNT MISMATCH' }), sys, null, NOW);
    expect(codes(b)).toEqual(['MARKET_CLOSED', 'BREAKER_ACCOUNT_MISMATCH']);
    const breaker = b[1]!;
    expect(breaker.action).toBe('reset-breaker');
    expect(breaker.target).toBe('ACCOUNT_MISMATCH');
    expect(breaker.detail).toContain('open sell order for 100 QQQ not placed by Scalp City');
    expect(breaker.detail).toContain('stays on until you reset it');
  });

  it('offers no reset for a breaker that would come straight back', () => {
    for (const id of ['DAILY_LOSS', 'CLOCK', 'ACCOUNT_CHANGED']) {
      const sys = system({ breakers: [tripped(id, 'x', 'because')] }, {}, {}, [{ code: `BREAKER_${id}`, message: 'x' }]);
      const [only] = entryBlockers(worker(), sys, null, NOW);
      expect(only!.action).toBeUndefined();
      expect(only!.detail).toBe('because');
    }
  });

  it('offers to accept the broker’s state for a position mismatch, but not for a stray order that must be cancelled', () => {
    const halts = [{ code: 'RECONCILIATION', message: 'Account reconciliation mismatch' }];
    const position = system({ reconciliation: { status: 'MISMATCH', mismatches: [mismatch('UNEXPECTED_POSITION', 'broker holds -111 QQQ; Scalp City has no record of opening it')] } }, {}, {}, halts);
    const [p] = entryBlockers(worker(), position, null, NOW);
    expect(p!.action).toBe('accept-reconciliation');
    expect(p!.detail).toContain('broker holds -111 QQQ');

    const order = system({ reconciliation: { status: 'MISMATCH', mismatches: [mismatch('UNEXPECTED_ORDER', 'open sell order for 100 QQQ not placed by Scalp City')] } }, {}, {}, halts);
    const [o] = entryBlockers(worker(), order, null, NOW);
    expect(o!.action).toBeUndefined();
    expect(o!.detail).toContain('Cancel it at the broker');
  });

  it('does not repeat a system halt in the worker’s own words, but keeps the worker’s own reasons', () => {
    const halts = [{ code: 'BREAKER_ACCOUNT_MISMATCH', message: 'Account mismatch' }];
    for (const text of ['HALTED · ACCOUNT MISMATCH', 'RECONCILIATION MISMATCH', 'SYSTEM RECOVERING', 'KILL SWITCH']) {
      expect(codes(entryBlockers(worker({ haltReason: text }), system({}, {}, {}, halts), null, NOW))).not.toContain('WORKER_HALT');
    }
    expect(codes(entryBlockers(worker({ haltReason: 'WORKER DAILY LOSS LIMIT' }), system({}, {}, {}, halts), null, NOW))).toContain('WORKER_HALT');
  });
});

describe('a READY that is really the last bar of the previous session', () => {
  it('is stale while the market is closed, however recent the bar looks', () => {
    expect(signalIsStale(worker(), system({}, { isOpen: false, label: 'PRE_MARKET' }), NOW)).toBe(true);
  });

  it('is stale when no bar has closed for more than three bars during the session', () => {
    expect(signalIsStale(worker({}, { barTime: NOW - 10 * 60_000 }), system(), NOW)).toBe(true);
    expect(signalIsStale(worker({}, { barTime: NOW - 60_000 }), system(), NOW)).toBe(false);
  });

  it('counts the worker’s own timeframe', () => {
    const five = worker({ config: { id: 'etf-gold', symbol: 'GLD', timeframe: '5Min', params: { readyThreshold: 60 } } }, { barTime: NOW - 10 * 60_000 });
    expect(signalIsStale(five, system(), NOW)).toBe(false);
    expect(timeframeMs('5Min')).toBe(300_000);
    expect(timeframeMs('15Min')).toBe(900_000);
    expect(timeframeMs('1Hour')).toBe(3_600_000);
    expect(timeframeMs('weird')).toBe(60_000);
  });
});
