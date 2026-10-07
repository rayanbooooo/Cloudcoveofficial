import type {
  AssetClass,
  BrokerName,
  BrokerStatus,
  ConnectionState,
  DirectionOrNeutral,
  HealthStatus,
  Instrument,
  OptionsFeed,
  OrderPurpose,
  OrderSide,
  OrderSource,
  OrderState,
  OrderType,
  PositionIntent,
  RejectedBy,
  SessionPolicy,
  Severity,
  SignalPhase,
  StockFeed,
  SystemPhase,
  Timeframe,
  TimeInForce,
  TowerState,
  TradingEnvironment,
  Venue,
} from './domain.js';
import type { OptionQuoteView, SymbolQuoteView } from './marketdata.js';
import type { ConditionResult, StrategyParams } from './signal.js';

/**
 * Data-transfer shapes pushed from the server to the browser.
 *
 * Convention: any value that originates from the broker or the market data
 * feed is `number | null`. `null` means "not available" and the UI renders
 * UNAVAILABLE — it is never replaced by a computed or placeholder number.
 */

export interface AccountView {
  available: boolean;
  broker: BrokerName;
  venue: Venue;
  env: TradingEnvironment;
  accountNumberMasked: string | null;
  status: string | null;
  currency: string | null;
  equity: number | null;
  lastEquity: number | null;
  cash: number | null;
  buyingPower: number | null;
  regtBuyingPower: number | null;
  daytradingBuyingPower: number | null;
  nonMarginableBuyingPower: number | null;
  optionsBuyingPower: number | null;
  portfolioValue: number | null;
  longMarketValue: number | null;
  shortMarketValue: number | null;
  initialMargin: number | null;
  maintenanceMargin: number | null;
  multiplier: number | null;
  /**
   * Day P&L. Alpaca: equity − last_equity, both broker-reported. OANDA has
   * no "last equity": it is rebuilt from the broker's own transactions since
   * 00:00 New York (see dayPnlNote).
   */
  dayPnl: number | null;
  dayPnlPct: number | null;
  /** How dayPnl was derived, when it is not a single broker field. */
  dayPnlNote: string | null;
  /** Margin in use / available (margin accounts, OANDA). */
  marginUsed: number | null;
  marginAvailable: number | null;
  /** OANDA margin closeout percentage (100% = closeout). */
  marginCloseoutPct: number | null;
  /** Σ unrealized_pl over broker positions. */
  unrealizedPnl: number | null;
  /** Σ unrealized_intraday_pl over broker positions. */
  unrealizedIntradayPnl: number | null;
  /**
   * Realized today, derived as dayPnl − Σ unrealized_intraday_pl. Labeled
   * "derived" in the UI: deposits, fees and dividends land in it too.
   */
  realizedPnlDerived: number | null;
  patternDayTrader: boolean | null;
  daytradeCount: number | null;
  tradingBlocked: boolean | null;
  accountBlocked: boolean | null;
  tradeSuspendedByUser: boolean | null;
  shortingEnabled: boolean | null;
  optionsApprovedLevel: number | null;
  optionsTradingLevel: number | null;
  /** When the broker values were fetched (server ms). */
  updatedAt: number | null;
}

export interface OptionContractInfo {
  underlying: string;
  expiration: string;
  type: 'call' | 'put';
  strike: number;
}

export interface PositionView {
  symbol: string;
  assetClass: AssetClass;
  side: 'long' | 'short';
  qty: number;
  qtyAvailable: number | null;
  avgEntryPrice: number;
  costBasis: number | null;
  marketValue: number | null;
  /** Broker's current_price at the last poll. */
  brokerPrice: number | null;
  /** Live mark from the market data stream when fresh, else null. */
  markPrice: number | null;
  markSource: 'quote_mid' | 'last_trade' | 'broker' | null;
  unrealizedPnl: number | null;
  unrealizedPnlPct: number | null;
  unrealizedIntradayPnl: number | null;
  /** Realized today on this symbol from Scalp City's own fills. */
  realizedPnlToday: number | null;
  multiplier: number;
  option: OptionContractInfo | null;
  /** Worker that owns this position, or null if not opened by a worker. */
  workerId: string | null;
  /** Held at the broker but not opened through Scalp City (adopted, never traded by workers). False for manual orders placed in the app. */
  external: boolean;
  brokerUpdatedAt: number;
}

