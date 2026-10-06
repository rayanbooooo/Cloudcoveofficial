import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { InstanceLock, startStandbyServer } from '../src/system/InstanceLock.js';

// Advisory locks need a real PostgreSQL server (two connections), so these
// run only when TEST_DATABASE_URL is set, e.g. against `npm run db:up`.
const url = process.env.TEST_DATABASE_URL;
const pgIt = url ? it : it.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// A private lock key per run, so a real Scalp City instance using the same
// database is neither blocked by nor disturbed by these tests.
const key = (): [number, number] => [0x7e57, Math.floor(Math.random() * 2 ** 31)];

describe('single-instance trading lock', () => {
  pgIt('lets exactly one process hold it; a waiting process takes over on release', async () => {
    const k = key();
    const a = new InstanceLock(url!, () => {}, { key: k });
    const b = new InstanceLock(url!, () => {}, { key: k });
    expect(await a.tryAcquire()).toBe(true);
    expect(await b.tryAcquire()).toBe(false);

    let waited = 0;
    const pending = b.acquire({ retryMs: 50, onWait: () => void waited++ });
    await sleep(250);
    expect(waited).toBe(1); // standby started once, not on every retry
    expect(b.isHeld).toBe(false);

    await a.release();
    expect(await pending).toBe(true);
    expect(b.isHeld).toBe(true);
    await b.release();
  });

  pgIt('reports a lost lock connection instead of trading on without it', async () => {
    const k = key();
    const reasons: string[] = [];
    const a = new InstanceLock(url!, (r) => reasons.push(r), { heartbeatMs: 100, key: k });
    expect(await a.tryAcquire()).toBe(true);

    // Kill exactly this lock's connection (never anyone else's).
    const pid = a.backendPid;
    expect(pid).toBeGreaterThan(0);
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    await admin.end();

    for (let i = 0; i < 50 && reasons.length === 0; i++) await sleep(100);
    expect(reasons).toHaveLength(1);
    expect(a.isHeld).toBe(false);

    // The lock is free for the replacement process.
    const b = new InstanceLock(url!, () => {}, { key: k });
    expect(await b.tryAcquire()).toBe(true);
    await b.release();
  });

  pgIt('frees the lock from a holder that stopped heartbeating, and leaves a live holder alone', async () => {
    const k = key();
    const lost: string[] = [];
    const dead = new InstanceLock(url!, (r) => lost.push(r), { key: k, heartbeatMs: 3_600_000 }); // never touches its connection again
    const live = new InstanceLock(url!, () => {}, { key: k });
    const waiter = new InstanceLock(url!, () => {}, { key: k });
    expect(await dead.tryAcquire()).toBe(true);
    const deadPid = dead.backendPid; // gone once its session is ended
    expect(await waiter.tryAcquire()).toBe(false);
    // Fresh holder: nothing to evict.
    expect(await waiter.evictDeadHolder(400)).toBeNull();
    await sleep(600);
    // Idle past the limit with no heartbeat: its session is ended, which frees the lock.
    const evicted = await waiter.evictDeadHolder(400);
    expect(evicted?.pid).toBe(deadPid);
    expect(evicted!.idleMs).toBeGreaterThanOrEqual(400);
    await sleep(100);
    expect(lost.length).toBe(1); // the evicted process learns it lost the lock
    expect(await live.tryAcquire()).toBe(true);
    // A holder that keeps its heartbeat is never evicted, however long we wait.
    const beating = new InstanceLock(url!, () => {}, { key: key(), heartbeatMs: 50 });
    expect(await beating.tryAcquire()).toBe(true);
    const other = new InstanceLock(url!, () => {}, { key: (beating as unknown as { key: [number, number] }).key });
    await sleep(500);
    expect(await other.evictDeadHolder(400)).toBeNull();
    expect(await other.tryAcquire()).toBe(false);
    await Promise.all([live.release(), beating.release()]);
  });

  pgIt('a waiting process takes over from a dead holder by itself', async () => {
    const k = key();
    const dead = new InstanceLock(url!, () => {}, { key: k, heartbeatMs: 3_600_000 });
    const next = new InstanceLock(url!, () => {}, { key: k });
    expect(await dead.tryAcquire()).toBe(true);
    const deadPid = dead.backendPid;
    const evictions: number[] = [];
    const got = await next.acquire({ retryMs: 50, staleHolderMs: 300, onEvict: (h) => evictions.push(h.pid) });
    expect(got).toBe(true);
    expect(evictions).toEqual([deadPid]);
    await next.release();
  });

  it('standby server passes health checks and trades nothing', async () => {
    const s = await startStandbyServer('127.0.0.1', 0);
    const health = await fetch(`http://127.0.0.1:${s.port}/api/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, phase: 'STANDBY' });
    const api = await fetch(`http://127.0.0.1:${s.port}/api/orders`, { method: 'POST' });
    expect(api.status).toBe(503);
    expect(await api.json()).toMatchObject({ error: 'STARTING' }); // the app can say "starting up" instead of failing to parse a page
    const page = await fetch(`http://127.0.0.1:${s.port}/`);
    expect(page.status).toBe(503);
    expect(page.headers.get('content-type')).toContain('text/html');
    await s.close();
  });
});
