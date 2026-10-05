import type {
  AssetClass,
  BrokerStatus,
  OrderPurpose,
  OrderSide,
  OrderSource,
  OrderType,
  RiskCheckView,
  RiskDecisionView,
  RiskLimits,
  TradingEnvironment,
  WorkerConfigView,
} from '@scalp-city/shared';
import type { BrokerAccount, BrokerPosition } from '../broker/types.js';
import { formatMoney, formatQty } from '../core/format.js';
import type { Freshness } from '../marketdata/MarketDataService.js';
import type { OrderRecord } from '../orders/types.js';
import type { LedgerPosition } from '../positions/types.js';

/** The order being evaluated. */
export interface ProposedOrder {
  /** Local id of the order being evaluated (excluded from "signal already used"). */
  orderId: string | null;
  purpose: OrderPurpose;
  source: OrderSource;
  workerId: string | null;
  signalId: string | null;
  /** Close time of the bar that produced the signal (worker entries). */
  signalBarCloseAt: number | null;
  symbol: string;
  /** Equity whose data drives the decision (the symbol itself for equities). */
  underlying: string | null;
  assetClass: AssetClass;
  side: OrderSide;
  qty: number;
  type: OrderType;
  limitPrice: number | null;
  stopPrice: number | null;
  multiplier: number;
  /** Live reference price: ask for buys, bid for sells (options), last/mid (equities). */
  referencePrice: number | null;
  /** CFD opens: stop loss price placed at the broker with the order. */
  protectiveStop?: number | null;
}

/** Instrument and margin facts for a CFD order (OANDA). */
export interface CfdMarket {
  /** The broker offers this instrument to this account. */
  listed: boolean;
  /** The broker's live "tradeable" flag on the latest price (null = no price seen). */
  tradeable: boolean | null;
  unitsPrecision: number | null;
  minUnits: number | null;
  maxOrderUnits: number | null;
  /** Effective margin rate for the instrument (0.05 = 20:1). */
  marginRate: number | null;
  /** Account-currency value of a 1.0 price move on one unit. */
  homeFactor: number | null;
  marginAvailable: number | null;
}

export interface OptionMarket {
  bid: number | null;
  ask: number | null;
  ageMs: number | null;
  stale: boolean;
  volume: number | null;
  openInterest: number | null;
  bidSize: number | null;
  contractTradable: boolean;
  contractStatus: string | null;
}

/** Everything the rules look at, captured at one instant. */
export interface RiskState {
  now: number;
  env: TradingEnvironment;
  limits: RiskLimits;
  /** Account currency, for messages. */
  currency?: string | null;
  /** CFD orders only. */
  cfd?: CfdMarket | null;
  controls: { autotrading: boolean; entriesPaused: boolean; killSwitch: boolean };
  live: { serverLockOpen: boolean; armed: boolean };
  /** Tripped circuit breakers. `exitSafe` breakers do not block risk-reducing exits. */
  breakers: { id: string; label: string; exitSafe: boolean }[];
  broker: { status: BrokerStatus; detail: string | null };
  account: BrokerAccount | null;
  accountRestriction: string | null;
  accountDayPnl: number | null;
  market: { isOpen: boolean; minutesToClose: number | null; label: string };
  clock: { ok: boolean; skewMs: number | null };
  freshness: Freshness | null;
  optionsPolicy: { allowed: boolean; reason: string | null };
  optionMarket: OptionMarket | null;
  /** Live reference price at evaluation time (ask for buys, bid for sells); overrides the proposal's. */
  referencePrice: number | null;
  reconciliation: { ok: boolean; detail: string | null };
  brokerPositions: BrokerPosition[];
  ledgerPositions: LedgerPosition[];
  /** Local orders that may still fill (non-terminal). */
  openOrders: OrderRecord[];
  entriesToday: number;
  workerEntriesToday: number;
  ordersLastMinute: number;
  worker: {
    config: WorkerConfigView;
    autotradeEnabled: boolean;
    dayPnl: number | null;
    realizedToday: number;
  } | null;
  asset: { tradable: boolean; shortable: boolean; easyToBorrow: boolean } | null;
  signalAlreadyUsed: boolean;
  allowedUnderlyings: string[];
  maxSignalAgeMs: number;
}

