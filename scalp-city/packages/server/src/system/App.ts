import type { TradingEnvironment } from '@scalp-city/shared';
import { AuditLog } from '../audit/AuditLog.js';
import { AuthService } from '../auth/AuthService.js';
import type { BrokerAdapter } from '../broker/types.js';
import type { AppConfig } from '../config/env.js';
import type { Clock } from '../core/clock.js';
import { EventBus } from '../core/eventBus.js';
import type { Logger } from '../core/logger.js';
import type { Db } from '../db/db.js';
import { migrate } from '../db/migrations.js';
import type { MarketDataProvider } from '../marketdata/types.js';
import { SettingsStore } from '../settings/SettingsStore.js';
import { WorkerRepository } from '../workers/WorkerRepository.js';
import { TradingContext, type TradingContextOptions } from './TradingContext.js';
import { ViewBuilder } from './ViewBuilder.js';

export interface AppOptions {
  config: AppConfig;
  db: Db;
  clock: Clock;
  logger: Logger;
  brokerFactory?: (env: TradingEnvironment) => BrokerAdapter;
  providerFactory?: (env: TradingEnvironment) => MarketDataProvider;
  timings?: TradingContextOptions['timings'];
}

/**
 * Process-level owner: database, bus, audit, auth, and the single active
 * TradingContext. Switching PAPER ↔ LIVE tears the context down completely
 * and rebuilds it through the recovery sequence; it never happens silently.
 */
export class App {
  readonly config: AppConfig;
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly bus: EventBus;
  readonly audit: AuditLog;
  readonly settings: SettingsStore;
  readonly auth: AuthService;
  readonly views: ViewBuilder;
  ctx!: TradingContext;
  /** First-run setup code to print on the console (null when an account exists). */
  setupCode: string | null = null;
  private switching = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly o: AppOptions) {
    this.config = o.config;
    this.db = o.db;
    this.clock = o.clock;
    this.logger = o.logger;
    this.bus = new EventBus(o.logger);
    this.audit = new AuditLog(o.db, o.logger.child({ component: 'audit' }), o.clock);
    this.settings = new SettingsStore(o.db);
    this.auth = new AuthService(o.db, o.config.sessionSecret, o.clock);
    this.views = new ViewBuilder(o.config, o.db, o.clock);
  }

  async init(): Promise<void> {
    const applied = await migrate(this.db, (m) => this.logger.info(m));
    if (applied) this.logger.info({ applied }, 'database migrated');
    await new WorkerRepository(this.db).seed();
    this.setupCode = await this.auth.prepareSetup();
    void this.audit.record({
      action: 'SYSTEM_START',
      actor: 'system',
      env: this.config.tradingEnvironment,
      details: { liveTradingEnabled: this.config.liveTradingEnabled, stockFeed: this.config.stockFeed, optionsFeed: this.config.optionsFeed, nonStandardEndpoints: this.config.nonStandardEndpoints },
    });
    this.ctx = this.createContext(this.config.tradingEnvironment);
    await this.ctx.start();
    await this.views.refresh(this.ctx.env);
    this.timers.push(setInterval(() => void this.views.refresh(this.ctx.env), 10_000));
    this.bus.on('POSITION_CLOSED', () => void this.views.refresh(this.ctx.env));
    this.bus.on('FILL', () => void this.views.refresh(this.ctx.env));
  }

  private createContext(env: TradingEnvironment): TradingContext {
    return new TradingContext({
      env,
      config: this.config,
      db: this.db,
      bus: this.bus,
      audit: this.audit,
      settings: this.settings,
      clock: this.clock,
      logger: this.logger,
      brokerFactory: this.o.brokerFactory,
      providerFactory: this.o.providerFactory,
      timings: this.o.timings,
    });
  }

  availableEnvs(): TradingEnvironment[] {
    return (['paper', 'live'] as TradingEnvironment[]).filter((e) => this.config.credentials[e] !== null);
  }

  get isSwitching(): boolean {
    return this.switching;
  }

  /**
   * Switch environments (spec §32). The caller has already re-authenticated
   * the user and collected explicit confirmation. Workers stop, streams
   * close, and the new environment starts disarmed with autotrading OFF.
   */
  async switchEnvironment(target: TradingEnvironment, actor: string): Promise<void> {
    if (this.switching) throw new Error('an environment switch is already in progress');
    if (target === this.ctx.env) return;
    if (!this.config.credentials[target]) throw new Error(`no credentials configured for ${target.toUpperCase()}`);
    this.switching = true;
    const from = this.ctx.env;
    try {
      this.ctx.liveGate.disarm(actor, 'environment switch');
      this.ctx.workers?.disableAll(actor);
      this.ctx.controls.setAutotrading(false, actor);
      this.ctx.phase = 'SWITCHING_ENVIRONMENT';
      this.bus.emit('SYSTEM_UPDATED', {});
      await this.ctx.stop();
      void this.audit.record({ action: 'ENV_SWITCHED', actor, env: target, details: { from, to: target } });
      this.ctx = this.createContext(target);
      await this.ctx.start();
      await this.views.refresh(target);
      this.ctx.timeline.add({ kind: 'system', severity: 'warn', title: `Environment switched to ${target.toUpperCase()}`, detail: `from ${from.toUpperCase()} by ${actor}` });
    } finally {
      this.switching = false;
      this.bus.emit('SYSTEM_UPDATED', {});
    }
  }

  async shutdown(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    await this.ctx?.stop();
    await this.audit.flush();
  }
}
