import type { OrderSide, OrderType, PositionIntent, TimeInForce } from '@scalp-city/shared';
import type { BrokerInstrument, BrokerOrder } from '../types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Raw = Record<string, any>;

/**
 * Can this price be traded on? OANDA reports it as `tradeable` (boolean) and,
 * on newer API versions, as `status` ("tradeable" | "non-tradeable" | "invalid").
 * Only an explicit "no" counts as no: a price that says nothing is not treated
 * as a halted market (the broker would still refuse the order if it were).
 */
export function priceTradeable(p: Raw): boolean {
  if (p.tradeable === false) return false;
  return p.status !== 'non-tradeable' && p.status !== 'invalid';
}

/** OANDA sends every number as a decimal string. Missing or malformed → null, never 0. */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Sum of OANDA amounts where a missing field means "none charged" (fees, financing). */
export function amt(v: unknown): number {
  return num(v) ?? 0;
}

/**
 * OANDA timestamps: RFC3339 with nanoseconds ("2026-10-05T15:00:00.123456789Z")
 * or UNIX seconds with a fraction ("1791212400.123456789").
 */
export function oandaTime(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v);
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? Math.round(n * 1000) : null;
  }
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(s);
  if (!m) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  const base = Date.parse(`${m[1]}${m[3]}`);
  if (!Number.isFinite(base)) return null;
  const frac = m[2] ? Number(`0.${m[2]}`) : 0;
  return base + Math.floor(frac * 1000);
}

/** Price of a fill: unit-weighted over the trades it opened, closed or reduced. */
export function fillPrice(fill: Raw): number | null {
  const legs: Raw[] = [...(fill.tradeOpened ? [fill.tradeOpened] : []), ...(fill.tradesClosed ?? []), ...(fill.tradeReduced ? [fill.tradeReduced] : [])];
  let units = 0;
  let value = 0;
  for (const l of legs) {
    const u = Math.abs(num(l.units) ?? 0);
    const p = num(l.price);
    if (u > 0 && p !== null) {
      units += u;
      value += u * p;
    }
  }
  if (units > 0) return value / units;
  return num(fill.fullVWAP) ?? num(fill.price);
}

/** Realized P&L of a fill in account currency, net of financing, commission and fees. */
export function fillRealized(fill: Raw): number {
  return amt(fill.pl) + amt(fill.financing) - Math.abs(amt(fill.commission)) - Math.abs(amt(fill.guaranteedExecutionFee));
}

/** Cancel reasons that mean "the broker refused this order" rather than a routine cancel. */
const REFUSALS = new Set([
  'INSUFFICIENT_MARGIN',
  'MARKET_HALTED',
  'ACCOUNT_LOCKED',
  'ACCOUNT_NEW_POSITIONS_LOCKED',
  'ACCOUNT_ORDER_CREATION_LOCKED',
  'ACCOUNT_ORDER_FILL_LOCKED',
  'FIFO_VIOLATION',
  'POSITION_SIZE_EXCEEDED',
  'OPEN_TRADES_ALLOWED_EXCEEDED',
  'PENDING_ORDERS_ALLOWED_EXCEEDED',
  'INSTRUMENT_BID_HALTED',
  'INSTRUMENT_ASK_HALTED',
  'INSTRUMENT_BID_REDUCE_ONLY',
  'INSTRUMENT_ASK_REDUCE_ONLY',
  'ACCOUNT_POSITION_VALUE_LIMIT_EXCEEDED',
  'INTERNAL_SERVER_ERROR',
]);

/** Map an OANDA ORDER_CANCEL reason to the broker status our state machine understands. */
export function cancelStatus(reason: unknown): 'canceled' | 'expired' | 'rejected' {
  const r = String(reason ?? '');
  if (r === 'TIME_IN_FORCE_EXPIRED') return 'expired';
  if (REFUSALS.has(r) || r.startsWith('STOP_LOSS_ON_FILL') || r.startsWith('TAKE_PROFIT_ON_FILL')) return 'rejected';
  return 'canceled';
}

const DEPENDENT_TYPES = new Set(['STOP_LOSS', 'TAKE_PROFIT', 'TRAILING_STOP_LOSS', 'GUARANTEED_STOP_LOSS']);

export function isDependentOrderType(type: unknown): boolean {
  return DEPENDENT_TYPES.has(String(type));
}

function orderType(type: unknown): BrokerOrder['type'] {
  switch (String(type)) {
    case 'MARKET':
      return 'market';
    case 'LIMIT':
    case 'TAKE_PROFIT':
      return 'limit';
    case 'TRAILING_STOP_LOSS':
      return 'trailing_stop';
    default:
      return 'stop';
  }
}

