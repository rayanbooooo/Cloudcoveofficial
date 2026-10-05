import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DateTime } from 'luxon';
import type { Clock } from '../../src/core/clock.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Protocol-level fake of the OANDA v20 REST + streaming API, for automated
 * tests and the local UI harness ONLY. It speaks the wire formats the real
 * adapters expect — Bearer auth, decimal strings, RFC3339 nanosecond times,
 * newline-delimited JSON streams, order/transaction semantics (FOK + price
 * bound, OPEN_ONLY / REDUCE_ONLY, stopLossOnFill, linked-order cancels) —
 * so the production OANDA adapter runs unmodified against it. Everything it
 * produces is synthetic; LIVE endpoints are pinned to OANDA in config and
 * can never point here.
 */

const NY = 'America/New_York';

interface Spec {
  type: string;
  displayName: string;
  pipLocation: number;
  displayPrecision: number;
  tradeUnitsPrecision: number;
  minimumTradeSize: number;
  maximumOrderUnits: number;
  marginRate: number;
  spread: number;
}

export const FAKE_SPECS: Record<string, Spec> = {
  XAU_USD: { type: 'METAL', displayName: 'Gold', pipLocation: -2, displayPrecision: 3, tradeUnitsPrecision: 0, minimumTradeSize: 1, maximumOrderUnits: 500, marginRate: 0.05, spread: 0.3 },
  NAS100_USD: { type: 'CFD', displayName: 'US Nas 100', pipLocation: 0, displayPrecision: 1, tradeUnitsPrecision: 1, minimumTradeSize: 0.1, maximumOrderUnits: 2000, marginRate: 0.05, spread: 1 },
  US30_USD: { type: 'CFD', displayName: 'US Wall St 30', pipLocation: 0, displayPrecision: 1, tradeUnitsPrecision: 1, minimumTradeSize: 0.1, maximumOrderUnits: 500, marginRate: 0.05, spread: 2 },
  GBP_USD: { type: 'CURRENCY', displayName: 'GBP/USD', pipLocation: -4, displayPrecision: 5, tradeUnitsPrecision: 0, minimumTradeSize: 1, maximumOrderUnits: 100_000_000, marginRate: 0.0333, spread: 0.00012 },
  EUR_JPY: { type: 'CURRENCY', displayName: 'EUR/JPY', pipLocation: -2, displayPrecision: 3, tradeUnitsPrecision: 0, minimumTradeSize: 1, maximumOrderUnits: 100_000_000, marginRate: 0.05, spread: 0.02 },
  USD_JPY: { type: 'CURRENCY', displayName: 'USD/JPY', pipLocation: -2, displayPrecision: 3, tradeUnitsPrecision: 0, minimumTradeSize: 1, maximumOrderUnits: 100_000_000, marginRate: 0.0333, spread: 0.012 },
  EUR_USD: { type: 'CURRENCY', displayName: 'EUR/USD', pipLocation: -4, displayPrecision: 5, tradeUnitsPrecision: 0, minimumTradeSize: 1, maximumOrderUnits: 100_000_000, marginRate: 0.0333, spread: 0.0001 },
};

export interface FakeOandaOptions {
  clock: Clock;
  token: string;
  accountId: string;
  currency?: string;
  startingBalance?: number;
  /** Instrument → starting mid price. USD_JPY / EUR_USD are added for conversions when missing. */
  instruments: Record<string, number>;
  /** NY date of the session the fake serves history for. */
  sessionDate: string;
  sessionOpen?: string;
  /** Mid price for minute index i since the session open (history before "now"). */
  historyPath?: (symbol: string, minute: number, base: number) => number;
  historyVolume?: (symbol: string, minute: number) => number;
  heartbeatMs?: number;
}

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface Trade {
  id: string;
  instrument: string;
  price: number;
  openTime: number;
  initialUnits: number;
  currentUnits: number;
  realizedPL: number;
  stopLossOrderId: string | null;
}

interface Order {
  id: string;
  type: string;
  instrument: string;
  units: number | null;
  timeInForce: string;
  price: number | null;
  priceBound: number | null;
  positionFill: string;
  state: 'PENDING' | 'FILLED' | 'CANCELLED' | 'TRIGGERED';
  clientExtensions: any | null;
  createTime: number;
  tradeID: string | null;
  fillingTransactionID: string | null;
  filledTime: number | null;
  cancellingTransactionID: string | null;
  cancelledTime: number | null;
  stopLossOnFill: any | null;
}

const iso = (t: number) => {
  const d = new Date(t).toISOString(); // 2026-10-05T15:00:00.123Z
  return `${d.slice(0, 23)}000000Z`; // nanosecond-style, as OANDA sends
};
const s = (n: number, dp = 4) => n.toFixed(dp);

