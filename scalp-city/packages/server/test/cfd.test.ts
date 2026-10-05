import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RiskLimits } from '@scalp-city/shared';
import { PROTECTIVE_SUFFIX, validateOrder } from '../src/orders/OrderEngine.js';
import type { OrderRecord } from '../src/orders/types.js';
import { evaluateRisk, fitsPrecision, type CfdMarket, type ProposedOrder, type RiskState } from '../src/risk/RiskEngine.js';
import { createEngineHarness, type EngineHarness } from './support/harness.js';
import { LIMITS, NOW, account, brokerPosition, riskState, workerConfig } from './support/riskFixtures.js';

const GOLD_LIMITS: RiskLimits = { ...LIMITS, maxPositionNotional: 10_000, maxOrderNotional: 10_000, maxRiskPerTrade: 20, pdtGuard: false };
const goldSpec: CfdMarket = { listed: true, tradeable: true, unitsPrecision: 0, minUnits: 1, maxOrderUnits: 500, marginRate: 0.05, homeFactor: 1, marginAvailable: 5_000 };

/** A worker LONG entry on gold: 3 units around 2650, a 2.2 stop. */
function goldEntry(over: Partial<ProposedOrder> = {}): ProposedOrder {
  return {
    orderId: null,
    purpose: 'ENTRY',
    source: 'WORKER',
    workerId: 'oanda-gold',
    signalId: 'oanda-gold:CALL:1',
    signalBarCloseAt: NOW - 3_000,
    symbol: 'XAU_USD',
    underlying: 'XAU_USD',
    assetClass: 'cfd',
    side: 'buy',
    qty: 3,
    type: 'limit',
    limitPrice: 2650.5,
    stopPrice: null,
    multiplier: 1,
    referencePrice: 2650.3,
    protectiveStop: 2648.1,
    ...over,
  };
}

function goldState(over: Partial<RiskState> = {}): RiskState {
  return riskState({
    limits: GOLD_LIMITS,
    currency: 'USD',
    cfd: goldSpec,
    account: account({ currency: 'USD', equity: 5_000, multiplier: null, daytradeCount: null, optionsApprovedLevel: null, optionsTradingLevel: null }),
    optionMarket: null,
    freshness: { lastEventAt: NOW - 40, ageMs: 40, stale: false, reason: null },
    allowedUnderlyings: ['XAU_USD', 'NAS100_USD'],
    worker: { config: workerConfig({ id: 'oanda-gold', name: 'GOLD', symbol: 'XAU_USD', instrument: 'CFD', allowShort: true, limits: { maxTradesPerDay: 5, maxContracts: 20, maxShares: 100, maxPositionNotional: 100_000, dailyLossLimit: 50, dailyGoal: 100, riskPerTrade: 10 } }), autotradeEnabled: true, dayPnl: 0, realizedToday: 0 },
    ...over,
  });
}

const blockedBy = (d: ReturnType<typeof evaluateRisk>) => d.blockedBy?.id ?? null;
const failed = (d: ReturnType<typeof evaluateRisk>) => d.checks.filter((c) => !c.passed).map((c) => c.id);

