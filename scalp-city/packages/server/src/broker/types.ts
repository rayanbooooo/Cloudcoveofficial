import type {
  AssetClass,
  ConnectionState,
  OrderSide,
  OrderType,
  PositionIntent,
  TimeInForce,
  TradingEnvironment,
} from '@scalp-city/shared';

/**
 * Broker-neutral shapes. Adapters translate their wire formats into these;
 * the rest of the server never sees a broker-specific payload.
 * Monetary values the broker did not report are `null`, never 0.
 */

export interface BrokerAccount {
  id: string;
  accountNumber: string;
  status: string;
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
  patternDayTrader: boolean | null;
  tradingBlocked: boolean | null;
  accountBlocked: boolean | null;
  tradeSuspendedByUser: boolean | null;
  shortingEnabled: boolean | null;
  daytradeCount: number | null;
  optionsApprovedLevel: number | null;
  optionsTradingLevel: number | null;
}

export interface BrokerPosition {
  symbol: string;
  assetId: string | null;
  assetClass: AssetClass;
  side: 'long' | 'short';
  /** Absolute quantity. */
  qty: number;
  qtyAvailable: number | null;
  avgEntryPrice: number;
  costBasis: number | null;
  marketValue: number | null;
  currentPrice: number | null;
  lastdayPrice: number | null;
  changeToday: number | null;
  unrealizedPl: number | null;
  unrealizedPlpc: number | null;
  unrealizedIntradayPl: number | null;
  unrealizedIntradayPlpc: number | null;
}

export interface BrokerOrder {
  id: string;
  clientOrderId: string;
  symbol: string;
  assetClass: AssetClass;
  side: OrderSide;
  type: OrderType | 'trailing_stop';
  timeInForce: TimeInForce;
  qty: number | null;
  filledQty: number;
  filledAvgPrice: number | null;
  limitPrice: number | null;
  stopPrice: number | null;
  /** Raw broker status string (e.g. "new", "partially_filled"). */
  status: string;
  positionIntent: PositionIntent | null;
  createdAt: number | null;
  updatedAt: number | null;
  submittedAt: number | null;
  filledAt: number | null;
  canceledAt: number | null;
  expiredAt: number | null;
  failedAt: number | null;
  extendedHours: boolean;
}

/** One message from the broker's order/trade update stream. */
export interface BrokerTradeUpdate {
  event: string;
  executionId: string | null;
  order: BrokerOrder;
  /** Event time (ms). */
  timestamp: number;
  positionQty: number | null;
  /** Execution price of this fill (fill/partial_fill only). */
  price: number | null;
  /** Execution quantity of this fill (fill/partial_fill only). */
  qty: number | null;
}

export interface BrokerAsset {
  id: string;
  symbol: string;
  assetClass: AssetClass | string;
  exchange: string;
  status: string;
  tradable: boolean;
  marginable: boolean;
  shortable: boolean;
  easyToBorrow: boolean;
  fractionable: boolean;
}

export interface BrokerClock {
  /** Broker's clock (ms). */
  timestamp: number;
  isOpen: boolean;
  nextOpen: number;
  nextClose: number;
  /** Local time the response arrived and the request round-trip, for skew estimation. */
  receivedAt: number;
  rttMs: number;
}

export interface BrokerCalendarDay {
  /** YYYY-MM-DD (New York). */
  date: string;
  /** Regular session open/close (ms). */
  openMs: number;
  closeMs: number;
}

export interface BrokerOptionContract {
  id: string;
  symbol: string;
  name: string;
  status: string;
  tradable: boolean;
  /** YYYY-MM-DD */
  expirationDate: string;
  rootSymbol: string;
  underlyingSymbol: string;
  type: 'call' | 'put';
  style: string;
  strikePrice: number;
  /** Contract multiplier (normally 100). */
  size: number;
  openInterest: number | null;
  openInterestDate: string | null;
  closePrice: number | null;
}

export interface OptionContractQuery {
  underlying: string;
  type?: 'call' | 'put';
  expirationDate?: string;
  expirationDateGte?: string;
  expirationDateLte?: string;
  strikeGte?: number;
  strikeLte?: number;
  limit?: number;
}

export interface SubmitOrderParams {
  clientOrderId: string;
  symbol: string;
  qty: number;
  side: OrderSide;
  type: OrderType;
  timeInForce: TimeInForce;
  limitPrice?: number | null;
  stopPrice?: number | null;
  positionIntent?: PositionIntent | null;
}

export interface StreamStatus {
  state: ConnectionState;
  since: number;
  lastMessageAt: number | null;
  reconnectAttempts: number;
  lastError: string | null;
}

export type BrokerErrorKind =
  /** The broker definitively refused the request (4xx with a reason). */
  | 'REJECTED'
  | 'AUTH'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'SERVER'
  | 'NETWORK'
  | 'TIMEOUT';

export class BrokerError extends Error {
  readonly kind: BrokerErrorKind;
  readonly status: number | null;
  readonly code: number | null;
  readonly body: unknown;

  constructor(kind: BrokerErrorKind, message: string, opts: { status?: number | null; code?: number | null; body?: unknown } = {}) {
    super(message);
    this.name = 'BrokerError';
    this.kind = kind;
    this.status = opts.status ?? null;
    this.code = opts.code ?? null;
    this.body = opts.body;
  }

  /**
   * For a non-idempotent request (order submission): could the request have
   * taken effect at the broker even though we got no clean answer? If so the
   * order must be RESOLVED by client order id — never blindly retried.
   */
  get ambiguous(): boolean {
    return this.kind === 'NETWORK' || this.kind === 'TIMEOUT' || this.kind === 'SERVER' || this.kind === 'RATE_LIMITED';
  }
}

export type Unsubscribe = () => void;

/** Broker abstraction (spec §70). Everything else is broker-independent. */
export interface BrokerAdapter {
  readonly name: 'ALPACA';
  readonly env: TradingEnvironment;
  readonly endpoint: string;

  getAccount(): Promise<BrokerAccount>;
  getPositions(): Promise<BrokerPosition[]>;
  getOrders(params: { status: 'open' | 'closed' | 'all'; after?: number; limit?: number }): Promise<BrokerOrder[]>;
  getOrder(brokerOrderId: string): Promise<BrokerOrder>;
  /** Returns null when the broker has no order with that client id. */
  getOrderByClientId(clientOrderId: string): Promise<BrokerOrder | null>;
  getAsset(symbol: string): Promise<BrokerAsset>;
  getAssets(params: { assetClass?: AssetClass; status?: 'active' | 'inactive' }): Promise<BrokerAsset[]>;
  submitOrder(params: SubmitOrderParams): Promise<BrokerOrder>;
  cancelOrder(brokerOrderId: string): Promise<void>;
  cancelAllOrders(): Promise<{ id: string; status: number }[]>;
  getOptionContracts(query: OptionContractQuery): Promise<BrokerOptionContract[]>;
  /** A single contract by OCC symbol; null if the broker does not list it. */
  getOptionContract(symbol: string): Promise<BrokerOptionContract | null>;
  getClock(): Promise<BrokerClock>;
  getCalendar(startDate: string, endDate: string): Promise<BrokerCalendarDay[]>;

  /** Start the order/trade update stream and deliver every update to `handler`. */
  subscribeTradeUpdates(handler: (update: BrokerTradeUpdate) => void): Unsubscribe;
  onTradeStreamStatus(handler: (status: StreamStatus) => void): Unsubscribe;
  tradeStreamStatus(): StreamStatus;
  close(): Promise<void>;
}
