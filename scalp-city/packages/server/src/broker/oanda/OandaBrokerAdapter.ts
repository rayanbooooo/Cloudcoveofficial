import type { AssetClass, TradingEnvironment } from '@scalp-city/shared';
import type { OandaCredentials } from '../../config/env.js';
import { systemClock, type Clock } from '../../core/clock.js';
import type { Logger } from '../../core/logger.js';
import { roundPrice } from '../../market/InstrumentCatalog.js';
import {
  BrokerError,
  type BrokerAccount,
  type BrokerAdapter,
  type BrokerAsset,
  type BrokerCalendarDay,
  type BrokerClock,
  type BrokerInstrument,
  type BrokerOptionContract,
  type BrokerOrder,
  type BrokerPosition,
  type BrokerTradeUpdate,
  type StreamStatus,
  type SubmitOrderParams,
  type Unsubscribe,
} from '../types.js';
import { configuredSessions, sessionClock, type SessionRules } from './calendar.js';
import {
  cancelStatus,
  fillPrice,
  fillRealized,
  isDependentOrderType,
  mapInstrument,
  mapOrder,
  num,
  oandaTime,
  priceString,
  unitsString,
  withFill,
  type Raw,
  type TradeInfo,
} from './mappers.js';
import { OANDA_DAY_PNL_NOTE, OandaDayPnl } from './OandaDayPnl.js';
import { OandaHttp } from './OandaHttp.js';
import { OandaStream } from './OandaStream.js';

export interface OandaBrokerAdapterOptions {
  env: TradingEnvironment;
  /** REST base, e.g. https://api-fxpractice.oanda.com */
  apiUrl: string;
  /** Streaming base, e.g. https://stream-fxpractice.oanda.com */
  streamUrl: string;
  credentials: OandaCredentials;
  session: { open: string; close: string };
  skipUsHolidays: boolean;
  /** Instruments the workers trade (kept priced for currency conversion). */
  instruments: string[];
  logger: Logger;
  clock?: Clock;
  fetchImpl?: typeof fetch;
}

interface OrderInfo {
  instrument: string;
  /** Signed units requested (null for dependent orders). */
  units: number | null;
  clientOrderId: string;
  /** Units filled so far (OANDA fills each fill with its own transaction). */
  filled: number;
  type: BrokerOrder['type'];
  dependent: boolean;
}

interface Conversion {
  positionValue: number | null;
  accountLoss: number | null;
}

/**
 * OANDA v20 adapter (spec §70): spot FX, metals and index CFDs.
 *
 *  - PAPER is an fxTrade Practice account, LIVE an fxTrade account; the two
 *    differ only in host and token (live hosts are pinned in config).
 *  - Opening orders are sent OPEN_ONLY and closing orders REDUCE_ONLY, so
 *    OANDA itself guarantees an exit can never open a reverse position.
 *  - Worker entries carry a stop loss that OANDA holds on its own servers
 *    (stopLossOnFill), so a position stays protected while this server is down.
 *  - The transaction stream is the source of fills; after any reconnect the
 *    gap is replayed from /transactions/sinceid, so nothing is missed.
 */
export class OandaBrokerAdapter implements BrokerAdapter {
  readonly name = 'OANDA' as const;
  readonly venue = 'oanda' as const;
  readonly calendarSource = 'configured' as const;
  readonly env: TradingEnvironment;
  readonly endpoint: string;
  private readonly http: OandaHttp;
  private readonly txStream: OandaStream;
  private readonly clock: Clock;
  private readonly acct: string;
  private readonly rules: SessionRules;
  private readonly dayPnl: OandaDayPnl;
  private streamStarted = false;
  private updateHandlers = new Set<(u: BrokerTradeUpdate) => void>();
  private orders = new Map<string, OrderInfo>();
  private trades = new Map<string, TradeInfo>();
  private lastTxId: number | null = null;
  private catchingUp = false;
  private currency: string | null = null;
  private conversions = new Map<string, Conversion>();
  private conversionsAt = 0;
  private mids = new Map<string, number>();
  private instrumentList: BrokerInstrument[] | null = null;
  private instrumentsAt = 0;