describe('RiskEngine — CFD entries', () => {
  it('approves a well-formed gold entry, with margin and risk-at-stop checked and no PDT rule', () => {
    const d = evaluateRisk(goldEntry(), goldState());
    expect(failed(d)).toEqual([]);
    expect(d.approved).toBe(true);
    const ids = d.checks.map((c) => c.id);
    for (const id of ['qty', 'instrument', 'stop_side', 'order_notional', 'position_notional', 'margin', 'risk_per_trade', 'market_open', 'data_fresh']) expect(ids).toContain(id);
    expect(ids).not.toContain('pdt');
    expect(ids).not.toContain('buying_power');
    expect(d.checks.find((c) => c.id === 'risk_per_trade')!.detail).toContain('$7.20'); // 3 × (2650.5 − 2648.1) × 1 — measured from the order's own limit, the worst fill
  });

  it('automated CFD entries must carry a broker-side stop', () => {
    const d = evaluateRisk(goldEntry({ protectiveStop: null }), goldState());
    expect(blockedBy(d)).toBe('stop_present');
  });

  it('refuses a stop on the wrong side of the price', () => {
    expect(blockedBy(evaluateRisk(goldEntry({ protectiveStop: 2652 }), goldState()))).toBe('stop_side'); // above a long
    expect(blockedBy(evaluateRisk(goldEntry({ side: 'sell', limitPrice: 2650.0, referencePrice: 2650.1, protectiveStop: 2648 }), goldState()))).toBe('stop_side'); // below a short
  });

  it('caps the money at risk if the stop is hit', () => {
    // Roomy notional and margin limits, so only the risk-at-stop rule is in play.
    const roomy = (over: Partial<RiskState> = {}) => goldState({ limits: { ...GOLD_LIMITS, maxPositionNotional: 1e6, maxOrderNotional: 1e6 }, cfd: { ...goldSpec, marginAvailable: 1e6 }, ...over });
    const d = evaluateRisk(goldEntry({ qty: 9, protectiveStop: 2648.0 }), roomy()); // 9 × 2.5 = $22.50 > $20
    expect(failed(d)).toEqual(['risk_per_trade']);
    expect(d.checks.find((c) => c.id === 'risk_per_trade')!.detail).toContain('$22.50');
    expect(evaluateRisk(goldEntry({ qty: 8, protectiveStop: 2648.0 }), roomy()).approved).toBe(true); // exactly $20.00 is allowed
  });

  it('checks the margin the broker will lock up, with a buffer', () => {
    // 9 units ≈ $23.9k notional × 5% × 1.1 ≈ $1,312; only $1,000 available.
    const d = evaluateRisk(goldEntry({ qty: 9, protectiveStop: 2649.9 }), goldState({ cfd: { ...goldSpec, marginAvailable: 1_000 } }));
    expect(failed(d)).toContain('margin');
    expect(failed(d)).toContain('position_notional'); // also over the $10k cap: both are reported
    expect(blockedBy(evaluateRisk(goldEntry({ qty: 1, protectiveStop: 2649.9 }), goldState({ cfd: { ...goldSpec, marginAvailable: null } })))).toBe('margin'); // unknown margin fails closed
    expect(blockedBy(evaluateRisk(goldEntry({ qty: 1, protectiveStop: 2649.9 }), goldState({ cfd: { ...goldSpec, marginRate: null } })))).toBe('margin');
  });

  it('enforces the notional caps in account currency using the live conversion rate', () => {
    // EUR/JPY: 4,000 units × 162 JPY × 0.00667 USD/JPY = ~$4.3k
    const eurjpy = (qty: number) => goldEntry({ symbol: 'EUR_JPY', underlying: 'EUR_JPY', qty, limitPrice: 162.05, referencePrice: 162.02, protectiveStop: 161.5, workerId: 'oanda-eurjpy', multiplier: 0.00667 });
    const spec: CfdMarket = { ...goldSpec, homeFactor: 0.00667, maxOrderUnits: 100_000_000, marginRate: 0.05 };
    const st = goldState({ cfd: spec, allowedUnderlyings: ['EUR_JPY'], worker: { ...goldState().worker!, config: workerConfig({ id: 'oanda-eurjpy', symbol: 'EUR_JPY', instrument: 'CFD', allowShort: true, limits: { maxTradesPerDay: 5, maxContracts: 20, maxShares: 100, maxPositionNotional: 100_000, dailyLossLimit: 50, dailyGoal: 100, riskPerTrade: 10 } }) } });
    expect(evaluateRisk(eurjpy(4_000), st).approved).toBe(true);
    expect(failed(evaluateRisk(eurjpy(12_000), st))).toContain('order_notional'); // ~$13k
    // No conversion rate → the order cannot even be valued → refused (never "assume 1").
    const noRate = evaluateRisk(eurjpy(4_000), { ...st, cfd: { ...spec, homeFactor: null } });
    expect(failed(noRate)).toContain('order_notional');
    expect(noRate.checks.find((c) => c.id === 'order_notional')!.detail).toContain('conversion');
  });

  it('enforces unit precision, minimum and maximum size from the broker\'s own instrument rules', () => {
    const nas: CfdMarket = { ...goldSpec, unitsPrecision: 1, minUnits: 0.1, maxOrderUnits: 2_000 };
    const base = goldEntry({ symbol: 'NAS100_USD', underlying: 'NAS100_USD', limitPrice: 20_501, referencePrice: 20_500.5, protectiveStop: 20_495, qty: 0.2 });
    const st = goldState({ cfd: nas });
    expect(evaluateRisk(base, st).approved).toBe(true);
    expect(failed(evaluateRisk({ ...base, qty: 0.25 }, st))).toContain('qty'); // finer than the step
    expect(failed(evaluateRisk({ ...base, qty: 0.05 }, st))).toContain('qty'); // below the minimum
    expect(failed(evaluateRisk({ ...base, qty: 2_500 }, st))).toContain('qty'); // above the maximum
    expect(failed(evaluateRisk({ ...base, qty: 0.3 }, st))).not.toContain('qty'); // 0.1 + 0.2 float noise is not a violation
    expect(failed(evaluateRisk(base, goldState({ cfd: { ...nas, unitsPrecision: null } })))).toContain('qty'); // unknown rules fail closed
  });

  it('refuses an instrument the broker does not offer this account', () => {
    expect(failed(evaluateRisk(goldEntry(), goldState({ cfd: { ...goldSpec, listed: false } })))).toContain('instrument');
  });

  it('refuses to open when the instrument is not tradeable or has no live price, but lets a person close', () => {
    expect(blockedBy(evaluateRisk(goldEntry(), goldState({ cfd: { ...goldSpec, tradeable: false } })))).toBe('market_open');
    expect(blockedBy(evaluateRisk(goldEntry(), goldState({ cfd: { ...goldSpec, tradeable: null } })))).toBe('market_open');
    expect(blockedBy(evaluateRisk(goldEntry(), goldState({ market: { isOpen: false, minutesToClose: null, label: 'CLOSED' } })))).toBe('market_open');
  });

  it('blocks shorts when the worker is not allowed to short', () => {
    const short = goldEntry({ side: 'sell', limitPrice: 2650.0, referencePrice: 2650.1, protectiveStop: 2652.2 });
    expect(evaluateRisk(short, goldState()).approved).toBe(true);
    const st = goldState();
    const noShort = { ...st, worker: { ...st.worker!, config: { ...st.worker!.config, allowShort: false } } };
    expect(failed(evaluateRisk(short, noShort))).toContain('short');
  });

  it('keeps every shared safety rule: kill switch, breakers, daily loss, reconciliation, one position per instrument', () => {
    expect(blockedBy(evaluateRisk(goldEntry(), goldState({ controls: { autotrading: true, entriesPaused: false, killSwitch: true } })))).toBe('kill_switch');
    expect(blockedBy(evaluateRisk(goldEntry(), goldState({ breakers: [{ id: 'API_ERRORS', label: 'Excessive API errors', exitSafe: false }] })))).toBe('circuit_breakers');
    expect(failed(evaluateRisk(goldEntry(), goldState({ accountDayPnl: -600 })))).toContain('daily_loss');
    expect(failed(evaluateRisk(goldEntry(), goldState({ accountDayPnl: null })))).toContain('daily_loss'); // unknown day P&L fails closed
    expect(failed(evaluateRisk(goldEntry(), goldState({ reconciliation: { ok: false, detail: 'mismatch' } })))).toContain('reconciliation');
    expect(failed(evaluateRisk(goldEntry(), goldState({ brokerPositions: [brokerPosition({ symbol: 'XAU_USD', assetClass: 'cfd', qty: 1, marketValue: 2650 })] })))).toContain('duplicate_position');
    expect(failed(evaluateRisk(goldEntry({ symbol: 'DOGE_USD', underlying: 'DOGE_USD' }), goldState()))).toContain('symbol'); // not a configured instrument
    expect(failed(evaluateRisk(goldEntry({ signalBarCloseAt: NOW - 120_000 }), goldState({ maxSignalAgeMs: 30_000 })))).toContain('signal_fresh');
    expect(failed(evaluateRisk(goldEntry(), goldState({ freshness: { lastEventAt: NOW - 9_000, ageMs: 9_000, stale: true, reason: 'last event 9.0s ago' } })))).toContain('data_fresh');
  });

  it('uses the account currency in its messages', () => {
    const d = evaluateRisk(goldEntry({ qty: 9, protectiveStop: 2648.0 }), goldState({ currency: 'GBP', limits: { ...GOLD_LIMITS, maxPositionNotional: 1e6, maxOrderNotional: 1e6 }, cfd: { ...goldSpec, marginAvailable: 1e6 } }));
    expect(d.checks.find((c) => c.id === 'risk_per_trade')!.detail).toContain('£22.50');
  });
});

