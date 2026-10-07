import { DateTime } from 'luxon';
import { instrumentName, maskAccountNumber, type HaltReason, type SystemPhase, type TradingEnvironment, type Venue } from '@scalp-city/shared';
import { AccountService } from '../account/AccountService.js';
import type { AuditLog } from '../audit/AuditLog.js';
import { AlpacaBrokerAdapter } from '../broker/alpaca/AlpacaBrokerAdapter.js';
import { OandaBrokerAdapter } from '../broker/oanda/OandaBrokerAdapter.js';
import type { BrokerAdapter, StreamStatus } from '../broker/types.js';
import { assertLiveEndpoints, hasCredentials, oandaStreamUrl, tradingBaseUrl, tradingStreamUrl, type AppConfig } from '../config/env.js';
import type { Clock } from '../core/clock.js';
import { sleep } from '../core/clock.js';
import type { EventBus } from '../core/eventBus.js';
import type { Logger } from '../core/logger.js';
import type { Db } from '../db/db.js';
import { InstrumentCatalog } from '../market/InstrumentCatalog.js';
import { MarketCalendar, nyDate } from '../market/MarketCalendar.js';
import { AlpacaMarketDataProvider } from '../marketdata/alpaca/AlpacaMarketDataProvider.js';
import { MarketDataService } from '../marketdata/MarketDataService.js';
import { OandaMarketDataProvider } from '../marketdata/oanda/OandaMarketDataProvider.js';
import type { MarketDataProvider } from '../marketdata/types.js';
import { ContractSelector } from '../options/ContractSelector.js';
import { OrderEngine } from '../orders/OrderEngine.js';
import { PositionLedger } from '../positions/PositionLedger.js';
import { LiveRiskContext } from '../risk/RiskContext.js';
import { RiskSettings } from '../risk/RiskSettings.js';
import { CircuitBreakers } from '../safety/CircuitBreakers.js';
import { Controls } from '../safety/Controls.js';
import { LiveGate } from '../safety/LiveGate.js';
import { Reconciler } from '../safety/Reconciler.js';
import type { SettingsStore } from '../settings/SettingsStore.js';
import { SignalRepository } from '../workers/SignalRepository.js';
import { WorkerManager } from '../workers/WorkerManager.js';
import { activeWorkerIds } from '../workers/definitions.js';
import { WorkerRepository } from '../workers/WorkerRepository.js';
import { WorkerStatsService } from '../workers/WorkerStats.js';
import { Alerts, Timeline } from './Timeline.js';

export interface TradingContextOptions {
  env: TradingEnvironment;
  config: AppConfig;
  db: Db;
  bus: EventBus;
  audit: AuditLog;
  settings: SettingsStore;
  clock: Clock;
  logger: Logger;
  /** Test seams. Production uses the configured broker's implementations. */
  brokerFactory?: (env: TradingEnvironment) => BrokerAdapter;
  providerFactory?: (env: TradingEnvironment) => MarketDataProvider;
  /** Faster loops for tests. */
  timings?: { recoveryRetryMs?: number; orderSyncMs?: number; reconcileMs?: number; marketDataWaitMs?: number };
}

/**
 * Everything needed to trade one environment (paper or live), wired
 * together. Paper and live use the exact same classes; only the broker
 * endpoint and credentials differ (spec §105).
 */
export class TradingContext {
  readonly env: TradingEnvironment;
  readonly venue: Venue;
  readonly configured: boolean;
  phase: SystemPhase = 'BOOTING';
  phaseDetail = '';
  broker!: BrokerAdapter;
  provider!: MarketDataProvider;
  calendar!: MarketCalendar;
  instruments!: InstrumentCatalog;
  marketData!: MarketDataService;
  account!: AccountService;
  ledger!: PositionLedger;
  orders!: OrderEngine;
  riskSettings!: RiskSettings;
  breakers!: CircuitBreakers;
  controls!: Controls;
  liveGate!: LiveGate;
  reconciler!: Reconciler;
  selector!: ContractSelector;
  workers!: WorkerManager;
  stats!: WorkerStatsService;
  readonly timeline: Timeline;
  readonly alerts: Alerts;
  private signals!: SignalRepository;
  private timers: NodeJS.Timeout[] = [];
  private offs: (() => void)[] = [];
  private stopped = false;
  private ready = false;
  private tradeStreamWasConnected = false;