  constructor(private readonly opts: OandaBrokerAdapterOptions) {
    this.env = opts.env;
    this.endpoint = opts.apiUrl;
    this.clock = opts.clock ?? systemClock;
    this.acct = `/v3/accounts/${encodeURIComponent(opts.credentials.accountId)}`;
    this.rules = { open: opts.session.open, close: opts.session.close, skipUsHolidays: opts.skipUsHolidays };
    this.http = new OandaHttp({ baseUrl: opts.apiUrl, token: opts.credentials.token, logger: opts.logger.child({ component: 'oanda-rest' }), fetchImpl: opts.fetchImpl });
    this.dayPnl = new OandaDayPnl(this.http, this.acct, this.clock, opts.logger.child({ component: 'oanda-day-pnl' }));
    this.txStream = new OandaStream({
      name: 'oanda-transactions',
      url: () => `${opts.streamUrl}${this.acct}/transactions/stream`,
      token: opts.credentials.token,
      logger: opts.logger.child({ component: 'oanda-transaction-stream' }),
      fetchImpl: opts.fetchImpl,
    });
    this.txStream.onMessage((m) => this.onTransaction(m));
    this.txStream.onConnected(() => void this.catchUp().catch((err) => opts.logger.warn({ err: (err as Error).message }, 'transaction catch-up failed')));
  }

  // ── Account ─────────────────────────────────────────────────────────────

  async getAccount(): Promise<BrokerAccount> {
    const r = await this.http.get<Raw>(`${this.acct}/summary`);
    const a = (r.account ?? {}) as Raw;
    if (typeof a.currency === 'string') this.currency = a.currency;
    const last = Number(a.lastTransactionID ?? r.lastTransactionID);
    if (this.lastTxId === null && Number.isFinite(last)) this.lastTxId = last;
    if (this.clock.now() - this.conversionsAt > 60_000) void this.refreshPricing().catch(() => undefined);

    const open = await this.http.get<Raw>(`${this.acct}/openTrades`);
    const trades = (open.trades ?? []) as Raw[];
    for (const t of trades) this.trades.set(String(t.id), { instrument: String(t.instrument), units: num(t.currentUnits) ?? 0 });

    let dayPnl: number | null = null;
    let dayPnlNote = OANDA_DAY_PNL_NOTE;
    try {
      await this.dayPnl.sync(a.lastTransactionID ?? r.lastTransactionID);
      dayPnl = this.dayPnl.total(trades);
    } catch (err) {
      // Unknown, never 0: the daily loss check then fails closed.
      dayPnlNote = `Day P&L unavailable — OANDA transaction history could not be read (${(err as Error).message})`;
      this.opts.logger.warn({ err: (err as Error).message }, 'day P&L sync failed');
    }

    const marginCall = typeof a.marginCallEnterTime === 'string' && a.marginCallEnterTime !== '';
    return {
      id: String(a.id),
      accountNumber: String(a.id),
      // OANDA reports locks through order rejections; a margin call is surfaced as a status.
      status: marginCall ? 'MARGIN_CALL' : 'ACTIVE',
      currency: typeof a.currency === 'string' ? a.currency : null,
      equity: num(a.NAV),
      lastEquity: null,
      cash: num(a.balance),
      buyingPower: null,
      regtBuyingPower: null,
      daytradingBuyingPower: null,
      nonMarginableBuyingPower: null,
      optionsBuyingPower: null,
      portfolioValue: num(a.NAV),
      longMarketValue: null,
      shortMarketValue: null,
      initialMargin: num(a.marginUsed),
      maintenanceMargin: num(a.marginCloseoutMarginUsed),
      multiplier: null,
      patternDayTrader: null,
      tradingBlocked: null,
      accountBlocked: null,
      tradeSuspendedByUser: null,
      shortingEnabled: true,
      daytradeCount: null,
      optionsApprovedLevel: null,
      optionsTradingLevel: null,
      dayPnl,
      dayPnlNote,
      marginUsed: num(a.marginUsed),
      marginAvailable: num(a.marginAvailable),
      marginCloseoutPercent: num(a.marginCloseoutPercent),
      marginRate: num(a.marginRate),
      hedgingEnabled: a.hedgingEnabled === true,
    };
  }

