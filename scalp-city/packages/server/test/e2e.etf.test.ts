import { afterEach, describe, expect, it } from 'vitest';
import type { JournalTradeView, Snapshot, WorkerView } from '@scalp-city/shared';
import { startE2E, type E2E } from './support/e2eHarness.js';

/**
 * ETF share workers (BROKER=alpaca, ALPACA_WORKER_SET=etf), end to end against the protocol-level fake
 * of Alpaca: market data → signal → risk → limit order → broker fill → ATR stop/target → exit → P&L.
 *
 * GLD stands in for gold. The scripted market is the same shape as the options flow: an opening range
 * near 300, a decline to 298.5, then a high-volume rally back through VWAP, EMA50 and the range high.
 * What these tests prove is the plumbing and the risk rules — not that the strategy makes money.
 */

const PRICES = { GLD: 300, QQQ: 600, DIA: 440, FXB: 125, FXE: 105 };
const ETF_IDS = ['etf-eur', 'etf-gbp', 'etf-gold', 'etf-nasdaq', 'etf-us30'];

function historyPath(symbol: string, i: number, base: number): number {
  if (symbol !== 'GLD') return base + Math.sin(i / 5) * 0.05;
  if (i < 15) return 300 + 0.15 * Math.sin(i);
  if (i < 60) return 300 - ((i - 15) * 1.5) / 45;
  return 298.5 + 0.02 * Math.sin(i);
}

let e: E2E | undefined;
afterEach(async () => {
  await e?.close();
  e = undefined;
});

async function start(env: Record<string, string> = {}): Promise<E2E> {
  e = await startE2E({ env: { ALPACA_WORKER_SET: 'etf', ...env }, fake: { symbols: PRICES, historyPath } });
  return e;
}

const snapshot = async (x: E2E) => (await x.api<Snapshot>('GET', '/api/snapshot')).body;
const worker = async (x: E2E, id: string): Promise<WorkerView> => (await snapshot(x)).workers.find((w) => w.config.id === id)!;

/** Print trades through the current minute, then close the bar one second after the minute ends. */
async function minute(x: E2E, price: number, volume: number): Promise<void> {
  for (let k = 1; k <= 5; k++) {
    x.fake.trade('GLD', price - 0.1 + (0.1 * k) / 5, volume / 5);
    for (const s of ['QQQ', 'DIA', 'FXB', 'FXE'] as const) x.fake.trade(s, PRICES[s], 100);
  }
  const now = x.clock.now();
  const nextMinute = Math.floor(now / 60_000) * 60_000 + 60_000;
  await x.advance(nextMinute + 1000 - now);
  const bar = x.fake.closeBar('GLD');
  for (const s of ['QQQ', 'DIA', 'FXB', 'FXE']) x.fake.closeBar(s);
  if (bar) await x.waitFor(async () => ((await worker(x, 'etf-gold')).signal.barTime ?? 0) >= bar.t, 'etf-gold evaluated the new bar');
}

async function ready(x: E2E): Promise<void> {
  await x.waitFor(async () => ((await snapshot(x)).system.phase === 'READY' ? true : null), 'system READY');
  expect((await x.api('POST', '/api/controls/autotrading', { enabled: true })).status).toBe(200);
  expect((await x.api('POST', '/api/workers/etf-gold/enabled', { enabled: true, confirmed: true })).status).toBe(200);
}

/** The scripted rally that charges a LONG setup on GLD. */
async function rally(x: E2E): Promise<void> {
  await minute(x, 298.8, 30_000);
  await minute(x, 299.2, 30_000);
  await minute(x, 299.65, 30_000);
  await minute(x, 300.1, 30_000);
  await minute(x, 300.5, 30_000);
}

