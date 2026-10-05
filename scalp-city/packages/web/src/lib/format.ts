import { priceDecimals } from '@scalp-city/shared';

/**
 * Display formatting. A null value is UNAVAILABLE — it is never rendered as
 * zero or as a placeholder number.
 */
export const UNAVAILABLE = 'UNAVAILABLE';

interface CurrencyInfo {
  code: string;
  /** "$", "£", "€", "¥" — or the ISO code plus a space when the currency has no short symbol. */
  prefix: string;
  digits: number;
  fmt: Intl.NumberFormat;
}

const currencyCache = new Map<string, CurrencyInfo>();

function currencyInfo(code: string): CurrencyInfo {
  const hit = currencyCache.get(code);
  if (hit) return hit;
  let info: CurrencyInfo;
  try {
    const f = new Intl.NumberFormat('en-US', { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' });
    const symbol = f.formatToParts(1).find((p) => p.type === 'currency')?.value ?? code;
    const digits = f.resolvedOptions().maximumFractionDigits ?? 2;
    info = { code, prefix: /^[A-Za-z]+$/.test(symbol) ? `${symbol} ` : symbol, digits, fmt: new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) };
  } catch {
    info = { code: 'USD', prefix: '$', digits: 2, fmt: new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) };
  }
  currencyCache.set(code, info);
  return info;
}

let current: CurrencyInfo = currencyInfo('USD');

/** The account's currency: every money() figure is in it. Set from the broker's account view. */
export function setDisplayCurrency(code: string | null | undefined): void {
  const next = currencyInfo((code ?? 'USD').toUpperCase());
  if (next.code !== current.code) current = next;
}

export function displayCurrency(): string {
  return current.code;
}

const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function money(v: number | null | undefined, opts: { sign?: boolean; compact?: boolean } = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return UNAVAILABLE;
  const abs = Math.abs(v);
  const body = opts.compact && abs >= 100_000 ? `${(abs / 1000).toFixed(abs >= 1_000_000 ? 0 : 1)}K` : current.fmt.format(abs);
  if (opts.sign) return `${v > 0 ? '+' : v < 0 ? '−' : ''}${current.prefix}${body}`;
  return `${v < 0 ? '−' : ''}${current.prefix}${body}`;
}

/** The environment as the broker calls it: PAPER (Alpaca), PRACTICE (OANDA), LIVE. */
export function envLabel(env: 'paper' | 'live' | null | undefined, venue?: string | null): string {
  return env === 'live' ? 'LIVE' : venue === 'oanda' ? 'PRACTICE' : 'PAPER';
}

/** Order size without float noise: 3 → "3", 0.30000000000000004 → "0.3". */
export function qtyStr(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return Number(v.toFixed(6)).toLocaleString('en-US', { maximumFractionDigits: 6 });
}

/** "1 unit", "2.5 units": the size with its noun agreeing in number. */
export function unitsStr(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${qtyStr(v)} ${Math.abs(v) === 1 ? 'unit' : 'units'}`;
}

/** A price with the decimals its market is quoted in: GBP_USD 1.30012, EUR_JPY 162.015, XAU_USD 2650.125, NAS100_USD 20501.2. */
export function px(symbol: string | null | undefined, v: number | null | undefined): string {
  return price(v, symbol ? priceDecimals(symbol) : 2);
}

export function price(v: number | null | undefined, decimals = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toFixed(decimals);
}

export function pct(v: number | null | undefined, opts: { sign?: boolean; decimals?: number } = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const d = opts.decimals ?? 2;
  const s = Math.abs(v).toFixed(d);
  if (opts.sign) return `${v > 0 ? '+' : v < 0 ? '−' : ''}${s}%`;
  return `${v < 0 ? '−' : ''}${s}%`;
}

export function int(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return intFmt.format(v);
}

export function compactVolume(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

export function age(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

const etTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const etShort = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
const etDate = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: '2-digit' });
const etDateTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/** Times are shown in exchange time (New York). */
export function timeET(ts: number | null | undefined): string {
  if (!ts) return '—';
  return etTime.format(ts);
}
export function hmET(ts: number | null | undefined): string {
  if (!ts) return '—';
  return etShort.format(ts);
}
export function dateET(ts: number | null | undefined): string {
  if (!ts) return '—';
  return etDate.format(ts);
}
export function dateTimeET(ts: number | null | undefined): string {
  if (!ts) return '—';
  return etDateTime.format(ts);
}

export function countdown(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms <= 0) return '0s';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export function pnlClass(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || Math.abs(v) < 0.005) return 'text-fg-2';
  return v > 0 ? 'text-call' : 'text-put';
}

export function humanize(s: string): string {
  return s.replace(/_/g, ' ');
}
