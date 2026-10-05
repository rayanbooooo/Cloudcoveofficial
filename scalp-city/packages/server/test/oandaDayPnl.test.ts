import { DateTime } from 'luxon';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OandaBrokerAdapter } from '../src/broker/oanda/OandaBrokerAdapter.js';
import { ManualClock } from '../src/core/clock.js';
import { createTestLogger } from '../src/core/logger.js';
import { FakeOanda } from './fakes/FakeOanda.js';

const NY = 'America/New_York';
const TOKEN = 'test-oanda-token-0123456789abcdef';
const ACCOUNT = '101-004-12345678-001';

let clock: ManualClock;
let fake: FakeOanda;
const adapters: OandaBrokerAdapter[] = [];

const newAdapter = () => {
  const a = new OandaBrokerAdapter({
    env: 'paper',
    apiUrl: fake.url,
    streamUrl: fake.url,
    credentials: { token: TOKEN, accountId: ACCOUNT },
    session: { open: '09:30', close: '16:00' },
    skipUsHolidays: true,
    instruments: ['XAU_USD', 'EUR_JPY'],
    logger: createTestLogger(),
    clock,
  });
  adapters.push(a);
  return a;
};

beforeEach(async () => {
  clock = new ManualClock(DateTime.fromISO('2026-10-05T11:00:30', { zone: NY }).toMillis());
  fake = new FakeOanda({ clock, token: TOKEN, accountId: ACCOUNT, instruments: { XAU_USD: 2650, EUR_JPY: 162 }, sessionDate: '2026-10-05' });
  await fake.start();
});
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.close();
  await fake.stop();
});

