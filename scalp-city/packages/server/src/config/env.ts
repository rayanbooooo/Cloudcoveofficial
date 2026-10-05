import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { OptionsFeed, RiskLimits, StockFeed, TradingEnvironment, Venue } from '@scalp-city/shared';

/** Which Alpaca workers run: ETF stand-ins for gold/Nasdaq/FX/US30, or the original options workers. */
export type AlpacaWorkerSet = 'etf' | 'options';

/** The only URL a LIVE trading context will ever talk to. */
export const ALPACA_LIVE_TRADING_URL = 'https://api.alpaca.markets';
export const ALPACA_PAPER_TRADING_URL = 'https://paper-api.alpaca.markets';
export const ALPACA_DATA_URL = 'https://data.alpaca.markets';
export const ALPACA_DATA_STREAM_URL = 'wss://stream.data.alpaca.markets';

/** OANDA v20. LIVE ("fxTrade") endpoints are pinned and cannot be overridden. */
export const OANDA_LIVE_API_URL = 'https://api-fxtrade.oanda.com';
export const OANDA_LIVE_STREAM_URL = 'https://stream-fxtrade.oanda.com';
export const OANDA_PRACTICE_API_URL = 'https://api-fxpractice.oanda.com';
export const OANDA_PRACTICE_STREAM_URL = 'https://stream-fxpractice.oanda.com';

/** Gold, Nasdaq, the Dow, GBP/USD and the euro — the ETFs Alpaca can trade for them. */
export const DEFAULT_ETF_SYMBOLS = ['GLD', 'QQQ', 'DIA', 'FXB', 'FXE'];
export const DEFAULT_OPTION_SYMBOLS = ['QQQ', 'SPY', 'IWM'];

/** Gold, Nasdaq 100, GBP/USD, EUR/JPY and the Dow — OANDA instrument names. */
export const DEFAULT_OANDA_INSTRUMENTS = ['XAU_USD', 'NAS100_USD', 'GBP_USD', 'EUR_JPY', 'US30_USD'];

export interface Credentials {
  keyId: string;
  secretKey: string;
}

export interface OandaCredentials {
  /** Personal access token (sent as a Bearer token; never logged). */
  token: string;
  /** v20 account id, e.g. 101-004-12345678-001. */
  accountId: string;
}

export interface OandaConfig {
  credentials: Record<TradingEnvironment, OandaCredentials | null>;
  endpoints: { practiceApi: string; practiceStream: string; liveApi: string; liveStream: string };
  /** The strategy's trading window, New York time ("09:30" – "16:00"). */
  session: { open: string; close: string };
  /** Skip US exchange holidays (index CFDs trade thin or not at all) and close early on half days. */
  skipUsHolidays: boolean;
}

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  host: string;
  port: number;
  /** Brokerage this installation trades through (BROKER). */
  venue: Venue;
  /** Which Alpaca workers run (ALPACA_WORKER_SET). */
  alpacaWorkerSet: AlpacaWorkerSet;
  /** Environment the server starts in. */
  tradingEnvironment: TradingEnvironment;
  /** Alpaca key pairs. */
  credentials: Record<TradingEnvironment, Credentials | null>;
  oanda: OandaConfig;
  endpoints: {
    paperTrading: string;
    liveTrading: string;
    data: string;
    dataStream: string;
  };
  /** Non-default endpoints in use (paper/data only — live is pinned). */
  nonStandardEndpoints: string[];
  stockFeed: StockFeed;
  optionsFeed: OptionsFeed;
  paperAllowIndicativeOptions: boolean;
  databaseUrl: string;
  sessionSecret: string;
  /** LIVE_TRADING_ENABLED — the server-side lock. */
  liveTradingEnabled: boolean;
  riskDefaults: RiskLimits;
  thresholds: {
    maxDataAgeMs: number;
    maxOptionQuoteAgeMs: number;
    maxClockSkewMs: number;
  };
  symbols: string[];
  allowedOrigins: string[];
  cookieSecure: boolean;
  logLevel: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const positiveNumber = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return fallback;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        ctx.addIssue({ code: 'custom', message: `must be a positive number, got "${v}"` });
        return z.NEVER;
      }
      return n;
    });

