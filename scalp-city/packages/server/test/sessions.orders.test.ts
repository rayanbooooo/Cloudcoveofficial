import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrderRequest } from '../src/orders/types.js';
import { marketableLimit, mayBecomeMarketableLimit } from '../src/orders/offHours.js';
import { DateTime } from 'luxon';
import { nyDate } from '../src/market/MarketCalendar.js';
import { createEngineHarness, entryRequest, type EngineHarness } from './support/harness.js';
import { brokerPosition } from './support/riskFixtures.js';

/**
 * Orders outside the regular session. Alpaca takes only limit orders there, flagged as extended-hours; the engine
 * flags every share order at that hour, turns an exit or flatten that would have been a market order into a limit
 * through the touch, and refuses an opening market order or an options order instead of sending something Alpaca
 * would reject (three broker rejections in ten minutes would trip the circuit breaker).
 */

describe('priced through the touch', () => {
  it('sells a little under the bid and buys a little over the ask, rounded away from the quote to the cent', () => {
    expect(marketableLimit('sell', { bid: 300, ask: 300.04 }, 0.5)).toBe(298.5);
    expect(marketableLimit('sell', { bid: 300.07, ask: 300.1 }, 0.5)).toBe(298.56); // 298.56965 rounds down
    expect(marketableLimit('buy', { bid: 300, ask: 300.04 }, 0.5)).toBe(301.55); // 301.5402 rounds up
    expect(marketableLimit('buy', { bid: 300, ask: 300.04 }, 0)).toBe(300.04);
    expect(marketableLimit('sell', { bid: 300.07, ask: 300.1 }, 0)).toBe(300.07); // float noise does not move a cent
  });

  it('has no price without a usable quote', () => {
    expect(marketableLimit('sell', { bid: 0, ask: 1 }, 0.5)).toBeNull();
    expect(marketableLimit('sell', { bid: 300, ask: 299 }, 0.5)).toBeNull(); // crossed
    expect(marketableLimit('sell', { bid: 300, ask: 300.04 }, -1)).toBeNull();
    expect(marketableLimit('sell', { bid: NaN, ask: 300 }, 0.5)).toBeNull();
  });

  it('only ever applies to orders that reduce a position', () => {
    for (const p of ['EXIT', 'FLATTEN', 'MANUAL_CLOSE'] as const) expect(mayBecomeMarketableLimit(p)).toBe(true);
    for (const p of ['ENTRY', 'MANUAL_OPEN', 'PROTECTIVE_STOP'] as const) expect(mayBecomeMarketableLimit(p)).toBe(false);
  });
});

