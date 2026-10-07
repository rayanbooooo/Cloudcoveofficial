import {
  INITIAL_SIGNAL_STATE,
  advanceSignal,
  aggregateBars,
  computeIndicatorSnapshot,
  directionLabel,
  evaluateSignal,
  instrumentName,
  parseOccSymbol,
  timeframeMinutes,
  type Bar,
  type IndicatorSnapshot,
  type RiskDecisionView,
  type SignalDirection,
  type SignalEvaluation,
  type SignalState,
  type SignalView,
  type TowerState,
  type WorkerConfigView,
  type WorkerMarketView,
  type WorkerPositionView,
  type WorkerView,
  type Venue,
} from '@scalp-city/shared';
import type { BrokerAccount, BrokerInstrument } from '../broker/types.js';
import type { Clock } from '../core/clock.js';
import { formatMoney, formatQty } from '../core/format.js';
import type { EventBus } from '../core/eventBus.js';
import type { Logger } from '../core/logger.js';
import { iso, type Db } from '../db/db.js';
import { floorUnits, roundPrice, type InstrumentCatalog } from '../market/InstrumentCatalog.js';
import type { MarketCalendar } from '../market/MarketCalendar.js';
import type { MarketDataService } from '../marketdata/MarketDataService.js';
import type { ContractSelector } from '../options/ContractSelector.js';
import type { OrderEngine } from '../orders/OrderEngine.js';
import { isTerminal } from '../orders/stateMachine.js';
import type { ExitPlan, OrderRecord, OrderRequest } from '../orders/types.js';
import type { PositionLedger } from '../positions/PositionLedger.js';
import type { LedgerPosition } from '../positions/types.js';
import type { Controls } from '../safety/Controls.js';
import type { Timeline } from '../system/Timeline.js';
import type { SignalRepository } from './SignalRepository.js';
import type { WorkerStatsService } from './WorkerStats.js';

export interface WorkerDeps {
  venue: Venue;
  /** The workers this deployment runs (null = every worker of the venue). */
  workerIds?: readonly string[] | null;
  env: 'paper' | 'live';
  marketData: MarketDataService;
  calendar: MarketCalendar;
  orders: OrderEngine;
  ledger: PositionLedger;
  selector: ContractSelector;
  controls: Controls;
  signals: SignalRepository;
  stats: WorkerStatsService;
  timeline: Timeline;
  bus: EventBus;
  clock: Clock;
  logger: Logger;
  db: Db;
  maxOptionQuoteAgeMs: number;
  /** System-level reason workers may not trade (kill switch, breaker, recovery …), or null. */
  systemHalt: () => string | null;
  maxPositionNotional: () => number;
  maxContracts: () => number;
  maxShares: () => number;
  /** CFD workers. */
  instruments: InstrumentCatalog;
  account: () => BrokerAccount | null;
  maxOrderNotional: () => number;
  maxRiskPerTrade: () => number;
}

type EntryRequest = OrderRequest & { signalBarCloseAt: number; referencePrice: number | null };
/** The parts of an entry every instrument shares; the instrument-specific builder adds the rest. */
type EntryCommon = Omit<EntryRequest, 'symbol' | 'underlying' | 'assetClass' | 'side' | 'positionIntent' | 'type' | 'qty' | 'limitPrice' | 'meta' | 'referencePrice'>;

/** Round to the instrument's tick (penny increments for options and stocks ≥ $1). */
export function roundToTick(price: number, isOption: boolean, direction: 'up' | 'down'): number {
  const tick = isOption || price >= 1 ? 0.01 : 0.0001;
  const steps = price / tick;
  const r = direction === 'up' ? Math.ceil(steps - 1e-9) : Math.floor(steps + 1e-9);
  return Number((r * tick).toFixed(isOption || price >= 1 ? 2 : 4));
}

const EXIT_REPRICE_MS = 10_000;

/**
 * One trading worker (a tower in the city). Analysis runs continuously on
 * real bars; orders only flow when the worker AND global autotrading are
 * on, and every order still has to pass the RiskEngine.
 */
export class Worker {
  config: WorkerConfigView;
  autotradeEnabled = false;
  signal: SignalState = { ...INITIAL_SIGNAL_STATE };
  private live: SignalEvaluation | null = null;
  private liveAt = 0;
  private lastSnapshot: IndicatorSnapshot | null = null;
  private lastEvaluatedBarT: number | null = null;
  private consumed = new Set<string>();
  private entryOrderId: string | null = null;
  private exitOrderId: string | null = null;
  private exitReason: string | null = null;
  private exitBackoffUntil = 0;
  private entryCanceling = false;
  private busy = false;
  private cooldownUntilBarT: number | null = null;
  private vwapLost = false;
  private transient: { state: 'PROFIT' | 'LOSS'; until: number } | null = null;
  private lastRisk: RiskDecisionView | null = null;
  private lastBlock: string | null = null;
  private lastEvaluatedAt: number | null = null;

  constructor(
    config: WorkerConfigView,
    private readonly d: WorkerDeps,
  ) {
    this.config = config;
  }

  get id(): string {
    return this.config.id;
  }

  // ── Bars & indicators ───────────────────────────────────────────────────

  /** Bars from the sessions this deployment trades (the regular one unless ALPACA_SESSIONS says more), in the worker's timeframe. */
  private bars(includeForming: boolean): Bar[] {
    const raw = includeForming ? this.d.marketData.bars(this.config.symbol) : this.d.marketData.finalBars(this.config.symbol);
    const rth = raw.filter((b) => this.d.calendar.sessionKey(b.t) !== null);
    if (this.config.timeframe === '1Min') return rth;
    return aggregateBars(rth, this.config.timeframe, this.d.clock.now());
  }

  private snapshot(bars: Bar[]): IndicatorSnapshot | null {
    const last = bars[bars.length - 1];
    if (!last) return null;
    const window = this.d.calendar.indicatorWindow(last.t);
    if (!window) return null;
    return computeIndicatorSnapshot(bars, this.config.params, { openMs: window.openMs, closeMs: window.closeMs, sessionKey: this.d.calendar.sessionKey }, this.d.clock.now());
  }

