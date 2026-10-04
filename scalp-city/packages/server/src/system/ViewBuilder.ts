import { DateTime } from 'luxon';
import {
  atr as atrSeries,
  ema as emaSeries,
  maskAccountNumber,
  parseOccSymbol,
  vwapSeries,
  type AccountView,
  type HealthItemView,
  type PositionView,
  type ReadinessView,
  type RiskView,
  type Snapshot,
  type SymbolQuoteView,
  type SystemView,
  type TradingEnvironment,
} from '@scalp-city/shared';
import type { AppConfig } from '../config/env.js';
import type { Clock } from '../core/clock.js';
import { iso, n, type Db } from '../db/db.js';
import { stockFeedLabel, optionsFeedLabel } from '../marketdata/MarketDataService.js';
import type { ReadinessInputs } from '../safety/LiveGate.js';
import type { TradingContext } from './TradingContext.js';

const UNAVAILABLE_STREAM = { state: 'DISCONNECTED' as const, since: 0, lastMessageAt: null, reconnectAttempts: 0, lastError: 'not configured' };

/**
 * Builds the browser-facing views from the live services. Every broker or
 * market value passes through unchanged or as `null` (UNAVAILABLE).
 */
export class ViewBuilder {
  private quoteCache = new Map<string, { at: number; v: SymbolQuoteView }>();
  private realizedBySymbol = new Map<string, number>();
  private paperRoundTrips = 0;
  dbOk = true;
  wsClients = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** Refresh DB-derived figures (realized today per symbol, paper round trips). */
  async refresh(env: TradingEnvironment): Promise<void> {
    try {
      const midnight = DateTime.fromMillis(this.clock.now(), { zone: 'America/New_York' }).startOf('day').toMillis();
      const r = await this.db.query<{ symbol: string; realized: number }>(
        `SELECT t.symbol, COALESCE(SUM(e.realized_pnl),0) AS realized FROM trade_events e JOIN trades t ON t.id = e.trade_id
          WHERE t.env = $1 AND e.kind = 'EXIT_FILL' AND e.occurred_at >= $2 GROUP BY t.symbol`,
        [env, iso(midnight)],
      );
      this.realizedBySymbol = new Map(r.rows.map((x) => [x.symbol, n(x.realized) ?? 0]));
      const p = await this.db.query<{ c: number }>(
        `SELECT COUNT(*) AS c FROM trades WHERE env = 'paper' AND status = 'CLOSED' AND realized_pnl IS NOT NULL AND qty_closed > 0 AND qty_opened > 0`,
      );
      this.paperRoundTrips = n(p.rows[0]?.c) ?? 0;
      this.dbOk = true;
    } catch {
      this.dbOk = false;
    }
  }

