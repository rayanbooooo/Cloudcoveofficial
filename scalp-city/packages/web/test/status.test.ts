import { describe, expect, it } from 'vitest';
import type { SystemView } from '@scalp-city/shared';
import { autotradingState, dataChip } from '../src/lib/status';

/** 09:30 New York on a weekday: the US open. */
const OPEN_AT = Date.UTC(2026, 9, 6, 13, 30);
const localBelgium = () => '15:30';

function system(haltReasons: { code: string; message: string }[], controls: Record<string, unknown> = {}, market: Record<string, unknown> = {}, venue = 'alpaca'): SystemView {
  return {
    venue,
    controls: { autotrading: true, entriesPaused: false, killSwitch: { active: false }, ...controls },
    market: { isOpen: false, label: 'PRE_MARKET', nextOpen: OPEN_AT, ...market },
    trading: { haltReasons },
  } as unknown as SystemView;
}

const CLOSED = { code: 'MARKET_CLOSED', message: 'Market pre market' };

describe('what the status line says about autotrading', () => {
  it('a closed market is waiting, not halted, and says when it opens in the viewer’s own time', () => {
    const s = autotradingState(system([CLOSED]), localBelgium);
    expect(s.tone).toBe('waiting');
    expect(s.label).toBe('AUTOTRADING ON · WAITING FOR THE MARKET');
    expect(s.detail).toBe('Opens 09:30 ET · 15:30 your time');
    expect(s.reasons).toEqual([CLOSED]);
  });

  it('does not repeat the time when the viewer is on New York time', () => {
    const s = autotradingState(system([CLOSED]), () => '09:30');
    expect(s.detail).toBe('Opens 09:30');
  });

  it('is halted when anything beyond the market is wrong, even while the market is also closed', () => {
    const s = autotradingState(system([{ code: 'BREAKER_ACCOUNT_MISMATCH', message: 'Account mismatch' }, CLOSED]), localBelgium);
    expect(s.tone).toBe('halted');
    expect(s.label).toBe('AUTOTRADING HALTED');
    expect(s.detail).toBeNull();
    expect(s.reasons.map((r) => r.code)).toEqual(['BREAKER_ACCOUNT_MISMATCH', 'MARKET_CLOSED']);
  });

  it.each([
    ['RECONCILIATION', 'Account reconciliation mismatch'],
    ['BROKER', 'Broker DISCONNECTED'],
    ['CLOCK', 'Clock skew 4000ms'],
    ['PHASE', 'recovering'],
    ['DAILY_LOSS', 'Daily loss limit reached'],
    ['NOT_CONFIGURED', 'Broker credentials not configured'],
  ])('%s is a real fault: halted', (code, message) => {
    expect(autotradingState(system([{ code, message }], {}, { isOpen: true, label: 'OPEN', nextOpen: null }), localBelgium).tone).toBe('halted');
  });

  it('no market having a price is waiting for data, not halted: it clears by itself when the data comes back', () => {
    const stale = { code: 'DATA_STALE', message: 'Market data stale: GLD, QQQ, DIA, FXB, FXE' };
    const s = autotradingState(system([stale], {}, { isOpen: true, label: 'OPEN', nextOpen: null }), localBelgium);
    expect(s).toMatchObject({ tone: 'waiting', label: 'AUTOTRADING ON · WAITING FOR MARKET DATA', detail: 'No market has a fresh price right now.' });
    expect(s.reasons).toEqual([stale]);
    expect(s.quiet).toEqual([]); // the reason already says so
    // A feed that is down is a phase reason, and that is still a fault.
    expect(autotradingState(system([stale, { code: 'PHASE', message: 'market data disconnected' }], {}, { isOpen: true, label: 'OPEN' }), localBelgium).tone).toBe('halted');
  });

  it('some markets without a fresh price are a note, not a halt: the others trade', () => {
    const sys = system([], {}, { isOpen: true, label: 'OPEN', nextOpen: null });
    (sys.trading as { quietMarkets: string[] }).quietMarkets = ['FXB', 'FXE'];
    const s = autotradingState(sys, localBelgium);
    expect(s).toMatchObject({ tone: 'on', label: 'AUTOTRADING ENABLED', reasons: [], quiet: ['FXB', 'FXE'] });
  });

  it('leaves a quiet market out of the note when its worker is switched off', () => {
    const sys = system([], {}, { isOpen: true, label: 'OPEN', nextOpen: null });
    (sys.trading as { quietMarkets: string[] }).quietMarkets = ['FXB', 'FXE'];
    expect(autotradingState(sys, localBelgium, new Set(['GLD', 'QQQ', 'DIA'])).quiet).toEqual([]);
    expect(autotradingState(sys, localBelgium, new Set(['GLD', 'FXB'])).quiet).toEqual(['FXB']);
  });

  it('is enabled when nothing blocks entries', () => {
    const s = autotradingState(system([], {}, { isOpen: true, label: 'OPEN', nextOpen: null }), localBelgium);
    expect(s).toMatchObject({ tone: 'on', label: 'AUTOTRADING ENABLED', reasons: [] });
  });

  it('paused entries read as a pause, not a fault', () => {
    const s = autotradingState(system([{ code: 'ENTRIES_PAUSED', message: 'Entries paused' }], { entriesPaused: true }, { isOpen: true, label: 'OPEN' }), localBelgium);
    expect(s).toMatchObject({ tone: 'waiting', label: 'ENTRIES PAUSED' });
  });

  it('with autotrading off, says so and leaves the switch out of the reasons', () => {
    const s = autotradingState(system([{ code: 'AUTOTRADING_OFF', message: 'Autotrading off' }, CLOSED], { autotrading: false }), localBelgium);
    expect(s).toMatchObject({ tone: 'off', label: 'AUTOTRADING OFF' });
    expect(s.reasons).toEqual([CLOSED]);
  });

  it('the kill switch outranks everything', () => {
    const s = autotradingState(system([{ code: 'KILL_SWITCH', message: 'Kill switch active' }], { killSwitch: { active: true } }), localBelgium);
    expect(s).toMatchObject({ tone: 'halted', label: 'KILL SWITCH ACTIVE' });
  });

  it('a CFD broker waits for its session, not the market', () => {
    const s = autotradingState(system([{ code: 'MARKET_CLOSED', message: 'Outside the trading session' }], {}, {}, 'oanda'), localBelgium);
    expect(s.label).toBe('AUTOTRADING ON · WAITING FOR THE SESSION');
  });

  it('says nothing about the opening time when the server does not know it', () => {
    expect(autotradingState(system([CLOSED], {}, { nextOpen: null }), localBelgium).detail).toBeNull();
  });
});

