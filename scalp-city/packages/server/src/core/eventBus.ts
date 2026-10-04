import type {
  AlertView,
  Bar,
  CityEvent,
  MarketTick,
  OrderState,
  RiskDecisionView,
  TimelineEvent,
} from '@scalp-city/shared';
import type { StreamStatus } from '../broker/types.js';
import type { OrderRecord } from '../orders/types.js';
import type { TradeRecord } from '../positions/types.js';
import type { Logger } from './logger.js';

/** Internal events (spec §75). */
export interface BusEvents {
  MARKET_TICK: MarketTick;
  MARKET_BAR: { bar: Bar; kind: 'forming' | 'closed' | 'updated' };
  MARKET_DATA_STATUS: { stream: 'stock' | 'options'; status: StreamStatus };
  SIGNAL_UPDATED: { workerId: string };
  RISK_APPROVED: { order: OrderRecord; decision: RiskDecisionView };
  RISK_REJECTED: { order: OrderRecord; decision: RiskDecisionView };
  ORDER_UPDATED: { order: OrderRecord; prevState: OrderState | null };
  ORDER_SUBMITTED: { order: OrderRecord };
  ORDER_FILLED: { order: OrderRecord };
  ORDER_CANCELED: { order: OrderRecord };
  ORDER_REJECTED: { order: OrderRecord };
  FILL: { order: OrderRecord; qty: number; price: number; at: number };
  POSITION_UPDATED: { symbol: string };
  POSITION_OPENED: { trade: TradeRecord };
  POSITION_CLOSED: { trade: TradeRecord };
  ACCOUNT_UPDATED: Record<string, never>;
  BROKER_STATUS: Record<string, never>;
  KILL_SWITCH: { active: boolean; by: string; reason: string | null };
  SYSTEM_UPDATED: Record<string, never>;
  WORKER_UPDATED: { workerId: string };
  TIMELINE: TimelineEvent;
  ALERT: AlertView;
  CITY_EVENT: CityEvent;
}

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<keyof BusEvents, Set<Handler<never>>>();

  constructor(private readonly logger: Logger) {}

  on<K extends keyof BusEvents>(event: K, handler: Handler<BusEvents[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => set!.delete(handler as Handler<never>);
  }

  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of [...set]) {
      try {
        (h as Handler<BusEvents[K]>)(payload);
      } catch (err) {
        this.logger.error({ err, event }, 'event handler failed');
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
