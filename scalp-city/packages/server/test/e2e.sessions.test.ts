import { afterEach, describe, expect, it } from 'vitest';
import type { JournalTradeView } from '@scalp-city/shared';
import type { OrderRequest } from '../src/orders/types.js';
import type { FakeAlpacaOptions } from './fakes/FakeAlpaca.js';
import { startE2E, type E2E } from './support/e2eHarness.js';
import { LOOSE, PRICES, flatHistory, minute, ready, sleep, snapshot, worker } from './support/scalpFlow.js';

/**
 * ALPACA_SESSIONS: the fast scalpers outside the regular session, end to end against the Alpaca fake with its
 * session rules switched on (`sessions: true`): only limit orders flagged extended-hours trade before 09:30, after
 * 16:00 and overnight, and each data feed carries only the hours its plan covers.
 *
 * Monday 5 October 2026 is the session date; the fake's calendar has every weekday as a trading day.
 */

let e: E2E | undefined;
afterEach(async () => {
  await e?.close();
  e = undefined;
});

interface StartOpts {
  env?: Record<string, string>;
  fake?: Partial<FakeAlpacaOptions>;
  startTime: string;
  startDate?: string;
}

async function start(o: StartOpts): Promise<E2E> {
  e = await startE2E({
    env: { ALPACA_WORKER_SET: 'scalp', ...LOOSE, ...o.env },
    fake: { symbols: PRICES, historyPath: flatHistory, sessions: true, ...o.fake },
    startTime: o.startTime,
    startDate: o.startDate,
  });
  return e;
}

/** Rising market, one minute at a time, until the gold worker is in a position (or the minutes run out). */
async function climbUntilHolding(x: E2E, minutes: number): Promise<boolean> {
  let price = 300;
  for (let i = 0; i < minutes; i++) {
    const next = price + 0.32;
    await minute(x, price, next);
    price = next;
    if ((await worker(x, 'scalp-gold')).position) return true;
  }
  return false;
}