  constructor(private readonly o: TradingContextOptions) {
    this.env = o.env;
    this.venue = o.config.venue;
    this.configured = hasCredentials(o.config, o.env);
    this.timeline = new Timeline(this.venue, o.env, o.db, o.bus, o.clock, o.logger.child({ component: 'timeline' }));
    this.alerts = new Alerts(o.bus, o.clock);
    this.riskSettings = new RiskSettings(o.settings, o.config.riskDefaults, this.venue);
    // The calendar is built further down; the breakers only ask which trading day it is after construction.
    this.breakers = new CircuitBreakers(o.env, o.settings, o.bus, o.audit, this.alerts, this.timeline, o.clock, o.logger.child({ component: 'breakers' }), this.venue, (t) => (this.calendar ? this.calendar.tradingDay(t) : nyDate(t)));
    this.controls = new Controls(o.env, o.settings, o.bus, o.audit, this.timeline, this.alerts, o.clock, o.logger.child({ component: 'controls' }));
    this.liveGate = new LiveGate(o.env, o.config.liveTradingEnabled, o.audit, this.timeline, o.bus, o.clock, o.logger.child({ component: 'live-gate' }));
    if (!this.configured) return;

    if (o.env === 'live') assertLiveEndpoints(o.config);
    const log = o.logger.child({ env: o.env, broker: this.venue });
    if (this.venue === 'oanda') {
      const creds = o.config.oanda.credentials[o.env]!;
      this.broker =
        o.brokerFactory?.(o.env) ??
        new OandaBrokerAdapter({
          env: o.env,
          apiUrl: tradingBaseUrl(o.config, o.env),
          streamUrl: oandaStreamUrl(o.config, o.env),
          credentials: creds,
          session: o.config.oanda.session,
          skipUsHolidays: o.config.oanda.skipUsHolidays,
          instruments: o.config.symbols,
          logger: log,
          clock: o.clock,
        });
      this.provider =
        o.providerFactory?.(o.env) ??
        new OandaMarketDataProvider({
          apiUrl: tradingBaseUrl(o.config, o.env),
          streamUrl: oandaStreamUrl(o.config, o.env),
          credentials: creds,
          logger: log,
          clock: o.clock,
        });
    } else {
      const creds = o.config.credentials[o.env]!;
      this.broker =
        o.brokerFactory?.(o.env) ??
        new AlpacaBrokerAdapter({
          env: o.env,
          baseUrl: tradingBaseUrl(o.config, o.env),
          streamUrl: tradingStreamUrl(o.config, o.env),
          credentials: creds,
          logger: log,
          clock: o.clock,
        });
      this.provider =
        o.providerFactory?.(o.env) ??
        new AlpacaMarketDataProvider({
          dataUrl: o.config.endpoints.data,
          dataStreamUrl: o.config.endpoints.dataStream,
          stockFeed: o.config.stockFeed,
          overnightFeed: o.config.sessions === 'all' ? o.config.overnightFeed : null,
          optionsFeed: o.config.optionsFeed,
          credentials: creds,
          logger: log,
          clock: o.clock,
        });
    }
    this.calendar = new MarketCalendar(this.broker, o.db, o.clock, log.child({ component: 'calendar' }), o.config.thresholds.maxClockSkewMs, o.config.sessions);
    this.instruments = new InstrumentCatalog(this.broker, o.clock, log.child({ component: 'instruments' }));
    this.marketData = new MarketDataService(this.provider, this.calendar, o.bus, o.clock, log.child({ component: 'market-data' }), {
      env: o.env,
      symbols: o.config.symbols,
      maxDataAgeMs: o.config.thresholds.maxDataAgeMs,
      offHoursMaxDataAgeMs: o.config.thresholds.offHoursMaxDataAgeMs,
      maxOptionQuoteAgeMs: o.config.thresholds.maxOptionQuoteAgeMs,
      paperAllowIndicativeOptions: o.config.paperAllowIndicativeOptions,
      // OANDA's official minute candle is fetched just after the minute; give it time to land.
      barGraceMs: this.venue === 'oanda' ? 9000 : undefined,
    });
    this.account = new AccountService(this.broker, o.db, o.bus, o.clock, log.child({ component: 'account' }), { env: o.env });
    this.ledger = new PositionLedger(this.venue, o.env, o.db, o.clock, log.child({ component: 'ledger' }), this.calendar.tradingDay);
    this.selector = new ContractSelector(this.broker, this.provider, o.clock, log.child({ component: 'options' }));
    this.stats = new WorkerStatsService(this.venue, o.env, o.db, o.clock, { key: this.calendar.tradingDay, start: this.calendar.tradingDayStart });
    this.signals = new SignalRepository(this.venue, o.env, o.db);

    let engine: OrderEngine | null = null;
    const risk = new LiveRiskContext({
      env: o.env,
      clock: o.clock,
      broker: this.broker,
      provider: this.provider,
      account: this.account,
      calendar: this.calendar,
      marketData: this.marketData,
      instruments: this.instruments,
      ledger: this.ledger,
      selector: this.selector,
      controls: this.controls,
      liveGate: this.liveGate,
      breakers: this.breakers,
      reconciler: () => this.reconciler,
      riskSettings: this.riskSettings,
      stats: this.stats,
      workers: () => this.workers ?? null,
      signalHasOrder: (id, exclude) => engine!.repository.signalHasOrder(id, exclude),
      allowedUnderlyings: o.config.symbols,
    });
    engine = new OrderEngine({
      venue: this.venue,
      env: o.env,
      broker: this.broker,
      db: o.db,
      ledger: this.ledger,
      bus: o.bus,
      audit: o.audit,
      timeline: this.timeline,
      alerts: this.alerts,
      clock: o.clock,
      logger: log.child({ component: 'orders' }),
      risk,
      breakers: {
        brokerRejected: (r) => this.breakers.recordRejection(r),
        apiError: (r) => this.breakers.recordApiError(r),
      },
      dailyPnl: () => this.account.dayPnl(),
      onFills: () => this.account.requestRefresh(),
      currency: () => this.account.account?.currency ?? null,
      tradingDay: this.calendar.tradingDay,
      // Only Alpaca has extended-hours rules (limit orders, flagged). OANDA instruments trade around the clock.
      offHours:
        this.venue === 'alpaca' && o.config.sessions !== 'regular'
          ? {
              active: (now) => !this.calendar.isRegularOpen(now),
              // The latest two-sided quote, else the last trade: only used to price an exit's limit through the touch.
              quote: (symbol) => {
                const q = this.marketData.state(symbol);
                if (!q) return null;
                if (q.bid !== null && q.ask !== null) return { bid: q.bid, ask: q.ask };
                return q.last !== null ? { bid: q.last, ask: q.last } : null;
              },
              bufferPct: o.config.offHoursExitBufferPct,
            }
          : undefined,
    });
    this.orders = engine;
    this.reconciler = new Reconciler(o.env, this.account, this.ledger, this.orders, this.breakers, o.audit, this.timeline, this.alerts, o.bus, o.clock, log.child({ component: 'reconciler' }), () =>
      this.workers ? this.workers.underlyings() : o.config.symbols,
    );

    this.workers = new WorkerManager(
      {
        venue: this.venue,
        workerIds: activeWorkerIds(this.venue, o.config.alpacaWorkerSet),
        env: o.env,
        marketData: this.marketData,
        calendar: this.calendar,
        orders: this.orders,
        ledger: this.ledger,
        selector: this.selector,
        controls: this.controls,
        signals: this.signals,
        stats: this.stats,
        timeline: this.timeline,
        bus: o.bus,
        clock: o.clock,
        logger: log.child({ component: 'workers' }),
        db: o.db,
        maxOptionQuoteAgeMs: o.config.thresholds.maxOptionQuoteAgeMs,
        systemHalt: () => this.systemHalt(),
        maxPositionNotional: () => this.riskSettings.get().maxPositionNotional,
        maxContracts: () => this.riskSettings.get().maxContracts,
        maxShares: () => this.riskSettings.get().maxShares,
        instruments: this.instruments,
        account: () => this.account.account,
        maxOrderNotional: () => this.riskSettings.get().maxOrderNotional,
        maxRiskPerTrade: () => this.riskSettings.get().maxRiskPerTrade,
      },
      new WorkerRepository(o.db),
      o.audit,
    );
  }

