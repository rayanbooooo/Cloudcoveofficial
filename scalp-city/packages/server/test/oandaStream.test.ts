import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DateTime } from 'luxon';
import { afterEach, describe, expect, it } from 'vitest';
import { OandaBrokerAdapter } from '../src/broker/oanda/OandaBrokerAdapter.js';
import { OandaStream } from '../src/broker/oanda/OandaStream.js';
import type { BrokerTradeUpdate, StreamStatus } from '../src/broker/types.js';
import { ManualClock } from '../src/core/clock.js';
import { createTestLogger } from '../src/core/logger.js';
import { FakeOanda } from './fakes/FakeOanda.js';

const NY = 'America/New_York';
const TOKEN = 'test-oanda-token-0123456789abcdef';
const ACCOUNT = '101-004-12345678-001';

const until = async (cond: () => boolean, label: string, ms = 10_000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('OandaStream (newline-delimited JSON over a long-lived response)', () => {
  let server: http.Server | null = null;
  let stream: OandaStream | null = null;
  afterEach(async () => {
    await stream?.stop();
    server?.closeAllConnections();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null;
    stream = null;
  });

  const listen = async (handler: http.RequestListener) => {
    server = http.createServer(handler);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  };

  it('reassembles messages split across network chunks and ignores blank lines', async () => {
    const url = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.write('{"type":"HEARTBEAT","time":"2026-10-05T15:00:00Z"}\n\n{"type":"PRICE","instr');
      setTimeout(() => res.write('ument":"XAU_USD"}\n{"type":"PRICE","instrument":"EUR_JPY"}\n'), 30);
    });
    const got: Record<string, unknown>[] = [];
    stream = new OandaStream({ name: 't', url: () => `${url}/s`, token: TOKEN, logger: createTestLogger() });
    stream.onMessage((m) => got.push(m));
    stream.start();
    await until(() => got.length === 3, 'three messages');
    expect(got.map((m) => m.instrument ?? m.type)).toEqual(['HEARTBEAT', 'XAU_USD', 'EUR_JPY']);
    expect(stream.getStatus().state).toBe('CONNECTED');
  });

  it('sends the token as a Bearer header and nothing else secret in the URL', async () => {
    let seen: http.IncomingMessage | null = null;
    const url = await listen((req, res) => {
      seen = req;
      res.writeHead(200);
      res.write('{"type":"HEARTBEAT"}\n');
    });
    stream = new OandaStream({ name: 't', url: () => `${url}/v3/accounts/${ACCOUNT}/pricing/stream?instruments=XAU_USD`, token: TOKEN, logger: createTestLogger() });
    stream.start();
    await until(() => seen !== null, 'a request');
    expect(seen!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen!.url).not.toContain(TOKEN);
  });

  it('tears down and rebuilds a stream that goes silent (a connected-but-mute feed is a failure)', async () => {
    let connections = 0;
    const url = await listen((req, res) => {
      connections++;
      res.writeHead(200);
      res.write('{"type":"HEARTBEAT"}\n'); // then nothing, ever
    });
    const seen: StreamStatus[] = [];
    stream = new OandaStream({ name: 't', url: () => `${url}/s`, token: TOKEN, logger: createTestLogger(), silenceTimeoutMs: 1_200, minBackoffMs: 50, maxBackoffMs: 100 });
    stream.onStatus((s) => seen.push(s));
    stream.start();
    await until(() => connections >= 2, 'a second connection after silence', 8_000);
    expect(seen.map((s) => s.state)).toContain('CONNECTED');
    const lost = seen.find((s) => s.state === 'RECONNECTING')!;
    expect(lost).toBeDefined();
    expect(lost.lastError).toMatch(/no data or heartbeat for 1s/); // the UI says why the feed was rebuilt
  }, 15_000);

  it('reconnects with backoff after the server drops it, and reports every state change', async () => {
    let connections = 0;
    const open = new Set<http.ServerResponse>();
    const url = await listen((req, res) => {
      connections++;
      open.add(res);
      res.writeHead(200);
      res.write('{"type":"HEARTBEAT"}\n');
    });
    const statuses: StreamStatus[] = [];
    stream = new OandaStream({ name: 't', url: () => `${url}/s`, token: TOKEN, logger: createTestLogger(), minBackoffMs: 40, maxBackoffMs: 80 });
    stream.onStatus((s) => statuses.push(s));
    stream.start();
    await until(() => stream!.getStatus().state === 'CONNECTED', 'connected');
    for (const r of open) r.destroy();
    await until(() => connections >= 2 && stream!.getStatus().state === 'CONNECTED', 'reconnected', 8_000);
    expect(statuses.map((s) => s.state)).toEqual(expect.arrayContaining(['CONNECTING', 'CONNECTED', 'RECONNECTING']));
    expect(stream.getStatus().reconnectAttempts).toBe(0); // reset by the successful reconnect
  });

  it('does not hammer OANDA with a rejected token: it backs off hard and says why', async () => {
    let requests = 0;
    const url = await listen((req, res) => {
      requests++;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"errorMessage":"Insufficient authorization to perform request."}');
    });
    stream = new OandaStream({ name: 't', url: () => `${url}/s`, token: 'bad', logger: createTestLogger(), minBackoffMs: 20 });
    stream.start();
    await until(() => stream!.getStatus().state === 'RECONNECTING', 'reconnecting state');
    await new Promise((r) => setTimeout(r, 400));
    expect(requests).toBe(1); // the next attempt is a minute away
    expect(stream.getStatus().lastError).toMatch(/authentication failed/);
    expect(stream.getStatus().state).not.toBe('CONNECTED');
  });

  it('stops promptly and reports DISCONNECTED', async () => {
    const url = await listen((req, res) => {
      res.writeHead(200);
      res.write('{"type":"HEARTBEAT"}\n');
    });
    stream = new OandaStream({ name: 't', url: () => `${url}/s`, token: TOKEN, logger: createTestLogger() });
    stream.start();
    await until(() => stream!.getStatus().state === 'CONNECTED', 'connected');
    await stream.stop();
    expect(stream.getStatus().state).toBe('DISCONNECTED');
  });
});