  private barCloseAt(t: number): number {
    return t + timeframeMinutes(this.config.timeframe) * 60_000;
  }

  /** Rebuild setup state from recent history after a (re)start — deterministic, never trades. */
  async warmStart(): Promise<void> {
    this.consumed = await this.d.signals.consumed(this.id, this.d.clock.now() - 3 * 86_400_000);
    const bars = this.bars(false).filter((b) => b.final);
    const start = Math.max(1, bars.length - 30);
    let state: SignalState = { ...INITIAL_SIGNAL_STATE };
    for (let i = start; i <= bars.length; i++) {
      const s = this.snapshot(bars.slice(0, i));
      if (!s) continue;
      state = advanceSignal(state, evaluateSignal(s, this.config.params), this.config.params, this.id);
      this.lastSnapshot = s;
    }
    this.signal = state;
    this.lastEvaluatedBarT = bars.length ? bars[bars.length - 1]!.t : null;
  }

  // ── Main loop (called every second and on bar closes) ─────────────────

  async tick(): Promise<void> {
    const now = this.d.clock.now();
    if (this.transient && now >= this.transient.until) this.transient = null;
    await this.evaluateConfirmed();
    this.evaluateLive(now);
    await this.manageOrders(now);
    await this.manageExit(now);
  }

  private async evaluateConfirmed(): Promise<void> {
    const bars = this.bars(false).filter((b) => b.final);
    const last = bars[bars.length - 1];
    if (!last || (this.lastEvaluatedBarT !== null && last.t <= this.lastEvaluatedBarT)) return;
    this.lastEvaluatedBarT = last.t;
    const snap = this.snapshot(bars);
    if (!snap) return;
    this.lastSnapshot = snap;
    this.lastEvaluatedAt = this.d.clock.now();
    const prev = this.signal;
    const next = advanceSignal(prev, evaluateSignal(snap, this.config.params), this.config.params, this.id);
    this.signal = next;
    this.onSignalTransition(prev, next);

    // VWAP-loss exit trigger is evaluated on confirmed bars only.
    const pos = this.position();
    if (pos && snap.vwap !== null) {
      const long = pos.direction === 'CALL' || (pos.direction === 'NEUTRAL' && pos.qty > 0);
      this.vwapLost = long ? snap.close < snap.vwap : snap.close > snap.vwap;
    } else {
      this.vwapLost = false;
    }

    if (next.phase === 'READY' && next.setupId) {
      await this.tryEntry(next, this.barCloseAt(last.t));
    }
    this.d.bus.emit('WORKER_UPDATED', { workerId: this.id });
  }

  private evaluateLive(now: number): void {
    if (now - this.liveAt < 1000) return;
    this.liveAt = now;
    const bars = this.bars(true);
    const snap = this.snapshot(bars);
    this.live = snap ? evaluateSignal(snap, this.config.params) : null;
    this.d.bus.emit('SIGNAL_UPDATED', { workerId: this.id });
  }

  private onSignalTransition(prev: SignalState, next: SignalState): void {
    const t = this.d.timeline;
    const base = { workerId: this.id, symbol: this.config.symbol, ts: next.barTime !== null ? this.barCloseAt(next.barTime) : undefined };
    // CALL/PUT is options vocabulary: CFD workers go long or short.
    const dir = (d: Parameters<typeof directionLabel>[0]) => directionLabel(d, this.config.instrument);
    if (next.fadedSetupId) {
      t.add({ ...base, kind: 'signal', title: `${this.config.name} · setup faded`, detail: `${dir(prev.direction)} charge fell to ${next.direction === prev.direction ? next.charge : 0}%` });
      void this.d.signals.markFaded(next.fadedSetupId).catch(() => undefined);
    }
    if (!next.setupId) return;
    // A setup is the run of momentum, identified by its direction and the bar it started forming on. A re-arming
    // strategy gets a new setup id on every READY bar, which must not be reported as a brand-new setup each time.
    const identity = (x: SignalState) => (x.setupId === null ? null : `${x.direction}:${x.formingSince}`);
    const newSetup = identity(next) !== identity(prev);
    for (const c of next.conditions) {
      const was = !newSetup ? prev.conditions.find((p) => p.id === c.id)?.met : false;
      if (c.met && !was) {
        t.add({ ...base, kind: 'signal', title: `${this.config.name} · ${c.label} confirmed`, detail: c.detail });
      }
    }
    if (next.phase !== prev.phase || newSetup) {
      if (next.phase === 'READY') t.add({ ...base, kind: 'signal', severity: 'success', title: `${this.config.name} · ${dir(next.direction)} signal reached ${next.charge}%`, detail: 'READY — subject to risk checks' });
      if (next.phase === 'CHARGING' || next.phase === 'READY') void this.d.signals.upsert(this.id, this.config.symbol, next).catch((err) => this.d.logger.warn({ err }, 'signal persist failed'));
    }
  }

  // ── Entry ──────────────────────────────────────────────────────────────

  private block(reason: string, risk: RiskDecisionView | null = null): void {
    if (risk) this.lastRisk = risk;
    if (this.lastBlock === reason) return;
    this.lastBlock = reason;
    this.d.timeline.add({ kind: 'risk', severity: 'warn', workerId: this.id, symbol: this.config.symbol, title: `${this.config.name} · entry blocked`, detail: reason });
    if (risk) {
      void this.d.db
        .query(
          `INSERT INTO risk_events(env, worker_id, signal_id, symbol, purpose, approved, blocked_by, checks, occurred_at) VALUES ($1,$2,$3,$4,'ENTRY',false,$5,$6,$7)`,
          [this.d.env, this.id, this.signal.setupId, this.config.symbol, risk.blockedBy?.id ?? null, JSON.stringify(risk.checks), iso(risk.evaluatedAt)],
        )
        .catch(() => undefined);
    }
  }

  private money(v: number): string {
    return formatMoney(v, this.d.account()?.currency ?? 'USD');
  }