describe('RiskEngine — CFD exits', () => {
  const exit = (over: Partial<ProposedOrder> = {}): ProposedOrder => goldEntry({ purpose: 'EXIT', side: 'sell', signalId: null, signalBarCloseAt: null, protectiveStop: null, type: 'market', limitPrice: null, ...over });
  const held = brokerPosition({ symbol: 'XAU_USD', assetClass: 'cfd', side: 'long', qty: 3, qtyAvailable: null, avgEntryPrice: 2649, marketValue: 7950, currentPrice: 2650 });

  it('allows reducing a position without a stop, and fractional-safe close quantities', () => {
    const st = goldState({ brokerPositions: [held] });
    expect(evaluateRisk(exit({ qty: 3 }), st).approved).toBe(true);
    expect(evaluateRisk(exit({ qty: 2 }), st).approved).toBe(true);
    expect(failed(evaluateRisk(exit({ qty: 4 }), st))).toContain('close_qty'); // more than is held
    expect(failed(evaluateRisk(exit({ side: 'buy', qty: 3 }), st))).toContain('reduces_position'); // that would add to the long
    expect(failed(evaluateRisk(exit({ qty: 3 }), goldState()))).toContain('reduces_position'); // nothing to close
  });

  it('a manual close or flatten works even before a live price is seen, but never an automated one', () => {
    const st = goldState({ brokerPositions: [held], cfd: { ...goldSpec, tradeable: null } });
    expect(evaluateRisk(exit({ purpose: 'MANUAL_CLOSE', source: 'MANUAL', qty: 3 }), st).approved).toBe(true);
    expect(evaluateRisk(exit({ purpose: 'FLATTEN', source: 'FLATTEN', qty: 3 }), st).approved).toBe(true);
    expect(failed(evaluateRisk(exit({ qty: 3 }), st))).toContain('market_open');
  });

  it('a halted instrument blocks even a close (OANDA would cancel it)', () => {
    const st = goldState({ brokerPositions: [held], cfd: { ...goldSpec, tradeable: false } });
    expect(failed(evaluateRisk(exit({ purpose: 'MANUAL_CLOSE', source: 'MANUAL', qty: 3 }), st))).toContain('market_open');
  });
});