describe('OANDA transaction stream: nothing is lost across a disconnect', () => {
  let fake: FakeOanda;
  let adapter: OandaBrokerAdapter;
  afterEach(async () => {
    await adapter?.close();
    await fake?.stop();
  });

  it('replays the transactions missed while the stream was down, so fills and broker stops are never lost', async () => {
    const clock = new ManualClock(DateTime.fromISO('2026-10-05T11:00:30', { zone: NY }).toMillis());
    fake = new FakeOanda({ clock, token: TOKEN, accountId: ACCOUNT, instruments: { XAU_USD: 2650 }, sessionDate: '2026-10-05', heartbeatMs: 300 });
    await fake.start();
    adapter = new OandaBrokerAdapter({
      env: 'paper',
      apiUrl: fake.url,
      streamUrl: fake.url,
      credentials: { token: TOKEN, accountId: ACCOUNT },
      session: { open: '09:30', close: '16:00' },
      skipUsHolidays: true,
      instruments: ['XAU_USD'],
      logger: createTestLogger(),
      clock,
    });
    const updates: BrokerTradeUpdate[] = [];
    adapter.subscribeTradeUpdates((u) => updates.push(u));
    await until(() => adapter.tradeStreamStatus().state === 'CONNECTED', 'stream connected');
    await adapter.getAccount(); // learns the account's last transaction id

    // The connection drops, and an order fills while nobody is listening.
    fake.dropStreams();
    const bo = await adapter.submitOrder({
      clientOrderId: 'sc-P-entry-gap',
      symbol: 'XAU_USD',
      qty: 2,
      side: 'buy',
      type: 'limit',
      limitPrice: fake.prices.get('XAU_USD')!.ask + 1,
      timeInForce: 'fok',
      positionIntent: 'buy_to_open',
      protectiveStop: { price: fake.prices.get('XAU_USD')!.ask - 3, clientOrderId: 'sc-P-entry-gap.sl' },
    });
    expect(bo.status).toBe('filled'); // the HTTP answer already says so
    expect(updates.filter((u) => u.order.clientOrderId === 'sc-P-entry-gap')).toHaveLength(0); // the stream saw nothing

    // On reconnect the gap is replayed from OANDA's transaction log.
    await until(() => updates.some((u) => u.event === 'fill' && u.order.clientOrderId === 'sc-P-entry-gap'), 'the missed fill, replayed', 15_000);
    const fill = updates.find((u) => u.event === 'fill' && u.order.clientOrderId === 'sc-P-entry-gap')!;
    expect(fill.order.filledQty).toBe(2);
    expect(fill.qty).toBe(2);
    expect(fill.order.symbol).toBe('XAU_USD');
    expect(fill.executionId).not.toBeNull(); // a stable execution id lets the engine dedupe
    await until(() => updates.some((u) => u.order.clientOrderId === 'sc-P-entry-gap.sl'), 'the missed broker stop, replayed', 15_000);
    const stop = updates.find((u) => u.order.clientOrderId === 'sc-P-entry-gap.sl')!;
    expect(stop.order.dependent).toBe(true);
    expect(stop.order.side).toBe('sell');
    expect(stop.order.qty).toBe(2);

    // And a fill that happens after the replay arrives live, exactly once.
    const before = updates.length;
    fake.tick('XAU_USD', 2640); // through the stop
    await until(() => updates.some((u) => u.event === 'fill' && u.order.clientOrderId === 'sc-P-entry-gap.sl'), 'the stop fill', 10_000);
    expect(updates.filter((u) => u.event === 'fill' && u.order.clientOrderId === 'sc-P-entry-gap.sl')).toHaveLength(1);
    expect(updates.length).toBeGreaterThan(before);
  }, 40_000);
});
