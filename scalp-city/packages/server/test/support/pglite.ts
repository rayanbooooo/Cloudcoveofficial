import type { Db, QueryResult, Queryable } from '../../src/db/db.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * In-process PostgreSQL (WASM) used by the automated tests so they run the
 * exact same SQL and migrations as production without a database server.
 * Loaded dynamically: it is a devDependency and never part of the runtime.
 */
type PGliteInstance = Awaited<ReturnType<typeof newInstance>>;

async function newInstance() {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  await pg.waitReady;
  return pg;
}

let template: Promise<PGliteInstance> | null = null;

/**
 * A fresh, fully migrated database. One template per test worker is migrated
 * once and cloned for each test — same SQL, a fraction of the start-up cost.
 */
export async function createPgliteDb(): Promise<Db> {
  if (!template) {
    template = (async () => {
      const t = await newInstance();
      const { migrate } = await import('../../src/db/migrations.js');
      await migrate(wrap(t));
      return t;
    })();
  }
  const pg = (await (await template).clone()) as PGliteInstance;
  return wrap(pg);
}

function wrap(pg: PGliteInstance): Db {
  const toResult = <T>(r: { rows: unknown[]; affectedRows?: number }): QueryResult<T> => ({
    rows: r.rows as T[],
    rowCount: r.affectedRows ?? r.rows.length,
  });

  // PGlite serialises queries internally; transactions get their own handle.
  const db: Db = {
    async query<T = any>(sql: string, params: unknown[] = []) {
      return toResult<T>(await pg.query(sql, params as any[]));
    },
    async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      return pg.transaction(async (tx) => {
        const q: Queryable = {
          query: async <R = any>(sql: string, params: unknown[] = []) => toResult<R>(await tx.query(sql, params as any[])),
        };
        return fn(q);
      });
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
    async ping() {
      return true;
    },
    async close() {
      await pg.close();
    },
  };
  return db;
}