  account(ctx: TradingContext): AccountView {
    const a = ctx.configured ? ctx.account.account : null;
    const positions = ctx.configured ? ctx.account.positions : [];
    const dayPnl = ctx.configured ? ctx.account.dayPnl() : null;
    const sum = (f: (p: (typeof positions)[number]) => number | null) => {
      if (!a) return null;
      let s = 0;
      for (const p of positions) {
        const v = f(p);
        if (v === null) return null;
        s += v;
      }
      return s;
    };
    const unrealized = sum((p) => p.unrealizedPl);
    const unrealizedIntraday = sum((p) => p.unrealizedIntradayPl);
    return {
      available: a !== null,
      broker: 'ALPACA',
      env: ctx.env,
      accountNumberMasked: maskAccountNumber(a?.accountNumber),
      status: a?.status ?? null,
      currency: a?.currency ?? null,
      equity: a?.equity ?? null,
      lastEquity: a?.lastEquity ?? null,
      cash: a?.cash ?? null,
      buyingPower: a?.buyingPower ?? null,
      regtBuyingPower: a?.regtBuyingPower ?? null,
      daytradingBuyingPower: a?.daytradingBuyingPower ?? null,
      nonMarginableBuyingPower: a?.nonMarginableBuyingPower ?? null,
      optionsBuyingPower: a?.optionsBuyingPower ?? null,
      portfolioValue: a?.portfolioValue ?? null,
      longMarketValue: a?.longMarketValue ?? null,
      shortMarketValue: a?.shortMarketValue ?? null,
      initialMargin: a?.initialMargin ?? null,
      maintenanceMargin: a?.maintenanceMargin ?? null,
      multiplier: a?.multiplier ?? null,
      dayPnl,
      dayPnlPct: dayPnl !== null && a?.lastEquity ? (dayPnl / a.lastEquity) * 100 : null,
      unrealizedPnl: unrealized,
      unrealizedIntradayPnl: unrealizedIntraday,
      realizedPnlDerived: dayPnl !== null && unrealizedIntraday !== null ? dayPnl - unrealizedIntraday : null,
      patternDayTrader: a?.patternDayTrader ?? null,
      daytradeCount: a?.daytradeCount ?? null,
      tradingBlocked: a?.tradingBlocked ?? null,
      accountBlocked: a?.accountBlocked ?? null,
      tradeSuspendedByUser: a?.tradeSuspendedByUser ?? null,
      shortingEnabled: a?.shortingEnabled ?? null,
      optionsApprovedLevel: a?.optionsApprovedLevel ?? null,
      optionsTradingLevel: a?.optionsTradingLevel ?? null,
      updatedAt: ctx.configured ? ctx.account.accountAt : null,
    };
  }

  positions(ctx: TradingContext): PositionView[] {
    if (!ctx.configured) return [];
    return ctx.account.positions.map((p) => {
      const isOption = p.assetClass === 'us_option';
      const mult = isOption ? 100 : 1;
      let mark: number | null = null;
      let markSource: PositionView['markSource'] = null;
      if (isOption) {
        const q = ctx.marketData.optionQuote(p.symbol);
        if (q && !q.stale && q.mid !== null) {
          mark = q.mid;
          markSource = 'quote_mid';
        }
      } else {
        const st = ctx.marketData.state(p.symbol);
        const f = ctx.marketData.freshness(p.symbol);
        if (st && !f.stale && st.last !== null) {
          mark = st.last;
          markSource = 'last_trade';
        }
      }
      if (mark === null && p.currentPrice !== null) {
        mark = p.currentPrice;
        markSource = 'broker';
      }
      const signedQty = p.side === 'long' ? p.qty : -p.qty;
      const unrealized = markSource === 'broker' || mark === null ? p.unrealizedPl : (mark - p.avgEntryPrice) * signedQty * mult;
      const occ = parseOccSymbol(p.symbol);
      const lp = ctx.ledger.get(p.symbol);
      return {
        symbol: p.symbol,
        assetClass: p.assetClass,
        side: p.side,
        qty: p.qty,
        qtyAvailable: p.qtyAvailable,
        avgEntryPrice: p.avgEntryPrice,
        costBasis: p.costBasis,
        marketValue: mark !== null && markSource !== 'broker' ? mark * signedQty * mult : p.marketValue,
        brokerPrice: p.currentPrice,
        markPrice: mark,
        markSource,
        unrealizedPnl: unrealized,
        unrealizedPnlPct: unrealized !== null && p.costBasis ? (unrealized / Math.abs(p.costBasis)) * 100 : p.unrealizedPlpc !== null ? p.unrealizedPlpc * 100 : null,
        unrealizedIntradayPnl: p.unrealizedIntradayPl,
        realizedPnlToday: this.realizedBySymbol.get(p.symbol) ?? 0,
        multiplier: mult,
        option: occ ? { underlying: occ.root, expiration: occ.expiration, type: occ.type, strike: occ.strike } : null,
        workerId: lp?.workerId ?? null,
        brokerUpdatedAt: ctx.account.positionsAt ?? 0,
      };
    });
  }

