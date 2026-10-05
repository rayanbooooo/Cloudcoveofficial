import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JournalTradeView, OrderPreview, OrderView, Snapshot, WorkerView } from '@scalp-city/shared';
import { START_PRICES, startOandaE2E, type OandaE2E } from './support/oandaHarness.js';

/**
 * OANDA PRACTICE end-to-end flow, automated.
 *
 * The production OANDA adapters (REST, the transaction stream, the pricing
 * stream and official M1 candles) run unmodified against a protocol-level
 * fake of the v20 API, driven on a virtual clock through a scripted market:
 *
 *   history: gold ranges near 2650 for the opening range, slides to 2647, then sits
 *   live:    a high-tick-volume rally back through VWAP, EMA50 and the OR high
 *
 * Expected: the GOLD worker charges to LONG, passes risk, sends a fill-or-kill
 * order with a stop loss that OANDA holds itself, OANDA fills it, the rally
 * reaches the ATR target, the exit fills reduce-only, OANDA cancels the linked
 * stop, and realized P&L in account currency flows to the worker, vault,
 * journal and audit log. A second trade is stopped out by OANDA's own stop
 * while the exit logic is not involved.
 */

const GOLD = 'XAU_USD';
const BASE = START_PRICES[GOLD]!;

// 09:30–09:44 range near 2650, slide to 2647 by 10:30, flat after.
function historyPath(symbol: string, i: number, base: number): number {
  if (symbol !== GOLD) return base * (1 + Math.sin(i / 5) * 0.00005);
  if (i < 15) return BASE + 0.6 * Math.sin(i);
  if (i < 60) return BASE - ((i - 15) * 3) / 45;
  return BASE - 3 + 0.05 * Math.sin(i);
}

let e: OandaE2E;

beforeAll(async () => {
  e = await startOandaE2E({ fake: { historyPath, historyVolume: () => 100 } });
}, 60_000);

afterAll(async () => {
  await e?.close();
});

const snapshot = async () => (await e.api<Snapshot>('GET', '/api/snapshot')).body;
const worker = async (id: string) => (await snapshot()).workers.find((w) => w.config.id === id)!;

/**
 * Print price updates through the current minute, ending at `price`, then move
 * the clock past the minute's end plus OANDA's candle delay, and wait until the
 * GOLD worker has evaluated exactly that official candle.
 */
async function minute(price: number, ticks = 300): Promise<void> {
  const steps = 5;
  for (let k = 1; k <= steps; k++) {
    e.fake.tick(GOLD, price - 0.4 + (0.4 * k) / steps, ticks / steps);
    for (const [sym, base] of Object.entries(START_PRICES)) if (sym !== GOLD) e.fake.tick(sym, base, 2);
  }
  const now = e.clock.now();
  const minuteStart = Math.floor(now / 60_000) * 60_000;
  const nextMinute = minuteStart + 60_000;
  await e.advance(nextMinute + 2500 - now);
  await e.waitFor(async () => ((await worker('oanda-gold')).signal.barTime ?? 0) >= minuteStart, `oanda-gold evaluated the ${new Date(minuteStart).toISOString()} candle`);
}