  /** Stop/target distances for a CFD entry from the latest confirmed ATR (null until ATR is warm). */
  exitPlan(spread: number | null = null): ExitPlan | null {
    const atr = this.lastSnapshot?.atr ?? null;
    if (atr === null || !(atr > 0)) return null;
    const x = this.config.exits;
    // Never closer than a few spreads: a stop inside the noise just pays the spread repeatedly.
    const floor = spread !== null && spread > 0 ? spread * 3 : 0;
    return { stopDistance: Math.max(atr * x.stopAtr, floor), targetDistance: Math.max(atr * x.targetAtr, floor), atr };
  }

  /**
   * CFD size: risk-based (loss at the stop ≤ riskPerTrade), then capped by the
   * notional limits and the broker's maximum, rounded DOWN to the unit step.
   */
  private cfdSize(spec: BrokerInstrument, price: number, stopDistance: number, factor: number): { units: number | null; note: string | null } {
    const L = this.config.limits;
    const risk = Math.min(L.riskPerTrade, this.d.maxRiskPerTrade());
    const notionalCap = Math.min(L.maxPositionNotional, this.d.maxPositionNotional(), this.d.maxOrderNotional());
    const byRisk = risk / (stopDistance * factor);
    const byNotional = notionalCap / (price * factor);
    const units = floorUnits(Math.min(byRisk, byNotional, spec.maxOrderUnits ?? Infinity), spec.unitsPrecision);
    if (!(units >= spec.minUnits - 1e-9)) {
      const minNotional = spec.minUnits * price * factor;
      const minRisk = spec.minUnits * stopDistance * factor;
      const why = minRisk > risk ? `${this.money(minRisk)} at the stop vs ${this.money(risk)} allowed` : `${this.money(minNotional)} notional vs ${this.money(notionalCap)} allowed`;
      return { units: null, note: `size: the minimum ${formatQty(spec.minUnits)} unit${spec.minUnits === 1 ? '' : 's'} is too big — ${why}` };
    }
    return { units, note: null };
  }

  /** Build a CFD entry, or explain why there can't be one. */
  private async cfdEntry(direction: SignalDirection, common: EntryCommon, signalMeta: { charge: number; conditions: unknown[] }): Promise<EntryRequest | string> {
    const sym = this.config.symbol;
    await this.d.instruments.ensure();
    const spec = this.d.instruments.get(sym);
    if (!spec) return `${sym} is not offered to this account`;
    const st = this.d.marketData.state(sym);
    if (!st || st.bid === null || st.ask === null || !(st.bid > 0) || !(st.ask >= st.bid)) return 'no live bid/ask';
    if (st.tradeable === false) return `${sym} is not tradeable right now`;
    const side = direction === 'CALL' ? 'buy' : 'sell';
    if (side === 'sell' && !this.config.allowShort) return 'SHORT signal — short entries disabled for this worker';
    const spread = st.ask - st.bid;
    const plan = this.exitPlan(spread);
    if (!plan) return 'ATR not ready — cannot place a stop yet';
    if (spread > plan.stopDistance * 0.35) return `spread ${spread.toFixed(spec.displayPrecision)} is too wide for a ${plan.stopDistance.toFixed(spec.displayPrecision)} stop`;
    const factor = this.d.instruments.homeFactor(sym);
    if (factor === null) return 'currency conversion rate unavailable';
    const ref = side === 'buy' ? st.ask : st.bid;
    // Worst acceptable fill: the slippage allowance, but never more than a quarter of the stop.
    const slip = Math.min((ref * this.config.entrySlippagePct) / 100, plan.stopDistance * 0.25);
    const bound = roundPrice(side === 'buy' ? ref + slip : ref - slip, spec.displayPrecision, side === 'buy' ? 'up' : 'down');
    const stopPrice = roundPrice(side === 'buy' ? ref - plan.stopDistance : ref + plan.stopDistance, spec.displayPrecision, side === 'buy' ? 'down' : 'up');
    const worstStop = Math.abs(bound - stopPrice);
    const size = this.cfdSize(spec, bound, worstStop, factor);
    if (size.units === null) return size.note ?? 'size unavailable';
    return {
      ...common,
      symbol: sym,
      underlying: sym,
      assetClass: 'cfd',
      side,
      positionIntent: side === 'buy' ? 'buy_to_open' : 'sell_to_open',
      // Fill-or-kill at the bound: fills now at the market (or better) or not at all — never rests.
      type: 'limit',
      timeInForce: 'fok',
      qty: size.units,
      limitPrice: bound,
      meta: {
        multiplier: factor,
        direction,
        signal: signalMeta,
        quote: { bid: st.bid, ask: st.ask, at: st.quoteAt },
        exitPlan: plan,
        protectiveStop: { price: stopPrice },
        riskAtStop: size.units * worstStop * factor,
      },
      referencePrice: ref,
    };
  }

  /**
   * Share size: risk-based (loss at the stop <= riskPerTrade), then capped by the notional and share
   * limits, rounded DOWN to whole shares.
   */
  private shareSize(price: number, stopDistance: number): { qty: number; note: string | null } {
    const L = this.config.limits;
    const risk = Math.min(L.riskPerTrade, this.d.maxRiskPerTrade());
    const notionalCap = Math.min(L.maxPositionNotional, this.d.maxPositionNotional(), this.d.maxOrderNotional());
    const shareCap = Math.min(L.maxShares, this.d.maxShares());
    const byRisk = Math.floor(risk / stopDistance);
    const byNotional = Math.floor(notionalCap / price);
    const qty = Math.max(0, Math.min(byRisk, byNotional, shareCap));
    if (qty >= 1) return { qty, note: null };
    if (byNotional < 1) return { qty: 0, note: `size: one share costs ${this.money(price)}, over the ${this.money(notionalCap)} position limit — raise the position limit in the Risk drawer` };
    if (byRisk < 1) return { qty: 0, note: `size: one share loses ${this.money(stopDistance)} at the stop, over the ${this.money(risk)} risk-per-trade limit` };
    return { qty: 0, note: `size: the share limit is ${shareCap}` };
  }

