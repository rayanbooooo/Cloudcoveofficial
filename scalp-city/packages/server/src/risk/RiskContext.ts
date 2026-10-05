import { parseOccSymbol, timeframeMinutes, type TradingEnvironment } from '@scalp-city/shared';
import type { AccountService } from '../account/AccountService.js';
import type { BrokerAdapter } from '../broker/types.js';
import type { Clock } from '../core/clock.js';
import type { InstrumentCatalog } from '../market/InstrumentCatalog.js';
import type { MarketCalendar } from '../market/MarketCalendar.js';
import type { MarketDataService } from '../marketdata/MarketDataService.js';
import type { MarketDataProvider } from '../marketdata/types.js';
import type { ContractSelector } from '../options/ContractSelector.js';
import type { OrderEngine, RiskContextProvider } from '../orders/OrderEngine.js';
import type { PositionLedger } from '../positions/PositionLedger.js';
import type { CircuitBreakers } from '../safety/CircuitBreakers.js';
import type { Controls } from '../safety/Controls.js';
import type { LiveGate } from '../safety/LiveGate.js';
import type { Reconciler } from '../safety/Reconciler.js';
import type { WorkerManager } from '../workers/WorkerManager.js';
import type { WorkerStatsService } from '../workers/WorkerStats.js';
import type { CfdMarket, ProposedOrder, RiskState } from './RiskEngine.js';
import type { RiskSettings } from './RiskSettings.js';

interface Prefetched {
  asset: { tradable: boolean; shortable: boolean; easyToBorrow: boolean } | null;
  signalUsed: boolean;
  contract: { tradable: boolean; status: string; openInterest: number | null; volume: number | null } | null;
}

export interface LiveRiskContextDeps {
  env: TradingEnvironment;
  clock: Clock;
  broker: BrokerAdapter;
  provider: MarketDataProvider;
  account: AccountService;
  calendar: MarketCalendar;
  marketData: MarketDataService;
  instruments: InstrumentCatalog;
  ledger: PositionLedger;
  selector: ContractSelector;
  controls: Controls;
  liveGate: LiveGate;
  breakers: CircuitBreakers;
  reconciler: () => Reconciler;
  riskSettings: RiskSettings;
  stats: WorkerStatsService;
  workers: () => WorkerManager | null;
  signalHasOrder: (signalId: string, excludeOrderId: string | null) => Promise<boolean>;
  allowedUnderlyings: string[];
}

/**
 * Builds the RiskEngine's view of the world from the live services.
 * Network lookups happen in `prefetch` (outside the submission lock);
 * `build` is synchronous so it sees every order already in flight.
 */
export class LiveRiskContext implements RiskContextProvider {
  private assetCache = new Map<string, { at: number; v: Prefetched['asset'] }>();

  constructor(private readonly d: LiveRiskContextDeps) {}

  private async asset(symbol: string): Promise<Prefetched['asset']> {
    const c = this.assetCache.get(symbol);
    if (c && this.d.clock.now() - c.at < 10 * 60_000) return c.v;
    const a = await this.d.broker.getAsset(symbol);
    const v = { tradable: a.tradable && a.status === 'active', shortable: a.shortable, easyToBorrow: a.easyToBorrow };
    this.assetCache.set(symbol, { at: this.d.clock.now(), v });
    return v;
  }

  async prefetch(o: ProposedOrder): Promise<Prefetched> {
    const asset = o.assetClass === 'us_equity' ? await this.asset(o.symbol) : null;
    if (o.assetClass === 'cfd') await this.d.instruments.ensure();
    const signalUsed = o.signalId ? await this.d.signalHasOrder(o.signalId, o.orderId) : false;
    let contract: Prefetched['contract'] = null;
    if (o.assetClass === 'us_option') {
      const known = this.d.selector.lastEvaluation(o.symbol);
      if (known) {
        contract = { tradable: known.tradable, status: known.status, openInterest: known.openInterest, volume: known.volume };
      } else {
        const c = await this.d.broker.getOptionContract(o.symbol);
        const snap = (await this.d.provider.getOptionSnapshots([o.symbol]).catch(() => []))[0] ?? null;
        if (snap) this.d.marketData.seedOptionQuote(o.symbol, snap);
        contract = c ? { tradable: c.tradable, status: c.status, openInterest: c.openInterest, volume: snap?.volume ?? null } : { tradable: false, status: 'not listed', openInterest: null, volume: null };
      }
    }
    return { asset, signalUsed, contract };
  }