function tif(v: unknown): TimeInForce {
  switch (String(v)) {
    case 'FOK':
      return 'fok';
    case 'IOC':
      return 'ioc';
    case 'GTC':
    case 'GTD':
      return 'gtc';
    default:
      return 'day';
  }
}

/** Status of an OANDA Order object (state PENDING | FILLED | TRIGGERED | CANCELLED). */
export function orderStatus(state: unknown): string {
  switch (String(state)) {
    case 'FILLED':
      return 'filled';
    case 'CANCELLED':
      return 'canceled';
    case 'TRIGGERED':
    case 'PENDING':
      return 'new';
    default:
      return 'unknown';
  }
}

export interface TradeInfo {
  instrument: string;
  /** Signed units the trade holds. */
  units: number;
}

/**
 * An OANDA Order object as a broker-neutral order. Dependent orders (stop
 * loss / take profit) carry no units of their own; their size and side come
 * from the trade they are attached to, when known.
 */
export function mapOrder(o: Raw, trade: TradeInfo | null): BrokerOrder {
  const dependent = isDependentOrderType(o.type);
  const units = num(o.units);
  const side: OrderSide = dependent ? (trade && trade.units < 0 ? 'buy' : 'sell') : units !== null && units < 0 ? 'sell' : 'buy';
  const qty = dependent ? (trade ? Math.abs(trade.units) : null) : units === null ? null : Math.abs(units);
  const status = orderStatus(o.state);
  const t = (x: unknown) => oandaTime(x);
  const type = orderType(o.type);
  return {
    id: String(o.id),
    clientOrderId: String(o.clientExtensions?.id ?? ''),
    symbol: String(o.instrument ?? trade?.instrument ?? ''),
    assetClass: 'cfd',
    side,
    type,
    timeInForce: tif(o.timeInForce),
    qty,
    filledQty: status === 'filled' && qty !== null ? qty : 0,
    filledAvgPrice: null,
    limitPrice: type === 'limit' ? num(o.price) : o.priceBound !== undefined ? num(o.priceBound) : null,
    stopPrice: type === 'stop' || type === 'trailing_stop' ? num(o.price) : null,
    status,
    positionIntent: positionIntentOf(o.positionFill, side, dependent),
    createdAt: t(o.createTime),
    updatedAt: t(o.filledTime) ?? t(o.cancelledTime) ?? t(o.createTime),
    submittedAt: t(o.createTime),
    filledAt: t(o.filledTime),
    canceledAt: t(o.cancelledTime),
    expiredAt: null,
    failedAt: null,
    extendedHours: false,
    statusReason: null,
    dependent,
  };
}

function positionIntentOf(fill: unknown, side: OrderSide, dependent: boolean): PositionIntent | null {
  if (dependent || fill === 'REDUCE_ONLY') return side === 'buy' ? 'buy_to_close' : 'sell_to_close';
  if (fill === 'OPEN_ONLY') return side === 'buy' ? 'buy_to_open' : 'sell_to_open';
  return null;
}

/** Fill details (from an ORDER_FILL transaction) applied to an order snapshot. */
export function withFill(o: BrokerOrder, fill: Raw): BrokerOrder {
  const units = Math.abs(num(fill.units) ?? 0);
  return {
    ...o,
    filledQty: units,
    filledAvgPrice: fillPrice(fill),
    filledAt: oandaTime(fill.time) ?? o.filledAt,
    updatedAt: oandaTime(fill.time) ?? o.updatedAt,
    realizedPl: fillRealized(fill),
    status: o.qty !== null && units < o.qty - 1e-9 ? (o.status === 'canceled' ? 'canceled' : 'partially_filled') : 'filled',
  };
}

export function mapInstrument(r: Raw): BrokerInstrument {
  const name = String(r.name);
  const [base, quote] = name.split('_');
  return {
    symbol: name,
    displayName: String(r.displayName ?? name),
    type: String(r.type ?? ''),
    displayPrecision: num(r.displayPrecision) ?? 5,
    pipLocation: num(r.pipLocation) ?? -4,
    unitsPrecision: num(r.tradeUnitsPrecision) ?? 0,
    minUnits: num(r.minimumTradeSize) ?? 1,
    maxOrderUnits: num(r.maximumOrderUnits),
    marginRate: num(r.marginRate) ?? 1,
    baseCurrency: base ?? name,
    quoteCurrency: quote ?? '',
  };
}

/** Wire format for a price: exactly the instrument's quote decimals. */
export function priceString(p: number, decimals: number): string {
  return p.toFixed(decimals);
}

/** Wire format for units: signed, with the instrument's unit precision. */
export function unitsString(qty: number, side: OrderSide, precision: number): string {
  const v = (side === 'buy' ? 1 : -1) * qty;
  return v.toFixed(precision);
}

export type { OrderType };
