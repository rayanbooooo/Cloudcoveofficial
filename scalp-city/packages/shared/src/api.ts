import type { AssetClass, Instrument, OrderSide, OrderType, TradingEnvironment } from './domain.js';
import type { Bar } from './marketdata.js';
import type {
  ExitRules,
  OptionSelectionPrefs,
  RiskDecisionView,
  RiskLimits,
  WorkerLimits,
} from './views.js';

/** REST request/response payloads shared by server and client. */

export interface SessionInfo {
  authenticated: boolean;
  username: string | null;
  csrfToken: string | null;
}

export interface LoginRequest {
  username: string;
  password: string;
}

/** Manual order ticket. Goes through the same RiskEngine as workers. */
export interface ManualOrderRequest {
  symbol: string;
  assetClass: AssetClass;
  side: OrderSide;
  qty: number;
  type: OrderType;
  limitPrice?: number | null;
  stopPrice?: number | null;
  /** 'open' adds to/creates a position; 'close' reduces an existing one. */
  intent: 'open' | 'close';
  /** CFD opens: a protective stop placed at the broker together with the order. */
  stopLoss?: number | null;
}

export interface OrderPreview {
  request: ManualOrderRequest;
  env: TradingEnvironment;
  estimatedPrice: number | null;
  estimatedNotional: number | null;
  buyingPower: number | null;
  /** CFD: estimated margin the order needs, and the account's margin available. */
  estimatedMargin: number | null;
  marginAvailable: number | null;
  /** CFD opens with a stop: loss if the stop is hit (account currency). */
  riskAtStop: number | null;
  currency: string | null;
  /** Estimated notional as % of equity. */
  riskPct: number | null;
  risk: RiskDecisionView;
  /** Required for submission; binds the confirmation to this exact preview. */
  previewToken: string;
  expiresAt: number;
  warnings: string[];
}

export interface SubmitManualOrderRequest {
  previewToken: string;
  /** Must be true; the UI only sends it from the explicit confirmation step. */
  confirmed: boolean;
}

export interface EnableLiveRequest {
  /** Re-authentication (step-up) for the most dangerous action. */
  password: string;
  /** The masked account the user saw and confirmed, e.g. "••••4821". */
  confirmAccount: string;
  /** Both confirmation steps completed in the UI. */
  acknowledgeRealMoney: boolean;
  secondConfirmation: boolean;
}

export interface SwitchEnvironmentRequest {
  target: TradingEnvironment;
  password: string;
  confirmed: boolean;
}

export interface RiskLimitsUpdateRequest {
  limits: Partial<RiskLimits>;
  /** Required when any change increases risk. */
  confirmed?: boolean;
  /** Required (step-up) when increasing risk while LIVE. */
  password?: string;
}

export interface RiskLimitsChangePreview {
  increasesRisk: boolean;
  changes: { key: keyof RiskLimits; from: number | boolean; to: number | boolean; increasesRisk: boolean }[];
  requiresPassword: boolean;
}

/** The Aggressive preset: limits scaled to the account (paper only). Percentages are of account equity. */
export interface RiskPresetRequest {
  preset: 'aggressive';
  /** The largest position and order. Default 30. */
  positionPct?: number;
  /** The account-wide daily-loss stop. Default 5. */
  dailyLossPct?: number;
  /** Required to apply (not to preview). */
  confirmed?: boolean;
}

export interface RiskPresetPreview {
  preset: 'aggressive';
  equity: number;
  positionPct: number;
  dailyLossPct: number;
  /** The account-wide limits that would change. */
  account: RiskLimitsChangePreview;
  /** What changes on each share worker (the same set for each of them). */
  workers: { id: string; name: string; changes: { key: keyof WorkerLimits; from: number; to: number }[] }[];
  /** Plain-words consequences, shown before the person confirms. */
  notes: string[];
}

export interface WorkerUpdateRequest {
  limits?: Partial<WorkerLimits>;
  exits?: Partial<ExitRules>;
  options?: Partial<OptionSelectionPrefs>;
  instrument?: Instrument;
  allowShort?: boolean;
  confirmed?: boolean;
  password?: string;
}

export interface WorkerToggleRequest {
  enabled: boolean;
  /** Required when enabling (autonomous execution), per spec §101. */
  confirmed?: boolean;
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}

export interface ChartResponse {
  symbol: string;
  timeframe: string;
  bars: Bar[];
  vwap: (number | null)[];
  ema: (number | null)[];
  atr: (number | null)[];
  source: string;
  feedLabel: string;
}