const positiveInt = (fallback: number) =>
  positiveNumber(fallback).refine((n) => Number.isInteger(n), { message: 'must be an integer' });

const flag = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return fallback;
      const s = v.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(s)) return true;
      if (['false', '0', 'no', 'off'].includes(s)) return false;
      ctx.addIssue({ code: 'custom', message: `must be true or false, got "${v}"` });
      return z.NEVER;
    });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).optional().default('development'),
  HOST: optionalString,
  PORT: positiveInt(8787),
  TRADING_ENVIRONMENT: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? 'paper' : v.trim().toLowerCase()))
    .pipe(z.enum(['paper', 'live'])),
  BROKER: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? 'alpaca' : v.trim().toLowerCase()))
    .pipe(z.enum(['alpaca', 'oanda'])),
  ALPACA_WORKER_SET: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? 'etf' : v.trim().toLowerCase()))
    .pipe(z.enum(['etf', 'options'])),
  OANDA_PRACTICE_TOKEN: optionalString,
  OANDA_PRACTICE_ACCOUNT_ID: optionalString,
  OANDA_LIVE_TOKEN: optionalString,
  OANDA_LIVE_ACCOUNT_ID: optionalString,
  OANDA_PRACTICE_API_URL: optionalString,
  OANDA_PRACTICE_STREAM_URL: optionalString,
  OANDA_LIVE_API_URL: optionalString,
  OANDA_LIVE_STREAM_URL: optionalString,
  OANDA_INSTRUMENTS: optionalString,
  OANDA_SESSION: optionalString,
  OANDA_SKIP_US_HOLIDAYS: flag(true),
  ALPACA_API_KEY: optionalString,
  ALPACA_API_SECRET: optionalString,
  ALPACA_PAPER_API_KEY: optionalString,
  ALPACA_PAPER_API_SECRET: optionalString,
  ALPACA_LIVE_API_KEY: optionalString,
  ALPACA_LIVE_API_SECRET: optionalString,
  ALPACA_LIVE_BASE_URL: optionalString,
  ALPACA_PAPER_BASE_URL: optionalString,
  ALPACA_DATA_URL: optionalString,
  ALPACA_DATA_STREAM_URL: optionalString,
  ALPACA_STOCK_FEED: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? 'iex' : v.trim().toLowerCase()))
    .pipe(z.enum(['iex', 'sip', 'delayed_sip'])),
  ALPACA_OPTIONS_FEED: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? 'indicative' : v.trim().toLowerCase()))
    .pipe(z.enum(['indicative', 'opra'])),
  PAPER_ALLOW_INDICATIVE_OPTIONS: flag(false),
  DATABASE_URL: optionalString,
  SESSION_SECRET: optionalString,
  LIVE_TRADING_ENABLED: flag(false),
  MAX_DAILY_LOSS: positiveNumber(500),
  MAX_POSITION_SIZE: optionalString,
  MAX_POSITION_NOTIONAL: optionalString,
  MAX_ORDER_NOTIONAL: optionalString,
  MAX_CONTRACTS: positiveInt(20),
  MAX_SHARES: positiveInt(100),
  MAX_CONCURRENT_POSITIONS: positiveInt(3),
  MAX_TRADES_PER_DAY: positiveInt(10),
  MAX_ORDERS_PER_MINUTE: positiveInt(10),
  // OANDA (BROKER=oanda) has its own limits, in the ACCOUNT's currency. The
  // Alpaca-style MAX_* values above are dollar figures sized for shares and
  // options; they are deliberately ignored for OANDA so a leftover MAX_POSITION_SIZE=300
  // can't silently block every FX/CFD order.
  OANDA_MAX_DAILY_LOSS: positiveNumber(100),
  OANDA_MAX_RISK_PER_TRADE: positiveNumber(20),
  OANDA_MAX_POSITION_NOTIONAL: positiveNumber(10_000),
  OANDA_MAX_ORDER_NOTIONAL: optionalString,
  OANDA_MAX_CONCURRENT_POSITIONS: positiveInt(3),
  OANDA_MAX_TRADES_PER_DAY: positiveInt(10),
  MAX_DATA_AGE_MS: positiveInt(5000),
  MAX_OPTION_QUOTE_AGE_MS: positiveInt(10_000),
  MAX_CLOCK_SKEW_MS: positiveInt(2000),
  SYMBOLS: optionalString,
  ALLOWED_ORIGINS: optionalString,
  COOKIE_SECURE: optionalString,
  LOG_LEVEL: optionalString,
});

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, '');
}

