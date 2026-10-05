import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderView, ReadinessView, Snapshot, SystemView } from '@scalp-city/shared';
import { AuditLog } from '../src/audit/AuditLog.js';
import { ManualClock } from '../src/core/clock.js';
import { EventBus } from '../src/core/eventBus.js';
import { createTestLogger } from '../src/core/logger.js';
import { migrate } from '../src/db/migrations.js';
import { LiveGate, LiveGateError, type ReadinessInputs } from '../src/safety/LiveGate.js';
import { Alerts, Timeline } from '../src/system/Timeline.js';
import { startE2E, type E2E } from './support/e2eHarness.js';
import { createPgliteDb } from './support/pglite.js';

describe('Kill switch and flatten all (spec §29, §30) — through the API against the fake broker', () => {
  let e: E2E;
  const snapshot = async () => (await e.api<Snapshot>('GET', '/api/snapshot')).body;

  beforeAll(async () => {
    e = await startE2E();
    await e.waitFor(async () => (await snapshot()).system.phase === 'READY', 'ready');
  }, 60_000);
  afterAll(async () => e?.close());

  it('kill switch cancels working orders, stops workers, blocks new orders — and leaves positions open', async () => {
    // A manual position the user holds, plus a resting order.
    e.fake.fillMode = 'immediate';
    let prev = (await e.api<{ previewToken: string }>('POST', '/api/orders/preview', { symbol: 'SPY', assetClass: 'us_equity', side: 'buy', qty: 2, type: 'market', intent: 'open' })).body;
    let r = await e.api<OrderView>('POST', '/api/orders', { previewToken: prev.previewToken, confirmed: true });
    expect(r.status).toBe(200);
    await e.waitFor(() => e.fake.positions.get('SPY')?.qty === 2, 'SPY filled');

    e.fake.fillMode = 'manual';
    prev = (await e.api<{ previewToken: string }>('POST', '/api/orders/preview', { symbol: 'IWM', assetClass: 'us_equity', side: 'buy', qty: 1, type: 'limit', limitPrice: 219.5, intent: 'open' })).body;
    r = await e.api<OrderView>('POST', '/api/orders', { previewToken: prev.previewToken, confirmed: true });
    expect(r.body.state).toBe('ACCEPTED');
    const resting = r.body.id;

    await e.api('POST', '/api/controls/autotrading', { enabled: true });
    await e.api('POST', '/api/workers/spy/enabled', { enabled: true, confirmed: true });

    const k = await e.api<{ system: SystemView; canceled: number }>('POST', '/api/controls/kill-switch', { reason: 'test' });
    expect(k.status).toBe(200);
    expect(k.body.system.controls.killSwitch.active).toBe(true);
    expect(k.body.system.controls.autotrading).toBe(false);
    expect(k.body.canceled).toBe(1);
    await e.waitFor(async () => (await snapshot()).orders.find((o) => o.id === resting)?.state === 'CANCELED', 'resting order canceled by broker');
    const s = await snapshot();
    expect(s.workers.every((w) => !w.autotradeEnabled)).toBe(true);
    // Positions are NOT liquidated by the kill switch.
    expect(e.fake.positions.get('SPY')?.qty).toBe(2);
    expect(s.system.trading.haltReasons.map((h) => h.code)).toContain('KILL_SWITCH');
    // Autotrading cannot be re-enabled while the kill switch is active.
    expect((await e.api('POST', '/api/controls/autotrading', { enabled: true })).status).toBe(409);
    // A new manual entry is blocked by the risk engine.
    prev = (await e.api<{ previewToken: string; risk: { approved: boolean } }>('POST', '/api/orders/preview', { symbol: 'QQQ', assetClass: 'us_equity', side: 'buy', qty: 1, type: 'market', intent: 'open' })).body;
    expect((prev as unknown as { risk: { approved: boolean; blockedBy: { id: string } } }).risk.approved).toBe(false);
    expect((prev as unknown as { risk: { blockedBy: { id: string } } }).risk.blockedBy.id).toBe('kill_switch');
  });

  it('flatten all requires explicit confirmation, closes broker positions and verifies the fills', async () => {
    expect((await e.api('POST', '/api/controls/flatten', {})).status).toBe(400);
    e.fake.fillMode = 'immediate';
    const r = await e.api<{ started: boolean }>('POST', '/api/controls/flatten', { confirmed: true });
    expect(r.body.started).toBe(true);
    const done = await e.waitFor(async () => {
      const s = await snapshot();
      return s.system.flatten && !s.system.flatten.inProgress ? s : null;
    }, 'flatten finished', 30_000);
    expect(done.system.flatten!.total).toBe(1);
    expect(done.system.flatten!.closed).toBe(1);
    expect(done.system.flatten!.messages.at(-1)).toContain('confirmed by broker');
    expect(e.fake.positions.size).toBe(0);
    const flattenOrder = done.orders.find((o) => o.purpose === 'FLATTEN')!;
    expect(flattenOrder.state).toBe('FILLED');
    expect(flattenOrder.risk!.approved).toBe(true); // flatten also went through the risk engine
    expect(done.system.controls.entriesPaused).toBe(true);
  });

  it('releasing the kill switch requires confirmation and leaves autotrading OFF', async () => {
    expect((await e.api('POST', '/api/controls/kill-switch/release', {})).status).toBe(400);
    const r = await e.api<SystemView>('POST', '/api/controls/kill-switch/release', { confirmed: true });
    expect(r.body.controls.killSwitch.active).toBe(false);
    expect(r.body.controls.autotrading).toBe(false);
  });

  it('refuses state-changing requests without a CSRF token', async () => {
    const res = await fetch(`${e.base}/api/controls/kill-switch`, { method: 'POST', headers: { Cookie: e.cookie, 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(403);
    const anon = await fetch(`${e.base}/api/snapshot`);
    expect(anon.status).toBe(401);
  });

  it('refuses a WebSocket from a foreign origin', async () => {
    const { default: WebSocket } = await import('ws');
    const ws = new WebSocket(`${e.base.replace('http', 'ws')}/ws`, { headers: { Cookie: e.cookie, Origin: 'https://evil.example' } });
    const code = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => resolve(101));
    });
    expect(code).toBe(403);
  });

  it('a manual order preview binds the confirmation to that exact order and expires', async () => {
    const bad = await e.api('POST', '/api/orders', { previewToken: 'nonexistent-token-123', confirmed: true });
    expect(bad.status).toBe(410);
    const prev = (await e.api<{ previewToken: string }>('POST', '/api/orders/preview', { symbol: 'QQQ', assetClass: 'us_equity', side: 'buy', qty: 1, type: 'market', intent: 'open' })).body;
    e.clock.advance(61_000);
    const expired = await e.api('POST', '/api/orders', { previewToken: prev.previewToken, confirmed: true });
    expect(expired.status).toBe(410);
  });
});