  build(o: ProposedOrder, prefetched: unknown, engine: OrderEngine): RiskState {
    const pre = prefetched as Prefetched;
    const d = this.d;
    const now = d.clock.now();
    const underlying = o.underlying ?? (o.assetClass === 'us_option' ? (parseOccSymbol(o.symbol)?.root ?? null) : o.symbol);
    const worker = o.workerId ? (d.workers()?.get(o.workerId) ?? null) : null;

    // The reference price is always the live quote at evaluation time.
    let referencePrice = o.referencePrice;
    let optionMarket: RiskState['optionMarket'] = null;
    let cfd: CfdMarket | null = null;
    if (o.assetClass === 'cfd') {
      const st = d.marketData.state(o.symbol);
      referencePrice = (o.side === 'buy' ? st?.ask : st?.bid) ?? st?.last ?? null;
      const spec = d.instruments.get(o.symbol);
      const acct = d.account.account;
      cfd = {
        listed: spec !== null,
        tradeable: st?.tradeable ?? null,
        unitsPrecision: spec?.unitsPrecision ?? null,
        minUnits: spec?.minUnits ?? null,
        maxOrderUnits: spec?.maxOrderUnits ?? null,
        marginRate: d.instruments.marginRate(o.symbol, acct),
        homeFactor: d.instruments.homeFactor(o.symbol),
        marginAvailable: acct?.marginAvailable ?? null,
      };
    } else if (o.assetClass === 'us_option') {
      const q = d.marketData.optionQuote(o.symbol);
      referencePrice = (o.side === 'buy' ? q?.ask : q?.bid) ?? q?.mid ?? null;
      optionMarket = {
        bid: q?.bid ?? null,
        ask: q?.ask ?? null,
        ageMs: q?.ageMs ?? null,
        stale: q?.stale ?? true,
        volume: pre.contract?.volume ?? null,
        openInterest: pre.contract?.openInterest ?? null,
        bidSize: null,
        contractTradable: pre.contract ? pre.contract.tradable && pre.contract.status === 'active' : false,
        contractStatus: pre.contract?.status ?? null,
      };
      const ev = d.selector.lastEvaluation(o.symbol);
      if (ev) optionMarket.bidSize = ev.bidSize;
    } else {
      const st = d.marketData.state(o.symbol);
      const mid = st && st.bid !== null && st.ask !== null ? (st.bid + st.ask) / 2 : null;
      referencePrice = (o.side === 'buy' ? st?.ask : st?.bid) ?? st?.last ?? mid ?? null;
    }

    const tradeStream = d.broker.tradeStreamStatus().state === 'CONNECTED';
    const broker = d.account.status(tradeStream);
    const clock = d.calendar.clockStatus();
    const workerStats = worker ? d.stats.base(worker.id) : null;
    const workerUnrealized = worker ? worker.unrealized() : null;
    const tfMinutes = worker ? timeframeMinutes(worker.config.timeframe) : 1;

    return {
      now,
      env: d.env,
      limits: d.riskSettings.get(),
      currency: d.account.account?.currency ?? null,
      cfd,
      controls: { autotrading: d.controls.autotrading, entriesPaused: d.controls.entriesPaused, killSwitch: d.controls.killSwitch.active },
      live: { serverLockOpen: d.liveGate.serverLockOpen, armed: d.liveGate.armed },
      breakers: d.breakers.tripped(),
      broker: { status: broker.status, detail: broker.detail },
      account: d.account.account,
      accountRestriction: d.account.restriction() ?? d.account.accountChanged ?? (d.env === 'live' ? d.account.environmentWarning : null),
      accountDayPnl: d.account.dayPnl(),
      market: { isOpen: d.calendar.isOpen(now), minutesToClose: d.calendar.minutesToClose(now), label: d.calendar.status(now).label },
      clock: { ok: clock.ok, skewMs: clock.brokerSkewMs },
      freshness: underlying ? d.marketData.freshness(underlying) : null,
      optionsPolicy: d.marketData.optionsAutotradePolicy(),
      optionMarket,
      referencePrice,
      reconciliation: { ok: d.reconciler().ok(), detail: d.reconciler().status().mismatches.map((m) => m.detail).join('; ') || d.reconciler().status().status },
      brokerPositions: d.account.positions,
      ledgerPositions: d.ledger.all(),
      openOrders: engine.riskOpenOrders(),
      entriesToday: engine.entriesToday(),
      workerEntriesToday: worker ? engine.entriesToday(worker.id) : 0,
      ordersLastMinute: engine.ordersLastMinute(),
      worker: worker
        ? {
            config: worker.config,
            autotradeEnabled: worker.autotradeEnabled,
            // Unknown mark → unknown P&L; the worker loss check then fails closed.
            dayPnl: workerUnrealized === null ? null : (workerStats?.realizedToday ?? 0) + workerUnrealized,
            realizedToday: workerStats?.realizedToday ?? 0,
          }
        : null,
      asset: pre.asset,
      signalAlreadyUsed: pre.signalUsed,
      allowedUnderlyings: d.allowedUnderlyings,
      // A signal is only acted on shortly after its bar closed.
      maxSignalAgeMs: tfMinutes === 1 ? 30_000 : 60_000,
    } satisfies RiskState & { now: number };
  }
}
