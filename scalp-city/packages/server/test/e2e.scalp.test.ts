import { afterEach, describe, expect, it } from 'vitest';
import type { JournalTradeView, Snapshot, WorkerView } from '@scalp-city/shared';
import { startE2E, type E2E } from './support/e2eHarness.js';

/**
 * The fast scalpers (ALPACA_WORKER_SET=scalp, the default) end to end against the Alpaca fake: 1-minute bars,
 * every READY bar its own entry, long and short, a stop and a target a fraction of an ATR away, and a worker
 * that is back in the market a bar after it leaves. The point is that it TRADES OFTEN and every trade still
 * passes risk and is sized from its stop. It says nothing about whether those trades make money.
 */

const PRICES = { GLD: 300, QQQ: 600, DIA: 440, FXB: 125, FXE: 105 };

/** A quiet morning around 300 (so VWAP and EMA20 sit near 300 and ATR is small). */
function flatHistory(symbol: string, i: number, base: number): number {
  return symbol === 'GLD' ? 300 + 0.04 * Math.sin(i / 3) : base + Math.sin(i / 5) * 0.05;
}

/** A quiet climb to 301.5 by 10:15, then flat: the next move down is a move against the trend. */
function climbHistory(symbol: string, i: number, base: number): number {
  if (symbol !== 'GLD') return base + Math.sin(i / 5) * 0.05;
  if (i < 15) return 300 + 0.04 * Math.sin(i);
  if (i < 45) return 300 + ((i - 15) * 1.5) / 30;
  return 301.5 + 0.03 * Math.sin(i);
}

let e: E2E | undefined;
afterEach(async () => {
  await e?.close();
  e = undefined;
});

const LOOSE = { MAX_TRADES_PER_DAY: '200', MAX_CONCURRENT_POSITIONS: '5', MAX_POSITION_SIZE: '5000', MAX_ORDER_NOTIONAL: '5000', MAX_ORDERS_PER_MINUTE: '60', MAX_DAILY_LOSS: '1000', MAX_SHARES: '100' };

async function start(history: (s: string, i: number, b: number) => number, env: Record<string, string> = {}): Promise<E2E> {
  e = await startE2E({ env: { ALPACA_WORKER_SET: 'scalp', ...LOOSE, ...env }, fake: { symbols: PRICES, historyPath: history } });
  return e;
}

const snapshot = async (x: E2E) => (await x.api<Snapshot>('GET', '/api/snapshot')).body;
const worker = async (x: E2E, id: string): Promise<WorkerView> => (await snapshot(x)).workers.find((w) => w.config.id === id)!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Print five trades ending at `price`, then close the bar one second after the minute ends. */
async function minute(x: E2E, from: number, price: number): Promise<void> {
  for (let k = 1; k <= 5; k++) {
    x.fake.trade('GLD', from + ((price - from) * k) / 5, 4_000);
    for (const s of ['QQQ', 'DIA', 'FXB', 'FXE'] as const) x.fake.trade(s, PRICES[s], 100);
  }
  const now = x.clock.now();
  const nextMinute = Math.floor(now / 60_000) * 60_000 + 60_000;
  await x.advance(nextMinute + 1000 - now);
  const bar = x.fake.closeBar('GLD');
  for (const s of ['QQQ', 'DIA', 'FXB', 'FXE']) x.fake.closeBar(s);
  if (bar) await x.waitFor(async () => ((await worker(x, 'scalp-gold')).signal.barTime ?? 0) >= bar.t, 'scalp-gold evaluated the new bar');
  await sleep(1300); // a worker tick or two: exits and the entry that follows a fill
}

async function ready(x: E2E): Promise<void> {
  await x.waitFor(async () => ((await snapshot(x)).system.phase === 'READY' ? true : null), 'system READY');
  expect((await x.api('POST', '/api/controls/autotrading', { enabled: true })).status).toBe(200);
  expect((await x.api('POST', '/api/workers/scalp-gold/enabled', { enabled: true, confirmed: true })).status).toBe(200);
}

