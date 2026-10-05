import { priceDecimals } from '@scalp-city/shared';

const fmtCache = new Map<string, Intl.NumberFormat>();

function currencyFormat(currency: string): Intl.NumberFormat | null {
  let f = fmtCache.get(currency);
  if (f) return f;
  try {
    f = new Intl.NumberFormat('en-US', { style: 'currency', currency });
  } catch {
    return null;
  }
  fmtCache.set(currency, f);
  return f;
}

/**
 * Money in the account's currency for logs, timeline and risk details:
 * "$12.30", "£4.10", "−€3.00". Unknown currency → plain number + code.
 */
export function formatMoney(v: number, currency: string | null | undefined, opts: { sign?: boolean } = {}): string {
  const cur = (currency ?? 'USD').toUpperCase();
  const f = currencyFormat(cur);
  const abs = Math.abs(v);
  const body = f ? f.format(abs) : `${abs.toFixed(2)} ${cur}`;
  const sign = v < 0 ? '−' : opts.sign && v > 0 ? '+' : '';
  return `${sign}${body}`;
}

/** A price with the decimals its instrument is quoted in. */
export function formatPrice(price: number, symbol: string): string {
  return price.toFixed(priceDecimals(symbol));
}

/** Order size without float noise: 3 → "3", 0.1 → "0.1", 1250 → "1,250". */
export function formatQty(qty: number): string {
  return Number(qty.toFixed(6)).toLocaleString('en-US', { maximumFractionDigits: 6 });
}
