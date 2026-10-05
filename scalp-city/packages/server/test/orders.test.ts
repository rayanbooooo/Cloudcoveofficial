import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brokerStatusToState, canTransition, fillDeltaPrice, nextState } from '../src/orders/stateMachine.js';
import { createEngineHarness, entryRequest, type EngineHarness } from './support/harness.js';
import { CONTRACT } from './support/riskFixtures.js';

let h: EngineHarness;
beforeEach(async () => {
  h = await createEngineHarness();
});
afterEach(async () => {
  await h.audit.flush();
  await h.db.close();
});

const waitFor = async (cond: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('order state machine', () => {
  it('maps broker statuses', () => {
    expect(brokerStatusToState('new')).toBe('ACCEPTED');
    expect(brokerStatusToState('partially_filled')).toBe('PARTIALLY_FILLED');
    expect(brokerStatusToState('filled')).toBe('FILLED');
    expect(brokerStatusToState('done_for_day')).toBe('EXPIRED');
    expect(brokerStatusToState('weird')).toBeNull();
  });

  it('never moves out of a terminal state', () => {
    expect(nextState('FILLED', 'new')).toEqual({ state: 'FILLED', changed: false, ignored: true });
    expect(canTransition('CANCELED', 'FILLED')).toBe(false);
  });

  it('lets a pending cancel fall back when the broker refuses it', () => {
    expect(nextState('CANCEL_PENDING', 'new').state).toBe('ACCEPTED');
  });

  it('prices a fill delta from the execution or from average-price change', () => {
    expect(fillDeltaPrice({ prevQty: 0, prevAvg: null, newQty: 8, newAvg: 3.6, eventQty: 8, eventPrice: 3.6 })).toBe(3.6);
    // 8 @ 3.60 then 12 more, new avg 3.672 → delta price = (3.672*20 - 3.6*8)/12 = 3.72
    expect(fillDeltaPrice({ prevQty: 8, prevAvg: 3.6, newQty: 20, newAvg: 3.672, eventQty: null, eventPrice: null })).toBeCloseTo(3.72, 10);
  });
});

describe('OrderEngine — lifecycle (spec §122 orders)', () => {
  it('submit → accepted → filled, and FILLED only after broker confirmation', async () => {
    const order = await h.engine.submit(entryRequest());
    expect(order.state).toBe('ACCEPTED');
    expect(order.brokerOrderId).not.toBeNull();
    expect(h.ledger.get(CONTRACT)).toBeNull(); // nothing held until a fill arrives

    await h.engine.onTradeUpdate(h.broker.fill(order.clientOrderId, 2, 3.68));
    expect(order.state).toBe('FILLED');
    expect(order.filledQty).toBe(2);
    const pos = h.ledger.get(CONTRACT)!;
    expect(pos.qty).toBe(2);
    expect(pos.workerId).toBe('qqq-og');
    expect(pos.avgPrice).toBeCloseTo(3.68, 10);
  });

  it('tracks partial fills with actual quantities', async () => {
    h.riskOverrides = { limits: { ...(await import('./support/riskFixtures.js')).LIMITS, maxOrderNotional: 1e6, maxPositionNotional: 1e6 } };
    const req = entryRequest({ qty: 20 });
    req.meta = { multiplier: 100, direction: 'CALL' };
    h.riskOverrides.worker = { config: (await import('./support/riskFixtures.js')).workerConfig({ limits: { maxTradesPerDay: 5, maxContracts: 20, maxShares: 100, maxPositionNotional: 1e6, dailyLossLimit: 200, dailyGoal: 500, riskPerTrade: 10 } }), autotradeEnabled: true, dayPnl: 0, realizedToday: 0 };
    const order = await h.engine.submit(req);
    expect(order.state).toBe('ACCEPTED');
    await h.engine.onTradeUpdate(h.broker.fill(order.clientOrderId, 8, 3.6));
    expect(order.state).toBe('PARTIALLY_FILLED');
    expect(order.filledQty).toBe(8);
    expect(h.ledger.get(CONTRACT)!.qty).toBe(8);
    await h.engine.onTradeUpdate(h.broker.fill(order.clientOrderId, 12, 3.72));
    expect(order.state).toBe('FILLED');
    expect(order.filledQty).toBe(20);
    expect(h.ledger.get(CONTRACT)!.qty).toBe(20);
    expect(h.ledger.get(CONTRACT)!.avgPrice).toBeCloseTo((8 * 3.6 + 12 * 3.72) / 20, 10);
  });

  it('cancel: CANCEL_PENDING until the broker confirms CANCELED', async () => {
    const order = await h.engine.submit(entryRequest());
    const r = await h.engine.cancel(order.id, 'tester');
    expect(r.ok).toBe(true);
    expect(order.state).toBe('CANCEL_PENDING');
    await h.engine.onTradeUpdate(h.broker.confirmCancel(order.clientOrderId));
    expect(order.state).toBe('CANCELED');
  });

  it('cancel refused by the broker reports the real reason and changes nothing', async () => {
    const order = await h.engine.submit(entryRequest());
    h.broker.cancelBehavior = 'refuse';
    const r = await h.engine.cancel(order.id, 'tester');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('not cancelable');
    expect(order.state).toBe('ACCEPTED');
    expect(order.meta.cancelError).toContain('not cancelable');
  });

  it('broker rejection is recorded with the broker reason', async () => {
    h.broker.submitBehavior = 'reject';
    const order = await h.engine.submit(entryRequest());
    expect(order.state).toBe('REJECTED');
    expect(order.rejectedBy).toBe('BROKER');
    expect(order.rejectReason).toBe('insufficient buying power');
    expect(h.breakerLog.some((x) => x.startsWith('reject:'))).toBe(true);
  });

  it('risk rejection never reaches the broker', async () => {
    h.riskOverrides = { controls: { autotrading: true, entriesPaused: false, killSwitch: true } };
    const order = await h.engine.submit(entryRequest());
    expect(order.state).toBe('REJECTED');
    expect(order.rejectedBy).toBe('RISK');
    expect(order.rejectReason).toContain('Kill switch');
    expect(h.broker.submitCalls).toHaveLength(0);
  });
});

describe('OrderEngine — idempotency (spec §14)', () => {
  it('a timeout after the broker created the order is resolved, not resubmitted', async () => {
    h.broker.submitBehavior = 'timeout-created';
    const order = await h.engine.submit(entryRequest());
    expect(order.state).toBe('SUBMITTING');
    expect(order.errorMessage).toContain('outcome unknown');
    await waitFor(() => order.state === 'ACCEPTED');
    expect(h.broker.submitCalls).toHaveLength(1);
    expect(order.brokerOrderId).not.toBeNull();
    expect(order.errorMessage).toBeNull();
  });

  it('a timeout where the broker never created the order ends in ERROR — still exactly one submission', async () => {
    h.broker.submitBehavior = 'timeout-not-created';
    const order = await h.engine.submit(entryRequest());
    await waitFor(() => order.state === 'ERROR');
    expect(h.broker.submitCalls).toHaveLength(1);
    expect(order.errorMessage).toContain('not retried');
  });

  it('a 5xx is treated as ambiguous and resolved by client order id', async () => {
    h.broker.submitBehavior = 'server-error-created';
    const order = await h.engine.submit(entryRequest());
    await waitFor(() => order.state === 'ACCEPTED');
    expect(h.broker.submitCalls).toHaveLength(1);
  });

  it('the same signal can never produce two orders', async () => {
    const req = entryRequest({ signalId: 'qqq-og:CALL:1791212400000' });
    const first = await h.engine.submit(req);
    const second = await h.engine.submit({ ...req });
    expect(first.state).toBe('ACCEPTED');
    expect(second.state).toBe('REJECTED');
    expect(second.rejectReason).toContain('duplicate signal');
    expect(h.broker.submitCalls).toHaveLength(1);
  });

  it('a duplicated fill event is counted once', async () => {
    const order = await h.engine.submit(entryRequest());
    const u = h.broker.fill(order.clientOrderId, 2, 3.68, 'exec-1');
    await h.engine.onTradeUpdate(u);
    await h.engine.onTradeUpdate(u);
    expect(order.filledQty).toBe(2);
    expect(h.ledger.get(CONTRACT)!.qty).toBe(2);
  });

  it('out-of-order events never move an order backwards', async () => {
    const order = await h.engine.submit(entryRequest());
    const o = h.broker.findByClientId(order.clientOrderId);
    const stale = { ...o }; // status "new"
    await h.engine.onTradeUpdate(h.broker.fill(order.clientOrderId, 2, 3.68));
    await h.engine.onTradeUpdate({ event: 'new', executionId: null, order: stale, timestamp: h.clock.now() - 1000, positionQty: null, price: null, qty: null });
    expect(order.state).toBe('FILLED');
    expect(order.filledQty).toBe(2);
  });

  it('concurrent entries cannot jointly exceed the position limit', async () => {
    const { LIMITS } = await import('./support/riskFixtures.js');
    h.riskOverrides = { limits: { ...LIMITS, maxConcurrentPositions: 1 } };
    const [a, b] = await Promise.all([
      h.engine.submit(entryRequest({ workerId: 'qqq-og', symbol: 'QQQ261005C00600000' })),
      h.engine.submit(entryRequest({ workerId: 'spy', symbol: 'SPY261005C00500000', underlying: 'SPY', signalId: 'spy:CALL:1' })),
    ]);
    const states = [a.state, b.state].sort();
    expect(states).toEqual(['ACCEPTED', 'REJECTED']);
    expect(h.broker.submitCalls).toHaveLength(1);
  });
});

describe('OrderEngine — round trip P&L', () => {
  it('realized P&L comes from actual fill prices', async () => {
    const entry = await h.engine.submit(entryRequest());
    await h.engine.onTradeUpdate(h.broker.fill(entry.clientOrderId, 2, 3.68));
    const exit = await h.engine.submit({
      ...entryRequest(),
      purpose: 'EXIT',
      signalId: null,
      side: 'sell',
      positionIntent: 'sell_to_close',
      type: 'market',
      limitPrice: null,
      meta: { multiplier: 100, direction: 'CALL', exitReason: 'TAKE_PROFIT' },
    });
    expect(exit.state).toBe('ACCEPTED');
    let closedPnl: number | null = null;
    h.bus.on('POSITION_CLOSED', ({ trade }) => (closedPnl = trade.realizedPnl));
    await h.engine.onTradeUpdate(h.broker.fill(exit.clientOrderId, 2, 4.1));
    expect(exit.state).toBe('FILLED');
    expect(h.ledger.get(CONTRACT)).toBeNull();
    expect(closedPnl).toBeCloseTo((4.1 - 3.68) * 2 * 100, 8); // +$84.00
    const { rows } = await h.db.query(`SELECT status, realized_pnl, exit_reason FROM trades`);
    expect(rows[0]).toMatchObject({ status: 'CLOSED', exit_reason: 'TAKE_PROFIT' });
    expect(Number(rows[0].realized_pnl)).toBeCloseTo(84, 8);
  });
});
