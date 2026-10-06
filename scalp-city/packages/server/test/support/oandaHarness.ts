import type { AddressInfo } from 'node:net';
import { DateTime } from 'luxon';
import WebSocket from 'ws';
import type { ServerMessage } from '@scalp-city/shared';
import { buildServer } from '../../src/api/server.js';
import { parseConfig } from '../../src/config/env.js';
import { ManualClock } from '../../src/core/clock.js';
import { createTestLogger } from '../../src/core/logger.js';
import type { Db } from '../../src/db/db.js';
import { App } from '../../src/system/App.js';
import { FakeOanda, type FakeOandaOptions } from '../fakes/FakeOanda.js';
import { createPgliteDb } from './pglite.js';

export const NY = 'America/New_York';
export const SESSION_DATE = '2026-10-05'; // a Monday, not a US market holiday
export const ORIGIN = 'http://localhost:5173';
export const OANDA_TOKEN = 'test-oanda-token-0123456789abcdef';
export const OANDA_ACCOUNT = '101-004-12345678-001';

export interface OandaE2E {
  clock: ManualClock;
  fake: FakeOanda;
  app: App;
  db: Db;
  base: string;
  cookie: string;
  csrf: string;
  messages: ServerMessage[];
  ws: WebSocket;
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }>;
  /** Advance virtual time and let the periodic pollers observe it. */
  advance(ms: number): Promise<void>;
  waitFor<T>(fn: () => T | Promise<T>, label: string, timeoutMs?: number): Promise<NonNullable<T>>;
  close(): Promise<void>;
}

/** OANDA instruments the workers trade, with their starting mid prices. */
export const START_PRICES: Record<string, number> = {
  XAU_USD: 2650,
  NAS100_USD: 20_500,
  GBP_USD: 1.3,
  EUR_JPY: 162,
  US30_USD: 43_000,
};

export async function startOandaE2E(opts: { env?: Record<string, string>; fake?: Partial<FakeOandaOptions>; startTime?: string } = {}): Promise<OandaE2E> {
  const clock = new ManualClock(DateTime.fromISO(`${SESSION_DATE}T${opts.startTime ?? '11:00:30'}`, { zone: NY }).toMillis());
  const fake = new FakeOanda({
    clock,
    token: OANDA_TOKEN,
    accountId: OANDA_ACCOUNT,
    instruments: START_PRICES,
    sessionDate: SESSION_DATE,
    ...opts.fake,
  });
  await fake.start();
  const config = parseConfig({
    NODE_ENV: 'test',
    BROKER: 'oanda',
    TRADING_ENVIRONMENT: 'paper',
    OANDA_PRACTICE_TOKEN: OANDA_TOKEN,
    OANDA_PRACTICE_ACCOUNT_ID: OANDA_ACCOUNT,
    OANDA_PRACTICE_API_URL: fake.url,
    OANDA_PRACTICE_STREAM_URL: fake.url,
    SESSION_SECRET: 'e2e-session-secret-0123456789-abcdefghijklmnop',
    // The scripted scenarios model a 09:30 open and a 15:50 end-of-day flatten.
    OANDA_SESSION: '09:30-16:00',
    OANDA_SKIP_US_HOLIDAYS: 'true',
    OANDA_MAX_POSITION_NOTIONAL: '50000',
    OANDA_MAX_ORDER_NOTIONAL: '50000',
    OANDA_MAX_RISK_PER_TRADE: '25',
    OANDA_MAX_DAILY_LOSS: '200',
    ...opts.env,
  });
  const db = await createPgliteDb();
  const app = new App({
    config,
    db,
    clock,
    logger: createTestLogger(),
    timings: { recoveryRetryMs: 500, orderSyncMs: 2000, reconcileMs: 1000, marketDataWaitMs: 5000 },
  });
  await app.init();
  const { fastify } = await buildServer(app);
  await fastify.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(fastify.server.address() as AddressInfo).port}`;

  await app.auth.createUser('tester', 'correct-horse-battery-staple');
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'correct-horse-battery-staple' }),
  });
  if (login.status !== 200) throw new Error(`login failed ${login.status}`);
  const setCookie = login.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0]!;
  const { csrfToken } = (await login.json()) as { csrfToken: string };

  const messages: ServerMessage[] = [];
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { Cookie: cookie, Origin: ORIGIN } });
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  const api = async <T,>(method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Cookie: cookie, 'x-csrf-token': csrfToken, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };

  const waitFor = async <T,>(fn: () => T | Promise<T>, label: string, timeoutMs = 15_000): Promise<NonNullable<T>> => {
    const start = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v as NonNullable<T>;
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  const advance = async (ms: number) => {
    clock.advance(ms);
    const ctx = app.ctx;
    await Promise.allSettled([ctx.account.refreshAll(), ctx.calendar.refreshClock()]);
    fake.refreshPrices();
  };

  const close = async () => {
    ws.close();
    await fastify.close();
    await app.shutdown();
    await fake.stop();
    await db.close();
  };

  return { clock, fake, app, db, base, cookie, csrf: csrfToken, messages, ws, api, advance, waitFor, close };
}
