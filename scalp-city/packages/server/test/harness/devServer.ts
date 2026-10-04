/**
 * DEV HARNESS: NOT A TRADING MODE.
 *
 * Runs the real server and UI against FakeAlpaca (the protocol-level fake
 * broker used by the end-to-end tests) with a synthetic market, an in-memory
 * database and a virtual clock pinned to a regular session. It exists to
 * develop and visually check the UI without broker access.
 *
 * Nothing here can reach a real broker: every endpoint points at the local
 * fake, so the UI shows the NON-STANDARD ENDPOINT warning the whole time.
 * Prices are synthetic. Nothing it shows says anything about real markets.
 *
 *   npm run demo                     # build the UI, start on http://127.0.0.1:8787
 *   DEMO_AUTOTRADE=1 npm run demo    # also switch autotrading on (fake paper account)
 */
import { DateTime } from 'luxon';
import { buildServer } from '../../src/api/server.js';
import { parseConfig } from '../../src/config/env.js';
import type { Clock } from '../../src/core/clock.js';
import { createLogger } from '../../src/core/logger.js';
import { App } from '../../src/system/App.js';
import { FakeAlpaca } from '../fakes/FakeAlpaca.js';
import { createPgliteDb } from '../support/pglite.js';
import { fileURLToPath } from 'node:url';

const NY = 'America/New_York';
const SESSION_DATE = '2026-10-05'; // a Monday
const PORT = Number(process.env.PORT ?? 8787);
const USER = process.env.DEMO_USER ?? 'demo';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'scalp-city-demo';
const AUTOTRADE = ['1', 'true', 'yes'].includes((process.env.DEMO_AUTOTRADE ?? '').toLowerCase());
const START = process.env.DEMO_START ?? '11:00:30';

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

/** Morning history per symbol (minute i since the open): QQQ sells off, SPY rallies, IWM chops. */
function historyPath(symbol: string, i: number, base: number): number {
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
  if (minute < 6) return symbol === 'QQQ' ? 0.8 : symbol === 'SPY' ? -0.55 : 0;
  const scale = symbol === 'IWM' ? 0.08 : 0.25;
  return regime * scale;
}

async function main(): Promise<void> {
  const virtualStart = DateTime.fromISO(`${SESSION_DATE}T${START}`, { zone: NY }).toMillis();
  const clock = new OffsetClock(virtualStart);
  const fake = new FakeAlpaca({
    clock,
    keyId: 'PKDEMOHARNESS',
    secretKey: 'demo-harness-secret',
    symbols: { QQQ: 600, SPY: 570, IWM: 220 },
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
    SESSION_SECRET: 'demo-harness-session-secret-not-for-production',
    DATABASE_URL: 'pglite://memory', // the harness passes its own in-memory database below
    MAX_POSITION_SIZE: '5000',
    MAX_ORDER_NOTIONAL: '5000',
    HOST: '127.0.0.1',
    PORT: String(PORT),
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  });
  const logger = createLogger(config.logLevel, process.stdout.isTTY === true);
  const db = await createPgliteDb();
  const app = new App({ config, db, clock, logger });
  await app.init();
  await app.auth.createUser(USER, PASSWORD);

  const webDist = fileURLToPath(new URL('../../../web/dist', import.meta.url));
  const { fastify } = await buildServer(app, { webDist });
  await fastify.listen({ host: '127.0.0.1', port: PORT });

  // Synthetic tape: ~2.5 prints per second per symbol, official bars on the minute.
  const rnd = mulberry32(20261005);
  const regimes = new Map<string, number>([
    ['QQQ', 1],
    ['SPY', -1],
    ['IWM', 0],
  ]);
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
      const noise = (rnd() - 0.5) * (s === 'IWM' ? 0.03 : 0.06);
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
    `  open        http://127.0.0.1:${PORT}`,
    `  sign in     ${USER} / ${PASSWORD}`,
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
