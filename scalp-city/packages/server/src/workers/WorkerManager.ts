import type { WorkerConfigView, WorkerUpdateRequest, WorkerView } from '@scalp-city/shared';
import type { AuditLog } from '../audit/AuditLog.js';
import { Worker, type WorkerDeps } from './Worker.js';
import type { WorkerRepository } from './WorkerRepository.js';

export class WorkerConfigError extends Error {}

/** Validate a worker config change; returns the merged config. */
export function mergeWorkerConfig(current: WorkerConfigView, patch: WorkerUpdateRequest): WorkerConfigView {
  if (patch.instrument !== undefined && (current.instrument === 'CFD') !== ((patch.instrument as string) === 'CFD')) {
    throw new WorkerConfigError(`${current.name} trades ${current.instrument === 'CFD' ? 'the instrument itself' : current.instrument.toLowerCase()} — it cannot switch to ${patch.instrument}`);
  }
  const next: WorkerConfigView = {
    ...current,
    instrument: patch.instrument ?? current.instrument,
    allowShort: patch.allowShort ?? current.allowShort,
    limits: { ...current.limits, ...(patch.limits ?? {}) },
    exits: { ...current.exits, ...(patch.exits ?? {}) },
    options: { ...current.options, ...(patch.options ?? {}) },
  };
  const positive = (v: number, name: string) => {
    if (!Number.isFinite(v) || v <= 0) throw new WorkerConfigError(`${name} must be a positive number`);
  };
  const nonNeg = (v: number, name: string) => {
    if (!Number.isFinite(v) || v < 0) throw new WorkerConfigError(`${name} must be zero or more`);
  };
  const L = next.limits;
  positive(L.maxTradesPerDay, 'max trades');
  positive(L.maxContracts, 'max contracts');
  positive(L.maxShares, 'max shares');
  positive(L.maxPositionNotional, 'max position');
  positive(L.dailyLossLimit, 'daily loss limit');
  positive(L.dailyGoal, 'daily goal');
  positive(L.riskPerTrade, 'risk per trade');
  const X = next.exits;
  positive(X.takeProfitPct, 'take profit');
  positive(X.stopLossPct, 'stop loss');
  positive(X.stopAtr, 'stop (ATR)');
  positive(X.targetAtr, 'target (ATR)');
  if (X.stopAtr < 0.5 || X.stopAtr > 10) throw new WorkerConfigError('stop (ATR) must be between 0.5 and 10');
  if (X.targetAtr < 0.5 || X.targetAtr > 20) throw new WorkerConfigError('target (ATR) must be between 0.5 and 20');
  positive(X.maxHoldMinutes, 'max hold');
  nonNeg(X.flattenBeforeCloseMinutes, 'flatten before close');
  nonNeg(X.cooldownBars, 'cooldown');
  const O = next.options;
  nonNeg(O.minDte, 'min DTE');
  if (O.maxDte < O.minDte) throw new WorkerConfigError('max DTE must be ≥ min DTE');
  positive(O.maxSpreadPct, 'max spread %');
  positive(O.maxSpreadAbs, 'max spread $');
  nonNeg(O.minVolume, 'min volume');
  nonNeg(O.minOpenInterest, 'min open interest');
  nonNeg(O.minBidSize, 'min bid size');
  if (!Number.isInteger(O.strikeOffset) || Math.abs(O.strikeOffset) > 5) throw new WorkerConfigError('strike offset must be an integer between −5 and 5');
  return next;
}

/** True when the change allows the worker to risk more. */
export function workerChangeIncreasesRisk(a: WorkerConfigView, b: WorkerConfigView): boolean {
  return (
    b.limits.maxTradesPerDay > a.limits.maxTradesPerDay ||
    b.limits.maxContracts > a.limits.maxContracts ||
    b.limits.maxShares > a.limits.maxShares ||
    b.limits.maxPositionNotional > a.limits.maxPositionNotional ||
    b.limits.dailyLossLimit > a.limits.dailyLossLimit ||
    b.limits.riskPerTrade > a.limits.riskPerTrade ||
    b.exits.stopLossPct > a.exits.stopLossPct ||
    b.exits.maxHoldMinutes > a.exits.maxHoldMinutes ||
    b.options.maxSpreadPct > a.options.maxSpreadPct ||
    b.options.maxSpreadAbs > a.options.maxSpreadAbs ||
    b.options.minVolume < a.options.minVolume ||
    b.options.minOpenInterest < a.options.minOpenInterest ||
    (b.allowShort && !a.allowShort)
  );
}

export class WorkerManager {
  private workers = new Map<string, Worker>();
  private ticking = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private offs: (() => void)[] = [];

