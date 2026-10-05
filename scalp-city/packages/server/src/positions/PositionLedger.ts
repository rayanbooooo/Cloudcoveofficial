import type { DirectionOrNeutral, TradingEnvironment, Venue } from '@scalp-city/shared';
import type { BrokerPosition } from '../broker/types.js';
import type { Clock } from '../core/clock.js';
import { newId } from '../core/ids.js';
import type { Logger } from '../core/logger.js';
import { iso, ms, n, type Db, type Queryable } from '../db/db.js';
import { nyDate } from '../market/MarketCalendar.js';
import type { OrderRecord } from '../orders/types.js';
import type { LedgerPosition, TradeRecord } from './types.js';

export interface FillEffect {
  symbol: string;
  opened: TradeRecord | null;
  closed: TradeRecord | null;
  realized: number;
  position: LedgerPosition | null;
  /** Trade copies to install in memory once the transaction commits. */
  tradeUpserts: TradeRecord[];
  tradeDeletes: string[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const parse = (v: any) => (v === null || v === undefined ? null : typeof v === 'string' ? JSON.parse(v) : v);

export function rowToTrade(r: any): TradeRecord {
  return {
    id: r.id,
    venue: r.venue ?? 'alpaca',
    env: r.env,
    workerId: r.worker_id,
    strategyId: r.strategy_id,
    symbol: r.symbol,
    underlying: r.underlying,
    assetClass: r.asset_class,
    direction: r.direction,
    status: r.status,
    qtyOpened: n(r.qty_opened) ?? 0,
    qtyClosed: n(r.qty_closed) ?? 0,
    entryValue: n(r.entry_value) ?? 0,
    exitValue: n(r.exit_value) ?? 0,
    multiplier: n(r.multiplier) ?? 1,
    realizedPnl: n(r.realized_pnl),
    signalId: r.signal_id,
    signalSnapshot: parse(r.signal_snapshot),
    riskSnapshot: parse(r.risk_snapshot),
    exitReason: r.exit_reason,
    dailyPnlBefore: n(r.daily_pnl_before),
    dailyPnlAfter: n(r.daily_pnl_after),
    tradingDay: typeof r.trading_day === 'string' ? r.trading_day.slice(0, 10) : nyDate(new Date(r.trading_day).getTime() + 12 * 3_600_000),
    openedAt: ms(r.opened_at)!,
    closedAt: ms(r.closed_at),
  };
}

function rowToPosition(r: any): LedgerPosition {
  return {
    venue: r.venue ?? 'alpaca',
    env: r.env,
    symbol: r.symbol,
    workerId: r.worker_id,
    tradeId: r.trade_id,
    assetClass: r.asset_class,
    underlying: r.underlying,
    direction: r.direction ?? 'NEUTRAL',
    qty: n(r.qty) ?? 0,
    avgPrice: n(r.avg_price) ?? 0,
    multiplier: n(r.multiplier) ?? 1,
    external: r.external === true,
    openedAt: ms(r.opened_at)!,
    updatedAt: ms(r.updated_at)!,
  };
}

/**
 * Scalp City's own view of what it holds, built exclusively from broker
 * fills. Compared against the broker by the reconciler; the broker wins.
 */
export class PositionLedger {
  private positions = new Map<string, LedgerPosition>();
  private trades = new Map<string, TradeRecord>();

  constructor(
    private readonly venue: Venue,
    private readonly env: TradingEnvironment,
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async load(): Promise<void> {
    this.positions.clear();
    this.trades.clear();
    const pos = await this.db.query('SELECT * FROM positions WHERE venue = $1 AND env = $2', [this.venue, this.env]);
    for (const r of pos.rows) {
      const p = rowToPosition(r);
      if (p.qty !== 0) this.positions.set(p.symbol, p);
    }
    const tr = await this.db.query(`SELECT * FROM trades WHERE venue = $1 AND env = $2 AND status = 'OPEN'`, [this.venue, this.env]);
    for (const r of tr.rows) {
      const t = rowToTrade(r);
      this.trades.set(t.id, t);
    }
  }

  get(symbol: string): LedgerPosition | null {
    return this.positions.get(symbol) ?? null;
  }

  all(): LedgerPosition[] {
    return [...this.positions.values()];
  }

  byWorker(workerId: string): LedgerPosition | null {
    for (const p of this.positions.values()) if (p.workerId === workerId && p.qty !== 0) return p;
    return null;
  }

  openTrade(tradeId: string | null): TradeRecord | null {
    return tradeId ? (this.trades.get(tradeId) ?? null) : null;
  }

  /**
   * Apply a broker-confirmed fill of `qty` at `price`. Must run inside the
   * caller's transaction (`q`); in-memory state is returned for the caller
   * to commit via `commit()` after the transaction succeeds.
   *
   * `brokerRealized`: the broker's own realized P&L for this fill, net of
   * costs, in account currency (OANDA). When present it is used as-is —
   * including the commission on an opening fill — instead of a figure
   * computed from prices.
   */
  async applyFill(
    q: Queryable,
    order: OrderRecord,
    qty: number,
    price: number,
    at: number,
    ctx: { dailyPnl: number | null; brokerRealized?: number | null },
  ): Promise<FillEffect> {
    const brokerRealized = ctx.brokerRealized ?? null;
    const signed = order.side === 'buy' ? qty : -qty;
    const existing = this.positions.get(order.symbol);
    const mult = order.meta.multiplier;
    let opened: TradeRecord | null = null;
    let closed: TradeRecord | null = null;
    let realized = 0;
    let pos: LedgerPosition | null;
    const tradeUpserts: TradeRecord[] = [];
    const tradeDeletes: string[] = [];

    if (!existing || existing.qty === 0) {
      // Opening a new position.
      const direction: DirectionOrNeutral = order.meta.direction ?? (signed > 0 ? 'CALL' : 'PUT');
      const entryCost = brokerRealized !== null && brokerRealized !== 0 ? brokerRealized : null;
      const trade: TradeRecord = {
        id: newId('trd'),
        venue: this.venue,
        env: this.env,
        workerId: order.workerId,
        strategyId: null,
        symbol: order.symbol,
        underlying: order.underlying,
        assetClass: order.assetClass,
        direction,
        status: 'OPEN',
        qtyOpened: qty,
        qtyClosed: 0,
        entryValue: qty * price * mult,
        exitValue: 0,
        multiplier: mult,
        realizedPnl: entryCost,
        signalId: order.signalId,
        signalSnapshot: order.meta.signal ?? null,
        riskSnapshot: {
          positionNotional: qty * price * mult,
          dailyPnlBefore: order.meta.dailyPnlBefore ?? ctx.dailyPnl,
          exitPlan: order.meta.exitPlan ?? null,
          protectiveStop: order.meta.protectiveStop ?? null,
          softStop: order.meta.softStop ?? null,
          riskAtStop: order.meta.riskAtStop ?? null,
        },
        exitReason: null,
        dailyPnlBefore: order.meta.dailyPnlBefore ?? ctx.dailyPnl,
        dailyPnlAfter: null,
        tradingDay: nyDate(at),
        openedAt: at,
        closedAt: null,
      };
      await q.query(
        `INSERT INTO trades(id, env, worker_id, strategy_id, symbol, underlying, asset_class, direction, status, qty_opened, qty_closed,
           entry_value, exit_value, multiplier, realized_pnl, signal_id, signal_snapshot, risk_snapshot, daily_pnl_before, trading_day, opened_at, venue)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'OPEN',$9,0,$10,0,$11,$18,$12,$13,$14,$15,$16,$17,$19)`,
        [
          trade.id,
          trade.env,
          trade.workerId,
          trade.strategyId,
          trade.symbol,
          trade.underlying,
          trade.assetClass,
          trade.direction,
          trade.qtyOpened,
          trade.entryValue,
          trade.multiplier,
          trade.signalId,
          JSON.stringify(trade.signalSnapshot),
          JSON.stringify(trade.riskSnapshot),
          trade.dailyPnlBefore,
          trade.tradingDay,
          iso(at),
          trade.realizedPnl,
          this.venue,
        ],
      );
      pos = {
        venue: this.venue,
        env: this.env,
        symbol: order.symbol,
        workerId: order.workerId,
        tradeId: trade.id,
        assetClass: order.assetClass,
        underlying: order.underlying,
        direction,
        qty: signed,
        avgPrice: price,
        multiplier: mult,
        external: false,
        openedAt: at,
        updatedAt: at,
      };
      opened = trade;
      await this.event(q, trade.id, 'ENTRY_FILL', order.id, qty, price, entryCost, at);
      tradeUpserts.push(trade);
    } else if (Math.sign(existing.qty) === Math.sign(signed)) {
      // Adding to the position.
      const absOld = Math.abs(existing.qty);
      const avg = (absOld * existing.avgPrice + qty * price) / (absOld + qty);
      pos = { ...existing, qty: existing.qty + signed, avgPrice: avg, updatedAt: at };
      const cached = this.openTrade(existing.tradeId);
      if (cached) {
        const entryCost = brokerRealized !== null && brokerRealized !== 0 ? brokerRealized : null;
        const realizedPnl = entryCost === null ? cached.realizedPnl : (cached.realizedPnl ?? 0) + entryCost;
        const trade = { ...cached, qtyOpened: cached.qtyOpened + qty, entryValue: cached.entryValue + qty * price * mult, realizedPnl };
        await q.query('UPDATE trades SET qty_opened = $2, entry_value = $3, realized_pnl = $4 WHERE id = $1', [trade.id, trade.qtyOpened, trade.entryValue, trade.realizedPnl]);
        await this.event(q, trade.id, 'ENTRY_FILL', order.id, qty, price, entryCost, at);
        tradeUpserts.push(trade);
      }
    } else {
      // Reducing (or, defensively, flipping) the position.
      const absOld = Math.abs(existing.qty);
      const closeQty = Math.min(qty, absOld);
      const dir = existing.qty > 0 ? 1 : -1;
      // Prefer the broker's own figure (account currency, net of costs); else derive it from prices.
      realized = brokerRealized ?? (price - existing.avgPrice) * closeQty * existing.multiplier * dir;
      const remaining = existing.qty + Math.sign(signed) * closeQty;
      const cached = this.openTrade(existing.tradeId);
      if (cached) {
        const trade: TradeRecord = {
          ...cached,
          qtyClosed: cached.qtyClosed + closeQty,
          exitValue: cached.exitValue + closeQty * price * mult,
          realizedPnl: (cached.realizedPnl ?? 0) + realized,
        };
        if (remaining === 0) {
          trade.status = 'CLOSED';
          trade.closedAt = at;
          trade.exitReason = order.meta.exitReason ?? order.purpose;
          trade.dailyPnlAfter = ctx.dailyPnl;
        }
        await q.query(
          `UPDATE trades SET qty_closed = $2, exit_value = $3, realized_pnl = $4, status = $5, closed_at = $6, exit_reason = $7, daily_pnl_after = $8 WHERE id = $1`,
          [trade.id, trade.qtyClosed, trade.exitValue, trade.realizedPnl, trade.status, iso(trade.closedAt), trade.exitReason, trade.dailyPnlAfter],
        );
        await this.event(q, trade.id, 'EXIT_FILL', order.id, closeQty, price, realized, at);
        if (remaining === 0) {
          closed = trade;
          tradeDeletes.push(trade.id);
        } else {
          tradeUpserts.push(trade);
        }
      }
      pos = remaining === 0 ? null : { ...existing, qty: remaining, updatedAt: at };
      if (qty > closeQty) {
        this.logger.error({ symbol: order.symbol, qty, held: absOld }, 'fill exceeded the held quantity — position flipped; reconciliation will flag it');
        const flipQty = qty - closeQty;
        pos = {
          ...existing,
          workerId: order.workerId,
          tradeId: null,
          qty: Math.sign(signed) * flipQty,
          avgPrice: price,
          openedAt: at,
          updatedAt: at,
        };
      }
    }

    if (pos) {
      await q.query(
        `INSERT INTO positions(env, symbol, worker_id, trade_id, asset_class, underlying, direction, qty, avg_price, multiplier, external, opened_at, updated_at, venue)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (venue, env, symbol) DO UPDATE SET worker_id = EXCLUDED.worker_id, trade_id = EXCLUDED.trade_id, direction = EXCLUDED.direction,
           qty = EXCLUDED.qty, avg_price = EXCLUDED.avg_price, external = EXCLUDED.external, updated_at = EXCLUDED.updated_at`,
        [pos.env, pos.symbol, pos.workerId, pos.tradeId, pos.assetClass, pos.underlying, pos.direction, pos.qty, pos.avgPrice, pos.multiplier, pos.external, iso(pos.openedAt), iso(pos.updatedAt), this.venue],
      );
    } else {
      await q.query('DELETE FROM positions WHERE venue = $1 AND env = $2 AND symbol = $3', [this.venue, this.env, order.symbol]);
    }
    return { symbol: order.symbol, opened, closed, realized, position: pos, tradeUpserts, tradeDeletes };
  }

  /** Install a fill's effects in memory — only after its transaction committed. */
  commit(effect: FillEffect): void {
    if (effect.position && effect.position.qty !== 0) this.positions.set(effect.symbol, effect.position);
    else this.positions.delete(effect.symbol);
    for (const t of effect.tradeUpserts) this.trades.set(t.id, t);
    for (const id of effect.tradeDeletes) this.trades.delete(id);
  }

  private async event(q: Queryable, tradeId: string, kind: string, orderId: string, qty: number, price: number, realized: number | null, at: number): Promise<void> {
    await q.query(
      `INSERT INTO trade_events(trade_id, kind, order_id, qty, price, realized_pnl, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [tradeId, kind, orderId, qty, price, realized, iso(at)],
    );
  }

  // ── Reconciliation support ─────────────────────────────────────────────

  /** Record a broker position that Scalp City did not open (external). */
  async adoptExternal(bp: BrokerPosition): Promise<LedgerPosition> {
    const now = this.clock.now();
    const pos: LedgerPosition = {
      venue: this.venue,
      env: this.env,
      symbol: bp.symbol,
      workerId: null,
      tradeId: null,
      assetClass: bp.assetClass,
      underlying: null,
      direction: 'NEUTRAL',
      qty: bp.side === 'long' ? bp.qty : -bp.qty,
      avgPrice: bp.avgEntryPrice,
      multiplier: bp.multiplier ?? (bp.assetClass === 'us_option' ? 100 : 1),
      external: true,
      openedAt: now,
      updatedAt: now,
    };
    await this.db.query(
      `INSERT INTO positions(env, symbol, worker_id, trade_id, asset_class, underlying, direction, qty, avg_price, multiplier, external, opened_at, updated_at, venue)
       VALUES ($1,$2,NULL,NULL,$3,NULL,'NEUTRAL',$4,$5,$6,true,$7,$7,$8)
       ON CONFLICT (venue, env, symbol) DO UPDATE SET qty = EXCLUDED.qty, avg_price = EXCLUDED.avg_price, external = true, worker_id = NULL, trade_id = NULL, updated_at = EXCLUDED.updated_at`,
      [this.env, pos.symbol, pos.assetClass, pos.qty, pos.avgPrice, pos.multiplier, iso(now), this.venue],
    );
    this.positions.set(pos.symbol, pos);
    return pos;
  }

  /** Accept the broker's quantity for a symbol (after a user-acknowledged mismatch). */
  async acceptBrokerQty(symbol: string, bp: BrokerPosition | null, reason: string): Promise<void> {
    const now = this.clock.now();
    const existing = this.positions.get(symbol);
    if (!bp) {
      // Position no longer exists at the broker: close the trade with unknown P&L.
      if (existing?.tradeId) {
        await this.db.query(
          `UPDATE trades SET status = 'CLOSED', closed_at = $2, exit_reason = $3 WHERE id = $1 AND status = 'OPEN'`,
          [existing.tradeId, iso(now), `CLOSED_OUTSIDE_SCALP_CITY: ${reason}`],
        );
        this.trades.delete(existing.tradeId);
      }
      await this.db.query('DELETE FROM positions WHERE venue = $1 AND env = $2 AND symbol = $3', [this.venue, this.env, symbol]);
      this.positions.delete(symbol);
      return;
    }
    const qty = bp.side === 'long' ? bp.qty : -bp.qty;
    if (!existing) {
      await this.adoptExternal(bp);
      return;
    }
    await this.db.query('UPDATE positions SET qty = $4, avg_price = $5, updated_at = $6 WHERE venue = $1 AND env = $2 AND symbol = $3', [this.venue, this.env, symbol, qty, bp.avgEntryPrice, iso(now)]);
    this.positions.set(symbol, { ...existing, qty, avgPrice: bp.avgEntryPrice, updatedAt: now });
  }
}