describe('precision helper', () => {
  it('accepts exact multiples of the step despite binary floating point', () => {
    expect(fitsPrecision(0.3, 1)).toBe(true);
    expect(fitsPrecision(0.1 + 0.2, 1)).toBe(true);
    expect(fitsPrecision(1234.5, 1)).toBe(true);
    expect(fitsPrecision(0.35, 1)).toBe(false);
    expect(fitsPrecision(3, 0)).toBe(true);
    expect(fitsPrecision(3.5, 0)).toBe(false);
  });
});

describe('validateOrder — CFD orders', () => {
  const order = (over: Partial<OrderRecord> = {}): OrderRecord => ({
    id: 'o1',
    venue: 'oanda',
    env: 'paper',
    clientOrderId: 'sc-P-entry-x',
    brokerOrderId: null,
    workerId: 'oanda-gold',
    source: 'WORKER',
    purpose: 'ENTRY',
    signalId: 's',
    tradeId: null,
    symbol: 'XAU_USD',
    underlying: 'XAU_USD',
    assetClass: 'cfd',
    side: 'buy',
    positionIntent: 'buy_to_open',
    type: 'limit',
    timeInForce: 'fok',
    qty: 3,
    limitPrice: 2650.5,
    stopPrice: null,
    state: 'VALIDATING',
    brokerStatus: null,
    filledQty: 0,
    filledAvgPrice: null,
    rejectedBy: null,
    rejectReason: null,
    errorMessage: null,
    risk: null,
    meta: { multiplier: 1, protectiveStop: { price: 2648.1 } },
    createdAt: NOW,
    submittedAt: null,
    updatedAt: NOW,
    filledAt: null,
    ...over,
  });

  it('accepts decimal units and underscored instrument names', () => {
    expect(validateOrder(order())).toBeNull();
    expect(validateOrder(order({ symbol: 'NAS100_USD', qty: 0.2 }))).toBeNull();
    expect(validateOrder(order({ type: 'market', limitPrice: null, timeInForce: 'fok', meta: { multiplier: 1 } }))).toBeNull();
  });

  it('still insists on whole numbers and plain tickers for shares and options', () => {
    expect(validateOrder(order({ assetClass: 'us_equity', symbol: 'QQQ', qty: 1.5, timeInForce: 'day', positionIntent: null, meta: { multiplier: 1 } }))).toMatch(/whole number/);
    expect(validateOrder(order({ assetClass: 'us_equity', symbol: 'XAU_USD', qty: 1, timeInForce: 'day', positionIntent: null, meta: { multiplier: 1 } }))).toMatch(/invalid symbol/);
  });

  it('rejects malformed CFD orders', () => {
    expect(validateOrder(order({ qty: 0 }))).toMatch(/positive/);
    expect(validateOrder(order({ qty: -1 }))).toMatch(/positive/);
    expect(validateOrder(order({ qty: Number.NaN }))).toMatch(/positive/);
    expect(validateOrder(order({ qty: 0.0000001 }))).toMatch(/decimals/);
    expect(validateOrder(order({ symbol: 'XAUUSD' }))).toMatch(/invalid symbol/);
    expect(validateOrder(order({ positionIntent: null }))).toMatch(/open or close/);
    expect(validateOrder(order({ type: 'stop', stopPrice: 1, limitPrice: null }))).toMatch(/not supported/);
    expect(validateOrder(order({ type: 'market', limitPrice: null, timeInForce: 'day' }))).toMatch(/cannot be DAY/);
    expect(validateOrder(order({ limitPrice: null }))).toMatch(/limit price required/);
  });

  it('only lets a stop loss ride on an order that opens a position, on the right side', () => {
    expect(validateOrder(order({ positionIntent: 'sell_to_close', side: 'sell' }))).toMatch(/only belongs on an order that opens/);
    expect(validateOrder(order({ meta: { multiplier: 1, protectiveStop: { price: 2651 } } }))).toMatch(/wrong side/); // long, stop above the price
    expect(validateOrder(order({ side: 'sell', positionIntent: 'sell_to_open', meta: { multiplier: 1, protectiveStop: { price: 2649 } } }))).toMatch(/wrong side/);
    expect(validateOrder(order({ meta: { multiplier: 1, protectiveStop: { price: -1 } } }))).toMatch(/positive/);
    expect(validateOrder(order({ assetClass: 'us_equity', symbol: 'QQQ', timeInForce: 'day', positionIntent: null }))).toMatch(/only supported for CFD/);
    expect(PROTECTIVE_SUFFIX).toBe('.sl');
  });
});

