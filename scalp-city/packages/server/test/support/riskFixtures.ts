import type { RiskLimits, WorkerConfigView } from '@scalp-city/shared';
import { DEFAULT_STRATEGY_PARAMS } from '@scalp-city/shared';
import type { BrokerAccount, BrokerPosition } from '../../src/broker/types.js';
import type { ProposedOrder, RiskState } from '../../src/risk/RiskEngine.js';

export const NOW = Date.UTC(2026, 9, 5, 15, 0); // 11:00 New York

export const LIMITS: RiskLimits = {
  maxDailyLoss: 500,
  maxPositionNotional: 5000,
  maxOrderNotional: 5000,
  maxContracts: 20,
  maxShares: 100,
  maxConcurrentPositions: 3,
  maxTradesPerDay: 10,
  maxOrdersPerMinute: 10,
  maxPriceDeviationPct: 5,
  noEntriesBeforeCloseMinutes: 10,
  pdtGuard: true,
};

export function account(over: Partial<BrokerAccount> = {}): BrokerAccount {
  return {
    id: 'acct-1',
    accountNumber: 'PA1234564821',
    status: 'ACTIVE',
    currency: 'USD',
    equity: 50_000,
    lastEquity: 50_000,
    cash: 50_000,
    buyingPower: 100_000,
    regtBuyingPower: 100_000,
    daytradingBuyingPower: 200_000,
    nonMarginableBuyingPower: 50_000,
    optionsBuyingPower: 50_000,
    portfolioValue: 50_000,
    longMarketValue: 0,
    shortMarketValue: 0,
    initialMargin: 0,
    maintenanceMargin: 0,
    multiplier: 2,
    patternDayTrader: false,
    tradingBlocked: false,
    accountBlocked: false,
    tradeSuspendedByUser: false,
    shortingEnabled: true,
    daytradeCount: 0,
    optionsApprovedLevel: 3,
    optionsTradingLevel: 3,
    ...over,
  };
}

export function workerConfig(over: Partial<WorkerConfigView> = {}): WorkerConfigView {
  return {
    id: 'qqq-og',
    name: 'QQQ OG',
    symbol: 'QQQ',
    strategyName: 'OG Scalper',
    timeframe: '1Min',
    instrument: 'OPTIONS',
    allowShort: false,
    entrySlippagePct: 2,
    entryTimeoutSec: 20,
    params: DEFAULT_STRATEGY_PARAMS,
    limits: { maxTradesPerDay: 5, maxContracts: 20, maxShares: 100, maxPositionNotional: 5000, dailyLossLimit: 200, dailyGoal: 500 },
    exits: { takeProfitPct: 25, stopLossPct: 15, exitOnVwapLoss: true, maxHoldMinutes: 30, flattenBeforeCloseMinutes: 15, cooldownBars: 3 },
    options: { minDte: 0, maxDte: 3, strikeOffset: 0, maxSpreadPct: 10, maxSpreadAbs: 0.15, minVolume: 100, minOpenInterest: 100, minBidSize: 1 },
    ...over,
  };
}

export const CONTRACT = 'QQQ261005C00600000';

/** A worker CALL entry: 2 contracts at $3.68. */
export function optionEntry(over: Partial<ProposedOrder> = {}): ProposedOrder {
  return {
    orderId: null,
    purpose: 'ENTRY',
    source: 'WORKER',
    workerId: 'qqq-og',
    signalId: 'qqq-og:CALL:1',
    signalBarCloseAt: NOW - 5_000,
    symbol: CONTRACT,
    underlying: 'QQQ',
    assetClass: 'us_option',
    side: 'buy',
    qty: 2,
    type: 'limit',
    limitPrice: 3.7,
    stopPrice: null,
    multiplier: 100,
    referencePrice: 3.68,
    ...over,
  };
}

export function brokerPosition(over: Partial<BrokerPosition> = {}): BrokerPosition {
  return {
    symbol: 'SPY',
    assetId: null,
    assetClass: 'us_equity',
    side: 'long',
    qty: 10,
    qtyAvailable: 10,
    avgEntryPrice: 500,
    costBasis: 5000,
    marketValue: 5000,
    currentPrice: 500,
    lastdayPrice: 499,
    changeToday: 0.002,
    unrealizedPl: 0,
    unrealizedPlpc: 0,
    unrealizedIntradayPl: 0,
    unrealizedIntradayPlpc: 0,
    ...over,
  };
}

/** A state in which the standard option entry passes every check. */
export function riskState(over: Partial<RiskState> = {}): RiskState {
  return {
    now: NOW,
    env: 'paper',
    limits: LIMITS,
    controls: { autotrading: true, entriesPaused: false, killSwitch: false },
    live: { serverLockOpen: false, armed: false },
    breakers: [],
    broker: { status: 'CONNECTED', detail: null },
    account: account(),
    accountRestriction: null,
    accountDayPnl: 0,
    market: { isOpen: true, minutesToClose: 300, label: 'OPEN' },
    clock: { ok: true, skewMs: 12 },
    freshness: { lastEventAt: NOW - 40, ageMs: 40, stale: false, reason: null },
    optionsPolicy: { allowed: true, reason: null },
    optionMarket: { bid: 3.66, ask: 3.68, ageMs: 200, stale: false, volume: 5000, openInterest: 12000, bidSize: 40, contractTradable: true, contractStatus: 'active' },
    referencePrice: null,
    reconciliation: { ok: true, detail: null },
    brokerPositions: [],
    ledgerPositions: [],
    openOrders: [],
    entriesToday: 0,
    workerEntriesToday: 0,
    ordersLastMinute: 0,
    worker: { config: workerConfig(), autotradeEnabled: true, dayPnl: 0, realizedToday: 0 },
    asset: { tradable: true, shortable: true, easyToBorrow: true },
    signalAlreadyUsed: false,
    allowedUnderlyings: ['QQQ', 'SPY', 'IWM'],
    maxSignalAgeMs: 90_000,
    ...over,
  };
}
