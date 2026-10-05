import type { SignalState, TradingEnvironment, Venue } from '@scalp-city/shared';
import { iso, type Db } from '../db/db.js';

/** Persists setups once they become meaningful (CHARGING or better) and their outcome. */
export class SignalRepository {
  constructor(
    private readonly venue: Venue,
    private readonly env: TradingEnvironment,
    private readonly db: Db,
  ) {}

  async upsert(workerId: string, symbol: string, s: SignalState): Promise<void> {
    if (!s.setupId) return;
    await this.db.query(
      `INSERT INTO signals(id, env, worker_id, symbol, direction, charge, conditions, phase, bar_time, ready_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET charge = EXCLUDED.charge, conditions = EXCLUDED.conditions, phase = EXCLUDED.phase,
         ready_at = COALESCE(signals.ready_at, EXCLUDED.ready_at), updated_at = now()`,
      [
        s.setupId,
        this.env,
        workerId,
        symbol,
        s.direction,
        s.charge,
        JSON.stringify(s.conditions),
        s.phase,
        iso(s.formingSince ?? s.barTime ?? 0),
        iso(s.readySince),
      ],
    );
  }

  async setOutcome(setupId: string, outcome: string, orderId: string | null = null): Promise<void> {
    await this.db.query(`UPDATE signals SET outcome = $2, order_id = COALESCE($3, order_id), updated_at = now() WHERE id = $1`, [setupId, outcome, orderId]);
  }

  async markFaded(setupId: string): Promise<void> {
    await this.db.query(`UPDATE signals SET phase = 'FADED', outcome = COALESCE(outcome, 'FADED'), updated_at = now() WHERE id = $1`, [setupId]);
  }

  /** Setups that already produced an entry order (so a replay can't re-trigger them). */
  async consumed(workerId: string, sinceMs: number): Promise<Set<string>> {
    const { rows } = await this.db.query<{ signal_id: string }>(
      `SELECT signal_id FROM orders WHERE venue = $1 AND env = $2 AND worker_id = $3 AND purpose = 'ENTRY' AND signal_id IS NOT NULL AND created_at >= $4`,
      [this.venue, this.env, workerId, iso(sinceMs)],
    );
    return new Set(rows.map((r) => r.signal_id));
  }
}
