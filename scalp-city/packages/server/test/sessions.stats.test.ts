import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import type { BrokerAdapter } from '../src/broker/types.js';
import { ManualClock } from '../src/core/clock.js';
import { createTestLogger } from '../src/core/logger.js';
import type { Db } from '../src/db/db.js';
import { MarketCalendar } from '../src/market/MarketCalendar.js';
import { WorkerStatsService } from '../src/workers/WorkerStats.js';
import { createEngineHarness, entryRequest } from './support/harness.js';

/**
 * Per-day figures (trades today, a worker's goal and loss limit) follow the TRADING day. With overnight trading that
 * runs 04:00 to 04:00, so a worker that lost its limit at 23:30 does not get a fresh allowance at midnight in the
 * middle of the night.
 */

const NY = 'America/New_York';
const at = (iso: string) => DateTime.fromISO(iso, { zone: NY }).toMillis();

describe('worker day counters follow the trading day', () => {
  it('under overnight trading a trade opened at 23:30 still counts at 01:00, and not after 04:00', async () => {
    const clock = new ManualClock(at('2026-10-05T23:30:00'));
    const cal = new MarketCalendar({ calendarSource: 'exchange' } as unknown as BrokerAdapter, {} as Db, clock, createTestLogger(), 2000, 'all');
    const h = await createEngineHarness({ tradingDay: cal.tradingDay });
    try {
      h.clock.set(at('2026-10-05T23:30:00'));
      const order = await h.engine.submit({ ...entryRequest(), signalBarCloseAt: h.clock.now() - 5_000 });
      expect(order.state).toBe('ACCEPTED');
      await h.engine.onTradeUpdate(h.broker.fill(order.clientOrderId, 2, 3.68));

      const stats = new WorkerStatsService('alpaca', 'paper', h.db, h.clock, { key: cal.tradingDay, start: cal.tradingDayStart });
      h.clock.set(at('2026-10-06T01:00:00')); // after midnight, still the same night
      await stats.refresh();
      expect(stats.base('qqq-og').tradesToday).toBe(1);
      h.clock.set(at('2026-10-06T04:30:00')); // the next trading day
      await stats.refresh();
      expect(stats.base('qqq-og').tradesToday).toBe(0);

      // Without a trading-day rule the day turns over at midnight, as it always did.
      const plain = new WorkerStatsService('alpaca', 'paper', h.db, h.clock);
      h.clock.set(at('2026-10-06T01:00:00'));
      await plain.refresh();
      expect(plain.base('qqq-og').tradesToday).toBe(0);
    } finally {
      await h.audit.flush();
      await h.db.close();
    }
  });
});
