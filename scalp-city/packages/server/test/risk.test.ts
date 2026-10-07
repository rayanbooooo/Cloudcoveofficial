import { describe, expect, it } from 'vitest';
import { evaluateRisk, type ProposedOrder } from '../src/risk/RiskEngine.js';
import type { OrderRecord } from '../src/orders/types.js';
import { CONTRACT, LIMITS, NOW, account, brokerPosition, optionEntry, riskState, workerConfig } from './support/riskFixtures.js';

const blockedBy = (d: ReturnType<typeof evaluateRisk>) => d.blockedBy?.id ?? null;

function workingOrder(over: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: 'ord_x',
    venue: 'alpaca',
    env: 'paper',
    clientOrderId: 'sc-P-entry-x',
    brokerOrderId: 'b-x',
    workerId: 'spy',
    source: 'WORKER',
    purpose: 'ENTRY',
    signalId: 'spy:CALL:1',
    tradeId: null,
    symbol: 'SPY261005C00500000',
    underlying: 'SPY',
    assetClass: 'us_option',
    side: 'buy',
    positionIntent: 'buy_to_open',
    type: 'limit',
    timeInForce: 'day',
    qty: 1,
    limitPrice: 2,
    stopPrice: null,
    state: 'ACCEPTED',
    brokerStatus: 'new',
    filledQty: 0,
    filledAvgPrice: null,
    rejectedBy: null,
    rejectReason: null,
    errorMessage: null,
    risk: null,
    meta: { multiplier: 100 },
    createdAt: NOW,
    submittedAt: NOW,
    updatedAt: NOW,
    filledAt: null,
    ...over,
  };
}

describe('RiskEngine — baseline', () => {
  it('approves a clean option entry and itemizes every check', () => {
    const d = evaluateRisk(optionEntry(), riskState());
    expect(d.approved).toBe(true);
    expect(d.blockedBy).toBeNull();
    const ids = d.checks.map((c) => c.id);
    for (const id of ['kill_switch', 'broker', 'market_open', 'data_fresh', 'buying_power', 'liquidity', 'max_positions', 'daily_loss', 'duplicate_order', 'options_permission']) {
      expect(ids).toContain(id);
    }
  });
});

describe('RiskEngine — spec §122 risk cases', () => {
  it('blocks at the daily loss limit', () => {
    expect(blockedBy(evaluateRisk(optionEntry(), riskState({ accountDayPnl: -500 })))).toBe('daily_loss');
    expect(evaluateRisk(optionEntry(), riskState({ accountDayPnl: -499.99 })).approved).toBe(true);
  });

  it('blocks when day P&L is unavailable (fails closed)', () => {
    expect(blockedBy(evaluateRisk(optionEntry(), riskState({ accountDayPnl: null })))).toBe('daily_loss');
  });

  it('blocks oversize positions', () => {
    // 20 × $3.70 × 100 = $7,400 > $5,000
    const d = evaluateRisk(optionEntry({ qty: 20 }), riskState());
    expect(d.approved).toBe(false);
    expect(['order_notional', 'position_notional']).toContain(blockedBy(d));
  });

  it('blocks more contracts than allowed', () => {
    const s = riskState({ limits: { ...LIMITS, maxContracts: 1, maxOrderNotional: 1e9, maxPositionNotional: 1e9 }, worker: { config: workerConfig({ limits: { ...workerConfig().limits, maxPositionNotional: 1e9 } }), autotradeEnabled: true, dayPnl: 0, realizedToday: 0 } });
    expect(blockedBy(evaluateRisk(optionEntry({ qty: 2 }), s))).toBe('max_contracts');
  });

  it('blocks a new position when the concurrent limit is reached', () => {
    const s = riskState({
      brokerPositions: [brokerPosition({ symbol: 'SPY' }), brokerPosition({ symbol: 'IWM' }), brokerPosition({ symbol: 'AAPL' })],
    });
    expect(blockedBy(evaluateRisk(optionEntry(), s))).toBe('max_positions');
  });

  it('counts in-flight entries toward the concurrent limit', () => {
    const s = riskState({
      brokerPositions: [brokerPosition({ symbol: 'IWM' }), brokerPosition({ symbol: 'AAPL' })],
      openOrders: [workingOrder()],
    });
    expect(blockedBy(evaluateRisk(optionEntry(), s))).toBe('max_positions');
  });

  it('blocks when buying power is insufficient', () => {
    const s = riskState({ account: account({ optionsBuyingPower: 500, buyingPower: 500 }) });
    expect(blockedBy(evaluateRisk(optionEntry(), s))).toBe('buying_power');
  });

  it('blocks on stale market data', () => {
    const s = riskState({ freshness: { lastEventAt: NOW - 9000, ageMs: 9000, stale: true, reason: 'last event 9.0s ago' } });
    const d = evaluateRisk(optionEntry(), s);
    expect(blockedBy(d)).toBe('data_fresh');
    expect(d.blockedBy!.detail).toContain('STALE');
  });

  it('blocks when the market is closed', () => {
    const s = riskState({ market: { isOpen: false, minutesToClose: null, label: 'CLOSED' } });
    expect(blockedBy(evaluateRisk(optionEntry(), s))).toBe('market_open');
  });

  it('blocks when the broker is disconnected', () => {
    const s = riskState({ broker: { status: 'DISCONNECTED', detail: 'order update stream not connected' } });
    expect(blockedBy(evaluateRisk(optionEntry(), s))).toBe('broker');
  });

  it('blocks a duplicate order on the same symbol', () => {
    const s = riskState({ openOrders: [workingOrder({ symbol: CONTRACT, workerId: 'qqq' })] });
    expect(blockedBy(evaluateRisk(optionEntry(), s))).toBe('duplicate_order');
  });

  it('blocks a reused signal', () => {
    expect(blockedBy(evaluateRisk(optionEntry(), riskState({ signalAlreadyUsed: true })))).toBe('signal_unique');
  });

  it('blocks a stale signal', () => {
    expect(blockedBy(evaluateRisk(optionEntry({ signalBarCloseAt: NOW - 120_000 }), riskState()))).toBe('signal_fresh');
  });

  it('blocks when a worker already holds a position (duplicate position protection)', () => {
    const s = riskState({
      ledgerPositions: [
        { venue: 'alpaca', env: 'paper', symbol: 'QQQ261005P00590000', workerId: 'qqq-og', tradeId: 't', assetClass: 'us_option', underlying: 'QQQ', direction: 'PUT', qty: 2, avgPrice: 2, multiplier: 100, external: false, openedAt: NOW, updatedAt: NOW },
      ],
    });
    expect(blockedBy(evaluateRisk(optionEntry(), s))).toBe('duplicate_position');
  });

  it('blocks entries when the broker shows an unexpected position in the symbol', () => {
    const s = riskState({ brokerPositions: [brokerPosition({ symbol: CONTRACT, assetClass: 'us_option', qty: 1, marketValue: 368 })] });
    expect(blockedBy(evaluateRisk(optionEntry(), s))).toBe('duplicate_position');
  });
});

