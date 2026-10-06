import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { decode, encode } from '@msgpack/msgpack';
import { DateTime } from 'luxon';
import { WebSocket, WebSocketServer } from 'ws';
import type { Clock } from '../../src/core/clock.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Protocol-level fake of the Alpaca Trading + Market Data APIs, for
 * automated tests and the local UI harness ONLY. It speaks the same wire
 * formats the real adapters expect (REST JSON with key headers, JSON trade
 * stream, msgpack data streams) so the production adapters are exercised
 * unmodified. Everything it emits is synthetic; it is never reachable from
 * a production configuration (and LIVE endpoints are pinned to Alpaca).
 */

const NY = 'America/New_York';

export interface FakeAlpacaOptions {
  clock: Clock;
  keyId: string;
  secretKey: string;
  symbols: Record<string, number>;
  /** NY date of the (single) trading session the fake serves. */
  sessionDate: string;
  sessionOpen?: string;
  sessionClose?: string;
  startingCash?: number;
  accountNumber?: string;
  /** Price for minute index i since the session open (history before "now"). */
  historyPath?: (symbol: string, minute: number, base: number) => number;
  historyVolume?: (symbol: string, minute: number) => number;
}

interface FakeOrder {
  id: string;
  client_order_id: string;
  symbol: string;
  asset_class: 'us_equity' | 'us_option';
  side: 'buy' | 'sell';
  type: string;
  time_in_force: string;
  qty: number;
  filled_qty: number;
  filled_avg_price: number | null;
  limit_price: number | null;
  stop_price: number | null;
  status: string;
  position_intent: string | null;
  created_at: number;
  updated_at: number;
  submitted_at: number;
  filled_at: number | null;
  canceled_at: number | null;
}

interface FakePosition {
  symbol: string;
  asset_class: 'us_equity' | 'us_option';
  qty: number; // signed
  avg: number;
}

interface RawBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  n: number;
  vw: number;
}