describe('the order engine outside the regular session', () => {
  let h: EngineHarness;
  let off = true;
  const quotes: Record<string, { bid: number; ask: number }> = { GLD: { bid: 300, ask: 300.04 }, QQQ: { bid: 600, ask: 600.04 } };

  beforeEach(async () => {
    off = true;
    h = await createEngineHarness({ offHours: { active: () => off, quote: (s) => quotes[s] ?? null, bufferPct: 0.5 } });
  });
  afterEach(async () => {
    await h.audit.flush();
    await h.db.close();
  });

  /** A worker's market exit of 10 GLD. */
  const exitRequest = (over: Partial<OrderRequest> & { referencePrice?: number } = {}): OrderRequest & { referencePrice: number } => ({
    workerId: 'qqq-og',
    source: 'WORKER',
    purpose: 'EXIT',
    signalId: null,
    symbol: 'GLD',
    underlying: 'GLD',
    assetClass: 'us_equity',
    side: 'sell',
    positionIntent: null,
    type: 'market',
    timeInForce: 'day',
    qty: 10,
    limitPrice: null,
    stopPrice: null,
    meta: { multiplier: 1, direction: 'CALL', exitReason: 'STOP_LOSS' },
    actor: 'worker:qqq-og',
    referencePrice: 300.02,
    ...over,
  });

  /** A worker's limit entry of 5 QQQ with a stop 3 below. */
  const shareEntry = (over: Partial<OrderRequest> & { referencePrice?: number } = {}) =>
    entryRequest({
      symbol: 'QQQ',
      underlying: 'QQQ',
      assetClass: 'us_equity',
      positionIntent: null,
      qty: 5,
      limitPrice: 600.04,
      meta: { multiplier: 1, direction: 'CALL', softStop: { price: 597 } },
      referencePrice: 600.04,
      ...over,
    });

  const holdGld = () => {
    h.broker.positions = [brokerPosition({ symbol: 'GLD', qty: 10, qtyAvailable: 10, avgEntryPrice: 301, currentPrice: 300 })];
  };

  it('turns a market exit into a day limit just under the bid, flagged as extended hours', async () => {
    holdGld();
    const order = await h.engine.submit(exitRequest());
    expect(order.state).toBe('ACCEPTED');
    expect(h.broker.submitCalls).toHaveLength(1);
    expect(h.broker.submitCalls[0]).toMatchObject({ symbol: 'GLD', side: 'sell', type: 'limit', limitPrice: 298.5, timeInForce: 'day', extendedHours: true });
    expect(order.type).toBe('limit');
    expect(order.limitPrice).toBe(298.5);
    expect(order.meta.extendedHours).toBe(true);
    expect(order.meta.convertedFromMarket).toEqual({ bufferPct: 0.5 });
  });

  it('does the same for a flatten and for a manual close, and covers a short a little over the ask', async () => {
    holdGld();
    const flat = await h.engine.submit(exitRequest({ source: 'FLATTEN', purpose: 'FLATTEN', workerId: null, actor: 'tester' }));
    expect(flat.state).toBe('ACCEPTED');
    expect(h.broker.submitCalls[0]).toMatchObject({ type: 'limit', limitPrice: 298.5, extendedHours: true });
    await h.engine.onTradeUpdate(h.broker.confirmCancel(flat.clientOrderId));

    const manual = await h.engine.submit(exitRequest({ source: 'MANUAL', purpose: 'MANUAL_CLOSE', workerId: null, actor: 'tester' }));
    expect(manual.state).toBe('ACCEPTED');
    expect(h.broker.submitCalls[1]).toMatchObject({ type: 'limit', limitPrice: 298.5, extendedHours: true });
    await h.engine.onTradeUpdate(h.broker.confirmCancel(manual.clientOrderId));

    h.broker.positions = [brokerPosition({ symbol: 'GLD', side: 'short', qty: 10, qtyAvailable: 10, avgEntryPrice: 299, currentPrice: 300 })];
    const cover = await h.engine.submit(exitRequest({ side: 'buy' }));
    expect(cover.state).toBe('ACCEPTED');
    expect(h.broker.submitCalls[2]).toMatchObject({ side: 'buy', type: 'limit', limitPrice: 301.55, extendedHours: true });
  });

  it('keeps a limit exit as it is, flagged', async () => {
    holdGld();
    const order = await h.engine.submit(exitRequest({ type: 'limit', limitPrice: 299.9 }));
    expect(order.state).toBe('ACCEPTED');
    expect(h.broker.submitCalls[0]).toMatchObject({ type: 'limit', limitPrice: 299.9, extendedHours: true });
    expect(order.meta.convertedFromMarket ?? null).toBeNull();
  });

  it('refuses a closing market order it cannot price, rather than sending what Alpaca would reject', async () => {
    h.broker.positions = [brokerPosition({ symbol: 'IWM', qty: 10, qtyAvailable: 10, avgEntryPrice: 220, currentPrice: 220 })];
    const order = await h.engine.submit(exitRequest({ symbol: 'IWM', underlying: 'IWM', referencePrice: 220 }));
    expect(order.state).toBe('REJECTED');
    expect(order.rejectedBy).toBe('VALIDATION');
    expect(order.rejectReason).toMatch(/only accepted in the regular session/);
    expect(h.broker.submitCalls).toHaveLength(0);
    expect(h.breakerLog).toEqual([]); // not a broker rejection: nothing to trip the breaker
  });

  it('sends a share entry as a flagged day limit, unchanged', async () => {
    const order = await h.engine.submit(shareEntry());
    expect(order.state).toBe('ACCEPTED');
    expect(h.broker.submitCalls[0]).toMatchObject({ symbol: 'QQQ', side: 'buy', type: 'limit', limitPrice: 600.04, timeInForce: 'day', extendedHours: true });
    expect(order.meta.convertedFromMarket ?? null).toBeNull();
  });

  it('never turns an opening market order into a limit: it is refused', async () => {
    const order = await h.engine.submit(shareEntry({ type: 'market', limitPrice: null }));
    expect(order.state).toBe('REJECTED');
    expect(order.rejectedBy).toBe('VALIDATION');
    expect(order.rejectReason).toMatch(/market orders are only accepted in the regular session/);
    expect(h.broker.submitCalls).toHaveLength(0);
  });

  it('refuses options, and an immediate-or-cancel / fill-or-kill share order, at this hour', async () => {
    const opt = await h.engine.submit(entryRequest());
    expect(opt.state).toBe('REJECTED');
    expect(opt.rejectedBy).toBe('VALIDATION');
    expect(opt.rejectReason).toMatch(/options trade only in the regular session/);

    const fok = await h.engine.submit(shareEntry({ timeInForce: 'fok' }));
    expect(fok.state).toBe('REJECTED');
    expect(fok.rejectReason).toMatch(/must be DAY or GTC, not FOK/);
    expect(h.broker.submitCalls).toHaveLength(0);
  });

  it('leaves everything alone during the regular session', async () => {
    off = false;
    holdGld();
    const order = await h.engine.submit(exitRequest());
    expect(order.state).toBe('ACCEPTED');
    expect(h.broker.submitCalls[0]).toMatchObject({ type: 'market', extendedHours: false });
    expect(order.meta.extendedHours).toBeUndefined();
    await h.engine.onTradeUpdate(h.broker.confirmCancel(order.clientOrderId)); // the worker is busy until its exit ends
    const opt = await h.engine.submit(entryRequest());
    expect(opt.rejectReason).toBeNull();
    expect(opt.state).toBe('ACCEPTED'); // options are fine in the regular session
  });
});