  quotes(ctx: TradingContext): Record<string, SymbolQuoteView> {
    const out: Record<string, SymbolQuoteView> = {};
    const now = this.clock.now();
    for (const symbol of this.config.symbols) {
      if (!ctx.configured) {
        out[symbol] = { symbol, last: null, lastTradeAt: null, bid: null, ask: null, quoteAt: null, lastEventAt: null, ageMs: null, stale: true, prevClose: null, change: null, changePct: null, sessionVolume: null, vwap: null, ema50: null, atr: null };
        continue;
      }
      const cached = this.quoteCache.get(symbol);
      const st = ctx.marketData.state(symbol)!;
      const f = ctx.marketData.freshness(symbol);
      let ind = cached && now - cached.at < 1000 ? { vwap: cached.v.vwap, ema50: cached.v.ema50, atr: cached.v.atr, sessionVolume: cached.v.sessionVolume } : null;
      if (!ind) {
        const bars = ctx.marketData.bars(symbol).filter((b) => ctx.calendar.sessionKey(b.t) !== null);
        const closes = bars.map((b) => b.c);
        const vw = vwapSeries(bars, ctx.calendar.sessionKey);
        const e = emaSeries(closes, 50);
        const a = atrSeries(bars, 14);
        const session = ctx.calendar.currentOrLast(now);
        const vol = session ? bars.filter((b) => b.t >= session.openMs && b.t < session.closeMs).reduce((s, b) => s + b.v, 0) : null;
        ind = { vwap: vw[vw.length - 1] ?? null, ema50: e[e.length - 1] ?? null, atr: a[a.length - 1] ?? null, sessionVolume: vol };
      }
      const change = st.last !== null && st.prevClose !== null ? st.last - st.prevClose : null;
      const v: SymbolQuoteView = {
        symbol,
        last: st.last,
        lastTradeAt: st.lastTradeAt,
        bid: st.bid,
        ask: st.ask,
        quoteAt: st.quoteAt,
        lastEventAt: st.lastEventAt,
        ageMs: f.ageMs,
        stale: f.stale,
        prevClose: st.prevClose,
        change,
        changePct: change !== null && st.prevClose ? (change / st.prevClose) * 100 : null,
        sessionVolume: ind.sessionVolume,
        vwap: ind.vwap,
        ema50: ind.ema50,
        atr: ind.atr,
      };
      this.quoteCache.set(symbol, { at: now, v });
      out[symbol] = v;
    }
    return out;
  }

  risk(ctx: TradingContext): RiskView {
    const limits = ctx.riskSettings.get();
    const a = ctx.configured ? ctx.account.account : null;
    const dayPnl = ctx.configured ? ctx.account.dayPnl() : null;
    const reasons = ctx.haltReasons();
    const latencies = ctx.configured ? this.config.symbols.map((s) => ctx.marketData.freshness(s).ageMs).filter((x): x is number => x !== null) : [];
    const brokerStatus = ctx.configured ? ctx.account.status(ctx.broker.tradeStreamStatus().state === 'CONNECTED').status : 'NOT_CONFIGURED';
    return {
      dailyPnl: dayPnl,
      maxDailyLoss: limits.maxDailyLoss,
      remainingRisk: dayPnl === null ? null : Math.max(0, limits.maxDailyLoss + Math.min(0, dayPnl)),
      openPositions: ctx.configured ? ctx.account.positions.length : 0,
      maxPositions: limits.maxConcurrentPositions,
      openOrders: ctx.configured ? ctx.orders.workingOrders().length : 0,
      tradesToday: ctx.configured ? ctx.orders.entriesToday() : 0,
      maxTradesPerDay: limits.maxTradesPerDay,
      buyingPower: a?.buyingPower ?? null,
      optionsBuyingPower: a?.optionsBuyingPower ?? null,
      dataLatencyMs: latencies.length ? Math.max(...latencies) : null,
      brokerStatus,
      entriesAllowed: reasons.length === 0,
      blockReasons: reasons.map((r) => r.message),
      dailyLossHalted: ctx.breakers.isTripped('DAILY_LOSS') || (dayPnl !== null && dayPnl <= -limits.maxDailyLoss),
      limits,
    };
  }

