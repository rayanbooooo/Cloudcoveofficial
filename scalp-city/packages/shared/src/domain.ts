/**
 * Core domain vocabulary shared by the server and the browser.
 *
 * Nothing in this package talks to a broker or holds state; it only defines
 * the shapes and pure math both sides agree on.
 */

export type TradingEnvironment = 'paper' | 'live';

/**
 * Which brokerage this installation trades through. Alpaca: US stocks and
 * options. OANDA: spot FX, metals and index CFDs (gold, NAS100, GBP/USD …).
 * Every order, position and trade is stored under its venue, so switching
 * brokers never mixes one broker's records with the other's.
 */
export type Venue = 'alpaca' | 'oanda';
export type BrokerName = 'ALPACA' | 'OANDA';

export function brokerNameOf(venue: Venue): BrokerName {
  return venue === 'oanda' ? 'OANDA' : 'ALPACA';
}

/** Connection lifecycle for every long-lived stream. */
export type ConnectionState = 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED' | 'ERROR';

/** Broker connectivity as seen by the trading system (spec §34). */
export type BrokerStatus =
  | 'CONNECTED'
  | 'AUTHENTICATION_ERROR'
  | 'DISCONNECTED'
  | 'RATE_LIMITED'
  | 'ACCOUNT_RESTRICTED'
  | 'NOT_CONFIGURED'
  | 'UNKNOWN';

/** Order lifecycle (spec §13). FILLED is only ever set from a broker confirmation. */
export const ORDER_STATES = [
  'CREATED',
  'VALIDATING',
  'RISK_CHECK',
  'SUBMITTING',
  'SUBMITTED',
  'ACCEPTED',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCEL_PENDING',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
  'ERROR',
] as const;
export type OrderState = (typeof ORDER_STATES)[number];

export const TERMINAL_ORDER_STATES: ReadonlySet<OrderState> = new Set<OrderState>([
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
]);

/** States in which an order may still produce fills at the broker. */
export const LIVE_ORDER_STATES: ReadonlySet<OrderState> = new Set<OrderState>([
  'SUBMITTING',
  'SUBMITTED',
  'ACCEPTED',
  'PARTIALLY_FILLED',
  'CANCEL_PENDING',
]);

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit';
export type TimeInForce = 'day' | 'gtc' | 'ioc' | 'fok' | 'opg' | 'cls';
export type PositionIntent = 'buy_to_open' | 'buy_to_close' | 'sell_to_open' | 'sell_to_close';
/**
 * `cfd`: an OTC instrument traded in units on margin, long or short
 * (OANDA spot FX, metals and index CFDs). P&L is in the account currency.
 */
export type AssetClass = 'us_equity' | 'us_option' | 'cfd';

/** Order types the platform will present, per asset class. */
export const SUPPORTED_ORDER_TYPES: Record<AssetClass, readonly OrderType[]> = {
  us_equity: ['market', 'limit', 'stop', 'stop_limit'],
  us_option: ['market', 'limit', 'stop', 'stop_limit'],
  cfd: ['market', 'limit'],
};

/**
 * Why an order exists. Drives which risk rules apply. PROTECTIVE_STOP is a
 * broker-side stop loss attached to a filled entry (the entry passed risk with
 * it); it lives at the broker so a position stays protected even if this
 * server is down.
 */
export type OrderPurpose = 'ENTRY' | 'EXIT' | 'FLATTEN' | 'MANUAL_OPEN' | 'MANUAL_CLOSE' | 'PROTECTIVE_STOP';

export type OrderSource = 'WORKER' | 'MANUAL' | 'FLATTEN';

/** Who rejected an order: our own validation, our risk engine, or the broker. */
export type RejectedBy = 'VALIDATION' | 'RISK' | 'BROKER';

export type SignalDirection = 'CALL' | 'PUT';
export type DirectionOrNeutral = SignalDirection | 'NEUTRAL';

/** Setup lifecycle produced by the signal engine. */
export type SignalPhase = 'IDLE' | 'FORMING' | 'CHARGING' | 'READY' | 'FADED';

/** Visual + operational state of a worker tower (spec §41). */
export const TOWER_STATES = [
  'WATCHING',
  'SETUP_FORMING',
  'CHARGING',
  'READY',
  'ORDER_PENDING',
  'IN_TRADE',
  'PROFIT',
  'LOSS',
  'STANDING_DOWN',
  'HALTED',
] as const;
export type TowerState = (typeof TOWER_STATES)[number];

/** What a worker trades: option contracts, the shares themselves, or (OANDA) the CFD/FX instrument. */
export type Instrument = 'OPTIONS' | 'EQUITY' | 'CFD';

export const TIMEFRAMES = ['1Min', '5Min', '15Min'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export function timeframeMinutes(tf: Timeframe): number {
  switch (tf) {
    case '1Min':
      return 1;
    case '5Min':
      return 5;
    case '15Min':
      return 15;
  }
}

/** System recovery / readiness phases (spec §94). */
export type SystemPhase =
  | 'BOOTING'
  | 'RECOVERING'
  | 'ACCOUNT_SYNC'
  | 'POSITION_SYNC'
  | 'ORDER_SYNC'
  | 'MARKET_DATA_SYNC'
  | 'RISK_CHECK'
  | 'READY'
  | 'DEGRADED'
  | 'SWITCHING_ENVIRONMENT'
  | 'NOT_CONFIGURED';

export type HealthStatus = 'ok' | 'warn' | 'error' | 'off';

export type Severity = 'info' | 'success' | 'warn' | 'error';

/**
 * Primary price feed. Alpaca: stock feeds. `oanda`: OANDA's own streaming
 * bid/ask prices (no exchange trades exist for OTC FX/CFDs; volume is the
 * number of price updates, i.e. tick volume).
 */
export type StockFeed = 'iex' | 'sip' | 'delayed_sip' | 'oanda';
export type OptionsFeed = 'indicative' | 'opra';

/**
 * Mask an account number for display: "••••4821". Never show it in full.
 * OANDA account ids ("101-004-12345678-001") keep the sub-account suffix,
 * which is otherwise identical for most users: "••••5678-001".
 */
export function maskAccountNumber(accountNumber: string | null | undefined): string | null {
  if (!accountNumber) return null;
  const oanda = /^\d{3}-\d{3}-(\d+)-(\d{3})$/.exec(accountNumber);
  if (oanda) return `••••${oanda[1]!.slice(-4)}-${oanda[2]}`;
  const tail = accountNumber.slice(-4);
  return `••••${tail}`;
}