describe('the order engine with no session policy (regular hours only)', () => {
  it('never flags or converts anything', async () => {
    const h = await createEngineHarness();
    try {
      h.broker.positions = [brokerPosition({ symbol: 'GLD', qty: 10, qtyAvailable: 10, avgEntryPrice: 301, currentPrice: 300 })];
      const order = await h.engine.submit({
        workerId: null,
        source: 'MANUAL',
        purpose: 'MANUAL_CLOSE',
        signalId: null,
        symbol: 'GLD',
        underlying: 'GLD',
        assetClass: 'us_equity',
        side: 'sell',
        positionIntent: null,
        type: 'market',
        timeInForce: 'day',
        qty: 10,
        limitPrice: null,
        stopPrice: null,
        meta: { multiplier: 1 },
        actor: 'tester',
      });
      expect(order.state).toBe('ACCEPTED');
      expect(h.broker.submitCalls[0]).toMatchObject({ type: 'market', extendedHours: false });
    } finally {
      await h.audit.flush();
      await h.db.close();
    }
  });
});

describe('trades per day across the night', () => {
  const NY = 'America/New_York';
  const at = (iso: string) => DateTime.fromISO(iso, { zone: NY }).toMillis();
  const shareEntry = () =>
    entryRequest({
      symbol: 'QQQ',
      underlying: 'QQQ',
      assetClass: 'us_equity',
      positionIntent: null,
      qty: 5,
      limitPrice: 600.04,
      meta: { multiplier: 1, direction: 'CALL', softStop: { price: 597 } },
      referencePrice: 600.04,
    });

  it('counts an entry at 23:30 on the same day as one at 01:00 when the trading day runs 04:00 to 04:00', async () => {
    const h = await createEngineHarness({ tradingDay: (t) => nyDate(t - 4 * 3_600_000) });
    try {
      h.clock.set(at('2026-10-05T23:30:00'));
      const order = await h.engine.submit({ ...shareEntry(), signalBarCloseAt: h.clock.now() - 5_000 });
      expect(order.state).toBe('ACCEPTED');
      expect(h.engine.entriesToday()).toBe(1);
      h.clock.set(at('2026-10-06T01:00:00')); // after midnight, in the same night
      expect(h.engine.entriesToday()).toBe(1);
      h.clock.set(at('2026-10-06T04:00:01')); // a new trading day
      expect(h.engine.entriesToday()).toBe(0);
    } finally {
      await h.audit.flush();
      await h.db.close();
    }
  });

  it('starts a new day at midnight under the default (New York date)', async () => {
    const h = await createEngineHarness();
    try {
      h.clock.set(at('2026-10-05T23:30:00'));
      await h.engine.submit({ ...shareEntry(), signalBarCloseAt: h.clock.now() - 5_000 });
      expect(h.engine.entriesToday()).toBe(1);
      h.clock.set(at('2026-10-06T00:30:00'));
      expect(h.engine.entriesToday()).toBe(0);
    } finally {
      await h.audit.flush();
      await h.db.close();
    }
  });
});