  health(ctx: TradingContext): HealthItemView[] {
    if (!ctx.configured) {
      return [
        { id: 'broker', label: 'Broker', status: 'off', detail: 'not configured' },
        { id: 'marketData', label: 'Market Data', status: 'off', detail: 'not configured' },
        { id: 'database', label: 'Database', status: this.dbOk ? 'ok' : 'error', detail: this.dbOk ? 'connected' : 'unreachable' },
        { id: 'websocket', label: 'WebSocket', status: 'ok', detail: `${this.wsClients} client(s)` },
        { id: 'riskEngine', label: 'Risk Engine', status: 'off', detail: 'idle' },
        { id: 'workers', label: 'Workers', status: 'off', detail: 'idle' },
      ];
    }
    const b = ctx.account.status(ctx.broker.tradeStreamStatus().state === 'CONNECTED');
    const md = ctx.marketData.status();
    const marketOpen = ctx.calendar.isOpen();
    const anyStale = Object.values(md.symbols).some((s) => s.stale);
    const tripped = ctx.breakers.tripped();
    const recon = ctx.reconciler.status().status;
    const halted = ctx.workers.views().filter((w) => w.towerState === 'HALTED').length;
    return [
      { id: 'broker', label: 'Broker', status: b.status === 'CONNECTED' ? 'ok' : b.status === 'UNKNOWN' ? 'warn' : 'error', detail: b.detail ?? b.status },
      {
        id: 'marketData',
        label: 'Market Data',
        status: md.stock.state !== 'CONNECTED' ? 'error' : marketOpen && anyStale ? 'warn' : 'ok',
        detail: md.stock.state !== 'CONNECTED' ? `${md.stock.state.toLowerCase()}${md.stock.lastError ? ` — ${md.stock.lastError}` : ''}` : `${md.stockFeedLabel}${marketOpen && anyStale ? ' — stale' : ''}`,
      },
      { id: 'database', label: 'Database', status: this.dbOk ? 'ok' : 'error', detail: this.dbOk ? 'connected' : 'unreachable' },
      { id: 'websocket', label: 'WebSocket', status: 'ok', detail: `${this.wsClients} client(s)` },
      { id: 'riskEngine', label: 'Risk Engine', status: tripped.length ? 'error' : recon === 'RECONCILED' ? 'ok' : 'warn', detail: tripped.length ? `breaker: ${tripped.map((t) => t.label).join(', ')}` : `reconciliation ${recon.toLowerCase()}` },
      { id: 'workers', label: 'Workers', status: ctx.phase !== 'READY' ? 'warn' : halted ? 'warn' : 'ok', detail: `${ctx.workers.all().length} workers · ${ctx.workers.all().filter((w) => w.autotradeEnabled).length} autotrading · ${halted} halted` },
    ];
  }

