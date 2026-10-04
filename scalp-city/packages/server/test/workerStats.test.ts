import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/core/clock.js';
import { WorkerStatsService } from '../src/workers/WorkerStats.js';
import { createPgliteDb } from './support/pglite.js';

describe('WorkerStats — day P&L is never assumed', () => {
  it('reports pnlToday as unknown when unrealized P&L is unknown, and as realized when flat', async () => {
    const db = await createPgliteDb();
    const stats = new WorkerStatsService('paper', db, new ManualClock(Date.UTC(2026, 9, 5, 15)));
    await stats.refresh();
    // Flat: nothing unrealized.
    expect(stats.stats('qqq', 0).pnlToday).toBe(0);
    // Holding a position whose mark is unknown: the day total is unknown, not "realized + 0".
    const unknown = stats.stats('qqq', null);
    expect(unknown.unrealized).toBeNull();
    expect(unknown.pnlToday).toBeNull();
    await db.close();
  });
});
