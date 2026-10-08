import { afterEach, describe, expect, it } from 'vitest';
import type { RiskLimits, RiskPresetPreview } from '@scalp-city/shared';
import { startE2E, type E2E } from './support/e2eHarness.js';
import { LOOSE, PRICES, flatHistory, minute, ready, snapshot } from './support/scalpFlow.js';

/**
 * The Aggressive preset, end to end on the paper fake: previewed, confirmed, applied to the account and to every
 * share worker, audited, and then the workers really do trade bigger. Before it, each trade risks $5 and a position is
 * about $5,000, which is why a $100,000 account moved by dollars.
 */

let e: E2E | undefined;
afterEach(async () => {
  await e?.close();
  e = undefined;
});

async function start(env: Record<string, string> = {}): Promise<E2E> {
  e = await startE2E({ env: { ALPACA_WORKER_SET: 'scalp', ...LOOSE, ...env }, fake: { symbols: PRICES, historyPath: flatHistory } });
  await e.waitFor(async () => ((await snapshot(e!)).system.phase === 'READY' ? true : null), 'system READY');
  return e;
}

const limits = async (x: E2E) => (await x.api<{ limits: RiskLimits }>('GET', '/api/risk/limits')).body.limits;

describe('"Max loss per trade" actually saves', () => {
  it('is accepted by the risk-limits API (it used to be dropped silently)', async () => {
    const x = await start();
    expect((await limits(x)).maxRiskPerTrade).toBe(25);
    const put = await x.api<{ limits: RiskLimits }>('PUT', '/api/risk/limits', { limits: { maxRiskPerTrade: 100 }, confirmed: true });
    expect(put.status).toBe(200);
    expect(put.body.limits.maxRiskPerTrade).toBe(100);
    expect((await limits(x)).maxRiskPerTrade).toBe(100);
  }, 60_000);
});