  private setPhase(phase: SystemPhase, detail = ''): void {
    this.phase = phase;
    this.phaseDetail = detail;
    this.o.logger.info({ env: this.env, phase, detail }, 'system phase');
    this.o.bus.emit('SYSTEM_UPDATED', {});
  }

  /** Recovery sequence (spec §36, §94). Never assumes previous memory is correct. */
  async start(): Promise<void> {
    await this.riskSettings.load();
    await this.controls.load();
    await this.breakers.load();
    await this.timeline.load(this.calendar ? this.calendar.tradingDayStart(this.o.clock.now()) : DateTime.fromMillis(this.o.clock.now(), { zone: 'America/New_York' }).startOf('day').toMillis());
    if (!this.configured) {
      const what =
        this.venue === 'oanda'
          ? this.env === 'live'
            ? 'No OANDA live (fxTrade) credentials configured: set OANDA_LIVE_TOKEN and OANDA_LIVE_ACCOUNT_ID'
            : 'No OANDA practice credentials configured: set OANDA_PRACTICE_TOKEN and OANDA_PRACTICE_ACCOUNT_ID'
          : `No Alpaca credentials configured for ${this.env.toUpperCase()}`;
      this.setPhase('NOT_CONFIGURED', this.venue === 'oanda' ? `${what} in the server environment, then restart.` : `${what}. Set them in the server environment and restart.`);
      return;
    }
    await this.workers.load();
    void this.recoverLoop();
  }