  environmentWarning(): string | null {
    // Practice and live are different hosts with different tokens; a mismatch fails authentication.
    return null;
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const r = await this.http.get<Raw>(`${this.acct}/openPositions`);
    const out: BrokerPosition[] = [];
    for (const p of (r.positions ?? []) as Raw[]) {
      const symbol = String(p.instrument);
      const longU = num(p.long?.units) ?? 0;
      const shortU = num(p.short?.units) ?? 0; // negative
      const net = longU + shortU;
      if (net === 0 && longU === 0 && shortU === 0) continue;
      const side = net >= 0 ? 'long' : 'short';
      const avg = side === 'long' ? num(p.long?.averagePrice) : num(p.short?.averagePrice);
      const factor = this.homeFactor(symbol);
      const mid = this.mids.get(symbol) ?? null;
      const qty = Math.abs(net);
      out.push({
        symbol,
        assetId: null,
        assetClass: 'cfd',
        side,
        qty,
        qtyAvailable: null,
        avgEntryPrice: avg ?? 0,
        costBasis: avg !== null && factor !== null ? qty * avg * factor : null,
        marketValue: mid !== null && factor !== null ? qty * mid * factor * (side === 'long' ? 1 : -1) : null,
        currentPrice: mid,
        lastdayPrice: null,
        changeToday: null,
        unrealizedPl: num(p.unrealizedPL),
        unrealizedPlpc: null,
        unrealizedIntradayPl: null,
        unrealizedIntradayPlpc: null,
        hedged: longU !== 0 && shortU !== 0,
        multiplier: factor,
      });
    }
    return out;
  }

  // ── Orders ──────────────────────────────────────────────────────────────

  async getOrders(params: { status: 'open' | 'closed' | 'all'; after?: number; limit?: number }): Promise<BrokerOrder[]> {
    if (params.status === 'open') {
      const r = await this.http.get<Raw>(`${this.acct}/pendingOrders`);
      return ((r.orders ?? []) as Raw[]).map((o) => this.toOrder(o));
    }
    const r = await this.http.get<Raw>(`${this.acct}/orders`, { state: 'ALL', count: Math.min(params.limit ?? 500, 500) });
    const all = ((r.orders ?? []) as Raw[]).map((o) => this.toOrder(o));
    const filtered = params.status === 'closed' ? all.filter((o) => o.status !== 'new') : all;
    return params.after ? filtered.filter((o) => (o.createdAt ?? 0) >= params.after!) : filtered;
  }

  private toOrder(o: Raw): BrokerOrder {
    const trade = o.tradeID !== undefined ? (this.trades.get(String(o.tradeID)) ?? null) : null;
    const mapped = mapOrder(o, trade);
    const info = this.orders.get(mapped.id);
    if (info && !mapped.symbol) mapped.symbol = info.instrument;
    return mapped;
  }

  /** An order with its fill (or cancel reason) filled in from the broker's transactions. */
  private async enrich(o: Raw): Promise<BrokerOrder> {
    let bo = this.toOrder(o);
    if (bo.status === 'filled' && o.fillingTransactionID) {
      const tx = await this.http.get<Raw>(`${this.acct}/transactions/${encodeURIComponent(String(o.fillingTransactionID))}`).catch(() => null);
      if (tx?.transaction) bo = withFill(bo, tx.transaction as Raw);
    } else if (bo.status === 'canceled' && o.cancellingTransactionID) {
      const tx = await this.http.get<Raw>(`${this.acct}/transactions/${encodeURIComponent(String(o.cancellingTransactionID))}`).catch(() => null);
      const reason = (tx?.transaction as Raw | undefined)?.reason;
      if (reason) bo = { ...bo, status: cancelStatus(reason), statusReason: String(reason) };
    }
    return bo;
  }

