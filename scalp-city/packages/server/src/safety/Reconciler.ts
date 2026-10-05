import { parseOccSymbol, type ReconciliationMismatch, type ReconciliationView, type TradingEnvironment } from '@scalp-city/shared';
import type { AccountService } from '../account/AccountService.js';
import type { AuditLog } from '../audit/AuditLog.js';
import type { Clock } from '../core/clock.js';
import type { EventBus } from '../core/eventBus.js';
import type { Logger } from '../core/logger.js';
import type { OrderEngine } from '../orders/OrderEngine.js';
import type { PositionLedger } from '../positions/PositionLedger.js';
import type { Alerts, Timeline } from '../system/Timeline.js';
import type { CircuitBreakers } from './CircuitBreakers.js';

/** Equity symbol an instrument relates to (the underlying for options). */
export function relatedUnderlying(symbol: string): string {
  return parseOccSymbol(symbol)?.root ?? symbol;
}

/**
 * Periodic local-vs-broker reconciliation (spec §35, §93). The broker is
 * authoritative. A difference must survive two consecutive passes (so fills
 * in flight don't false-alarm) before trading is halted; resolving it takes
 * an explicit, audited "accept broker state".
 */
export class Reconciler {
  private view: ReconciliationView = { status: 'UNKNOWN', lastRunAt: null, mismatches: [], externalPositions: [] };
  private suspect = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly env: TradingEnvironment,
    private readonly account: AccountService,
    private readonly ledger: PositionLedger,
    private readonly orders: OrderEngine,
    private readonly breakers: CircuitBreakers,
    private readonly audit: AuditLog,
    private readonly timeline: Timeline,
    private readonly alerts: Alerts,
    private readonly bus: EventBus,
    private readonly clock: Clock,
    private readonly logger: Logger,
    /** Underlyings the workers trade; positions in other symbols are informational. */
    private readonly workerUnderlyings: () => string[],
  ) {}

  start(intervalMs = 15_000): void {
    this.timer = setInterval(() => void this.run().catch(() => undefined), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): ReconciliationView {
    return { ...this.view, mismatches: [...this.view.mismatches], externalPositions: [...this.view.externalPositions] };
  }

  ok(): boolean {
    return this.view.status === 'RECONCILED';
  }

  /**
   * Compare once. `immediate` (startup) skips the two-pass persistence rule:
   * after a restart nothing is in flight that could explain a difference.
   */
  async run(opts: { immediate?: boolean } = {}): Promise<ReconciliationView> {
    if (this.running) return this.status();
    this.running = true;
    try {
      await Promise.all([this.account.refreshPositions(), this.account.refreshOpenOrders()]);
    } catch (err) {
      this.running = false;
      this.view = { ...this.view, status: this.view.status === 'RECONCILED' ? 'PENDING' : this.view.status };
      this.logger.warn({ err: (err as Error).message }, 'reconciliation skipped: broker unavailable');
      return this.status();
    }
    try {
      return await this.compare(opts.immediate === true);
    } finally {
      this.running = false;
    }
  }

  private async compare(immediate: boolean): Promise<ReconciliationView> {
    const now = this.clock.now();
    const watched = new Set(this.workerUnderlyings());
    const inFlight = new Set(this.orders.riskOpenOrders().map((o) => o.symbol));
    const found: ReconciliationMismatch[] = [];
    const external: string[] = [];

    const brokerBySymbol = new Map(this.account.positions.map((p) => [p.symbol, p]));
    for (const bp of this.account.positions) {
      if (inFlight.has(bp.symbol)) continue;
      const brokerQty = bp.side === 'long' ? bp.qty : -bp.qty;
      if (bp.hedged && watched.has(relatedUnderlying(bp.symbol))) {
        found.push({ symbol: bp.symbol, local: this.ledger.get(bp.symbol)?.qty ?? 0, broker: brokerQty, kind: 'QTY_MISMATCH', detail: `${bp.symbol} has long and short trades open at once (hedged) — Scalp City only manages net positions; close one side at the broker` });
        continue;
      }
      const lp = this.ledger.get(bp.symbol);
      if (!lp) {
        if (!watched.has(relatedUnderlying(bp.symbol))) {
          // Unrelated holding (e.g. a long-term position): adopt as external, don't block trading.
          await this.ledger.adoptExternal(bp);
          external.push(bp.symbol);
          continue;
        }
        found.push({ symbol: bp.symbol, local: 0, broker: brokerQty, kind: 'UNEXPECTED_POSITION', detail: `broker holds ${brokerQty} ${bp.symbol}; Scalp City has no record of opening it` });
        continue;
      }
      if (lp.external) external.push(bp.symbol);
      if (Math.abs(lp.qty - brokerQty) > 1e-9) {
        found.push({ symbol: bp.symbol, local: lp.qty, broker: brokerQty, kind: 'QTY_MISMATCH', detail: `local ${lp.qty} vs broker ${brokerQty}` });
      }
    }
    for (const lp of this.ledger.all()) {
      if (inFlight.has(lp.symbol)) continue;
      if (!brokerBySymbol.has(lp.symbol)) {
        found.push({ symbol: lp.symbol, local: lp.qty, broker: 0, kind: 'MISSING_POSITION', detail: `local ${lp.qty} ${lp.symbol}, broker holds none` });
      }
    }
    for (const bo of this.account.openOrders) {
      if (this.orders.byClientOrderId(bo.clientOrderId)) continue;
      // A broker-side stop for one of our entries that the stream hasn't reported yet: adopt it.
      if (await this.orders.adoptProtectiveStop(bo).catch(() => null)) continue;
      if (!watched.has(relatedUnderlying(bo.symbol))) continue;
      found.push({ symbol: bo.symbol, local: 0, broker: bo.qty ?? 0, kind: 'UNEXPECTED_ORDER', detail: `open ${bo.side} order for ${bo.qty} ${bo.symbol} not placed by Scalp City` });
    }

    // Two-pass rule.
    const confirmed: ReconciliationMismatch[] = [];
    const seenKeys = new Set<string>();
    for (const m of found) {
      const key = `${m.kind}|${m.symbol}|${m.local}|${m.broker}`;
      seenKeys.add(key);
      const first = this.suspect.get(key);
      if (immediate || (first !== undefined && first < now)) confirmed.push(m);
      else if (first === undefined) this.suspect.set(key, now);
    }
    for (const k of [...this.suspect.keys()]) if (!seenKeys.has(k)) this.suspect.delete(k);

    const prevStatus = this.view.status;
    const status: ReconciliationView['status'] = confirmed.length ? 'MISMATCH' : found.length ? 'PENDING' : 'RECONCILED';
    this.view = { status, lastRunAt: now, mismatches: confirmed, externalPositions: external };

    if (confirmed.length && prevStatus !== 'MISMATCH') {
      const unexpected = confirmed.some((m) => m.kind === 'UNEXPECTED_POSITION');
      await this.breakers.trip(unexpected ? 'UNEXPECTED_POSITION' : 'ACCOUNT_MISMATCH', confirmed.map((m) => m.detail).join('; '));
      void this.audit.record({ action: 'RECONCILIATION_MISMATCH', actor: 'system', env: this.env, details: { mismatches: confirmed } });
      this.alerts.raise('RECONCILIATION', 'error', 'ACCOUNT RECONCILIATION WARNING', 'Trading disabled until state is reconciled.');
    }
    if (status !== prevStatus) this.bus.emit('SYSTEM_UPDATED', {});
    return this.status();
  }

  /** User-acknowledged resolution: the broker's numbers become the local record. */
  async acceptBrokerState(actor: string): Promise<ReconciliationView> {
    await Promise.all([this.account.refreshPositions(), this.account.refreshOpenOrders()]);
    const before = this.view.mismatches;
    for (const m of before) {
      if (m.kind === 'UNEXPECTED_ORDER') continue; // nothing local to change; cancel it at the broker if unwanted
      await this.ledger.acceptBrokerQty(m.symbol, this.account.brokerPosition(m.symbol), `accepted by ${actor}`);
    }
    void this.audit.record({ action: 'RECONCILIATION_ACCEPTED', actor, env: this.env, details: { mismatches: before } });
    this.timeline.add({ kind: 'control', title: 'Broker state accepted', detail: `${before.length} difference(s) resolved by ${actor}` });
    this.suspect.clear();
    const view = await this.compare(true);
    if (view.status === 'RECONCILED') {
      await this.breakers.reset('ACCOUNT_MISMATCH', actor);
      await this.breakers.reset('UNEXPECTED_POSITION', actor);
    }
    return view;
  }
}
