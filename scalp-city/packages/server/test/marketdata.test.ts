import { DateTime } from 'luxon';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AlpacaBrokerAdapter } from '../src/broker/alpaca/AlpacaBrokerAdapter.js';
import { ManualClock } from '../src/core/clock.js';
import { EventBus } from '../src/core/eventBus.js';
import { createTestLogger } from '../src/core/logger.js';
import type { Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrations.js';
import { MarketCalendar } from '../src/market/MarketCalendar.js';
import { AlpacaMarketDataProvider } from '../src/marketdata/alpaca/AlpacaMarketDataProvider.js';
import { BarStore } from '../src/marketdata/BarStore.js';
import { LruSet, MarketDataService } from '../src/marketdata/MarketDataService.js';
import { FakeAlpaca } from './fakes/FakeAlpaca.js';
import { createPgliteDb } from './support/pglite.js';

const NY = 'America/New_York';
const START = DateTime.fromISO('2026-10-05T11:00:30', { zone: NY }).toMillis();
const waitFor = async (cond: () => boolean, label: string, ms = 8000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('BarStore', () => {
  const M = 60_000;
  const T = Math.floor(START / M) * M;

  it('aggregates a forming bar from trades and closes it once on the provider bar', () => {
    const s = new BarStore('QQQ');
    s.onTrade(600, 100, T + 1000);
    s.onTrade(601, 200, T + 2000);
    const f = s.formingBar()!;
    expect([f.o, f.h, f.l, f.c, f.v]).toEqual([600, 601, 600, 601, 300]);
    const ev = s.onProviderBar({ symbol: 'QQQ', timeframe: '1Min', t: T, o: 600, h: 601, l: 600, c: 601, v: 300, n: 2, vw: 600.67, final: true, source: 'provider' }, false);
    expect(ev.map((e) => e.kind)).toEqual(['closed']);
    // A duplicate delivery of the same bar is only an update.
    const again = s.onProviderBar({ symbol: 'QQQ', timeframe: '1Min', t: T, o: 600, h: 601, l: 600, c: 601, v: 300, n: 2, vw: 600.67, final: true, source: 'provider' }, false);
    expect(again.map((e) => e.kind)).toEqual(['updated']);
  });

  it('finalizes its own aggregate when no provider bar arrives within the grace period', () => {
    const s = new BarStore('QQQ');
    s.onTrade(600, 100, T + 1000);
    expect(s.tick(T + M + 1000, 5000)).toEqual([]);
    const ev = s.tick(T + M + 6000, 5000);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.kind).toBe('closed');
    expect(ev[0]!.bar.source).toBe('aggregated');
  });

  it('never emits closed for historical bars', () => {
    const s = new BarStore('QQQ');
    const ev = s.mergeHistorical([{ symbol: 'QQQ', timeframe: '1Min', t: T - M, o: 1, h: 1, l: 1, c: 1, v: 1, n: 1, vw: 1, final: true, source: 'historical' }]);
    expect(ev.every((e) => e.kind === 'updated')).toBe(true);
  });
});

describe('MarketDataService against the Alpaca wire protocol (msgpack)', () => {
  let db: Db;
  let clock: ManualClock;
  let fake: FakeAlpaca;
  let bus: EventBus;
  let md: MarketDataService;
  let provider: AlpacaMarketDataProvider;

  beforeEach(async () => {
    clock = new ManualClock(START);
    fake = new FakeAlpaca({ clock, keyId: 'K', secretKey: 'S', symbols: { QQQ: 600, SPY: 570, IWM: 220 }, sessionDate: '2026-10-05' });
    await fake.start();
    db = await createPgliteDb();
    await migrate(db);
    const logger = createTestLogger();
    bus = new EventBus(logger);
    const broker = new AlpacaBrokerAdapter({ env: 'paper', baseUrl: fake.url, streamUrl: `${fake.wsUrl}/stream`, credentials: { keyId: 'K', secretKey: 'S' }, logger, clock });
    const calendar = new MarketCalendar(broker, db, clock, logger, 2000);
    await calendar.start();
    provider = new AlpacaMarketDataProvider({ dataUrl: fake.url, dataStreamUrl: fake.wsUrl, stockFeed: 'iex', optionsFeed: 'opra', credentials: { keyId: 'K', secretKey: 'S' }, logger });
    md = new MarketDataService(provider, calendar, bus, clock, logger, { env: 'paper', symbols: ['QQQ', 'SPY', 'IWM'], maxDataAgeMs: 5000, maxOptionQuoteAgeMs: 10_000, paperAllowIndicativeOptions: false });
  });

  afterEach(async () => {
    await md.stop();
    await fake.stop();
    await db.close();
  });

  it('connects, authenticates, subscribes and receives normalized trades/quotes (connection)', async () => {
    await md.start();
    await waitFor(() => provider.status().stock.state === 'CONNECTED', 'stock stream connected');
    // History was loaded from the REST bars endpoint.
    expect(md.finalBars('QQQ').length).toBeGreaterThan(60);
    fake.trade('QQQ', 601.23, 100);
    await waitFor(() => md.state('QQQ')!.last === 601.23, 'trade received');
    const f = md.freshness('QQQ');
    expect(f.stale).toBe(false);
    expect(f.ageMs).toBe(0); // exchange timestamp == virtual now
  });

  it('reconnects with backoff and resubscribes after the stream drops (reconnection)', async () => {
    const states: string[] = [];
    bus.on('MARKET_DATA_STATUS', ({ stream, status }) => stream === 'stock' && states.push(status.state));
    await md.start();
    await waitFor(() => provider.status().stock.state === 'CONNECTED', 'connected');
    fake.dropDataStreams();
    await waitFor(() => states.includes('RECONNECTING'), 'reconnecting');
    expect(md.freshness('QQQ').stale).toBe(true); // stale while disconnected — no trading on it
    await waitFor(() => provider.status().stock.state === 'CONNECTED', 'reconnected', 10_000);
    fake.trade('QQQ', 602.5, 100);
    await waitFor(() => md.state('QQQ')!.last === 602.5, 'data after resubscribe');
  });

  it('marks data stale once it exceeds the configured maximum age (stale data)', async () => {
    await md.start();
    await waitFor(() => provider.status().stock.state === 'CONNECTED', 'connected');
    fake.trade('QQQ', 600.5, 100);
    await waitFor(() => md.state('QQQ')!.last === 600.5, 'trade');
    clock.advance(4000);
    expect(md.freshness('QQQ').stale).toBe(false);
    clock.advance(1500);
    const f = md.freshness('QQQ');
    expect(f.stale).toBe(true);
    expect(f.reason).toContain('5.5s');
  });

  it('suppresses duplicate events (duplicate events)', async () => {
    await md.start();
    let ticks = 0;
    bus.on('MARKET_TICK', (t) => t.kind === 'trade' && t.symbol === 'QQQ' && ticks++);
    const trade = { kind: 'trade' as const, symbol: 'QQQ', t: clock.now(), price: 600.1, size: 50, exchange: 'V', id: '42', conditions: [], tape: 'C' };
    md.handle(trade);
    md.handle({ ...trade });
    expect(ticks).toBe(1);
    const quote = { kind: 'quote' as const, symbol: 'QQQ', t: clock.now(), bid: 600, ask: 600.02, bidSize: 1, askSize: 1, bidExchange: 'V', askExchange: 'V' };
    let quotes = 0;
    bus.on('MARKET_TICK', (t) => t.kind === 'quote' && quotes++);
    md.handle(quote);
    md.handle({ ...quote });
    expect(quotes).toBe(1);
  });

  it('labels feeds honestly and blocks automated options on a non-NBBO feed', () => {
    const s = md.status();
    expect(s.stockFeedLabel).toBe('LIVE · IEX ONLY');
    expect(s.stockPartialVolume).toBe(true);
    expect(s.optionsRealtimeNbbo).toBe(true);
    const indicative = new MarketDataService(
      new AlpacaMarketDataProvider({ dataUrl: fake.url, dataStreamUrl: fake.wsUrl, stockFeed: 'delayed_sip', optionsFeed: 'indicative', credentials: { keyId: 'K', secretKey: 'S' }, logger: createTestLogger() }),
      new MarketCalendar(new AlpacaBrokerAdapter({ env: 'live', baseUrl: fake.url, streamUrl: fake.wsUrl, credentials: { keyId: 'K', secretKey: 'S' }, logger: createTestLogger() }), db, clock, createTestLogger(), 2000),
      bus,
      clock,
      createTestLogger(),
      { env: 'live', symbols: ['QQQ'], maxDataAgeMs: 5000, maxOptionQuoteAgeMs: 10_000, paperAllowIndicativeOptions: true },
    );
    const st = indicative.status();
    expect(st.stockFeedLabel).toBe('DELAYED 15 MIN');
    expect(st.stockRealtime).toBe(false);
    expect(st.optionsAutotradeAllowed).toBe(false); // never in live, regardless of the paper flag
    expect(st.optionsBlockReason).toContain('OPTIONS DATA UNAVAILABLE');
  });
});

describe('LruSet', () => {
  it('evicts the oldest key beyond capacity', () => {
    const s = new LruSet(2);
    expect(s.add('a')).toBe(true);
    expect(s.add('a')).toBe(false);
    s.add('b');
    s.add('c');
    expect(s.add('a')).toBe(true);
  });
});