describe('the data chip in the top bar', () => {
  function withData(over: Record<string, unknown> = {}, quiet: string[] = [], open = true): SystemView {
    return {
      market: { isOpen: open },
      trading: { quietMarkets: quiet },
      marketData: {
        stock: { state: 'CONNECTED' },
        stockRealtime: true,
        stockFeed: 'iex',
        symbols: { GLD: {}, QQQ: {}, DIA: {}, FXB: {}, FXE: {} },
        ...over,
      },
    } as unknown as SystemView;
  }

  it('says LIVE when every market has a fresh price', () => {
    expect(dataChip(withData())).toEqual({ label: 'LIVE', tone: 'ok' });
  });

  it('counts the markets with a price when a few are quiet, instead of calling the whole feed stale', () => {
    expect(dataChip(withData({}, ['FXB', 'FXE']))).toEqual({ label: '3/5 LIVE', tone: 'warn' });
  });

  it('says STALE only when no market has a fresh price', () => {
    expect(dataChip(withData({}, ['GLD', 'QQQ', 'DIA', 'FXB', 'FXE']))).toEqual({ label: 'STALE', tone: 'warn' });
  });

  it('ignores quiet markets while the market is closed, and reports a feed that is down or late as such', () => {
    expect(dataChip(withData({}, ['FXB'], false))).toEqual({ label: 'LIVE', tone: 'ok' });
    expect(dataChip(withData({ stock: { state: 'RECONNECTING' } }))).toEqual({ label: 'RECONNECTING', tone: 'error' });
    expect(dataChip(withData({ stockRealtime: false }))).toEqual({ label: 'DELAYED', tone: 'warn' });
    expect(dataChip(withData({ stockFeed: 'overnight' }))).toEqual({ label: 'QUOTES ONLY', tone: 'warn' });
  });
});