describe('RiskEngine — controls and gates', () => {
  it('kill switch blocks entries and automated exits but not a manual flatten', () => {
    const s = riskState({ controls: { autotrading: true, entriesPaused: false, killSwitch: true }, brokerPositions: [brokerPosition({ symbol: CONTRACT, assetClass: 'us_option', qty: 2, marketValue: 736 })] });
    expect(blockedBy(evaluateRisk(optionEntry(), s))).toBe('kill_switch');
    const exit = optionEntry({ purpose: 'EXIT', side: 'sell', type: 'market', limitPrice: null, signalId: null });
    expect(blockedBy(evaluateRisk(exit, s))).toBe('kill_switch');
    const flatten = { ...exit, purpose: 'FLATTEN' as const, source: 'FLATTEN' as const, workerId: null };
    expect(evaluateRisk(flatten, s).approved).toBe(true);
  });

  it('autotrading off blocks worker orders', () => {
    const s = riskState({ controls: { autotrading: false, entriesPaused: false, killSwitch: false } });
    expect(blockedBy(evaluateRisk(optionEntry(), s))).toBe('autotrading');
  });

  it('pause entries blocks new entries but not exits', () => {
    const s = riskState({ controls: { autotrading: true, entriesPaused: true, killSwitch: false }, brokerPositions: [brokerPosition({ symbol: CONTRACT, assetClass: 'us_option', qty: 2, marketValue: 736 })] });
    expect(blockedBy(evaluateRisk(optionEntry(), s))).toBe('entries_paused');
    const exit = optionEntry({ purpose: 'EXIT', side: 'sell', type: 'market', limitPrice: null, signalId: null, qty: 2 });
    expect(evaluateRisk(exit, s).approved).toBe(true);
  });

  it('LIVE refuses every order unless the server lock is open AND execution is armed', () => {
    expect(blockedBy(evaluateRisk(optionEntry(), riskState({ env: 'live', live: { serverLockOpen: false, armed: true } })))).toBe('live_gate');
    expect(blockedBy(evaluateRisk(optionEntry(), riskState({ env: 'live', live: { serverLockOpen: true, armed: false } })))).toBe('live_gate');
    expect(evaluateRisk(optionEntry(), riskState({ env: 'live', live: { serverLockOpen: true, armed: true } })).approved).toBe(true);
  });

  it('daily-loss breaker does not stop a risk-reducing exit; integrity breakers do', () => {
    const pos = [brokerPosition({ symbol: CONTRACT, assetClass: 'us_option', qty: 2, marketValue: 736 })];
    const exit = optionEntry({ purpose: 'EXIT', side: 'sell', type: 'market', limitPrice: null, signalId: null, qty: 2 });
    const lossOnly = riskState({ brokerPositions: pos, breakers: [{ id: 'DAILY_LOSS', label: 'Daily loss limit', exitSafe: true }] });
    expect(evaluateRisk(exit, lossOnly).approved).toBe(true);
    expect(blockedBy(evaluateRisk(optionEntry(), lossOnly))).toBe('circuit_breakers');
    const mismatch = riskState({ brokerPositions: pos, breakers: [{ id: 'ACCOUNT_MISMATCH', label: 'Account mismatch', exitSafe: false }] });
    expect(blockedBy(evaluateRisk(exit, mismatch))).toBe('circuit_breakers');
  });

  it('refuses closing more than the broker position holds', () => {
    const s = riskState({ brokerPositions: [brokerPosition({ symbol: CONTRACT, assetClass: 'us_option', qty: 2, qtyAvailable: 2, marketValue: 736 })] });
    const exit = optionEntry({ purpose: 'MANUAL_CLOSE', source: 'MANUAL', side: 'sell', type: 'market', limitPrice: null, signalId: null, qty: 3 });
    expect(blockedBy(evaluateRisk(exit, s))).toBe('close_qty');
  });

  it('refuses illiquid option contracts regardless of signal strength', () => {
    const s = riskState({ optionMarket: { bid: 1.0, ask: 1.4, ageMs: 100, stale: false, volume: 5000, openInterest: 12000, bidSize: 40, contractTradable: true, contractStatus: 'active' } });
    expect(blockedBy(evaluateRisk(optionEntry({ limitPrice: 1.4, referencePrice: 1.4 }), s))).toBe('liquidity');
  });

  it('blocks automated options trading on a non-real-time options feed', () => {
    const s = riskState({ optionsPolicy: { allowed: false, reason: 'OPTIONS DATA UNAVAILABLE' } });
    expect(blockedBy(evaluateRisk(optionEntry(), s))).toBe('options_data');
  });

  it('guards against fat-finger limit prices', () => {
    expect(blockedBy(evaluateRisk(optionEntry({ limitPrice: 4.5 }), riskState()))).toBe('price_sanity');
  });

  it('enforces the pattern-day-trader guard for small margin accounts', () => {
    const s = riskState({ account: account({ equity: 20_000, daytradeCount: 3, multiplier: 2 }) });
    expect(blockedBy(evaluateRisk(optionEntry(), s))).toBe('pdt');
    const cash = riskState({ account: account({ equity: 20_000, daytradeCount: 3, multiplier: 1 }) });
    expect(evaluateRisk(optionEntry(), cash).approved).toBe(true);
  });

  it('stands a worker down at its daily goal and halts it at its loss limit', () => {
    const goal = riskState({ worker: { config: workerConfig(), autotradeEnabled: true, dayPnl: 510, realizedToday: 510 } });
    expect(blockedBy(evaluateRisk(optionEntry(), goal))).toBe('worker_goal');
    const loss = riskState({ worker: { config: workerConfig(), autotradeEnabled: true, dayPnl: -200, realizedToday: -200 } });
    expect(blockedBy(evaluateRisk(optionEntry(), loss))).toBe('worker_loss');
  });

  it("fails closed when a worker's day P&L is unknown (open position without a mark)", () => {
    const unknown = riskState({ worker: { config: workerConfig(), autotradeEnabled: true, dayPnl: null, realizedToday: 0 } });
    expect(blockedBy(evaluateRisk(optionEntry(), unknown))).toBe('worker_loss');
  });

  it('enforces max trades per day and order rate', () => {
    expect(blockedBy(evaluateRisk(optionEntry(), riskState({ entriesToday: 10 })))).toBe('max_trades');
    expect(blockedBy(evaluateRisk(optionEntry(), riskState({ ordersLastMinute: 10 })))).toBe('order_rate');
  });

  it('never allows selling options to open', () => {
    expect(blockedBy(evaluateRisk(optionEntry({ purpose: 'MANUAL_OPEN', source: 'MANUAL', side: 'sell' }), riskState()))).toBe('no_short_options');
  });
});

