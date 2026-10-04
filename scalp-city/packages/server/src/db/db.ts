import pg from 'pg';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  /** Run `fn` inside a transaction; rolls back if it throws. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Execute a multi-statement SQL script (migrations). */
  exec(sql: string): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

// Return NUMERIC and INT8 as JS numbers. Monetary values originate from the
// broker as decimal strings parsed to doubles anyway; keeping one numeric
// type end-to-end avoids string/number confusion in comparisons.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export class PgDb implements Db {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  }

  async query<T = any>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const r = await this.pool.query(sql, params as any[]);
    return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
  }

  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const q: Queryable = {
      query: async <R = any>(sql: string, params: unknown[] = []) => {
        const r = await client.query(sql, params as any[]);
        return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
      },
    };
    try {
      await client.query('BEGIN');
      const out = await fn(q);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Normalise a DB timestamp (Date | string | number | null) to epoch ms. */
export function ms(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/** Normalise a DB numeric (number | string | null) to number | null. */
export function n(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : null;
}

export function iso(t: number | null | undefined): string | null {
  return t === null || t === undefined ? null : new Date(t).toISOString();
}