export class FakeOanda {
  url = '';
  balance: number;
  readonly currency: string;
  prices = new Map<string, { bid: number; ask: number; tradeable: boolean }>();
  candles = new Map<string, Map<number, Candle>>();
  trades = new Map<string, Trade>();
  orders = new Map<string, Order>();
  transactions: any[] = [];
  /** Next POST /orders response is dropped after the order is processed (connection reset). */
  dropNextSubmitResponse = false;
  /** Next POST /orders is refused outright (400) with this reject reason. */
  rejectNext: string | null = null;
  /** Next MARKET order is canceled at fill time with this reason (e.g. INSUFFICIENT_MARGIN). */
  cancelNext: string | null = null;
  submitBodies: any[] = [];
  private nextId = 1000;
  private server!: http.Server;
  private txClients = new Set<http.ServerResponse>();
  private priceClients = new Set<{ res: http.ServerResponse; instruments: Set<string> }>();
  private timers: NodeJS.Timeout[] = [];
  private autopilot: NodeJS.Timeout | null = null;
  readonly sessionOpenMs: number;

  constructor(private readonly o: FakeOandaOptions) {
    this.currency = o.currency ?? 'USD';
    this.balance = o.startingBalance ?? 100_000;
    const [oh, om] = (o.sessionOpen ?? '09:30').split(':').map(Number);
    this.sessionOpenMs = DateTime.fromISO(o.sessionDate, { zone: NY }).set({ hour: oh, minute: om }).toMillis();
    const all = { USD_JPY: 150, EUR_USD: 1.08, ...o.instruments };
    for (const [sym, mid] of Object.entries(all)) {
      if (!FAKE_SPECS[sym]) throw new Error(`FakeOanda has no spec for ${sym}`);
      this.buildHistory(sym, mid);
    }
    this.transactions.push({ id: String(this.nextId++), time: iso(this.now() - 86_400_000), type: 'CREATE', accountID: o.accountId });
  }

  private now(): number {
    return this.o.clock.now();
  }

  private spec(sym: string): Spec {
    return FAKE_SPECS[sym]!;
  }

  private round(sym: string, p: number): number {
    return Number(p.toFixed(this.spec(sym).displayPrecision));
  }

  // ── Market ──────────────────────────────────────────────────────────────

  private buildHistory(symbol: string, base: number): void {
    const map = new Map<number, Candle>();
    const nowMin = Math.floor(this.now() / 60_000) * 60_000;
    const path = this.o.historyPath ?? ((_s: string, i: number, b: number) => b * (1 + Math.sin(i / 7) * 0.0004));
    const vol = this.o.historyVolume ?? (() => 100);
    const wiggle = this.spec(symbol).spread * 1.5;
    let prev = path(symbol, 0, base);
    for (let t = this.sessionOpenMs, i = 0; t < nowMin; t += 60_000, i++) {
      const c = path(symbol, i, base);
      const o = prev;
      map.set(t, { t, o, h: Math.max(o, c) + wiggle, l: Math.min(o, c) - wiggle, c, v: vol(symbol, i) });
      prev = c;
    }
    this.candles.set(symbol, map);
    const last = [...map.values()].pop();
    this.setPriceSilently(symbol, last?.c ?? base);
  }

  private setPriceSilently(symbol: string, mid: number): void {
    const half = this.spec(symbol).spread / 2;
    this.prices.set(symbol, { bid: this.round(symbol, mid - half), ask: this.round(symbol, mid + half), tradeable: this.prices.get(symbol)?.tradeable ?? true });
  }

  /** A price update at the current time: streamed, counted into the minute candle, and stops/limits checked. */
  tick(symbol: string, mid: number, ticks = 1): void {
    this.setPriceSilently(symbol, mid);
    const p = this.prices.get(symbol)!;
    const m = (p.bid + p.ask) / 2;
    const t = Math.floor(this.now() / 60_000) * 60_000;
    const map = this.candles.get(symbol)!;
    const c = map.get(t);
    if (!c) map.set(t, { t, o: m, h: m, l: m, c: m, v: ticks });
    else {
      c.h = Math.max(c.h, m);
      c.l = Math.min(c.l, m);
      c.c = m;
      c.v += ticks;
    }
    this.publishPrice(symbol);
    this.checkPending(symbol);
  }

  setTradeable(symbol: string, tradeable: boolean): void {
    this.prices.get(symbol)!.tradeable = tradeable;
    this.publishPrice(symbol);
  }

  /** Re-publish every price with the current time (keeps data fresh after a clock jump). */
  refreshPrices(): void {
    for (const sym of this.prices.keys()) this.publishPrice(sym);
  }

  mid(symbol: string): number {
    const p = this.prices.get(symbol)!;
    return (p.bid + p.ask) / 2;
  }

  private priceJson(symbol: string): any {
    const p = this.prices.get(symbol)!;
    return {
      type: 'PRICE',
      instrument: symbol,
      time: iso(this.now()),
      status: p.tradeable ? 'tradeable' : 'non-tradeable',
      tradeable: p.tradeable,
      bids: [{ price: s(p.bid, this.spec(symbol).displayPrecision), liquidity: 1_000_000 }],
      asks: [{ price: s(p.ask, this.spec(symbol).displayPrecision), liquidity: 1_000_000 }],
      closeoutBid: s(p.bid, this.spec(symbol).displayPrecision),
      closeoutAsk: s(p.ask, this.spec(symbol).displayPrecision),
    };
  }

