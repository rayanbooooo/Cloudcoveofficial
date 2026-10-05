import type { Instrument, StrategyParams, Timeframe, Venue, WorkerConfigView } from '@scalp-city/shared';
import type { Db } from '../db/db.js';
import { STRATEGIES, WORKERS, workerDefaults } from './definitions.js';

interface StoredWorkerConfig {
  entrySlippagePct: number;
  entryTimeoutSec: number;
  limits: WorkerConfigView['limits'];
  exits: WorkerConfigView['exits'];
  options: WorkerConfigView['options'];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const parse = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);

export class WorkerRepository {
  constructor(private readonly db: Db) {}

  /** Insert default strategies/workers that don't exist yet. Never overwrites user changes. */
  async seed(): Promise<void> {
    for (const s of STRATEGIES) {
      await this.db.query(
        `INSERT INTO strategies(id, name, params) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
        [s.id, s.name, JSON.stringify(s.params)],
      );
    }
    for (const w of WORKERS) {
      const config: StoredWorkerConfig = {
        entrySlippagePct: w.entrySlippagePct,
        entryTimeoutSec: w.entryTimeoutSec,
        limits: w.limits,
        exits: w.exits,
        options: w.options,
      };
      await this.db.query(
        `INSERT INTO workers(id, name, symbol, strategy_id, timeframe, instrument, allow_short, config, sort_order, venue)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
        [w.id, w.name, w.symbol, w.strategyId, w.timeframe, w.instrument, w.allowShort, JSON.stringify(config), w.sortOrder, w.venue],
      );
    }
  }

  /** Workers of one venue (broker), in display order. `ids` limits them to the active set. */
  async list(venue: Venue, ids?: readonly string[]): Promise<WorkerConfigView[]> {
    const { rows } = await this.db.query(
      `SELECT w.*, s.name AS strategy_name, s.params AS strategy_params
         FROM workers w JOIN strategies s ON s.id = w.strategy_id
        WHERE w.venue = $1 AND ($2::text[] IS NULL OR w.id = ANY($2::text[]))
        ORDER BY w.sort_order, w.id`,
      [venue, ids ? [...ids] : null],
    );
    return rows.map((r: any) => {
      const stored = parse(r.config) as StoredWorkerConfig;
      // Fields added in later versions get their defaults; stored values always win.
      const d = workerDefaults(r.id);
      const cfg = { ...stored, limits: { ...d.limits, ...stored.limits }, exits: { ...d.exits, ...stored.exits }, options: { ...d.options, ...stored.options } };
      return {
        id: r.id,
        name: r.name,
        symbol: r.symbol,
        strategyName: r.strategy_name,
        timeframe: r.timeframe as Timeframe,
        instrument: r.instrument as Instrument,
        allowShort: r.allow_short === true,
        entrySlippagePct: cfg.entrySlippagePct,
        entryTimeoutSec: cfg.entryTimeoutSec,
        params: parse(r.strategy_params) as StrategyParams,
        limits: cfg.limits,
        exits: cfg.exits,
        options: cfg.options,
      };
    });
  }

  async update(cfg: WorkerConfigView): Promise<void> {
    const stored: StoredWorkerConfig = {
      entrySlippagePct: cfg.entrySlippagePct,
      entryTimeoutSec: cfg.entryTimeoutSec,
      limits: cfg.limits,
      exits: cfg.exits,
      options: cfg.options,
    };
    await this.db.query(
      `UPDATE workers SET instrument = $2, allow_short = $3, config = $4, updated_at = now() WHERE id = $1`,
      [cfg.id, cfg.instrument, cfg.allowShort, JSON.stringify(stored)],
    );
  }
}
