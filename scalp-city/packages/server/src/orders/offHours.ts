import type { OrderPurpose, OrderSide } from '@scalp-city/shared';

/**
 * Outside the regular session Alpaca takes limit orders only (marked extended-hours, day or GTC). An exit or a
 * flatten that would have been a market order is priced as a LIMIT THROUGH THE TOUCH instead: a sell a little under
 * the best bid, a buy a little over the best ask. It fills at the book's prices like a market order would, and the
 * buffer is the most it can be worse than the quote it was priced from.
 */

/** Orders that only ever reduce a position: these may be turned into marketable limits. Opening orders may not. */
const CLOSING: ReadonlySet<OrderPurpose> = new Set<OrderPurpose>(['EXIT', 'FLATTEN', 'MANUAL_CLOSE']);

export function mayBecomeMarketableLimit(purpose: OrderPurpose): boolean {
  return CLOSING.has(purpose);
}

/**
 * The limit price for a market-like order: `bufferPct` percent past the touch (best ask for a buy, best bid for a
 * sell), rounded away from the quote to the cent so the buffer is never rounded off. Null without a usable quote.
 */
export function marketableLimit(side: OrderSide, quote: { bid: number; ask: number }, bufferPct: number): number | null {
  if (!(quote.bid > 0) || !(quote.ask >= quote.bid) || !(bufferPct >= 0)) return null;
  const f = bufferPct / 100;
  const px = side === 'sell' ? quote.bid * (1 - f) : quote.ask * (1 + f);
  // Whole cents (equities above $1): a sell rounds down, a buy rounds up.
  const cents = side === 'sell' ? Math.floor(px * 100 + 1e-9) : Math.ceil(px * 100 - 1e-9);
  const out = cents / 100;
  return out > 0 ? out : null;
}