describe('OANDA practice end-to-end: prices → signal → risk → order → fill → broker stop → exit → P&L', () => {
  it('starts, authenticates, connects both OANDA streams, reconciles and reaches READY', async () => {
    const s = await e.waitFor(async () => {
      const snap = await snapshot();
      return snap.system.phase === 'READY' ? snap : null;
    }, 'system READY');
    expect(s.system.env).toBe('paper');
    expect(s.system.venue).toBe('oanda');
    expect(s.system.broker.name).toBe('OANDA');
    expect(s.system.broker.status).toBe('CONNECTED');
    expect(s.system.broker.accountMasked).toBe('••••5678-001');
    expect(s.system.broker.tradeStream.state).toBe('CONNECTED');
    expect(s.system.marketData.stock.state).toBe('CONNECTED');
    expect(s.system.marketData.stockFeedLabel).toBe('LIVE · OANDA PRICES');
    expect(s.system.marketData.tickVolume).toBe(true);
    expect(s.system.marketData.priceBasis).toBe('mid');
    expect(s.system.reconciliation.status).toBe('RECONCILED');
    expect(s.system.endpoints.nonStandard).toBe(true); // the fake is flagged, never presented as OANDA
    expect(s.system.market.isOpen).toBe(true);
    // Account: broker numbers only, account currency, day P&L derived (not guessed).
    expect(s.account.broker).toBe('OANDA');
    expect(s.account.currency).toBe('USD');
    expect(s.account.equity).toBe(100_000);
    expect(s.account.marginAvailable).toBe(100_000);
    expect(s.account.dayPnl).toBe(0);
    expect(s.account.dayPnlNote).toContain('OANDA transactions');
    // The five markets, traded as the instrument itself.
    expect(s.workers.map((w) => w.config.symbol)).toEqual(['XAU_USD', 'NAS100_USD', 'GBP_USD', 'EUR_JPY', 'US30_USD']);
    expect(s.workers.every((w) => w.config.instrument === 'CFD' && w.config.allowShort)).toBe(true);
    expect(s.workers.map((w) => w.market?.displayName)).toEqual(['GOLD', 'NAS100', 'GBP/USD', 'EUR/JPY', 'US30']);
    expect(s.workers.every((w) => w.market?.listed && w.market.homeFactor !== null && w.market.marginRate !== null)).toBe(true);
    expect(Object.keys(s.quotes).sort()).toEqual(['EUR_JPY', 'GBP_USD', 'NAS100_USD', 'US30_USD', 'XAU_USD']);
    expect(s.system.controls.autotrading).toBe(false);
    expect(s.workers.every((w) => !w.autotradeEnabled)).toBe(true);
  });

  it('loads real prices with indicators from OANDA candles', async () => {
    const s = await snapshot();
    for (const sym of Object.keys(START_PRICES)) {
      const q = s.quotes[sym]!;
      expect(q.last).not.toBeNull();
      expect(q.bid).not.toBeNull();
      expect(q.ask).not.toBeNull();
      expect(q.ask!).toBeGreaterThan(q.bid!);
      expect(q.vwap).not.toBeNull();
      expect(q.ema50).not.toBeNull();
      expect(q.atr).not.toBeNull();
      expect(q.tradeable).toBe(true);
    }
    expect(s.quotes[GOLD]!.last!).toBeLessThan(s.quotes[GOLD]!.vwap!); // the slide left price under VWAP
    // Sizing is explained before any trade: risk-based, in account currency, rounded to the unit step.
    const gold = (await worker('oanda-gold')).market!;
    expect(gold.plannedUnits).toBeGreaterThanOrEqual(1);
    expect(gold.plannedStop).toBeGreaterThan(0);
    expect(gold.currency).toBe('USD');
  });

  it('enables autotrading and the GOLD worker (with confirmation)', async () => {
    expect((await e.api('POST', '/api/workers/oanda-gold/enabled', { enabled: true })).status).toBe(428);
    expect((await e.api('POST', '/api/controls/autotrading', { enabled: true })).status).toBe(200);
    const r = await e.api<WorkerView>('POST', '/api/workers/oanda-gold/enabled', { enabled: true, confirmed: true });
    expect(r.status).toBe(200);
    expect(r.body.autotradeEnabled).toBe(true);
  });

  it('charges a LONG setup from a real rally and enters only after risk approval and an OANDA fill', async () => {
    await minute(BASE - 2.4); // 11:00 — still under VWAP
    await minute(BASE - 0.9); // 11:01 — reclaims VWAP
    await minute(BASE + 0.6); // 11:02
    await minute(BASE + 2.1); // 11:03 — breaks the opening range
    await minute(BASE + 3.6); // 11:04 — every condition confirmed → READY

    const filled = await e.waitFor(async () => {
      const w = await worker('oanda-gold');
      return w.position ? w : null;
    }, 'entry filled', 15_000);
    expect(filled.position!.assetClass).toBe('cfd');
    expect(filled.position!.direction).toBe('CALL');
    expect(filled.position!.qty).toBeGreaterThan(0);
    expect(filled.signal.direction).toBe('CALL');

    const s = await e.waitFor(async () => {
      const snap = await snapshot();
      return snap.positions.length > 0 ? snap : null;
    }, 'broker position listed');
    const entry = s.orders.find((o) => o.workerId === 'oanda-gold' && o.purpose === 'ENTRY')!;
    expect(entry.state).toBe('FILLED');
    expect(entry.assetClass).toBe('cfd');
    expect(entry.side).toBe('buy');
    expect(entry.positionIntent).toBe('buy_to_open');
    expect(entry.timeInForce).toBe('fok'); // fills now at the approved price or not at all
    expect(entry.filledQty).toBe(entry.qty);
    expect(entry.brokerOrderId).not.toBeNull();
    expect(entry.risk!.approved).toBe(true);
    const ids = entry.risk!.checks.map((c) => c.id);
    for (const id of ['margin', 'risk_per_trade', 'stop_side', 'instrument', 'market_open', 'data_fresh', 'broker', 'daily_loss']) expect(ids).toContain(id);
    expect(ids).not.toContain('pdt'); // the pattern-day-trader rule is for US securities, not FX/CFDs

    // What was sent to OANDA: signed units, a worst-price bound, FOK, OPEN_ONLY, and a stop OANDA holds.
    const sent = e.fake.submitBodies.find((b) => b.clientExtensions?.id === entry.clientOrderId)!;
    expect(sent.type).toBe('MARKET');
    expect(sent.timeInForce).toBe('FOK');
    expect(sent.positionFill).toBe('OPEN_ONLY');
    expect(Number(sent.units)).toBe(entry.qty);
    expect(sent.priceBound).toBeDefined();
    expect(sent.stopLossOnFill.price).toBeDefined();
    expect(sent.stopLossOnFill.clientExtensions.id).toBe(`${entry.clientOrderId}.sl`);

    // The broker really holds the position and the stop; the app mirrors both.
    expect(e.fake.netUnits(GOLD)).toBe(entry.qty);
    expect(s.positions).toHaveLength(1);
    expect(s.positions[0]!.workerId).toBe('oanda-gold');
    expect(s.positions[0]!.assetClass).toBe('cfd');
    const stop = await e.waitFor(async () => (await snapshot()).orders.find((o) => o.purpose === 'PROTECTIVE_STOP'), 'broker stop adopted');
    expect(stop.state).toBe('ACCEPTED');
    expect(stop.side).toBe('sell');
    expect(stop.stopPrice).toBe(Number(sent.stopLossOnFill.price));
    expect(stop.workerId).toBe('oanda-gold');
    // Risk at the stop was approved and recorded.
    const trades = (await e.api<JournalTradeView[]>('GET', '/api/journal')).body;
    expect(trades).toHaveLength(1);
    expect(trades[0]!.status).toBe('OPEN');
    expect(trades[0]!.assetClass).toBe('cfd');
  });

  it('manages the position and exits on take-profit, reduce-only, after an OANDA fill', async () => {
    const before = await snapshot();
    const planned = before.workers.find((w) => w.config.id === 'oanda-gold')!;
    expect(planned.position).not.toBeNull();
    const entryPrice = planned.position!.avgEntryPrice;
    // Rally continues well past the ATR target.
    await minute(entryPrice + 6, 400);
    const closed = await e.waitFor(async () => {
      const snap = await snapshot();
      return snap.positions.length === 0 && snap.orders.some((o) => o.purpose === 'EXIT' && o.state === 'FILLED') ? snap : null;
    }, 'exit filled and position closed', 20_000);

    const exit = closed.orders.find((o) => o.purpose === 'EXIT')!;
    expect(exit.side).toBe('sell');
    expect(exit.positionIntent).toBe('sell_to_close');
    expect(exit.type).toBe('market');
    expect(exit.timeInForce).toBe('fok');
    const sentExit = e.fake.submitBodies.find((b) => b.clientExtensions?.id === exit.clientOrderId)!;
    expect(sentExit.positionFill).toBe('REDUCE_ONLY'); // OANDA itself guarantees an exit can never open a short
    expect(e.fake.netUnits(GOLD)).toBe(0);

    // OANDA removed the linked stop when the trade closed; the app saw it and says so.
    const stop = await e.waitFor(async () => (await snapshot()).orders.find((o) => o.purpose === 'PROTECTIVE_STOP' && o.state === 'CANCELED'), 'linked stop canceled');
    expect(stop.state).toBe('CANCELED');

    // Realized P&L is OANDA's own number, in account currency.
    const trades = (await e.api<JournalTradeView[]>('GET', '/api/journal')).body;
    expect(trades).toHaveLength(1);
    const t = trades[0]!;
    expect(t.status).toBe('CLOSED');
    expect(t.exitReason).toBe('TAKE_PROFIT');
    expect(t.realizedPnl!).toBeGreaterThan(0);
    expect(e.fake.balance - 100_000).toBeCloseTo(t.realizedPnl!, 4);
    const w = await worker('oanda-gold');
    expect(w.stats.realizedToday).toBeCloseTo(t.realizedPnl!, 4);
    expect(closed.account.dayPnl!).toBeCloseTo(t.realizedPnl!, 2);
    expect(w.position).toBeNull();
  });
});

