import type {
  AssetClass,
  DirectionOrNeutral,
  OrderPurpose,
  OrderSide,
  OrderSource,
  OrderState,
  OrderType,
  PositionIntent,
  RejectedBy,
  RiskDecisionView,
  TimeInForce,
  TradingEnvironment,
  Venue,
} from '@scalp-city/shared';

export interface ExitPlan {
  /** Stop distance from the fill price (price units). */
  stopDistance: number;
  /** Profit target distance from the fill price (price units). */
  targetDistance: number;
  /** The ATR the distances came from. */
  atr: number;
}

export interface OrderMeta {
  /**
   * Account-currency value of a 1.0 price move on one unit: 100 for standard
   * options, 1 for equities, the quote→home conversion factor for CFDs.
   */
  multiplier: number;
  direction?: DirectionOrNeutral;
  /** Why an exit was requested (TAKE_PROFIT, STOP_LOSS, …). */
  exitReason?: string;
  requestedBy?: string;
  /** Snapshot of the signal at entry, for the trade journal. */
  signal?: { charge: number; conditions: unknown[] } | null;
  /** Account day P&L when the order was requested. */
  dailyPnlBefore?: number | null;
  /** Live quote used to price the order. */
  quote?: { bid: number | null; ask: number | null; at: number | null } | null;
  /** Times the outcome-resolution loop ran for this order. */
  resolutionAttempts?: number;
  /** Set when the broker refused a cancel request. */
  cancelError?: string | null;
  /** CFD entries: where the worker plans to take profit / stop out, relative to the fill. */
  exitPlan?: ExitPlan | null;
  /** CFD opens: stop loss placed at the broker together with this order. */
  protectiveStop?: { price: number } | null;
  /** Share entries: the stop this SERVER enforces (nothing is placed at the broker). */
  softStop?: { price: number } | null;
  /** Worst-case loss at the protective stop (account currency), as approved by risk. */
  riskAtStop?: number | null;
  /** PROTECTIVE_STOP orders: client order id of the entry they protect. */
  parentClientOrderId?: string | null;
  /** Broker's reason when it canceled the order (e.g. BOUNDS_VIOLATION, LINKED_TRADE_CLOSED). */
  cancelReason?: string | null;
}

/** Authoritative local record of an order intent and its broker lifecycle. */
export interface OrderRecord {
  id: string;
  venue: Venue;
  env: TradingEnvironment;
  clientOrderId: string;
  brokerOrderId: string | null;
  workerId: string | null;
  source: OrderSource;
  purpose: OrderPurpose;
  signalId: string | null;
  tradeId: string | null;
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
  risk: RiskDecisionView | null;
  meta: OrderMeta;
  createdAt: number;
  submittedAt: number | null;
  updatedAt: number;
  filledAt: number | null;
}

/** What callers ask the order engine for. */
export interface OrderRequest {
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
  meta: OrderMeta;
  /** Username or "system"/"worker:<id>". */
  actor: string;
}