function validUrl(raw: string, protocols: string[], name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(`${name} is not a valid URL: ${raw}`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new ConfigError(`${name} must use ${protocols.join(' or ')}, got ${parsed.protocol}`);
  }
  return stripTrailingSlash(raw);
}

function pair(key: string | undefined, secret: string | undefined, label: string): Credentials | null {
  if (!key && !secret) return null;
  if (!key || !secret) throw new ConfigError(`${label}: both the key and the secret must be set`);
  return { keyId: key, secretKey: secret };
}

const OANDA_ACCOUNT_RE = /^\d{3}-\d{3}-\d{4,12}-\d{3}$/;

function oandaPair(token: string | undefined, accountId: string | undefined, label: string): OandaCredentials | null {
  if (!token && !accountId) return null;
  if (!token || !accountId) throw new ConfigError(`${label}: both the API token and the account id must be set`);
  if (/\s/.test(token)) throw new ConfigError(`${label}: the API token contains whitespace — paste it without spaces or line breaks`);
  if (!OANDA_ACCOUNT_RE.test(accountId)) {
    throw new ConfigError(`${label}: account id must look like 101-004-12345678-001 (OANDA → My Account → v20 account number), got "${accountId}"`);
  }
  return { token, accountId };
}

/** "09:30-16:00" → { open: "09:30", close: "16:00" } (New York time). */
function parseSession(raw: string | undefined): { open: string; close: string } {
  const v = raw ?? '09:30-16:00';
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) throw new ConfigError(`OANDA_SESSION must look like 09:30-16:00 (New York time), got "${v}"`);
  const [oh, om, ch, cm] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (oh > 23 || ch > 23 || om > 59 || cm > 59) throw new ConfigError(`OANDA_SESSION has an invalid time: "${v}"`);
  if (ch * 60 + cm <= oh * 60 + om) throw new ConfigError(`OANDA_SESSION must end after it starts (same day), got "${v}"`);
  if (ch * 60 + cm - (oh * 60 + om) < 30) throw new ConfigError(`OANDA_SESSION must be at least 30 minutes long, got "${v}"`);
  const pad = (n: number) => String(n).padStart(2, '0');
  return { open: `${pad(oh)}:${pad(om)}`, close: `${pad(ch)}:${pad(cm)}` };
}

/**
 * Load `.env` (if present) without overriding variables already set in the
 * process environment, then validate. Never logs secret values.
 */
