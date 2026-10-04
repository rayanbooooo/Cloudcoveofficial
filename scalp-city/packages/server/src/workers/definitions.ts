import { DEFAULT_STRATEGY_PARAMS, type StrategyParams, type WorkerConfigView } from '@scalp-city/shared';

export interface StrategyDefinition {
  id: string;
  name: string;
  params: StrategyParams;
}

/**
 * Strategies are mechanical rule sets over real market data. Nothing here
 * claims an edge: they exist to be observed in PAPER, measured, and only
 * then trusted with money.
 */
export const STRATEGIES: StrategyDefinition[] = [
  {
    id: 'og-scalper',
    name: 'OG Scalper',
    // The original Scalp City setup: VWAP reclaim + EMA50 + momentum + opening range break.
    params: { ...DEFAULT_STRATEGY_PARAMS },
  },
  {
    id: 'momentum-scalper',
    name: 'Momentum Scalper',
    params: {
      ...DEFAULT_STRATEGY_PARAMS,
      vwapMode: 'side',
      momentumThreshold: 0.6,
      weights: { VWAP: 20, EMA50: 15, MOMENTUM: 30, OPENING_RANGE: 10, STRUCTURE: 10, VOLUME: 15 },
      required: ['VWAP', 'MOMENTUM'],
    },
  },
  {
    id: 'trend-rider',
    name: 'Trend Rider',
    params: {
      ...DEFAULT_STRATEGY_PARAMS,
      vwapMode: 'side',
      momentumThreshold: 0.4,
      weights: { VWAP: 20, EMA50: 30, MOMENTUM: 15, OPENING_RANGE: 5, STRUCTURE: 25, VOLUME: 5 },
      required: ['EMA50', 'STRUCTURE'],
    },
  },
];

type WorkerSeed = Omit<WorkerConfigView, 'params' | 'strategyName'> & { strategyId: string; sortOrder: number };

const baseLimits = { maxTradesPerDay: 5, maxContracts: 20, maxShares: 100, maxPositionNotional: 1000, dailyLossLimit: 200, dailyGoal: 500 };
const baseExits = {
  takeProfitPct: 25,
  stopLossPct: 15,
  exitOnVwapLoss: true,
  maxHoldMinutes: 30,
  flattenBeforeCloseMinutes: 15,
  cooldownBars: 3,
};
const baseOptions = {
  minDte: 0,
  maxDte: 3,
  strikeOffset: 0,
  maxSpreadPct: 10,
  maxSpreadAbs: 0.15,
  minVolume: 100,
  minOpenInterest: 100,
  minBidSize: 1,
};

export const WORKERS: WorkerSeed[] = [
  {
    id: 'qqq-og',
    name: 'QQQ OG',
    symbol: 'QQQ',
    strategyId: 'og-scalper',
    timeframe: '1Min',
    instrument: 'OPTIONS',
    allowShort: false,
    entrySlippagePct: 2,
    entryTimeoutSec: 20,
    limits: { ...baseLimits },
    exits: { ...baseExits },
    options: { ...baseOptions },
    sortOrder: 1,
  },
  {
    id: 'qqq',
    name: 'QQQ',
    symbol: 'QQQ',
    strategyId: 'momentum-scalper',
    timeframe: '1Min',
    instrument: 'OPTIONS',
    allowShort: false,
    entrySlippagePct: 2,
    entryTimeoutSec: 20,
    limits: { ...baseLimits },
    exits: { ...baseExits, takeProfitPct: 20, stopLossPct: 12 },
    options: { ...baseOptions, strikeOffset: 1 },
    sortOrder: 2,
  },
  {
    id: 'qqq-trend',
    name: 'QQQ TREND',
    symbol: 'QQQ',
    strategyId: 'trend-rider',
    timeframe: '5Min',
    instrument: 'OPTIONS',
    allowShort: false,
    entrySlippagePct: 2,
    entryTimeoutSec: 30,
    limits: { ...baseLimits, maxTradesPerDay: 3 },
    exits: { ...baseExits, takeProfitPct: 40, stopLossPct: 20, maxHoldMinutes: 90, cooldownBars: 2 },
    options: { ...baseOptions, minDte: 1, maxDte: 7 },
    sortOrder: 3,
  },
  {
    id: 'spy',
    name: 'SPY',
    symbol: 'SPY',
    strategyId: 'og-scalper',
    timeframe: '1Min',
    instrument: 'OPTIONS',
    allowShort: false,
    entrySlippagePct: 2,
    entryTimeoutSec: 20,
    limits: { ...baseLimits },
    exits: { ...baseExits },
    options: { ...baseOptions },
    sortOrder: 4,
  },
  {
    id: 'iwm',
    name: 'IWM',
    symbol: 'IWM',
    strategyId: 'og-scalper',
    timeframe: '1Min',
    instrument: 'OPTIONS',
    allowShort: false,
    entrySlippagePct: 2,
    entryTimeoutSec: 20,
    limits: { ...baseLimits },
    exits: { ...baseExits },
    options: { ...baseOptions, maxSpreadAbs: 0.1 },
    sortOrder: 5,
  },
];
