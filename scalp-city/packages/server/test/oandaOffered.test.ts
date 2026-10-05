import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Snapshot } from '@scalp-city/shared';
import { OandaBrokerAdapter } from '../src/broker/oanda/OandaBrokerAdapter.js';
import { systemClock } from '../src/core/clock.js';
import { createTestLogger } from '../src/core/logger.js';
import { FakeOanda } from './fakes/FakeOanda.js';
import { OANDA_ACCOUNT, OANDA_TOKEN, startOandaE2E, type OandaE2E } from './support/oandaHarness.js';

/**
 * Some OANDA entities do not offer index CFDs or metals. OANDA refuses a whole
 * pricing request or stream that names one market the account is not offered,
 * so a configured-but-unoffered market must never take the offered ones down:
 * not their prices, not the clock check, not the currency conversions.
 */

// An account that offers gold and two FX pairs, but neither index CFD.
const OFFERED = { XAU_USD: 2650, GBP_USD: 1.3, EUR_JPY: 162 };

describe('configured markets the account is not offered (app level)', () => {
  let e: OandaE2E;
  beforeAll(async () => {
    e = await startOandaE2E({ fake: { instruments: OFFERED } });
  }, 60_000);
  afterAll(async () => {
    await e?.close();
  });
  const snapshot = async () => (await e.api<Snapshot>('GET', '/api/snapshot')).body;

  it('still reaches READY with a connected price stream and a verified clock', async () => {
    const s = await e.waitFor(async () => {
      const snap = await snapshot();
      return snap.system.phase === 'READY' ? snap : null;
    }, 'system READY');
    expect(s.system.marketData.stock.state).toBe('CONNECTED');
    expect(s.system.clock.ok).toBe(true);
    expect(s.system.health.some((h) => h.status === 'error')).toBe(false);
    expect(s.system.trading.haltReasons.some((r) => r.code === 'DATA_STALE')).toBe(false);
  });

  it('prices and sizes the offered markets, including the currency conversion for EUR/JPY', async () => {
    const s = await snapshot();
    expect(Object.keys(s.quotes).sort()).toEqual(['EUR_JPY', 'GBP_USD', 'XAU_USD']);
    for (const q of Object.values(s.quotes)) {
      expect(q.last).not.toBeNull();
      expect(q.stale).toBe(false);
    }
    const jpy = s.workers.find((w) => w.config.symbol === 'EUR_JPY')!;
    expect(jpy.market?.listed).toBe(true);
    expect(jpy.market?.homeFactor).not.toBeNull(); // JPY → USD, from OANDA's own conversion factors
    expect(s.workers.find((w) => w.config.symbol === 'XAU_USD')!.market?.plannedUnits).toBeGreaterThanOrEqual(1);
  });

  it('says which markets are not offered, and their workers never trade', async () => {
    const s = await snapshot();
    for (const sym of ['NAS100_USD', 'US30_USD']) {
      const w = s.workers.find((x) => x.config.symbol === sym)!;
      expect(w.market?.listed).toBe(false);
      expect(w.market?.plannedUnits).toBeNull();
      expect(w.market?.sizingNote).toContain('not offered');
    }
    const note = s.timeline.find((t) => t.title.startsWith('Not offered to this OANDA account'));
    expect(note?.severity).toBe('warn');
    expect(note?.title).toContain('NAS100');
    expect(note?.title).toContain('US30');
  });
});

describe('the broker adapter when it cannot read the account market list', () => {
  let fake: FakeOanda;
  beforeAll(async () => {
    fake = new FakeOanda({ clock: systemClock, token: OANDA_TOKEN, accountId: OANDA_ACCOUNT, instruments: OFFERED, sessionDate: new Date().toISOString().slice(0, 10), sessionOpen: '00:00' });
    await fake.start();
  });
  afterAll(async () => {
    await fake.stop();
  });

  it('prices the markets OANDA accepts one by one when it refuses the request that names an unoffered one', async () => {
    fake.failInstrumentList = true;
    const adapter = new OandaBrokerAdapter({
      env: 'paper',
      apiUrl: fake.url,
      streamUrl: fake.url,
      credentials: { token: OANDA_TOKEN, accountId: OANDA_ACCOUNT },
      session: { open: '09:30', close: '16:00' },
      skipUsHolidays: true,
      instruments: ['XAU_USD', 'US30_USD', 'EUR_JPY'], // US30 is not offered, and the list that would say so is down
      logger: createTestLogger(),
    });
    await adapter.getAccount(); // learns the account currency
    const clock = await adapter.getClock(); // pricing: the whole request is refused, so it falls back market by market
    expect(clock.timestamp).toBeGreaterThan(0);
    expect(adapter.homeFactor('EUR_JPY')).not.toBeNull(); // the JPY conversion survived
    expect(adapter.homeFactor('XAU_USD')).toBe(1); // USD-quoted on a USD account
  });

  it('still gets the server time when no configured market can be priced at all', async () => {
    fake.failInstrumentList = true;
    const adapter = new OandaBrokerAdapter({
      env: 'paper',
      apiUrl: fake.url,
      streamUrl: fake.url,
      credentials: { token: OANDA_TOKEN, accountId: OANDA_ACCOUNT },
      session: { open: '09:30', close: '16:00' },
      skipUsHolidays: true,
      instruments: ['NAS100_USD', 'US30_USD'], // neither is offered
      logger: createTestLogger(),
    });
    const clock = await adapter.getClock(); // falls back to the account summary's Date header
    expect(Math.abs(clock.timestamp - Date.now())).toBeLessThan(5000);
  });
});
