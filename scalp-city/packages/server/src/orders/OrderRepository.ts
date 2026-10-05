import type { TradingEnvironment, Venue } from '@scalp-city/shared';
import { iso, ms, n, type Db, type Queryable } from '../db/db.js';
import type { OrderRecord } from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const parse = (v: any) => (v === null || v === undefined ? null : typeof v === 'string' ? JSON.parse(v) : v);

export function rowToOrder(r: any): OrderRecord {
  return {
    id: r.id,
    venue: r.venue ?? 'alpaca',
    env: r.env,
    clientOrderId: r.client_order_id,
    brokerOrderId: r.broker_order_id,
    workerId: r.worker_id,
    source: r.source,
    purpose: r.purpose,
    signalId: r.signal_id,
    tradeId: r.trade_id,
    symbol: r.symbol,
    underlying: r.underlying,
    assetClass: r.asset_class,
    side: r.side,
    positionIntent: r.position_intent,
    type: r.type,
    timeInForce: r.time_in_force,
    qty: n(r.qty) ?? 0,
    limitPrice: n(r.limit_price),
    stopPrice: n(r.stop_price),
    state: r.state,
    brokerStatus: r.broker_status,
    filledQty: n(r.filled_qty) ?? 0,
    filledAvgPrice: n(r.filled_avg_price),
    rejectedBy: r.rejected_by,
    rejectReason: r.reject_reason,
    errorMessage: r.error_message,
    risk: parse(r.risk),
    meta: parse(r.meta) ?? { multiplier: 1 },
    createdAt: ms(r.created_at)!,
    submittedAt: ms(r.submitted_at),
    updatedAt: ms(r.updated_at)!,
    filledAt: ms(r.filled_at),
  };
}

export class UniqueViolation extends Error {}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === '23505' || /duplicate key|unique constraint/i.test(e?.message ?? '');
}

export class OrderRepository {
  constructor(private readonly db: Db) {}

  async insert(o: OrderRecord): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO orders(id, env, client_order_id, broker_order_id, worker_id, source, purpose, signal_id, trade_id, symbol, underlying,
           asset_class, side, position_intent, type, time_in_force, qty, limit_price, stop_price, state, broker_status, filled_qty,
           filled_avg_price, rejected_by, reject_reason, error_message, risk, meta, created_at, submitted_at, updated_at, filled_at, venue)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)`,
        this.params(o),
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new UniqueViolation((err as Error).message);
      throw err;
    }
  }

  private params(o: OrderRecord): unknown[] {
    return [
      o.id,
      o.env,
      o.clientOrderId,
      o.brokerOrderId,
      o.workerId,
      o.source,
      o.purpose,
      o.signalId,
      o.tradeId,
      o.symbol,
      o.underlying,
      o.assetClass,
      o.side,
      o.positionIntent,
      o.type,
      o.timeInForce,
      o.qty,
      o.limitPrice,
      o.stopPrice,
      o.state,
      o.brokerStatus,
      o.filledQty,
      o.filledAvgPrice,
      o.rejectedBy,
      o.rejectReason,
      o.errorMessage,
      o.risk === null ? null : JSON.stringify(o.risk),
      JSON.stringify(o.meta),
      iso(o.createdAt),
      iso(o.submittedAt),
      iso(o.updatedAt),
      iso(o.filledAt),
      o.venue,
    ];
  }

  async update(q: Queryable, o: OrderRecord): Promise<void> {
    await q.query(
      `UPDATE orders SET broker_order_id = $2, state = $3, broker_status = $4, filled_qty = $5, filled_avg_price = $6, rejected_by = $7,
         reject_reason = $8, error_message = $9, risk = $10, meta = $11, submitted_at = $12, updated_at = $13, filled_at = $14, trade_id = $15
       WHERE id = $1`,
      [
        o.id,
        o.brokerOrderId,
        o.state,
        o.brokerStatus,
        o.filledQty,
        o.filledAvgPrice,
        o.rejectedBy,
        o.rejectReason,
        o.errorMessage,
        o.risk === null ? null : JSON.stringify(o.risk),
        JSON.stringify(o.meta),
        iso(o.submittedAt),
        iso(o.updatedAt),
        iso(o.filledAt),
        o.tradeId,
      ],
    );
  }

  /** Record an order event exactly once. Returns false if the key was already recorded (duplicate). */
  async recordEvent(
    q: Queryable,
    e: {
      orderId: string;
      eventKey: string;
      event: string;
      fromState: string | null;
      toState: string;
      brokerStatus: string | null;
      filledQty: number | null;
      fillQty: number | null;
      fillPrice: number | null;
      payload: unknown;
      occurredAt: number;
    },
  ): Promise<boolean> {
    const r = await q.query(
      `INSERT INTO order_events(order_id, event_key, event, from_state, to_state, broker_status, filled_qty, fill_qty, fill_price, payload, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (event_key) DO NOTHING`,
      [
        e.orderId,
        e.eventKey,
        e.event,
        e.fromState,
        e.toState,
        e.brokerStatus,
        e.filledQty,
        e.fillQty,
        e.fillPrice,
        e.payload === undefined ? null : JSON.stringify(e.payload),
        iso(e.occurredAt),
      ],
    );
    return r.rowCount > 0;
  }

  /** Orders that may still change (plus today's), for the in-memory working set. */
  async loadWorkingSet(venue: Venue, env: TradingEnvironment, sinceMs: number): Promise<OrderRecord[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM orders WHERE venue = $1 AND env = $2 AND (created_at >= $3 OR state NOT IN ('FILLED','CANCELED','REJECTED','EXPIRED'))
       ORDER BY created_at ASC`,
      [venue, env, iso(sinceMs)],
    );
    return rows.map(rowToOrder);
  }

  async listRecent(venue: Venue, env: TradingEnvironment, limit: number): Promise<OrderRecord[]> {
    const { rows } = await this.db.query(`SELECT * FROM orders WHERE venue = $1 AND env = $2 ORDER BY created_at DESC LIMIT $3`, [venue, env, limit]);
    return rows.map(rowToOrder);
  }

  async events(orderId: string): Promise<{ event: string; toState: string; fillQty: number | null; fillPrice: number | null; occurredAt: number }[]> {
    const { rows } = await this.db.query(`SELECT * FROM order_events WHERE order_id = $1 ORDER BY id ASC`, [orderId]);
    return rows.map((r: any) => ({ event: r.event, toState: r.to_state, fillQty: n(r.fill_qty), fillPrice: n(r.fill_price), occurredAt: ms(r.occurred_at)! }));
  }

  /** Whether another ENTRY order already used this signal (the order being evaluated is excluded). */
  async signalHasOrder(signalId: string, excludeOrderId: string | null = null): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT 1 FROM orders WHERE signal_id = $1 AND purpose = 'ENTRY' AND ($2::text IS NULL OR id <> $2) LIMIT 1`,
      [signalId, excludeOrderId],
    );
    return rows.length > 0;
  }
}