  private publishPrice(symbol: string): void {
    const line = `${JSON.stringify(this.priceJson(symbol))}\n`;
    for (const c of this.priceClients) if (c.instruments.has(symbol)) c.res.write(line);
  }

  /** Quote-currency → account-currency factor (mid based). */
  factor(symbol: string): number {
    const q = symbol.split('_')[1]!;
    return this.conv(q);
  }

  private conv(cur: string): number {
    if (cur === this.currency) return 1;
    const direct = this.prices.get(`${cur}_${this.currency}`);
    if (direct) return (direct.bid + direct.ask) / 2;
    const inverse = this.prices.get(`${this.currency}_${cur}`);
    if (inverse) return 2 / (inverse.bid + inverse.ask);
    throw new Error(`no conversion ${cur}→${this.currency}`);
  }

  // ── Account math ────────────────────────────────────────────────────────

  private unrealized(t: Trade): number {
    const p = this.prices.get(t.instrument)!;
    const exit = t.currentUnits > 0 ? p.bid : p.ask;
    return (exit - t.price) * t.currentUnits * this.factor(t.instrument);
  }

  private marginUsed(): number {
    let m = 0;
    for (const t of this.trades.values()) m += Math.abs(t.currentUnits) * this.mid(t.instrument) * this.factor(t.instrument) * this.spec(t.instrument).marginRate;
    return m;
  }

  nav(): number {
    let u = 0;
    for (const t of this.trades.values()) u += this.unrealized(t);
    return this.balance + u;
  }

  netUnits(symbol: string): number {
    let u = 0;
    for (const t of this.trades.values()) if (t.instrument === symbol) u += t.currentUnits;
    return u;
  }

  private tx(fields: any): any {
    const t = { id: String(this.nextId++), time: iso(this.now()), accountID: this.o.accountId, userID: 1, batchID: fields.batchID ?? undefined, ...fields };
    this.transactions.push(t);
    const line = `${JSON.stringify(t)}\n`;
    for (const c of this.txClients) c.write(line);
    return t;
  }

  // ── Test setup helpers ──────────────────────────────────────────────────

  /** A trade that was opened before today (its opening transaction is time-stamped `hoursAgo` hours back). */
  seedTrade(instrument: string, units: number, price: number, hoursAgo = 20): Trade {
    const id = String(this.nextId++);
    const time = this.now() - hoursAgo * 3_600_000;
    this.transactions.push({
      id,
      time: iso(time),
      accountID: this.o.accountId,
      type: 'ORDER_FILL',
      instrument,
      units: String(units),
      reason: 'MARKET_ORDER',
      tradeOpened: { tradeID: id, units: String(units), price: s(price, this.spec(instrument).displayPrecision) },
    });
    const t: Trade = { id, instrument, price, openTime: time, initialUnits: units, currentUnits: units, realizedPL: 0, stopLossOrderId: null };
    this.trades.set(id, t);
    return t;
  }

  /** A deposit (not trading P&L). */
  deposit(amount: number): void {
    this.balance += amount;
    this.tx({ type: 'TRANSFER_FUNDS', amount: s(amount), fundingReason: 'CLIENT_FUNDING', accountBalance: s(this.balance) });
  }

  /** Overnight financing charged to the account. */
  financing(amount: number): void {
    this.balance += amount;
    this.tx({ type: 'DAILY_FINANCING', financing: s(amount), accountBalance: s(this.balance), positionFinancings: [] });
  }

  // ── Orders ──────────────────────────────────────────────────────────────

  private orderJson(o: Order): any {
    const out: any = { id: o.id, createTime: iso(o.createTime), state: o.state, type: o.type, timeInForce: o.timeInForce };
    if (o.instrument && !o.tradeID) out.instrument = o.instrument;
    if (o.units !== null) out.units = String(o.units);
    if (o.price !== null) out.price = s(o.price, this.spec(o.instrument).displayPrecision);
    if (o.priceBound !== null) out.priceBound = s(o.priceBound, this.spec(o.instrument).displayPrecision);
    if (o.tradeID) out.tradeID = o.tradeID;
    if (!o.tradeID) out.positionFill = o.positionFill;
    if (o.clientExtensions) out.clientExtensions = o.clientExtensions;
    if (o.fillingTransactionID) {
      out.fillingTransactionID = o.fillingTransactionID;
      out.filledTime = iso(o.filledTime!);
    }
    if (o.cancellingTransactionID) {
      out.cancellingTransactionID = o.cancellingTransactionID;
      out.cancelledTime = iso(o.cancelledTime!);
    }
    return out;
  }

  private decimals(v: string): number {
    const i = v.indexOf('.');
    return i < 0 ? 0 : v.length - i - 1;
  }

