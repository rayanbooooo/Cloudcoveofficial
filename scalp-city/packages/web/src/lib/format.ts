/**
 * Display formatting. A null value is UNAVAILABLE — it is never rendered as
 * zero or as a placeholder number.
 */
export const UNAVAILABLE = 'UNAVAILABLE';

const moneyFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function money(v: number | null | undefined, opts: { sign?: boolean; compact?: boolean } = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return UNAVAILABLE;
  const abs = Math.abs(v);
  const body = opts.compact && abs >= 100_000 ? `${(abs / 1000).toFixed(abs >= 1_000_000 ? 0 : 1)}K` : moneyFmt.format(abs);
  if (opts.sign) return `${v > 0 ? '+' : v < 0 ? '−' : ''}$${body}`;
  return `${v < 0 ? '−' : ''}$${body}`;
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