const OPEN_PURPOSES: ReadonlySet<OrderPurpose> = new Set(['ENTRY', 'MANUAL_OPEN']);

export function isOpening(purpose: OrderPurpose): boolean {
  return OPEN_PURPOSES.has(purpose);
}

/** True when `qty` is a whole multiple of 10^-precision (with float tolerance). */
export function fitsPrecision(qty: number, precision: number): boolean {
  const scaled = qty * 10 ** precision;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

class Checks {
  readonly list: RiskCheckView[] = [];
  add(id: string, label: string, passed: boolean, detail: string): void {
    this.list.push({ id, label, passed, detail });
  }
}

/** Position notional for a broker position (abs, account currency). */
function positionNotional(p: BrokerPosition): number {
  if (p.marketValue !== null) return Math.abs(p.marketValue);
  const mult = p.multiplier ?? (p.assetClass === 'us_option' ? 100 : 1);
  return Math.abs(p.qty * (p.currentPrice ?? p.avgEntryPrice) * mult);
}

/**
 * Evaluate an order against every risk rule (spec §23). Pure: no I/O, no
 * clocks, no hidden state — the same inputs always give the same answer.
 * There is deliberately no override parameter.
 */
export function evaluateRisk(o: ProposedOrder, s: RiskState): RiskDecisionView {
  const c = new Checks();
  const ref = s.referencePrice ?? o.referencePrice;
  const opening = isOpening(o.purpose);
  const automated = o.source === 'WORKER';
  const isOption = o.assetClass === 'us_option';
  const isCfd = o.assetClass === 'cfd';
  const cfd = isCfd ? (s.cfd ?? null) : null;
  const L = s.limits;
  const money = (v: number) => formatMoney(v, s.currency ?? 'USD');

  // ── Structural sanity ──────────────────────────────────────────────────
  if (isCfd) {
    const prec = cfd?.unitsPrecision ?? null;
    const min = cfd?.minUnits ?? null;
    const max = cfd?.maxOrderUnits ?? null;
    const ok =
      Number.isFinite(o.qty) &&
      o.qty > 0 &&
      prec !== null &&
      fitsPrecision(o.qty, prec) &&
      (min === null || o.qty >= min - 1e-9) &&
      (max === null || o.qty <= max);
    c.add(
      'qty',
      'Quantity',
      ok,
      prec === null
        ? `${formatQty(o.qty)} units — instrument size rules unknown`
        : `${formatQty(o.qty)} units (step ${10 ** -prec}${min !== null ? `, min ${formatQty(min)}` : ''}${max !== null ? `, max ${formatQty(max)}` : ''})`,
    );
  } else {
    c.add('qty', 'Quantity', Number.isInteger(o.qty) && o.qty > 0, `${o.qty}`);
  }
  if (isOption && o.side === 'sell' && opening) {
    c.add('no_short_options', 'Short options', false, 'selling options to open is not supported');
  }

  // ── Global gates ───────────────────────────────────────────────────────
  if (s.env === 'live') {
    const ok = s.live.serverLockOpen && s.live.armed;
    c.add(
      'live_gate',
      'Live execution',
      ok,
      !s.live.serverLockOpen ? 'LIVE_TRADING_ENABLED=false on the server' : !s.live.armed ? 'live execution not armed in the app' : 'armed',
    );
  }

  if (opening || o.purpose === 'EXIT') {
    c.add('kill_switch', 'Kill switch', !s.controls.killSwitch, s.controls.killSwitch ? 'KILL SWITCH ACTIVE' : 'ready');
  }

  const blockingBreakers = opening ? s.breakers : o.purpose === 'EXIT' ? s.breakers.filter((b) => !b.exitSafe) : [];
  c.add(
    'circuit_breakers',
    'Circuit breakers',
    blockingBreakers.length === 0,
    blockingBreakers.length ? `tripped: ${blockingBreakers.map((b) => b.label).join(', ')}` : 'none tripped',
  );

  if (automated) {
    c.add('autotrading', 'Autotrading', s.controls.autotrading, s.controls.autotrading ? 'on' : 'AUTOTRADING OFF');
    const enabled = s.worker?.autotradeEnabled === true;
    c.add('worker_enabled', 'Worker enabled', enabled, enabled ? 'on' : 'worker autotrading OFF');
  }
  if (o.purpose === 'ENTRY') {
    c.add('entries_paused', 'Entries', !s.controls.entriesPaused, s.controls.entriesPaused ? 'ENTRIES PAUSED' : 'open');
  }

  c.add('broker', 'Broker', s.broker.status === 'CONNECTED', s.broker.status === 'CONNECTED' ? 'connected' : `${s.broker.status}${s.broker.detail ? ` — ${s.broker.detail}` : ''}`);
  c.add('account', 'Account', s.account !== null && s.accountRestriction === null, s.account === null ? 'account unavailable' : (s.accountRestriction ?? 'active'));
  if (isCfd) {
    // FX/CFDs trade outside the strategy's session: closing is allowed whenever
    // the broker says the instrument is tradeable; opening needs both.
    const tradeable = cfd?.tradeable ?? null;
    const userClose = o.purpose === 'MANUAL_CLOSE' || o.purpose === 'FLATTEN';
    const instrOk = tradeable === true || (userClose && tradeable === null);
    const instrDetail = tradeable === true ? 'tradeable' : tradeable === false ? `${o.symbol} not tradeable right now (closed or halted)` : 'no live price yet';
    if (opening) {
      c.add('market_open', 'Market open', s.market.isOpen && instrOk, !s.market.isOpen ? `session ${s.market.label.toLowerCase().replace('_', ' ')}` : instrDetail);
    } else {
      c.add('market_open', 'Market open', instrOk, instrDetail);
    }
  } else {
    c.add('market_open', 'Market open', s.market.isOpen, s.market.isOpen ? 'regular session' : `market ${s.market.label.toLowerCase().replace('_', ' ')}`);
  }
  c.add('clock', 'Server clock', s.clock.ok, s.clock.ok ? `skew ${s.clock.skewMs ?? 0}ms` : s.clock.skewMs === null ? 'broker clock not verified' : `skew ${s.clock.skewMs}ms`);

  if (opening) {
    const m = s.market.minutesToClose;
    const ok = m !== null && m > L.noEntriesBeforeCloseMinutes;
    c.add('near_close', 'Time to close', ok, m === null ? 'n/a' : `${m.toFixed(1)} min to close (no entries in last ${L.noEntriesBeforeCloseMinutes})`);
  }

  // Decisions made by a worker must rest on live data. Manual closes and
  // flatten do not depend on our data feed.
  if (opening || o.purpose === 'EXIT') {
    const f = s.freshness;
    c.add('data_fresh', 'Market data', f !== null && !f.stale, f === null ? 'no data' : f.stale ? `STALE — ${f.reason}` : `live ${f.ageMs}ms`);
  }

  if (o.purpose === 'ENTRY') {
    const age = o.signalBarCloseAt === null ? null : s.now - o.signalBarCloseAt;
    c.add('signal_fresh', 'Signal age', age !== null && age >= 0 && age <= s.maxSignalAgeMs, age === null ? 'no signal time' : `${(age / 1000).toFixed(1)}s since bar close`);
    c.add('signal_unique', 'Signal unused', !s.signalAlreadyUsed, s.signalAlreadyUsed ? 'this signal already produced an order' : 'new');
  }

  c.add('reconciliation', 'Reconciled', opening || o.purpose === 'EXIT' ? s.reconciliation.ok : true, s.reconciliation.ok ? 'local = broker' : (s.reconciliation.detail ?? 'mismatch'));

  // Fat-finger guard: limit price must be near the live reference.
  if ((o.type === 'limit' || o.type === 'stop_limit') && o.limitPrice !== null) {
    if (ref === null || ref <= 0) {
      c.add('price_sanity', 'Price check', false, 'no live reference price');
    } else {
      const dev = (Math.abs(o.limitPrice - ref) / ref) * 100;
      c.add('price_sanity', 'Price check', dev <= L.maxPriceDeviationPct, `limit ${o.limitPrice} vs live ${ref} (${dev.toFixed(dev < 0.1 ? 3 : 1)}%, max ${L.maxPriceDeviationPct}%)`);
    }
  }

  const rateExempt = o.purpose === 'FLATTEN';
  if (!rateExempt) {
    c.add('order_rate', 'Order rate', s.ordersLastMinute < L.maxOrdersPerMinute, `${s.ordersLastMinute}/${L.maxOrdersPerMinute} in the last minute`);
  }

  // ── Opening-only rules ────────────────────────────────────────────────
  if (opening) {
    const underlying = o.underlying ?? o.symbol;
    if (o.source === 'WORKER') {
      c.add('symbol', 'Symbol eligible', s.allowedUnderlyings.includes(underlying), `${underlying} ${s.allowedUnderlyings.includes(underlying) ? 'allowed' : 'not in allowed list'}`);
    }

    if (isCfd) {
      c.add('instrument', 'Instrument', cfd !== null && cfd.listed, cfd === null || !cfd.listed ? `${o.symbol} is not offered to this account` : 'listed');
      if (o.side === 'sell') {
        const shortOk = o.source !== 'WORKER' || s.worker?.config.allowShort === true;
        c.add('short', 'Short sale', shortOk, shortOk ? 'CFD short allowed' : 'short entries disabled for this worker');
      }
      const stop = o.protectiveStop ?? null;
      if (stop !== null) {
        const sideOk = ref !== null && (o.side === 'buy' ? stop < ref : stop > ref);
        c.add('stop_side', 'Stop placement', sideOk, ref === null ? 'no live price to check the stop against' : `stop ${stop} vs live ${ref}${sideOk ? '' : ' — wrong side'}`);
      } else if (automated) {
        c.add('stop_present', 'Broker stop', false, 'automated CFD entries must carry a broker-side stop loss');
      }
    } else if (isOption) {
      const level = s.account?.optionsTradingLevel ?? s.account?.optionsApprovedLevel ?? null;
      c.add('options_permission', 'Options permission', level !== null && level >= 2, level === null ? 'options level unknown' : `level ${level} (long calls/puts need ≥ 2)`);
      if (automated) {
        c.add('options_data', 'Options data', s.optionsPolicy.allowed, s.optionsPolicy.allowed ? (s.optionsPolicy.reason ?? 'real-time') : (s.optionsPolicy.reason ?? 'unavailable'));
      }
      const om = s.optionMarket;
      c.add('contract', 'Contract', om !== null && om.contractTradable, om === null ? 'contract not validated' : om.contractTradable ? 'tradable' : `not tradable (${om.contractStatus ?? 'unknown'})`);
      if (om === null || om.bid === null || om.ask === null || om.bid <= 0 || om.ask <= 0) {
        c.add('option_quote', 'Option quote', false, 'no two-sided quote');
      } else {
        c.add('option_quote', 'Option quote', !om.stale, om.stale ? `quote stale (${om.ageMs === null ? 'n/a' : (om.ageMs / 1000).toFixed(1) + 's'})` : `bid ${om.bid} / ask ${om.ask}`);
        const spread = om.ask - om.bid;
        const mid = (om.ask + om.bid) / 2;
        const spreadPct = (spread / mid) * 100;
        const prefs = s.worker?.config.options;
        const maxPct = prefs?.maxSpreadPct ?? 25;
        const maxAbs = prefs?.maxSpreadAbs ?? Infinity;
        const liquidityOk =
          spreadPct <= maxPct &&
          spread <= maxAbs &&
          (prefs ? (om.volume ?? 0) >= prefs.minVolume : true) &&
          (prefs ? (om.openInterest ?? 0) >= prefs.minOpenInterest : true) &&
          (prefs ? (om.bidSize ?? 0) >= prefs.minBidSize : true);
        c.add(
          'liquidity',
          'Liquidity',
          liquidityOk,
          `spread ${spread.toFixed(2)} (${spreadPct.toFixed(1)}%, max ${maxPct}%)` +
            (prefs ? ` · vol ${om.volume ?? 'n/a'} (min ${prefs.minVolume}) · OI ${om.openInterest ?? 'n/a'} (min ${prefs.minOpenInterest})` : ''),
        );
      }
    } else {
      const a = s.asset;
      c.add('asset', 'Asset tradable', a !== null && a.tradable, a === null ? 'asset unknown' : a.tradable ? 'tradable' : 'not tradable');
      if (o.side === 'sell') {
        const shortOk = a !== null && a.shortable && a.easyToBorrow && s.account?.shortingEnabled === true && (o.source !== 'WORKER' || s.worker?.config.allowShort === true);
        c.add('short', 'Short sale', shortOk, shortOk ? 'shortable, easy to borrow' : 'short selling not permitted for this order');
      }
    }

    // Size (account currency). For CFDs the multiplier is the live quote→home conversion.
    const price = o.limitPrice ?? ref;
    const mult = isCfd ? (cfd?.homeFactor ?? null) : o.multiplier;
    const notional = price === null || mult === null ? null : o.qty * price * mult;
    const orderCap = Math.min(L.maxOrderNotional, s.worker?.config.limits.maxPositionNotional ?? Infinity);
    c.add(
      'order_notional',
      'Order value',
      notional !== null && notional <= orderCap,
      notional === null ? (mult === null ? 'currency conversion rate unavailable' : 'no price to value the order') : `${money(notional)} (max ${money(orderCap)})`,
    );

    const existing = s.brokerPositions.find((p) => p.symbol === o.symbol);
    const resulting = (existing ? positionNotional(existing) : 0) + (notional ?? Infinity);
    const posCap = Math.min(L.maxPositionNotional, s.worker?.config.limits.maxPositionNotional ?? Infinity);
    c.add('position_notional', 'Position size', resulting <= posCap, `${Number.isFinite(resulting) ? money(resulting) : 'n/a'} (max ${money(posCap)})`);

    if (isCfd) {
      // Margin: what the broker will lock up, with a 10% buffer for price movement.
      const rate = cfd?.marginRate ?? null;
      const avail = cfd?.marginAvailable ?? null;
      const needMargin = notional === null || rate === null ? null : notional * rate * 1.1;
      c.add(
        'margin',
        'Margin',
        needMargin !== null && avail !== null && needMargin <= avail,
        avail === null ? 'margin available unknown' : needMargin === null ? 'margin requirement unknown' : `need ~${money(needMargin)} of ${money(avail)} available`,
      );
      const stop = o.protectiveStop ?? null;
      if (stop !== null && price !== null && mult !== null) {
        const atStop = o.qty * Math.abs(price - stop) * mult;
        c.add('risk_per_trade', 'Risk at stop', atStop <= L.maxRiskPerTrade, `${money(atStop)} if the stop is hit (max ${money(L.maxRiskPerTrade)})`);
      } else if (stop !== null) {
        c.add('risk_per_trade', 'Risk at stop', false, 'cannot value the stop distance (no price or conversion rate)');
      }
    } else if (isOption) {
      const held = existing?.qty ?? 0;
      const cap = Math.min(L.maxContracts, s.worker?.config.limits.maxContracts ?? Infinity);
      c.add('max_contracts', 'Contracts', held + o.qty <= cap, `${held + o.qty} (max ${cap})`);
    } else {
      const held = existing?.qty ?? 0;
      const cap = Math.min(L.maxShares, s.worker?.config.limits.maxShares ?? Infinity);
      c.add('max_shares', 'Shares', held + o.qty <= cap, `${held + o.qty} (max ${cap})`);
    }

    if (!isCfd) {
      // Buying power (with a 2% buffer for price movement between check and fill)
      const bp = isOption ? (s.account?.optionsBuyingPower ?? s.account?.buyingPower ?? null) : (s.account?.buyingPower ?? null);
      const need = notional === null ? null : notional * 1.02;
      c.add('buying_power', 'Buying power', bp !== null && need !== null && need <= bp, bp === null ? 'buying power unavailable' : `need ${need === null ? 'n/a' : money(need)} of ${money(bp)}`);
    }

    // Concurrent positions: broker positions plus entries still in flight on new symbols
    const held = new Set(s.brokerPositions.map((p) => p.symbol));
    const pending = new Set(
      s.openOrders.filter((x) => isOpening(x.purpose) && !held.has(x.symbol)).map((x) => x.symbol),
    );
    const count = held.size + pending.size;
    const addsPosition = !held.has(o.symbol) && !pending.has(o.symbol);
    c.add('max_positions', 'Open positions', !addsPosition || count < L.maxConcurrentPositions, `${count}/${L.maxConcurrentPositions}`);

    c.add('max_trades', 'Trades today', s.entriesToday < L.maxTradesPerDay, `${s.entriesToday}/${L.maxTradesPerDay}`);

    const dp = s.accountDayPnl;
    c.add('daily_loss', 'Daily loss limit', dp !== null && dp > -L.maxDailyLoss, dp === null ? 'day P&L unavailable' : `${money(dp)} (limit ${money(-L.maxDailyLoss)})`);

    // The pattern-day-trader rule applies to US securities margin accounts, not to FX/CFDs.
    if (L.pdtGuard && s.account && !isCfd) {
      const a = s.account;
      const margin = (a.multiplier ?? 1) > 1;
      const under = a.equity !== null && a.equity < 25_000;
      const atRisk = margin && under && (a.daytradeCount ?? 0) >= 3;
      c.add('pdt', 'Pattern day trader', !atRisk, atRisk ? `${a.daytradeCount} day trades in 5 days with equity < $25k — another round trip would violate PDT` : 'ok');
    }

    // Duplicate protection
    const sameSymbolOrder = s.openOrders.find((x) => x.symbol === o.symbol);
    c.add('duplicate_order', 'No duplicate order', !sameSymbolOrder, sameSymbolOrder ? `order ${sameSymbolOrder.clientOrderId} already working on ${o.symbol}` : 'none working');

    const owner = s.ledgerPositions.find((p) => p.symbol === o.symbol && p.qty !== 0);
    if (o.purpose === 'ENTRY') {
      const workerOrder = s.openOrders.find((x) => x.workerId === o.workerId);
      c.add('worker_order', 'Worker idle', !workerOrder, workerOrder ? `worker already has order ${workerOrder.clientOrderId}` : 'no working order');
      const workerPos = s.ledgerPositions.find((p) => p.workerId === o.workerId && p.qty !== 0);
      const brokerHas = s.brokerPositions.some((p) => p.symbol === o.symbol);
      const ok = !workerPos && !owner && !brokerHas;
      c.add(
        'duplicate_position',
        'No duplicate position',
        ok,
        workerPos ? `worker already holds ${workerPos.symbol}` : owner ? `${o.symbol} already held` : brokerHas ? `broker already shows a ${o.symbol} position` : 'flat',
      );
    } else if (owner?.workerId) {
      c.add('duplicate_position', 'No worker conflict', false, `${o.symbol} is held by worker ${owner.workerId}`);
    }

    if (s.worker) {
      const W = s.worker.config.limits;
      c.add('worker_trades', 'Worker trades', s.workerEntriesToday < W.maxTradesPerDay, `${s.workerEntriesToday}/${W.maxTradesPerDay}`);
      const wp = s.worker.dayPnl;
      c.add('worker_loss', 'Worker loss limit', wp !== null && wp > -W.dailyLossLimit, wp === null ? 'n/a' : `${money(wp)} (limit ${money(-W.dailyLossLimit)})`);
      if (o.purpose === 'ENTRY') {
        c.add('worker_goal', 'Worker goal', s.worker.realizedToday < W.dailyGoal, `${money(s.worker.realizedToday)} of ${money(W.dailyGoal)} goal`);
      }
    }
  } else {
    // ── Closing rules: may only reduce an existing broker position ─────
    const pos = s.brokerPositions.find((p) => p.symbol === o.symbol);
    const reduces = pos !== undefined && ((pos.side === 'long' && o.side === 'sell') || (pos.side === 'short' && o.side === 'buy'));
    c.add('reduces_position', 'Reduces position', reduces, pos ? `${pos.side} ${formatQty(pos.qty)}` : `no ${o.symbol} position at broker`);
    const available = pos ? (pos.qtyAvailable ?? pos.qty) : 0;
    c.add('close_qty', 'Close quantity', pos !== undefined && o.qty <= available + 1e-9, `${formatQty(o.qty)} of ${formatQty(available)} available`);
    const otherClose = s.openOrders.find((x) => x.symbol === o.symbol && !isOpening(x.purpose));
    c.add('duplicate_close', 'No duplicate close', !otherClose, otherClose ? `close order ${otherClose.clientOrderId} already working` : 'none working');
  }

  const failed = c.list.find((x) => !x.passed) ?? null;
  return { approved: failed === null, checks: c.list, blockedBy: failed, evaluatedAt: s.now };
}