  async getOrder(brokerOrderId: string): Promise<BrokerOrder> {
    const r = await this.http.get<Raw>(`${this.acct}/orders/${encodeURIComponent(brokerOrderId)}`);
    return this.enrich(r.order as Raw);
  }

  async getOrderByClientId(clientOrderId: string): Promise<BrokerOrder | null> {
    try {
      const r = await this.http.get<Raw>(`${this.acct}/orders/@${encodeURIComponent(clientOrderId)}`);
      return await this.enrich(r.order as Raw);
    } catch (err) {
      if (err instanceof BrokerError && err.kind === 'NOT_FOUND') return null;
      throw err;
    }
  }

  /**
   * Submit exactly once. Never retried: a timeout or 5xx leaves the outcome
   * unknown and the order engine resolves it by client id (@clientID).
   */
  async submitOrder(p: SubmitOrderParams): Promise<BrokerOrder> {
    const spec = await this.instrument(p.symbol);
    if (!spec) throw new BrokerError('REJECTED', `${p.symbol} is not tradeable for this OANDA account`);
    const closing = p.positionIntent?.endsWith('_close') === true;
    const opening = p.positionIntent?.endsWith('_open') === true;
    const units = unitsString(p.qty, p.side, spec.unitsPrecision);
    if (Number(units) === 0) throw new BrokerError('REJECTED', `quantity ${p.qty} rounds to zero units for ${p.symbol}`);
    // Never give the broker a worse price than the one approved: buys round down, sells up.
    const px = (v: number) => priceString(roundPrice(v, spec.displayPrecision, p.side === 'buy' ? 'down' : 'up'), spec.displayPrecision);
    const order: Raw = {
      instrument: p.symbol,
      units,
      positionFill: closing ? 'REDUCE_ONLY' : opening ? 'OPEN_ONLY' : 'DEFAULT',
      clientExtensions: { id: p.clientOrderId, tag: 'scalp-city' },
    };
    if (p.type === 'market') {
      order.type = 'MARKET';
      order.timeInForce = p.timeInForce === 'ioc' ? 'IOC' : 'FOK';
    } else if (p.type === 'limit' && p.limitPrice !== null && p.limitPrice !== undefined) {
      if (p.timeInForce === 'fok' || p.timeInForce === 'ioc') {
        // Marketable now or not at all: a market order with a worst-price bound.
        order.type = 'MARKET';
        order.timeInForce = p.timeInForce.toUpperCase();
        order.priceBound = px(p.limitPrice);
      } else {
        order.type = 'LIMIT';
        order.price = px(p.limitPrice);
        order.timeInForce = p.timeInForce === 'gtc' ? 'GTC' : 'GFD';
        order.triggerCondition = 'DEFAULT';
      }
    } else {
      throw new BrokerError('REJECTED', `${p.type} orders are not supported for OANDA instruments`);
    }
    if (p.protectiveStop) {
      // The stop protects the opened position: for a long it sits below, rounded further away never.
      const stop = roundPrice(p.protectiveStop.price, spec.displayPrecision, p.side === 'buy' ? 'up' : 'down');
      order.stopLossOnFill = {
        price: priceString(stop, spec.displayPrecision),
        timeInForce: 'GTC',
        clientExtensions: { id: p.protectiveStop.clientOrderId, tag: 'scalp-city' },
      };
    }
    const res = await this.http.post<Raw>(`${this.acct}/orders`, { order }, { timeoutMs: 10_000 });
    const create = (res.orderCreateTransaction ?? {}) as Raw;
    const id = String(create.id ?? '');
    if (!id) throw new BrokerError('SERVER', 'OANDA accepted the request but returned no order transaction');
    this.orders.set(id, { instrument: p.symbol, units: Number(units), clientOrderId: p.clientOrderId, filled: 0, type: p.type, dependent: false });
    const t = oandaTime(create.time) ?? this.clock.now();
    let bo: BrokerOrder = {
      id,
      clientOrderId: p.clientOrderId,
      symbol: p.symbol,
      assetClass: 'cfd',
      side: p.side,
      type: p.type,
      timeInForce: p.timeInForce,
      qty: p.qty,
      filledQty: 0,
      filledAvgPrice: null,
      limitPrice: p.limitPrice ?? null,
      stopPrice: null,
      status: 'new',
      positionIntent: p.positionIntent ?? null,
      createdAt: t,
      updatedAt: t,
      submittedAt: t,
      filledAt: null,
      canceledAt: null,
      expiredAt: null,
      failedAt: null,
      extendedHours: false,
      statusReason: null,
    };
    const fill = res.orderFillTransaction as Raw | undefined;
    if (fill) {
      this.noteFill(fill);
      bo = withFill(bo, fill);
    }
    const cancel = res.orderCancelTransaction as Raw | undefined;
    if (cancel) {
      bo = { ...bo, status: bo.filledQty > 0 ? 'canceled' : cancelStatus(cancel.reason), statusReason: String(cancel.reason ?? ''), canceledAt: oandaTime(cancel.time), updatedAt: oandaTime(cancel.time) ?? bo.updatedAt };
    }
    return bo;
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    await this.http.put(`${this.acct}/orders/${encodeURIComponent(brokerOrderId)}/cancel`);
  }