  /**
   * Build a share entry (long, or short when the worker allows it), or explain why there can't be one.
   * The stop comes from the live ATR and is enforced by this server; nothing is placed at the broker.
   */
  private equityEntry(direction: SignalDirection, common: EntryCommon, signalMeta: { charge: number; conditions: unknown[] }): EntryRequest | string {
    const sym = this.config.symbol;
    const st = this.d.marketData.state(sym);
    if (!st || st.bid === null || st.ask === null || !(st.bid > 0) || !(st.ask >= st.bid)) return 'no live bid/ask';
    const side = direction === 'CALL' ? 'buy' : 'sell';
    if (side === 'sell' && !this.config.allowShort) return 'SHORT signal — short selling is off for this worker';
    const spread = st.ask - st.bid;
    const plan = this.exitPlan(spread);
    if (!plan) return 'ATR not ready — cannot place a stop yet';
    if (spread > plan.stopDistance * 0.35) return `spread ${this.money(spread)} is too wide for a ${this.money(plan.stopDistance)} stop`;
    const ref = side === 'buy' ? st.ask : st.bid;
    // Worst acceptable fill: the slippage allowance, but never more than a quarter of the stop.
    const slip = Math.min((ref * this.config.entrySlippagePct) / 100, plan.stopDistance * 0.25);
    const bound = roundToTick(side === 'buy' ? ref + slip : ref - slip, false, side === 'buy' ? 'up' : 'down');
    const stopPrice = roundToTick(side === 'buy' ? ref - plan.stopDistance : ref + plan.stopDistance, false, side === 'buy' ? 'down' : 'up');
    const worstStop = Math.abs(bound - stopPrice);
    const size = this.shareSize(bound, worstStop);
    if (size.qty < 1) return size.note ?? 'size unavailable';
    return {
      ...common,
      symbol: sym,
      underlying: sym,
      assetClass: 'us_equity',
      side,
      positionIntent: null,
      type: 'limit',
      qty: size.qty,
      limitPrice: bound,
      meta: {
        multiplier: 1,
        direction,
        signal: signalMeta,
        quote: { bid: st.bid, ask: st.ask, at: st.quoteAt },
        exitPlan: plan,
        softStop: { price: stopPrice },
        riskAtStop: size.qty * worstStop,
      },
      referencePrice: ref,
    };
  }

  private sizeFor(price: number, multiplier: number): number {
    const L = this.config.limits;
    const notionalCap = Math.min(L.maxPositionNotional, this.d.maxPositionNotional());
    const byNotional = Math.floor(notionalCap / (price * multiplier));
    const unitCap = multiplier > 1 ? Math.min(L.maxContracts, this.d.maxContracts()) : Math.min(L.maxShares, this.d.maxShares());
    return Math.max(0, Math.min(byNotional, unitCap));
  }