  private reject(type: string, order: any, reason: string, message: string): { status: number; body: any } {
    const rej = this.tx({ type: `${type}_REJECT`, instrument: order.instrument, units: order.units, timeInForce: order.timeInForce, clientExtensions: order.clientExtensions, rejectReason: reason });
    return { status: 400, body: { orderRejectTransaction: rej, relatedTransactionIDs: [rej.id], lastTransactionID: rej.id, errorCode: reason, errorMessage: message } };
  }

  private submit(body: any): { status: number; body: any } {
    const order = body?.order ?? {};
    this.submitBodies.push(order);
    const type = String(order.type ?? '');
    const kind = type === 'MARKET' ? 'MARKET_ORDER' : type === 'LIMIT' ? 'LIMIT_ORDER' : null;
    if (!kind) return { status: 400, body: { errorMessage: `Invalid value specified for 'type'`, errorCode: 'INVALID_ORDER_TYPE' } };
    const spec = FAKE_SPECS[order.instrument];
    if (!spec) return this.reject(kind, order, 'INSTRUMENT_NOT_TRADEABLE', 'The instrument specified is not tradeable by the Account');
    if (this.rejectNext) {
      const r = this.rejectNext;
      this.rejectNext = null;
      return this.reject(kind, order, r, `rejected: ${r}`);
    }
    const unitsStr = String(order.units ?? '');
    const units = Number(unitsStr);
    if (!Number.isFinite(units) || units === 0) return this.reject(kind, order, 'UNITS_INVALID', 'The units specified are invalid');
    if (this.decimals(unitsStr) > spec.tradeUnitsPrecision) return this.reject(kind, order, 'UNITS_PRECISION_EXCEEDED', 'The units specified contain more precision than is allowed');
    if (Math.abs(units) < spec.minimumTradeSize) return this.reject(kind, order, 'UNITS_MINIMUM_NOT_MET', 'The units specified do not meet the minimum');
    for (const f of ['price', 'priceBound']) {
      if (order[f] !== undefined && this.decimals(String(order[f])) > spec.displayPrecision) return this.reject(kind, order, 'PRICE_PRECISION_EXCEEDED', `The ${f} specified contains more precision than is allowed`);
    }
    if (order.stopLossOnFill?.price !== undefined && this.decimals(String(order.stopLossOnFill.price)) > spec.displayPrecision) {
      return this.reject(kind, order, 'STOP_LOSS_ON_FILL_PRICE_PRECISION_EXCEEDED', 'stop loss price precision exceeded');
    }
    const cid = order.clientExtensions?.id;
    if (cid && [...this.orders.values()].some((x) => x.clientExtensions?.id === cid)) return this.reject(kind, order, 'CLIENT_ORDER_ID_ALREADY_EXISTS', 'client order id already exists');
    if (type === 'MARKET' && !['FOK', 'IOC'].includes(order.timeInForce)) return this.reject(kind, order, 'TIME_IN_FORCE_INVALID', 'market orders must be FOK or IOC');

    const create = this.tx({
      type: kind,
      instrument: order.instrument,
      units: unitsStr,
      timeInForce: order.timeInForce,
      priceBound: order.priceBound,
      price: order.price,
      positionFill: order.positionFill ?? 'DEFAULT',
      reason: 'CLIENT_ORDER',
      clientExtensions: order.clientExtensions,
      stopLossOnFill: order.stopLossOnFill,
    });
    const o: Order = {
      id: create.id,
      type,
      instrument: order.instrument,
      units,
      timeInForce: order.timeInForce,
      price: order.price !== undefined ? Number(order.price) : null,
      priceBound: order.priceBound !== undefined ? Number(order.priceBound) : null,
      positionFill: order.positionFill ?? 'DEFAULT',
      state: 'PENDING',
      clientExtensions: order.clientExtensions ?? null,
      createTime: this.now(),
      tradeID: null,
      fillingTransactionID: null,
      filledTime: null,
      cancellingTransactionID: null,
      cancelledTime: null,
      stopLossOnFill: order.stopLossOnFill ?? null,
    };
    this.orders.set(o.id, o);
    const out: any = { orderCreateTransaction: create, relatedTransactionIDs: [create.id] };
    if (type === 'MARKET') {
      const r = this.execute(o, null);
      Object.assign(out, r);
    } else {
      this.checkPending(o.instrument);
      if (o.state === 'FILLED') out.orderFillTransaction = this.transactions.find((t) => t.id === o.fillingTransactionID);
    }
    out.lastTransactionID = String(this.nextId - 1);
    for (const t of this.transactions.filter((t) => Number(t.id) > Number(create.id))) out.relatedTransactionIDs.push(t.id);
    return { status: 201, body: out };
  }

  private cancelOrder(o: Order, reason: string): any {
    o.state = 'CANCELLED';
    const c = this.tx({ type: 'ORDER_CANCEL', orderID: o.id, clientOrderID: o.clientExtensions?.id, reason });
    o.cancellingTransactionID = c.id;
    o.cancelledTime = this.now();
    return c;
  }