export interface RiskCheckView {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface RiskDecisionView {
  approved: boolean;
  checks: RiskCheckView[];
  /** First failing check, for one-line display. */
  blockedBy: RiskCheckView | null;
  evaluatedAt: number;
}

export interface OrderView {
  id: string;
  clientOrderId: string;
  brokerOrderId: string | null;
  env: TradingEnvironment;
  workerId: string | null;
  source: OrderSource;
  purpose: OrderPurpose;
  signalId: string | null;
  symbol: string;
  underlying: string | null;
  assetClass: AssetClass;
  side: OrderSide;
  positionIntent: PositionIntent | null;
  type: OrderType;
  timeInForce: TimeInForce;
  qty: number;
  limitPrice: number | null;
  stopPrice: number | null;
  state: OrderState;
  brokerStatus: string | null;
  filledQty: number;
  filledAvgPrice: number | null;
  rejectedBy: RejectedBy | null;
  rejectReason: string | null;
  errorMessage: string | null;
  createdAt: number;
  submittedAt: number | null;
  updatedAt: number;
  filledAt: number | null;
  risk: RiskDecisionView | null;
  cancelable: boolean;
}

export interface SignalView {
  signalId: string | null;
  direction: DirectionOrNeutral;
  phase: SignalPhase;
  /** Confirmed charge from the last closed bar. */
  charge: number;
  callCharge: number;
  putCharge: number;
  conditions: ConditionResult[];
  barTime: number | null;
  /** Live preview including the forming bar — display only, never traded on. */
  live: {
    direction: DirectionOrNeutral;
    charge: number;
    conditions: ConditionResult[];
    asOf: number;
  } | null;
  /** When the forming bar closes and the next confirmed evaluation runs. */
  nextEvaluationAt: number | null;
  /** Whether this setup id has already produced an order. */
  consumed: boolean;
  lastRisk: RiskDecisionView | null;
}

export interface WorkerLimits {
  maxTradesPerDay: number;
  /**
   * CFD workers: how much the worker is willing to lose if its stop is hit,
   * in account currency. Position size = riskPerTrade ÷ stop distance.
   */
  riskPerTrade: number;
  maxContracts: number;
  maxShares: number;
  maxPositionNotional: number;
  /** Positive number: the worker halts when its day P&L ≤ −dailyLossLimit. */
  dailyLossLimit: number;
  /** Positive number: the worker stands down when its realized day P&L ≥ dailyGoal. */
  dailyGoal: number;
}

export interface ExitRules {
  /** Options/shares: take profit at this % gain on the position. */
  takeProfitPct: number;
  /** Options/shares: stop out at this % loss on the position. */
  stopLossPct: number;
  /** CFD workers: stop distance in multiples of the 1-bar ATR at entry (also placed at the broker). */
  stopAtr: number;
  /** CFD workers: profit target distance in multiples of the 1-bar ATR at entry. */
  targetAtr: number;
  /** Exit a CALL when price closes below VWAP (PUT: above). */
  exitOnVwapLoss: boolean;
  maxHoldMinutes: number;
  /** Close positions this many minutes before the session close. */
  flattenBeforeCloseMinutes: number;
  /** Bars to wait after an exit before a new entry. */
  cooldownBars: number;
}

export interface OptionSelectionPrefs {
  /** 0 = same-day expiry if listed; otherwise nearest expiry with ≥ minDte days. */
  minDte: number;
  maxDte: number;
  /** Strikes away from ATM: 0 = ATM, 1 = one strike OTM, −1 = one strike ITM. */
  strikeOffset: number;
  maxSpreadPct: number;
  maxSpreadAbs: number;
  minVolume: number;
  minOpenInterest: number;
  minBidSize: number;
}

export interface WorkerConfigView {
  id: string;
  name: string;
  symbol: string;
  strategyName: string;
  timeframe: Timeframe;
  instrument: Instrument;
  allowShort: boolean;
  /** Entry limit price = ask × (1 + slippage) (buy) — caps what we pay. */
  entrySlippagePct: number;
  entryTimeoutSec: number;
  params: StrategyParams;
  limits: WorkerLimits;
  exits: ExitRules;
  options: OptionSelectionPrefs;
}

export interface WorkerStats {
  realizedToday: number;
  unrealized: number | null;
  pnlToday: number | null;
  tradesToday: number;
  winsToday: number;
  lossesToday: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  profitFactor: number | null;
  maxDrawdown: number;
  realizedAllTime: number;
  tradesAllTime: number;
}

export interface WorkerPositionView {
  symbol: string;
  assetClass: AssetClass;
  direction: DirectionOrNeutral;
  qty: number;
  avgEntryPrice: number;
  markPrice: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPct: number | null;
  openedAt: number;
  tradeId: string;
  option: OptionContractInfo | null;
  /**
   * Stop and target of a CFD or share position, and the loss if the stop is hit. `stopSource` says who
   * holds the stop: the broker (OANDA, protects the position even if this server is down) or this
   * server (shares: only protects while the server is running).
   */
  stopPrice: number | null;
  stopSource: 'broker' | 'server' | null;
  targetPrice: number | null;
  riskAtStop: number | null;
}

/** Live instrument facts for a CFD worker (OANDA); null for options/shares workers. */
export interface WorkerMarketView {
  displayName: string;
  /** Broker says the instrument can be traded right now (null = unknown). */
  tradeable: boolean | null;
  /** Instrument listed for this account at the broker. */
  listed: boolean;
  unitsPrecision: number | null;
  minUnits: number | null;
  displayPrecision: number | null;
  marginRate: number | null;
  /** Account-currency value of a 1.0 price move on one unit (quote → home conversion). */
  homeFactor: number | null;
  /** Account-currency notional of the minimum size at the current price. */
  minNotional: number | null;
  currency: string | null;
  /** Stop / target distances the next entry would use, from the live ATR (price units). */
  plannedStop: number | null;
  plannedTarget: number | null;
  /** Units the next entry would use at the live price, after every limit (null = can't size). */
  plannedUnits: number | null;
  /** Why the next entry can't be sized, if it can't. */
  sizingNote: string | null;
}

export interface WorkerView {
  config: WorkerConfigView;
  market: WorkerMarketView | null;
  /** Worker autotrading switch (runtime only — always OFF after a restart). */
  autotradeEnabled: boolean;
  towerState: TowerState;
  statusText: string;
  haltReason: string | null;
  signal: SignalView;
  position: WorkerPositionView | null;
  activeOrderId: string | null;
  stats: WorkerStats;
  /** Warning shown when the worker holds a position it is not currently managing. */
  unmanagedWarning: string | null;
  lastEvaluatedAt: number | null;
}

export interface RiskLimits {
  maxDailyLoss: number;
  maxPositionNotional: number;
  maxOrderNotional: number;
  maxContracts: number;
  maxShares: number;
  maxConcurrentPositions: number;
  maxTradesPerDay: number;
  maxOrdersPerMinute: number;
  /** Max deviation of a limit price from the live quote (fat-finger guard). */
  maxPriceDeviationPct: number;
  /** No new entries this many minutes before the close. */
  noEntriesBeforeCloseMinutes: number;
  /** Block entries that would trip the pattern-day-trader rule. */
  pdtGuard: boolean;
  /**
   * CFD entries: the most an order may lose if its broker-side stop is hit,
   * in account currency (units × stop distance × conversion).
   */
  maxRiskPerTrade: number;
}

export interface RiskView {
  dailyPnl: number | null;
  maxDailyLoss: number;
  remainingRisk: number | null;
  openPositions: number;
  maxPositions: number;
  openOrders: number;
  tradesToday: number;
  maxTradesPerDay: number;
  buyingPower: number | null;
  optionsBuyingPower: number | null;
  /** Margin accounts (OANDA): margin still available for new positions. */
  marginAvailable: number | null;
  dataLatencyMs: number | null;
  brokerStatus: BrokerStatus;
  /** Whether new entries can be opened right now (all gates pass). */
  entriesAllowed: boolean;
  blockReasons: string[];
  dailyLossHalted: boolean;
  limits: RiskLimits;
}

export interface StreamStatusView {
  state: ConnectionState;
  since: number;
  lastMessageAt: number | null;
  reconnectAttempts: number;
  lastError: string | null;
}

export interface MarketDataStatusView {
  stock: StreamStatusView;
  options: StreamStatusView;
  stockFeed: StockFeed;
  /** e.g. "LIVE · IEX" / "LIVE · SIP" / "DELAYED 15m" */
  stockFeedLabel: string;
  stockRealtime: boolean;
  /** IEX carries a fraction of consolidated volume. */
  stockPartialVolume: boolean;
  optionsFeed: OptionsFeed;
  optionsFeedLabel: string;
  optionsRealtimeNbbo: boolean;
  /** Whether workers may trade options on the configured feed. */
  optionsAutotradeAllowed: boolean;
  optionsBlockReason: string | null;
  /** Volume is a count of price updates (OANDA), not traded size. */
  tickVolume: boolean;
  /** 'mid': prices are the midpoint of the broker's bid/ask (no exchange trades exist for OTC FX/CFDs). */
  priceBasis: 'trades' | 'mid';
  maxDataAgeMs: number;
  /** How old a quote may be outside the regular session, where trading is thinner. */
  offHoursMaxDataAgeMs: number;
  symbols: Record<string, { lastEventAt: number | null; ageMs: number | null; stale: boolean }>;
}

export interface MarketStatusView {
  /** Workers may trade right now: inside a session the deployment trades (see `sessions`). */
  isOpen: boolean;
  /** OPEN | CLOSED | PRE_MARKET | AFTER_HOURS | OVERNIGHT | HOLIDAY | UNKNOWN */
  label: 'OPEN' | 'CLOSED' | 'PRE_MARKET' | 'AFTER_HOURS' | 'OVERNIGHT' | 'HOLIDAY' | 'UNKNOWN';
  /** Which sessions this deployment trades. */
  sessions: SessionPolicy;
  sessionOpen: number | null;
  sessionClose: number | null;
  nextOpen: number | null;
  nextClose: number | null;
  earlyClose: boolean;
  /** When the broker clock was last fetched. */
  checkedAt: number | null;
}

export interface BreakerView {
  id: string;
  label: string;
  tripped: boolean;
  trippedAt: number | null;
  detail: string | null;
  /** Latched breakers need a manual reset. */
  latched: boolean;
}

export interface ReconciliationMismatch {
  symbol: string;
  local: number;
  broker: number;
  kind: 'QTY_MISMATCH' | 'UNEXPECTED_POSITION' | 'MISSING_POSITION' | 'UNEXPECTED_ORDER';
  detail: string;
}

export interface ReconciliationView {
  status: 'RECONCILED' | 'MISMATCH' | 'PENDING' | 'UNKNOWN';
  lastRunAt: number | null;
  mismatches: ReconciliationMismatch[];
  /** Positions in the account that no worker owns (adopted as external). */
  externalPositions: string[];
}

export interface HealthItemView {
  id: 'broker' | 'marketData' | 'database' | 'websocket' | 'riskEngine' | 'workers';
  label: string;
  status: HealthStatus;
  detail: string;
}

export interface HaltReason {
  code: string;
  message: string;
}

export interface FlattenStatusView {
  inProgress: boolean;
  startedAt: number;
  finishedAt: number | null;
  total: number;
  closed: number;
  messages: string[];
}

export interface SystemView {
  serverTime: number;
  env: TradingEnvironment;
  venue: Venue;
  /** Environments with credentials configured (switch targets). */
  availableEnvs: TradingEnvironment[];
  live: {
    /** LIVE_TRADING_ENABLED server lock. */
    serverLockOpen: boolean;
    armed: boolean;
    armedAt: number | null;
    armedBy: string | null;
  };
  endpoints: { trading: string; nonStandard: boolean };
  phase: SystemPhase;
  phaseDetail: string;
  controls: {
    autotrading: boolean;
    entriesPaused: boolean;
    killSwitch: { active: boolean; activatedAt: number | null; activatedBy: string | null; reason: string | null };
  };
  flatten: FlattenStatusView | null;
  trading: {
    /** New entries possible right now. */
    entriesAllowed: boolean;
    /** Workers allowed to submit any order right now. */
    autotradingActive: boolean;
    haltReasons: HaltReason[];
    /**
     * Markets with no fresh price while the market is open (a thin ETF on the free feed is often one). Their own
     * workers wait; the others trade. Only when every market is quiet is that a halt reason (DATA_STALE).
     */
    quietMarkets: string[];
  };
  broker: {
    name: BrokerName;
    status: BrokerStatus;
    lastOkAt: number | null;
    lastError: string | null;
    tradeStream: StreamStatusView;
    accountMasked: string | null;
  };
  marketData: MarketDataStatusView;
  market: MarketStatusView;
  clock: { brokerSkewMs: number | null; ok: boolean; checkedAt: number | null };
  breakers: BreakerView[];
  reconciliation: ReconciliationView;
  health: HealthItemView[];
}

export interface ReadinessItem {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface ReadinessView {
  env: TradingEnvironment;
  ready: boolean;
  items: ReadinessItem[];
  checkedAt: number;
}

export type TimelineKind = 'signal' | 'risk' | 'order' | 'fill' | 'exit' | 'pnl' | 'system' | 'alert' | 'control';

export interface TimelineEvent {
  id: string;
  ts: number;
  kind: TimelineKind;
  severity: Severity;
  workerId: string | null;
  symbol: string | null;
  title: string;
  detail: string | null;
}

export type AlertCode =
  | 'ORDER_FILLED'
  | 'ORDER_REJECTED'
  | 'POSITION_OPENED'
  | 'POSITION_CLOSED'
  | 'DAILY_LOSS_LIMIT'
  | 'KILL_SWITCH'
  | 'BROKER_DISCONNECTED'
  | 'MARKET_DATA_DISCONNECTED'
  | 'UNEXPECTED_POSITION'
  | 'RECONCILIATION'
  | 'CIRCUIT_BREAKER'
  | 'LIVE_MODE';

export interface AlertView {
  id: string;
  ts: number;
  code: AlertCode;
  severity: Severity;
  title: string;
  message: string;
}

/** Cinematic city events — emitted only after broker confirmation. */
export type CityEventKind = 'ORDER_SUBMITTED' | 'ORDER_FILLED' | 'PROFIT_LOCKED' | 'POSITION_CLOSED' | 'ORDER_REJECTED' | 'KILL_SWITCH';

export interface CityEvent {
  id: string;
  ts: number;
  kind: CityEventKind;
  workerId: string | null;
  symbol: string;
  direction: DirectionOrNeutral;
  qty: number;
  price: number | null;
  pnl: number | null;
  assetClass: AssetClass;
}

export interface JournalTradeView {
  id: string;
  env: TradingEnvironment;
  workerId: string | null;
  workerName: string | null;
  strategyName: string | null;
  symbol: string;
  underlying: string | null;
  assetClass: AssetClass;
  direction: DirectionOrNeutral;
  qty: number;
  entryAvgPrice: number | null;
  exitAvgPrice: number | null;
  realizedPnl: number | null;
  status: 'OPEN' | 'CLOSED';
  openedAt: number;
  closedAt: number | null;
  signalId: string | null;
  signalConditions: ConditionResult[] | null;
  signalCharge: number | null;
  entryOrderIds: string[];
  exitOrderIds: string[];
  exitReason: string | null;
  dailyPnlBefore: number | null;
  dailyPnlAfter: number | null;
  positionNotional: number | null;
  option: OptionContractInfo | null;
}

export interface Snapshot {
  system: SystemView;
  account: AccountView;
  positions: PositionView[];
  orders: OrderView[];
  workers: WorkerView[];
  quotes: Record<string, SymbolQuoteView>;
  optionQuotes: Record<string, OptionQuoteView>;
  risk: RiskView;
  timeline: TimelineEvent[];
  alerts: AlertView[];
}
