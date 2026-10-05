import type { RiskLimits, RiskLimitsChangePreview, Venue } from '@scalp-city/shared';
import { SETTINGS, type SettingsStore } from '../settings/SettingsStore.js';

/** For each limit: does a HIGHER value allow more risk? */
const HIGHER_IS_RISKIER: Record<keyof RiskLimits, boolean> = {
  maxDailyLoss: true,
  maxPositionNotional: true,
  maxOrderNotional: true,
  maxContracts: true,
  maxShares: true,
  maxConcurrentPositions: true,
  maxTradesPerDay: true,
  maxOrdersPerMinute: true,
  maxPriceDeviationPct: true,
  noEntriesBeforeCloseMinutes: false,
  pdtGuard: false,
  maxRiskPerTrade: true,
};

export class RiskLimitsError extends Error {}

/**
 * Global risk limits. Seeded from the environment on first boot, then
 * managed in-app. Limits can be tightened freely; loosening requires an
 * explicit confirmation (and re-authentication while LIVE) and is audited.
 * There is no "disable": every limit must stay a positive finite number.
 */
export class RiskSettings {
  private limits!: RiskLimits;
  private readonly key: string;

  /**
   * Limits are kept per broker: notional sizes that suit options are far too
   * small for leveraged FX/CFDs (and vice versa). Alpaca keeps the original key.
   */
  constructor(
    private readonly store: SettingsStore,
    private readonly defaults: RiskLimits,
    venue: Venue = 'alpaca',
  ) {
    this.key = venue === 'alpaca' ? SETTINGS.riskLimits : `${SETTINGS.riskLimits}.${venue}`;
  }

  async load(): Promise<void> {
    const stored = await this.store.get<Partial<RiskLimits> | null>(this.key, null);
    this.limits = { ...this.defaults, ...(stored ?? {}) };
    if (!stored) await this.store.set(this.key, this.limits, 'system:seed');
  }

  get(): RiskLimits {
    return { ...this.limits };
  }

  validate(next: RiskLimits): void {
    for (const [k, v] of Object.entries(next) as [keyof RiskLimits, number | boolean][]) {
      if (k === 'pdtGuard') {
        if (typeof v !== 'boolean') throw new RiskLimitsError('pdtGuard must be true or false');
        continue;
      }
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new RiskLimitsError(`${k} must be a non-negative number`);
      if (k !== 'noEntriesBeforeCloseMinutes' && v <= 0) throw new RiskLimitsError(`${k} must be greater than zero — limits cannot be disabled`);
      const ints: (keyof RiskLimits)[] = ['maxContracts', 'maxShares', 'maxConcurrentPositions', 'maxTradesPerDay', 'maxOrdersPerMinute'];
      if (ints.includes(k) && !Number.isInteger(v)) throw new RiskLimitsError(`${k} must be a whole number`);
    }
  }

  preview(patch: Partial<RiskLimits>, live: boolean): { next: RiskLimits; preview: RiskLimitsChangePreview } {
    const cur = this.get();
    const next = { ...cur } as RiskLimits;
    const changes: RiskLimitsChangePreview['changes'] = [];
    for (const [k, v] of Object.entries(patch) as [keyof RiskLimits, number | boolean][]) {
      if (!(k in HIGHER_IS_RISKIER) || v === undefined) continue;
      const from = cur[k];
      if (from === v) continue;
      (next as unknown as Record<string, number | boolean>)[k] = v;
      const increasesRisk =
        typeof v === 'boolean' ? from === true && v === false : HIGHER_IS_RISKIER[k] ? (v as number) > (from as number) : (v as number) < (from as number);
      changes.push({ key: k, from, to: v, increasesRisk });
    }
    this.validate(next);
    const increasesRisk = changes.some((c) => c.increasesRisk);
    return { next, preview: { increasesRisk, changes, requiresPassword: increasesRisk && live } };
  }

  async apply(next: RiskLimits, actor: string): Promise<void> {
    this.validate(next);
    this.limits = { ...next };
    await this.store.set(this.key, this.limits, actor);
  }
}
