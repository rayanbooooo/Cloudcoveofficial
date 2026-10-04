import type { FlattenStatusView, TradingEnvironment } from '@scalp-city/shared';
import type { AccountService } from '../account/AccountService.js';
import type { AuditLog } from '../audit/AuditLog.js';
import type { BrokerAdapter } from '../broker/types.js';
import type { Clock } from '../core/clock.js';
import { sleep } from '../core/clock.js';
import type { EventBus } from '../core/eventBus.js';
import { newId } from '../core/ids.js';
import type { Logger } from '../core/logger.js';
import type { OrderEngine } from '../orders/OrderEngine.js';
import { SETTINGS, type SettingsStore } from '../settings/SettingsStore.js';
import type { Alerts, Timeline } from '../system/Timeline.js';

export interface KillSwitchState {
  active: boolean;
  activatedAt: number | null;
  activatedBy: string | null;
  reason: string | null;
}

const KILL_OFF: KillSwitchState = { active: false, activatedAt: null, activatedBy: null, reason: null };

/**
 * Operator controls (spec §29, §30, §59–61, §100).
 *
 *  AUTOTRADING OFF  workers analyse and signal but submit nothing
 *  PAUSE ENTRIES    no new entries; workers keep managing exits
 *  KILL SWITCH      autotrading off + cancel working orders + block all
 *                   automated orders; persisted across restarts
 *  FLATTEN ALL      explicit, confirmed: close every broker position and
 *                   verify the fills
 *
 * Autotrading always starts OFF after a restart (spec §94).
 */
export class Controls {
  autotrading = false;
  entriesPaused = false;
  killSwitch: KillSwitchState = { ...KILL_OFF };
  flatten: FlattenStatusView | null = null;

