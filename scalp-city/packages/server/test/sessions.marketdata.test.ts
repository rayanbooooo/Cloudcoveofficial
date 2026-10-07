import { DateTime } from 'luxon';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionPolicy, StockFeed } from '@scalp-city/shared';
import { AlpacaBrokerAdapter } from '../src/broker/alpaca/AlpacaBrokerAdapter.js';
import { ManualClock } from '../src/core/clock.js';
import { EventBus } from '../src/core/eventBus.js';
import { createTestLogger } from '../src/core/logger.js';
import type { Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrations.js';
import { MarketCalendar } from '../src/market/MarketCalendar.js';
import { AlpacaMarketDataProvider } from '../src/marketdata/alpaca/AlpacaMarketDataProvider.js';
import { MarketDataService, stockFeedLabel } from '../src/marketdata/MarketDataService.js';
import { FakeAlpaca, type FakeAlpacaOptions } from './fakes/FakeAlpaca.js';
import { createPgliteDb } from './support/pglite.js';

/**
 * Market data across the sessions: which stream and which history each hour comes from, and how old a quote may
 * be before it stops counting. The Alpaca fake serves each feed only the hours its plan covers.
 */

const NY = 'America/New_York';
const at = (iso: string): number => DateTime.fromISO(iso, { zone: NY }).toMillis();
const SYMBOLS = ['QQQ', 'SPY'];
const KEYS = { keyId: 'K', secretKey: 'S' };

const waitFor = async (cond: () => boolean, label: string, ms = 8000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

interface Rig {
  clock: ManualClock;
  fake: FakeAlpaca;
  provider: AlpacaMarketDataProvider;
  md: MarketDataService;
  calendar: MarketCalendar;
}

const open: { rig?: Rig; db?: Db } = {};

async function rig(o: {
  now: string;
  policy: SessionPolicy;
  stockFeed: StockFeed;
  overnightFeed?: 'overnight' | 'boats' | null;
  fake?: Partial<FakeAlpacaOptions>;
  maxDataAgeMs?: number;
  offHoursMaxDataAgeMs?: number;
}): Promise<Rig> {
  const clock = new ManualClock(at(o.now));
  const fake = new FakeAlpaca({ clock, ...KEYS, symbols: { QQQ: 600, SPY: 570 }, sessionDate: '2026-10-05', sessions: true, ...o.fake });
  await fake.start();
  const db = await createPgliteDb();
  await migrate(db);
  const logger = createTestLogger();
  const bus = new EventBus(logger);
  const broker = new AlpacaBrokerAdapter({ env: 'paper', baseUrl: fake.url, streamUrl: `${fake.wsUrl}/stream`, credentials: KEYS, logger, clock });
  const calendar = new MarketCalendar(broker, db, clock, logger, 2000, o.policy);
  await calendar.start();
  const provider = new AlpacaMarketDataProvider({
    dataUrl: fake.url,
    dataStreamUrl: fake.wsUrl,
    stockFeed: o.stockFeed,
    overnightFeed: o.overnightFeed ?? null,
    optionsFeed: 'opra',
    credentials: KEYS,
    logger,
    clock,
  });
  const md = new MarketDataService(provider, calendar, bus, clock, logger, {
    env: 'paper',
    symbols: SYMBOLS,
    maxDataAgeMs: o.maxDataAgeMs ?? 5000,
    offHoursMaxDataAgeMs: o.offHoursMaxDataAgeMs ?? 30_000,
    maxOptionQuoteAgeMs: 10_000,
    paperAllowIndicativeOptions: false,
  });
  open.rig = { clock, fake, provider, md, calendar };
  open.db = db;
  return open.rig;
}

afterEach(async () => {
  await open.rig?.md.stop();
  open.rig?.calendar.stop();
  await open.rig?.fake.stop();
  await open.db?.close();
  open.rig = undefined;
  open.db = undefined;
});

describe('the stream that carries the hour', () => {
  it('watches the daytime stream by day and the overnight stream at night, and says so when it changes', async () => {
    const { clock, provider, md, fake } = await rig({ now: '2026-10-05T22:30:30', policy: 'all', stockFeed: 'iex', overnightFeed: 'overnight', fake: { dataPlan: 'basic', historyFrom: '2026-10-05T04:00' } });
    const seen: string[] = [];
    provider.onStatus((stream, st) => stream === 'stock' && seen.push(st.state));
    await md.start();
    // Both stock streams stay connected, so the changeover at 04:00 and 20:00 is not a reconnect.
    await waitFor(() => provider.status().stock.state === 'CONNECTED', 'overnight stream connected');
    expect(provider.stockFeed).toBe('overnight');
    expect(md.status().stockFeedLabel).toBe(stockFeedLabel('overnight').label);

    // The night's prints come in on the overnight feed (the free plan's, whose trades are 15 minutes late)...
    expect(md.barsDelayedReason()).toMatch(/15 minutes late/);
    fake.trade('QQQ', 601.5, 100);
    await waitFor(() => md.state('QQQ')!.last === 601.5, 'overnight trade received');
    expect(md.state('QQQ')!.lastTradeAt).toBe(clock.now() - 15 * 60_000);
    expect(md.state('QQQ')!.quoteAt).toBe(clock.now()); // while its quotes are real time

    // ...and when the clock reaches 04:00 the data service is told the daytime stream now carries the hour.
    seen.length = 0;
    clock.set(at('2026-10-06T04:00:05'));
    await waitFor(() => provider.stockFeed === 'iex' && seen.length > 0, 'feed change announced', 5000);
    expect(md.status().stockFeed).toBe('iex');
    expect(provider.status().stock.state).toBe('CONNECTED');
    expect(md.barsDelayedReason()).toBeNull();
  });

  it('has a single stream and no overnight feed when the deployment does not trade overnight', async () => {
    const { provider, md } = await rig({ now: '2026-10-05T06:30:30', policy: 'extended', stockFeed: 'sip', fake: { dataPlan: 'plus', historyFrom: '2026-10-05T04:00' } });
    await md.start();
    await waitFor(() => provider.status().stock.state === 'CONNECTED', 'connected');
    expect(provider.stockFeed).toBe('sip');
    expect(md.status().stockFeedLabel).toBe('LIVE · SIP');
  });

  it('reports a refused overnight feed instead of waiting for data that cannot come', async () => {
    // A free-plan account asking for the paid plan’s overnight feed is refused with 409 at authentication.
    const { provider, md } = await rig({ now: '2026-10-05T22:30:30', policy: 'all', stockFeed: 'iex', overnightFeed: 'boats', fake: { dataPlan: 'basic', historyFrom: '2026-10-05T04:00' } });
    await md.start();
    await waitFor(() => provider.status().stock.state === 'ERROR', 'overnight stream refused');
    expect(provider.status().stock.lastError).toMatch(/does not include the boats overnight feed/);
    expect(md.freshness('QQQ')).toMatchObject({ stale: true, reason: 'market data error' });
  });
});

describe('history from the feed that carried each hour', () => {
  it('on the free plan warms up from IEX by day and leaves every other hour as a gap (the derived overnight feed has no history)', async () => {
    const { md } = await rig({ now: '2026-10-05T22:30:30', policy: 'all', stockFeed: 'iex', overnightFeed: 'overnight', fake: { dataPlan: 'basic', historyFrom: '2026-10-05T04:00' } });
    await md.start();
    const hours = new Set(md.finalBars('QQQ').map((b) => DateTime.fromMillis(b.t, { zone: NY }).hour));
    // IEX covers 08:00–17:00: nothing exists at 04:00–08:00, 17:00–20:00, or overnight.
    for (const h of [8, 12, 16]) expect(hours.has(h), `hour ${h}`).toBe(true);
    for (const h of [4, 5, 6, 7, 17, 18, 19, 20, 21, 22]) expect(hours.has(h), `hour ${h}`).toBe(false);
  });

  it('on the paid plan the day is unbroken from 04:00 to 20:00', async () => {
    const { md } = await rig({ now: '2026-10-05T22:30:30', policy: 'all', stockFeed: 'sip', overnightFeed: 'boats', fake: { dataPlan: 'plus', historyFrom: '2026-10-05T04:00' } });
    await md.start();
    const hours = new Set(md.finalBars('QQQ').map((b) => DateTime.fromMillis(b.t, { zone: NY }).hour));
    for (const h of [4, 6, 9, 12, 17, 19, 20, 22]) expect(hours.has(h), `hour ${h}`).toBe(true);
  });

  it('a feed the plan does not cover loses only its own stretch of history', async () => {
    // Free plan, but the paid plan’s overnight feed asked for: the night’s history is refused (403), the day’s still loads.
    const { md } = await rig({ now: '2026-10-05T22:30:30', policy: 'all', stockFeed: 'iex', overnightFeed: 'boats', fake: { dataPlan: 'basic', historyFrom: '2026-10-05T04:00' } });
    await md.warmUp();
    const hours = new Set(md.finalBars('QQQ').map((b) => DateTime.fromMillis(b.t, { zone: NY }).hour));
    expect(hours.has(12)).toBe(true);
    expect(hours.has(21)).toBe(false);
  });
});

describe('how old a quote may be', () => {
  it('is 5 s in the regular session and 30 s outside it', async () => {
    const reg = await rig({ now: '2026-10-05T11:00:30', policy: 'extended', stockFeed: 'sip', fake: { dataPlan: 'plus', historyFrom: '2026-10-05T04:00' } });
    await reg.md.start();
    await waitFor(() => reg.provider.status().stock.state === 'CONNECTED', 'connected');
    reg.fake.trade('QQQ', 600.5, 100);
    await waitFor(() => reg.md.state('QQQ')!.last === 600.5, 'trade');
    reg.clock.advance(20_000);
    expect(reg.md.freshness('QQQ').stale).toBe(true); // 20 s is too old at 11:00
    await reg.md.stop();
    reg.calendar.stop();
    await reg.fake.stop();
    await open.db?.close();

    const pre = await rig({ now: '2026-10-05T06:30:30', policy: 'extended', stockFeed: 'sip', fake: { dataPlan: 'plus', historyFrom: '2026-10-05T04:00' } });
    await pre.md.start();
    await waitFor(() => pre.provider.status().stock.state === 'CONNECTED', 'connected');
    pre.fake.trade('QQQ', 600.5, 100);
    await waitFor(() => pre.md.state('QQQ')!.last === 600.5, 'trade');
    pre.clock.advance(20_000);
    expect(pre.md.freshness('QQQ').stale).toBe(false); // but fine at 06:30
    pre.clock.advance(15_000);
    const f = pre.md.freshness('QQQ');
    expect(f.stale).toBe(true);
    expect(f.reason).toContain('35.0s');
  });

  it('is never tighter off-hours than in the regular session', async () => {
    const { clock, md, provider, fake } = await rig({ now: '2026-10-05T06:30:30', policy: 'extended', stockFeed: 'sip', maxDataAgeMs: 60_000, offHoursMaxDataAgeMs: 10_000, fake: { dataPlan: 'plus', historyFrom: '2026-10-05T04:00' } });
    await md.start();
    await waitFor(() => provider.status().stock.state === 'CONNECTED', 'connected');
    fake.trade('QQQ', 600.5, 100);
    await waitFor(() => md.state('QQQ')!.last === 600.5, 'trade');
    clock.advance(45_000);
    expect(md.freshness('QQQ').stale).toBe(false);
  });

  it('names the free IEX feed’s hours when that is why there is no data', async () => {
    const { md, provider } = await rig({ now: '2026-10-05T06:30:30', policy: 'extended', stockFeed: 'iex', fake: { dataPlan: 'basic', historyFrom: '2026-10-05T04:00' } });
    await md.start();
    await waitFor(() => provider.status().stock.state === 'CONNECTED', 'connected');
    const f = md.freshness('QQQ');
    expect(f.stale).toBe(true);
    expect(f.reason).toMatch(/free IEX feed has no data at this hour/);
    expect(f.reason).toMatch(/08:00–17:00/);
  });
});

describe('what the feed in use can support', () => {
  it('says how long IEX will keep reporting: until 17:00, and nothing before 08:00', async () => {
    const at1645 = await rig({ now: '2026-10-05T16:45:00', policy: 'extended', stockFeed: 'iex', fake: { dataPlan: 'basic' } });
    expect(at1645.md.dataMinutesLeft()).toBe(15);
    at1645.clock.set(at('2026-10-05T08:00:00'));
    expect(at1645.md.dataMinutesLeft()).toBe(540);
    at1645.clock.set(at('2026-10-05T06:30:00'));
    expect(at1645.md.dataMinutesLeft()).toBe(0);
    at1645.clock.set(at('2026-10-05T17:00:00'));
    expect(at1645.md.dataMinutesLeft()).toBe(0);
  });

  it('has no such limit on the feeds that cover their whole session', async () => {
    const sip = await rig({ now: '2026-10-05T19:55:00', policy: 'extended', stockFeed: 'sip', fake: { dataPlan: 'plus' } });
    expect(sip.md.dataMinutesLeft()).toBeNull();
    expect(sip.md.barsDelayedReason()).toBeNull();
  });

  it('knows whether the last minutes all traded', async () => {
    const { md } = await rig({ now: '2026-10-05T06:30:30', policy: 'extended', stockFeed: 'sip', fake: { dataPlan: 'plus' } });
    const T = at('2026-10-05T06:00:00');
    const bar = (t: number) => ({ symbol: 'QQQ', timeframe: '1Min' as const, t, o: 600, h: 600.1, l: 599.9, c: 600, v: 100, n: 3, vw: 600, final: true, source: 'provider' as const });
    expect(md.barsUnbroken('QQQ', 4)).toBe(false); // no bars yet
    for (const m of [0, 1, 2]) md.handle({ kind: 'bar', bar: bar(T + m * 60_000), updated: false });
    expect(md.barsUnbroken('QQQ', 4)).toBe(false); // fewer than four
    md.handle({ kind: 'bar', bar: bar(T + 3 * 60_000), updated: false });
    expect(md.barsUnbroken('QQQ', 4)).toBe(true);
    md.handle({ kind: 'bar', bar: bar(T + 5 * 60_000), updated: false }); // minute 4 had no trade
    expect(md.barsUnbroken('QQQ', 4)).toBe(false);
    md.handle({ kind: 'bar', bar: bar(T + 6 * 60_000), updated: false });
    md.handle({ kind: 'bar', bar: bar(T + 7 * 60_000), updated: false });
    md.handle({ kind: 'bar', bar: bar(T + 8 * 60_000), updated: false });
    expect(md.barsUnbroken('QQQ', 4)).toBe(true); // four in a row again
  });
});

describe('feed labels', () => {
  it('describe the overnight feeds without claiming more than is known', () => {
    expect(stockFeedLabel('boats')).toMatchObject({ label: 'LIVE · OVERNIGHT (BOATS)', realtime: true, partialVolume: true });
    expect(stockFeedLabel('overnight')).toMatchObject({ label: 'OVERNIGHT FEED · TRADES 15 MIN LATE', realtime: true, partialVolume: true });
  });
});