describe('trading outside the regular session', () => {
  it('trades the pre-market on the paid data plan: limit orders flagged extended-hours, in and out', async () => {
    const x = await start({ env: { ALPACA_SESSIONS: 'extended', ALPACA_STOCK_FEED: 'sip' }, fake: { dataPlan: 'plus', historyFrom: '2026-10-05T04:00' }, startTime: '06:30:30' });
    await ready(x);
    const before = await snapshot(x);
    expect(before.system.market).toMatchObject({ label: 'PRE_MARKET', isOpen: true, sessions: 'extended' });
    expect(before.system.marketData.stockFeed).toBe('sip');
    expect(before.system.trading.haltReasons.map((r) => r.code)).not.toContain('MARKET_CLOSED');

    let price = 300;
    for (let i = 0; i < 9; i++) {
      const next = price + 0.32;
      await minute(x, price, next);
      price = next;
    }

    const brokerOrders = [...x.fake.orders.values()];
    expect(brokerOrders.length).toBeGreaterThanOrEqual(2);
    for (const o of brokerOrders) {
      // Everything that reached Alpaca at this hour is a day/GTC limit order carrying the extended-hours flag.
      expect(o.type).toBe('limit');
      expect(o.extended_hours).toBe(true);
      expect(['day', 'gtc']).toContain(o.time_in_force);
    }
    const s = await snapshot(x);
    expect(s.orders.filter((o) => o.state === 'FILLED' && o.purpose === 'ENTRY').length).toBeGreaterThanOrEqual(1);
    expect(s.orders.filter((o) => o.rejectedBy === 'BROKER')).toEqual([]);
    expect(s.system.breakers.filter((b) => b.tripped)).toEqual([]);
    const closed = ((await x.api<JournalTradeView[]>('GET', '/api/journal')).body ?? []).filter((t) => t.status === 'CLOSED');
    expect(closed.length).toBeGreaterThanOrEqual(1);
    expect(closed.every((t) => ['TAKE_PROFIT', 'TIME_STOP', 'STOP_LOSS', 'VWAP_LOST', 'END_OF_DAY'].includes(t.exitReason ?? ''))).toBe(true);
  }, 150_000);

  it('trades through the night on the paid plan’s BOATS feed, and a flatten there is a marketable limit', async () => {
    const x = await start({ env: { ALPACA_SESSIONS: 'all', ALPACA_STOCK_FEED: 'sip' }, fake: { dataPlan: 'plus', historyFrom: '2026-10-05T04:00' }, startTime: '22:30:30' });
    await ready(x);
    const before = await snapshot(x);
    expect(before.system.market).toMatchObject({ label: 'OVERNIGHT', isOpen: true, sessions: 'all' });
    expect(before.system.marketData.stockFeed).toBe('boats');
    expect(before.system.marketData.stock.state).toBe('CONNECTED');

    expect(await climbUntilHolding(x, 12)).toBe(true);
    const held = (await worker(x, 'scalp-gold')).position!;
    expect(held.qty).toBeGreaterThan(0);

    expect((await x.api('POST', '/api/controls/flatten', { confirmed: true })).status).toBe(200);
    await x.waitFor(() => (x.fake.positions.size === 0 ? true : null), 'flatten closed the position at the broker', 30_000);

    const s = await snapshot(x);
    const flatten = s.orders.find((o) => o.purpose === 'FLATTEN')!;
    expect(flatten).toBeDefined();
    // A market order asked for; a limit through the touch sent — and it filled.
    expect(flatten.type).toBe('limit');
    expect(flatten.state).toBe('FILLED');
    const sent = [...x.fake.orders.values()].find((o) => o.client_order_id === flatten.clientOrderId)!;
    expect(sent.extended_hours).toBe(true);
    expect(sent.type).toBe('limit');
    expect(sent.limit_price).toBeLessThan(x.fake.prices.get('GLD')!.bid); // sell: under the bid
    expect(sent.limit_price).toBeGreaterThan(x.fake.prices.get('GLD')!.bid * 0.99); // but within the buffer
    for (const o of x.fake.orders.values()) {
      expect(o.type).toBe('limit');
      expect(o.extended_hours).toBe(true);
    }
    expect(s.orders.filter((o) => o.rejectedBy === 'BROKER')).toEqual([]);
  }, 150_000);

  it('trades the small hours of a Sunday night session before a trading Monday', async () => {
    const x = await start({ env: { ALPACA_SESSIONS: 'all', ALPACA_STOCK_FEED: 'sip' }, fake: { dataPlan: 'plus', historyFrom: '2026-10-04T20:00' }, startTime: '01:30:30' });
    await ready(x);
    const before = await snapshot(x);
    expect(before.system.market).toMatchObject({ label: 'OVERNIGHT', isOpen: true });
    expect(before.system.trading.haltReasons.map((r) => r.code)).not.toContain('MARKET_CLOSED');
    expect(await climbUntilHolding(x, 12)).toBe(true);
    for (const o of x.fake.orders.values()) {
      expect(o.type).toBe('limit');
      expect(o.extended_hours).toBe(true);
    }
  }, 150_000);
});

describe('thin markets', () => {
  it('does not enter on bars with a hole in them: a minute without a trade makes the next three bars wait', async () => {
    const x = await start({ env: { ALPACA_SESSIONS: 'all', ALPACA_STOCK_FEED: 'sip' }, fake: { dataPlan: 'plus', historyFrom: '2026-10-05T04:00' }, startTime: '22:30:30' });
    await ready(x);
    let price = 300;
    const step = async () => {
      const next = price + 0.32;
      await minute(x, price, next);
      price = next;
    };
    // Trade until one round trip is done and the worker is flat again.
    for (let i = 0; i < 14; i++) {
      await step();
      const closed = ((await x.api<JournalTradeView[]>('GET', '/api/journal')).body ?? []).filter((t) => t.status === 'CLOSED');
      if (closed.length >= 1 && !(await worker(x, 'scalp-gold')).position) break;
    }
    expect((await snapshot(x)).orders.filter((o) => o.purpose === 'ENTRY').length).toBeGreaterThanOrEqual(1);

    // A minute with no trade at all: no bar for it.
    const gapAt = Math.floor(x.clock.now() / 60_000) * 60_000;
    await x.advance(60_000);
    for (let i = 0; i < 3; i++) await step(); // the three bars after the hole
    const waiting = await snapshot(x);
    expect(waiting.orders.filter((o) => o.purpose === 'ENTRY' && o.createdAt > gapAt)).toEqual([]);
    expect(waiting.timeline.some((t) => (t.detail ?? '').includes('thin market'))).toBe(true); // the risk check says so

    // Four unbroken bars again: entries resume.
    for (let i = 0; i < 4; i++) await step();
    expect((await snapshot(x)).orders.filter((o) => o.purpose === 'ENTRY' && o.createdAt > gapAt).length).toBeGreaterThanOrEqual(1);
  }, 240_000);
});

