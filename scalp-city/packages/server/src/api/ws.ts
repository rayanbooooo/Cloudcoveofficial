import type { WebSocket } from 'ws';
import type { Bar, ServerMessageType } from '@scalp-city/shared';
import type { SessionRecord } from '../auth/AuthService.js';
import type { App } from '../system/App.js';

interface Client {
  socket: WebSocket;
  session: SessionRecord;
  seq: number;
  alive: boolean;
  needsSnapshot: boolean;
}

const HIGH_WATER = 2 * 1024 * 1024;
const LOW_WATER = 256 * 1024;

/**
 * Server → browser real-time push (spec §74). Market data is coalesced and
 * flushed every 250 ms so a burst of ticks never becomes a burst of React
 * renders (spec §87). A slow client is not allowed to buffer unboundedly:
 * it skips market deltas and gets a fresh snapshot once it drains.
 */
export class WsGateway {
  private clients = new Set<Client>();
  private dirtyQuotes = false;
  private dirtyOptions = false;
  private bars = new Map<string, Bar>();
  private dirtyWorkers = new Set<string>();
  private dirtyPortfolio = false;
  private dirtySystem = false;
  private timers: NodeJS.Timeout[] = [];
  private offs: (() => void)[] = [];

  constructor(private readonly app: App) {}

  start(): void {
    const bus = this.app.bus;
    this.offs.push(bus.on('MARKET_TICK', (t) => (t.kind === 'option_quote' || t.kind === 'option_trade' ? (this.dirtyOptions = true) : (this.dirtyQuotes = true))));
    this.offs.push(bus.on('MARKET_BAR', ({ bar }) => this.bars.set(`${bar.symbol}|${bar.t}`, bar)));
    this.offs.push(bus.on('WORKER_UPDATED', ({ workerId }) => this.dirtyWorkers.add(workerId)));
    this.offs.push(bus.on('SIGNAL_UPDATED', ({ workerId }) => this.dirtyWorkers.add(workerId)));
    for (const ev of ['FILL', 'POSITION_UPDATED', 'POSITION_OPENED', 'POSITION_CLOSED', 'ACCOUNT_UPDATED'] as const) {
      this.offs.push(bus.on(ev, () => (this.dirtyPortfolio = true)));
    }
    for (const ev of ['SYSTEM_UPDATED', 'BROKER_STATUS', 'MARKET_DATA_STATUS', 'KILL_SWITCH'] as const) {
      this.offs.push(bus.on(ev, () => (this.dirtySystem = true)));
    }
    this.offs.push(bus.on('ORDER_UPDATED', ({ order }) => {
      const ctx = this.app.ctx;
      if (ctx.configured) this.broadcast('order.updated', ctx.orders.view(order));
      this.dirtyPortfolio = true;
    }));
    this.offs.push(bus.on('TIMELINE', (e) => this.broadcast('timeline.event', e)));
    this.offs.push(bus.on('ALERT', (a) => this.broadcast('alert', a)));
    this.offs.push(bus.on('CITY_EVENT', (e) => this.broadcast('city.event', e)));

    this.timers.push(setInterval(() => this.flush(), 250));
    // Data ages and clocks move every second even without events.
    this.timers.push(setInterval(() => (this.dirtySystem = true), 1000));
    this.timers.push(setInterval(() => this.broadcast('heartbeat', { serverTime: this.app.clock.now() }), 5000));
    this.timers.push(
      setInterval(() => {
        for (const c of this.clients) {
          if (!c.alive) {
            c.socket.terminate();
            continue;
          }
          c.alive = false;
          try {
            c.socket.ping();
          } catch {
            /* closed */
          }
        }
      }, 15_000),
    );
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    for (const off of this.offs) off();
    for (const c of this.clients) c.socket.close(1001, 'server shutting down');
    this.clients.clear();
  }

  handle(socket: WebSocket, session: SessionRecord): void {
    const client: Client = { socket, session, seq: 0, alive: true, needsSnapshot: false };
    this.clients.add(client);
    this.app.views.wsClients = this.clients.size;
    socket.on('pong', () => (client.alive = true));
    socket.on('close', () => {
      this.clients.delete(client);
      this.app.views.wsClients = this.clients.size;
    });
    socket.on('error', () => socket.terminate());
    socket.on('message', (raw) => {
      let msg: { type?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'resync') this.sendSnapshot(client);
      else if (msg.type === 'ping') this.send(client, 'heartbeat', JSON.stringify({ serverTime: this.app.clock.now() }));
    });
    this.sendSnapshot(client);
  }

  private sendSnapshot(c: Client): void {
    const snap = this.app.views.snapshot(this.app.ctx, this.app.availableEnvs());
    c.needsSnapshot = false;
    this.send(c, 'snapshot', JSON.stringify(snap));
  }

  private send(c: Client, type: ServerMessageType, dataJson: string): void {
    if (c.socket.readyState !== c.socket.OPEN) return;
    c.seq += 1;
    c.socket.send(`{"type":"${type}","seq":${c.seq},"data":${dataJson}}`);
  }

  private broadcast(type: ServerMessageType, data: unknown, opts: { droppable?: boolean } = {}): void {
    if (this.clients.size === 0) return;
    const json = JSON.stringify(data);
    for (const c of this.clients) {
      if (c.needsSnapshot) {
        if (c.socket.bufferedAmount < LOW_WATER) this.sendSnapshot(c);
        continue;
      }
      if (opts.droppable && c.socket.bufferedAmount > HIGH_WATER) {
        // Rather than queue stale market data, skip it and resync with a snapshot.
        c.needsSnapshot = true;
        continue;
      }
      this.send(c, type, json);
    }
  }

  private flush(): void {
    if (this.clients.size === 0) {
      this.bars.clear();
      this.dirtyWorkers.clear();
      this.dirtyQuotes = this.dirtyOptions = this.dirtyPortfolio = this.dirtySystem = false;
      return;
    }
    const ctx = this.app.ctx;
    const v = this.app.views;
    if (this.dirtyQuotes || this.dirtyOptions) {
      this.broadcast(
        'market.tick',
        {
          quotes: this.dirtyQuotes ? Object.values(v.quotes(ctx)) : [],
          optionQuotes: this.dirtyOptions && ctx.configured ? ctx.marketData.optionQuotes() : [],
        },
        { droppable: true },
      );
      this.dirtyQuotes = this.dirtyOptions = false;
    }
    if (this.bars.size) {
      this.broadcast('market.bar', { bars: [...this.bars.values()] }, { droppable: true });
      this.bars.clear();
    }
    if (this.dirtyWorkers.size && ctx.configured) {
      for (const id of this.dirtyWorkers) {
        const w = ctx.workers.get(id);
        if (w) this.broadcast('worker.updated', w.view());
      }
      this.dirtyWorkers.clear();
    }
    if (this.dirtyPortfolio) {
      this.broadcast('account.updated', v.account(ctx));
      this.broadcast('position.updated', { positions: v.positions(ctx) });
      this.dirtyPortfolio = false;
      this.dirtySystem = true;
    }
    if (this.dirtySystem) {
      this.broadcast('system.updated', v.system(ctx, this.app.availableEnvs()));
      this.broadcast('risk.updated', v.risk(ctx));
      this.dirtySystem = false;
    }
  }
}
