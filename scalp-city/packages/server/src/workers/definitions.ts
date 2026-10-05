import { DEFAULT_STRATEGY_PARAMS, type StrategyParams, type Venue, type WorkerConfigView } from '@scalp-city/shared';

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

export type WorkerSeed = Omit<WorkerConfigView, 'params' | 'strategyName'> & { strategyId: string; sortOrder: number; venue: Venue };

const baseLimits = { maxTradesPerDay: 5, maxContracts: 20, maxShares: 100, maxPositionNotional: 1000, dailyLossLimit: 200, dailyGoal: 500, riskPerTrade: 10 };
const baseExits = {
  takeProfitPct: 25,
  stopLossPct: 15,
  stopAtr: 1.5,
  targetAtr: 2,
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

/** Alpaca worker sets: ETF stand-ins for the markets people ask for (default), or the original options workers. */
export type AlpacaWorkerSet = 'etf' | 'options';

const OPTIONS_WORKERS: WorkerSeed[] = [
  {
    venue: 'alpaca',
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
    venue: 'alpaca',
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
    venue: 'alpaca',
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
    venue: 'alpaca',
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
    venue: 'alpaca',
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

/**
 * ETF stand-ins (BROKER=alpaca, ALPACA_WORKER_SET=etf): the closest things Alpaca can trade to gold,
 * the Nasdaq, GBP/USD, EUR/JPY and the Dow. They trade SHARES of the fund, not the spot market, and
 * only during US stock hours. There is no ETF that tracks EUR/JPY, so FXE (euro vs dollar) stands in.
 *
 * Each trade is sized so that a stop-out costs at most `riskPerTrade`, with the stop set from the
 * market's own range (ATR). The stop is held by this server, not by the broker. Long only until you
 * turn shorting on per worker. The two currency ETFs trade thinly, so they use 5-minute bars.
 */
function etfWorkers(): WorkerSeed[] {
  const limits = { ...baseLimits, maxTradesPerDay: 3, maxShares: 50, maxPositionNotional: 1000, dailyLossLimit: 30, dailyGoal: 50, riskPerTrade: 10 };
  const exits = { ...baseExits, stopAtr: 1.5, targetAtr: 2, maxHoldMinutes: 45, flattenBeforeCloseMinutes: 15, cooldownBars: 3 };
  const seed = (id: string, name: string, symbol: string, timeframe: '1Min' | '5Min', sortOrder: number): WorkerSeed => ({
    venue: 'alpaca',
    id,
    name,
    symbol,
    strategyId: 'og-scalper',
    timeframe,
    instrument: 'EQUITY',
    allowShort: false,
    // Worst fill accepted vs the live price; also capped at a quarter of the stop distance.
    entrySlippagePct: 0.05,
    entryTimeoutSec: 20,
    limits: { ...limits },
    exits: timeframe === '5Min' ? { ...exits, maxHoldMinutes: 90, cooldownBars: 2 } : { ...exits },
    options: { ...baseOptions },
    sortOrder,
  });
  return [
    seed('etf-gold', 'GOLD (GLD)', 'GLD', '1Min', 1),
    seed('etf-nasdaq', 'NASDAQ (QQQ)', 'QQQ', '1Min', 2),
    seed('etf-us30', 'US30 (DIA)', 'DIA', '1Min', 3),
    seed('etf-gbp', 'GBPUSD (FXB)', 'FXB', '5Min', 4),
    seed('etf-eur', 'EURO (FXE)', 'FXE', '5Min', 5),
  ];
}

const ETF_WORKERS = etfWorkers();

export const WORKERS: WorkerSeed[] = [...OPTIONS_WORKERS, ...ETF_WORKERS, ...oandaWorkers()];

/** The workers a deployment runs. Others stay in the database (with their history) but are not loaded. */
export function activeWorkerIds(venue: Venue, set: AlpacaWorkerSet): string[] {
  return WORKERS.filter((w) => w.venue === venue && (venue !== 'alpaca' || (set === 'etf' ? ETF_WORKERS : OPTIONS_WORKERS).some((x) => x.id === w.id))).map((w) => w.id);
}

/**
 * OANDA (BROKER=oanda): gold, Nasdaq 100, GBP/USD, EUR/JPY and the Dow.
 * Each trades the instrument itself, long or short, with an ATR stop that
 * is also placed at the broker, sized so a stop-out costs at most
 * `riskPerTrade`. Defaults are deliberately small; prove them in practice.
 */
function oandaWorkers(): WorkerSeed[] {
  // maxPositionNotional is generous here on purpose: the global risk limits (Risk drawer)
  // are the binding notional cap, so there is one number to tune.
  const limits = { ...baseLimits, maxTradesPerDay: 4, maxPositionNotional: 100_000, dailyLossLimit: 50, dailyGoal: 100, riskPerTrade: 10 };
  const exits = { ...baseExits, stopAtr: 1.5, targetAtr: 2, maxHoldMinutes: 30, flattenBeforeCloseMinutes: 10, cooldownBars: 3 };
  const seed = (id: string, name: string, symbol: string, strategyId: string, sortOrder: number): WorkerSeed => ({
    venue: 'oanda',
    id,
    name,
    symbol,
    strategyId,
    timeframe: '1Min',
    instrument: 'CFD',
    allowShort: true,
    // Worst fill accepted vs the live price; also capped at a quarter of the stop distance.
    entrySlippagePct: 0.05,
    entryTimeoutSec: 20,
    limits: { ...limits },
    exits: { ...exits },
    options: { ...baseOptions },
    sortOrder,
  });
  return [
    seed('oanda-gold', 'GOLD', 'XAU_USD', 'og-scalper', 1),
    seed('oanda-nas100', 'NAS100', 'NAS100_USD', 'og-scalper', 2),
    seed('oanda-gbpusd', 'GBP/USD', 'GBP_USD', 'og-scalper', 3),
    seed('oanda-eurjpy', 'EUR/JPY', 'EUR_JPY', 'og-scalper', 4),
    seed('oanda-us30', 'US30', 'US30_USD', 'og-scalper', 5),
  ];
}

/** Defaults for fields added after a worker was first stored (older rows lack them). */
export function workerDefaults(id: string): Pick<WorkerConfigView, 'limits' | 'exits' | 'options'> {
  const seed = WORKERS.find((w) => w.id === id);
  return { limits: { ...(seed?.limits ?? baseLimits) }, exits: { ...(seed?.exits ?? baseExits) }, options: { ...(seed?.options ?? baseOptions) } };
}