describe('OANDA day P&L (rebuilt from broker transactions, since OANDA has no "last equity")', () => {
  it('is zero on a fresh day, and zero rather than unknown', async () => {
    const a = await newAdapter().getAccount();
    expect(a.dayPnl).toBe(0);
    expect(a.lastEquity).toBeNull();
    expect(a.equity).toBe(100_000);
  });

  it('counts today\'s realized P&L from OANDA\'s own fills', async () => {
    const adapter = newAdapter();
    const ask = fake.prices.get('XAU_USD')!.ask;
    await adapter.submitOrder({ clientOrderId: 'c1', symbol: 'XAU_USD', qty: 2, side: 'buy', type: 'market', timeInForce: 'fok', positionIntent: 'buy_to_open' });
    fake.tick('XAU_USD', fake.mid('XAU_USD') + 5);
    await adapter.submitOrder({ clientOrderId: 'c2', symbol: 'XAU_USD', qty: 2, side: 'sell', type: 'market', timeInForce: 'fok', positionIntent: 'sell_to_close' });
    const bid = fake.prices.get('XAU_USD')!.bid;
    const expected = (bid - ask) * 2; // bought at the ask, sold at the (higher) bid
    expect(fake.balance - 100_000).toBeCloseTo(expected, 6);
    const a = await adapter.getAccount();
    expect(a.dayPnl).toBeCloseTo(expected, 6);
    expect(a.dayPnl!).toBeGreaterThan(0);
  });

  it('counts an open position opened today at its live unrealized P&L, gain or loss', async () => {
    const adapter = newAdapter();
    await adapter.submitOrder({ clientOrderId: 'c1', symbol: 'XAU_USD', qty: 3, side: 'buy', type: 'market', timeInForce: 'fok', positionIntent: 'buy_to_open' });
    fake.tick('XAU_USD', fake.mid('XAU_USD') + 4);
    const up = await adapter.getAccount();
    expect(up.dayPnl!).toBeGreaterThan(5);
    fake.tick('XAU_USD', fake.mid('XAU_USD') - 12);
    const down = await adapter.getAccount();
    expect(down.dayPnl!).toBeLessThan(-20);
    expect(down.dayPnl!).toBeCloseTo(down.equity! - 100_000, 6); // nothing realized yet: equals the NAV change
  });

  it('never lets an older position\'s gain offset today\'s losses — but does count its loss', async () => {
    fake.seedTrade('XAU_USD', 2, 2600); // opened yesterday, now far in profit (price ≈ 2650)
    const adapter = newAdapter();
    const a = await adapter.getAccount();
    expect(a.equity!).toBeGreaterThan(100_090); // NAV really is up ~$100…
    expect(a.dayPnl).toBe(0); // …but none of it is today's, so it can't make room under the daily loss limit
    fake.tick('XAU_USD', 2580); // …then the old trade turns into a loss
    const b = await adapter.getAccount();
    expect(b.dayPnl!).toBeLessThan(-39); // (2579.85 − 2600) × 2 ≈ −40.3
    expect(b.dayPnl!).toBeGreaterThan(-41);
  });

  it('excludes deposits and withdrawals, includes overnight financing', async () => {
    const adapter = newAdapter();
    fake.deposit(5_000);
    expect((await adapter.getAccount()).dayPnl).toBe(0);
    fake.financing(-1.25);
    expect((await adapter.getAccount()).dayPnl).toBeCloseTo(-1.25, 10);
    fake.deposit(-500); // a withdrawal
    expect((await adapter.getAccount()).dayPnl).toBeCloseTo(-1.25, 10);
  });

  it('is identical after a restart: it is derived from broker records, so the daily loss limit cannot be reset by bouncing the server', async () => {
    const first = newAdapter();
    await first.submitOrder({ clientOrderId: 'c1', symbol: 'EUR_JPY', qty: 1000, side: 'buy', type: 'market', timeInForce: 'fok', positionIntent: 'buy_to_open' });
    fake.tick('EUR_JPY', fake.mid('EUR_JPY') - 0.6);
    await first.submitOrder({ clientOrderId: 'c2', symbol: 'EUR_JPY', qty: 1000, side: 'sell', type: 'market', timeInForce: 'fok', positionIntent: 'sell_to_close' });
    const before = await first.getAccount();
    expect(before.dayPnl!).toBeLessThan(0);
    const after = await newAdapter().getAccount(); // a brand-new process
    expect(after.dayPnl).toBeCloseTo(before.dayPnl!, 10);
    expect(after.dayPnl!).toBeCloseTo(fake.balance - 100_000, 3); // OANDA reports money to 4 decimals
  });

  it('starts a new day at midnight New York', async () => {
    const adapter = newAdapter();
    await adapter.submitOrder({ clientOrderId: 'c1', symbol: 'XAU_USD', qty: 1, side: 'buy', type: 'market', timeInForce: 'fok', positionIntent: 'buy_to_open' });
    fake.tick('XAU_USD', fake.mid('XAU_USD') - 3);
    await adapter.submitOrder({ clientOrderId: 'c2', symbol: 'XAU_USD', qty: 1, side: 'sell', type: 'market', timeInForce: 'fok', positionIntent: 'sell_to_close' });
    expect((await adapter.getAccount()).dayPnl!).toBeLessThan(-3);
    clock.advance(14 * 3_600_000); // 01:00 the next morning, New York
    const next = await adapter.getAccount();
    expect(next.dayPnl).toBe(0);
  });

  it('reports unknown — never zero — when the transaction history cannot be read', async () => {
    const adapter = newAdapter();
    expect((await adapter.getAccount()).dayPnl).toBe(0);
    // Break only the transaction history endpoints.
    const real = fake.transactions;
    Object.defineProperty(fake, 'transactions', { get: () => { throw new Error('history unavailable'); }, configurable: true });
    clock.advance(14 * 3_600_000); // a new day forces a rebuild
    const a = await adapter.getAccount();
    expect(a.dayPnl).toBeNull();
    expect(a.dayPnlNote).toContain('unavailable');
    Object.defineProperty(fake, 'transactions', { value: real, writable: true, configurable: true });
  });
});
