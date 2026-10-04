import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountService } from '../src/account/AccountService.js';
import { SettingsStore } from '../src/settings/SettingsStore.js';
import { CircuitBreakers } from '../src/safety/CircuitBreakers.js';
import { Reconciler } from '../src/safety/Reconciler.js';
import { Alerts, Timeline } from '../src/system/Timeline.js';
import { createEngineHarness, entryRequest, type EngineHarness } from './support/harness.js';
import { CONTRACT, brokerPosition } from './support/riskFixtures.js';
import { createTestLogger } from '../src/core/logger.js';

let h: EngineHarness;
let account: AccountService;
let breakers: CircuitBreakers;
let rec: Reconciler;

beforeEach(async () => {
  h = await createEngineHarness();
  const logger = createTestLogger();
  account = new AccountService(h.broker, h.db, h.bus, h.clock, logger, { env: 'paper' });
  const timeline = new Timeline('paper', h.db, h.bus, h.clock, logger);
  const alerts = new Alerts(h.bus, h.clock);
  breakers = new CircuitBreakers('paper', new SettingsStore(h.db), h.bus, h.audit, alerts, timeline, h.clock, logger);
  await breakers.load();
  rec = new Reconciler('paper', account, h.ledger, h.engine, breakers, h.audit, timeline, alerts, h.bus, h.clock, logger, () => ['QQQ', 'SPY', 'IWM']);
});
afterEach(async () => {
  await h.audit.flush();
  await h.db.close();
});

describe('Reconciliation (spec §35)', () => {
  it('reports RECONCILED when local and broker positions match', async () => {
    const o = await h.engine.submit(entryRequest());
    await h.engine.onTradeUpdate(h.broker.fill(o.clientOrderId, 2, 3.68));
    const v = await rec.run();
    expect(v.status).toBe('RECONCILED');
    expect(v.mismatches).toEqual([]);
    expect(breakers.tripped()).toEqual([]);
  });

  it('halts trading when the broker quantity differs from the local record, but only after it persists', async () => {
    const o = await h.engine.submit(entryRequest());
    await h.engine.onTradeUpdate(h.broker.fill(o.clientOrderId, 2, 3.68));
    // Something outside Scalp City changed the position.
    h.broker.positions[0]!.qty = 1;
    const first = await rec.run();
    expect(first.status).toBe('PENDING'); // could be a fill in flight — not yet
    h.clock.advance(15_000);
    const second = await rec.run();
    expect(second.status).toBe('MISMATCH');
    expect(second.mismatches[0]).toMatchObject({ symbol: CONTRACT, local: 2, broker: 1, kind: 'QTY_MISMATCH' });
    expect(breakers.isTripped('ACCOUNT_MISMATCH')).toBe(true);
  });

  it('flags an unexpected position in a traded underlying and an unrelated holding is adopted quietly', async () => {
    h.broker.positions.push(brokerPosition({ symbol: 'QQQ', qty: 5 }), brokerPosition({ symbol: 'AAPL', qty: 10 }));
    const v = await rec.run({ immediate: true });
    expect(v.status).toBe('MISMATCH');
    expect(v.mismatches.map((m) => m.symbol)).toEqual(['QQQ']);
    expect(v.mismatches[0]!.kind).toBe('UNEXPECTED_POSITION');
    expect(v.externalPositions).toContain('AAPL');
    expect(breakers.isTripped('UNEXPECTED_POSITION')).toBe(true);
  });

  it('accepting broker state adopts the position, resets the breaker and reconciles', async () => {
    h.broker.positions.push(brokerPosition({ symbol: 'QQQ', qty: 5 }));
    await rec.run({ immediate: true });
    const v = await rec.acceptBrokerState('tester');
    expect(v.status).toBe('RECONCILED');
    expect(h.ledger.get('QQQ')!.external).toBe(true);
    expect(breakers.isTripped('UNEXPECTED_POSITION')).toBe(false);
    await h.audit.flush();
    expect((await h.audit.list()).map((r) => r.action)).toContain('RECONCILIATION_ACCEPTED');
  });

  it('skips symbols with fills in flight', async () => {
    const o = await h.engine.submit(entryRequest()); // accepted, not filled
    h.broker.positions.push(brokerPosition({ symbol: CONTRACT, assetClass: 'us_option', qty: 2 }));
    const v = await rec.run({ immediate: true });
    expect(v.status).toBe('RECONCILED');
    expect(o.state).toBe('ACCEPTED');
  });
});