describe('OANDA safety behaviors', () => {
  it('keeps a position protected by the broker-side stop when it is hit, and books the loss from broker numbers', async () => {
    await e.api('POST', '/api/controls/pause', { paused: true }); // no new automated entries while we set up
    const balanceBefore = e.fake.balance;
    const dayPnlBefore = (await snapshot()).account.dayPnl!;
    expect(dayPnlBefore).toBeCloseTo(balanceBefore - 100_000, 2); // the earlier take-profit trade
    // Open by hand (manual ticket → same risk engine) with a stop 4.0 below.
    const ask = e.fake.prices.get(GOLD)!.ask;
    const preview = await e.api<OrderPreview>('POST', '/api/orders/preview', { symbol: GOLD, assetClass: 'cfd', side: 'buy', qty: 2, type: 'market', intent: 'open', stopLoss: Math.round((ask - 4) * 1000) / 1000 });
    expect(preview.status).toBe(200);
    expect(preview.body.risk.approved).toBe(true);
    expect(preview.body.currency).toBe('USD');
    expect(preview.body.riskAtStop).toBeGreaterThan(0);
    expect(preview.body.estimatedMargin).toBeGreaterThan(0);
    const placed = await e.api<OrderView>('POST', '/api/orders', { previewToken: preview.body.previewToken, confirmed: true });
    expect(placed.status).toBe(200);
    await e.waitFor(async () => (await snapshot()).positions.find((p) => p.symbol === GOLD && p.qty === 2), 'manual position open');
    await e.waitFor(async () => (await snapshot()).orders.find((o) => o.purpose === 'PROTECTIVE_STOP' && o.state === 'ACCEPTED' && o.clientOrderId.startsWith(placed.body.clientOrderId)), 'its broker stop adopted');

    // Price falls through the stop. OANDA triggers its own stop; the exit logic isn't involved.
    const stopPrice = Number(e.fake.submitBodies.at(-1).stopLossOnFill.price);
    e.fake.tick(GOLD, stopPrice - 0.5);
    await e.advance(1000);
    const after = await e.waitFor(async () => {
      const s = await snapshot();
      return s.positions.find((p) => p.symbol === GOLD) ? null : s;
    }, 'position closed by the broker stop', 20_000);
    const stopOrder = after.orders.find((o) => o.purpose === 'PROTECTIVE_STOP' && o.state === 'FILLED')!;
    expect(stopOrder).toBeDefined();
    expect(stopOrder.side).toBe('sell');
    expect(e.fake.netUnits(GOLD)).toBe(0);
    const trade = (await e.api<JournalTradeView[]>('GET', '/api/journal')).body.find((t) => t.exitReason === 'BROKER_STOP')!;
    expect(trade).toBeDefined();
    expect(trade.realizedPnl!).toBeLessThan(0);
    expect(e.fake.balance - balanceBefore).toBeCloseTo(trade.realizedPnl!, 4);
    // The loss is on the day P&L the daily-loss limit reads: today's realized total, straight from OANDA's transactions.
    expect(after.account.dayPnl!).toBeCloseTo(e.fake.balance - 100_000, 2);
    expect(after.account.dayPnl!).toBeCloseTo(dayPnlBefore + trade.realizedPnl!, 2); // earlier profit + this loss
    await e.api('POST', '/api/controls/pause', { paused: false });
  });

  it('resolves an order whose response was lost by its client id instead of resubmitting', async () => {
    const posBefore = e.fake.netUnits('GBP_USD');
    const ask = e.fake.prices.get('GBP_USD')!.ask;
    const preview = await e.api<OrderPreview>('POST', '/api/orders/preview', { symbol: 'GBP_USD', assetClass: 'cfd', side: 'buy', qty: 1000, type: 'market', intent: 'open', stopLoss: Math.round((ask - 0.004) * 1e5) / 1e5 });
    expect(preview.body.risk.approved).toBe(true);
    const submitsBefore = e.fake.submitBodies.length;
    e.fake.dropNextSubmitResponse = true; // OANDA processes the order, but the connection dies before the reply
    const placed = await e.api<OrderView>('POST', '/api/orders', { previewToken: preview.body.previewToken, confirmed: true });
    expect(placed.status).toBe(200);
    // The position appears from OANDA's own records, exactly once.
    await e.waitFor(async () => (await snapshot()).positions.find((p) => p.symbol === 'GBP_USD'), 'resolved position', 20_000);
    expect(e.fake.netUnits('GBP_USD') - posBefore).toBe(1000);
    expect(e.fake.submitBodies.length).toBe(submitsBefore + 1); // never resubmitted
    const o = (await snapshot()).orders.find((x) => x.clientOrderId === placed.body.clientOrderId)!;
    expect(o.state).toBe('FILLED');
    expect(o.filledQty).toBe(1000);
  });

  it('flatten-all closes every OANDA position with reduce-only orders and verifies it at the broker', async () => {
    expect(e.fake.netUnits('GBP_USD')).toBe(1000);
    const r = await e.api('POST', '/api/controls/flatten', { confirmed: true });
    expect(r.status).toBe(200);
    await e.waitFor(async () => {
      const s = await snapshot();
      return s.system.flatten && !s.system.flatten.inProgress ? s : null;
    }, 'flatten finished', 60_000);
    expect(e.fake.netUnits('GBP_USD')).toBe(0);
    const s = await snapshot();
    expect(s.positions).toHaveLength(0);
    expect(s.system.flatten!.closed).toBe(s.system.flatten!.total);
    const closing = e.fake.submitBodies.filter((b) => b.instrument === 'GBP_USD').at(-1);
    expect(closing.positionFill).toBe('REDUCE_ONLY');
    await e.api('POST', '/api/controls/pause', { paused: false });
  });

  it('refuses an order OANDA would reject for margin and reports the real reason', async () => {
    e.fake.cancelNext = 'INSUFFICIENT_MARGIN';
    const ask = e.fake.prices.get('EUR_JPY')!.ask;
    const preview = await e.api<OrderPreview>('POST', '/api/orders/preview', { symbol: 'EUR_JPY', assetClass: 'cfd', side: 'buy', qty: 100, type: 'market', intent: 'open', stopLoss: Math.round((ask - 0.5) * 1000) / 1000 });
    expect(preview.body.risk.approved).toBe(true);
    const placed = await e.api<OrderView>('POST', '/api/orders', { previewToken: preview.body.previewToken, confirmed: true });
    expect(placed.status).toBe(200);
    const o = await e.waitFor(async () => (await snapshot()).orders.find((x) => x.clientOrderId === placed.body.clientOrderId && x.state === 'REJECTED'), 'order rejected by OANDA');
    expect(o.rejectedBy).toBe('BROKER');
    expect(o.rejectReason).toBe('INSUFFICIENT_MARGIN');
    expect(e.fake.netUnits('EUR_JPY')).toBe(0);
    expect((await snapshot()).positions.find((p) => p.symbol === 'EUR_JPY')).toBeUndefined();
  });

  it('blocks orders when OANDA says the instrument is not tradeable', async () => {
    e.fake.setTradeable('US30_USD', false);
    await e.advance(1500);
    await e.waitFor(async () => (await snapshot()).quotes.US30_USD!.tradeable === false, 'halt flag seen in the quote');
    const ask = e.fake.prices.get('US30_USD')!.ask;
    const preview = await e.api<OrderPreview>('POST', '/api/orders/preview', { symbol: 'US30_USD', assetClass: 'cfd', side: 'buy', qty: 0.1, type: 'market', intent: 'open', stopLoss: ask - 30 });
    expect(preview.body.risk.approved).toBe(false);
    expect(preview.body.risk.blockedBy!.id).toBe('market_open');
    expect(preview.body.risk.blockedBy!.detail).toContain('not tradeable');
    e.fake.setTradeable('US30_USD', true);
  });

  it('stops everything when a position appears at OANDA that Scalp City did not open', async () => {
    // Someone opens a trade in OANDA's own app on a watched instrument.
    const sub = await fetch(`${e.fake.url}/v3/accounts/101-004-12345678-001/orders`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-oanda-token-0123456789abcdef', 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: { type: 'MARKET', instrument: 'NAS100_USD', units: '0.2', timeInForce: 'FOK', positionFill: 'DEFAULT', clientExtensions: { id: 'someone-else', tag: 'phone-app' } } }),
    });
    expect(sub.status).toBe(201);
    // A difference must survive two reconciliation passes before trading halts, so let virtual time pass between them.
    const s = await e.waitFor(async () => {
      await e.advance(2000);
      const snap = await snapshot();
      return snap.system.reconciliation.status === 'MISMATCH' ? snap : null;
    }, 'reconciliation mismatch', 20_000);
    expect(s.system.reconciliation.mismatches.some((m) => m.symbol === 'NAS100_USD' && m.kind === 'UNEXPECTED_POSITION')).toBe(true);
    expect(s.system.trading.entriesAllowed).toBe(false);
    expect(s.system.breakers.some((b) => b.tripped)).toBe(true);
    // Autonomous trading cannot continue past an account mismatch: every worker is HALTED.
    const nas = s.workers.find((w) => w.config.id === 'oanda-nas100')!;
    expect(nas.towerState).toBe('HALTED');
    // A new entry is refused by the risk engine too.
    const ask = e.fake.prices.get('GBP_USD')!.ask;
    const preview = await e.api<OrderPreview>('POST', '/api/orders/preview', { symbol: 'GBP_USD', assetClass: 'cfd', side: 'buy', qty: 1000, type: 'market', intent: 'open', stopLoss: ask - 0.004 });
    expect(preview.body.risk.approved).toBe(false);
  });
});
