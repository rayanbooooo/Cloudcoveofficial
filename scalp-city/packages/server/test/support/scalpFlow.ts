import { expect } from 'vitest';
import type { Snapshot, WorkerView } from '@scalp-city/shared';
import type { OrderRequest } from '../../src/orders/types.js';
import type { E2E } from './e2eHarness.js';

/** Helpers shared by the end-to-end tests that drive the fast scalpers minute by minute against the Alpaca fake. */

export const PRICES = { GLD: 300, QQQ: 600, DIA: 440, FXB: 125, FXE: 105 };

/** A quiet stretch around 300 (so VWAP and EMA20 sit near 300 and ATR is small). */
export function flatHistory(symbol: string, i: number, base: number): number {
  return symbol === 'GLD' ? 300 + 0.04 * Math.sin(i / 3) : base + Math.sin(i / 5) * 0.05;
}

export const LOOSE = { MAX_TRADES_PER_DAY: '200', MAX_CONCURRENT_POSITIONS: '5', MAX_POSITION_SIZE: '5000', MAX_ORDER_NOTIONAL: '5000', MAX_ORDERS_PER_MINUTE: '60', MAX_DAILY_LOSS: '1000', MAX_SHARES: '100' };

export const snapshot = async (x: E2E): Promise<Snapshot> => (await x.api<Snapshot>('GET', '/api/snapshot')).body;
export const worker = async (x: E2E, id: string): Promise<WorkerView> => (await snapshot(x)).workers.find((w) => w.config.id === id)!;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Print five trades ending at `price`, then close the bar one second after the minute ends. */
export async function minute(x: E2E, from: number, price: number): Promise<void> {
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

/** Wait for the system, then switch autotrading and the gold worker on. */
export async function ready(x: E2E): Promise<void> {
  await x.waitFor(async () => ((await snapshot(x)).system.phase === 'READY' ? true : null), 'system READY');
  expect((await x.api('POST', '/api/controls/autotrading', { enabled: true })).status).toBe(200);
  expect((await x.api('POST', '/api/workers/scalp-gold/enabled', { enabled: true, confirmed: true })).status).toBe(200);
}

/** A worker's long entry of one share with a stop a dollar below, fresh as of now: what a risk preview is asked about. */
export function shareEntryRequest(x: E2E, workerId: string, symbol: string, price: number): OrderRequest & { signalBarCloseAt: number; referencePrice: number } {
  return {
    workerId,
    source: 'WORKER',
    purpose: 'ENTRY',
    signalId: `preview:${symbol}:${x.clock.now()}`,
    symbol,
    underlying: symbol,
    assetClass: 'us_equity',
    side: 'buy',
    positionIntent: null,
    type: 'limit',
    timeInForce: 'day',
    qty: 1,
    limitPrice: price + 0.05,
    stopPrice: null,
    meta: { multiplier: 1, direction: 'CALL', softStop: { price: price - 1 } },
    actor: 'test',
    signalBarCloseAt: x.clock.now() - 1000,
    referencePrice: price + 0.02,
  };
}