  /**
   * Cancel every pending order except stop losses / take profits attached to
   * open trades: those hold no quantity, vanish when their trade closes, and
   * removing them would leave a position unprotected if closing it fails.
   */
  async cancelAllOrders(): Promise<{ id: string; status: number }[]> {
    const r = await this.http.get<Raw>(`${this.acct}/pendingOrders`);
    const out: { id: string; status: number }[] = [];
    for (const o of (r.orders ?? []) as Raw[]) {
      if (isDependentOrderType(o.type)) continue;
      try {
        await this.cancelOrder(String(o.id));
        out.push({ id: String(o.id), status: 200 });
      } catch (err) {
        out.push({ id: String(o.id), status: err instanceof BrokerError ? (err.status ?? 500) : 500 });
      }
    }
    return out;
  }

  // ── Instruments, prices, conversions ───────────────────────────────────

  async getInstruments(): Promise<BrokerInstrument[]> {
    const r = await this.http.get<Raw>(`${this.acct}/instruments`);
    this.instrumentList = ((r.instruments ?? []) as Raw[]).map(mapInstrument);
    this.instrumentsAt = this.clock.now();
    return this.instrumentList;
  }

  private async instrument(symbol: string): Promise<BrokerInstrument | null> {
    if (!this.instrumentList || this.clock.now() - this.instrumentsAt > 6 * 3_600_000) await this.getInstruments();
    return this.instrumentList!.find((i) => i.symbol === symbol) ?? null;
  }

  /** Account-currency value of a 1.0 price move on one unit (null until known). */
  homeFactor(symbol: string): number | null {
    const quote = symbol.split('_')[1];
    if (!quote) return null;
    if (this.currency && quote === this.currency) return 1;
    const c = this.conversions.get(quote);
    if (!c) return null;
    const f = Math.max(c.positionValue ?? 0, c.accountLoss ?? 0);
    return f > 0 ? f : null;
  }

  /** Latest prices and OANDA's own home-currency conversion factors (also the clock reading). */
  private async refreshPricing(): Promise<{ time: number | null; date: number | null }> {
    const symbols = new Set(this.opts.instruments);
    for (const t of this.trades.values()) symbols.add(t.instrument);
    const r = await this.http.getWithDate<Raw>(`${this.acct}/pricing`, { instruments: [...symbols].join(','), includeHomeConversions: true });
    const body = r.body ?? {};
    for (const p of (body.prices ?? []) as Raw[]) {
      const bid = num(p.bids?.[0]?.price ?? p.closeoutBid);
      const ask = num(p.asks?.[0]?.price ?? p.closeoutAsk);
      if (bid !== null && ask !== null) this.mids.set(String(p.instrument), (bid + ask) / 2);
    }
    for (const c of (body.homeConversions ?? []) as Raw[]) {
      this.conversions.set(String(c.currency), { positionValue: num(c.positionValue), accountLoss: num(c.accountLoss) });
    }
    if (Array.isArray(body.homeConversions)) this.conversionsAt = this.clock.now();
    return { time: oandaTime(body.time), date: r.date };
  }