describe('fast scalpers', () => {
  it('run the five 1-minute workers, long and short, with tight stops and short holds', async () => {
    const x = await start(flatHistory);
    const s = await x.waitFor(async () => {
      const snap = await snapshot(x);
      return snap.system.phase === 'READY' ? snap : null;
    }, 'system READY');
    expect(s.workers.map((w) => w.config.id).sort()).toEqual(['scalp-eur', 'scalp-gbp', 'scalp-gold', 'scalp-nasdaq', 'scalp-us30']);
    for (const w of s.workers) {
      expect(w.config.timeframe).toBe('1Min');
      expect(w.config.instrument).toBe('EQUITY');
      expect(w.config.allowShort).toBe(true);
      expect(w.config.exits).toMatchObject({ stopAtr: 1, targetAtr: 1.2, maxHoldMinutes: 4, cooldownBars: 1 });
      expect(w.config.params.rearmEachBar).toBe(true);
    }
  }, 60_000);

  it('buys again and again in a rising market: several round trips in a few minutes, each sized from its stop', async () => {
    const x = await start(flatHistory);
    await ready(x);
    let price = 300;
    for (let i = 0; i < 11; i++) {
      const next = price + 0.32;
      await minute(x, price, next);
      price = next;
    }
    const w = await worker(x, 'scalp-gold');
    const j = (await x.api<JournalTradeView[]>('GET', '/api/journal')).body;
    const closed = j.filter((t) => t.status === 'CLOSED');
    expect(closed.length + (w.position ? 1 : 0)).toBeGreaterThanOrEqual(4); // a patient strategy would have taken one
    expect(closed.every((t) => ['TAKE_PROFIT', 'TIME_STOP', 'STOP_LOSS', 'VWAP_LOST', 'END_OF_DAY'].includes(t.exitReason ?? ''))).toBe(true);
    expect(closed.filter((t) => t.exitReason === 'TAKE_PROFIT').length).toBeGreaterThanOrEqual(2);
    // Every entry passed risk with a stop whose loss is within the $5 per-trade limit.
    const s = await snapshot(x);
    const entries = s.orders.filter((o) => o.workerId === 'scalp-gold' && o.purpose === 'ENTRY' && o.state === 'FILLED');
    expect(entries.length).toBeGreaterThanOrEqual(4);
    for (const o of entries) {
      expect(o.side).toBe('buy');
      expect(o.risk!.approved).toBe(true);
      const atStop = o.risk!.checks.find((c) => c.id === 'risk_per_trade')!;
      expect(atStop.passed).toBe(true);
    }
    // One worker, one position at a time, and the setup chatter is not spammed onto the timeline.
    expect(s.positions.length).toBeLessThanOrEqual(1);
    expect(s.timeline.filter((t) => t.title.includes('signal reached')).length).toBeLessThanOrEqual(3);
  }, 120_000);

  it('goes short in a falling market, and covers on the target', async () => {
    const x = await start(climbHistory);
    await ready(x);
    let price = 301.5;
    for (let i = 0; i < 7; i++) {
      const next = price - 0.4;
      await minute(x, price, next);
      price = next;
    }
    const s = await snapshot(x);
    const shorts = s.orders.filter((o) => o.workerId === 'scalp-gold' && o.purpose === 'ENTRY' && o.side === 'sell' && o.state === 'FILLED');
    expect(shorts.length).toBeGreaterThanOrEqual(1);
    expect(shorts[0]!.assetClass).toBe('us_equity');
    expect(shorts[0]!.risk!.approved).toBe(true);
    expect(shorts[0]!.risk!.checks.find((c) => c.id === 'short')!.passed).toBe(true);
    const j = (await x.api<JournalTradeView[]>('GET', '/api/journal')).body;
    const covered = j.filter((t) => t.status === 'CLOSED' && t.direction === 'PUT');
    expect(covered.length).toBeGreaterThanOrEqual(1);
    expect(covered.some((t) => t.exitReason === 'TAKE_PROFIT' && (t.realizedPnl ?? 0) > 0)).toBe(true);
  }, 120_000);
});
