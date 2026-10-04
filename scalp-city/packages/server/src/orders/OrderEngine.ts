import {
  LIVE_ORDER_STATES,
  SUPPORTED_ORDER_TYPES,
  type CityEvent,
  type OrderState,
  type OrderView,
  type RejectedBy,
  type RiskDecisionView,
  type TradingEnvironment,
} from '@scalp-city/shared';
import type { AuditLog } from '../audit/AuditLog.js';
import { BrokerError, type BrokerAdapter, type BrokerOrder, type BrokerTradeUpdate } from '../broker/types.js';
import type { Clock } from '../core/clock.js';
import { sleep } from '../core/clock.js';
import type { EventBus } from '../core/eventBus.js';
import { newClientOrderId, newId } from '../core/ids.js';
import type { Logger } from '../core/logger.js';
import { Mutex } from '../core/mutex.js';
import { iso, type Db } from '../db/db.js';
import { nyDate } from '../market/MarketCalendar.js';
import type { FillEffect, PositionLedger } from '../positions/PositionLedger.js';
import { evaluateRisk, isOpening, type ProposedOrder, type RiskState } from '../risk/RiskEngine.js';
import type { Alerts, Timeline } from '../system/Timeline.js';
import { OrderRepository, UniqueViolation } from './OrderRepository.js';
import { fillDeltaPrice, isTerminal, nextState } from './stateMachine.js';
import type { OrderRecord, OrderRequest } from './types.js';

/** Supplies the risk engine's view of the world for one proposed order. */
export interface RiskContextProvider {
  /** Async lookups done before taking the submission lock (asset info, contract, signal reuse). */
  prefetch(order: ProposedOrder): Promise<unknown>;
  /** Synchronous snapshot built inside the lock, so concurrent orders see each other. */
  build(order: ProposedOrder, prefetched: unknown, engine: OrderEngine): RiskState;
}

export interface BreakerSignals {
  brokerRejected(reason: string): void;
  apiError(reason: string): void;
}

export interface OrderEngineDeps {
  env: TradingEnvironment;
  broker: BrokerAdapter;
  db: Db;
  ledger: PositionLedger;
  bus: EventBus;
  audit: AuditLog;
  timeline: Timeline;
  alerts: Alerts;
  clock: Clock;
  logger: Logger;
  risk: RiskContextProvider;
  breakers: BreakerSignals;
  /** Account day P&L (broker numbers) for journal context. */
  dailyPnl: () => number | null;
  /** Called after fills so account/positions refresh quickly. */
  onFills: () => void;
  /** Delays between attempts to resolve an order whose submission outcome is unknown. */
  resolutionDelaysMs?: number[];
}

export function validateOrder(o: OrderRecord): string | null {
  if (!Number.isInteger(o.qty) || o.qty <= 0) return 'quantity must be a positive whole number';
  if (!SUPPORTED_ORDER_TYPES[o.assetClass].includes(o.type)) return `${o.type} orders are not supported for ${o.assetClass}`;
  if (o.assetClass === 'us_option' && o.timeInForce !== 'day') return 'options orders must be DAY orders';
  if ((o.type === 'limit' || o.type === 'stop_limit') && !(o.limitPrice !== null && o.limitPrice > 0)) return 'limit price required';
  if ((o.type === 'stop' || o.type === 'stop_limit') && !(o.stopPrice !== null && o.stopPrice > 0)) return 'stop price required';
  if (o.type === 'market' && (o.limitPrice !== null || o.stopPrice !== null)) return 'market orders take no prices';
  if (!/^[A-Z0-9.]{1,21}$/.test(o.symbol)) return 'invalid symbol';
  return null;
}

/**
 * Order lifecycle owner (spec §8, §110). Guarantees:
 *  - every order passes the RiskEngine; there is no other path to the broker
 *  - an order is persisted as SUBMITTING *before* the broker call
 *  - a submission with an unknown outcome is resolved by client order id and
 *    is never blindly resubmitted
 *  - fills come only from broker evidence, deduplicated, applied
 *    transactionally with the position ledger
 */
export class OrderEngine {
  private readonly repo: OrderRepository;
  private orders = new Map<string, OrderRecord>();
  private byClient = new Map<string, string>();
  private byBroker = new Map<string, string>();
  private lock = new Mutex();
  private submissions: number[] = [];
  private externalSeen = new Set<string>();
  private resolving = new Set<string>();

  constructor(private readonly d: OrderEngineDeps) {
    this.repo = new OrderRepository(d.db);
  }

  get repository(): OrderRepository {
    return this.repo;
  }