  system(ctx: TradingContext, availableEnvs: TradingEnvironment[]): SystemView {
    const configured = ctx.configured;
    const stockFeed = stockFeedLabel(this.config.stockFeed);
    const optFeed = optionsFeedLabel(this.config.optionsFeed);
    const md = configured
      ? ctx.marketData.status()
      : {
          stock: UNAVAILABLE_STREAM,
          options: UNAVAILABLE_STREAM,
          stockFeed: this.config.stockFeed,
          stockFeedLabel: stockFeed.label,
          stockRealtime: stockFeed.realtime,
          stockPartialVolume: stockFeed.partialVolume,
          optionsFeed: this.config.optionsFeed,
          optionsFeedLabel: optFeed.label,
          optionsRealtimeNbbo: optFeed.realtimeNbbo,
          optionsAutotradeAllowed: false,
          optionsBlockReason: 'not configured',
          maxDataAgeMs: this.config.thresholds.maxDataAgeMs,
          symbols: Object.fromEntries(this.config.symbols.map((s) => [s, { lastEventAt: null, ageMs: null, stale: true }])),
        };
    const reasons = ctx.haltReasons();
    const brokerStatus = configured ? ctx.account.status(ctx.broker.tradeStreamStatus().state === 'CONNECTED') : { status: 'NOT_CONFIGURED' as const, detail: 'no credentials' };
    return {
      serverTime: this.clock.now(),
      env: ctx.env,
      availableEnvs,
      live: { serverLockOpen: ctx.liveGate.serverLockOpen, armed: ctx.liveGate.armed, armedAt: ctx.liveGate.armedAt, armedBy: ctx.liveGate.armedBy },
      endpoints: {
        trading: configured ? ctx.broker.endpoint : ctx.env === 'live' ? this.config.endpoints.liveTrading : this.config.endpoints.paperTrading,
        nonStandard: this.config.nonStandardEndpoints.length > 0,
      },
      phase: ctx.phase,
      phaseDetail: ctx.phaseDetail,
      controls: { autotrading: ctx.controls.autotrading, entriesPaused: ctx.controls.entriesPaused, killSwitch: { ...ctx.controls.killSwitch } },
      flatten: ctx.controls.flatten ? { ...ctx.controls.flatten, messages: [...ctx.controls.flatten.messages] } : null,
      trading: {
        entriesAllowed: reasons.length === 0,
        autotradingActive: ctx.controls.autotrading && !ctx.controls.killSwitch.active && ctx.systemHalt() === null,
        haltReasons: reasons,
      },
      broker: {
        name: 'ALPACA',
        status: brokerStatus.status,
        lastOkAt: configured ? ctx.account.lastOkAt : null,
        lastError: brokerStatus.detail,
        tradeStream: configured ? ctx.broker.tradeStreamStatus() : UNAVAILABLE_STREAM,
        accountMasked: configured ? maskAccountNumber(ctx.account.account?.accountNumber) : null,
      },
      marketData: md,
      market: configured
        ? ctx.calendar.status()
        : { isOpen: false, label: 'UNKNOWN', sessionOpen: null, sessionClose: null, nextOpen: null, nextClose: null, earlyClose: false, checkedAt: null },
      clock: configured ? ctx.calendar.clockStatus() : { brokerSkewMs: null, ok: false, checkedAt: null },
      breakers: ctx.breakers.views(),
      reconciliation: configured ? ctx.reconciler.status() : { status: 'UNKNOWN', lastRunAt: null, mismatches: [], externalPositions: [] },
      health: this.health(ctx),
    };
  }