  private async recoverLoop(): Promise<void> {
    const retry = this.o.timings?.recoveryRetryMs ?? 20_000;
    while (!this.stopped) {
      try {
        await this.recover();
        return;
      } catch (err) {
        this.setPhase('DEGRADED', `recovery failed: ${(err as Error).message} — retrying in ${Math.round(retry / 1000)}s`);
        this.o.logger.error({ err: (err as Error).message }, 'recovery failed');
        await sleep(retry);
      }
    }
  }

  /**
   * Markets the broker does not offer this account (e.g. index CFDs or metals for some OANDA entities) can never
   * have data. Leave them out of market data so they neither break the other markets' feed nor read as "stale";
   * their workers keep reporting that the market is not offered and never trade.
   */
  private dropUnofferedMarkets(): void {
    if (!this.instruments.supported || !this.instruments.loaded) return;
    const offered = this.o.config.symbols.filter((s) => this.instruments.get(s) !== null);
    const missing = this.o.config.symbols.filter((s) => !offered.includes(s));
    this.marketData.restrictTo(offered);
    if (missing.length === 0) return;
    const names = missing.map((s) => instrumentName(s)).join(', ');
    this.o.logger.warn({ markets: missing }, 'markets not offered to this broker account; they will not be traded');
    this.timeline.add({
      kind: 'system',
      severity: 'warn',
      workerId: null,
      symbol: null,
      title: `Not offered to this ${this.broker.name} account: ${names}`,
      detail: 'Their workers stay idle. Check the account type or region with the broker, or remove the market from the configuration.',
    });
  }

