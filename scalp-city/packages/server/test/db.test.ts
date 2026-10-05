import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit/AuditLog.js';
import { ManualClock } from '../src/core/clock.js';
import { createTestLogger } from '../src/core/logger.js';
import type { Db } from '../src/db/db.js';
import { MIGRATIONS, migrate, splitSql } from '../src/db/migrations.js';
import { activeWorkerIds } from '../src/workers/definitions.js';
import { WorkerRepository } from '../src/workers/WorkerRepository.js';
import { createEmptyPgliteDb, createPgliteDb } from './support/pglite.js';

let db: Db;

beforeAll(async () => {
  db = await createPgliteDb();
  await migrate(db);
});
afterAll(async () => {
  await db.close();
});

describe('migrations', () => {
  it('applies cleanly and is idempotent', async () => {
    expect(await migrate(db)).toBe(0);
    const { rows } = await db.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version');
    expect(rows.map((r) => Number(r.version))).toEqual(MIGRATIONS.map((m) => m.version));
  });

  it('upgrades an Alpaca-era database: old rows become venue "alpaca", CFD workers allowed', async () => {
    const old = await createEmptyPgliteDb();
    // Apply only the original schema, write a pre-upgrade row, then upgrade.
    const split = splitSql;
    await old.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    await old.tx(async (q) => {
      for (const stmt of split(MIGRATIONS[0]!.sql)) await q.query(stmt);
      await q.query('INSERT INTO schema_migrations(version, name) VALUES (1, $1)', [MIGRATIONS[0]!.name]);
    });
    await old.query(`INSERT INTO positions(env, symbol, asset_class, qty, avg_price, multiplier, opened_at, updated_at) VALUES ('paper','QQQ','us_equity',1,1,1,now(),now())`);
    expect(await migrate(old)).toBe(MIGRATIONS.length - 1);
    const { rows } = await old.query<{ venue: string }>('SELECT venue FROM positions');
    expect(rows[0]!.venue).toBe('alpaca');
    // Same symbol may now exist under another broker without colliding.
    await old.query(`INSERT INTO positions(env, symbol, asset_class, qty, avg_price, multiplier, opened_at, updated_at, venue) VALUES ('paper','QQQ','cfd',1,1,1,now(),now(),'oanda')`);
    await new WorkerRepository(old).seed();
    const w = await old.query<{ id: string; instrument: string }>(`SELECT id, instrument FROM workers WHERE venue = 'oanda' ORDER BY sort_order`);
    expect(w.rows.map((r) => r.id)).toEqual(['oanda-gold', 'oanda-nas100', 'oanda-gbpusd', 'oanda-eurjpy', 'oanda-us30']);
    expect(new Set(w.rows.map((r) => r.instrument))).toEqual(new Set(['CFD']));
    await old.close();
  });

  it('loads only the active worker set, and leaves the other set in the database', async () => {
    const repo = new WorkerRepository(db);
    await repo.seed();
    const ids = async (set: 'etf' | 'options') => (await repo.list('alpaca', activeWorkerIds('alpaca', set))).map((w) => w.id);
    expect(await ids('etf')).toEqual(['etf-gold', 'etf-nasdaq', 'etf-us30', 'etf-gbp', 'etf-eur']);
    expect(await ids('options')).toEqual(['qqq-og', 'qqq', 'qqq-trend', 'spy', 'iwm']);
    // Nothing is deleted: switching the set back finds the old workers (and their history) as they were.
    expect((await repo.list('alpaca')).length).toBe(10);
    expect((await repo.list('oanda', activeWorkerIds('oanda', 'etf'))).length).toBe(5);
    const etf = (await repo.list('alpaca', activeWorkerIds('alpaca', 'etf'))).map((w) => [w.symbol, w.instrument, w.timeframe, w.allowShort]);
    expect(etf).toEqual([
      ['GLD', 'EQUITY', '1Min', false],
      ['QQQ', 'EQUITY', '1Min', false],
      ['DIA', 'EQUITY', '1Min', false],
      ['FXB', 'EQUITY', '5Min', false],
      ['FXE', 'EQUITY', '5Min', false],
    ]);
  });

  it('splits SQL without breaking dollar-quoted bodies', () => {
    const parts = splitSql(`CREATE TABLE a(x int); -- c;omment\nCREATE FUNCTION f() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'x;y'; END; $$ LANGUAGE plpgsql;`);
    expect(parts).toHaveLength(2);
    expect(parts[1]).toContain("RAISE EXCEPTION 'x;y'; END;");
  });

  it('refuses a second ENTRY order for the same signal', async () => {
    await new WorkerRepository(db).seed();
    const insert = (id: string, coid: string) =>
      db.query(
        `INSERT INTO orders(id, env, client_order_id, worker_id, source, purpose, signal_id, symbol, asset_class, side, type, time_in_force, qty, state, created_at, updated_at)
         VALUES ($1,'paper',$2,'qqq-og','WORKER','ENTRY','sig-1','QQQ','us_equity','buy','market','day',1,'CREATED',now(),now())`,
        [id, coid],
      );
    await insert('o1', 'c1');
    await expect(insert('o2', 'c2')).rejects.toThrow();
  });
});

describe('audit log', () => {
  it('chains hashes and verifies', async () => {
    const audit = new AuditLog(db, createTestLogger(), new ManualClock(Date.UTC(2026, 9, 5, 14, 0)));
    await audit.record({ action: 'SYSTEM_START', actor: 'system', env: 'paper' });
    await audit.record({ action: 'ORDER_REQUESTED', actor: 'worker:qqq-og', env: 'paper', symbol: 'QQQ', details: { qty: 2, nested: { b: 1, a: 2 } } });
    await audit.record({ action: 'KILL_SWITCH', actor: 'rayan', env: 'paper', details: { password: 'hunter2' } });
    const v = await audit.verify();
    expect(v).toEqual({ ok: true, checked: 3, brokenAtId: null });
    const rows = await audit.list({ limit: 10 });
    expect(rows[0]!.details).toEqual({ password: '[REDACTED]' });
    expect(rows[1]!.prevHash).toBe(rows[2]!.hash);
  });

  it('is append-only at the database level', async () => {
    await expect(db.query(`UPDATE audit_logs SET actor = 'mallory'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);
    await expect(db.query(`TRUNCATE audit_logs`)).rejects.toThrow(/append-only/);
  });
});
