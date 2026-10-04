import { randomUUID } from 'node:crypto';
import type { OrderPurpose, TradingEnvironment } from '@scalp-city/shared';

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/**
 * Client order id: generated once, persisted before the broker call, and
 * reused for any status resolution. Alpaca rejects a duplicate
 * client_order_id, so the broker itself also refuses a second submission.
 * Max length at Alpaca is 128 characters.
 */
export function newClientOrderId(env: TradingEnvironment, purpose: OrderPurpose): string {
  const p = purpose.toLowerCase().replace('_', '-');
  return `sc-${env === 'live' ? 'L' : 'P'}-${p}-${randomUUID()}`;
}
