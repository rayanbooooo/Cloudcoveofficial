/**
 * DEV HARNESS: NOT A TRADING MODE.
 *
 * Runs the real server and UI against a protocol-level fake broker (the same
 * fakes the end-to-end tests use) with a synthetic market, an in-memory
 * database and a virtual clock pinned to a regular session. It exists to
 * develop and visually check the UI without broker access.
 *
 * Nothing here can reach a real broker: every endpoint points at the local
 * fake, so the UI shows the NON-STANDARD ENDPOINT warning the whole time.
 * Prices are synthetic. Nothing it shows says anything about real markets.
 *
 *   npm run demo                     # Alpaca-style demo (QQQ/SPY/IWM) on http://127.0.0.1:8787
 *   DEMO_SET=etf|options npm run demo # Alpaca demo with the patient ETF workers, or the classic QQQ/SPY/IWM options workers (default: fast scalpers)
 *   DEMO_BROKER=oanda npm run demo   # OANDA-style demo: gold, NAS100, GBPUSD, EURJPY, US30
 *   DEMO_OANDA_OFFERED=XAU_USD,GBP_USD,EUR_JPY DEMO_BROKER=oanda npm run demo   # an account that is not offered the others
 *   DEMO_AUTOTRADE=1 npm run demo    # also switch autotrading on (fake account)
 *
 * Hosting the demo behind a public URL (e.g. a Vercel Sandbox): set HOST=0.0.0.0,
 * PUBLIC_URL / ALLOWED_ORIGINS to that URL, COOKIE_SECURE=true and a strong
 * DEMO_PASSWORD. It is still the fake broker: never give it real credentials.
 *
 *   DEMO_SETUP=1 npm run demo        # no preset account: create yours in the browser with
 *                                    # the one-time setup code printed below (first-run flow)
 */
import { DateTime } from 'luxon';
import { buildServer } from '../../src/api/server.js';
import { parseConfig } from '../../src/config/env.js';
import type { Clock } from '../../src/core/clock.js';
import { createLogger } from '../../src/core/logger.js';
import { App } from '../../src/system/App.js';
import { FakeAlpaca } from '../fakes/FakeAlpaca.js';
import { FakeOanda } from '../fakes/FakeOanda.js';
import { createPgliteDb } from '../support/pglite.js';
import { fileURLToPath } from 'node:url';

const NY = 'America/New_York';
const SESSION_DATE = '2026-10-05'; // a Monday
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://127.0.0.1:${PORT}`;
const USER = process.env.DEMO_USER ?? 'demo';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'scalp-city-demo';
const SETUP = ['1', 'true', 'yes'].includes((process.env.DEMO_SETUP ?? '').toLowerCase());
const AUTOTRADE = ['1', 'true', 'yes'].includes((process.env.DEMO_AUTOTRADE ?? '').toLowerCase());
const START = process.env.DEMO_START ?? '11:00:30';
const BROKER = (process.env.DEMO_BROKER ?? 'alpaca').toLowerCase();
/** Alpaca demo: the fast 1-minute scalpers (default), the patient ETF workers, or the classic QQQ/SPY/IWM options workers. */
const SET = (process.env.DEMO_SET ?? 'scalp').toLowerCase();
if (SET !== 'scalp' && SET !== 'etf' && SET !== 'options') throw new Error(`DEMO_SET must be scalp, etf or options, got "${SET}"`);
const ETF_MARKETS = SET !== 'options';
if (BROKER !== 'alpaca' && BROKER !== 'oanda') throw new Error(`DEMO_BROKER must be alpaca or oanda, got "${BROKER}"`);

