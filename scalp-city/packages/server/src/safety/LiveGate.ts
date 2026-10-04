import type { ReadinessItem, ReadinessView, TradingEnvironment } from '@scalp-city/shared';
import type { AuditLog } from '../audit/AuditLog.js';
import type { Clock } from '../core/clock.js';
import type { EventBus } from '../core/eventBus.js';
import type { Logger } from '../core/logger.js';
import type { Timeline } from '../system/Timeline.js';

export interface ReadinessInputs {
  brokerConnected: { ok: boolean; detail: string };
  account: { ok: boolean; detail: string };
  marketDataConnected: { ok: boolean; detail: string };
  marketDataFresh: { ok: boolean; detail: string };
  optionsData: { ok: boolean; detail: string };
  riskLimits: { ok: boolean; detail: string };
  killSwitch: { ok: boolean; detail: string };
  dailyLoss: { ok: boolean; detail: string };
  reconciliation: { ok: boolean; detail: string };
  noUnexpectedOrders: { ok: boolean; detail: string };
  noUnexpectedPositions: { ok: boolean; detail: string };
  workers: { ok: boolean; detail: string };
  breakers: { ok: boolean; detail: string };
  clock: { ok: boolean; detail: string };
  paperRoundTrip: { ok: boolean; detail: string };
}

export class LiveGateError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * The live trading lock (spec §3, §33, §124, §125).
 *
 * Two independent locks must both be open before a real order can exist:
 *   1. LIVE_TRADING_ENABLED=true in the server environment (operator lock)
 *   2. "armed" in the app: readiness checklist passed, password
 *      re-entered, account confirmed, two explicit confirmations.
 * Arming is never persisted: every restart comes back disarmed.
 */
export class LiveGate {
  armed = false;
  armedAt: number | null = null;
  armedBy: string | null = null;

  constructor(
    readonly env: TradingEnvironment,
    readonly serverLockOpen: boolean,
    private readonly audit: AuditLog,
    private readonly timeline: Timeline,
    private readonly bus: EventBus,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  readiness(inputs: ReadinessInputs): ReadinessView {
    const items: ReadinessItem[] = [
      { id: 'server_lock', label: 'Server live lock', ok: this.serverLockOpen, detail: this.serverLockOpen ? 'LIVE_TRADING_ENABLED=true' : 'LIVE_TRADING_ENABLED=false — set it on the server to allow live orders' },
      { id: 'environment', label: 'Live environment', ok: this.env === 'live', detail: this.env === 'live' ? 'connected to the live account' : 'this server is running in PAPER' },
      { id: 'broker', label: 'Broker', ...pick(inputs.brokerConnected) },
      { id: 'account', label: 'Account', ...pick(inputs.account) },
      { id: 'market_data', label: 'Market data', ...pick(inputs.marketDataConnected) },
      { id: 'market_data_fresh', label: 'Market data fresh', ...pick(inputs.marketDataFresh) },
      { id: 'options_data', label: 'Options data', ...pick(inputs.optionsData) },
      { id: 'risk_engine', label: 'Risk engine', ...pick(inputs.riskLimits) },
      { id: 'position_sync', label: 'Position sync', ...pick(inputs.reconciliation) },
      { id: 'unexpected_orders', label: 'No unexpected orders', ...pick(inputs.noUnexpectedOrders) },
      { id: 'unexpected_positions', label: 'No unexpected positions', ...pick(inputs.noUnexpectedPositions) },
      { id: 'order_engine', label: 'Order engine', ...pick(inputs.breakers) },
      { id: 'kill_switch', label: 'Kill switch', ...pick(inputs.killSwitch) },
      { id: 'daily_loss', label: 'Daily loss limit', ...pick(inputs.dailyLoss) },
      { id: 'workers', label: 'Worker configuration', ...pick(inputs.workers) },
      { id: 'clock', label: 'Server clock', ...pick(inputs.clock) },
      { id: 'paper_e2e', label: 'Paper round trip verified', ...pick(inputs.paperRoundTrip) },
    ];
    return { env: this.env, ready: items.every((i) => i.ok), items, checkedAt: this.clock.now() };
  }

  /** Arm live execution. Every precondition is re-verified server-side. */
  async arm(params: {
    actor: string;
    passwordOk: boolean;
    confirmAccount: string;
    expectedAccount: string | null;
    acknowledgeRealMoney: boolean;
    secondConfirmation: boolean;
    readiness: ReadinessView;
  }): Promise<void> {
    const refuse = (msg: string, status = 400): never => {
      void this.audit.record({ action: 'LIVE_MODE_ENABLE_REJECTED', actor: params.actor, env: this.env, details: { reason: msg } });
      throw new LiveGateError(msg, status);
    };
    if (this.env !== 'live') refuse('This server is running in PAPER. Live execution can only be armed in a LIVE environment.');
    if (!this.serverLockOpen) refuse('LIVE_TRADING_ENABLED is false on the server. Live orders are refused regardless of this app.', 403);
    if (!params.passwordOk) refuse('Password re-authentication failed.', 401);
    if (!params.acknowledgeRealMoney || !params.secondConfirmation) refuse('Both live-trading confirmations are required.');
    if (!params.expectedAccount || params.confirmAccount !== params.expectedAccount) refuse('Confirmed account does not match the connected live account.');
    if (!params.readiness.ready) {
      const failing = params.readiness.items.filter((i) => !i.ok).map((i) => i.label);
      refuse(`Live readiness checks failing: ${failing.join(', ')}`, 409);
    }
    this.armed = true;
    this.armedAt = this.clock.now();
    this.armedBy = params.actor;
    this.logger.warn({ actor: params.actor, account: params.expectedAccount }, 'LIVE EXECUTION ARMED');
    void this.audit.record({ action: 'LIVE_MODE_ENABLED', actor: params.actor, env: this.env, details: { account: params.expectedAccount, readiness: params.readiness.items.map((i) => ({ id: i.id, ok: i.ok })) } });
    this.timeline.add({ kind: 'control', severity: 'warn', title: 'LIVE EXECUTION ARMED', detail: `${params.expectedAccount} — by ${params.actor}` });
    this.bus.emit('SYSTEM_UPDATED', {});
  }

  disarm(actor: string, reason: string): void {
    if (!this.armed) return;
    this.armed = false;
    this.armedAt = null;
    this.armedBy = null;
    void this.audit.record({ action: 'LIVE_MODE_DISARMED', actor, env: this.env, details: { reason } });
    this.timeline.add({ kind: 'control', title: 'Live execution disarmed', detail: `${reason} — by ${actor}` });
    this.bus.emit('SYSTEM_UPDATED', {});
  }
}

function pick(v: { ok: boolean; detail: string }): { ok: boolean; detail: string } {
  return { ok: v.ok, detail: v.detail };
}
