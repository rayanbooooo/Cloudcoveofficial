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

  it('standby server passes health checks and trades nothing', async () => {
    const s = await startStandbyServer('127.0.0.1', 0);
    const health = await fetch(`http://127.0.0.1:${s.port}/api/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, phase: 'STANDBY' });
    const api = await fetch(`http://127.0.0.1:${s.port}/api/orders`, { method: 'POST' });
    expect(api.status).toBe(503);
    await s.close();
  });
});