  constructor(
    private readonly env: TradingEnvironment,
    private readonly settings: SettingsStore,
    private readonly bus: EventBus,
    private readonly audit: AuditLog,
    private readonly timeline: Timeline,
    private readonly alerts: Alerts,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async load(): Promise<void> {
    this.killSwitch = await this.settings.get<KillSwitchState>(SETTINGS.killSwitch, { ...KILL_OFF });
  }

  private changed(): void {
    this.bus.emit('SYSTEM_UPDATED', {});
  }

  setAutotrading(on: boolean, actor: string): { ok: boolean; message: string } {
    if (on && this.killSwitch.active) return { ok: false, message: 'release the kill switch first' };
    if (this.autotrading === on) return { ok: true, message: `autotrading already ${on ? 'on' : 'off'}` };
    this.autotrading = on;
    void this.audit.record({ action: on ? 'AUTOTRADING_ON' : 'AUTOTRADING_OFF', actor, env: this.env });
    this.timeline.add({ kind: 'control', severity: on ? 'info' : 'warn', title: `Autotrading ${on ? 'ON' : 'OFF'}`, detail: `by ${actor}` });
    this.changed();
    return { ok: true, message: `autotrading ${on ? 'on' : 'off'}` };
  }

  setEntriesPaused(paused: boolean, actor: string, reason?: string): void {
    if (this.entriesPaused === paused) return;
    this.entriesPaused = paused;
    void this.audit.record({ action: paused ? 'ENTRIES_PAUSED' : 'ENTRIES_RESUMED', actor, env: this.env, details: { reason: reason ?? null } });
    this.timeline.add({ kind: 'control', severity: paused ? 'warn' : 'info', title: paused ? 'Entries paused' : 'Entries resumed', detail: reason ?? `by ${actor}` });
    this.changed();
  }

  /**
   * KILL SWITCH. Instant: no confirmation, because it only ever reduces
   * activity. Does NOT liquidate positions — FLATTEN ALL is separate.
   */
  async activateKillSwitch(actor: string, reason: string, orders: OrderEngine | null): Promise<{ canceled: number; failed: string[] }> {
    this.killSwitch = { active: true, activatedAt: this.clock.now(), activatedBy: actor, reason };
    this.autotrading = false;
    await this.settings.set(SETTINGS.killSwitch, this.killSwitch, actor);
    this.changed();
    this.bus.emit('KILL_SWITCH', { active: true, by: actor, reason });
    void this.audit.record({ action: 'KILL_SWITCH', actor, env: this.env, details: { reason } });
    this.timeline.add({ kind: 'control', severity: 'error', title: 'KILL SWITCH ACTIVATED', detail: `${reason} — by ${actor}` });
    this.alerts.raise('KILL_SWITCH', 'error', 'KILL SWITCH ACTIVATED', 'All workers stopped. Working orders canceled. Positions are NOT closed — use FLATTEN ALL to close them.');
    this.bus.emit('CITY_EVENT', { id: newId('ce'), ts: this.clock.now(), kind: 'KILL_SWITCH', workerId: null, symbol: '*', direction: 'NEUTRAL', qty: 0, price: null, pnl: null, assetClass: 'us_equity' });
    const r = orders ? await orders.cancelAllWorking(actor) : { requested: 0, failed: [] as string[] };
    this.logger.error({ actor, reason, canceled: r.requested, failed: r.failed.length }, 'KILL SWITCH');
    return { canceled: r.requested, failed: r.failed };
  }

  async releaseKillSwitch(actor: string): Promise<void> {
    if (!this.killSwitch.active) return;
    this.killSwitch = { ...KILL_OFF };
    await this.settings.set(SETTINGS.killSwitch, this.killSwitch, actor);
    void this.audit.record({ action: 'KILL_SWITCH_RELEASED', actor, env: this.env });
    this.timeline.add({ kind: 'control', title: 'Kill switch released', detail: `by ${actor} — autotrading remains OFF` });
    this.bus.emit('KILL_SWITCH', { active: false, by: actor, reason: null });
    this.changed();
  }

  /**
   * FLATTEN ALL (spec §30): cancel working orders, read the broker's actual
   * positions, submit a closing order for each through the order engine
   * (and therefore the risk engine), then watch the broker until the
   * positions are gone. Nothing is zeroed locally — only broker fills count.
   */
  async flattenAll(actor: string, deps: { broker: BrokerAdapter; account: AccountService; orders: OrderEngine }): Promise<FlattenStatusView> {
    if (this.flatten?.inProgress) return this.flatten;
    const status: FlattenStatusView = { inProgress: true, startedAt: this.clock.now(), finishedAt: null, total: 0, closed: 0, messages: [] };
    this.flatten = status;
    const note = (m: string) => {
      status.messages.push(m);
      this.changed();
    };
    this.setEntriesPaused(true, actor, 'FLATTEN ALL');
    void this.audit.record({ action: 'FLATTEN_ALL', actor, env: this.env });
    this.timeline.add({ kind: 'control', severity: 'warn', title: 'FLATTEN ALL started', detail: `by ${actor}` });

    try {
      // 1. Working orders can hold quantity (qty_available) — cancel everything at the broker.
      await deps.orders.cancelAllWorking(actor);
      const canceled = await deps.broker.cancelAllOrders().catch((err: Error) => {
        note(`cancel-all at broker failed: ${err.message}`);
        return [];
      });
      if (canceled.length) note(`requested cancel of ${canceled.length} open order(s) at broker`);
      for (let i = 0; i < 20; i++) {
        await deps.account.refreshOpenOrders().catch(() => undefined);
        if (deps.account.openOrders.length === 0) break;
        await sleep(500);
      }

      // 2. Authoritative positions.
      await deps.account.refreshPositions();
      const positions = deps.account.positions.slice();
      status.total = positions.length;
      if (positions.length === 0) note('no open positions at broker');

      // 3. One closing order per position, through the same risk engine.
      for (const p of positions) {
        const isOption = p.assetClass === 'us_option';
        const side = p.side === 'long' ? 'sell' : 'buy';
        const qty = p.qtyAvailable ?? p.qty;
        if (qty <= 0) {
          note(`${p.symbol}: no quantity available to close (held by open orders?)`);
          continue;
        }
        const order = await deps.orders.submit({
          workerId: null,
          source: 'FLATTEN',
          purpose: 'FLATTEN',
          signalId: null,
          symbol: p.symbol,
          underlying: null,
          assetClass: p.assetClass,
          side,
          positionIntent: isOption ? (side === 'sell' ? 'sell_to_close' : 'buy_to_close') : null,
          type: 'market',
          timeInForce: 'day',
          qty,
          limitPrice: null,
          stopPrice: null,
          meta: { multiplier: isOption ? 100 : 1, exitReason: 'FLATTEN_ALL' },
          actor,
        });
        note(`${p.symbol}: ${side} ${qty} → ${order.state}${order.rejectReason ? ` (${order.rejectReason})` : ''}`);
      }

      // 4. Verify against the broker.
      for (let i = 0; i < 60; i++) {
        await sleep(1000);
        await deps.account.refreshPositions().catch(() => undefined);
        const remaining = deps.account.positions.filter((p) => positions.some((q) => q.symbol === p.symbol));
        status.closed = positions.length - remaining.length;
        this.changed();
        if (remaining.length === 0) break;
      }
      const left = deps.account.positions.filter((p) => positions.some((q) => q.symbol === p.symbol));
      note(left.length === 0 ? 'all positions closed — confirmed by broker' : `still open at broker: ${left.map((p) => `${p.symbol} ${p.qty}`).join(', ')}`);
    } catch (err) {
      note(`flatten error: ${(err as Error).message}`);
    } finally {
      status.inProgress = false;
      status.finishedAt = this.clock.now();
      this.timeline.add({ kind: 'control', severity: status.closed === status.total ? 'success' : 'error', title: 'FLATTEN ALL finished', detail: `${status.closed}/${status.total} closed` });
      this.changed();
    }
    return status;
  }
}