describe('PositionLedger — broker-reported P&L, fractional units, venue isolation', () => {
  let h: EngineHarness;
  beforeEach(async () => {
    h = await createEngineHarness();
  });
  afterEach(async () => {
    await h.audit.flush();
    await h.db.close();
  });

  const cfdOrder = (over: Partial<OrderRecord>): OrderRecord => ({
    id: `o-${Math.random()}`,
    venue: 'alpaca',
    env: 'paper',
    clientOrderId: `c-${Math.random()}`,
    brokerOrderId: null,
    workerId: 'qqq-og',
    source: 'WORKER',
    purpose: 'ENTRY',
    signalId: null,
    tradeId: null,
    symbol: 'NAS100_USD',
    underlying: 'NAS100_USD',
    assetClass: 'cfd',
    side: 'buy',
    positionIntent: 'buy_to_open',
    type: 'market',
    timeInForce: 'fok',
    qty: 0.3,
    limitPrice: null,
    stopPrice: null,
    state: 'FILLED',
    brokerStatus: 'filled',
    filledQty: 0.3,
    filledAvgPrice: 20_500,
    rejectedBy: null,
    rejectReason: null,
    errorMessage: null,
    risk: null,
    meta: { multiplier: 1, direction: 'CALL' },
    createdAt: NOW,
    submittedAt: NOW,
    updatedAt: NOW,
    filledAt: NOW,
    ...over,
  });

  it('books realized P&L from the broker\'s own figure (account currency, net of costs) and the entry commission with it', async () => {
    // Insert the order rows the trade events reference.
    const open = cfdOrder({ meta: { multiplier: 1, direction: 'CALL' } });
    const close = cfdOrder({ purpose: 'EXIT', side: 'sell', positionIntent: 'sell_to_close', meta: { multiplier: 1, direction: 'CALL', exitReason: 'TAKE_PROFIT' } });
    for (const o of [open, close]) await h.engine.repository.insert({ ...o, venue: 'alpaca' });
    const e1 = await h.db.tx((q) => h.ledger.applyFill(q, open, 0.3, 20_500, NOW, { dailyPnl: 0, brokerRealized: -0.25 })); // entry commission
    h.ledger.commit(e1);
    expect(h.ledger.get('NAS100_USD')!.qty).toBeCloseTo(0.3, 10);
    expect(e1.opened!.realizedPnl).toBe(-0.25);
    // Price moved +10 on 0.3 units = +3.00 raw; the broker nets costs and reports +2.60.
    const e2 = await h.db.tx((q) => h.ledger.applyFill(q, close, 0.3, 20_510, NOW + 60_000, { dailyPnl: 0, brokerRealized: 2.6 }));
    h.ledger.commit(e2);
    expect(e2.realized).toBe(2.6);
    expect(e2.closed!.status).toBe('CLOSED');
    expect(e2.closed!.realizedPnl).toBeCloseTo(2.35, 10); // −0.25 entry cost + 2.60
    expect(h.ledger.get('NAS100_USD')).toBeNull();
    const { rows } = await h.db.query<{ kind: string; realized_pnl: number | null }>('SELECT kind, realized_pnl FROM trade_events ORDER BY id');
    expect(rows.map((r) => [r.kind, r.realized_pnl === null ? null : Number(r.realized_pnl)])).toEqual([['ENTRY_FILL', -0.25], ['EXIT_FILL', 2.6]]);
  });

  it('falls back to price arithmetic with the right multiplier when the broker gives no figure', async () => {
    const open = cfdOrder({ meta: { multiplier: 0.0066, direction: 'CALL' }, symbol: 'EUR_JPY', underlying: 'EUR_JPY', qty: 1000, filledQty: 1000 });
    const close = cfdOrder({ purpose: 'EXIT', side: 'sell', positionIntent: 'sell_to_close', symbol: 'EUR_JPY', underlying: 'EUR_JPY', qty: 1000, filledQty: 1000, meta: { multiplier: 0.0066, direction: 'CALL' } });
    for (const o of [open, close]) await h.engine.repository.insert(o);
    h.ledger.commit(await h.db.tx((q) => h.ledger.applyFill(q, open, 1000, 162, NOW, { dailyPnl: 0 })));
    const e = await h.db.tx((q) => h.ledger.applyFill(q, close, 1000, 162.5, NOW + 1, { dailyPnl: 0 }));
    expect(e.realized).toBeCloseTo(0.5 * 1000 * 0.0066, 10); // 0.5 JPY × 1000 units × 0.0066 USD/JPY
  });

  it('keeps fractional units exact in a partial close and leaves the remainder open', async () => {
    const open = cfdOrder({ qty: 0.5, filledQty: 0.5 });
    const part = cfdOrder({ purpose: 'EXIT', side: 'sell', positionIntent: 'sell_to_close', qty: 0.2, filledQty: 0.2 });
    for (const o of [open, part]) await h.engine.repository.insert(o);
    h.ledger.commit(await h.db.tx((q) => h.ledger.applyFill(q, open, 0.5, 20_500, NOW, { dailyPnl: 0 })));
    const e = await h.db.tx((q) => h.ledger.applyFill(q, part, 0.2, 20_510, NOW + 1, { dailyPnl: 0, brokerRealized: 1.9 }));
    h.ledger.commit(e);
    expect(e.closed).toBeNull();
    expect(h.ledger.get('NAS100_USD')!.qty).toBeCloseTo(0.3, 10);
    expect(e.realized).toBe(1.9);
  });
});
