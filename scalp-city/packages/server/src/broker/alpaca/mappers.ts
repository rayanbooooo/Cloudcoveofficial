import { DateTime } from 'luxon';
import type { AssetClass, OrderSide, PositionIntent, TimeInForce } from '@scalp-city/shared';
import type {
  BrokerAccount,
  BrokerAsset,
  BrokerCalendarDay,
  BrokerOptionContract,
  BrokerOrder,
  BrokerPosition,
  BrokerTradeUpdate,
} from '../types.js';
import { num, ts } from './AlpacaHttp.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = Record<string, any>;

const NY = 'America/New_York';

function bool(v: unknown): boolean | null {
  if (v === true || v === false) return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function assetClass(v: unknown): AssetClass {
  return v === 'us_option' ? 'us_option' : 'us_equity';
}

export function mapAccount(r: Raw): BrokerAccount {
  return {
    id: String(r.id),
    accountNumber: String(r.account_number ?? ''),
    status: String(r.status ?? 'UNKNOWN'),
    currency: str(r.currency),
    equity: num(r.equity),
    lastEquity: num(r.last_equity),
    cash: num(r.cash),
    buyingPower: num(r.buying_power),
    regtBuyingPower: num(r.regt_buying_power),
    daytradingBuyingPower: num(r.daytrading_buying_power),
    nonMarginableBuyingPower: num(r.non_marginable_buying_power),
    optionsBuyingPower: num(r.options_buying_power),
    portfolioValue: num(r.portfolio_value),
    longMarketValue: num(r.long_market_value),
    shortMarketValue: num(r.short_market_value),
    initialMargin: num(r.initial_margin),
    maintenanceMargin: num(r.maintenance_margin),
    multiplier: num(r.multiplier),
    patternDayTrader: bool(r.pattern_day_trader),
    tradingBlocked: bool(r.trading_blocked),
    accountBlocked: bool(r.account_blocked),
    tradeSuspendedByUser: bool(r.trade_suspended_by_user),
    shortingEnabled: bool(r.shorting_enabled),
    daytradeCount: num(r.daytrade_count),
    optionsApprovedLevel: num(r.options_approved_level),
    optionsTradingLevel: num(r.options_trading_level),
  };
}

export function mapPosition(r: Raw): BrokerPosition {
  const qty = num(r.qty) ?? 0;
  const side = r.side === 'short' || qty < 0 ? 'short' : 'long';
  return {
    symbol: String(r.symbol),
    assetId: str(r.asset_id),
    assetClass: assetClass(r.asset_class),
    side,
    qty: Math.abs(qty),
    qtyAvailable: num(r.qty_available) === null ? null : Math.abs(num(r.qty_available)!),
    avgEntryPrice: num(r.avg_entry_price) ?? 0,
    costBasis: num(r.cost_basis),
    marketValue: num(r.market_value),
    currentPrice: num(r.current_price),
    lastdayPrice: num(r.lastday_price),
    changeToday: num(r.change_today),
    unrealizedPl: num(r.unrealized_pl),
    unrealizedPlpc: num(r.unrealized_plpc),
    unrealizedIntradayPl: num(r.unrealized_intraday_pl),
    unrealizedIntradayPlpc: num(r.unrealized_intraday_plpc),
  };
}

export function mapOrder(r: Raw): BrokerOrder {
  const type = (r.type ?? r.order_type ?? 'market') as BrokerOrder['type'];
  return {
    id: String(r.id),
    clientOrderId: String(r.client_order_id ?? ''),
    symbol: String(r.symbol ?? ''),
    assetClass: assetClass(r.asset_class),
    side: (r.side === 'sell' ? 'sell' : 'buy') as OrderSide,
    type,
    timeInForce: (r.time_in_force ?? 'day') as TimeInForce,
    qty: num(r.qty),
    filledQty: num(r.filled_qty) ?? 0,
    filledAvgPrice: num(r.filled_avg_price),
    limitPrice: num(r.limit_price),
    stopPrice: num(r.stop_price),
    status: String(r.status ?? 'unknown'),
    positionIntent: (str(r.position_intent) as PositionIntent | null) ?? null,
    createdAt: ts(r.created_at),
    updatedAt: ts(r.updated_at),
    submittedAt: ts(r.submitted_at),
    filledAt: ts(r.filled_at),
    canceledAt: ts(r.canceled_at),
    expiredAt: ts(r.expired_at),
    failedAt: ts(r.failed_at),
    extendedHours: r.extended_hours === true,
  };
}

export function mapTradeUpdate(data: Raw): BrokerTradeUpdate {
  return {
    event: String(data.event),
    executionId: str(data.execution_id),
    order: mapOrder(data.order ?? {}),
    timestamp: ts(data.timestamp) ?? ts(data.order?.updated_at) ?? Date.now(),
    positionQty: num(data.position_qty),
    price: num(data.price),
    qty: num(data.qty),
  };
}

export function mapAsset(r: Raw): BrokerAsset {
  return {
    id: String(r.id),
    symbol: String(r.symbol),
    assetClass: String(r.class ?? r.asset_class ?? 'us_equity'),
    exchange: String(r.exchange ?? ''),
    status: String(r.status ?? ''),
    tradable: r.tradable === true,
    marginable: r.marginable === true,
    shortable: r.shortable === true,
    easyToBorrow: r.easy_to_borrow === true,
    fractionable: r.fractionable === true,
  };
}

export function mapOptionContract(r: Raw): BrokerOptionContract {
  return {
    id: String(r.id),
    symbol: String(r.symbol),
    name: String(r.name ?? r.symbol),
    status: String(r.status ?? ''),
    tradable: r.tradable === true,
    expirationDate: String(r.expiration_date),
    rootSymbol: String(r.root_symbol ?? ''),
    underlyingSymbol: String(r.underlying_symbol ?? ''),
    type: r.type === 'put' ? 'put' : 'call',
    style: String(r.style ?? ''),
    strikePrice: num(r.strike_price) ?? NaN,
    size: num(r.size) ?? 100,
    openInterest: num(r.open_interest),
    openInterestDate: str(r.open_interest_date),
    closePrice: num(r.close_price),
  };
}

/** "09:30" | "0930" | ISO datetime → ms, interpreted in New York time on `date`. */
export function nyTimeToMs(date: string, time: string): number {
  if (time.includes('T')) {
    const iso = DateTime.fromISO(time, { zone: NY });
    if (iso.isValid) return iso.toMillis();
  }
  const m = /^(\d{1,2}):?(\d{2})/.exec(time);
  if (!m) throw new Error(`unrecognized calendar time "${time}"`);
  const dt = DateTime.fromISO(date, { zone: NY }).set({ hour: Number(m[1]), minute: Number(m[2]), second: 0, millisecond: 0 });
  if (!dt.isValid) throw new Error(`invalid calendar date "${date}"`);
  return dt.toMillis();
}

export function mapCalendarDay(r: Raw): BrokerCalendarDay {
  const date = String(r.date);
  const day: BrokerCalendarDay = { date, openMs: nyTimeToMs(date, String(r.open)), closeMs: nyTimeToMs(date, String(r.close)) };
  // Alpaca's calendar also gives the extended-hours session ("0400" to "2000"; earlier on half days).
  if (typeof r.session_open === 'string' && typeof r.session_close === 'string') {
    try {
      day.extOpenMs = nyTimeToMs(date, r.session_open);
      day.extCloseMs = nyTimeToMs(date, r.session_close);
    } catch {
      delete day.extOpenMs;
      delete day.extCloseMs;
    }
  }
  return day;
}