export function loadEnvFile(cwd = process.cwd()): void {
  for (const candidate of [path.join(cwd, '.env'), path.join(cwd, '..', '.env'), path.join(cwd, '..', '..', '.env')]) {
    if (fs.existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
  }
}

export function parseConfig(source: NodeJS.ProcessEnv): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;

  // ── Endpoints ──────────────────────────────────────────────────────────
  const liveTrading = validUrl(e.ALPACA_LIVE_BASE_URL ?? ALPACA_LIVE_TRADING_URL, ['https:'], 'ALPACA_LIVE_BASE_URL');
  if (liveTrading !== ALPACA_LIVE_TRADING_URL) {
    // Pinned on purpose: a live context must never be pointed anywhere else.
    throw new ConfigError(
      `ALPACA_LIVE_BASE_URL must be ${ALPACA_LIVE_TRADING_URL} (got ${liveTrading}). The live endpoint cannot be overridden.`,
    );
  }
  const paperTrading = validUrl(e.ALPACA_PAPER_BASE_URL ?? ALPACA_PAPER_TRADING_URL, ['https:', 'http:'], 'ALPACA_PAPER_BASE_URL');
  const data = validUrl(e.ALPACA_DATA_URL ?? ALPACA_DATA_URL, ['https:', 'http:'], 'ALPACA_DATA_URL');
  const dataStream = validUrl(e.ALPACA_DATA_STREAM_URL ?? ALPACA_DATA_STREAM_URL, ['wss:', 'ws:'], 'ALPACA_DATA_STREAM_URL');
  const nonStandardEndpoints: string[] = [];
  if (e.BROKER === 'alpaca') {
    if (paperTrading !== ALPACA_PAPER_TRADING_URL) nonStandardEndpoints.push(paperTrading);
    if (data !== ALPACA_DATA_URL) nonStandardEndpoints.push(data);
    if (dataStream !== ALPACA_DATA_STREAM_URL) nonStandardEndpoints.push(dataStream);
  }

  // ── Credentials ────────────────────────────────────────────────────────
  const generic = pair(e.ALPACA_API_KEY, e.ALPACA_API_SECRET, 'ALPACA_API_KEY/ALPACA_API_SECRET');
  const paperExplicit = pair(e.ALPACA_PAPER_API_KEY, e.ALPACA_PAPER_API_SECRET, 'ALPACA_PAPER_API_KEY/SECRET');
  const liveExplicit = pair(e.ALPACA_LIVE_API_KEY, e.ALPACA_LIVE_API_SECRET, 'ALPACA_LIVE_API_KEY/SECRET');
  const env = e.TRADING_ENVIRONMENT as TradingEnvironment;
  const credentials: Record<TradingEnvironment, Credentials | null> = {
    paper: paperExplicit ?? (env === 'paper' ? generic : null),
    live: liveExplicit ?? (env === 'live' ? generic : null),
  };

  // ── OANDA ──────────────────────────────────────────────────────────────
  const venue = e.BROKER as Venue;
  if (e.OANDA_LIVE_API_URL !== undefined && stripTrailingSlash(e.OANDA_LIVE_API_URL) !== OANDA_LIVE_API_URL) {
    throw new ConfigError(`OANDA_LIVE_API_URL must be ${OANDA_LIVE_API_URL}. The live endpoint cannot be overridden.`);
  }
  if (e.OANDA_LIVE_STREAM_URL !== undefined && stripTrailingSlash(e.OANDA_LIVE_STREAM_URL) !== OANDA_LIVE_STREAM_URL) {
    throw new ConfigError(`OANDA_LIVE_STREAM_URL must be ${OANDA_LIVE_STREAM_URL}. The live endpoint cannot be overridden.`);
  }
  const practiceApi = validUrl(e.OANDA_PRACTICE_API_URL ?? OANDA_PRACTICE_API_URL, ['https:', 'http:'], 'OANDA_PRACTICE_API_URL');
  const practiceStream = validUrl(e.OANDA_PRACTICE_STREAM_URL ?? OANDA_PRACTICE_STREAM_URL, ['https:', 'http:'], 'OANDA_PRACTICE_STREAM_URL');
  const oanda: OandaConfig = {
    credentials: {
      paper: oandaPair(e.OANDA_PRACTICE_TOKEN, e.OANDA_PRACTICE_ACCOUNT_ID, 'OANDA_PRACTICE_TOKEN/OANDA_PRACTICE_ACCOUNT_ID'),
      live: oandaPair(e.OANDA_LIVE_TOKEN, e.OANDA_LIVE_ACCOUNT_ID, 'OANDA_LIVE_TOKEN/OANDA_LIVE_ACCOUNT_ID'),
    },
    endpoints: { practiceApi, practiceStream, liveApi: OANDA_LIVE_API_URL, liveStream: OANDA_LIVE_STREAM_URL },
    session: parseSession(e.OANDA_SESSION),
    skipUsHolidays: e.OANDA_SKIP_US_HOLIDAYS,
  };
  if (venue === 'oanda') {
    if (practiceApi !== OANDA_PRACTICE_API_URL) nonStandardEndpoints.push(practiceApi);
    if (practiceStream !== OANDA_PRACTICE_STREAM_URL) nonStandardEndpoints.push(practiceStream);
  }

  // ── Secrets & database ─────────────────────────────────────────────────
  const isTest = e.NODE_ENV === 'test';
  const sessionSecret = e.SESSION_SECRET ?? (isTest ? 'test-session-secret-test-session-secret-0000' : undefined);
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new ConfigError('SESSION_SECRET must be set to a random string of at least 32 characters.');
  }
  const databaseUrl = e.DATABASE_URL ?? (isTest ? 'pglite://memory' : undefined);
  if (!databaseUrl) {
    throw new ConfigError('DATABASE_URL must be set (PostgreSQL connection string). See .env.example.');
  }

  // ── Risk defaults ──────────────────────────────────────────────────────
  const num = (raw: string | undefined, name: string, fallback: number): number => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${name} must be a positive number, got "${raw}"`);
    return n;
  };
  let riskDefaults: RiskLimits;
  if (venue === 'oanda') {
    // Leveraged FX/CFD positions carry far more notional per unit of risk than
    // options do, so OANDA has its own limits. Risk per trade is the real
    // control (every position carries a broker-side stop); notional is a sanity cap.
    const maxPositionNotional = e.OANDA_MAX_POSITION_NOTIONAL;
    riskDefaults = {
      maxDailyLoss: e.OANDA_MAX_DAILY_LOSS,
      maxPositionNotional,
      maxOrderNotional: num(e.OANDA_MAX_ORDER_NOTIONAL, 'OANDA_MAX_ORDER_NOTIONAL', maxPositionNotional),
      maxContracts: e.MAX_CONTRACTS,
      maxShares: e.MAX_SHARES,
      maxConcurrentPositions: e.OANDA_MAX_CONCURRENT_POSITIONS,
      maxTradesPerDay: e.OANDA_MAX_TRADES_PER_DAY,
      maxOrdersPerMinute: e.MAX_ORDERS_PER_MINUTE,
      maxPriceDeviationPct: 2,
      noEntriesBeforeCloseMinutes: 10,
      pdtGuard: false,
      maxRiskPerTrade: e.OANDA_MAX_RISK_PER_TRADE,
    };
  } else {
    riskDefaults = {
      maxDailyLoss: e.MAX_DAILY_LOSS,
      maxPositionNotional: num(e.MAX_POSITION_NOTIONAL ?? e.MAX_POSITION_SIZE, 'MAX_POSITION_SIZE', 1000),
      maxOrderNotional: num(e.MAX_ORDER_NOTIONAL, 'MAX_ORDER_NOTIONAL', 1000),
      maxContracts: e.MAX_CONTRACTS,
      maxShares: e.MAX_SHARES,
      maxConcurrentPositions: e.MAX_CONCURRENT_POSITIONS,
      maxTradesPerDay: e.MAX_TRADES_PER_DAY,
      maxOrdersPerMinute: e.MAX_ORDERS_PER_MINUTE,
      maxPriceDeviationPct: 5,
      noEntriesBeforeCloseMinutes: 10,
      pdtGuard: true,
      maxRiskPerTrade: 25, // CFD-only limit; unused for shares and options
    };
  }

  let symbols: string[];
  if (venue === 'oanda') {
    symbols = (e.OANDA_INSTRUMENTS ? e.OANDA_INSTRUMENTS.split(',') : DEFAULT_OANDA_INSTRUMENTS).map((s) => s.trim().toUpperCase()).filter(Boolean);
    for (const s of symbols) {
      if (!/^[A-Z0-9]{2,12}_[A-Z0-9]{2,12}$/.test(s)) throw new ConfigError(`OANDA_INSTRUMENTS contains an invalid instrument: ${s} (use OANDA names like XAU_USD)`);
    }
  } else {
    symbols = (e.SYMBOLS ?? (e.ALPACA_WORKER_SET === 'options' ? DEFAULT_OPTION_SYMBOLS : DEFAULT_ETF_SYMBOLS).join(','))
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    for (const s of symbols) {
      if (!/^[A-Z.]{1,10}$/.test(s)) throw new ConfigError(`SYMBOLS contains an invalid ticker: ${s}`);
    }
  }
  if (symbols.length === 0) throw new ConfigError('at least one symbol/instrument must be configured');
  if (new Set(symbols).size !== symbols.length) throw new ConfigError('a symbol/instrument is listed twice');

  const allowedOrigins = (e.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const cookieSecure =
    e.COOKIE_SECURE === undefined ? e.NODE_ENV === 'production' : ['true', '1', 'yes'].includes(e.COOKIE_SECURE.toLowerCase());

  return {
    nodeEnv: e.NODE_ENV,
    host: e.HOST ?? '127.0.0.1',
    port: e.PORT,
    venue,
    alpacaWorkerSet: e.ALPACA_WORKER_SET as AlpacaWorkerSet,
    tradingEnvironment: env,
    credentials,
    oanda,
    endpoints: { paperTrading, liveTrading, data, dataStream },
    nonStandardEndpoints,
    stockFeed: e.ALPACA_STOCK_FEED as StockFeed,
    optionsFeed: e.ALPACA_OPTIONS_FEED as OptionsFeed,
    paperAllowIndicativeOptions: e.PAPER_ALLOW_INDICATIVE_OPTIONS,
    databaseUrl,
    sessionSecret,
    liveTradingEnabled: e.LIVE_TRADING_ENABLED,
    riskDefaults,
    thresholds: {
      maxDataAgeMs: e.MAX_DATA_AGE_MS,
      maxOptionQuoteAgeMs: e.MAX_OPTION_QUOTE_AGE_MS,
      maxClockSkewMs: e.MAX_CLOCK_SKEW_MS,
    },
    symbols,
    allowedOrigins,
    cookieSecure,
    logLevel: e.LOG_LEVEL ?? 'info',
  };
}

/** Whether the configured broker has credentials for an environment. */
export function hasCredentials(config: AppConfig, env: TradingEnvironment): boolean {
  return config.venue === 'oanda' ? config.oanda.credentials[env] !== null : config.credentials[env] !== null;
}

/** Trading REST base URL for an environment. */
export function tradingBaseUrl(config: AppConfig, env: TradingEnvironment): string {
  if (config.venue === 'oanda') return env === 'live' ? config.oanda.endpoints.liveApi : config.oanda.endpoints.practiceApi;
  return env === 'live' ? config.endpoints.liveTrading : config.endpoints.paperTrading;
}

/** OANDA streaming base URL for an environment. */
export function oandaStreamUrl(config: AppConfig, env: TradingEnvironment): string {
  return env === 'live' ? config.oanda.endpoints.liveStream : config.oanda.endpoints.practiceStream;
}

/** Trading (trade_updates) stream URL for an environment. */
export function tradingStreamUrl(config: AppConfig, env: TradingEnvironment): string {
  const base = tradingBaseUrl(config, env);
  return base.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:') + '/stream';
}

/**
 * A live context may only run against Alpaca's real endpoints — including
 * market data, so live decisions are never made on substituted data.
 */
export function assertLiveEndpoints(config: AppConfig): void {
  if (config.venue === 'oanda') {
    if (config.oanda.endpoints.liveApi !== OANDA_LIVE_API_URL || config.oanda.endpoints.liveStream !== OANDA_LIVE_STREAM_URL) {
      throw new ConfigError('Live trading endpoints are not the pinned OANDA fxTrade URLs.');
    }
    return;
  }
  if (config.endpoints.liveTrading !== ALPACA_LIVE_TRADING_URL) {
    throw new ConfigError('Live trading endpoint is not the pinned Alpaca live URL.');
  }
  if (config.endpoints.data !== ALPACA_DATA_URL || config.endpoints.dataStream !== ALPACA_DATA_STREAM_URL) {
    throw new ConfigError('Live mode requires the standard Alpaca market data endpoints; overrides are only allowed in paper.');
  }
}
