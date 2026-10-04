import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { OptionsFeed, RiskLimits, StockFeed, TradingEnvironment } from '@scalp-city/shared';

/** The only URL a LIVE trading context will ever talk to. */
export const ALPACA_LIVE_TRADING_URL = 'https://api.alpaca.markets';
export const ALPACA_PAPER_TRADING_URL = 'https://paper-api.alpaca.markets';
export const ALPACA_DATA_URL = 'https://data.alpaca.markets';
export const ALPACA_DATA_STREAM_URL = 'wss://stream.data.alpaca.markets';

export interface Credentials {
  keyId: string;
  secretKey: string;
}

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  host: string;
  port: number;
  /** Environment the server starts in. */
  tradingEnvironment: TradingEnvironment;
  credentials: Record<TradingEnvironment, Credentials | null>;
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
  MAX_ORDER_NOTIONAL: positiveNumber(1000),
  MAX_CONTRACTS: positiveInt(20),
  MAX_SHARES: positiveInt(100),
  MAX_CONCURRENT_POSITIONS: positiveInt(3),
  MAX_TRADES_PER_DAY: positiveInt(10),
  MAX_ORDERS_PER_MINUTE: positiveInt(10),
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
  if (paperTrading !== ALPACA_PAPER_TRADING_URL) nonStandardEndpoints.push(paperTrading);
  if (data !== ALPACA_DATA_URL) nonStandardEndpoints.push(data);
  if (dataStream !== ALPACA_DATA_STREAM_URL) nonStandardEndpoints.push(dataStream);

  // ── Credentials ────────────────────────────────────────────────────────
  const generic = pair(e.ALPACA_API_KEY, e.ALPACA_API_SECRET, 'ALPACA_API_KEY/ALPACA_API_SECRET');
  const paperExplicit = pair(e.ALPACA_PAPER_API_KEY, e.ALPACA_PAPER_API_SECRET, 'ALPACA_PAPER_API_KEY/SECRET');
  const liveExplicit = pair(e.ALPACA_LIVE_API_KEY, e.ALPACA_LIVE_API_SECRET, 'ALPACA_LIVE_API_KEY/SECRET');
  const env = e.TRADING_ENVIRONMENT as TradingEnvironment;
  const credentials: Record<TradingEnvironment, Credentials | null> = {
    paper: paperExplicit ?? (env === 'paper' ? generic : null),
    live: liveExplicit ?? (env === 'live' ? generic : null),
  };

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
  const positionRaw = e.MAX_POSITION_NOTIONAL ?? e.MAX_POSITION_SIZE;
  const maxPositionNotional = positionRaw === undefined ? 1000 : Number(positionRaw);
  if (!Number.isFinite(maxPositionNotional) || maxPositionNotional <= 0) {
    throw new ConfigError(`MAX_POSITION_SIZE must be a positive number, got "${positionRaw}"`);
  }
  const riskDefaults: RiskLimits = {
    maxDailyLoss: e.MAX_DAILY_LOSS,
    maxPositionNotional,
    maxOrderNotional: e.MAX_ORDER_NOTIONAL,
    maxContracts: e.MAX_CONTRACTS,
    maxShares: e.MAX_SHARES,
    maxConcurrentPositions: e.MAX_CONCURRENT_POSITIONS,
    maxTradesPerDay: e.MAX_TRADES_PER_DAY,
    maxOrdersPerMinute: e.MAX_ORDERS_PER_MINUTE,
    maxPriceDeviationPct: 5,
    noEntriesBeforeCloseMinutes: 10,
    pdtGuard: true,
  };

  const symbols = (e.SYMBOLS ?? 'QQQ,SPY,IWM')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  for (const s of symbols) {
    if (!/^[A-Z.]{1,10}$/.test(s)) throw new ConfigError(`SYMBOLS contains an invalid ticker: ${s}`);
  }

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
    tradingEnvironment: env,
    credentials,
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

/** Trading REST base URL for an environment. */
export function tradingBaseUrl(config: AppConfig, env: TradingEnvironment): string {
  return env === 'live' ? config.endpoints.liveTrading : config.endpoints.paperTrading;
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
  if (config.endpoints.liveTrading !== ALPACA_LIVE_TRADING_URL) {
    throw new ConfigError('Live trading endpoint is not the pinned Alpaca live URL.');
  }
  if (config.endpoints.data !== ALPACA_DATA_URL || config.endpoints.dataStream !== ALPACA_DATA_STREAM_URL) {
    throw new ConfigError('Live mode requires the standard Alpaca market data endpoints; overrides are only allowed in paper.');
  }
}
