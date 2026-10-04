import type { Bar, OptionQuoteView, SymbolQuoteView } from './marketdata.js';
import type {
  AccountView,
  AlertView,
  CityEvent,
  OrderView,
  PositionView,
  RiskView,
  Snapshot,
  SystemView,
  TimelineEvent,
  WorkerView,
} from './views.js';

/**
 * Server → browser real-time protocol (spec §74).
 *
 * Every message carries a monotonically increasing `seq`. The browser
 * treats a gap in `seq` as lost state and asks for a fresh snapshot; it
 * never patches over a gap. Commands go over authenticated REST, never over
 * this socket.
 */
export type ServerMessage =
  | { type: 'snapshot'; seq: number; data: Snapshot }
  | { type: 'market.tick'; seq: number; data: { quotes: SymbolQuoteView[]; optionQuotes: OptionQuoteView[] } }
  | { type: 'market.bar'; seq: number; data: { bars: Bar[] } }
  | { type: 'worker.updated'; seq: number; data: WorkerView }
  | { type: 'order.updated'; seq: number; data: OrderView }
  | { type: 'position.updated'; seq: number; data: { positions: PositionView[] } }
  | { type: 'account.updated'; seq: number; data: AccountView }
  | { type: 'risk.updated'; seq: number; data: RiskView }
  | { type: 'system.updated'; seq: number; data: SystemView }
  | { type: 'timeline.event'; seq: number; data: TimelineEvent }
  | { type: 'alert'; seq: number; data: AlertView }
  | { type: 'city.event'; seq: number; data: CityEvent }
  | { type: 'heartbeat'; seq: number; data: { serverTime: number } };

export type ServerMessageType = ServerMessage['type'];

/** Browser → server messages (control-plane only; no trading commands). */
export type ClientMessage = { type: 'resync' } | { type: 'ping'; t: number };