  /** Fill (or cancel) an order now. `at` is the trigger price for stop/limit fills. */
  private execute(o: Order, at: number | null): { orderFillTransaction?: any; orderCancelTransaction?: any } {
    const p = this.prices.get(o.instrument)!;
    if (this.cancelNext && !o.tradeID) {
      const r = this.cancelNext;
      this.cancelNext = null;
      return { orderCancelTransaction: this.cancelOrder(o, r) };
    }
    if (!p.tradeable) return { orderCancelTransaction: this.cancelOrder(o, 'MARKET_HALTED') };
    const trade = o.tradeID ? this.trades.get(o.tradeID) : null;
    const units = trade ? -trade.currentUnits : o.units!;
    const buy = units > 0;
    const px = at ?? (buy ? p.ask : p.bid);
    if (o.priceBound !== null && (buy ? px > o.priceBound + 1e-12 : px < o.priceBound - 1e-12)) return { orderCancelTransaction: this.cancelOrder(o, 'BOUNDS_VIOLATION') };
    const net = this.netUnits(o.instrument);
    const reduces = net !== 0 && Math.sign(net) !== Math.sign(units);
    if (o.positionFill === 'REDUCE_ONLY' && !reduces && !trade) return { orderCancelTransaction: this.cancelOrder(o, 'REDUCE_ONLY_VIOLATION') };
    if (o.positionFill === 'OPEN_ONLY' && reduces) return { orderCancelTransaction: this.cancelOrder(o, 'OPEN_ONLY_VIOLATION') };
    const factor = this.factor(o.instrument);
    if (!reduces) {
      const need = Math.abs(units) * px * factor * this.spec(o.instrument).marginRate;
      if (need > this.nav() - this.marginUsed()) return { orderCancelTransaction: this.cancelOrder(o, 'INSUFFICIENT_MARGIN') };
    }

    const fillId = String(this.nextId); // the fill's id is also the opened trade's id
    const fill: any = { type: 'ORDER_FILL', orderID: o.id, clientOrderID: o.clientExtensions?.id, instrument: o.instrument, units: String(units), reason: trade ? 'STOP_LOSS_ORDER' : o.type === 'LIMIT' ? 'LIMIT_ORDER' : 'MARKET_ORDER', fullVWAP: s(px, this.spec(o.instrument).displayPrecision), financing: '0.0000', commission: '0.0000', guaranteedExecutionFee: '0.0000' };
    let remaining = units;
    let pl = 0;
    const closed: any[] = [];
    const closedTrades: Trade[] = [];
    if (reduces || trade) {
      const targets = trade ? [trade] : [...this.trades.values()].filter((t) => t.instrument === o.instrument && Math.sign(t.currentUnits) !== Math.sign(units)).sort((a, b) => Number(a.id) - Number(b.id));
      for (const t of targets) {
        if (remaining === 0) break;
        const take = Math.min(Math.abs(remaining), Math.abs(t.currentUnits)) * Math.sign(remaining);
        const realized = (px - t.price) * -take * factor;
        pl += realized;
        const leg = { tradeID: t.id, units: String(take), price: s(px, this.spec(o.instrument).displayPrecision), realizedPL: s(realized), financing: '0.0000', guaranteedExecutionFee: '0.0000', halfSpreadCost: '0.0000' };
        t.currentUnits += take;
        t.realizedPL += realized;
        remaining -= take;
        if (Math.abs(t.currentUnits) < 1e-9) {
          closed.push(leg);
          closedTrades.push(t);
        } else fill.tradeReduced = leg;
      }
    }
    if (Math.abs(remaining) > 1e-9) {
      fill.tradeOpened = { tradeID: fillId, units: String(remaining), price: s(px, this.spec(o.instrument).displayPrecision), guaranteedExecutionFee: '0.0000', halfSpreadCost: '0.0000', initialMarginRequired: s(Math.abs(remaining) * px * factor * this.spec(o.instrument).marginRate) };
    }
    if (closed.length) fill.tradesClosed = closed;
    this.balance += pl;
    fill.pl = s(pl);
    fill.accountBalance = s(this.balance);
    const fillTx = this.tx(fill);
    o.state = 'FILLED';
    o.fillingTransactionID = fillTx.id;
    o.filledTime = this.now();
    if (fill.tradeOpened) {
      const t: Trade = { id: fillTx.id, instrument: o.instrument, price: px, openTime: this.now(), initialUnits: remaining, currentUnits: remaining, realizedPL: 0, stopLossOrderId: null };
      this.trades.set(t.id, t);
      if (o.stopLossOnFill) {
        const sl = this.tx({ type: 'STOP_LOSS_ORDER', tradeID: t.id, price: o.stopLossOnFill.price, timeInForce: o.stopLossOnFill.timeInForce ?? 'GTC', triggerCondition: 'DEFAULT', reason: 'ON_FILL', clientExtensions: o.stopLossOnFill.clientExtensions });
        const slo: Order = {
          id: sl.id,
          type: 'STOP_LOSS',
          instrument: o.instrument,
          units: null,
          timeInForce: sl.timeInForce,
          price: Number(o.stopLossOnFill.price),
          priceBound: null,
          positionFill: 'DEFAULT',
          state: 'PENDING',
          clientExtensions: o.stopLossOnFill.clientExtensions ?? null,
          createTime: this.now(),
          tradeID: t.id,
          fillingTransactionID: null,
          filledTime: null,
          cancellingTransactionID: null,
          cancelledTime: null,
          stopLossOnFill: null,
        };
        this.orders.set(slo.id, slo);
        t.stopLossOrderId = slo.id;
      }
    }
    for (const t of closedTrades) {
      this.trades.delete(t.id);
      for (const dep of this.orders.values()) if (dep.tradeID === t.id && dep.state === 'PENDING' && dep.id !== o.id) this.cancelOrder(dep, 'LINKED_TRADE_CLOSED');
    }
    return { orderFillTransaction: fillTx };
  }