  async load(): Promise<void> {
    const since = this.d.clock.now() - 36 * 3_600_000;
    for (const o of await this.repo.loadWorkingSet(this.d.env, since)) this.track(o);
  }

  private track(o: OrderRecord): void {
    this.orders.set(o.id, o);
    this.byClient.set(o.clientOrderId, o.id);
    if (o.brokerOrderId) this.byBroker.set(o.brokerOrderId, o.id);
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  get(id: string): OrderRecord | null {
    return this.orders.get(id) ?? null;
  }

  byClientOrderId(clientOrderId: string): OrderRecord | null {
    const id = this.byClient.get(clientOrderId);
    return id ? (this.orders.get(id) ?? null) : null;
  }

  /** Orders that may still produce fills. */
  openOrders(): OrderRecord[] {
    return [...this.orders.values()].filter((o) => LIVE_ORDER_STATES.has(o.state) || o.state === 'ERROR' || o.state === 'CREATED' || o.state === 'VALIDATING' || o.state === 'RISK_CHECK');
  }

  /** Orders that can still fill at the broker (excludes not-yet-submitted). */
  workingOrders(): OrderRecord[] {
    return [...this.orders.values()].filter((o) => LIVE_ORDER_STATES.has(o.state));
  }

  /**
   * Exposure the risk engine must account for: everything that can still
   * fill, plus recent unknown-outcome orders (ERROR) — conservatively treated
   * as possibly live for ten minutes. Drafts awaiting their own risk check
   * are excluded; only one order is ever inside the check at a time.
   */
  riskOpenOrders(): OrderRecord[] {
    const now = this.d.clock.now();
    return [...this.orders.values()].filter((o) => LIVE_ORDER_STATES.has(o.state) || (o.state === 'ERROR' && now - o.updatedAt < 10 * 60_000));
  }

  recent(limit = 100): OrderRecord[] {
    return [...this.orders.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  ordersLastMinute(): number {
    const cutoff = this.d.clock.now() - 60_000;
    this.submissions = this.submissions.filter((t) => t >= cutoff);
    return this.submissions.length;
  }

  /**
   * Opening orders today that reached the broker and filled (trades taken),
   * plus those still working — what "trades per day" limits count.
   */
  entriesToday(workerId?: string | null): number {
    const today = nyDate(this.d.clock.now());
    let count = 0;
    for (const o of this.orders.values()) {
      if (!isOpening(o.purpose)) continue;
      if (workerId !== undefined && o.workerId !== workerId) continue;
      if (nyDate(o.createdAt) !== today) continue;
      if (o.filledQty > 0 || LIVE_ORDER_STATES.has(o.state)) count++;
    }
    return count;
  }

  view(o: OrderRecord): OrderView {
    return {
      id: o.id,
      clientOrderId: o.clientOrderId,
      brokerOrderId: o.brokerOrderId,
      env: o.env,
      workerId: o.workerId,
      source: o.source,
      purpose: o.purpose,
      signalId: o.signalId,
      symbol: o.symbol,
      underlying: o.underlying,
      assetClass: o.assetClass,
      side: o.side,
      positionIntent: o.positionIntent,
      type: o.type,
      timeInForce: o.timeInForce,
      qty: o.qty,
      limitPrice: o.limitPrice,
      stopPrice: o.stopPrice,
      state: o.state,
      brokerStatus: o.brokerStatus,
      filledQty: o.filledQty,
      filledAvgPrice: o.filledAvgPrice,
      rejectedBy: o.rejectedBy,
      rejectReason: o.rejectReason,
      errorMessage: o.errorMessage,
      createdAt: o.createdAt,
      submittedAt: o.submittedAt,
      updatedAt: o.updatedAt,
      filledAt: o.filledAt,
      risk: o.risk,
      cancelable: o.brokerOrderId !== null && (o.state === 'SUBMITTED' || o.state === 'ACCEPTED' || o.state === 'PARTIALLY_FILLED'),
    };
  }

  // ── Risk dry-run (used by the manual order preview) ───────────────────

  async previewRisk(req: OrderRequest): Promise<RiskDecisionView> {
    const draft = this.draft(req);
    const proposed = this.proposed(draft, req);
    const pre = await this.d.risk.prefetch(proposed);
    return this.lock.run(async () => evaluateRisk(proposed, this.d.risk.build(proposed, pre, this)));
  }

  // ── Submission ──────────────────────────────────────────────────────────

  private draft(req: OrderRequest): OrderRecord {
    const now = this.d.clock.now();
    return {
      id: newId('ord'),
      env: this.d.env,
      clientOrderId: newClientOrderId(this.d.env, req.purpose),
      brokerOrderId: null,
      workerId: req.workerId,
      source: req.source,
      purpose: req.purpose,
      signalId: req.signalId,
      tradeId: null,
      symbol: req.symbol,
      underlying: req.underlying,
      assetClass: req.assetClass,
      side: req.side,
      positionIntent: req.positionIntent,
      type: req.type,
      timeInForce: req.timeInForce,
      qty: req.qty,
      limitPrice: req.limitPrice,
      stopPrice: req.stopPrice,
      state: 'CREATED',
      brokerStatus: null,
      filledQty: 0,
      filledAvgPrice: null,
      rejectedBy: null,
      rejectReason: null,
      errorMessage: null,
      risk: null,
      meta: { ...req.meta, requestedBy: req.actor, dailyPnlBefore: req.meta.dailyPnlBefore ?? this.d.dailyPnl() },
      createdAt: now,
      submittedAt: null,
      updatedAt: now,
      filledAt: null,
    };
  }

  private proposed(o: OrderRecord, req: OrderRequest & { signalBarCloseAt?: number | null; referencePrice?: number | null }): ProposedOrder {
    return {
      orderId: o.id,
      purpose: o.purpose,
      source: o.source,
      workerId: o.workerId,
      signalId: o.signalId,
      signalBarCloseAt: req.signalBarCloseAt ?? null,
      symbol: o.symbol,
      underlying: o.underlying ?? (o.assetClass === 'us_equity' ? o.symbol : null),
      assetClass: o.assetClass,
      side: o.side,
      qty: o.qty,
      type: o.type,
      limitPrice: o.limitPrice,
      stopPrice: o.stopPrice,
      multiplier: o.meta.multiplier,
      referencePrice: req.referencePrice ?? null,
    };
  }

  /**
   * Submit an order. Always returns the order record (inspect `.state`);
   * never throws for business outcomes like risk or broker rejections.
   */
  async submit(req: OrderRequest & { signalBarCloseAt?: number | null; referencePrice?: number | null }): Promise<OrderRecord> {
    const order = this.draft(req);
    const log = this.d.logger.child({ worker: order.workerId ?? undefined, symbol: order.symbol, clientOrderId: order.clientOrderId });

    try {
      await this.repo.insert(order);
    } catch (err) {
      if (err instanceof UniqueViolation) {
        order.state = 'REJECTED';
        order.rejectedBy = 'VALIDATION';
        order.rejectReason = 'duplicate signal — an order already exists for this signal';
        log.warn('duplicate signal submission refused by database constraint');
        void this.d.audit.record({ action: 'RISK_BLOCK', actor: req.actor, env: this.d.env, workerId: order.workerId, symbol: order.symbol, details: { reason: order.rejectReason, signalId: order.signalId } });
        return order;
      }
      throw err;
    }
    this.track(order);
    this.d.bus.emit('ORDER_UPDATED', { order, prevState: null });
    void this.d.audit.record({
      action: 'ORDER_REQUESTED',
      actor: req.actor,
      env: this.d.env,
      workerId: order.workerId,
      symbol: order.symbol,
      orderId: order.id,
      clientOrderId: order.clientOrderId,
      details: { purpose: order.purpose, side: order.side, qty: order.qty, type: order.type, limitPrice: order.limitPrice, signalId: order.signalId },
    });

    const proposed = this.proposed(order, req);
    let prefetched: unknown;
    try {
      prefetched = await this.d.risk.prefetch(proposed);
    } catch (err) {
      await this.lock.run(() => this.reject(order, 'RISK', `risk data unavailable: ${(err as Error).message}`));
      return order;
    }

    // Validation, risk and the write-ahead to SUBMITTING happen under one
    // lock, so concurrent orders always see each other's exposure.
    await this.lock.run(async () => {
      await this.transition(order, 'VALIDATING');
      const invalid = validateOrder(order);
      if (invalid) {
        await this.reject(order, 'VALIDATION', invalid);
        return;
      }
      await this.transition(order, 'RISK_CHECK');
      const decision = evaluateRisk(proposed, this.d.risk.build(proposed, prefetched, this));
      order.risk = decision;
      await this.recordRisk(order, decision);
      if (!decision.approved) {
        this.d.bus.emit('RISK_REJECTED', { order, decision });
        await this.reject(order, 'RISK', decision.blockedBy ? `${decision.blockedBy.label}: ${decision.blockedBy.detail}` : 'risk check failed');
        return;
      }
      this.d.bus.emit('RISK_APPROVED', { order, decision });
      await this.transition(order, 'SUBMITTING');
      this.submissions.push(this.d.clock.now());
    });
    if (order.state !== 'SUBMITTING') return order;

    // Exactly one submission attempt.
    try {
      const bo = await this.d.broker.submitOrder({
        clientOrderId: order.clientOrderId,
        symbol: order.symbol,
        qty: order.qty,
        side: order.side,
        type: order.type,
        timeInForce: order.timeInForce,
        limitPrice: order.limitPrice,
        stopPrice: order.stopPrice,
        positionIntent: order.positionIntent,
      });
      await this.applyBroker(order, bo, { event: 'submit_response', eventKey: `submit:${order.id}`, at: this.d.clock.now(), update: null });
      void this.d.audit.record({
        action: 'ORDER_SUBMITTED',
        actor: req.actor,
        env: this.d.env,
        workerId: order.workerId,
        symbol: order.symbol,
        orderId: order.id,
        clientOrderId: order.clientOrderId,
        details: { brokerOrderId: bo.id, brokerStatus: bo.status },
      });
      this.d.timeline.add({ kind: 'order', workerId: order.workerId, symbol: order.symbol, title: `Order submitted · ${order.side.toUpperCase()} ${order.qty} ${order.symbol}`, detail: `${order.type}${order.limitPrice ? ` @ ${order.limitPrice}` : ''} · ${bo.status}` });
      this.city('ORDER_SUBMITTED', order, null, null);
    } catch (err) {
      if (err instanceof BrokerError && !err.ambiguous) {
        await this.lock.run(() => this.reject(order, 'BROKER', err.message));
        this.d.breakers.brokerRejected(err.message);
      } else {
        const msg = (err as Error).message;
        log.error({ err: msg }, 'order submission outcome unknown; resolving by client order id');
        this.d.breakers.apiError(`order submission: ${msg}`);
        await this.lock.run(async () => {
          order.errorMessage = `submission outcome unknown (${msg}) — checking broker by client order id`;
          order.updatedAt = this.d.clock.now();
          await this.repo.update(this.d.db, order);
          this.d.bus.emit('ORDER_UPDATED', { order, prevState: order.state });
        });
        void this.resolve(order);
      }
    }
    return order;
  }

  /**
   * Resolve an order whose submission outcome is unknown: poll the broker by
   * client order id. If it exists, adopt it. If it never appears, mark ERROR.
   * Never resubmits.
   */
  async resolve(order: OrderRecord): Promise<void> {
    if (this.resolving.has(order.id)) return;
    this.resolving.add(order.id);
    try {
      const delays = this.d.resolutionDelaysMs ?? [1000, 2000, 4000, 8000, 15_000];
      for (const delay of delays) {
        await sleep(delay);
        if (order.state !== 'SUBMITTING' && order.state !== 'ERROR') return; // the stream answered first
        let bo: BrokerOrder | null;
        try {
          bo = await this.d.broker.getOrderByClientId(order.clientOrderId);
        } catch {
          continue;
        }
        order.meta.resolutionAttempts = (order.meta.resolutionAttempts ?? 0) + 1;
        if (bo) {
          await this.applyBroker(order, bo, { event: 'resolved', eventKey: `resolve:${order.id}:${bo.status}:${bo.filledQty}`, at: this.d.clock.now(), update: null });
          void this.d.audit.record({ action: 'ORDER_RESOLVED', actor: 'system', env: this.d.env, workerId: order.workerId, symbol: order.symbol, orderId: order.id, clientOrderId: order.clientOrderId, details: { brokerOrderId: bo.id, status: bo.status } });
          return;
        }
      }
      if (order.state === 'SUBMITTING') {
        await this.lock.run(async () => {
          order.errorMessage = 'broker has no order with this client order id after resolution window — treated as NOT submitted; not retried';
          await this.transition(order, 'ERROR');
        });
        void this.d.audit.record({ action: 'ORDER_ERROR', actor: 'system', env: this.d.env, workerId: order.workerId, symbol: order.symbol, orderId: order.id, clientOrderId: order.clientOrderId, details: { reason: order.errorMessage } });
        this.d.alerts.raise('ORDER_REJECTED', 'error', 'Order outcome unknown', `${order.symbol}: ${order.errorMessage}`);
      }
    } finally {
      this.resolving.delete(order.id);
    }
  }

  // ── Cancellation ────────────────────────────────────────────────────────

  /** Ask the broker to cancel. CANCELED is only set when the broker confirms. */
  async cancel(orderId: string, actor: string): Promise<{ ok: boolean; message: string }> {
    const order = this.orders.get(orderId);
    if (!order) return { ok: false, message: 'unknown order' };
    if (isTerminal(order.state)) return { ok: false, message: `order already ${order.state}` };
    if (!order.brokerOrderId) {
      const bo = await this.d.broker.getOrderByClientId(order.clientOrderId).catch(() => null);
      if (!bo) return { ok: false, message: 'order is not at the broker yet' };
      await this.applyBroker(order, bo, { event: 'sync', eventKey: `sync:${bo.id}:${bo.status}:${bo.filledQty}:${bo.updatedAt}`, at: this.d.clock.now(), update: null });
      if (isTerminal(order.state)) return { ok: false, message: `order already ${order.state}` };
    }
    void this.d.audit.record({ action: 'ORDER_CANCEL_REQUESTED', actor, env: this.d.env, workerId: order.workerId, symbol: order.symbol, orderId: order.id, clientOrderId: order.clientOrderId });
    try {
      await this.d.broker.cancelOrder(order.brokerOrderId!);
    } catch (err) {
      const message = err instanceof BrokerError ? err.message : (err as Error).message;
      await this.lock.run(async () => {
        order.meta.cancelError = message;
        order.updatedAt = this.d.clock.now();
        await this.repo.update(this.d.db, order);
        this.d.bus.emit('ORDER_UPDATED', { order, prevState: order.state });
      });
      void this.d.audit.record({ action: 'ORDER_CANCEL_FAILED', actor, env: this.d.env, workerId: order.workerId, symbol: order.symbol, orderId: order.id, clientOrderId: order.clientOrderId, details: { broker: message } });
      this.d.timeline.add({ kind: 'order', severity: 'warn', workerId: order.workerId, symbol: order.symbol, title: 'Cancel refused by broker', detail: message });
      return { ok: false, message: `broker refused cancel: ${message}` };
    }
    await this.lock.run(async () => {
      if (!isTerminal(order.state) && order.state !== 'CANCEL_PENDING') await this.transition(order, 'CANCEL_PENDING');
    });
    return { ok: true, message: 'cancel requested — awaiting broker confirmation' };
  }

  /** Cancel every working order this engine placed. */
  async cancelAllWorking(actor: string): Promise<{ requested: number; failed: string[] }> {
    const failed: string[] = [];
    const working = this.workingOrders();
    for (const o of working) {
      const r = await this.cancel(o.id, actor);
      if (!r.ok) failed.push(`${o.symbol} ${o.clientOrderId}: ${r.message}`);
    }
    return { requested: working.length, failed };
  }

  // ── Broker evidence ─────────────────────────────────────────────────────

  async onTradeUpdate(u: BrokerTradeUpdate): Promise<void> {
    let order = this.byClientOrderId(u.order.clientOrderId) ?? this.orders.get(this.byBroker.get(u.order.id) ?? '') ?? null;
    if (!order) {
      // Possibly ours but outside the working set.
      const { rows } = await this.d.db.query('SELECT id FROM orders WHERE client_order_id = $1', [u.order.clientOrderId]);
      if (rows.length) {
        const recent = await this.repo.loadWorkingSet(this.d.env, this.d.clock.now() - 7 * 86_400_000);
        for (const o of recent) if (!this.orders.has(o.id)) this.track(o);
        order = this.byClientOrderId(u.order.clientOrderId);
      }
    }
    if (!order) {
      this.noteExternal(u.order);
      return;
    }
    const eventKey = u.executionId ? `exec:${u.executionId}` : `${u.order.id}:${u.event}:${u.timestamp}:${u.order.filledQty}`;
    await this.applyBroker(order, u.order, { event: u.event, eventKey, at: u.timestamp, update: u });
    if (u.event === 'order_cancel_rejected') {
      this.d.timeline.add({ kind: 'order', severity: 'warn', workerId: order.workerId, symbol: order.symbol, title: 'Cancel rejected by broker', detail: `order is ${u.order.status}` });
    }
  }

  private noteExternal(bo: BrokerOrder): void {
    if (this.externalSeen.has(bo.id)) return;
    this.externalSeen.add(bo.id);
    this.d.logger.warn({ brokerOrderId: bo.id, symbol: bo.symbol, status: bo.status }, 'order not placed by Scalp City seen on the account');
    void this.d.audit.record({ action: 'EXTERNAL_ORDER_SEEN', actor: 'system', env: this.d.env, symbol: bo.symbol, details: { brokerOrderId: bo.id, side: bo.side, qty: bo.qty, status: bo.status } });
    this.d.timeline.add({ kind: 'alert', severity: 'warn', symbol: bo.symbol, title: 'External order on account', detail: `${bo.side} ${bo.qty ?? ''} ${bo.symbol} (${bo.status}) — not placed by Scalp City` });
  }

  /** Re-check every order that may still change against the broker (restart, reconnect, safety net). */
  async syncNonTerminal(): Promise<void> {
    const candidates = [...this.orders.values()].filter((o) => !isTerminal(o.state) && o.state !== 'CREATED' && o.state !== 'VALIDATING' && o.state !== 'RISK_CHECK');
    for (const o of candidates) {
      try {
        const bo = o.brokerOrderId ? await this.d.broker.getOrder(o.brokerOrderId) : await this.d.broker.getOrderByClientId(o.clientOrderId);
        if (bo) {
          await this.applyBroker(o, bo, { event: 'sync', eventKey: `sync:${bo.id}:${bo.status}:${bo.filledQty}:${bo.updatedAt}`, at: this.d.clock.now(), update: null });
        } else if (o.state === 'SUBMITTING') {
          void this.resolve(o);
        }
      } catch (err) {
        this.d.logger.warn({ err: (err as Error).message, clientOrderId: o.clientOrderId }, 'order sync failed');
      }
    }
    // Orders interrupted before submission can never have reached the broker.
    for (const o of [...this.orders.values()].filter((x) => x.state === 'CREATED' || x.state === 'VALIDATING' || x.state === 'RISK_CHECK')) {
      if (this.d.clock.now() - o.updatedAt > 30_000) {
        await this.lock.run(() => this.reject(o, 'VALIDATION', 'interrupted before submission (restart) — never sent to broker'));
      }
    }
  }

  /**
   * Apply a broker snapshot of an order. Idempotent: duplicate event keys are
   * ignored, states only move forward, and fill quantity is monotonic.
   */
  async applyBroker(order: OrderRecord, bo: BrokerOrder, ctx: { event: string; eventKey: string; at: number; update: BrokerTradeUpdate | null }): Promise<void> {
    await this.lock.run(async () => {
      const prevState = order.state;
      const prevFilled = order.filledQty;
      const t = nextState(order.state, bo.status);
      const newFilled = Math.max(order.filledQty, bo.filledQty);
      const delta = newFilled - prevFilled;
      const fillPrice =
        delta > 0
          ? fillDeltaPrice({ prevQty: prevFilled, prevAvg: order.filledAvgPrice, newQty: newFilled, newAvg: bo.filledAvgPrice, eventQty: ctx.update?.qty ?? null, eventPrice: ctx.update?.price ?? null })
          : null;
      const now = this.d.clock.now();
      const next: OrderRecord = {
        ...order,
        meta: { ...order.meta },
        state: t.state,
        brokerOrderId: order.brokerOrderId ?? bo.id,
        brokerStatus: bo.status,
        filledQty: newFilled,
        filledAvgPrice: delta > 0 ? (bo.filledAvgPrice ?? fillPrice ?? order.filledAvgPrice) : order.filledAvgPrice,
        submittedAt: order.submittedAt ?? bo.submittedAt ?? ctx.at,
        updatedAt: now,
        filledAt: t.state === 'FILLED' ? (bo.filledAt ?? ctx.at) : order.filledAt,
      };
      if ((prevState === 'SUBMITTING' || prevState === 'ERROR') && t.changed) next.errorMessage = null;
      if (t.state === 'REJECTED' && prevState !== 'REJECTED') {
        next.rejectedBy = 'BROKER';
        next.rejectReason = order.rejectReason ?? 'rejected by broker';
      }

      let effect: FillEffect | null = null;
      const recorded = await this.d.db.tx(async (q) => {
        const isNew = await this.repo.recordEvent(q, {
          orderId: order.id,
          eventKey: ctx.eventKey,
          event: ctx.event,
          fromState: prevState,
          toState: next.state,
          brokerStatus: bo.status,
          filledQty: newFilled,
          fillQty: delta > 0 ? delta : null,
          fillPrice,
          payload: ctx.update ? { event: ctx.update.event, executionId: ctx.update.executionId, price: ctx.update.price, qty: ctx.update.qty, positionQty: ctx.update.positionQty } : { status: bo.status },
          occurredAt: ctx.at,
        });
        if (!isNew) return false;
        if (delta > 0 && fillPrice !== null) {
          effect = await this.d.ledger.applyFill(q, next, delta, fillPrice, ctx.at, { dailyPnl: this.d.dailyPnl() });
          if (effect.opened) next.tradeId = effect.opened.id;
          else if (!next.tradeId) next.tradeId = effect.closed?.id ?? this.d.ledger.get(next.symbol)?.tradeId ?? null;
        }
        await this.repo.update(q, next);
        return true;
      });
      if (!recorded) return; // duplicate delivery

      Object.assign(order, next);
      if (order.brokerOrderId) this.byBroker.set(order.brokerOrderId, order.id);
      if (effect) this.d.ledger.commit(effect);
      this.afterApply(order, prevState, delta, fillPrice, ctx.at, effect);
    });
  }

  private afterApply(order: OrderRecord, prevState: OrderState, delta: number, fillPrice: number | null, at: number, effect: FillEffect | null): void {
    const { bus, timeline, audit, alerts, env } = this.d;
    bus.emit('ORDER_UPDATED', { order, prevState });
    const base = { env, workerId: order.workerId, symbol: order.symbol, orderId: order.id, clientOrderId: order.clientOrderId };

    if (delta > 0 && fillPrice !== null) {
      bus.emit('FILL', { order, qty: delta, price: fillPrice, at });
      const partial = order.state !== 'FILLED';
      void audit.record({ ...base, action: partial ? 'ORDER_PARTIALLY_FILLED' : 'ORDER_FILLED', actor: 'broker', details: { qty: delta, price: fillPrice, filledQty: order.filledQty, orderQty: order.qty } });
      timeline.add({
        kind: 'fill',
        severity: 'success',
        ts: at,
        workerId: order.workerId,
        symbol: order.symbol,
        title: `${partial ? 'Partial fill' : 'Order filled'} · ${order.side.toUpperCase()} ${delta} ${order.symbol} @ ${fillPrice.toFixed(2)}`,
        detail: partial ? `${order.filledQty}/${order.qty} filled, ${order.qty - order.filledQty} remaining` : null,
      });
      this.d.onFills();
    }

    if (order.state !== prevState) {
      switch (order.state) {
        case 'FILLED':
          bus.emit('ORDER_FILLED', { order });
          if (isOpening(order.purpose)) this.city('ORDER_FILLED', order, order.filledAvgPrice, null);
          alerts.raise('ORDER_FILLED', 'success', 'Order filled', `${order.side.toUpperCase()} ${order.filledQty} ${order.symbol} @ ${order.filledAvgPrice?.toFixed(2) ?? 'n/a'}`);
          break;
        case 'CANCELED':
          bus.emit('ORDER_CANCELED', { order });
          void audit.record({ ...base, action: 'ORDER_CANCELED', actor: 'broker', details: { filledQty: order.filledQty } });
          timeline.add({ kind: 'order', ts: at, workerId: order.workerId, symbol: order.symbol, title: `Order canceled · ${order.symbol}`, detail: order.filledQty > 0 ? `${order.filledQty}/${order.qty} filled before cancel` : null });
          break;
        case 'EXPIRED':
          void audit.record({ ...base, action: 'ORDER_EXPIRED', actor: 'broker' });
          timeline.add({ kind: 'order', ts: at, workerId: order.workerId, symbol: order.symbol, title: `Order expired · ${order.symbol}`, detail: null });
          break;
        case 'REJECTED':
          bus.emit('ORDER_REJECTED', { order });
          void audit.record({ ...base, action: 'ORDER_REJECTED', actor: 'broker', details: { reason: order.rejectReason } });
          timeline.add({ kind: 'order', severity: 'error', ts: at, workerId: order.workerId, symbol: order.symbol, title: `Order rejected · ${order.symbol}`, detail: order.rejectReason });
          alerts.raise('ORDER_REJECTED', 'error', 'Order rejected', `${order.symbol}: ${order.rejectReason}`);
          this.d.breakers.brokerRejected(order.rejectReason ?? 'rejected');
          this.city('ORDER_REJECTED', order, null, null);
          break;
        case 'ACCEPTED':
          if (prevState === 'SUBMITTING' || prevState === 'SUBMITTED') {
            void audit.record({ ...base, action: 'ORDER_ACCEPTED', actor: 'broker', details: { brokerStatus: order.brokerStatus } });
          }
          break;
        default:
          break;
      }
    }

    if (effect?.opened) {
      bus.emit('POSITION_OPENED', { trade: effect.opened });
      void audit.record({ ...base, action: 'POSITION_OPENED', actor: 'broker', details: { tradeId: effect.opened.id, qty: effect.opened.qtyOpened, direction: effect.opened.direction } });
      alerts.raise('POSITION_OPENED', 'info', 'Position opened', `${order.symbol} · ${effect.opened.direction}`);
    }
    if (effect?.closed) {
      const t = effect.closed;
      bus.emit('POSITION_CLOSED', { trade: t });
      void audit.record({ ...base, action: 'POSITION_CLOSED', actor: 'broker', details: { tradeId: t.id, realizedPnl: t.realizedPnl, exitReason: t.exitReason } });
      const pnl = t.realizedPnl ?? 0;
      timeline.add({
        kind: 'pnl',
        severity: pnl >= 0 ? 'success' : 'error',
        ts: at,
        workerId: order.workerId,
        symbol: order.symbol,
        title: `Position closed · ${pnl >= 0 ? '+' : '−'}$${Math.abs(pnl).toFixed(2)}`,
        detail: t.exitReason,
      });
      alerts.raise('POSITION_CLOSED', pnl >= 0 ? 'success' : 'warn', 'Position closed', `${order.symbol} ${pnl >= 0 ? '+' : '−'}$${Math.abs(pnl).toFixed(2)}`);
      this.city(pnl >= 0 ? 'PROFIT_LOCKED' : 'POSITION_CLOSED', order, fillPrice, pnl);
    }
  }

  private city(kind: CityEvent['kind'], order: OrderRecord, price: number | null, pnl: number | null): void {
    this.d.bus.emit('CITY_EVENT', {
      id: newId('ce'),
      ts: this.d.clock.now(),
      kind,
      workerId: order.workerId,
      symbol: order.symbol,
      direction: order.meta.direction ?? 'NEUTRAL',
      qty: order.filledQty || order.qty,
      price,
      pnl,
      assetClass: order.assetClass,
    });
  }

  // ── Internal transitions (must be called under the lock) ───────────────

  private async transition(order: OrderRecord, to: OrderState): Promise<void> {
    const prevState = order.state;
    order.state = to;
    order.updatedAt = this.d.clock.now();
    await this.d.db.tx(async (q) => {
      await this.repo.recordEvent(q, {
        orderId: order.id,
        eventKey: `${order.id}:${to}:${order.updatedAt}`,
        event: 'internal',
        fromState: prevState,
        toState: to,
        brokerStatus: order.brokerStatus,
        filledQty: order.filledQty,
        fillQty: null,
        fillPrice: null,
        payload: null,
        occurredAt: order.updatedAt,
      });
      await this.repo.update(q, order);
    });
    this.d.bus.emit('ORDER_UPDATED', { order, prevState });
  }

  private async reject(order: OrderRecord, by: RejectedBy, reason: string): Promise<void> {
    order.rejectedBy = by;
    order.rejectReason = reason;
    await this.transition(order, 'REJECTED');
    if (by === 'RISK' || by === 'VALIDATION') {
      void this.d.audit.record({ action: 'RISK_BLOCK', actor: order.meta.requestedBy ?? 'system', env: this.d.env, workerId: order.workerId, symbol: order.symbol, orderId: order.id, clientOrderId: order.clientOrderId, details: { reason, by } });
      this.d.timeline.add({ kind: 'risk', severity: 'warn', workerId: order.workerId, symbol: order.symbol, title: `Risk blocked · ${order.symbol}`, detail: reason });
    } else {
      void this.d.audit.record({ action: 'ORDER_REJECTED', actor: 'broker', env: this.d.env, workerId: order.workerId, symbol: order.symbol, orderId: order.id, clientOrderId: order.clientOrderId, details: { reason } });
      this.d.timeline.add({ kind: 'order', severity: 'error', workerId: order.workerId, symbol: order.symbol, title: `Order rejected by broker · ${order.symbol}`, detail: reason });
      this.d.alerts.raise('ORDER_REJECTED', 'error', 'Order rejected', `${order.symbol}: ${reason}`);
      this.city('ORDER_REJECTED', order, null, null);
    }
  }

  private async recordRisk(order: OrderRecord, decision: RiskDecisionView): Promise<void> {
    await this.d.db.query(
      `INSERT INTO risk_events(env, worker_id, order_id, signal_id, symbol, purpose, approved, blocked_by, checks, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [this.d.env, order.workerId, order.id, order.signalId, order.symbol, order.purpose, decision.approved, decision.blockedBy?.id ?? null, JSON.stringify(decision.checks), iso(decision.evaluatedAt)],
    );
  }
}
