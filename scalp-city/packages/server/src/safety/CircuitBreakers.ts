import type { BreakerView, TradingEnvironment } from '@scalp-city/shared';
import type { AuditLog } from '../audit/AuditLog.js';
import type { Clock } from '../core/clock.js';
import type { EventBus } from '../core/eventBus.js';
import type { Logger } from '../core/logger.js';
import { nyDate } from '../market/MarketCalendar.js';
import { SETTINGS, type SettingsStore } from '../settings/SettingsStore.js';
import type { Alerts, Timeline } from '../system/Timeline.js';

export type BreakerId =
  | 'API_ERRORS'
  | 'REJECTED_ORDERS'
  | 'ACCOUNT_MISMATCH'
  | 'UNEXPECTED_POSITION'
  | 'DAILY_LOSS'
  | 'CLOCK'
  | 'ACCOUNT_CHANGED';

/**
 * `exitSafe`: risk-reducing automated exits may still run while tripped.
 * Integrity breakers (state can't be trusted) stop automated exits too;
 * manual close / flatten are always available to the user.
 */
export const BREAKERS: Record<BreakerId, { label: string; exitSafe: boolean }> = {
  API_ERRORS: { label: 'Excessive API errors', exitSafe: false },
  REJECTED_ORDERS: { label: 'Multiple rejected orders', exitSafe: true },
  ACCOUNT_MISMATCH: { label: 'Account mismatch', exitSafe: false },
  UNEXPECTED_POSITION: { label: 'Unexpected position', exitSafe: false },
  DAILY_LOSS: { label: 'Daily loss limit', exitSafe: true },
  CLOCK: { label: 'System clock problem', exitSafe: false },
  ACCOUNT_CHANGED: { label: 'Broker account changed', exitSafe: false },
};

interface Latched {
  trippedAt: number;
  detail: string;
  /** NY trading day the trip belongs to (DAILY_LOSS clears on a new day). */
  day: string;
}

/**
 * Automatic trading circuit breakers (spec §90). A tripped breaker stays
 * latched — across restarts — until a person resets it, except DAILY_LOSS,
 * which belongs to its trading day.
 */
export class CircuitBreakers {
  private latched = new Map<BreakerId, Latched>();
  private apiErrors: number[] = [];
  private rejections: number[] = [];
  private badClockReadings = 0;

  constructor(
    private readonly env: TradingEnvironment,
    private readonly settings: SettingsStore,
    private readonly bus: EventBus,
    private readonly audit: AuditLog,
    private readonly alerts: Alerts,
    private readonly timeline: Timeline,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  private key(): string {
    return `${SETTINGS.latchedBreakers}.${this.env}`;
  }

  async load(): Promise<void> {
    const stored = await this.settings.get<Record<string, Latched>>(this.key(), {});
    const today = nyDate(this.clock.now());
    for (const [id, v] of Object.entries(stored)) {
      if (!(id in BREAKERS)) continue;
      if (id === 'DAILY_LOSS' && v.day !== today) continue; // a new trading day
      this.latched.set(id as BreakerId, v);
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.settings.set(this.key(), Object.fromEntries(this.latched), 'system');
  }

  isTripped(id: BreakerId): boolean {
    return this.latched.has(id);
  }

  async trip(id: BreakerId, detail: string): Promise<void> {
    if (this.latched.has(id)) return;
    const now = this.clock.now();
    this.latched.set(id, { trippedAt: now, detail, day: nyDate(now) });
    await this.persist();
    this.logger.error({ breaker: id, detail }, 'CIRCUIT BREAKER TRIPPED');
    void this.audit.record({ action: 'BREAKER_TRIPPED', actor: 'system', env: this.env, details: { breaker: id, detail } });
    this.timeline.add({ kind: 'alert', severity: 'error', title: `Circuit breaker · ${BREAKERS[id].label}`, detail });
    this.alerts.raise(id === 'DAILY_LOSS' ? 'DAILY_LOSS_LIMIT' : id === 'UNEXPECTED_POSITION' ? 'UNEXPECTED_POSITION' : 'CIRCUIT_BREAKER', 'error', `TRADING HALTED — ${BREAKERS[id].label}`, detail);
    this.bus.emit('SYSTEM_UPDATED', {});
  }

  async reset(id: BreakerId, actor: string): Promise<boolean> {
    if (!this.latched.has(id)) return false;
    this.latched.delete(id);
    if (id === 'API_ERRORS') this.apiErrors = [];
    if (id === 'REJECTED_ORDERS') this.rejections = [];
    if (id === 'CLOCK') this.badClockReadings = 0;
    await this.persist();
    void this.audit.record({ action: 'BREAKER_RESET', actor, env: this.env, details: { breaker: id } });
    this.timeline.add({ kind: 'control', title: `Breaker reset · ${BREAKERS[id].label}`, detail: `by ${actor}` });
    this.bus.emit('SYSTEM_UPDATED', {});
    return true;
  }

  /** ≥ 5 broker API failures within 60s. */
  recordApiError(reason: string): void {
    const now = this.clock.now();
    this.apiErrors = this.apiErrors.filter((t) => now - t < 60_000);
    this.apiErrors.push(now);
    if (this.apiErrors.length >= 5) void this.trip('API_ERRORS', `${this.apiErrors.length} broker API failures in 60s — last: ${reason}`);
  }

  /** ≥ 3 broker rejections within 10 minutes. */
  recordRejection(reason: string): void {
    const now = this.clock.now();
    this.rejections = this.rejections.filter((t) => now - t < 600_000);
    this.rejections.push(now);
    if (this.rejections.length >= 3) void this.trip('REJECTED_ORDERS', `${this.rejections.length} rejected orders in 10 min — last: ${reason}`);
  }

  /** Three consecutive bad clock readings latch the CLOCK breaker. */
  recordClock(ok: boolean, skewMs: number | null): void {
    if (ok) {
      this.badClockReadings = 0;
      return;
    }
    this.badClockReadings++;
    if (this.badClockReadings >= 3) void this.trip('CLOCK', `server clock differs from broker by ${skewMs ?? '?'}ms`);
  }

  tripped(): { id: string; label: string; exitSafe: boolean }[] {
    return [...this.latched.keys()].map((id) => ({ id, ...BREAKERS[id] }));
  }

  views(): BreakerView[] {
    return (Object.keys(BREAKERS) as BreakerId[]).map((id) => {
      const l = this.latched.get(id);
      return { id, label: BREAKERS[id].label, tripped: !!l, trippedAt: l?.trippedAt ?? null, detail: l?.detail ?? null, latched: id !== 'DAILY_LOSS' };
    });
  }
}
