import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';

/** Advisory-lock key: one trading process per database, and therefore per account. */
const LOCK_KEY: [number, number] = [0x5c17, 0x7ad1];

/**
 * Single-writer guard: exactly one Scalp City process may trade against a
 * database. Hosting platforms briefly run the old and the new instance side
 * by side during a deploy, and a mis-set instance count would run two for
 * good. Two traders on one account means duplicate entries and, for shares,
 * a second exit sell that opens a short.
 *
 * The lock is a Postgres session-level advisory lock held on a dedicated
 * connection for the life of the process. If that connection drops, this
 * process can no longer prove it is the only trader, so `onLost` fires (the
 * server exits and the platform restarts it, and recovery reconciles).
 */
export class InstanceLock {
  private client: pg.Client | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private held = false;

  private readonly heartbeatMs: number;
  private readonly key: [number, number];

  constructor(
    private readonly connectionString: string,
    private readonly onLost: (reason: string) => void,
    opts: { heartbeatMs?: number; key?: [number, number] } = {},
  ) {
    this.heartbeatMs = opts.heartbeatMs ?? 10_000;
    this.key = opts.key ?? LOCK_KEY;
  }

  get isHeld(): boolean {
    return this.held;
  }

  /** Server process id of the lock connection (diagnostics and tests). */
  get backendPid(): number | null {
    return (this.client as (pg.Client & { processID?: number }) | null)?.processID ?? null;
  }

  /** One attempt. True when this process now holds the lock. */
  async tryAcquire(): Promise<boolean> {
    if (this.held) return true;
    const client = new pg.Client({ connectionString: this.connectionString, connectionTimeoutMillis: 5_000, application_name: 'scalp-city-trading-lock' });
    await client.connect();
    let ok = false;
    try {
      const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', this.key);
      ok = rows[0]?.ok === true;
    } finally {
      if (!ok) await client.end().catch(() => undefined);
    }
    if (!ok) return false;
    this.client = client;
    this.held = true;
    client.on('error', (err) => this.lose(`lock connection error: ${err.message}`));
    client.on('end', () => this.lose('lock connection closed'));
    this.heartbeat = setInterval(() => {
      client.query('SELECT 1').catch((err: Error) => this.lose(`lock heartbeat failed: ${err.message}`));
    }, this.heartbeatMs);
    this.heartbeat.unref();
    return true;
  }

  /**
   * Free the lock from a holder that is dead but not yet noticed. When a host is torn down without closing
   * its database connection, Postgres keeps that session (and its lock) until the connection times out,
   * which can take hours, and every new instance would wait in standby for all that time. A live holder
   * touches its connection every `heartbeatMs`, so a lock session idle for `staleMs` or longer belongs to a
   * dead process: end it. Only the lock's own session is ever ended, and never one that is busy or fresh.
   * (A holder that was merely unreachable finds its connection gone at its next heartbeat and exits.)
   */
  async evictDeadHolder(staleMs: number): Promise<{ pid: number; idleMs: number } | null> {
    const client = new pg.Client({ connectionString: this.connectionString, connectionTimeoutMillis: 5_000, application_name: 'scalp-city-lock-watch' });
    await client.connect();
    try {
      const { rows } = await client.query<{ pid: number; state: string | null; idle_ms: string | null }>(
        `SELECT l.pid, a.state, EXTRACT(EPOCH FROM (now() - a.state_change)) * 1000 AS idle_ms
           FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE l.locktype = 'advisory' AND l.classid = $1::oid AND l.objid = $2::oid AND l.objsubid = 2 AND l.granted
            AND a.application_name = 'scalp-city-trading-lock' AND l.pid <> pg_backend_pid()`,
        this.key,
      );
      const holder = rows[0];
      if (!holder || holder.idle_ms === null || holder.state === 'active') return null;
      const idleMs = Number(holder.idle_ms);
      if (!(idleMs >= staleMs)) return null;
      const { rows: done } = await client.query<{ ok: boolean }>('SELECT pg_terminate_backend($1) AS ok', [holder.pid]);
      return done[0]?.ok === true ? { pid: holder.pid, idleMs } : null;
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  /**
   * Retry until acquired. `onWait` runs once, after the first failed attempt
   * (used to start the standby server). With `staleHolderMs`, a holder whose
   * heartbeat stopped that long ago is evicted (see evictDeadHolder).
   * Returns false if `signal` aborts.
   */
  async acquire(
    opts: {
      retryMs?: number;
      onWait?: () => void | Promise<void>;
      onError?: (err: Error) => void;
      onEvict?: (holder: { pid: number; idleMs: number }) => void;
      staleHolderMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<boolean> {
    let waited = false;
    let lastCheck = 0;
    for (;;) {
      if (opts.signal?.aborted) return false;
      try {
        if (await this.tryAcquire()) return true;
      } catch (err) {
        opts.onError?.(err as Error);
      }
      if (!waited) {
        waited = true;
        await opts.onWait?.();
      }
      if (opts.staleHolderMs !== undefined && Date.now() - lastCheck >= Math.min(15_000, opts.staleHolderMs)) {
        lastCheck = Date.now();
        try {
          const evicted = await this.evictDeadHolder(opts.staleHolderMs);
          if (evicted) opts.onEvict?.(evicted);
        } catch (err) {
          opts.onError?.(err as Error);
        }
      }
      await new Promise((r) => setTimeout(r, opts.retryMs ?? 3_000));
    }
  }

  private lose(reason: string): void {
    if (!this.held) return;
    this.held = false;
    this.stopHeartbeat();
    this.client = null;
    this.onLost(reason);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false; // first, so the connection's 'end' event is not reported as a loss
    this.stopHeartbeat();
    const c = this.client;
    this.client = null;
    await c?.end().catch(() => undefined);
  }
}

const STANDBY_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Scalp City · standby</title></head>
<body style="margin:0;background:#04070c;color:#cfd8e6;font:14px/1.5 system-ui,sans-serif;display:grid;place-items:center;height:100vh">
<div style="max-width:420px;padding:24px;text-align:center"><div style="letter-spacing:.24em;font-weight:700">SCALP CITY</div>
<p>Starting up: the previous instance is still finishing. Only one instance trades at a time. This page refreshes on its own.</p><p style="font-size:12px;opacity:.7">Still here after five minutes? Check that only one Scalp City service uses this database, or restart this one.</p></div></body></html>`;

/**
 * Minimal server for a waiting instance: health checks pass (so a platform's
 * zero-downtime deploy can complete and stop the old instance), API calls get a
 * JSON "starting up" answer and everything else a self-refreshing "starting up"
 * page. No trading happens here.
 */
export async function startStandbyServer(host: string, port: number): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/healthz')) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, phase: 'STANDBY' }));
      return;
    }
    if (req.url?.startsWith('/api/')) {
      // The app asks for data, not a page: answer in the shape it understands so it can say "starting up".
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: 'STARTING', message: 'The server is starting up. Wait a minute and try again.' }));
      return;
    }
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '5', 'cache-control': 'no-store' });
    res.end(STANDBY_HTML);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