  // ── Clock & calendar (configured trading window) ───────────────────────

  async getClock(): Promise<BrokerClock> {
    const sent = this.clock.now();
    const r = await this.refreshPricing();
    const receivedAt = this.clock.now();
    // The pricing response's own time is OANDA's clock to the millisecond; the HTTP Date header is
    // only to the second but is unambiguous. If the two disagree by more than 2s the "time" field is
    // not the server's current time (e.g. a stale price on a quiet instrument), so trust the header —
    // a stale price must never look like a server clock problem and halt trading.
    const timestamp = r.time !== null && r.date !== null ? (Math.abs(r.time - r.date) <= 2000 ? r.time : r.date) : (r.time ?? r.date);
    if (timestamp === null) throw new BrokerError('SERVER', 'OANDA pricing response carried no server time');
    const s = sessionClock(timestamp, this.rules);
    return { timestamp, isOpen: s.isOpen, nextOpen: s.nextOpen, nextClose: s.nextClose, receivedAt, rttMs: receivedAt - sent };
  }

  async getCalendar(startDate: string, endDate: string): Promise<BrokerCalendarDay[]> {
    return configuredSessions(startDate, endDate, this.rules);
  }

  // ── Not applicable to OANDA ────────────────────────────────────────────

  async getAsset(symbol: string): Promise<BrokerAsset> {
    const i = await this.instrument(symbol);
    if (!i) throw new BrokerError('NOT_FOUND', `${symbol} is not offered to this account`);
    return { id: i.symbol, symbol: i.symbol, assetClass: 'cfd', exchange: 'OANDA', status: 'active', tradable: true, marginable: true, shortable: true, easyToBorrow: true, fractionable: i.unitsPrecision > 0 };
  }

  async getAssets(params: { assetClass?: AssetClass; status?: 'active' | 'inactive' }): Promise<BrokerAsset[]> {
    if (params.assetClass && params.assetClass !== 'cfd') return [];
    const list = await this.getInstruments();
    return list.map((i) => ({ id: i.symbol, symbol: i.symbol, assetClass: 'cfd', exchange: 'OANDA', status: 'active', tradable: true, marginable: true, shortable: true, easyToBorrow: true, fractionable: i.unitsPrecision > 0 }));
  }

  async getOptionContracts(): Promise<BrokerOptionContract[]> {
    return [];
  }

  async getOptionContract(): Promise<BrokerOptionContract | null> {
    return null;
  }

  // ── Transaction stream → trade updates ─────────────────────────────────

  subscribeTradeUpdates(handler: (update: BrokerTradeUpdate) => void): Unsubscribe {
    this.updateHandlers.add(handler);
    if (!this.streamStarted) {
      this.streamStarted = true;
      this.txStream.start();
    }
    return () => this.updateHandlers.delete(handler);
  }

  onTradeStreamStatus(handler: (status: StreamStatus) => void): Unsubscribe {
    return this.txStream.onStatus(handler);
  }

  tradeStreamStatus(): StreamStatus {
    return this.txStream.getStatus();
  }

  async close(): Promise<void> {
    await this.txStream.stop();
  }

  /** Replay transactions missed while the stream was down. Duplicates are harmless downstream. */
  private async catchUp(): Promise<void> {
    if (this.lastTxId === null || this.catchingUp) return;
    this.catchingUp = true;
    try {
      for (let i = 0; i < 20; i++) {
        const r = await this.http.get<Raw>(`${this.acct}/transactions/sinceid`, { id: this.lastTxId });
        const txs = ((r.transactions ?? []) as Raw[]).sort((a, b) => Number(a.id) - Number(b.id));
        if (txs.length === 0) break;
        for (const tx of txs) this.onTransaction(tx);
      }
    } finally {
      this.catchingUp = false;
    }
  }

  private emit(u: BrokerTradeUpdate): void {
    for (const h of this.updateHandlers) {
      try {
        h(u);
      } catch (err) {
        this.opts.logger.error({ err }, 'trade update handler failed');
      }
    }
  }