describe('ETF share workers', () => {
  it('runs the five ETF workers and leaves the classic options workers out', async () => {
    const x = await start();
    const s = await x.waitFor(async () => {
      const snap = await snapshot(x);
      return snap.system.phase === 'READY' ? snap : null;
    }, 'system READY');
    expect(s.workers.map((w) => w.config.id).sort()).toEqual(ETF_IDS);
    expect(s.workers.every((w) => w.config.instrument === 'EQUITY' && !w.config.allowShort)).toBe(true);
    expect(s.workers.map((w) => w.config.symbol).sort()).toEqual(['DIA', 'FXB', 'FXE', 'GLD', 'QQQ']);
    for (const sym of ['GLD', 'QQQ', 'DIA', 'FXB', 'FXE']) expect(s.quotes[sym]!.last).not.toBeNull();
    expect(s.quotes.SPY).toBeUndefined();
  }, 60_000);

  it('buys with a server-held ATR stop, sized so the stop costs at most the risk limit, and exits on the target', async () => {
    const x = await start();
    await ready(x);
    await rally(x);

    const w = await x.waitFor(async () => {
      const ww = await worker(x, 'etf-gold');
      return ww.position ? ww : null;
    }, 'entry filled', 20_000);
    const p = w.position!;
    expect(p.assetClass).toBe('us_equity');
    expect(Number.isInteger(p.qty) && p.qty > 0).toBe(true);
    expect(p.stopSource).toBe('server'); // shares: this server holds the stop, not the broker
    expect(p.stopPrice!).toBeLessThan(p.avgEntryPrice);
    expect(p.targetPrice!).toBeGreaterThan(p.avgEntryPrice);
    expect(p.riskAtStop!).toBeLessThanOrEqual(10 + 1e-6); // riskPerTrade
    expect(p.riskAtStop!).toBeCloseTo(p.qty * (p.avgEntryPrice - p.stopPrice!), 6);

    const s = await x.waitFor(async () => {
      const snap = await snapshot(x);
      return snap.positions.length > 0 ? snap : null;
    }, 'broker position listed');
    const entry = s.orders.find((o) => o.workerId === 'etf-gold' && o.purpose === 'ENTRY')!;
    expect(entry.assetClass).toBe('us_equity');
    expect(entry.type).toBe('limit');
    expect(entry.state).toBe('FILLED');
    expect(entry.risk!.approved).toBe(true);
    const ids = entry.risk!.checks.map((c) => c.id);
    for (const id of ['stop_side', 'risk_per_trade', 'max_shares', 'buying_power', 'asset', 'data_fresh', 'market_open']) expect(ids).toContain(id);
    expect(x.fake.positions.get('GLD')!.qty).toBe(p.qty);
    // Nothing is placed at the broker besides the entry: the stop is enforced here.
    expect(x.fake.positions.size).toBe(1);

    // The target is reached: a non-urgent exit.
    x.fake.trade('GLD', p.targetPrice! + 0.1, 500);
    const flat = await x.waitFor(async () => {
      const ww = await worker(x, 'etf-gold');
      return !ww.position && ww.stats.tradesAllTime === 1 ? ww : null;
    }, 'take-profit exit filled', 25_000);
    expect(flat.stats.realizedToday).toBeGreaterThan(0);
    const j = (await x.api<JournalTradeView[]>('GET', '/api/journal')).body;
    expect(j).toHaveLength(1);
    expect(j[0]!.exitReason).toBe('TAKE_PROFIT');
    expect(j[0]!.status).toBe('CLOSED');
    await x.waitFor(async () => ((await snapshot(x)).positions.length === 0 ? true : null), 'broker positions flat');
    expect(x.fake.positions.size).toBe(0);
  }, 90_000);

  it('stops out when the market falls through the stop, losing about the risk limit and no more', async () => {
    const x = await start();
    await ready(x);
    await rally(x);
    const w = await x.waitFor(async () => {
      const ww = await worker(x, 'etf-gold');
      return ww.position ? ww : null;
    }, 'entry filled', 20_000);
    const p = w.position!;

    x.fake.trade('GLD', p.stopPrice! - 0.1, 500);
    await x.waitFor(async () => {
      const ww = await worker(x, 'etf-gold');
      return !ww.position && ww.stats.tradesAllTime === 1 ? ww : null;
    }, 'stop-loss exit filled', 25_000);
    const j = (await x.api<JournalTradeView[]>('GET', '/api/journal')).body;
    expect(j[0]!.exitReason).toBe('STOP_LOSS');
    expect(j[0]!.realizedPnl!).toBeLessThan(0);
    // Risk limit 10, plus the 10 cents the scripted market gapped through the stop, on a few shares.
    expect(j[0]!.realizedPnl!).toBeGreaterThan(-(10 + p.qty * 0.2));
    expect(x.fake.positions.size).toBe(0);
  }, 90_000);

  it('does not trade when one share is over the position limit, and says so', async () => {
    const x = await start({ MAX_POSITION_SIZE: '250', MAX_ORDER_NOTIONAL: '250' });
    await ready(x);
    await rally(x);
    const s = await x.waitFor(async () => {
      const snap = await snapshot(x);
      return snap.timeline.some((t) => t.title.includes('entry blocked')) ? snap : null;
    }, 'a blocked entry on the timeline', 20_000);
    const blocked = s.timeline.find((t) => t.title.includes('entry blocked'))!;
    expect(blocked.detail).toMatch(/one share costs \$3\d\d\.\d\d, over the \$250\.00 position limit/);
    expect(s.positions).toHaveLength(0);
    expect(x.fake.positions.size).toBe(0);
    expect((await worker(x, 'etf-gold')).position).toBeNull();
  }, 90_000);
});