  /** Trigger pending limit orders and stop losses against the current price. */
  private checkPending(symbol: string): void {
    const p = this.prices.get(symbol)!;
    for (const o of [...this.orders.values()]) {
      if (o.state !== 'PENDING' || o.instrument !== symbol) continue;
      if (o.type === 'STOP_LOSS') {
        const t = this.trades.get(o.tradeID!);
        if (!t) continue;
        const long = t.currentUnits > 0;
        if (long ? p.bid <= o.price! : p.ask >= o.price!) this.execute(o, long ? p.bid : p.ask);
      } else if (o.type === 'LIMIT') {
        const buy = (o.units ?? 0) > 0;
        if (buy ? p.ask <= o.price! : p.bid >= o.price!) this.execute(o, buy ? p.ask : p.bid);
      }
    }
  }

  // ── HTTP ────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    const hb = this.o.heartbeatMs ?? 2000;
    this.timers.push(
      setInterval(() => {
        const t = iso(this.now());
        const last = String(this.nextId - 1);
        for (const c of this.txClients) c.write(`${JSON.stringify({ type: 'HEARTBEAT', lastTransactionID: last, time: t })}\n`);
        for (const c of this.priceClients) c.res.write(`${JSON.stringify({ type: 'HEARTBEAT', time: t })}\n`);
      }, hb),
    );
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    if (this.autopilot) clearInterval(this.autopilot);
    for (const c of this.txClients) c.destroy();
    for (const c of this.priceClients) c.res.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Drop every open stream (as a network blip would). */
  dropStreams(): void {
    for (const c of this.txClients) c.destroy();
    for (const c of this.priceClients) c.res.destroy();
    this.txClients.clear();
    this.priceClients.clear();
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', Date: new Date(this.now()).toUTCString() });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${this.o.token}`) return send(401, { errorMessage: 'Insufficient authorization to perform request.' });
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    const q = url.searchParams;
    let body: any;
    if (req.method === 'POST' || req.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const text = Buffer.concat(chunks).toString();
      body = text ? JSON.parse(text) : {};
    }
    const acct = `/v3/accounts/${this.o.accountId}`;
    try {
      const candles = /^\/v3\/instruments\/([A-Z0-9_]+)\/candles$/.exec(p);
      if (candles && req.method === 'GET') return send(200, this.candlesJson(candles[1]!, q));
      if (!p.startsWith(acct)) {
        if (p.startsWith('/v3/accounts/')) return send(403, { errorMessage: 'The provided request was forbidden.' });
        return send(404, { errorMessage: 'not found' });
      }
      const sub = p.slice(acct.length);
      if (req.method === 'GET' && sub === '/transactions/stream') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' });
        res.write(`${JSON.stringify({ type: 'HEARTBEAT', lastTransactionID: String(this.nextId - 1), time: iso(this.now()) })}\n`);
        this.txClients.add(res);
        req.on('close', () => this.txClients.delete(res));
        return;
      }
      if (req.method === 'GET' && sub === '/pricing/stream') {
        const instruments = new Set((q.get('instruments') ?? '').split(',').filter(Boolean));
        for (const i of instruments) if (!this.prices.has(i)) return send(400, { errorMessage: `Invalid Instrument ${i}` });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' });
        const client = { res, instruments };
        this.priceClients.add(client);
        req.on('close', () => this.priceClients.delete(client));
        if (q.get('snapshot') !== 'false') for (const i of instruments) res.write(`${JSON.stringify(this.priceJson(i))}\n`);
        return;
      }
      if (req.method === 'GET' && sub === '/summary') return send(200, { account: this.summaryJson(), lastTransactionID: String(this.nextId - 1) });
      if (req.method === 'GET' && sub === '/instruments') {
        return send(200, {
          instruments: Object.entries(FAKE_SPECS)
            .filter(([sym]) => this.prices.has(sym))
            .map(([name, x]) => ({
              name,
              type: x.type,
              displayName: x.displayName,
              pipLocation: x.pipLocation,
              displayPrecision: x.displayPrecision,
              tradeUnitsPrecision: x.tradeUnitsPrecision,
              minimumTradeSize: String(x.minimumTradeSize),
              maximumOrderUnits: String(x.maximumOrderUnits),
              marginRate: String(x.marginRate),
            })),
          lastTransactionID: String(this.nextId - 1),
        });
      }
      if (req.method === 'GET' && sub === '/openPositions') return send(200, { positions: this.positionsJson(), lastTransactionID: String(this.nextId - 1) });
      if (req.method === 'GET' && sub === '/openTrades') return send(200, { trades: [...this.trades.values()].map((t) => this.tradeJson(t)), lastTransactionID: String(this.nextId - 1) });
      if (req.method === 'GET' && sub === '/pendingOrders') return send(200, { orders: [...this.orders.values()].filter((o) => o.state === 'PENDING').map((o) => this.orderJson(o)), lastTransactionID: String(this.nextId - 1) });
      if (req.method === 'GET' && sub === '/orders') {
        const state = q.get('state') ?? 'PENDING';
        return send(200, { orders: [...this.orders.values()].filter((o) => state === 'ALL' || o.state === state).map((o) => this.orderJson(o)).reverse(), lastTransactionID: String(this.nextId - 1) });
      }
      if (req.method === 'POST' && sub === '/orders') {
        const r = this.submit(body);
        if (this.dropNextSubmitResponse) {
          this.dropNextSubmitResponse = false;
          req.socket.destroy(); // processed, but the client never hears back
          return;
        }
        return send(r.status, r.body);
      }
      const ord = /^\/orders\/([^/]+?)(\/cancel)?$/.exec(sub);
      if (ord) {
        const spec = decodeURIComponent(ord[1]!);
        const o = spec.startsWith('@') ? [...this.orders.values()].find((x) => x.clientExtensions?.id === spec.slice(1)) : this.orders.get(spec);
        if (!o) return send(404, { errorMessage: 'The Order specified does not exist', errorCode: 'ORDER_DOESNT_EXIST' });
        if (req.method === 'GET' && !ord[2]) return send(200, { order: this.orderJson(o), lastTransactionID: String(this.nextId - 1) });
        if (req.method === 'PUT' && ord[2]) {
          if (o.state !== 'PENDING') {
            const rej = this.tx({ type: 'ORDER_CANCEL_REJECT', orderID: o.id, clientOrderID: o.clientExtensions?.id, rejectReason: 'ORDER_DOESNT_EXIST' });
            return send(404, { orderCancelRejectTransaction: rej, errorCode: 'ORDER_DOESNT_EXIST', errorMessage: 'The Order specified does not exist' });
          }
          const c = this.cancelOrder(o, 'CLIENT_REQUEST');
          return send(200, { orderCancelTransaction: c, relatedTransactionIDs: [c.id], lastTransactionID: c.id });
        }
      }
      if (req.method === 'GET' && sub === '/pricing') {
        const list = (q.get('instruments') ?? '').split(',').filter(Boolean);
        const out: any = { prices: list.filter((i) => this.prices.has(i)).map((i) => ({ ...this.priceJson(i), type: undefined })), time: iso(this.now()) };
        if (q.get('includeHomeConversions') === 'true') {
          const curs = new Set<string>([this.currency]);
          for (const i of list) for (const c of i.split('_')) if (/^[A-Z]{3}$/.test(c)) curs.add(c);
          out.homeConversions = [...curs].flatMap((c) => {
            try {
              const f = this.conv(c);
              return [{ currency: c, accountGain: s(f, 8), accountLoss: s(f, 8), positionValue: s(f, 8) }];
            } catch {
              return [];
            }
          });
        }
        return send(200, out);
      }
      if (req.method === 'GET' && sub === '/transactions') {
        const from = Date.parse(q.get('from') ?? '1970-01-01T00:00:00Z');
        const to = Date.parse(q.get('to') ?? new Date(this.now()).toISOString());
        const inRange = this.transactions.filter((t) => {
          const ms = Date.parse(t.time);
          return ms >= from && ms <= to;
        });
        const pageSize = Number(q.get('pageSize') ?? 100);
        const pages: string[] = [];
        for (let i = 0; i < inRange.length; i += pageSize) {
          const chunk = inRange.slice(i, i + pageSize);
          pages.push(`${this.url}${acct}/transactions/idrange?from=${chunk[0].id}&to=${chunk[chunk.length - 1].id}`);
        }
        return send(200, { from: q.get('from'), to: q.get('to'), pageSize, count: inRange.length, pages, lastTransactionID: String(this.nextId - 1) });
      }
      if (req.method === 'GET' && sub === '/transactions/idrange') {
        const a = Number(q.get('from'));
        const b = Number(q.get('to'));
        return send(200, { transactions: this.transactions.filter((t) => Number(t.id) >= a && Number(t.id) <= b), lastTransactionID: String(this.nextId - 1) });
      }
      if (req.method === 'GET' && sub === '/transactions/sinceid') {
        const id = Number(q.get('id'));
        return send(200, { transactions: this.transactions.filter((t) => Number(t.id) > id).slice(0, 1000), lastTransactionID: String(this.nextId - 1) });
      }
      const txm = /^\/transactions\/(\d+)$/.exec(sub);
      if (txm && req.method === 'GET') {
        const t = this.transactions.find((x) => x.id === txm[1]);
        return t ? send(200, { transaction: t, lastTransactionID: String(this.nextId - 1) }) : send(404, { errorMessage: 'transaction not found' });
      }
      return send(404, { errorMessage: `no route ${req.method} ${p}` });
    } catch (err) {
      return send(500, { errorMessage: (err as Error).message });
    }
  }

  private summaryJson(): any {
    let u = 0;
    for (const t of this.trades.values()) u += this.unrealized(t);
    const used = this.marginUsed();
    const nav = this.balance + u;
    return {
      id: this.o.accountId,
      alias: 'Primary',
      currency: this.currency,
      balance: s(this.balance),
      NAV: s(nav),
      unrealizedPL: s(u),
      pl: '0.0000',
      financing: '0.0000',
      commission: '0.0000',
      marginRate: '0.02',
      marginUsed: s(used),
      marginAvailable: s(nav - used),
      marginCloseoutMarginUsed: s(used / 2),
      marginCloseoutPercent: s(nav > 0 ? used / 2 / nav : 0, 5),
      openTradeCount: this.trades.size,
      openPositionCount: new Set([...this.trades.values()].map((t) => t.instrument)).size,
      pendingOrderCount: [...this.orders.values()].filter((o) => o.state === 'PENDING').length,
      hedgingEnabled: false,
      lastTransactionID: String(this.nextId - 1),
    };
  }

  private tradeJson(t: Trade): any {
    return {
      id: t.id,
      instrument: t.instrument,
      price: s(t.price, this.spec(t.instrument).displayPrecision),
      openTime: iso(t.openTime),
      initialUnits: String(t.initialUnits),
      currentUnits: String(t.currentUnits),
      state: 'OPEN',
      realizedPL: s(t.realizedPL),
      unrealizedPL: s(this.unrealized(t)),
      financing: '0.0000',
    };
  }

  private positionsJson(): any[] {
    const by = new Map<string, Trade[]>();
    for (const t of this.trades.values()) by.set(t.instrument, [...(by.get(t.instrument) ?? []), t]);
    return [...by.entries()].map(([instrument, ts]) => {
      const longs = ts.filter((t) => t.currentUnits > 0);
      const shorts = ts.filter((t) => t.currentUnits < 0);
      const side = (list: Trade[]) => {
        const units = list.reduce((a, t) => a + t.currentUnits, 0);
        const avg = units === 0 ? null : list.reduce((a, t) => a + t.price * t.currentUnits, 0) / units;
        const u = list.reduce((a, t) => a + this.unrealized(t), 0);
        const out: any = { units: String(units), pl: '0.0000', unrealizedPL: s(u), resettablePL: '0.0000', financing: '0.0000', tradeIDs: list.map((t) => t.id) };
        if (avg !== null) out.averagePrice = s(avg, this.spec(instrument).displayPrecision);
        return out;
      };
      const l = side(longs);
      const sh = side(shorts);
      return { instrument, long: l, short: sh, pl: '0.0000', unrealizedPL: s(Number(l.unrealizedPL) + Number(sh.unrealizedPL)), marginUsed: '0.0000', commission: '0.0000', financing: '0.0000' };
    });
  }

  private candlesJson(symbol: string, q: URLSearchParams): any {
    if (!this.prices.has(symbol)) return { errorMessage: 'Invalid instrument' };
    const gran = q.get('granularity') ?? 'S5';
    const now = this.now();
    if (gran === 'D') {
      const c = this.mid(symbol);
      const t = DateTime.fromMillis(now, { zone: NY }).startOf('day').minus({ days: 1 }).set({ hour: 17 }).toMillis();
      return { instrument: symbol, granularity: 'D', candles: [{ complete: true, volume: 50_000, time: iso(t - 86_400_000), mid: { o: s(c), h: s(c), l: s(c), c: s(c * 0.995) } }] };
    }
    const count = Number(q.get('count') ?? 500);
    const from = q.get('from') ? Date.parse(q.get('from')!) : null;
    const dp = this.spec(symbol).displayPrecision;
    let list = [...this.candles.get(symbol)!.values()].filter((c) => c.t <= now).sort((a, b) => a.t - b.t);
    if (from !== null) list = list.filter((c) => c.t >= from).slice(0, count);
    else list = list.slice(-count);
    return {
      instrument: symbol,
      granularity: 'M1',
      candles: list.map((c) => ({ complete: c.t + 60_000 <= now, volume: c.v, time: iso(c.t), mid: { o: s(c.o, dp), h: s(c.h, dp), l: s(c.l, dp), c: s(c.c, dp) } })),
    };
  }

  /**
   * Harness autopilot: a synthetic random walk at real-time speed so the UI
   * can be exercised without a broker. Clearly synthetic; never used in tests
   * that assert trading outcomes.
   */
  startAutopilot(intervalMs = 400): void {
    this.autopilot = setInterval(() => {
      for (const sym of this.prices.keys()) {
        const m = this.mid(sym);
        this.tick(sym, m + (Math.random() - 0.5) * m * 0.0003);
      }
    }, intervalMs);
  }
}