  private async recover(): Promise<void> {
    this.setPhase('RECOVERING', 'reloading local state');
    await this.ledger.load();
    await this.orders.load();

    this.setPhase('ACCOUNT_SYNC', 'retrieving account from broker');
    await this.account.refreshAccount();
    if (this.account.environmentWarning && this.env === 'live') throw new Error(this.account.environmentWarning);
    if (this.instruments.supported && !this.instruments.loaded) await this.instruments.start();
    this.dropUnofferedMarkets();

    this.setPhase('POSITION_SYNC', 'retrieving positions from broker');
    await this.account.refreshPositions();

    this.setPhase('ORDER_SYNC', 'reconnecting order stream and syncing open orders');
    if (this.offs.length === 0) this.wireEvents();
    await this.orders.syncNonTerminal();
    await this.account.refreshOpenOrders();

    this.setPhase('MARKET_DATA_SYNC', 'loading calendar, history and live data');
    await this.calendar.start();
    await this.marketData.start();
    const waitMs = this.o.timings?.marketDataWaitMs ?? 15_000;
    for (let waited = 0; waited < waitMs; waited += 250) {
      if (this.provider.status().stock.state === 'CONNECTED') break;
      await sleep(250);
    }

    this.setPhase('RISK_CHECK', 'reconciling broker and local state');
    await this.reconciler.run({ immediate: true });
    await this.workers.start();

    this.account.start();
    this.reconciler.start(this.o.timings?.reconcileMs ?? 15_000);
    this.timers.push(setInterval(() => void this.orders.syncNonTerminal().catch(() => undefined), this.o.timings?.orderSyncMs ?? 30_000));
    this.timers.push(
      setInterval(() => {
        const c = this.calendar.clockStatus();
        if (c.checkedAt !== null) this.breakers.recordClock(c.ok, c.brokerSkewMs);
      }, 30_000),
    );
    this.ready = true;
    const stockState = this.provider.status().stock.state;
    if (stockState === 'CONNECTED') this.setPhase('READY', 'recovered — workers monitoring (autotrading is OFF after every restart until you enable it)');
    else this.setPhase('DEGRADED', `market data ${stockState.toLowerCase()} — trading blocked until live data resumes`);
    void this.o.audit.record({
      action: 'RECOVERY_COMPLETE',
      actor: 'system',
      env: this.env,
      details: {
        account: maskAccountNumber(this.account.account?.accountNumber),
        positions: this.account.positions.length,
        openOrders: this.account.openOrders.length,
        reconciliation: this.reconciler.status().status,
      },
    });
    this.timeline.add({ kind: 'system', title: `Recovered · ${this.env.toUpperCase()}`, detail: `${this.account.positions.length} position(s), ${this.account.openOrders.length} open order(s), reconciliation ${this.reconciler.status().status}` });
  }

  private wireEvents(): void {
    const bus = this.o.bus;
    this.offs.push(this.broker.subscribeTradeUpdates((u) => void this.orders.onTradeUpdate(u).catch((err) => this.o.logger.error({ err }, 'trade update failed'))));
    this.offs.push(
      this.broker.onTradeStreamStatus((s: StreamStatus) => {
        bus.emit('BROKER_STATUS', {});
        if (s.state === 'CONNECTED') {
          if (this.tradeStreamWasConnected && this.ready) {
            // After a broker reconnect: reconcile orders, account and positions before trusting state (spec §66).
            this.timeline.add({ kind: 'system', title: 'Broker stream reconnected', detail: 'syncing orders, account and positions' });
            void (async () => {
              await this.orders.syncNonTerminal();
              await this.account.refreshAll().catch(() => undefined);
              await this.reconciler.run();
            })();
          }
          this.tradeStreamWasConnected = true;
        } else if (this.tradeStreamWasConnected && (s.state === 'RECONNECTING' || s.state === 'DISCONNECTED')) {
          this.alerts.raise('BROKER_DISCONNECTED', 'error', 'BROKER CONNECTION LOST', 'New orders disabled. Reconnecting…');
        }
      }),
    );
    this.offs.push(
      bus.on('MARKET_DATA_STATUS', ({ stream, status }) => {
        if (stream !== 'stock') return;
        if (status.state === 'CONNECTED' && this.ready && this.phase === 'DEGRADED') this.setPhase('READY', 'market data restored');
        if (status.state !== 'CONNECTED' && this.ready && this.phase === 'READY') {
          this.setPhase('DEGRADED', `market data ${status.state.toLowerCase()}`);
          this.alerts.raise('MARKET_DATA_DISCONNECTED', 'error', 'MARKET DATA OFFLINE', 'New autonomous entries stopped. Existing positions preserved. Reconnecting…');
        }
      }),
    );
    this.offs.push(
      bus.on('ACCOUNT_UPDATED', () => {
        const dp = this.account.dayPnl();
        const limit = this.riskSettings.get().maxDailyLoss;
        if (dp !== null && dp <= -limit && !this.breakers.isTripped('DAILY_LOSS')) {
          void this.breakers.trip('DAILY_LOSS', `Day P&L ${dp.toFixed(2)} reached the −${limit.toFixed(2)} limit. All new entries disabled.`);
        }
        if (this.account.accountChanged && !this.breakers.isTripped('ACCOUNT_CHANGED')) void this.breakers.trip('ACCOUNT_CHANGED', this.account.accountChanged);
      }),
    );
  }