  private noteFill(fill: Raw): void {
    const opened = fill.tradeOpened as Raw | undefined;
    if (opened?.tradeID !== undefined) this.trades.set(String(opened.tradeID), { instrument: String(fill.instrument), units: num(opened.units) ?? 0 });
    for (const c of (fill.tradesClosed ?? []) as Raw[]) this.trades.delete(String(c.tradeID));
    const reduced = fill.tradeReduced as Raw | undefined;
    if (reduced?.tradeID !== undefined) {
      const t = this.trades.get(String(reduced.tradeID));
      if (t) t.units += num(reduced.units) ?? 0;
    }
  }

  private baseOrder(id: string, info: OrderInfo | undefined, overrides: Partial<BrokerOrder>): BrokerOrder {
    const units = info?.units ?? null;
    return {
      id,
      clientOrderId: info?.clientOrderId ?? '',
      symbol: info?.instrument ?? '',
      assetClass: 'cfd',
      side: units !== null && units < 0 ? 'sell' : 'buy',
      type: info?.type === 'trailing_stop' ? 'trailing_stop' : (info?.type ?? 'market'),
      timeInForce: 'fok',
      qty: units === null ? null : Math.abs(units),
      filledQty: info?.filled ?? 0,
      filledAvgPrice: null,
      limitPrice: null,
      stopPrice: null,
      status: 'new',
      positionIntent: null,
      createdAt: null,
      updatedAt: null,
      submittedAt: null,
      filledAt: null,
      canceledAt: null,
      expiredAt: null,
      failedAt: null,
      extendedHours: false,
      statusReason: null,
      dependent: info?.dependent ?? false,
      ...overrides,
    };
  }

