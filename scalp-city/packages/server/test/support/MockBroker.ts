import { randomUUID } from 'node:crypto';
import { isOccSymbol, type AssetClass, type TradingEnvironment } from '@scalp-city/shared';
import {
  BrokerError,
  type BrokerAccount,
  type BrokerAdapter,
  type BrokerAsset,
  type BrokerCalendarDay,
  type BrokerClock,
  type BrokerOptionContract,
  type BrokerOrder,
  type BrokerPosition,
  type BrokerTradeUpdate,
  type OptionContractQuery,
  type StreamStatus,
  type SubmitOrderParams,
} from '../../src/broker/types.js';
import { account as defaultAccount } from './riskFixtures.js';

export type SubmitBehavior = 'accept' | 'reject' | 'timeout-created' | 'timeout-not-created' | 'server-error-created';

/**
 * In-memory broker for automated tests (spec §69). Behaves like the Alpaca
 * Trading API at the adapter boundary: orders, fills via trade updates,
 * cancels, rejections, and failure modes such as a timeout after the order
 * was actually created. Test-only — never wired into the runtime.
 */
export class MockBroker implements BrokerAdapter {
  readonly name = 'ALPACA' as const;
  readonly venue = 'alpaca' as const;
  readonly calendarSource = 'exchange' as const;
  readonly endpoint = 'mock://broker';
  account: BrokerAccount = defaultAccount();
  positions: BrokerPosition[] = [];
  orders = new Map<string, BrokerOrder>();
  contracts: BrokerOptionContract[] = [];
  submitBehavior: SubmitBehavior = 'accept';
  rejectMessage = 'insufficient buying power';
  cancelBehavior: 'ok' | 'refuse' = 'ok';
  submitCalls: SubmitOrderParams[] = [];
  now = () => Date.now();
  private handlers = new Set<(u: BrokerTradeUpdate) => void>();
  private statusHandlers = new Set<(s: StreamStatus) => void>();
  streamStatus: StreamStatus = { state: 'CONNECTED', since: Date.now(), lastMessageAt: null, reconnectAttempts: 0, lastError: null };

  constructor(readonly env: TradingEnvironment = 'paper') {}

  async getAccount() {
    return { ...this.account };
  }
  async getPositions() {
    return this.positions.map((p) => ({ ...p }));
  }
  async getOrders(params: { status: 'open' | 'closed' | 'all' }) {
    const open = new Set(['new', 'accepted', 'pending_new', 'partially_filled', 'pending_cancel']);
    return [...this.orders.values()]
      .filter((o) => params.status === 'all' || (params.status === 'open' ? open.has(o.status) : !open.has(o.status)))
      .map((o) => ({ ...o }));
  }
  async getOrder(id: string) {
    const o = this.orders.get(id);
    if (!o) throw new BrokerError('NOT_FOUND', 'order not found', { status: 404 });
    return { ...o };
  }
  async getOrderByClientId(coid: string) {
    for (const o of this.orders.values()) if (o.clientOrderId === coid) return { ...o };
    return null;
  }
  async getAsset(symbol: string): Promise<BrokerAsset> {
    return { id: symbol, symbol, assetClass: 'us_equity', exchange: 'NASDAQ', status: 'active', tradable: true, marginable: true, shortable: true, easyToBorrow: true, fractionable: true };
  }
  async getAssets() {
    return [];
  }

  async submitOrder(p: SubmitOrderParams): Promise<BrokerOrder> {
    this.submitCalls.push({ ...p });
    for (const o of this.orders.values()) {
      if (o.clientOrderId === p.clientOrderId) throw new BrokerError('REJECTED', 'client_order_id must be unique', { status: 422 });
    }
    if (this.submitBehavior === 'reject') throw new BrokerError('REJECTED', this.rejectMessage, { status: 403 });
    if (this.submitBehavior === 'timeout-not-created') throw new BrokerError('TIMEOUT', 'POST /v2/orders: timed out');
    const t = this.now();
    const assetClass: AssetClass = isOccSymbol(p.symbol) ? 'us_option' : 'us_equity';
    const o: BrokerOrder = {
      id: randomUUID(),
      clientOrderId: p.clientOrderId,
      symbol: p.symbol,
      assetClass,
      side: p.side,
      type: p.type,
      timeInForce: p.timeInForce,
      qty: p.qty,
      filledQty: 0,
      filledAvgPrice: null,
      limitPrice: p.limitPrice ?? null,
      stopPrice: p.stopPrice ?? null,
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
    };
    this.orders.set(o.id, o);
    if (this.submitBehavior === 'timeout-created') throw new BrokerError('TIMEOUT', 'POST /v2/orders: timed out');
    if (this.submitBehavior === 'server-error-created') throw new BrokerError('SERVER', 'HTTP 504', { status: 504 });
    return { ...o };
  }