  readiness(ctx: TradingContext): ReadinessView {
    const ok = (v: boolean, detail: string) => ({ ok: v, detail });
    if (!ctx.configured) {
      const no = ok(false, 'broker not configured');
      return ctx.liveGate.readiness({
        brokerConnected: no, account: no, marketDataConnected: no, marketDataFresh: no, optionsData: no, riskLimits: no, killSwitch: no, dailyLoss: no,
        reconciliation: no, noUnexpectedOrders: no, noUnexpectedPositions: no, workers: no, breakers: no, clock: no, paperRoundTrip: ok(this.paperRoundTrips > 0, `${this.paperRoundTrips} paper round trip(s)`),
      });
    }
    const b = ctx.account.status(ctx.broker.tradeStreamStatus().state === 'CONNECTED');
    const md = ctx.marketData.status();
    const marketOpen = ctx.calendar.isOpen();
    const stale = Object.entries(md.symbols).filter(([, s]) => s.stale).map(([k]) => k);
    const usesOptions = ctx.workers.all().some((w) => w.config.instrument === 'OPTIONS');
    const limits = ctx.riskSettings.get();
    const limitsOk = Object.entries(limits).every(([k, v]) => (typeof v === 'boolean' ? true : k === 'noEntriesBeforeCloseMinutes' ? v >= 0 : v > 0));
    const recon = ctx.reconciler.status();
    const dayPnl = ctx.account.dayPnl();
    const unexpectedOrders = recon.mismatches.filter((m) => m.kind === 'UNEXPECTED_ORDER');
    const unexpectedPositions = recon.mismatches.filter((m) => m.kind !== 'UNEXPECTED_ORDER');
    const restriction = ctx.account.restriction() ?? ctx.account.accountChanged ?? ctx.account.environmentWarning;
    const clock = ctx.calendar.clockStatus();
    const inputs: ReadinessInputs = {
      brokerConnected: ok(b.status === 'CONNECTED', b.detail ?? b.status),
      account: ok(ctx.account.account !== null && restriction === null, restriction ?? `${maskAccountNumber(ctx.account.account?.accountNumber)} ${ctx.account.account?.status ?? ''}`),
      marketDataConnected: ok(md.stock.state === 'CONNECTED' && md.stockRealtime, md.stockRealtime ? `${md.stockFeedLabel} · ${md.stock.state}` : 'feed is delayed — live trading needs real-time data'),
      marketDataFresh: ok(!marketOpen || stale.length === 0, marketOpen ? (stale.length ? `stale: ${stale.join(', ')}` : 'all symbols live') : 'market closed — freshness enforced on every order'),
      optionsData: ok(!usesOptions || md.optionsAutotradeAllowed, !usesOptions ? 'no worker trades options' : (md.optionsBlockReason ?? md.optionsFeedLabel)),
      riskLimits: ok(limitsOk, limitsOk ? `daily loss −$${limits.maxDailyLoss}, ${limits.maxConcurrentPositions} positions, ${limits.maxContracts} contracts` : 'a risk limit is invalid'),
      killSwitch: ok(!ctx.controls.killSwitch.active, ctx.controls.killSwitch.active ? 'kill switch is ACTIVE — release it first' : 'armed and available'),
      dailyLoss: ok(dayPnl !== null && dayPnl > -limits.maxDailyLoss, dayPnl === null ? 'day P&L unavailable' : `day P&L ${dayPnl.toFixed(2)} vs −${limits.maxDailyLoss}`),
      reconciliation: ok(recon.status === 'RECONCILED', recon.status),
      noUnexpectedOrders: ok(unexpectedOrders.length === 0, unexpectedOrders.length ? unexpectedOrders.map((m) => m.detail).join('; ') : 'none'),
      noUnexpectedPositions: ok(unexpectedPositions.length === 0, unexpectedPositions.length ? unexpectedPositions.map((m) => m.detail).join('; ') : 'none'),
      workers: ok(ctx.workers.all().length > 0, `${ctx.workers.all().length} workers configured`),
      breakers: ok(ctx.breakers.tripped().length === 0 && ctx.phase === 'READY', ctx.breakers.tripped().length ? `tripped: ${ctx.breakers.tripped().map((x) => x.label).join(', ')}` : ctx.phase),
      clock: ok(clock.ok, clock.brokerSkewMs === null ? 'not verified' : `skew ${clock.brokerSkewMs}ms`),
      paperRoundTrip: ok(this.paperRoundTrips > 0, this.paperRoundTrips > 0 ? `${this.paperRoundTrips} completed paper round trip(s) in the journal` : 'run a full paper trade (entry → exit) first'),
    };
    return ctx.liveGate.readiness(inputs);
  }

  snapshot(ctx: TradingContext, availableEnvs: TradingEnvironment[]): Snapshot {
    return {
      system: this.system(ctx, availableEnvs),
      account: this.account(ctx),
      positions: this.positions(ctx),
      orders: ctx.configured ? ctx.orders.recent(100).map((o) => ctx.orders.view(o)) : [],
      workers: ctx.configured ? ctx.workers.views() : [],
      quotes: this.quotes(ctx),
      optionQuotes: ctx.configured ? Object.fromEntries(ctx.marketData.optionQuotes().map((q) => [q.symbol, q])) : {},
      risk: this.risk(ctx),
      timeline: ctx.timeline.list(200),
      alerts: ctx.alerts.list(),
    };
  }
}
