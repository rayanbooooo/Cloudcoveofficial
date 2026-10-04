import { isOccSymbol, type AssetClass, type TradingEnvironment } from '@scalp-city/shared';
import type { Credentials } from '../../config/env.js';
import { systemClock, type Clock } from '../../core/clock.js';
import type { Logger } from '../../core/logger.js';
import {
  BrokerError,
  type BrokerAccount,
  type BrokerAdapter,
  type BrokerAsset,
  type BrokerCalendarDay,
  type BrokerClock,
  type BrokerOptionContract,
  type BrokerOrder,
  type BrokerPosition,
  type BrokerTradeUpdate,
  type OptionContractQuery,
  type StreamStatus,
  type SubmitOrderParams,
  type Unsubscribe,
} from '../types.js';
import { AlpacaHttp, ts } from './AlpacaHttp.js';
import { AlpacaTradeStream } from './AlpacaTradeStream.js';
import { mapAccount, mapAsset, mapCalendarDay, mapOptionContract, mapOrder, mapPosition } from './mappers.js';

export interface AlpacaBrokerAdapterOptions {
  env: TradingEnvironment;
  baseUrl: string;
  streamUrl: string;
  credentials: Credentials;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** Server clock used for skew measurement (defaults to the system clock). */
  clock?: Clock;
}

/**
 * Format a price for the wire without float noise (3.6800000001 → "3.68").
 * Options trade in penny increments at every price; equities allow four
 * decimals only below $1.
 */
export function priceStr(p: number, isOption: boolean): string {
  const decimals = isOption || p >= 1 ? 2 : 4;
  return p.toFixed(decimals);
}

/**
 * Alpaca Trading API adapter for a personal account (not the Broker API).
 * Paper and live use the identical code path; only the base URL and keys
 * differ (spec §105).
 */
export class AlpacaBrokerAdapter implements BrokerAdapter {
  readonly name = 'ALPACA' as const;
  readonly env: TradingEnvironment;
  readonly endpoint: string;
  private readonly http: AlpacaHttp;
  private readonly stream: AlpacaTradeStream;
  private streamStarted = false;

  constructor(private readonly opts: AlpacaBrokerAdapterOptions) {
    this.env = opts.env;
    this.endpoint = opts.baseUrl;
    this.http = new AlpacaHttp({
      baseUrl: opts.baseUrl,
      credentials: opts.credentials,
      logger: opts.logger.child({ component: 'alpaca-trading' }),
      requestsPerMinute: 180,
      fetchImpl: opts.fetchImpl,
    });
    this.stream = new AlpacaTradeStream(opts.streamUrl, opts.credentials, opts.logger.child({ component: 'alpaca-trade-stream' }));
  }

  async getAccount(): Promise<BrokerAccount> {
    return mapAccount(await this.http.get('/v2/account'));
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const rows = await this.http.get<unknown[]>('/v2/positions');
    return (rows ?? []).map((r) => mapPosition(r as Record<string, unknown>));
  }

  async getOrders(params: { status: 'open' | 'closed' | 'all'; after?: number; limit?: number }): Promise<BrokerOrder[]> {
    const rows = await this.http.get<unknown[]>('/v2/orders', {
      status: params.status,
      limit: Math.min(params.limit ?? 500, 500),
      after: params.after ? new Date(params.after).toISOString() : undefined,
      direction: 'desc',
      nested: false,
    });
    return (rows ?? []).map((r) => mapOrder(r as Record<string, unknown>));
  }

  async getOrder(brokerOrderId: string): Promise<BrokerOrder> {
    return mapOrder(await this.http.get(`/v2/orders/${encodeURIComponent(brokerOrderId)}`));
  }

  async getOrderByClientId(clientOrderId: string): Promise<BrokerOrder | null> {
    try {
      return mapOrder(await this.http.get('/v2/orders:by_client_order_id', { client_order_id: clientOrderId }));
    } catch (err) {
      if (err instanceof BrokerError && err.kind === 'NOT_FOUND') return null;
      throw err;
    }
  }

  async getAsset(symbol: string): Promise<BrokerAsset> {
    return mapAsset(await this.http.get(`/v2/assets/${encodeURIComponent(symbol)}`));
  }

