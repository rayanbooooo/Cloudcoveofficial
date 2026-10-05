import type { AssetClass, DirectionOrNeutral } from './domain.js';

/**
 * Display helpers for instrument symbols. Purely cosmetic: orders always use
 * the broker's own symbol (e.g. OANDA "XAU_USD"), never a display name.
 */

/** OANDA instrument names: BASE_QUOTE, e.g. XAU_USD, NAS100_USD, EUR_JPY. */
const OANDA_SYMBOL_RE = /^[A-Z0-9]{2,12}_[A-Z0-9]{2,12}$/;

export function isOandaSymbol(symbol: string): boolean {
  return OANDA_SYMBOL_RE.test(symbol);
}

const NAMES: Record<string, string> = {
  XAU_USD: 'GOLD',
  XAG_USD: 'SILVER',
  NAS100_USD: 'NAS100',
  US30_USD: 'US30',
  SPX500_USD: 'S&P 500',
  US2000_USD: 'RUSSELL 2000',
  DE30_EUR: 'DAX',
  DE40_EUR: 'DAX',
  UK100_GBP: 'FTSE 100',
  JP225_USD: 'NIKKEI',
  BCO_USD: 'BRENT',
  WTICO_USD: 'WTI OIL',
};

/** Short human name: "GOLD", "NAS100", "GBP/USD". Unknown symbols pass through. */
export function instrumentName(symbol: string): string {
  if (NAMES[symbol]) return NAMES[symbol]!;
  if (isOandaSymbol(symbol)) return symbol.replace('_', '/');
  return symbol;
}

/** Longer description for tooltips and drawers. */
export function instrumentDescription(symbol: string): string {
  switch (symbol) {
    case 'XAU_USD':
      return 'Gold spot (XAU/USD)';
    case 'NAS100_USD':
      return 'Nasdaq 100 index CFD';
    case 'US30_USD':
      return 'Dow Jones 30 index CFD';
    case 'GBP_USD':
      return 'British pound / US dollar';
    case 'EUR_JPY':
      return 'Euro / Japanese yen';
    default:
      return isOandaSymbol(symbol) ? `${symbol.replace('_', '/')} (OANDA)` : symbol;
  }
}

/** Quote currency of an OANDA instrument (the currency its price and P&L are in). */
export function quoteCurrency(symbol: string): string | null {
  const m = OANDA_SYMBOL_RE.exec(symbol) ? symbol.split('_') : null;
  return m ? m[1]! : null;
}

/**
 * Direction label. The signal engine speaks CALL (bullish) / PUT (bearish);
 * for anything that is not an option contract that means LONG / SHORT.
 */
export function directionLabel(direction: DirectionOrNeutral, assetClass: AssetClass | 'OPTIONS' | 'EQUITY' | 'CFD' = 'us_option'): string {
  if (direction === 'NEUTRAL') return 'NEUTRAL';
  const options = assetClass === 'us_option' || assetClass === 'OPTIONS';
  if (options) return direction;
  return direction === 'CALL' ? 'LONG' : 'SHORT';
}

/** Units of size for display: contracts, shares or units. */
export function sizeUnit(assetClass: AssetClass, qty: number): string {
  const one = Math.abs(qty) === 1;
  if (assetClass === 'us_option') return one ? 'contract' : 'contracts';
  if (assetClass === 'us_equity') return one ? 'share' : 'shares';
  return one ? 'unit' : 'units';
}

/** Decimal places a price is quoted with (OANDA display precision; 2 elsewhere). */
export function priceDecimals(symbol: string, fallback = 2): number {
  if (!isOandaSymbol(symbol)) return fallback;
  const q = quoteCurrency(symbol);
  if (symbol.startsWith('XAU_') || symbol.startsWith('XAG_')) return 3;
  if (/^[A-Z]{3}_[A-Z]{3}$/.test(symbol)) return q === 'JPY' || q === 'HUF' ? 3 : 5;
  return 1; // index and commodity CFDs
}
