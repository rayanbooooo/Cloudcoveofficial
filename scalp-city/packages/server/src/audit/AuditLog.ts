import { createHash } from 'node:crypto';
import type { TradingEnvironment } from '@scalp-city/shared';
import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import { iso, ms, type Db } from '../db/db.js';

export type AuditAction =
  | 'SYSTEM_START'
  | 'RECOVERY_COMPLETE'
  | 'LOGIN'
  | 'LOGIN_FAILED'
  | 'LOGOUT'
  | 'LIVE_MODE_ENABLED'
  | 'LIVE_MODE_DISARMED'
  | 'LIVE_MODE_ENABLE_REJECTED'
  | 'ENV_SWITCHED'
  | 'ORDER_REQUESTED'
  | 'ORDER_SUBMITTED'
  | 'ORDER_ACCEPTED'
  | 'ORDER_PARTIALLY_FILLED'
  | 'ORDER_FILLED'
  | 'ORDER_REJECTED'
  | 'ORDER_CANCEL_REQUESTED'
  | 'ORDER_CANCEL_FAILED'
  | 'ORDER_CANCELED'
  | 'ORDER_EXPIRED'
  | 'ORDER_ERROR'
  | 'ORDER_RESOLVED'
  | 'POSITION_OPENED'
  | 'POSITION_CLOSED'
  | 'RISK_BLOCK'
  | 'RISK_LIMITS_CHANGED'
  | 'KILL_SWITCH'
  | 'KILL_SWITCH_RELEASED'
  | 'FLATTEN_ALL'
  | 'AUTOTRADING_ON'
  | 'AUTOTRADING_OFF'
  | 'ENTRIES_PAUSED'
  | 'ENTRIES_RESUMED'
  | 'WORKER_ENABLED'
  | 'WORKER_DISABLED'
  | 'WORKER_CONFIG_CHANGED'
  | 'BREAKER_TRIPPED'
  | 'BREAKER_RESET'
  | 'RECONCILIATION_MISMATCH'
  | 'RECONCILIATION_ACCEPTED'
  | 'EXTERNAL_ORDER_SEEN';

export interface AuditEntry {
  action: AuditAction;
  actor: string;
  env?: TradingEnvironment | null;
  workerId?: string | null;
  symbol?: string | null;
  orderId?: string | null;
  clientOrderId?: string | null;
  details?: Record<string, unknown>;
}

export interface AuditRow extends Required<Omit<AuditEntry, 'details'>> {
  id: number;
  occurredAt: number;
  details: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);
const SECRET_KEY_RE = /(secret|password|token|apikey|api_key|key_id|authorization|cookie)/i;

/** Remove anything that looks like a credential before it is persisted. */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? '[REDACTED]' : scrub(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

/** Deterministic JSON (sorted keys) so the hash survives a jsonb round trip. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

function hashRow(prevHash: string, r: Omit<AuditRow, 'id' | 'hash' | 'prevHash'>): string {
  const body = canonicalJson({
    prevHash,
    occurredAt: new Date(r.occurredAt).toISOString(),
    actor: r.actor,
    action: r.action,
    env: r.env,
    workerId: r.workerId,
    symbol: r.symbol,
    orderId: r.orderId,
    clientOrderId: r.clientOrderId,
    details: r.details,
  });
  return createHash('sha256').update(body).digest('hex');
}

/**
 * Immutable, tamper-evident audit trail for every live action (spec §38).
 * Appends are serialized in-process and guarded by an advisory lock so the
 * hash chain stays linear even if two processes ever share a database.
 */
export class AuditLog {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
    private readonly clock: Clock,
  ) {}

  /** Append an entry. Failures are logged loudly but never throw into trading code paths. */
  record(entry: AuditEntry): Promise<void> {
    const occurredAt = this.clock.now();
    const run = async () => {
      const row = {
        occurredAt,
        actor: entry.actor,
        action: entry.action,
        env: entry.env ?? null,
        workerId: entry.workerId ?? null,
        symbol: entry.symbol ?? null,
        orderId: entry.orderId ?? null,
        clientOrderId: entry.clientOrderId ?? null,
        details: (scrub(entry.details ?? {}) as Record<string, unknown>) ?? {},
      };
      await this.db.tx(async (q) => {
        await q.query('SELECT pg_advisory_xact_lock(727274)');
        const prev = await q.query<{ hash: string }>('SELECT hash FROM audit_logs ORDER BY id DESC LIMIT 1');
        const prevHash = prev.rows[0]?.hash ?? GENESIS;
        const hash = hashRow(prevHash, row);
        await q.query(
          `INSERT INTO audit_logs (occurred_at, actor, action, env, worker_id, symbol, order_id, client_order_id, details, prev_hash, hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            iso(row.occurredAt),
            row.actor,
            row.action,
            row.env,
            row.workerId,
            row.symbol,
            row.orderId,
            row.clientOrderId,
            JSON.stringify(row.details),
            prevHash,
            hash,
          ],
        );
      });
      this.logger.info({ audit: row.action, actor: row.actor, env: row.env, workerId: row.workerId, symbol: row.symbol, clientOrderId: row.clientOrderId }, 'audit');
    };
    const p = this.chain.then(run, run).catch((err) => {
      this.logger.error({ err, action: entry.action }, 'AUDIT WRITE FAILED');
    });
    this.chain = p;
    return p;
  }

  /** Wait until all queued appends have been written. */
  flush(): Promise<void> {
    return this.chain;
  }

  async list(opts: { limit?: number; beforeId?: number; action?: string } = {}): Promise<AuditRow[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (opts.beforeId) {
      params.push(opts.beforeId);
      where.push(`id < $${params.length}`);
    }
    if (opts.action) {
      params.push(opts.action);
      where.push(`action = $${params.length}`);
    }
    params.push(Math.min(opts.limit ?? 100, 500));
    const { rows } = await this.db.query(
      `SELECT * FROM audit_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(toRow);
  }

  /** Re-hash the whole chain; reports the first row whose hash or link is wrong. */
  async verify(): Promise<{ ok: boolean; checked: number; brokenAtId: number | null }> {
    const { rows } = await this.db.query('SELECT * FROM audit_logs ORDER BY id ASC');
    let prev = GENESIS;
    let checked = 0;
    for (const raw of rows) {
      const r = toRow(raw);
      const expected = hashRow(prev, r);
      if (r.prevHash !== prev || r.hash !== expected) return { ok: false, checked, brokenAtId: r.id };
      prev = r.hash;
      checked++;
    }
    return { ok: true, checked, brokenAtId: null };
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toRow(r: any): AuditRow {
  return {
    id: Number(r.id),
    occurredAt: ms(r.occurred_at)!,
    actor: r.actor,
    action: r.action,
    env: r.env,
    workerId: r.worker_id,
    symbol: r.symbol,
    orderId: r.order_id,
    clientOrderId: r.client_order_id,
    details: typeof r.details === 'string' ? JSON.parse(r.details) : (r.details ?? {}),
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}
