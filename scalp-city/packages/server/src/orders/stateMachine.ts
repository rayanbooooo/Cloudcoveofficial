import { TERMINAL_ORDER_STATES, type OrderState } from '@scalp-city/shared';

/**
 * Order state machine (spec §13). Two rules make it safe against the
 * realities of a broker stream (duplicates, reordering, reconnect replays):
 *
 *  1. State only moves along ALLOWED edges; terminal states absorb. A late
 *     "accepted" can never pull a FILLED order backwards.
 *  2. Filled quantity is tracked separately and is monotonic — a fill is
 *     accounted even if its event arrives after the order was canceled.
 *
 * FILLED is only ever reached from a broker-reported status.
 */
const ALLOWED: Record<OrderState, readonly OrderState[]> = {
  CREATED: ['VALIDATING', 'REJECTED', 'ERROR'],
  VALIDATING: ['RISK_CHECK', 'REJECTED', 'ERROR'],
  RISK_CHECK: ['SUBMITTING', 'REJECTED', 'ERROR'],
  SUBMITTING: ['SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCEL_PENDING', 'CANCELED', 'REJECTED', 'EXPIRED', 'ERROR'],
  SUBMITTED: ['ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCEL_PENDING', 'CANCELED', 'REJECTED', 'EXPIRED', 'ERROR'],
  ACCEPTED: ['PARTIALLY_FILLED', 'FILLED', 'CANCEL_PENDING', 'CANCELED', 'REJECTED', 'EXPIRED', 'ERROR'],
  PARTIALLY_FILLED: ['PARTIALLY_FILLED', 'FILLED', 'CANCEL_PENDING', 'CANCELED', 'EXPIRED', 'ERROR'],
  CANCEL_PENDING: ['ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'ERROR'],
  FILLED: [],
  CANCELED: [],
  REJECTED: [],
  EXPIRED: [],
  // ERROR means "outcome unknown". Later broker evidence may resolve it.
  ERROR: ['SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCEL_PENDING', 'CANCELED', 'REJECTED', 'EXPIRED'],
};

export function canTransition(from: OrderState, to: OrderState): boolean {
  return ALLOWED[from].includes(to);
}

export function isTerminal(s: OrderState): boolean {
  return TERMINAL_ORDER_STATES.has(s);
}

/** Map an Alpaca order status to our state. Unknown statuses return null (state unchanged). */
export function brokerStatusToState(status: string): OrderState | null {
  switch (status) {
    case 'pending_new':
    case 'accepted_for_bidding':
    case 'pending_review':
    case 'held':
      return 'SUBMITTED';
    case 'new':
    case 'accepted':
    case 'pending_replace':
    case 'stopped':
    case 'calculated':
    case 'suspended':
      return 'ACCEPTED';
    case 'partially_filled':
      return 'PARTIALLY_FILLED';
    case 'filled':
      return 'FILLED';
    case 'pending_cancel':
      return 'CANCEL_PENDING';
    case 'canceled':
    case 'replaced':
      return 'CANCELED';
    case 'expired':
    case 'done_for_day':
      return 'EXPIRED';
    case 'rejected':
      return 'REJECTED';
    default:
      return null;
  }
}

export interface TransitionResult {
  state: OrderState;
  changed: boolean;
  /** True when the broker reported a state we refused (out of order / illegal). */
  ignored: boolean;
}

/** Decide the next state given a broker-reported status. */
export function nextState(current: OrderState, brokerStatus: string): TransitionResult {
  const target = brokerStatusToState(brokerStatus);
  if (target === null) return { state: current, changed: false, ignored: true };
  if (target === current) return { state: current, changed: false, ignored: false };
  if (canTransition(current, target)) return { state: target, changed: true, ignored: false };
  return { state: current, changed: false, ignored: true };
}

/**
 * Price of the newly filled quantity. Prefer the execution's own price when
 * the event describes exactly the delta; otherwise derive it from the change
 * in cumulative average price (covers missed or coalesced events).
 */
export function fillDeltaPrice(params: {
  prevQty: number;
  prevAvg: number | null;
  newQty: number;
  newAvg: number | null;
  eventQty: number | null;
  eventPrice: number | null;
}): number | null {
  const delta = params.newQty - params.prevQty;
  if (delta <= 0) return null;
  if (params.eventQty !== null && params.eventPrice !== null && Math.abs(params.eventQty - delta) < 1e-9) return params.eventPrice;
  if (params.newAvg === null) return params.eventPrice;
  const prevNotional = (params.prevAvg ?? 0) * params.prevQty;
  const price = (params.newAvg * params.newQty - prevNotional) / delta;
  return Number.isFinite(price) && price > 0 ? price : params.newAvg;
}
