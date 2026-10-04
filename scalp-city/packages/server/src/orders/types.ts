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
} from '@scalp-city/shared';

export interface OrderMeta {
  /** Contract multiplier (100 for standard options, 1 for equities). */
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
}

/** Authoritative local record of an order intent and its broker lifecycle. */
export interface OrderRecord {
  id: string;
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