  /** Why workers may not trade right now (null = no system-level halt). */
  systemHalt(): string | null {
    if (this.phase !== 'READY' && this.phase !== 'DEGRADED') return `SYSTEM ${this.phase.replace('_', ' ')}`;
    const tripped = this.breakers.tripped();
    if (tripped.length) return `HALTED · ${tripped[0]!.label.toUpperCase()}`;
    if (this.reconciler.status().status === 'MISMATCH') return 'RECONCILIATION MISMATCH';
    return null;
  }

  /** Every reason new entries are blocked right now — never hidden (spec §95). */
  haltReasons(): HaltReason[] {
    const out: HaltReason[] = [];
    if (!this.configured) return [{ code: 'NOT_CONFIGURED', message: 'Broker credentials not configured' }];
    if (this.env === 'live' && !this.liveGate.serverLockOpen) out.push({ code: 'LIVE_LOCKED', message: 'LIVE_TRADING_ENABLED=false on server' });
    if (this.env === 'live' && this.liveGate.serverLockOpen && !this.liveGate.armed) out.push({ code: 'LIVE_NOT_ARMED', message: 'Live execution not armed' });
    if (this.controls.killSwitch.active) out.push({ code: 'KILL_SWITCH', message: 'Kill switch active' });
    if (!this.controls.autotrading) out.push({ code: 'AUTOTRADING_OFF', message: 'Autotrading off' });
    if (this.controls.entriesPaused) out.push({ code: 'ENTRIES_PAUSED', message: 'Entries paused' });
    if (this.phase !== 'READY') out.push({ code: 'PHASE', message: this.phaseDetail || this.phase });
    for (const b of this.breakers.tripped()) out.push({ code: `BREAKER_${b.id}`, message: b.label });
    if (this.reconciler && this.reconciler.status().status === 'MISMATCH') out.push({ code: 'RECONCILIATION', message: 'Account reconciliation mismatch' });
    if (this.account) {
      const b = this.account.status(this.broker.tradeStreamStatus().state === 'CONNECTED');
      if (b.status !== 'CONNECTED') out.push({ code: 'BROKER', message: `Broker ${b.status.replace('_', ' ')}${b.detail ? ` — ${b.detail}` : ''}` });
    }
    if (this.calendar) {
      const m = this.calendar.status();
      if (!m.isOpen) {
        out.push({
          code: 'MARKET_CLOSED',
          message: this.broker.calendarSource === 'configured' ? 'Outside the trading session' : `Market ${m.label.replace('_', ' ').toLowerCase()}`,
        });
      }
      else {
        const stale = this.marketData.symbols.filter((s) => this.marketData.freshness(s).stale);
        if (stale.length) out.push({ code: 'DATA_STALE', message: `Market data stale: ${stale.join(', ')}` });
      }
      const c = this.calendar.clockStatus();
      if (!c.ok) out.push({ code: 'CLOCK', message: c.brokerSkewMs === null ? 'Server clock not verified' : `Clock skew ${c.brokerSkewMs}ms` });
    }
    if (this.account?.dayPnl() !== null && this.account && this.account.dayPnl()! <= -this.riskSettings.get().maxDailyLoss) {
      out.push({ code: 'DAILY_LOSS', message: 'Daily loss limit reached' });
    }
    return out;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const off of this.offs) off();
    this.offs = [];
    if (!this.configured) return;
    this.workers.stop();
    this.reconciler.stop();
    this.account.stop();
    this.calendar.stop();
    this.instruments.stop();
    await Promise.allSettled([this.marketData.stop(), this.broker.close()]);
    await this.o.audit.flush();
  }
}