describe('LIVE activation (spec §3, §124, §125)', () => {
  async function gate(env: 'paper' | 'live', serverLockOpen: boolean) {
    const db = await createPgliteDb();
    await migrate(db);
    const logger = createTestLogger();
    const clock = new ManualClock(Date.UTC(2026, 9, 5, 15));
    const bus = new EventBus(logger);
    const audit = new AuditLog(db, logger, clock);
    const g = new LiveGate(env, serverLockOpen, audit, new Timeline('alpaca', env, db, bus, clock, logger), bus, clock, logger);
    return { g, audit, db };
  }
  const allOk = Object.fromEntries(
    ['brokerConnected', 'account', 'marketDataConnected', 'marketDataFresh', 'optionsData', 'riskLimits', 'killSwitch', 'dailyLoss', 'reconciliation', 'noUnexpectedOrders', 'noUnexpectedPositions', 'workers', 'breakers', 'clock', 'paperRoundTrip'].map((k) => [k, { ok: true, detail: 'ok' }]),
  ) as unknown as ReadinessInputs;
  const params = (readiness: ReadinessView, over: Record<string, unknown> = {}) => ({
    actor: 'tester',
    passwordOk: true,
    confirmAccount: '••••4821',
    expectedAccount: '••••4821',
    acknowledgeRealMoney: true,
    secondConfirmation: true,
    readiness,
    ...over,
  });

  it('refuses to arm in PAPER, with the server lock closed, or with failed re-authentication', async () => {
    const paper = await gate('paper', true);
    await expect(paper.g.arm(params(paper.g.readiness(allOk)))).rejects.toThrow(/PAPER/);
    const locked = await gate('live', false);
    await expect(locked.g.arm(params(locked.g.readiness(allOk)))).rejects.toThrow(/LIVE_TRADING_ENABLED/);
    const live = await gate('live', true);
    await expect(live.g.arm(params(live.g.readiness(allOk), { passwordOk: false }))).rejects.toBeInstanceOf(LiveGateError);
    expect(live.g.armed).toBe(false);
  });

  it('requires both confirmations and the exact connected account', async () => {
    const { g } = await gate('live', true);
    await expect(g.arm(params(g.readiness(allOk), { secondConfirmation: false }))).rejects.toThrow(/confirmations/);
    await expect(g.arm(params(g.readiness(allOk), { confirmAccount: '••••0000' }))).rejects.toThrow(/account/);
  });

  it('refuses while any readiness item fails — including the paper round trip', async () => {
    const { g } = await gate('live', true);
    const r = g.readiness({ ...allOk, paperRoundTrip: { ok: false, detail: 'none yet' } });
    expect(r.ready).toBe(false);
    await expect(g.arm(params(r))).rejects.toThrow(/Paper round trip verified/);
  });

  it('arms when everything holds, audits it, and disarms', async () => {
    const { g, audit } = await gate('live', true);
    await g.arm(params(g.readiness(allOk)));
    expect(g.armed).toBe(true);
    g.disarm('tester', 'done');
    expect(g.armed).toBe(false);
    await audit.flush();
    const actions = (await audit.list()).map((r) => r.action);
    expect(actions).toContain('LIVE_MODE_ENABLED');
    expect(actions).toContain('LIVE_MODE_DISARMED');
  });
});
