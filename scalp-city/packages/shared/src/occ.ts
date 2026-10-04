/**
 * OCC option symbol parsing, for DISPLAY and validation only.
 *
 * Contracts are never constructed from parts to be traded: the options
 * contract selector only trades symbols returned by the broker's contract
 * listing. Parsing lets the UI show strike/expiry for any position the
 * broker reports.
 */

export interface ParsedOptionSymbol {
  root: string;
  /** YYYY-MM-DD */
  expiration: string;
  type: 'call' | 'put';
  strike: number;
}

const OCC_RE = /^([A-Z0-9.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

export function parseOccSymbol(symbol: string): ParsedOptionSymbol | null {
  const m = OCC_RE.exec(symbol.trim().toUpperCase());
  if (!m) return null;
  const [, root, yy, mm, dd, cp, strike] = m as unknown as [string, string, string, string, string, string, string];
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return {
    root,
    expiration: `20${yy}-${mm}-${dd}`,
    type: cp === 'C' ? 'call' : 'put',
    strike: Number(strike) / 1000,
  };
}

export function isOccSymbol(symbol: string): boolean {
  return parseOccSymbol(symbol) !== null;
}