/** Real-time clock shifted into the fake session, so time flows at 1× from START. */
class OffsetClock implements Clock {
  private readonly offset: number;
  constructor(virtualStart: number) {
    this.offset = virtualStart - Date.now();
  }
  now(): number {
    return Date.now() + this.offset;
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ETF_START: Record<string, number> = { GLD: 300, QQQ: 600, DIA: 440, FXB: 125, FXE: 105 };

/** Morning history per symbol (minute i since the open): QQQ sells off, SPY rallies, IWM chops. ETF set: GLD sells off, DIA trends down, QQQ rallies, FXB/FXE chop. */
function historyPath(symbol: string, i: number, base: number): number {
  if (ETF_MARKETS) {
    switch (symbol) {
      case 'GLD':
        return i < 15 ? base + 0.15 * Math.sin(i) : i < 60 ? base - ((i - 15) * 1.5) / 45 : base - 1.5 + 0.02 * Math.sin(i);
      case 'QQQ':
        return i < 15 ? base + 0.3 * Math.sin(i) : base + ((i - 15) * 2.4) / 75 + 0.08 * Math.sin(i / 2);
      case 'DIA':
        return i < 15 ? base + 0.2 * Math.sin(i) : base - ((i - 15) * 2.0) / 75 + 0.05 * Math.sin(i / 2);
      default:
        return base + 0.04 * Math.sin(i / 5) + 0.015 * Math.sin(i / 1.7);
    }
  }
  switch (symbol) {
    case 'QQQ':
      return i < 15 ? base + 0.3 * Math.sin(i) : i < 60 ? base - ((i - 15) * 3) / 45 : base - 3 + 0.05 * Math.sin(i);
    case 'SPY':
      return i < 15 ? base + 0.2 * Math.sin(i) : i < 60 ? base + ((i - 15) * 2.2) / 45 : base + 2.2 + 0.05 * Math.sin(i);
    default:
      return base + 0.35 * Math.sin(i / 5) + 0.1 * Math.sin(i / 1.7);
  }
}

/** Opening act for the live session: QQQ reverses up, SPY rolls over. Then a seeded regime walk. */
function driftPerMinute(symbol: string, minute: number, regime: number): number {
  if (ETF_MARKETS) {
    if (minute < 6) return symbol === 'GLD' ? 0.45 : symbol === 'DIA' ? -0.3 : 0;
    return regime * (symbol === 'FXB' || symbol === 'FXE' ? 0.01 : 0.12);
  }
  if (minute < 6) return symbol === 'QQQ' ? 0.8 : symbol === 'SPY' ? -0.55 : 0;
  const scale = symbol === 'IWM' ? 0.08 : 0.25;
  return regime * scale;
}


/**
 * OANDA demo scenario. Each instrument gets a morning path that ends in the
 * state the demo wants to show, so the city has variety within a minute or two:
 * gold reverses up (long), NAS100 reverses down (short), GBPUSD leans up and
 * builds charge, EURJPY chops (watching), US30 trends down (no cross).
 * Fractions are of the starting price. Entirely synthetic.
 */
const OANDA_START: Record<string, number> = { XAU_USD: 2650, NAS100_USD: 20_500, GBP_USD: 1.3, EUR_JPY: 162, US30_USD: 43_000 };
/** Per-minute noise as a fraction of price, so ATR (and so stop distance) is realistic for each market. */
const OANDA_NOISE: Record<string, number> = { XAU_USD: 0.00028, NAS100_USD: 0.0004, GBP_USD: 0.00012, EUR_JPY: 0.00016, US30_USD: 0.0003 };

function oandaPath(symbol: string, i: number, base: number): number {
  const wave = Math.sin(i * 1.9) * 0.00012 + Math.sin(i * 0.7) * 0.00008;
  const f = (x: number) => base * (1 + x);
  switch (symbol) {
    case 'XAU_USD': // opening range, sell-off, sharp V back above VWAP (long)
      return i < 15 ? f(wave) : i < 78 ? f(-((i - 15) / 63) * 0.0045 + wave) : f(-0.0045 + ((i - 78) / 12) * 0.0105 + wave);
    case 'NAS100_USD': // rally then sharp drop through VWAP (short)
      return i < 15 ? f(wave) : i < 78 ? f(((i - 15) / 63) * 0.006 + wave) : f(0.006 - ((i - 78) / 12) * 0.0135 + wave);
    case 'GBP_USD':
      return i < 15 ? f(wave) : f(((i - 15) / 75) * 0.0012 + wave);
    case 'US30_USD':
      return i < 15 ? f(wave) : f(-((i - 15) / 75) * 0.005 + wave);
    default:
      return f(wave * 2 + Math.sin(i / 9) * 0.0003);
  }
}

/** Tick volume: a quiet morning, busier into the reversal bars. */
function oandaVolume(symbol: string, i: number): number {
  const reversal = (symbol === 'XAU_USD' || symbol === 'NAS100_USD') && i >= 78;
  return (reversal ? 150 : 90) + Math.round(20 * Math.abs(Math.sin(i / 3)));
}

/** Live drift per minute (fraction of price) once the demo is running. */
function oandaDrift(symbol: string, minute: number): number {
  switch (symbol) {
    case 'XAU_USD':
      return minute < 20 ? 0.0004 : 0.00002;
    case 'NAS100_USD':
      return minute < 20 ? -0.0005 : -0.00002;
    case 'GBP_USD':
      return 0.00004;
    case 'US30_USD':
      return -0.00008;
    default:
      return 0;
  }
}

async function main(): Promise<void> {
  if (BROKER === 'oanda') return mainOanda();
  const virtualStart = DateTime.fromISO(`${SESSION_DATE}T${START}`, { zone: NY }).toMillis();
  const clock = new OffsetClock(virtualStart);
  const fake = new FakeAlpaca({
    clock,
    keyId: 'PKDEMOHARNESS',
    secretKey: 'demo-harness-secret',
    symbols: ETF_MARKETS ? ETF_START : { QQQ: 600, SPY: 570, IWM: 220 },
    sessionDate: SESSION_DATE,
    historyPath,
    historyVolume: (_s, i) => 8_000 + Math.round(4_000 * Math.abs(Math.sin(i / 3))),
  });
  await fake.start();

  const config = parseConfig({
    NODE_ENV: 'development',
    TRADING_ENVIRONMENT: 'paper',
    ALPACA_API_KEY: 'PKDEMOHARNESS',
    ALPACA_API_SECRET: 'demo-harness-secret',
    ALPACA_PAPER_BASE_URL: fake.url,
    ALPACA_DATA_URL: fake.url,
    ALPACA_DATA_STREAM_URL: fake.wsUrl,
    ALPACA_OPTIONS_FEED: 'opra',
    ALPACA_WORKER_SET: SET,
    SESSION_SECRET: 'demo-harness-session-secret-not-for-production',
    DATABASE_URL: 'pglite://memory', // the harness passes its own in-memory database below
    MAX_POSITION_SIZE: '5000',
    MAX_ORDER_NOTIONAL: '5000',
    // Loose enough for the fast scalpers to show how often they trade (a fresh real install is much slower).
    MAX_TRADES_PER_DAY: '300',
    MAX_CONCURRENT_POSITIONS: '5',
    MAX_ORDERS_PER_MINUTE: '40',
    MAX_DAILY_LOSS: '1000',
    HOST,
    PORT: String(PORT),
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
    COOKIE_SECURE: process.env.COOKIE_SECURE,
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  });
  const logger = createLogger(config.logLevel, process.stdout.isTTY === true);
  const db = await createPgliteDb();
  const app = new App({ config, db, clock, logger });
  await app.init();
  if (!SETUP) {
    await app.auth.createUser(USER, PASSWORD); // closes first-run setup
    app.setupCode = null;
  }

  const webDist = fileURLToPath(new URL('../../../web/dist', import.meta.url));
  const { fastify } = await buildServer(app, { webDist });
  await fastify.listen({ host: HOST, port: PORT });

  // Synthetic tape: ~2.5 prints per second per symbol, official bars on the minute.
  const rnd = mulberry32(20261005);
  const regimes = new Map<string, number>(
    ETF_MARKETS
      ? [
          ['GLD', 1],
          ['QQQ', 1],
          ['DIA', -1],
          ['FXB', 0],
          ['FXE', 0],
        ]
      : [
          ['QQQ', 1],
          ['SPY', -1],
          ['IWM', 0],
        ],
  );
  let lastMinute = Math.floor(clock.now() / 60_000);
  const startMinute = lastMinute;
  const tape = setInterval(() => {
    const minute = Math.floor(clock.now() / 60_000);
    if (minute !== lastMinute) {
      for (const s of fake.prices.keys()) fake.closeBar(s);
      lastMinute = minute;
      if ((minute - startMinute) % 9 === 0) for (const s of regimes.keys()) regimes.set(s, Math.round(rnd() * 2 - 1));
    }
    const m = minute - startMinute;
    for (const [s, p] of fake.prices) {
      const drift = driftPerMinute(s, m, regimes.get(s) ?? 0) / 150;
      const noise = (rnd() - 0.5) * (s === 'IWM' || s === 'FXB' || s === 'FXE' ? 0.03 : 0.06);
      fake.trade(s, p.last + drift + noise, Math.floor(50 + rnd() * 400));
    }
  }, 400);

  if (AUTOTRADE) {
    // Waits for recovery to finish; the same switches a user flips in the UI.
    const t = setInterval(() => {
      const ctx = app.ctx;
      if (!ctx?.workers) return;
      clearInterval(t);
      for (const w of ctx.workers.all()) ctx.workers.setEnabled(w.config.id, true, 'demo-harness');
      ctx.controls.setAutotrading(true, 'demo-harness');
    }, 500);
  }

  const banner = [
    '',
    '  ███ SCALP CITY · DEV HARNESS (synthetic market, fake broker, in-memory DB)',
    '  This is NOT paper trading on Alpaca and NOT live trading. No real broker is contacted.',
    `  open        ${PUBLIC_URL}`,
    SETUP ? `  first run   create your account in the browser with setup code ${app.setupCode}` : `  sign in     ${USER} / ${PASSWORD}`,
    `  session     ${SESSION_DATE} from ${START} New York (virtual clock, real-time speed)`,
    `  autotrade   ${AUTOTRADE ? 'ON (fake account)' : 'off — set DEMO_AUTOTRADE=1 to watch workers trade'}`,
    '',
  ];
  for (const l of banner) console.log(l);

  const shutdown = async () => {
    clearInterval(tape);
    await fastify.close();
    await app.shutdown();
    await fake.stop();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}


async function mainOanda(): Promise<void> {
  const virtualStart = DateTime.fromISO(`${SESSION_DATE}T${START}`, { zone: NY }).toMillis();
  const clock = new OffsetClock(virtualStart);
  const token = 'demo-harness-oanda-token-0123456789';
  const accountId = '101-004-99999999-001';
  // DEMO_OANDA_OFFERED=XAU_USD,GBP_USD,EUR_JPY: an account that is not offered the other markets (see how the app copes).
  const offered = (process.env.DEMO_OANDA_OFFERED ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const startPrices = offered.length ? Object.fromEntries(Object.entries(OANDA_START).filter(([sym]) => offered.includes(sym))) : OANDA_START;
  const fake = new FakeOanda({
    clock,
    token,
    accountId,
    instruments: startPrices,
    sessionDate: SESSION_DATE,
    historyPath: oandaPath,
    historyVolume: oandaVolume,
  });
  await fake.start();

  const config = parseConfig({
    NODE_ENV: 'development',
    BROKER: 'oanda',
    TRADING_ENVIRONMENT: 'paper',
    OANDA_PRACTICE_TOKEN: token,
    OANDA_PRACTICE_ACCOUNT_ID: accountId,
    OANDA_PRACTICE_API_URL: fake.url,
    OANDA_PRACTICE_STREAM_URL: fake.url,
    SESSION_SECRET: 'demo-harness-session-secret-not-for-production',
    DATABASE_URL: 'pglite://memory',
    // The demo's morning paths assume a 09:30 open.
    OANDA_SESSION: '09:30-16:00',
    OANDA_SKIP_US_HOLIDAYS: 'true',
    OANDA_MAX_DAILY_LOSS: '1000',
    OANDA_MAX_RISK_PER_TRADE: '50',
    OANDA_MAX_POSITION_NOTIONAL: '200000',
    OANDA_MAX_ORDER_NOTIONAL: '200000',
    OANDA_MAX_TRADES_PER_DAY: '20',
    HOST,
    PORT: String(PORT),
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
    COOKIE_SECURE: process.env.COOKIE_SECURE,
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  });
  const logger = createLogger(config.logLevel, process.stdout.isTTY === true);
  const db = await createPgliteDb();
  const app = new App({ config, db, clock, logger });
  await app.init();
  if (!SETUP) {
    await app.auth.createUser(USER, PASSWORD);
    app.setupCode = null;
  }

  const webDist = fileURLToPath(new URL('../../../web/dist', import.meta.url));
  const { fastify } = await buildServer(app, { webDist });
  await fastify.listen({ host: HOST, port: PORT });

  // Synthetic tape: a price update every 400 ms per instrument (one tick each), drifting per the scenario.
  const rnd = mulberry32(20261005);
  const startMinute = Math.floor(clock.now() / 60_000);
  const tape = setInterval(() => {
    const minute = Math.floor(clock.now() / 60_000) - startMinute;
    for (const sym of Object.keys(startPrices)) {
      const m = fake.mid(sym);
      const drift = oandaDrift(sym, minute) / 150;
      const noise = (rnd() - 0.5) * (OANDA_NOISE[sym] ?? 0.0002) * 0.9;
      fake.tick(sym, m * (1 + drift + noise));
    }
  }, 400);

  if (AUTOTRADE) {
    const t = setInterval(() => {
      const ctx = app.ctx;
      if (!ctx?.workers) return;
      clearInterval(t);
      for (const w of ctx.workers.all()) ctx.workers.setEnabled(w.config.id, true, 'demo-harness');
      ctx.controls.setAutotrading(true, 'demo-harness');
    }, 500);
  }

  const banner = [
    '',
    '  ███ SCALP CITY · DEV HARNESS (synthetic market, FAKE OANDA, in-memory DB)',
    '  This is NOT an OANDA practice account and NOT live trading. No real broker is contacted.',
    `  open        ${PUBLIC_URL}`,
    SETUP ? `  first run   create your account in the browser with setup code ${app.setupCode}` : `  sign in     ${USER} / ${PASSWORD}`,
    `  session     ${SESSION_DATE} from ${START} New York (virtual clock, real-time speed)`,
    `  autotrade   ${AUTOTRADE ? 'ON (fake account)' : 'off — set DEMO_AUTOTRADE=1 to watch workers trade'}`,
    '',
  ];
  for (const l of banner) console.log(l);

  const shutdown = async () => {
    clearInterval(tape);
    await fastify.close();
    await app.shutdown();
    await fake.stop();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