  async getAssets(params: { assetClass?: AssetClass; status?: 'active' | 'inactive' }): Promise<BrokerAsset[]> {
    const rows = await this.http.get<unknown[]>('/v2/assets', { asset_class: params.assetClass, status: params.status ?? 'active' });
    return (rows ?? []).map((r) => mapAsset(r as Record<string, unknown>));
  }

  /**
   * Submit exactly once. Never retried here: a timeout or 5xx leaves the
   * outcome unknown and the order engine resolves it by client_order_id.
   */
  async submitOrder(p: SubmitOrderParams): Promise<BrokerOrder> {
    const body: Record<string, unknown> = {
      symbol: p.symbol,
      qty: String(p.qty),
      side: p.side,
      type: p.type,
      time_in_force: p.timeInForce,
      client_order_id: p.clientOrderId,
    };
    const isOption = isOccSymbol(p.symbol);
    if (p.limitPrice !== undefined && p.limitPrice !== null) body.limit_price = priceStr(p.limitPrice, isOption);
    if (p.stopPrice !== undefined && p.stopPrice !== null) body.stop_price = priceStr(p.stopPrice, isOption);
    if (p.positionIntent) body.position_intent = p.positionIntent;
    return mapOrder(await this.http.post('/v2/orders', body, { timeoutMs: 10_000 }));
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    await this.http.delete(`/v2/orders/${encodeURIComponent(brokerOrderId)}`);
  }

  async cancelAllOrders(): Promise<{ id: string; status: number }[]> {
    const rows = await this.http.delete<{ id: string; status: number }[] | undefined>('/v2/orders');
    return (rows ?? []).map((r) => ({ id: String(r.id), status: Number(r.status) }));
  }

  async getOptionContracts(q: OptionContractQuery): Promise<BrokerOptionContract[]> {
    const out: BrokerOptionContract[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await this.http.get<{ option_contracts?: unknown[]; next_page_token?: string | null }>('/v2/options/contracts', {
        underlying_symbols: q.underlying,
        type: q.type,
        status: 'active',
        expiration_date: q.expirationDate,
        expiration_date_gte: q.expirationDateGte,
        expiration_date_lte: q.expirationDateLte,
        strike_price_gte: q.strikeGte,
        strike_price_lte: q.strikeLte,
        limit: q.limit ?? 1000,
        page_token: pageToken,
      });
      for (const r of res.option_contracts ?? []) out.push(mapOptionContract(r as Record<string, unknown>));
      pageToken = res.next_page_token ?? undefined;
      if (!pageToken) break;
    }
    return out;
  }

  async getOptionContract(symbol: string): Promise<BrokerOptionContract | null> {
    try {
      return mapOptionContract(await this.http.get(`/v2/options/contracts/${encodeURIComponent(symbol)}`));
    } catch (err) {
      if (err instanceof BrokerError && err.kind === 'NOT_FOUND') return null;
      throw err;
    }
  }

  async getClock(): Promise<BrokerClock> {
    const clock = this.opts.clock ?? systemClock;
    const sent = clock.now();
    const r = await this.http.get<Record<string, unknown>>('/v2/clock');
    const receivedAt = clock.now();
    const timestamp = ts(r.timestamp);
    const nextOpen = ts(r.next_open);
    const nextClose = ts(r.next_close);
    if (timestamp === null || nextOpen === null || nextClose === null) {
      throw new BrokerError('SERVER', 'malformed clock response');
    }
    return { timestamp, isOpen: r.is_open === true, nextOpen, nextClose, receivedAt, rttMs: receivedAt - sent };
  }

  async getCalendar(startDate: string, endDate: string): Promise<BrokerCalendarDay[]> {
    const rows = await this.http.get<unknown[]>('/v2/calendar', { start: startDate, end: endDate });
    return (rows ?? []).map((r) => mapCalendarDay(r as Record<string, unknown>));
  }

  subscribeTradeUpdates(handler: (update: BrokerTradeUpdate) => void): Unsubscribe {
    const off = this.stream.onUpdate(handler);
    if (!this.streamStarted) {
      this.streamStarted = true;
      this.stream.start();
    }
    return off;
  }

  onTradeStreamStatus(handler: (status: StreamStatus) => void): Unsubscribe {
    return this.stream.onStatus(handler);
  }

  tradeStreamStatus(): StreamStatus {
    return this.stream.getStatus();
  }

  async close(): Promise<void> {
    await this.stream.stop();
  }
}