interface DataClient {
  ws: WebSocket;
  kind: 'stock' | 'options';
  authed: boolean;
  trades: Set<string>;
  quotes: Set<string>;
  bars: Set<string>;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

function occ(root: string, date: string, type: 'call' | 'put', strike: number): string {
  const [y, m, d] = date.split('-');
  return `${root}${y!.slice(2)}${m}${d}${type === 'call' ? 'C' : 'P'}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
}

export class FakeAlpaca {
  url = '';
  wsUrl = '';
  readonly startEquity: number;
  cash: number;
  positions = new Map<string, FakePosition>();
  orders = new Map<string, FakeOrder>();
  prices = new Map<string, { bid: number; ask: number; last: number }>();
  history = new Map<string, RawBar[]>();
  forming = new Map<string, RawBar>();
  contracts: { symbol: string; underlying: string; type: 'call' | 'put'; strike: number; expiration: string }[] = [];
  fillMode: 'immediate' | 'manual' = 'immediate';
  rejectNext: string | null = null;
  submitCount = 0;
  private server!: http.Server;
  private wss = new WebSocketServer({ noServer: true });
  private tradeClients = new Set<WebSocket>();
  private dataClients = new Set<DataClient>();
  private autopilot: NodeJS.Timeout | null = null;
  readonly sessionOpenMs: number;
  readonly sessionCloseMs: number;

  constructor(private readonly o: FakeAlpacaOptions) {
    this.startEquity = o.startingCash ?? 100_000;
    this.cash = this.startEquity;
    const open = o.sessionOpen ?? '09:30';
    const close = o.sessionClose ?? '16:00';
    const [oh, om] = open.split(':').map(Number);
    const [ch, cm] = close.split(':').map(Number);
    this.sessionOpenMs = DateTime.fromISO(o.sessionDate, { zone: NY }).set({ hour: oh, minute: om }).toMillis();
    this.sessionCloseMs = DateTime.fromISO(o.sessionDate, { zone: NY }).set({ hour: ch, minute: cm }).toMillis();
    for (const [sym, price] of Object.entries(o.symbols)) {
      this.prices.set(sym, { bid: r2(price - 0.01), ask: r2(price + 0.01), last: price });
      this.buildHistory(sym, price);
      this.buildContracts(sym, price);
    }
  }

  private now(): number {
    return this.o.clock.now();
  }

  // ── History & contracts ─────────────────────────────────────────────────

  private buildHistory(symbol: string, base: number): void {
    const bars: RawBar[] = [];
    const nowMin = Math.floor(this.now() / 60_000) * 60_000;
    const path = this.o.historyPath ?? ((_s, i, b) => b + Math.sin(i / 7) * 0.4 + i * 0.002);
    const vol = this.o.historyVolume ?? (() => 10_000);
    let prev = path(symbol, 0, base);
    for (let t = this.sessionOpenMs, i = 0; t < nowMin && t < this.sessionCloseMs; t += 60_000, i++) {
      const c = path(symbol, i, base);
      const o = prev;
      const h = Math.max(o, c) + 0.05;
      const l = Math.min(o, c) - 0.05;
      bars.push({ t, o: r2(o), h: r2(h), l: r2(l), c: r2(c), v: vol(symbol, i), n: 60, vw: r2((h + l + c) / 3) });
      prev = c;
    }
    this.history.set(symbol, bars);
    const last = bars[bars.length - 1];
    if (last) this.prices.set(symbol, { bid: r2(last.c - 0.01), ask: r2(last.c + 0.01), last: last.c });
  }

  private buildContracts(symbol: string, price: number): void {
    const dates: string[] = [];
    let d = DateTime.fromISO(this.o.sessionDate, { zone: NY });
    while (dates.length < 4) {
      if (d.weekday <= 5) dates.push(d.toISODate()!);
      d = d.plus({ days: 1 });
    }
    const center = Math.round(price);
    for (const date of dates) {
      for (let k = center - 12; k <= center + 12; k++) {
        for (const type of ['call', 'put'] as const) this.contracts.push({ symbol: occ(symbol, date, type, k), underlying: symbol, type, strike: k, expiration: date });
      }
    }
  }

  /** Synthetic option quote derived from the underlying (intrinsic + decaying time value). */
  optionQuote(contract: string): { bid: number; ask: number } | null {
    const c = this.contracts.find((x) => x.symbol === contract);
    if (!c) return null;
    const s = this.prices.get(c.underlying)!.last;
    const intrinsic = c.type === 'call' ? Math.max(0, s - c.strike) : Math.max(0, c.strike - s);
    const mid = intrinsic + 1.2 * Math.exp(-Math.abs(s - c.strike) / 5) + 0.05;
    return { bid: r2(mid - 0.01), ask: r2(mid + 0.01) };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handleHttp(req, res));
    this.server.on('upgrade', (req, socket, head) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => this.handleWs(ws, req.url ?? ''));
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const port = (this.server.address() as AddressInfo).port;
    this.url = `http://127.0.0.1:${port}`;
    this.wsUrl = `ws://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    if (this.autopilot) clearInterval(this.autopilot);
    for (const c of this.wss.clients) c.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // ── HTTP ────────────────────────────────────────────────────────────────

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (req.headers['apca-api-key-id'] !== this.o.keyId || req.headers['apca-api-secret-key'] !== this.o.secretKey) {
      return send(401, { code: 40110000, message: 'request is not authorized' });
    }
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    const q = url.searchParams;
    let body: any = undefined;
    if (req.method === 'POST' || req.method === 'PATCH') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    }
    try {
      if (req.method === 'GET' && p === '/v2/account') return send(200, this.accountJson());
      if (req.method === 'GET' && p === '/v2/positions') return send(200, [...this.positions.values()].map((x) => this.positionJson(x)));
      if (req.method === 'GET' && p === '/v2/orders') {
        const status = q.get('status') ?? 'open';
        const open = new Set(['new', 'accepted', 'partially_filled', 'pending_cancel']);
        return send(200, [...this.orders.values()].filter((o) => status === 'all' || (status === 'open' ? open.has(o.status) : !open.has(o.status))).map((o) => this.orderJson(o)));
      }
      if (req.method === 'POST' && p === '/v2/orders') return this.submit(body, send);
      if (req.method === 'DELETE' && p === '/v2/orders') {
        const out = [];
        for (const o of this.orders.values()) {
          if (['new', 'accepted', 'partially_filled'].includes(o.status)) {
            this.cancel(o);
            out.push({ id: o.id, status: 200 });
          }
        }
        return send(207, out);
      }
      if (req.method === 'GET' && p === '/v2/orders:by_client_order_id') {
        const o = [...this.orders.values()].find((x) => x.client_order_id === q.get('client_order_id'));
        return o ? send(200, this.orderJson(o)) : send(404, { code: 40410000, message: 'order not found' });
      }
      let m = /^\/v2\/orders\/([^/]+)$/.exec(p);
      if (m) {
        const o = this.orders.get(m[1]!);
        if (!o) return send(404, { code: 40410000, message: 'order not found' });
        if (req.method === 'GET') return send(200, this.orderJson(o));
        if (req.method === 'DELETE') {
          if (!['new', 'accepted', 'partially_filled'].includes(o.status)) return send(422, { code: 42210000, message: `order is not cancelable (${o.status})` });
          o.status = 'pending_cancel';
          o.updated_at = this.now();
          setTimeout(() => this.cancel(o), 20);
          return send(204, undefined);
        }
      }
      m = /^\/v2\/assets\/([^/]+)$/.exec(p);
      if (m) return send(200, { id: randomUUID(), class: 'us_equity', exchange: 'NASDAQ', symbol: m[1], status: 'active', tradable: true, marginable: true, shortable: true, easy_to_borrow: true, fractionable: true });
      if (p === '/v2/options/contracts') {
        const u = q.get('underlying_symbols');
        const type = q.get('type');
        const gte = q.get('expiration_date_gte');
        const lte = q.get('expiration_date_lte');
        const exp = q.get('expiration_date');
        const sGte = q.get('strike_price_gte');
        const sLte = q.get('strike_price_lte');
        const list = this.contracts.filter(
          (c) =>
            (!u || c.underlying === u) &&
            (!type || c.type === type) &&
            (!exp || c.expiration === exp) &&
            (!gte || c.expiration >= gte) &&
            (!lte || c.expiration <= lte) &&
            (!sGte || c.strike >= Number(sGte)) &&
            (!sLte || c.strike <= Number(sLte)),
        );
        return send(200, { option_contracts: list.map((c) => this.contractJson(c)), next_page_token: null });
      }
      m = /^\/v2\/options\/contracts\/([^/]+)$/.exec(p);
      if (m) {
        const c = this.contracts.find((x) => x.symbol === m![1]);
        return c ? send(200, this.contractJson(c)) : send(404, { code: 40410000, message: 'contract not found' });
      }
      if (p === '/v2/clock') {
        const now = this.now();
        const isOpen = now >= this.sessionOpenMs && now < this.sessionCloseMs;
        return send(200, {
          timestamp: DateTime.fromMillis(now, { zone: NY }).toISO(),
          is_open: isOpen,
          next_open: DateTime.fromMillis(this.sessionOpenMs + 86_400_000, { zone: NY }).toISO(),
          next_close: DateTime.fromMillis(this.sessionCloseMs, { zone: NY }).toISO(),
        });
      }
      if (p === '/v2/calendar') {
        const start = q.get('start') ?? this.o.sessionDate;
        const end = q.get('end') ?? this.o.sessionDate;
        const days = [];
        for (let d = DateTime.fromISO(start, { zone: NY }); d.toISODate()! <= end; d = d.plus({ days: 1 })) {
          if (d.weekday > 5) continue;
          days.push({ date: d.toISODate(), open: this.o.sessionOpen ?? '09:30', close: this.o.sessionClose ?? '16:00', session_open: '0400', session_close: '2000' });
        }
        return send(200, days);
      }
      // ── Market data REST ──
      if (p === '/v2/stocks/bars') {
        const symbols = (q.get('symbols') ?? '').split(',').filter(Boolean);
        const start = Date.parse(q.get('start') ?? '1970-01-01');
        const end = Date.parse(q.get('end') ?? new Date(this.now()).toISOString());
        const out: Record<string, unknown[]> = {};
        for (const s of symbols) {
          out[s] = (this.history.get(s) ?? []).filter((b) => b.t >= start && b.t <= end).map((b) => ({ ...b, t: new Date(b.t).toISOString() }));
        }
        return send(200, { bars: out, next_page_token: null });
      }
      if (p === '/v2/stocks/snapshots') {
        const symbols = (q.get('symbols') ?? '').split(',').filter(Boolean);
        const out: Record<string, unknown> = {};
        const iso = new Date(this.now()).toISOString();
        for (const s of symbols) {
          const pr = this.prices.get(s);
          if (!pr) continue;
          const first = this.history.get(s)?.[0];
          out[s] = { latestTrade: { p: pr.last, s: 100, t: iso }, latestQuote: { bp: pr.bid, ap: pr.ask, bs: 3, as: 3, t: iso }, prevDailyBar: { c: first ? first.o : pr.last } };
        }
        return send(200, out);
      }
      if (p === '/v1beta1/options/snapshots') {
        const symbols = (q.get('symbols') ?? '').split(',').filter(Boolean);
        return send(200, { snapshots: Object.fromEntries(symbols.filter((s) => this.optionQuote(s)).map((s) => [s, this.optionSnapshot(s)])), next_page_token: null });
      }
      m = /^\/v1beta1\/options\/snapshots\/([^/]+)$/.exec(p);
      if (m) {
        const list = this.contracts.filter((c) => c.underlying === m![1]);
        return send(200, { snapshots: Object.fromEntries(list.map((c) => [c.symbol, this.optionSnapshot(c.symbol)])), next_page_token: null });
      }
      return send(404, { code: 40410000, message: `no route ${req.method} ${p}` });
    } catch (err) {
      return send(500, { message: (err as Error).message });
    }
  }

  private optionSnapshot(symbol: string): unknown {
    const q = this.optionQuote(symbol)!;
    const iso = new Date(this.now()).toISOString();
    return {
      latestQuote: { bp: q.bid, ap: q.ask, bs: 50, as: 50, t: iso },
      latestTrade: { p: r2((q.bid + q.ask) / 2), s: 1, t: iso },
      dailyBar: { o: q.bid, h: q.ask, l: q.bid, c: q.ask, v: 5000, t: iso },
      impliedVolatility: 0.22,
      greeks: { delta: 0.5, gamma: 0.05, theta: -0.1, vega: 0.1, rho: 0.01 },
    };
  }

  private contractJson(c: (typeof this.contracts)[number]): unknown {
    return {
      id: randomUUID(),
      symbol: c.symbol,
      name: `${c.underlying} ${c.expiration} ${c.type} ${c.strike}`,
      status: 'active',
      tradable: true,
      expiration_date: c.expiration,
      root_symbol: c.underlying,
      underlying_symbol: c.underlying,
      underlying_asset_id: randomUUID(),
      type: c.type,
      style: 'american',
      strike_price: String(c.strike),
      size: '100',
      open_interest: '5000',
      open_interest_date: this.o.sessionDate,
      close_price: null,
    };
  }

  private markOf(p: FakePosition): number {
    if (p.asset_class === 'us_option') {
      const q = this.optionQuote(p.symbol)!;
      return (q.bid + q.ask) / 2;
    }
    return this.prices.get(p.symbol)!.last;
  }

  equity(): number {
    let mv = 0;
    for (const p of this.positions.values()) mv += p.qty * this.markOf(p) * (p.asset_class === 'us_option' ? 100 : 1);
    return this.cash + mv;
  }

  private accountJson(): unknown {
    const equity = this.equity();
    return {
      id: 'fake-account-id',
      account_number: this.o.accountNumber ?? 'PA0000004821',
      status: 'ACTIVE',
      currency: 'USD',
      cash: this.cash.toFixed(2),
      equity: equity.toFixed(2),
      last_equity: this.startEquity.toFixed(2),
      buying_power: (this.cash * 2).toFixed(2),
      regt_buying_power: (this.cash * 2).toFixed(2),
      daytrading_buying_power: (this.cash * 4).toFixed(2),
      non_marginable_buying_power: this.cash.toFixed(2),
      options_buying_power: this.cash.toFixed(2),
      portfolio_value: equity.toFixed(2),
      long_market_value: (equity - this.cash).toFixed(2),
      short_market_value: '0',
      initial_margin: '0',
      maintenance_margin: '0',
      multiplier: '2',
      pattern_day_trader: false,
      trading_blocked: false,
      account_blocked: false,
      trade_suspended_by_user: false,
      shorting_enabled: true,
      daytrade_count: 0,
      options_approved_level: 3,
      options_trading_level: 3,
    };
  }

  private positionJson(p: FakePosition): unknown {
    const mult = p.asset_class === 'us_option' ? 100 : 1;
    const mark = this.markOf(p);
    const cost = p.avg * p.qty * mult;
    const mv = mark * p.qty * mult;
    return {
      asset_id: randomUUID(),
      symbol: p.symbol,
      exchange: 'NASDAQ',
      asset_class: p.asset_class,
      avg_entry_price: String(p.avg),
      qty: String(p.qty),
      qty_available: String(Math.abs(p.qty)),
      side: p.qty >= 0 ? 'long' : 'short',
      market_value: mv.toFixed(2),
      cost_basis: cost.toFixed(2),
      unrealized_pl: (mv - cost).toFixed(2),
      unrealized_plpc: cost ? ((mv - cost) / Math.abs(cost)).toFixed(4) : '0',
      unrealized_intraday_pl: (mv - cost).toFixed(2),
      unrealized_intraday_plpc: cost ? ((mv - cost) / Math.abs(cost)).toFixed(4) : '0',
      current_price: mark.toFixed(2),
      lastday_price: mark.toFixed(2),
      change_today: '0',
    };
  }

  private orderJson(o: FakeOrder): unknown {
    const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
    return {
      id: o.id,
      client_order_id: o.client_order_id,
      created_at: iso(o.created_at),
      updated_at: iso(o.updated_at),
      submitted_at: iso(o.submitted_at),
      filled_at: iso(o.filled_at),
      expired_at: null,
      canceled_at: iso(o.canceled_at),
      failed_at: null,
      asset_id: randomUUID(),
      symbol: o.symbol,
      asset_class: o.asset_class,
      qty: String(o.qty),
      filled_qty: String(o.filled_qty),
      filled_avg_price: o.filled_avg_price === null ? null : String(o.filled_avg_price),
      order_class: 'simple',
      order_type: o.type,
      type: o.type,
      side: o.side,
      time_in_force: o.time_in_force,
      limit_price: o.limit_price === null ? null : String(o.limit_price),
      stop_price: o.stop_price === null ? null : String(o.stop_price),
      status: o.status,
      extended_hours: false,
      position_intent: o.position_intent,
    };
  }

  // ── Orders & matching ───────────────────────────────────────────────────

  private submit(b: any, send: (s: number, body: unknown) => void): void {
    this.submitCount++;
    if ([...this.orders.values()].some((o) => o.client_order_id === b.client_order_id)) return send(422, { code: 40010001, message: 'client_order_id must be unique' });
    if (this.rejectNext) {
      const msg = this.rejectNext;
      this.rejectNext = null;
      return send(403, { code: 40310000, message: msg });
    }
    const isOption = this.contracts.some((c) => c.symbol === b.symbol);
    if (!isOption && !this.prices.has(b.symbol)) return send(422, { code: 40010001, message: `asset "${b.symbol}" not found` });
    const qty = Number(b.qty);
    if (!Number.isInteger(qty) || qty <= 0) return send(422, { code: 40010001, message: 'qty must be a positive integer' });
    const now = this.now();
    const o: FakeOrder = {
      id: randomUUID(),
      client_order_id: b.client_order_id,
      symbol: b.symbol,
      asset_class: isOption ? 'us_option' : 'us_equity',
      side: b.side,
      type: b.type,
      time_in_force: b.time_in_force,
      qty,
      filled_qty: 0,
      filled_avg_price: null,
      limit_price: b.limit_price ? Number(b.limit_price) : null,
      stop_price: b.stop_price ? Number(b.stop_price) : null,
      status: 'accepted',
      position_intent: b.position_intent ?? null,
      created_at: now,
      updated_at: now,
      submitted_at: now,
      filled_at: null,
      canceled_at: null,
    };
    if (o.side === 'buy') {
      const px = this.executable(o) ?? o.limit_price ?? 0;
      const cost = px * qty * (isOption ? 100 : 1);
      const bp = isOption ? this.cash : this.cash * 2;
      if (cost > bp) return send(403, { code: 40310000, message: 'insufficient buying power' });
    }
    this.orders.set(o.id, o);
    send(200, this.orderJson(o));
    setTimeout(() => {
      // A price move in the meantime may already have filled (or cancelled) it.
      if (o.status !== 'accepted') return;
      o.status = 'new';
      o.updated_at = this.now();
      this.emitTrade('new', o);
      this.tryFill(o);
    }, 5);
  }

  /** Price at which the order could execute right now, or null if not marketable. */
  private executable(o: FakeOrder): number | null {
    const q = o.asset_class === 'us_option' ? this.optionQuote(o.symbol) : this.prices.get(o.symbol);
    if (!q) return null;
    const px = o.side === 'buy' ? q.ask : q.bid;
    if (o.type === 'market') return px;
    if (o.type === 'limit' && o.limit_price !== null) {
      if (o.side === 'buy' && o.limit_price >= q.ask) return q.ask;
      if (o.side === 'sell' && o.limit_price <= q.bid) return q.bid;
    }
    return null;
  }

  tryFill(o: FakeOrder): void {
    if (this.fillMode !== 'immediate' || !['new', 'accepted', 'partially_filled'].includes(o.status)) return;
    const px = this.executable(o);
    if (px === null) return;
    this.fill(o, o.qty - o.filled_qty, px);
  }

  /** Execute `qty` of an order at `price` (tests may call directly for partial fills). */
  fill(o: FakeOrder, qty: number, price: number): void {
    if (!(qty > 0)) return;
    const mult = o.asset_class === 'us_option' ? 100 : 1;
    const prevQty = o.filled_qty;
    o.filled_qty += qty;
    o.filled_avg_price = ((o.filled_avg_price ?? 0) * prevQty + price * qty) / o.filled_qty;
    o.status = o.filled_qty >= o.qty ? 'filled' : 'partially_filled';
    o.updated_at = this.now();
    if (o.status === 'filled') o.filled_at = this.now();
    const signed = o.side === 'buy' ? qty : -qty;
    this.cash -= signed * price * mult;
    const p = this.positions.get(o.symbol);
    if (!p) this.positions.set(o.symbol, { symbol: o.symbol, asset_class: o.asset_class, qty: signed, avg: price });
    else {
      const next = p.qty + signed;
      if (next === 0) this.positions.delete(o.symbol);
      else {
        if (Math.sign(next) === Math.sign(p.qty) && Math.abs(next) > Math.abs(p.qty)) p.avg = (p.avg * Math.abs(p.qty) + price * qty) / Math.abs(next);
        p.qty = next;
      }
    }
    this.emitTrade(o.status === 'filled' ? 'fill' : 'partial_fill', o, { execution_id: randomUUID(), price: String(price), qty: String(qty), position_qty: String(this.positions.get(o.symbol)?.qty ?? 0) });
  }

  private cancel(o: FakeOrder): void {
    if (['filled', 'canceled'].includes(o.status)) return;
    o.status = 'canceled';
    o.canceled_at = this.now();
    o.updated_at = this.now();
    this.emitTrade('canceled', o);
  }

  private emitTrade(event: string, o: FakeOrder, extra: Record<string, unknown> = {}): void {
    const msg = { stream: 'trade_updates', data: { event, order: this.orderJson(o), timestamp: new Date(this.now()).toISOString(), ...extra } };
    // Alpaca sends trade updates as binary frames carrying JSON.
    const buf = Buffer.from(JSON.stringify(msg));
    for (const ws of this.tradeClients) if (ws.readyState === WebSocket.OPEN) ws.send(buf, { binary: true });
  }

  // ── WebSocket servers ───────────────────────────────────────────────────

  private handleWs(ws: WebSocket, path: string): void {
    if (path === '/stream') return this.handleTradeStream(ws);
    const kind = path.startsWith('/v2/') ? 'stock' : path.startsWith('/v1beta1/') ? 'options' : null;
    if (!kind) return ws.close(4004, 'unknown path');
    const client: DataClient = { ws, kind, authed: false, trades: new Set(), quotes: new Set(), bars: new Set() };
    this.dataClients.add(client);
    ws.on('close', () => this.dataClients.delete(client));
    const reply = (msgs: unknown[]) => ws.send(encode(msgs));
    reply([{ T: 'success', msg: 'connected' }]);
    ws.on('message', (raw: Buffer) => {
      let m: any;
      try {
        m = decode(raw);
      } catch {
        return reply([{ T: 'error', code: 400, msg: 'invalid syntax' }]);
      }
      if (m.action === 'auth') {
        if (m.key === this.o.keyId && m.secret === this.o.secretKey) {
          client.authed = true;
          reply([{ T: 'success', msg: 'authenticated' }]);
        } else reply([{ T: 'error', code: 402, msg: 'auth failed' }]);
        return;
      }
      if (!client.authed) return reply([{ T: 'error', code: 401, msg: 'not authenticated' }]);
      if (m.action === 'subscribe' || m.action === 'unsubscribe') {
        const add = m.action === 'subscribe';
        for (const ch of ['trades', 'quotes', 'bars'] as const) {
          for (const s of (m[ch] as string[] | undefined) ?? []) (add ? client[ch].add(s) : client[ch].delete(s));
        }
        reply([{ T: 'subscription', trades: [...client.trades], quotes: [...client.quotes], bars: [...client.bars] }]);
        if (add && kind === 'options') for (const s of (m.quotes as string[] | undefined) ?? []) this.publishOptionQuote(s);
      }
    });
  }

  private handleTradeStream(ws: WebSocket): void {
    let authed = false;
    ws.on('close', () => this.tradeClients.delete(ws));
    ws.on('message', (raw: Buffer) => {
      const m = JSON.parse(raw.toString());
      if (m.action === 'authenticate') {
        authed = m.data?.key_id === this.o.keyId && m.data?.secret_key === this.o.secretKey;
        ws.send(Buffer.from(JSON.stringify({ stream: 'authorization', data: { status: authed ? 'authorized' : 'unauthorized', action: 'authenticate' } })), { binary: true });
      } else if (m.action === 'listen' && authed) {
        this.tradeClients.add(ws);
        ws.send(Buffer.from(JSON.stringify({ stream: 'listening', data: { streams: ['trade_updates'] } })), { binary: true });
      }
    });
  }

  /** Drop every connected trade stream (reconnect tests). */
  dropTradeStreams(): void {
    for (const ws of this.tradeClients) ws.terminate();
    this.tradeClients.clear();
  }

  dropDataStreams(): void {
    for (const c of this.dataClients) c.ws.terminate();
    this.dataClients.clear();
  }

  private publish(kind: 'stock' | 'options', channel: 'trades' | 'quotes' | 'bars', symbol: string, msg: Record<string, unknown>): void {
    const buf = encode([msg]);
    for (const c of this.dataClients) {
      if (c.kind === kind && c.authed && c[channel].has(symbol) && c.ws.readyState === WebSocket.OPEN) c.ws.send(buf);
    }
  }

  // ── Market controls ─────────────────────────────────────────────────────

  setQuote(symbol: string, bid: number, ask: number): void {
    const p = this.prices.get(symbol)!;
    p.bid = r2(bid);
    p.ask = r2(ask);
    this.publish('stock', 'quotes', symbol, { T: 'q', S: symbol, bx: 'V', bp: p.bid, bs: 3, ax: 'V', ap: p.ask, as: 3, c: ['R'], z: 'C', t: new Date(this.now()) });
    this.repriceOptions(symbol);
    for (const o of this.orders.values()) if (o.symbol === symbol) this.tryFill(o);
  }

  /** Print a trade: updates last price, the forming bar and the quote around it. */
  trade(symbol: string, price: number, size = 100): void {
    const p = this.prices.get(symbol)!;
    p.last = r2(price);
    const t = this.now();
    const minute = Math.floor(t / 60_000) * 60_000;
    const f = this.forming.get(symbol);
    if (!f || f.t !== minute) this.forming.set(symbol, { t: minute, o: p.last, h: p.last, l: p.last, c: p.last, v: size, n: 1, vw: p.last });
    else {
      f.vw = (f.vw * f.v + p.last * size) / (f.v + size);
      f.h = Math.max(f.h, p.last);
      f.l = Math.min(f.l, p.last);
      f.c = p.last;
      f.v += size;
      f.n += 1;
    }
    this.publish('stock', 'trades', symbol, { T: 't', S: symbol, i: Math.floor(Math.random() * 1e12), x: 'V', p: p.last, s: size, c: ['@'], z: 'C', t: new Date(t) });
    this.setQuote(symbol, price - 0.01, price + 0.01);
  }

  /** Publish the official minute bar for the forming bar (as Alpaca does right after the minute). */
  closeBar(symbol: string): RawBar | null {
    const f = this.forming.get(symbol);
    if (!f) return null;
    this.forming.delete(symbol);
    f.vw = r2(f.vw);
    this.history.get(symbol)!.push({ ...f });
    this.publish('stock', 'bars', symbol, { T: 'b', S: symbol, o: f.o, h: f.h, l: f.l, c: f.c, v: f.v, n: f.n, vw: f.vw, t: new Date(f.t) });
    return f;
  }

  private repriceOptions(underlying: string): void {
    for (const c of this.dataClients) {
      if (c.kind !== 'options') continue;
      for (const s of c.quotes) if (s.startsWith(underlying)) this.publishOptionQuote(s);
    }
    for (const o of this.orders.values()) if (o.asset_class === 'us_option' && o.symbol.startsWith(underlying)) this.tryFill(o);
  }

  publishOptionQuote(symbol: string): void {
    const q = this.optionQuote(symbol);
    if (!q) return;
    this.publish('options', 'quotes', symbol, { T: 'q', S: symbol, bx: 'C', bp: q.bid, bs: 50, ax: 'C', ap: q.ask, as: 50, c: 'A', t: new Date(this.now()) });
  }

  /** Re-publish every current quote with the current timestamp (keeps data fresh after a clock jump). */
  refreshQuotes(): void {
    for (const [s, p] of this.prices) this.setQuote(s, p.bid, p.ask);
  }

  /**
   * Harness autopilot: a synthetic random walk at real-time speed so the UI
   * can be exercised without a broker. Clearly synthetic; never used in tests
   * that assert trading outcomes.
   */
  startAutopilot(intervalMs = 400): void {
    let lastMinute = Math.floor(this.now() / 60_000);
    this.autopilot = setInterval(() => {
      const minute = Math.floor(this.now() / 60_000);
      if (minute !== lastMinute) {
        for (const s of this.prices.keys()) this.closeBar(s);
        lastMinute = minute;
      }
      for (const [s, p] of this.prices) {
        const drift = (Math.random() - 0.5) * p.last * 0.0006;
        this.trade(s, p.last + drift, Math.floor(50 + Math.random() * 400));
      }
    }, intervalMs);
  }
}