  private async waitForOptionQuote(symbol: string, ms: number): Promise<void> {
    const until = this.d.clock.now() + ms;
    while (this.d.clock.now() < until) {
      const q = this.d.marketData.optionQuote(symbol);
      if (q && !q.stale) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  private canAttemptEntry(sig: SignalState): string | null {
    if (!this.autotradeEnabled) return 'worker autotrading OFF';
    if (!this.d.controls.autotrading) return 'global autotrading OFF';
    if (this.d.controls.entriesPaused) return 'entries paused';
    if (this.d.controls.killSwitch.active) return 'kill switch active';
    const halt = this.d.systemHalt();
    if (halt) return halt;
    if (!sig.setupId || this.consumed.has(sig.setupId)) return 'signal already used';
    if (this.position() || this.entryOrderId || this.exitOrderId) return 'worker busy';
    if (this.cooldownUntilBarT !== null && (this.lastEvaluatedBarT ?? 0) < this.cooldownUntilBarT) return 'cooling down after exit';
    return null;
  }

  private async tryEntry(sig: SignalState, barCloseAt: number): Promise<void> {
    const pre = this.canAttemptEntry(sig);
    if (pre) {
      if (pre !== 'worker busy' && pre !== 'signal already used' && pre !== 'worker autotrading OFF' && pre !== 'global autotrading OFF') this.block(pre);
      return;
    }
    if (this.busy) return;
    this.busy = true;
    try {
      const direction = sig.direction as SignalDirection;
      const st = this.d.marketData.state(this.config.symbol);
      const spot = st?.last ?? (st?.bid !== null && st?.ask !== null && st ? (st.bid! + st.ask!) / 2 : null);
      if (spot === null || spot === undefined) return this.block('no live price for the underlying');

      let req: EntryRequest;
      const common = {
        workerId: this.id,
        source: 'WORKER' as const,
        purpose: 'ENTRY' as const,
        signalId: sig.setupId,
        timeInForce: 'day' as const,
        stopPrice: null,
        actor: `worker:${this.id}`,
        signalBarCloseAt: barCloseAt,
      };
      const signalMeta = { charge: sig.charge, conditions: sig.conditions };

      if (this.config.instrument === 'OPTIONS') {
        const sel = await this.d.selector.select({
          underlying: this.config.symbol,
          direction,
          spot,
          prefs: this.config.options,
          maxQuoteAgeMs: this.d.maxOptionQuoteAgeMs,
        });
        if (!sel.ok || !sel.contract) return this.block(sel.reason);
        const c = sel.contract;
        this.d.marketData.watchOptions(this.id, [c.symbol]);
        this.d.marketData.seedOptionQuote(c.symbol, { bid: c.bid, ask: c.ask, bidSize: c.bidSize, askSize: c.askSize, quoteTime: c.quoteTime, lastPrice: null, lastTime: null });
        await this.waitForOptionQuote(c.symbol, 3000);
        const q = this.d.marketData.optionQuote(c.symbol);
        const ask = q?.ask ?? c.ask;
        if (ask === null || ask <= 0) return this.block(`${c.symbol}: no ask`);
        const limit = roundToTick(ask * (1 + this.config.entrySlippagePct / 100), true, 'up');
        const qty = this.sizeFor(limit, c.multiplier);
        if (qty < 1) return this.block(`size: one contract at $${limit.toFixed(2)} exceeds position limits`);
        req = {
          ...common,
          symbol: c.symbol,
          underlying: this.config.symbol,
          assetClass: 'us_option',
          side: 'buy',
          positionIntent: 'buy_to_open',
          type: 'limit',
          qty,
          limitPrice: limit,
          meta: { multiplier: c.multiplier, direction, signal: signalMeta, quote: { bid: q?.bid ?? c.bid, ask, at: q?.quoteAt ?? c.quoteTime } },
          referencePrice: ask,
        };
      } else if (this.config.instrument === 'CFD') {
        const r = await this.cfdEntry(direction, common, signalMeta);
        if (typeof r === 'string') return this.block(r);
        req = r;
      } else {
        const r = this.equityEntry(direction, common, signalMeta);
        if (typeof r === 'string') return this.block(r);
        req = r;
      }

      // Dry run first: a transient block (e.g. one stale second) must not consume the signal.
      const dry = await this.d.orders.previewRisk(req);
      this.lastRisk = dry;
      if (!dry.approved) return this.block(dry.blockedBy ? `${dry.blockedBy.label}: ${dry.blockedBy.detail}` : 'risk check failed', dry);

      const order = await this.d.orders.submit(req);
      this.lastRisk = order.risk;
      this.lastBlock = null;
      if (order.state === 'REJECTED') {
        if (order.rejectedBy !== 'VALIDATION') this.consumed.add(sig.setupId!);
        void this.d.signals.setOutcome(sig.setupId!, `REJECTED_${order.rejectedBy}`, order.id).catch(() => undefined);
        return;
      }
      this.consumed.add(sig.setupId!);
      this.entryOrderId = order.id;
      void this.d.signals.setOutcome(sig.setupId!, 'ORDER_SUBMITTED', order.id).catch(() => undefined);
    } catch (err) {
      this.d.logger.error({ err, worker: this.id }, 'entry attempt failed');
      this.block(`entry error: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  // ── Orders in flight ───────────────────────────────────────────────────

  private async manageOrders(now: number): Promise<void> {
    if (this.entryOrderId) {
      const o = this.d.orders.get(this.entryOrderId);
      if (!o || isTerminal(o.state) || o.state === 'ERROR') {
        this.entryOrderId = null;
        this.entryCanceling = false;
      } else if (!this.entryCanceling && o.submittedAt && now - o.submittedAt > this.config.entryTimeoutSec * 1000 && (o.state === 'ACCEPTED' || o.state === 'SUBMITTED' || o.state === 'PARTIALLY_FILLED')) {
        // Unfilled entry: cancel. Any partial fill stays as the position.
        this.entryCanceling = true;
        const r = await this.d.orders.cancel(o.id, `worker:${this.id}`);
        this.d.timeline.add({ kind: 'order', workerId: this.id, symbol: o.symbol, title: `${this.config.name} · entry timed out`, detail: r.message });
        if (!r.ok) this.entryCanceling = false;
      }
    }
    if (this.exitOrderId) {
      const o = this.d.orders.get(this.exitOrderId);
      if (!o || isTerminal(o.state) || o.state === 'ERROR') {
        this.exitOrderId = null;
      } else if (o.type === 'limit' && o.submittedAt && now - o.submittedAt > EXIT_REPRICE_MS && o.state !== 'CANCEL_PENDING') {
        // Limit exit not filling: cancel; the next tick re-exits at market.
        const r = await this.d.orders.cancel(o.id, `worker:${this.id}`);
        if (r.ok) this.exitReason = `${this.exitReason ?? 'EXIT'} (repriced to market)`;
      }
    }
  }

  // ── Exits ───────────────────────────────────────────────────────────────

  position(): LedgerPosition | null {
    return this.d.ledger.byWorker(this.id);
  }

  private markPrice(pos: LedgerPosition): { price: number | null; fresh: boolean } {
    if (pos.assetClass === 'us_option') {
      const q = this.d.marketData.optionQuote(pos.symbol);
      return { price: q?.mid ?? q?.last ?? null, fresh: !!q && !q.stale };
    }
    if (pos.assetClass === 'cfd') {
      const st = this.d.marketData.state(pos.symbol);
      const f = this.d.marketData.freshness(pos.symbol);
      const mid = st && st.bid !== null && st.ask !== null ? (st.bid + st.ask) / 2 : (st?.last ?? null);
      return { price: mid, fresh: !f.stale };
    }
    const st = this.d.marketData.state(pos.symbol);
    const f = this.d.marketData.freshness(pos.symbol);
    const mid = st && st.bid !== null && st.ask !== null ? (st.bid + st.ask) / 2 : null;
    return { price: st?.last ?? mid, fresh: !f.stale };
  }

  /** The exit plan stored with the open trade (survives restarts), else one from the live ATR. */
  private planFor(pos: LedgerPosition): ExitPlan | null {
    const snap = this.d.ledger.openTrade(pos.tradeId)?.riskSnapshot as { exitPlan?: ExitPlan | null } | null | undefined;
    const p = snap?.exitPlan;
    if (p && p.stopDistance > 0 && p.targetDistance > 0) return p;
    return this.exitPlan();
  }

  /**
   * Stop/target exits for CFD and share positions, judged on the price we'd actually get: the bid for
   * longs, the ask for shorts. Shares have no broker-held stop: this is the only thing that stops them out.
   */
  private planExitReason(pos: LedgerPosition, now: number): { reason: string; urgent: boolean } | null {
    const st = this.d.marketData.state(pos.symbol);
    if (!st || st.bid === null || st.ask === null || this.d.marketData.freshness(pos.symbol).stale) return null;
    const x = this.config.exits;
    const long = pos.qty > 0;
    const exec = long ? st.bid : st.ask;
    if (!this.d.calendar.isOpen(now)) {
      // CFDs outside the trading window (e.g. after a restart): don't carry it — close while the broker allows.
      // Shares can't trade outside the regular session; they are judged again at the next open.
      if (pos.assetClass !== 'cfd') return null;
      return st.tradeable === false ? null : { reason: 'SESSION_CLOSED', urgent: true };
    }
    const toClose = this.d.calendar.minutesToClose(now);
    if (toClose !== null && toClose <= x.flattenBeforeCloseMinutes) return { reason: 'END_OF_DAY', urgent: true };
    // The free IEX feed goes quiet at 17:00: be out while there is still a price to get out at.
    const dataLeft = this.d.calendar.policy !== 'regular' ? this.d.marketData.dataMinutesLeft(now) : null;
    if (dataLeft !== null && dataLeft <= x.flattenBeforeCloseMinutes) return { reason: 'END_OF_DAY', urgent: true };
    const plan = this.planFor(pos);
    if (plan) {
      const stopHit = long ? exec <= pos.avgPrice - plan.stopDistance : exec >= pos.avgPrice + plan.stopDistance;
      if (stopHit) return { reason: 'STOP_LOSS', urgent: true };
      const targetHit = long ? exec >= pos.avgPrice + plan.targetDistance : exec <= pos.avgPrice - plan.targetDistance;
      if (targetHit) return { reason: 'TAKE_PROFIT', urgent: false };
    }
    if (now - pos.openedAt >= x.maxHoldMinutes * 60_000) return { reason: 'TIME_STOP', urgent: false };
    if (x.exitOnVwapLoss && this.vwapLost) return { reason: 'VWAP_LOST', urgent: false };
    return null;
  }

  private async manageExit(now: number): Promise<void> {
    const pos = this.position();
    if (!pos || this.exitOrderId || this.busy || now < this.exitBackoffUntil) return;
    if (pos.assetClass === 'cfd' || pos.assetClass === 'us_equity') {
      const r = this.planExitReason(pos, now);
      // A limit exit that did not fill is repriced to market.
      if (r) await this.submitExit(pos, r.reason, r.urgent || (this.exitReason?.includes('repriced') ?? false));
      return;
    }
    if (pos.assetClass === 'us_option') this.d.marketData.watchOptions(this.id, [pos.symbol]);
    const { price, fresh } = this.markPrice(pos);
    if (price === null || !fresh) return; // can't decide on stale data — surfaced as an unmanaged warning
    const dir = pos.qty > 0 ? 1 : -1;
    const pnlPct = ((price - pos.avgPrice) / pos.avgPrice) * 100 * dir;
    const x = this.config.exits;
    const toClose = this.d.calendar.minutesToClose(now);
    let reason: string | null = null;
    let urgent = false;
    if (toClose !== null && toClose <= x.flattenBeforeCloseMinutes) {
      reason = 'END_OF_DAY';
      urgent = true;
    } else if (pnlPct <= -x.stopLossPct) {
      reason = 'STOP_LOSS';
      urgent = true;
    } else if (pnlPct >= x.takeProfitPct) reason = 'TAKE_PROFIT';
    else if (now - pos.openedAt >= x.maxHoldMinutes * 60_000) reason = 'TIME_STOP';
    else if (x.exitOnVwapLoss && this.vwapLost) reason = 'VWAP_LOST';
    if (this.exitReason?.includes('repriced')) urgent = true;
    if (!reason) return;
    await this.submitExit(pos, reason, urgent);
  }

  private async submitExit(pos: LedgerPosition, reason: string, urgent: boolean): Promise<void> {
    this.busy = true;
    try {
      const isOption = pos.assetClass === 'us_option';
      const isCfd = pos.assetClass === 'cfd';
      const isShares = pos.assetClass === 'us_equity';
      const side = pos.qty > 0 ? 'sell' : 'buy';
      let type: 'market' | 'limit' = 'market';
      let limitPrice: number | null = null;
      if (isOption && !urgent) {
        const q = this.d.marketData.optionQuote(pos.symbol);
        const px = side === 'sell' ? q?.bid : q?.ask;
        if (px && px > 0) {
          type = 'limit';
          limitPrice = roundToTick(px, true, side === 'sell' ? 'down' : 'up');
        }
      } else if (isShares && !urgent) {
        // Not urgent (target, time stop, VWAP loss): ask for the current bid/ask instead of crossing the spread blindly.
        const st = this.d.marketData.state(pos.symbol);
        const px = side === 'sell' ? st?.bid : st?.ask;
        if (px && px > 0) {
          type = 'limit';
          limitPrice = roundToTick(px, false, side === 'sell' ? 'down' : 'up');
        }
      }
      let ref = this.markPrice(pos).price;
      if (isCfd) {
        const st = this.d.marketData.state(pos.symbol);
        ref = (side === 'sell' ? st?.bid : st?.ask) ?? ref;
      }
      const order = await this.d.orders.submit({
        workerId: this.id,
        source: 'WORKER',
        purpose: 'EXIT',
        signalId: null,
        symbol: pos.symbol,
        underlying: pos.underlying ?? parseOccSymbol(pos.symbol)?.root ?? pos.symbol,
        assetClass: pos.assetClass,
        side,
        positionIntent: isOption || isCfd ? (side === 'sell' ? 'sell_to_close' : 'buy_to_close') : null,
        type,
        // CFD exits: market fill-or-kill, reduce-only at the broker (can never open a reverse position).
        timeInForce: isCfd ? 'fok' : 'day',
        qty: Math.abs(pos.qty),
        limitPrice,
        stopPrice: null,
        meta: { multiplier: pos.multiplier, direction: pos.direction, exitReason: reason },
        actor: `worker:${this.id}`,
        referencePrice: ref,
      } as OrderRequest & { referencePrice: number | null });
      this.lastRisk = order.risk;
      if (order.state === 'REJECTED' || order.state === 'ERROR') {
        this.exitBackoffUntil = this.d.clock.now() + 5000;
        if (order.rejectedBy === 'RISK') this.block(`exit blocked — ${order.rejectReason}`, order.risk);
        return;
      }
      this.exitOrderId = order.id;
      this.exitReason = reason;
      this.d.timeline.add({ kind: 'exit', workerId: this.id, symbol: pos.symbol, title: `${this.config.name} · exit order submitted`, detail: `${reason} · ${type}${limitPrice ? ` @ ${limitPrice}` : ''}` });
    } finally {
      this.busy = false;
    }
  }

  /** Called by the manager when one of this worker's positions closes. */
  onPositionClosed(pnl: number | null): void {
    const now = this.d.clock.now();
    this.transient = { state: (pnl ?? 0) >= 0 ? 'PROFIT' : 'LOSS', until: now + 8000 };
    this.exitReason = null;
    this.d.marketData.watchOptions(this.id, []);
    const tfMs = timeframeMinutes(this.config.timeframe) * 60_000;
    this.cooldownUntilBarT = (this.lastEvaluatedBarT ?? now) + this.config.exits.cooldownBars * tfMs;
  }

  onOrderUpdated(o: OrderRecord): void {
    if (o.id === this.entryOrderId && isTerminal(o.state)) this.entryOrderId = null;
    if (o.id === this.exitOrderId && isTerminal(o.state)) this.exitOrderId = null;
  }

  // ── View ───────────────────────────────────────────────────────────────

  private haltReason(): string | null {
    if (this.d.controls.killSwitch.active) return 'KILL SWITCH';
    const sys = this.d.systemHalt();
    if (sys) return sys;
    const s = this.d.stats.base(this.id);
    const unreal = this.unrealized();
    if (s.realizedToday + (unreal ?? 0) <= -this.config.limits.dailyLossLimit) return 'WORKER DAILY LOSS LIMIT';
    return null;
  }

  private standDownReason(): string | null {
    const s = this.d.stats.base(this.id);
    if (s.realizedToday >= this.config.limits.dailyGoal) return 'DAILY GOAL REACHED';
    if (this.d.orders.entriesToday(this.id) >= this.config.limits.maxTradesPerDay) return 'TRADE LIMIT REACHED';
    return null;
  }

  /** 0 when flat; null when a position is open but has no usable mark (unknown, never assumed 0). */
  unrealized(): number | null {
    const pos = this.position();
    if (!pos) return 0;
    const { price } = this.markPrice(pos);
    if (price === null) return null;
    const mult = pos.assetClass === 'cfd' ? (this.d.instruments.homeFactor(pos.symbol) ?? pos.multiplier) : pos.multiplier;
    return (price - pos.avgPrice) * pos.qty * mult;
  }

  /** Live instrument facts and the size the next entry would use (CFD workers). */
  private marketView(): WorkerMarketView | null {
    if (this.config.instrument !== 'CFD') return null;
    const sym = this.config.symbol;
    const spec = this.d.instruments.get(sym);
    const st = this.d.marketData.state(sym);
    const factor = this.d.instruments.homeFactor(sym);
    const acct = this.d.account();
    const mid = st && st.bid !== null && st.ask !== null ? (st.bid + st.ask) / 2 : (st?.last ?? null);
    const spread = st && st.bid !== null && st.ask !== null ? st.ask - st.bid : null;
    const plan = this.exitPlan(spread);
    let plannedUnits: number | null = null;
    let sizingNote: string | null = null;
    if (!spec) sizingNote = this.d.instruments.loaded ? `${sym} is not offered to this account` : 'instrument rules not loaded yet';
    else if (mid === null) sizingNote = 'no live price';
    else if (factor === null) sizingNote = 'currency conversion rate unavailable';
    else if (!plan) sizingNote = 'waiting for ATR (needs ~15 one-minute bars)';
    else {
      const slip = Math.min((mid * this.config.entrySlippagePct) / 100, plan.stopDistance * 0.25);
      const r = this.cfdSize(spec, mid + slip, plan.stopDistance + slip, factor);
      plannedUnits = r.units;
      sizingNote = r.note;
    }
    return {
      displayName: instrumentName(sym),
      tradeable: st?.tradeable ?? null,
      listed: spec !== null,
      unitsPrecision: spec?.unitsPrecision ?? null,
      minUnits: spec?.minUnits ?? null,
      displayPrecision: spec?.displayPrecision ?? null,
      marginRate: this.d.instruments.marginRate(sym, acct),
      homeFactor: factor,
      minNotional: spec && mid !== null && factor !== null ? spec.minUnits * mid * factor : null,
      currency: acct?.currency ?? null,
      plannedStop: plan?.stopDistance ?? null,
      plannedTarget: plan?.targetDistance ?? null,
      plannedUnits,
      sizingNote,
    };
  }

  private towerState(): { state: TowerState; text: string } {
    const pos = this.position();
    const halt = this.haltReason();
    const marketOpen = this.d.calendar.isOpen();
    const activeOrder = (this.entryOrderId && this.d.orders.get(this.entryOrderId)) || (this.exitOrderId && this.d.orders.get(this.exitOrderId)) || null;
    if (halt) return { state: 'HALTED', text: halt };
    if (this.transient) return { state: this.transient.state, text: this.transient.state === 'PROFIT' ? 'PROFIT LOCKED' : 'POSITION CLOSED' };
    if (activeOrder && !isTerminal(activeOrder.state)) return { state: 'ORDER_PENDING', text: `ORDER ${activeOrder.state.replace('_', ' ')}` };
    if (pos) return { state: 'IN_TRADE', text: `IN TRADE · ${directionLabel(pos.direction, pos.assetClass)}` };
    // A market the broker does not offer this account has no data and can never be traded: say so instead of "monitoring".
    if (this.config.instrument === 'CFD' && this.d.instruments.loaded && this.d.instruments.get(this.config.symbol) === null) {
      return { state: 'STANDING_DOWN', text: 'NOT OFFERED TO THIS ACCOUNT' };
    }
    if (!marketOpen) return { state: 'WATCHING', text: this.config.instrument === 'CFD' ? 'OUTSIDE SESSION · MONITORING' : 'MARKET CLOSED · MONITORING' };
    const stand = this.standDownReason();
    if (stand) return { state: 'STANDING_DOWN', text: stand };
    const suffix = this.autotradeEnabled && this.d.controls.autotrading ? '' : ' · AUTOTRADING OFF';
    switch (this.signal.phase) {
      case 'READY':
        return { state: 'READY', text: `READY${suffix}` };
      case 'CHARGING':
        return { state: 'CHARGING', text: `CHARGING${suffix}` };
      case 'FORMING':
        return { state: 'SETUP_FORMING', text: `SETUP FORMING${suffix}` };
      default:
        return { state: 'WATCHING', text: `MONITORING${suffix}` };
    }
  }

  /** The broker-held stop for a CFD position, the plan's target, and the loss if the stop is hit. */
  private cfdProtection(pos: LedgerPosition): { stopPrice: number | null; targetPrice: number | null; riskAtStop: number | null } {
    const sign = pos.qty > 0 ? 1 : -1;
    const stop = this.d.orders.protectiveStops().find((o) => o.workerId === this.id && o.symbol === pos.symbol)?.stopPrice ?? null;
    const plan = this.planFor(pos);
    const f = this.d.instruments.homeFactor(pos.symbol);
    return {
      stopPrice: stop,
      targetPrice: plan ? pos.avgPrice + sign * plan.targetDistance : null,
      riskAtStop: stop !== null && f !== null ? Math.abs(pos.qty) * (pos.avgPrice - stop) * sign * f : null,
    };
  }

  /** The server-held stop for a share position, the plan's target, and the loss if the stop is hit. */
  private shareProtection(pos: LedgerPosition): { stopPrice: number | null; targetPrice: number | null; riskAtStop: number | null } {
    const sign = pos.qty > 0 ? 1 : -1;
    const plan = this.planFor(pos);
    if (!plan) return { stopPrice: null, targetPrice: null, riskAtStop: null };
    return {
      stopPrice: pos.avgPrice - sign * plan.stopDistance,
      targetPrice: pos.avgPrice + sign * plan.targetDistance,
      riskAtStop: Math.abs(pos.qty) * plan.stopDistance,
    };
  }

  private unmanagedWarning(): string | null {
    const pos = this.position();
    if (!pos) return null;
    if (pos.assetClass === 'cfd' && this.d.clock.now() - pos.openedAt > 15_000 && this.cfdProtection(pos).stopPrice === null) {
      return 'NO BROKER-SIDE STOP — this position is only protected while Scalp City is running. Close it, or add a stop at the broker.';
    }
    if (this.d.controls.killSwitch.active) return 'KILL SWITCH — position is not being managed. Use FLATTEN ALL or close manually.';
    if (!this.d.controls.autotrading) return 'AUTOTRADING OFF — no automated stop/target on this position. Use PAUSE ENTRIES to keep exits active.';
    if (!this.autotradeEnabled) return 'Worker OFF — no automated stop/target on this position.';
    const { price, fresh } = this.markPrice(pos);
    if (price === null || !fresh) return 'No live price for this position — exits cannot be evaluated until data resumes.';
    return null;
  }

  signalView(): SignalView {
    const s = this.signal;
    const tfMs = timeframeMinutes(this.config.timeframe) * 60_000;
    const now = this.d.clock.now();
    return {
      signalId: s.setupId,
      direction: s.direction,
      phase: s.phase,
      charge: s.charge,
      callCharge: s.callCharge,
      putCharge: s.putCharge,
      conditions: s.conditions,
      barTime: s.barTime,
      live: this.live ? { direction: this.live.direction, charge: this.live.charge, conditions: this.live.conditions, asOf: this.liveAt } : null,
      nextEvaluationAt: this.d.calendar.isOpen(now) ? Math.floor(now / tfMs) * tfMs + tfMs : null,
      consumed: s.setupId !== null && this.consumed.has(s.setupId),
      lastRisk: this.lastRisk,
    };
  }

  view(): WorkerView {
    const pos = this.position();
    const tower = this.towerState();
    const unreal = this.unrealized();
    let position: WorkerPositionView | null = null;
    if (pos) {
      const { price } = this.markPrice(pos);
      const occ = parseOccSymbol(pos.symbol);
      const cfd = pos.assetClass === 'cfd' ? this.cfdProtection(pos) : null;
      const shares = pos.assetClass === 'us_equity' ? this.shareProtection(pos) : null;
      position = {
        symbol: pos.symbol,
        assetClass: pos.assetClass,
        direction: pos.direction,
        qty: pos.qty,
        avgEntryPrice: pos.avgPrice,
        markPrice: price,
        unrealizedPnl: unreal,
        unrealizedPnlPct: price === null ? null : ((price - pos.avgPrice) / pos.avgPrice) * 100 * (pos.qty > 0 ? 1 : -1),
        openedAt: pos.openedAt,
        tradeId: pos.tradeId ?? '',
        option: occ ? { underlying: occ.root, expiration: occ.expiration, type: occ.type, strike: occ.strike } : null,
        stopPrice: cfd?.stopPrice ?? shares?.stopPrice ?? null,
        stopSource: cfd?.stopPrice != null ? 'broker' : shares?.stopPrice != null ? 'server' : null,
        targetPrice: cfd?.targetPrice ?? shares?.targetPrice ?? null,
        riskAtStop: cfd?.riskAtStop ?? shares?.riskAtStop ?? null,
      };
    }
    return {
      config: this.config,
      market: this.marketView(),
      autotradeEnabled: this.autotradeEnabled,
      towerState: tower.state,
      statusText: tower.text,
      haltReason: tower.state === 'HALTED' ? tower.text : null,
      signal: this.signalView(),
      position,
      activeOrderId: this.exitOrderId ?? this.entryOrderId,
      stats: this.d.stats.stats(this.id, unreal),
      unmanagedWarning: this.unmanagedWarning(),
      lastEvaluatedAt: this.lastEvaluatedAt,
    };
  }

  indicatorSnapshot(): IndicatorSnapshot | null {
    return this.lastSnapshot;
  }
}