describe('RiskEngine — automated share entries outside the regular session', () => {
  /** A worker's long entry of 5 QQQ with its stop 3 below. */
  const shareEntry = (over: Partial<ProposedOrder> = {}): ProposedOrder => ({
    orderId: null,
    purpose: 'ENTRY',
    source: 'WORKER',
    workerId: 'qqq-og',
    signalId: 'qqq-og:CALL:1',
    signalBarCloseAt: NOW - 5_000,
    symbol: 'QQQ',
    underlying: 'QQQ',
    assetClass: 'us_equity',
    side: 'buy',
    qty: 5,
    type: 'limit',
    limitPrice: 600.04,
    stopPrice: null,
    multiplier: 1,
    referencePrice: 600.04,
    softStop: 597,
    ...over,
  });
  const ids = (d: ReturnType<typeof evaluateRisk>) => d.checks.map((c) => c.id);
  const check = (d: ReturnType<typeof evaluateRisk>, id: string) => d.checks.find((c) => c.id === id)!;
  const data = (over: Partial<NonNullable<ReturnType<typeof riskState>['signalData']>> = {}) => ({ dataMinutesLeft: null, barsDelayed: null, barsUnbroken: true, ...over });

  it('adds none of these checks in the regular session, where the data is not in question', () => {
    const d = evaluateRisk(shareEntry(), riskState());
    expect(d.approved).toBe(true);
    for (const id of ['bars_live', 'data_hours', 'bars_unbroken']) expect(ids(d)).not.toContain(id);
  });

  it('approves an entry on bars that can be traded on, from a feed that will keep reporting, with an unbroken run of minutes', () => {
    const d = evaluateRisk(shareEntry(), riskState({ signalData: data() }));
    expect(d.approved).toBe(true);
    expect(check(d, 'bars_unbroken')).toMatchObject({ passed: true });
    expect(ids(d)).not.toContain('bars_live');
    expect(ids(d)).not.toContain('data_hours');
  });

  it('refuses bars that describe the market as it was a quarter of an hour ago, and says that before anything else about the signal', () => {
    const reason = 'the free plan’s overnight feed reports trades 15 minutes late, so its bars are old news';
    const d = evaluateRisk(shareEntry({ signalBarCloseAt: NOW - 15 * 60_000 }), riskState({ signalData: data({ barsDelayed: reason }) }));
    expect(d.approved).toBe(false);
    expect(blockedBy(d)).toBe('bars_live'); // not the less helpful "signal age"
    expect(d.blockedBy!.detail).toBe(reason);
  });

  it('keeps entries out of the last ten minutes before the free IEX feed goes quiet', () => {
    const left = (m: number) => evaluateRisk(shareEntry(), riskState({ signalData: data({ dataMinutesLeft: m }) }));
    expect(left(10.5).approved).toBe(true);
    for (const m of [10, 9.9, 3, 0.5]) {
      const d = left(m);
      expect(blockedBy(d), `${m} min`).toBe('data_hours');
      expect(d.blockedBy!.detail).toContain('free IEX feed goes quiet at 17:00');
    }
    const none = left(0);
    expect(blockedBy(none)).toBe('data_hours');
    expect(none.blockedBy!.detail).toBe('the free IEX feed has no data at this hour');
  });

  it('refuses a signal on bars with a hole in them: a minute without a trade in the last four', () => {
    const d = evaluateRisk(shareEntry(), riskState({ signalData: data({ barsUnbroken: false }) }));
    expect(blockedBy(d)).toBe('bars_unbroken');
    expect(d.blockedBy!.detail).toMatch(/thin market/);
  });

  it('is about automated signals only: a person’s own order, an exit and a flatten are not held to it', () => {
    const bad = riskState({ signalData: data({ barsDelayed: 'late', dataMinutesLeft: 3, barsUnbroken: false }), brokerPositions: [brokerPosition({ symbol: 'QQQ', qty: 5, qtyAvailable: 5, avgEntryPrice: 600 })] });
    const manual = evaluateRisk(shareEntry({ source: 'MANUAL', purpose: 'MANUAL_OPEN', workerId: null, softStop: null }), { ...bad, brokerPositions: [] });
    for (const id of ['bars_live', 'data_hours', 'bars_unbroken']) expect(ids(manual)).not.toContain(id);
    const exit = evaluateRisk(shareEntry({ purpose: 'EXIT', side: 'sell', softStop: null }), bad);
    for (const id of ['bars_live', 'data_hours', 'bars_unbroken']) expect(ids(exit)).not.toContain(id);
    const flatten = evaluateRisk(shareEntry({ source: 'FLATTEN', purpose: 'FLATTEN', side: 'sell', workerId: null, softStop: null }), bad);
    for (const id of ['bars_live', 'data_hours', 'bars_unbroken']) expect(ids(flatten)).not.toContain(id);
  });
});