  private onTransaction(m: Raw): void {
    const type = String(m.type ?? '');
    if (type === 'HEARTBEAT') {
      const last = Number(m.lastTransactionID);
      if (Number.isFinite(last) && this.lastTxId !== null && last > this.lastTxId) void this.catchUp().catch(() => undefined);
      else if (Number.isFinite(last) && this.lastTxId === null) this.lastTxId = last;
      return;
    }
    const txId = Number(m.id);
    if (Number.isFinite(txId)) this.lastTxId = Math.max(this.lastTxId ?? 0, txId);
    const at = oandaTime(m.time) ?? this.clock.now();

    switch (type) {
      case 'MARKET_ORDER':
      case 'LIMIT_ORDER':
      case 'STOP_ORDER':
      case 'MARKET_IF_TOUCHED_ORDER': {
        const units = num(m.units);
        const info: OrderInfo = {
          instrument: String(m.instrument ?? ''),
          units,
          clientOrderId: String(m.clientExtensions?.id ?? ''),
          filled: this.orders.get(String(m.id))?.filled ?? 0,
          type: type === 'LIMIT_ORDER' ? 'limit' : type === 'MARKET_ORDER' ? 'market' : 'stop',
          dependent: false,
        };
        this.orders.set(String(m.id), info);
        this.emit({ event: 'new', executionId: null, order: this.baseOrder(String(m.id), info, { createdAt: at, updatedAt: at, submittedAt: at }), timestamp: at, positionQty: null, price: null, qty: null });
        return;
      }
      case 'STOP_LOSS_ORDER':
      case 'TAKE_PROFIT_ORDER':
      case 'TRAILING_STOP_LOSS_ORDER':
      case 'GUARANTEED_STOP_LOSS_ORDER': {
        const trade = this.trades.get(String(m.tradeID));
        const info: OrderInfo = {
          instrument: trade?.instrument ?? '',
          units: trade ? -trade.units : null,
          clientOrderId: String(m.clientExtensions?.id ?? ''),
          filled: 0,
          type: type === 'TAKE_PROFIT_ORDER' ? 'limit' : type === 'TRAILING_STOP_LOSS_ORDER' ? 'trailing_stop' : 'stop',
          dependent: true,
        };
        this.orders.set(String(m.id), info);
        this.emit({
          event: 'new',
          executionId: null,
          order: this.baseOrder(String(m.id), info, { timeInForce: 'gtc', stopPrice: info.type === 'stop' ? num(m.price) : null, limitPrice: info.type === 'limit' ? num(m.price) : null, createdAt: at, updatedAt: at, submittedAt: at }),
          timestamp: at,
          positionQty: null,
          price: null,
          qty: null,
        });
        return;
      }
      case 'ORDER_FILL': {
        this.noteFill(m);
        const orderId = String(m.orderID);
        const units = Math.abs(num(m.units) ?? 0);
        const info = this.orders.get(orderId);
        const merged: OrderInfo = info
          ? { ...info, filled: info.filled + units, instrument: info.instrument || String(m.instrument) }
          : { instrument: String(m.instrument), units: num(m.units), clientOrderId: String(m.clientOrderID ?? ''), filled: units, type: 'market', dependent: false };
        if (!merged.clientOrderId && m.clientOrderID) merged.clientOrderId = String(m.clientOrderID);
        this.orders.set(orderId, merged);
        const requested = merged.units === null ? null : Math.abs(merged.units);
        const done = requested === null || merged.filled >= requested - 1e-9;
        const price = fillPrice(m);
        this.emit({
          event: done ? 'fill' : 'partial_fill',
          executionId: String(m.id),
          order: this.baseOrder(orderId, merged, {
            side: (num(m.units) ?? 0) < 0 ? 'sell' : 'buy',
            qty: requested ?? merged.filled,
            filledQty: merged.filled,
            filledAvgPrice: price,
            status: done ? 'filled' : 'partially_filled',
            filledAt: done ? at : null,
            updatedAt: at,
          }),
          timestamp: at,
          positionQty: null,
          price,
          qty: units,
          realizedPl: fillRealized(m),
        });
        return;
      }
      case 'ORDER_CANCEL': {
        const orderId = String(m.orderID);
        const info = this.orders.get(orderId);
        const status = (info?.filled ?? 0) > 0 ? 'canceled' : cancelStatus(m.reason);
        const merged = info ?? { instrument: '', units: null, clientOrderId: String(m.clientOrderID ?? ''), filled: 0, type: 'market' as const, dependent: false };
        if (!merged.clientOrderId && m.clientOrderID) merged.clientOrderId = String(m.clientOrderID);
        this.emit({
          event: status === 'expired' ? 'expired' : status === 'rejected' ? 'rejected' : 'canceled',
          executionId: null,
          order: this.baseOrder(orderId, merged, { status, statusReason: String(m.reason ?? ''), canceledAt: at, updatedAt: at }),
          timestamp: at,
          positionQty: null,
          price: null,
          qty: null,
        });
        return;
      }
      case 'ORDER_CANCEL_REJECT': {
        const orderId = String(m.orderID);
        const info = this.orders.get(orderId);
        this.emit({
          event: 'order_cancel_rejected',
          executionId: null,
          order: this.baseOrder(orderId, info ?? { instrument: '', units: null, clientOrderId: String(m.clientOrderID ?? ''), filled: 0, type: 'market', dependent: false }, { status: 'new', statusReason: String(m.rejectReason ?? ''), updatedAt: at }),
          timestamp: at,
          positionQty: null,
          price: null,
          qty: null,
        });
        return;
      }
      case 'MARKET_ORDER_REJECT':
      case 'LIMIT_ORDER_REJECT':
      case 'STOP_ORDER_REJECT':
      case 'MARKET_IF_TOUCHED_ORDER_REJECT': {
        // A refused request creates no order; its client id still tells us whose it was.
        const clientOrderId = String(m.clientExtensions?.id ?? '');
        if (!clientOrderId) return;
        const units = num(m.units);
        this.emit({
          event: 'rejected',
          executionId: null,
          order: this.baseOrder(`reject-${m.id}`, { instrument: String(m.instrument ?? ''), units, clientOrderId, filled: 0, type: 'market', dependent: false }, { status: 'rejected', statusReason: String(m.rejectReason ?? ''), updatedAt: at }),
          timestamp: at,
          positionQty: null,
          price: null,
          qty: null,
        });
        return;
      }
      default:
        return;
    }
  }
}