  async cancelOrder(id: string): Promise<void> {
    const o = this.orders.get(id);
    if (!o) throw new BrokerError('NOT_FOUND', 'order not found', { status: 404 });
    if (this.cancelBehavior === 'refuse' || o.status === 'filled' || o.status === 'canceled') {
      throw new BrokerError('REJECTED', `order is not cancelable (status ${o.status})`, { status: 422 });
    }
    o.status = 'pending_cancel';
    o.updatedAt = this.now();
  }

  async cancelAllOrders() {
    const out: { id: string; status: number }[] = [];
    for (const o of this.orders.values()) {
      if (['new', 'accepted', 'partially_filled'].includes(o.status)) {
        o.status = 'canceled';
        o.canceledAt = this.now();
        o.updatedAt = this.now();
        this.emit('canceled', o);
        out.push({ id: o.id, status: 200 });
      }
    }
    return out;
  }

  async getOptionContracts(q: OptionContractQuery) {
    return this.contracts.filter((c) => c.underlyingSymbol === q.underlying && (!q.type || c.type === q.type));
  }
  async getOptionContract(symbol: string) {
    return this.contracts.find((c) => c.symbol === symbol) ?? null;
  }
  async getClock(): Promise<BrokerClock> {
    const t = this.now();
    return { timestamp: t, isOpen: true, nextOpen: t + 86_400_000, nextClose: t + 3_600_000, receivedAt: t, rttMs: 0 };
  }
  async getCalendar(): Promise<BrokerCalendarDay[]> {
    return [];
  }

  subscribeTradeUpdates(handler: (u: BrokerTradeUpdate) => void) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  onTradeStreamStatus(handler: (s: StreamStatus) => void) {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }
  tradeStreamStatus() {
    return { ...this.streamStatus };
  }
  async close() {}

  // ── Test controls ───────────────────────────────────────────────────────

  findByClientId(coid: string): BrokerOrder {
    for (const o of this.orders.values()) if (o.clientOrderId === coid) return o;
    throw new Error(`no broker order for ${coid}`);
  }

  emit(event: string, o: BrokerOrder, extra: Partial<BrokerTradeUpdate> = {}): BrokerTradeUpdate {
    const u: BrokerTradeUpdate = { event, executionId: null, order: { ...o }, timestamp: this.now(), positionQty: null, price: null, qty: null, ...extra };
    for (const h of this.handlers) h(u);
    return u;
  }

  /** Simulate an execution of `qty` at `price`; emits partial_fill or fill and updates positions. */
  fill(coid: string, qty: number, price: number, executionId: string = randomUUID()): BrokerTradeUpdate {
    const o = this.findByClientId(coid);
    const prevQty = o.filledQty;
    const prevAvg = o.filledAvgPrice ?? 0;
    o.filledQty = prevQty + qty;
    o.filledAvgPrice = (prevAvg * prevQty + price * qty) / o.filledQty;
    o.status = o.filledQty >= (o.qty ?? 0) ? 'filled' : 'partially_filled';
    o.updatedAt = this.now();
    if (o.status === 'filled') o.filledAt = this.now();
    this.applyPosition(o, qty, price);
    return this.emit(o.status === 'filled' ? 'fill' : 'partial_fill', o, { executionId, price, qty });
  }

  confirmCancel(coid: string): BrokerTradeUpdate {
    const o = this.findByClientId(coid);
    o.status = 'canceled';
    o.canceledAt = this.now();
    o.updatedAt = this.now();
    return this.emit('canceled', o);
  }

  private applyPosition(o: BrokerOrder, qty: number, price: number): void {
    const signed = o.side === 'buy' ? qty : -qty;
    const mult = o.assetClass === 'us_option' ? 100 : 1;
    const p = this.positions.find((x) => x.symbol === o.symbol);
    if (!p) {
      this.positions.push({
        symbol: o.symbol,
        assetId: null,
        assetClass: o.assetClass,
        side: signed > 0 ? 'long' : 'short',
        qty: Math.abs(signed),
        qtyAvailable: Math.abs(signed),
        avgEntryPrice: price,
        costBasis: Math.abs(signed) * price * mult,
        marketValue: Math.abs(signed) * price * mult,
        currentPrice: price,
        lastdayPrice: price,
        changeToday: 0,
        unrealizedPl: 0,
        unrealizedPlpc: 0,
        unrealizedIntradayPl: 0,
        unrealizedIntradayPlpc: 0,
      });
      return;
    }
    const cur = p.side === 'long' ? p.qty : -p.qty;
    const next = cur + signed;
    if (next === 0) {
      this.positions = this.positions.filter((x) => x !== p);
      return;
    }
    if (Math.sign(next) === Math.sign(cur) && Math.abs(next) > Math.abs(cur)) {
      p.avgEntryPrice = (p.avgEntryPrice * Math.abs(cur) + price * qty) / Math.abs(next);
    }
    p.qty = Math.abs(next);
    p.qtyAvailable = p.qty;
    p.side = next > 0 ? 'long' : 'short';
    p.marketValue = p.qty * price * mult;
    p.currentPrice = price;
  }
}
