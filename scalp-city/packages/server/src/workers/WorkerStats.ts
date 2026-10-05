import { DateTime } from 'luxon';
import type { TradingEnvironment, Venue, WorkerStats } from '@scalp-city/shared';
import type { Clock } from '../core/clock.js';
import { iso, n, type Db } from '../db/db.js';
import { nyDate } from '../market/MarketCalendar.js';

interface BaseStats {
  realizedToday: number;
  tradesToday: number;
  winsToday: number;
  lossesToday: number;
  realizedAllTime: number;
  tradesAllTime: number;
  wins: number;
  losses: number;
  grossWin: number;
  grossLoss: number;
  maxDrawdown: number;
}

const EMPTY: BaseStats = {
  realizedToday: 0,
  tradesToday: 0,
  winsToday: 0,
  lossesToday: 0,
  realizedAllTime: 0,
  tradesAllTime: 0,
  wins: 0,
  losses: 0,
  grossWin: 0,
  grossLoss: 0,
  maxDrawdown: 0,
};

/**
 * Worker performance from the trade journal (spec §115): only realized
 * results of actual broker fills. Trades closed outside Scalp City (P&L
 * unknown) are excluded from win/loss statistics rather than guessed.
 */
export class WorkerStatsService {
  private cache = new Map<string, BaseStats>();

  constructor(
    private readonly venue: Venue,
    private readonly env: TradingEnvironment,
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async refresh(): Promise<void> {
    const now = this.clock.now();
    const today = nyDate(now);
    const midnight = DateTime.fromMillis(now, { zone: 'America/New_York' }).startOf('day').toMillis();
    const next = new Map<string, BaseStats>();
    const get = (w: string) => {
      let s = next.get(w);
      if (!s) {
        s = { ...EMPTY };
        next.set(w, s);
      }
      return s;
    };

    // Entry fills carry realized costs too (broker commission), so every fill event counts.
    const realizedToday = await this.db.query<{ worker_id: string; realized: number }>(
      `SELECT t.worker_id, COALESCE(SUM(e.realized_pnl), 0) AS realized
         FROM trade_events e JOIN trades t ON t.id = e.trade_id
        WHERE t.venue = $1 AND t.env = $2 AND t.worker_id IS NOT NULL AND e.kind IN ('EXIT_FILL', 'ENTRY_FILL') AND e.occurred_at >= $3
        GROUP BY t.worker_id`,
      [this.venue, this.env, iso(midnight)],
    );
    for (const r of realizedToday.rows) get(r.worker_id).realizedToday = n(r.realized) ?? 0;

    const opened = await this.db.query<{ worker_id: string; c: number }>(
      `SELECT worker_id, COUNT(*) AS c FROM trades WHERE venue = $1 AND env = $2 AND worker_id IS NOT NULL AND trading_day = $3 GROUP BY worker_id`,
      [this.venue, this.env, today],
    );
    for (const r of opened.rows) get(r.worker_id).tradesToday = n(r.c) ?? 0;

    const closed = await this.db.query<{ worker_id: string; realized_pnl: number; closed_at: Date }>(
      `SELECT worker_id, realized_pnl, closed_at FROM trades
        WHERE venue = $1 AND env = $2 AND worker_id IS NOT NULL AND status = 'CLOSED' AND realized_pnl IS NOT NULL
        ORDER BY closed_at ASC`,
      [this.venue, this.env],
    );
    const equity = new Map<string, { cum: number; peak: number }>();
    for (const r of closed.rows) {
      const s = get(r.worker_id);
      const pnl = n(r.realized_pnl) ?? 0;
      s.tradesAllTime++;
      s.realizedAllTime += pnl;
      if (pnl > 0) {
        s.wins++;
        s.grossWin += pnl;
      } else if (pnl < 0) {
        s.losses++;
        s.grossLoss += -pnl;
      }
      const closedAt = new Date(r.closed_at).getTime();
      if (closedAt >= midnight) {
        if (pnl > 0) s.winsToday++;
        else if (pnl < 0) s.lossesToday++;
      }
      const e = equity.get(r.worker_id) ?? { cum: 0, peak: 0 };
      e.cum += pnl;
      e.peak = Math.max(e.peak, e.cum);
      s.maxDrawdown = Math.min(s.maxDrawdown, e.cum - e.peak);
      equity.set(r.worker_id, e);
    }
    this.cache = next;
  }

  base(workerId: string): BaseStats {
    return this.cache.get(workerId) ?? { ...EMPTY };
  }

  stats(workerId: string, unrealized: number | null): WorkerStats {
    const s = this.base(workerId);
    const decided = s.wins + s.losses;
    return {
      realizedToday: s.realizedToday,
      unrealized,
      // Unknown unrealized P&L makes the day total unknown: a loss is never hidden behind a 0.
      pnlToday: unrealized === null ? null : s.realizedToday + unrealized,
      tradesToday: s.tradesToday,
      winsToday: s.winsToday,
      lossesToday: s.lossesToday,
      winRate: decided > 0 ? (s.wins / decided) * 100 : null,
      avgWin: s.wins > 0 ? s.grossWin / s.wins : null,
      avgLoss: s.losses > 0 ? -s.grossLoss / s.losses : null,
      profitFactor: s.grossLoss > 0 ? s.grossWin / s.grossLoss : s.grossWin > 0 ? null : null,
      maxDrawdown: s.maxDrawdown,
      realizedAllTime: s.realizedAllTime,
      tradesAllTime: s.tradesAllTime,
    };
  }
}
