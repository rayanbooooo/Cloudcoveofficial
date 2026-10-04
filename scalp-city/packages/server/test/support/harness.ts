import { AuditLog } from '../../src/audit/AuditLog.js';
import { ManualClock } from '../../src/core/clock.js';
import { EventBus } from '../../src/core/eventBus.js';
import { createTestLogger } from '../../src/core/logger.js';
import type { Db } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrations.js';
import { OrderEngine, type RiskContextProvider } from '../../src/orders/OrderEngine.js';
import type { OrderRequest } from '../../src/orders/types.js';
import { PositionLedger } from '../../src/positions/PositionLedger.js';
import type { ProposedOrder, RiskState } from '../../src/risk/RiskEngine.js';
import { Alerts, Timeline } from '../../src/system/Timeline.js';
import { WorkerRepository } from '../../src/workers/WorkerRepository.js';
import { MockBroker } from './MockBroker.js';
import { createPgliteDb } from './pglite.js';
import { CONTRACT, NOW, riskState } from './riskFixtures.js';

export interface EngineHarness {
  db: Db;
  clock: ManualClock;
  bus: EventBus;
  broker: MockBroker;
  ledger: PositionLedger;
  audit: AuditLog;
  engine: OrderEngine;
  breakerLog: string[];
  /** Override pieces of the risk state per test. */
  riskOverrides: Partial<RiskState>;
}

export async function createEngineHarness(): Promise<EngineHarness> {
  const db = await createPgliteDb();
  await migrate(db);
  await new WorkerRepository(db).seed();
  const logger = createTestLogger();
  const clock = new ManualClock(NOW);
  const bus = new EventBus(logger);
  const broker = new MockBroker();
  broker.now = () => clock.now();
  const ledger = new PositionLedger('paper', db, clock, logger);
  const audit = new AuditLog(db, logger, clock);
  const timeline = new Timeline('paper', db, bus, clock, logger);
  const alerts = new Alerts(bus, clock);
  const breakerLog: string[] = [];
  const h = { db, clock, bus, broker, ledger, audit, breakerLog, riskOverrides: {} } as EngineHarness;

  const risk: RiskContextProvider = {
    async prefetch() {
      return null;
    },
    build(o: ProposedOrder, _pre: unknown, engine: OrderEngine): RiskState {
      return riskState({
        now: clock.now(),
        openOrders: engine.riskOpenOrders(),
        brokerPositions: broker.positions.map((p) => ({ ...p })),
        ledgerPositions: ledger.all(),
        entriesToday: engine.entriesToday(),
        workerEntriesToday: engine.entriesToday(o.workerId),
        ordersLastMinute: engine.ordersLastMinute(),
        ...h.riskOverrides,
      } as Partial<RiskState>);
    },
  };

  h.engine = new OrderEngine({
    env: 'paper',
    broker,
    db,
    ledger,
    bus,
    audit,
    timeline,
    alerts,
    clock,
    logger,
    risk,
    breakers: { brokerRejected: (r) => breakerLog.push(`reject:${r}`), apiError: (r) => breakerLog.push(`api:${r}`) },
    dailyPnl: () => 0,
    onFills: () => undefined,
    resolutionDelaysMs: [5, 5, 5],
  });
  return h;
}

export function entryRequest(over: Partial<OrderRequest> & { signalBarCloseAt?: number; referencePrice?: number } = {}): OrderRequest & { signalBarCloseAt: number; referencePrice: number } {
  return {
    workerId: 'qqq-og',
    source: 'WORKER',
    purpose: 'ENTRY',
    signalId: `qqq-og:CALL:${Math.random()}`,
    symbol: CONTRACT,
    underlying: 'QQQ',
    assetClass: 'us_option',
    side: 'buy',
    positionIntent: 'buy_to_open',
    type: 'limit',
    timeInForce: 'day',
    qty: 2,
    limitPrice: 3.7,
    stopPrice: null,
    meta: { multiplier: 100, direction: 'CALL' },
    actor: 'worker:qqq-og',
    signalBarCloseAt: NOW - 5000,
    referencePrice: 3.68,
    ...over,
  };
}