  constructor(
    private readonly deps: WorkerDeps,
    private readonly repo: WorkerRepository,
    private readonly audit: AuditLog,
  ) {}

  async load(): Promise<void> {
    for (const cfg of await this.repo.list(this.deps.venue, this.deps.workerIds ?? undefined)) this.workers.set(cfg.id, new Worker(cfg, this.deps));
  }

  async start(): Promise<void> {
    await this.deps.stats.refresh().catch(() => undefined);
    for (const w of this.workers.values()) await w.warmStart();
    const bus = this.deps.bus;
    this.offs.push(
      bus.on('MARKET_BAR', ({ bar, kind }) => {
        if (kind !== 'closed') return;
        for (const w of this.workers.values()) if (w.config.symbol === bar.symbol) void this.tickWorker(w);
      }),
    );
    this.offs.push(
      bus.on('ORDER_UPDATED', ({ order }) => {
        if (!order.workerId) return;
        this.workers.get(order.workerId)?.onOrderUpdated(order);
        bus.emit('WORKER_UPDATED', { workerId: order.workerId });
      }),
    );
    this.offs.push(
      bus.on('POSITION_CLOSED', ({ trade }) => {
        void this.deps.stats.refresh().then(() => {
          if (trade.workerId) {
            this.workers.get(trade.workerId)?.onPositionClosed(trade.realizedPnl);
            bus.emit('WORKER_UPDATED', { workerId: trade.workerId });
          }
        });
      }),
    );
    this.offs.push(
      bus.on('POSITION_OPENED', ({ trade }) => {
        if (trade.workerId) bus.emit('WORKER_UPDATED', { workerId: trade.workerId });
      }),
    );
    this.timer = setInterval(() => {
      for (const w of this.workers.values()) void this.tickWorker(w);
    }, 1000);
    this.statsTimer = setInterval(() => void this.deps.stats.refresh().catch(() => undefined), 30_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.timer = null;
    this.statsTimer = null;
    for (const off of this.offs) off();
    this.offs = [];
    for (const w of this.workers.values()) w.autotradeEnabled = false;
  }

  private async tickWorker(w: Worker): Promise<void> {
    if (this.ticking.has(w.id)) return;
    this.ticking.add(w.id);
    try {
      await w.tick();
    } catch (err) {
      this.deps.logger.error({ err, worker: w.id }, 'worker tick failed');
    } finally {
      this.ticking.delete(w.id);
    }
  }

  get(id: string): Worker | null {
    return this.workers.get(id) ?? null;
  }

  all(): Worker[] {
    return [...this.workers.values()];
  }

  underlyings(): string[] {
    return [...new Set(this.all().map((w) => w.config.symbol))];
  }

  views(): WorkerView[] {
    return this.all().map((w) => w.view());
  }

  setEnabled(id: string, enabled: boolean, actor: string): void {
    const w = this.workers.get(id);
    if (!w) throw new WorkerConfigError(`unknown worker ${id}`);
    if (w.autotradeEnabled === enabled) return;
    w.autotradeEnabled = enabled;
    void this.audit.record({ action: enabled ? 'WORKER_ENABLED' : 'WORKER_DISABLED', actor, env: this.deps.env, workerId: id, symbol: w.config.symbol });
    this.deps.timeline.add({ kind: 'control', workerId: id, symbol: w.config.symbol, title: `${w.config.name} autotrading ${enabled ? 'ON' : 'OFF'}`, detail: `by ${actor}` });
    this.deps.bus.emit('WORKER_UPDATED', { workerId: id });
  }

  disableAll(actor: string): void {
    for (const w of this.workers.values()) if (w.autotradeEnabled) this.setEnabled(w.id, false, actor);
  }

  async updateConfig(id: string, patch: WorkerUpdateRequest, actor: string): Promise<WorkerConfigView> {
    const w = this.workers.get(id);
    if (!w) throw new WorkerConfigError(`unknown worker ${id}`);
    if ((patch.instrument && patch.instrument !== w.config.instrument) && (w.position() || w.view().activeOrderId)) {
      throw new WorkerConfigError('cannot change instrument while the worker holds a position or order');
    }
    const next = mergeWorkerConfig(w.config, patch);
    await this.repo.update(next);
    const before = w.config;
    w.config = next;
    void this.audit.record({ action: 'WORKER_CONFIG_CHANGED', actor, env: this.deps.env, workerId: id, details: { before: { limits: before.limits, exits: before.exits, options: before.options, instrument: before.instrument }, after: { limits: next.limits, exits: next.exits, options: next.options, instrument: next.instrument } } });
    this.deps.bus.emit('WORKER_UPDATED', { workerId: id });
    return next;
  }
}