describe('the free plan’s data gaps', () => {
  it('blocks trading in the hours IEX does not cover, says why, and goes live when IEX opens', async () => {
    // 06:30: pre-market, but IEX only carries 08:00–17:00. Nothing arrives, so nothing may trade.
    const x = await start({ env: { ALPACA_SESSIONS: 'extended' }, fake: { dataPlan: 'basic', historyFrom: '2026-10-05T04:00' }, startTime: '06:30:30' });
    await ready(x);
    await x.advance(3 * 60_000); // three quiet minutes: IEX has nothing to say before 08:00
    const quiet = await snapshot(x);
    expect(quiet.system.market).toMatchObject({ label: 'PRE_MARKET', isOpen: true });
    expect(quiet.system.marketData.symbols.GLD!.stale).toBe(true);
    expect(quiet.system.trading.haltReasons.map((r) => r.code)).toContain('DATA_STALE');
    expect(x.fake.orders.size).toBe(0);

    // The reason is given in plain words.
    const md = x.app.ctx.marketData.freshness('GLD');
    expect(md.stale).toBe(true);
    expect(md.reason).toMatch(/IEX/);
    expect(md.reason).toMatch(/08:00–17:00/);

    // 08:00:30: IEX is on. Quotes arrive, and data is fresh again.
    await x.advance(87 * 60_000);
    await x.waitFor(async () => ((await snapshot(x)).system.marketData.symbols.GLD!.stale === false ? true : null), 'data fresh once IEX opens');
    expect((await snapshot(x)).system.trading.haltReasons.map((r) => r.code)).not.toContain('DATA_STALE');
  }, 150_000);

  it('stops entering ten minutes before IEX goes quiet at 17:00, and is flat before it does', async () => {
    const x = await start({ env: { ALPACA_SESSIONS: 'extended' }, fake: { dataPlan: 'basic', historyFrom: '2026-10-05T08:00' }, startTime: '16:44:30' });
    await ready(x);
    let price = 300;
    for (let i = 0; i < 14; i++) {
      // 16:45 … 16:58, a rising market throughout
      const next = price + 0.32;
      await minute(x, price, next);
      price = next;
    }
    const s = await snapshot(x);
    const cutoff = new Date('2026-10-05T16:50:00-04:00').getTime();
    const entries = s.orders.filter((o) => o.purpose === 'ENTRY');
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.filter((o) => o.createdAt >= cutoff)).toEqual([]); // none in the last ten minutes of data
    expect(s.timeline.some((t) => (t.detail ?? '').includes('free IEX feed goes quiet'))).toBe(true);
    // Nothing is left open to be stranded overnight when the feed goes quiet.
    expect((await worker(x, 'scalp-gold')).position).toBeNull();
    expect(x.fake.positions.size).toBe(0);
    expect(s.orders.filter((o) => o.rejectedBy === 'BROKER')).toEqual([]);
  }, 150_000);

  it('leaves a quiet connection alone while IEX has nothing to say, but still rebuilds a silent one in the regular session', async () => {
    const quiet = await start({ env: { ALPACA_SESSIONS: 'extended' }, fake: { dataPlan: 'basic', historyFrom: '2026-10-05T04:00' }, startTime: '04:30:30' });
    await quiet.waitFor(async () => ((await snapshot(quiet)).system.marketData.stock.state === 'CONNECTED' ? true : null), 'connected');
    const since = (await snapshot(quiet)).system.marketData.stock.since;
    quiet.clock.advance(40 * 60_000); // 05:10: forty minutes of the silence that IEX is expected to keep
    await sleep(2500); // the data service’s own watchdog runs every second
    const after = (await snapshot(quiet)).system.marketData.stock;
    expect(after.state).toBe('CONNECTED');
    expect(after.since).toBe(since); // not rebuilt
    await quiet.close();

    // The same silence at 11:00 is a failure, and the connection is rebuilt.
    const day = await start({ env: { ALPACA_SESSIONS: 'extended' }, fake: { dataPlan: 'basic', historyFrom: '2026-10-05T04:00' }, startTime: '11:00:30' });
    await day.waitFor(async () => ((await snapshot(day)).system.marketData.stock.state === 'CONNECTED' ? true : null), 'connected');
    day.fake.trade('GLD', 300, 100);
    const daySince = (await snapshot(day)).system.marketData.stock.since;
    day.clock.advance(3 * 60_000);
    await day.waitFor(async () => ((await snapshot(day)).system.marketData.stock.since !== daySince ? true : null), 'silent connection rebuilt', 15_000);
  }, 90_000);

  it('does not trade overnight on the free plan: its overnight feed reports trades 15 minutes late', async () => {
    const x = await start({ env: { ALPACA_SESSIONS: 'all' }, fake: { dataPlan: 'basic', historyFrom: '2026-10-05T04:00' }, startTime: '22:30:30' });
    await ready(x);
    const before = await snapshot(x);
    expect(before.system.market.label).toBe('OVERNIGHT');
    expect(before.system.marketData.stockFeed).toBe('overnight');
    expect(before.system.marketData.stockFeedLabel).toBe('OVERNIGHT FEED · TRADES 15 MIN LATE');

    // A rising market, minute by minute. The bars reach the app a quarter of an hour late.
    let price = 300;
    for (let i = 0; i < 5; i++) {
      const next = price + 0.32;
      for (let k = 1; k <= 5; k++) x.fake.trade('GLD', price + ((next - price) * k) / 5, 4_000);
      await x.advance(60_000);
      x.fake.closeBar('GLD');
      price = next;
    }
    await sleep(1500);
    expect(x.fake.orders.size).toBe(0);

    // The risk engine says why, in the same list of checks as every other order.
    const entry: OrderRequest & { signalBarCloseAt: number; referencePrice: number } = {
      workerId: 'scalp-gold',
      source: 'WORKER',
      purpose: 'ENTRY',
      signalId: 'preview:free-overnight',
      symbol: 'GLD',
      underlying: 'GLD',
      assetClass: 'us_equity',
      side: 'buy',
      positionIntent: null,
      type: 'limit',
      timeInForce: 'day',
      qty: 1,
      limitPrice: 300.1,
      stopPrice: null,
      meta: { multiplier: 1, direction: 'CALL', softStop: { price: 299 } },
      actor: 'test',
      signalBarCloseAt: x.clock.now() - 1000,
      referencePrice: 300.05,
    };
    const decision = await x.app.ctx.orders.previewRisk(entry);
    expect(decision.approved).toBe(false);
    const bars = decision.checks.find((c) => c.id === 'bars_live')!;
    expect(bars.passed).toBe(false);
    expect(bars.detail).toMatch(/15 minutes late/);
  }, 150_000);

  it('says so when the plan has no overnight feed at all, rather than waiting for data that will never come', async () => {
    // The paid SIP plan names its overnight feed `boats`; ask a free-plan account for it and Alpaca refuses the stream.
    const x = await start({ env: { ALPACA_SESSIONS: 'all', ALPACA_OVERNIGHT_FEED: 'boats' }, fake: { dataPlan: 'basic', historyFrom: '2026-10-05T04:00' }, startTime: '22:30:30' });
    await x.waitFor(async () => ((await snapshot(x)).system.marketData.stock.lastError ? true : null), 'overnight stream refused');
    const s = await snapshot(x);
    expect(s.system.marketData.stock.state).toBe('ERROR');
    expect(s.system.marketData.stock.lastError).toMatch(/does not include the boats overnight feed/);
    expect(s.system.trading.entriesAllowed).toBe(false);
  }, 60_000);
});

describe('the closed week', () => {
  it('stays out of the market from Friday evening to Sunday evening, and says the market is closed', async () => {
    const x = await start({ env: { ALPACA_SESSIONS: 'all' }, fake: { dataPlan: 'plus' }, startDate: '2026-10-10', startTime: '12:00:30' });
    await ready(x);
    const s = await snapshot(x);
    expect(s.system.market).toMatchObject({ label: 'CLOSED', isOpen: false, sessions: 'all' });
    expect(s.system.trading.haltReasons.map((r) => r.code)).toContain('MARKET_CLOSED');
    expect(s.system.trading.entriesAllowed).toBe(false);
    // Sunday 20:00 is the next opening.
    expect(s.system.market.nextOpen).toBe(new Date('2026-10-11T20:00:00-04:00').getTime());
  }, 60_000);
});