describe('the Aggressive preset', () => {
  it('is previewed before anything changes, needs a confirmation, and then sets the account and every share worker', async () => {
    const x = await start();
    const before = await limits(x);
    expect(before.maxPositionNotional).toBe(5_000);

    const p = await x.api<RiskPresetPreview>('POST', '/api/risk/preset/preview', { preset: 'aggressive' });
    expect(p.status).toBe(200);
    expect(p.body.equity).toBe(100_000);
    expect(p.body).toMatchObject({ positionPct: 30, dailyLossPct: 5 });
    expect(p.body.account.increasesRisk).toBe(true);
    expect(p.body.account.changes.find((c) => c.key === 'maxPositionNotional')).toMatchObject({ from: 5_000, to: 30_000, increasesRisk: true });
    expect(p.body.account.changes.find((c) => c.key === 'maxDailyLoss')).toMatchObject({ to: 5_000 });
    expect(p.body.workers).toHaveLength(5);
    for (const w of p.body.workers) {
      expect(w.changes.find((c) => c.key === 'riskPerTrade')).toMatchObject({ from: 5, to: 250 });
      expect(w.changes.find((c) => c.key === 'maxPositionNotional')).toMatchObject({ from: 5_000, to: 30_000 });
    }
    expect(p.body.notes.join(' ')).toMatch(/BOTH directions/);
    expect(await limits(x)).toEqual(before); // a preview changes nothing

    // Applying needs the person's confirmation.
    expect((await x.api('POST', '/api/risk/preset', { preset: 'aggressive' })).status).toBe(428);
    expect(await limits(x)).toEqual(before);

    const applied = await x.api<{ limits: RiskLimits; workers: number }>('POST', '/api/risk/preset', { preset: 'aggressive', confirmed: true });
    expect(applied.status).toBe(200);
    expect(applied.body.workers).toBe(5);
    expect(await limits(x)).toMatchObject({
      maxDailyLoss: 5_000,
      maxPositionNotional: 30_000,
      maxOrderNotional: 30_000,
      maxShares: 2_000,
      maxRiskPerTrade: 500,
      maxConcurrentPositions: 5,
      maxTradesPerDay: 1_000,
      maxOrdersPerMinute: 120,
      // what it does not touch
      maxPriceDeviationPct: before.maxPriceDeviationPct,
      noEntriesBeforeCloseMinutes: before.noEntriesBeforeCloseMinutes,
      pdtGuard: before.pdtGuard,
    });
    const s = await snapshot(x);
    expect(s.workers).toHaveLength(5);
    for (const w of s.workers) {
      expect(w.config.limits).toMatchObject({ riskPerTrade: 250, maxPositionNotional: 30_000, maxShares: 2_000, maxTradesPerDay: 1_000, dailyLossLimit: 1_500 });
    }
    expect(s.timeline.some((t) => t.title === 'Aggressive preset applied')).toBe(true);

    // Audited, with the account size it was scaled from.
    await x.app.audit.flush();
    const { rows } = await x.db.query<{ details: unknown }>(`SELECT details FROM audit_logs WHERE action = 'RISK_LIMITS_CHANGED' ORDER BY id DESC LIMIT 1`);
    const details = (typeof rows[0]!.details === 'string' ? JSON.parse(rows[0]!.details) : rows[0]!.details) as { preset?: string; equity?: number };
    expect(details).toMatchObject({ preset: 'aggressive', equity: 100_000 });
  }, 60_000);

  it('takes the two knobs, and refuses nonsense for either', async () => {
    const x = await start();
    for (const bad of [{ positionPct: 0 }, { positionPct: 101 }, { dailyLossPct: 0.1 }, { dailyLossPct: 26 }, { positionPct: 'lots' }]) {
      expect((await x.api('POST', '/api/risk/preset/preview', { preset: 'aggressive', ...bad })).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await x.api('POST', '/api/risk/preset/preview', { preset: 'reckless' })).status).toBe(400);
    const r = await x.api('POST', '/api/risk/preset', { preset: 'aggressive', positionPct: 50, dailyLossPct: 2, confirmed: true });
    expect(r.status).toBe(200);
    expect(await limits(x)).toMatchObject({ maxPositionNotional: 50_000, maxOrderNotional: 50_000, maxDailyLoss: 2_000 });
  }, 60_000);

  it('makes the scalpers trade bigger: about $5,000 a position before, about $30,000 after, every trade still through the risk engine', async () => {
    const x = await start();
    await ready(x);
    // Oldest first: the snapshot lists orders newest first.
    const entries = async () =>
      (await snapshot(x)).orders
        .filter((o) => o.workerId === 'scalp-gold' && o.purpose === 'ENTRY' && o.state === 'FILLED')
        .sort((a, b) => a.createdAt - b.createdAt);
    const flat = async () => !(await snapshot(x)).positions.some((p) => p.symbol === 'GLD');

    // Before: the shipped limits.
    let price = 300;
    const step = async () => {
      const next = price + 0.32;
      await minute(x, price, next);
      price = next;
    };
    for (let i = 0; i < 12 && ((await entries()).length < 1 || !(await flat())); i++) await step();
    const small = await entries();
    expect(small.length).toBeGreaterThanOrEqual(1);
    expect(small[0]!.qty).toBeLessThanOrEqual(16); // $5,000 ÷ $300
    expect(small[0]!.qty * small[0]!.limitPrice!).toBeLessThanOrEqual(5_000);

    // After the preset.
    expect((await x.api('POST', '/api/risk/preset', { preset: 'aggressive', confirmed: true })).status).toBe(200);
    const had = small.length;
    for (let i = 0; i < 14 && (await entries()).length <= had; i++) await step();
    const after = (await entries()).slice(had);
    expect(after.length).toBeGreaterThanOrEqual(1);
    const o = after[0]!;
    expect(o.qty).toBeGreaterThanOrEqual(90);
    expect(o.qty).toBeLessThanOrEqual(100);
    expect(o.qty * o.limitPrice!).toBeGreaterThan(25_000);
    expect(o.qty * o.limitPrice!).toBeLessThanOrEqual(30_000);
    expect(o.qty).toBeGreaterThan(small[0]!.qty * 5); // several times the size
    // It still went through every check, including the loss at its stop.
    expect(o.risk!.approved).toBe(true);
    expect(o.risk!.checks.find((c) => c.id === 'risk_per_trade')).toMatchObject({ passed: true });
    expect(o.risk!.checks.find((c) => c.id === 'order_notional')).toMatchObject({ passed: true });
  }, 240_000);
});
