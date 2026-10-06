import type { DirectionOrNeutral, SignalDirection, SignalPhase, Timeframe } from './domain.js';
import type { Bar } from './marketdata.js';
import {
  atr,
  atrMomentum,
  ema,
  openingRange,
  priceStructure,
  relativeVolume,
  vwapSeries,
  type PriceStructure,
} from './indicators/core.js';

export const CONDITION_IDS = ['VWAP', 'EMA50', 'MOMENTUM', 'OPENING_RANGE', 'STRUCTURE', 'VOLUME'] as const;
export type ConditionId = (typeof CONDITION_IDS)[number];

export interface StrategyParams {
  /** 'cross' requires price to have crossed VWAP within the lookback; 'side' only requires being on the right side. */
  vwapMode: 'cross' | 'side';
  vwapCrossLookback: number;
  emaPeriod: number;
  emaSlopeLookback: number;
  atrPeriod: number;
  momentumLookback: number;
  /** Required move in ATR units over `momentumLookback` bars. */
  momentumThreshold: number;
  openingRangeMinutes: number;
  structureLookback: number;
  rvolLookback: number;
  rvolThreshold: number;
  weights: Record<ConditionId, number>;
  /** Conditions that must hold for READY regardless of total charge. */
  required: ConditionId[];
  formingThreshold: number;
  chargingThreshold: number;
  readyThreshold: number;
  /**
   * Fast scalping: every closed bar that is READY is its own setup, so it can take its own entry. By default a
   * setup is used once and the next one only forms after it fades, which is what keeps a patient strategy rare.
   */
  rearmEachBar?: boolean;
}

export const DEFAULT_STRATEGY_PARAMS: StrategyParams = {
  vwapMode: 'cross',
  vwapCrossLookback: 5,
  emaPeriod: 50,
  emaSlopeLookback: 3,
  atrPeriod: 14,
  momentumLookback: 5,
  momentumThreshold: 0.5,
  openingRangeMinutes: 15,
  structureLookback: 6,
  rvolLookback: 20,
  rvolThreshold: 1.2,
  weights: { VWAP: 20, EMA50: 20, MOMENTUM: 20, OPENING_RANGE: 20, STRUCTURE: 10, VOLUME: 10 },
  required: ['VWAP', 'EMA50'],
  formingThreshold: 30,
  chargingThreshold: 60,
  readyThreshold: 100,
};

/** Session boundaries for the bars being evaluated (from the market calendar). */
export interface SessionWindow {
  /** Regular-session open (ms) of the session the latest bar belongs to. */
  openMs: number;
  closeMs: number;
  /** Identifier of a bar's session, or null if the bar is outside regular hours. */
  sessionKey: (t: number) => string | null;
}

/** Everything the signal conditions need, computed from real bars only. */
export interface IndicatorSnapshot {
  symbol: string;
  timeframe: Timeframe;
  /** Start time of the bar the snapshot describes. */
  barTime: number;
  /** Whether that bar is closed (decisions) or still forming (display only). */
  barFinal: boolean;
  barsAvailable: number;
  close: number;
  vwap: number | null;
  ema: number | null;
  emaPrev: number | null;
  atr: number | null;
  momentum: number | null;
  orHigh: number | null;
  orLow: number | null;
  orComplete: boolean;
  structure: PriceStructure | null;
  rvol: number | null;
  /** Bars since price was last on the other side of VWAP (for CALL: below), null if not within lookback. */
  barsSinceCrossUp: number | null;
  barsSinceCrossDown: number | null;
}

/**
 * Build an indicator snapshot from bars sorted ascending. Bars must already
 * be restricted to regular session hours; the last bar is the one described.
 */
export function computeIndicatorSnapshot(
  bars: readonly Bar[],
  params: StrategyParams,
  session: SessionWindow,
  asOfMs: number,
): IndicatorSnapshot | null {
  if (bars.length === 0) return null;
  const last = bars[bars.length - 1]!;
  const closes = bars.map((b) => b.c);
  const emaSeries = ema(closes, params.emaPeriod);
  const atrSeries = atr(bars, params.atrPeriod);
  const mom = atrMomentum(closes, atrSeries, params.momentumLookback);
  const vw = vwapSeries(bars, session.sessionKey);
  const sessionBars = bars.filter((b) => b.t >= session.openMs && b.t < session.closeMs);
  const or = openingRange(sessionBars, session.openMs, params.openingRangeMinutes, asOfMs);
  const n = bars.length - 1;

  const crossInfo = (dir: 'up' | 'down'): number | null => {
    // Look back over the window for the most recent bar on the opposite side of VWAP.
    for (let k = 1; k <= params.vwapCrossLookback && n - k >= 0; k++) {
      const i = n - k;
      const v = vw[i];
      if (v === null || v === undefined) break; // left the session — no cross inside it
      const c = closes[i]!;
      if (dir === 'up' ? c < v : c > v) return k;
    }
    return null;
  };

  return {
    symbol: last.symbol,
    timeframe: last.timeframe,
    barTime: last.t,
    barFinal: last.final,
    barsAvailable: bars.length,
    close: last.c,
    vwap: vw[n] ?? null,
    ema: emaSeries[n] ?? null,
    emaPrev: n - params.emaSlopeLookback >= 0 ? (emaSeries[n - params.emaSlopeLookback] ?? null) : null,
    atr: atrSeries[n] ?? null,
    momentum: mom[n] ?? null,
    orHigh: or?.high ?? null,
    orLow: or?.low ?? null,
    orComplete: or?.complete ?? false,
    structure: priceStructure(bars, params.structureLookback),
    rvol: relativeVolume(bars, params.rvolLookback),
    barsSinceCrossUp: crossInfo('up'),
    barsSinceCrossDown: crossInfo('down'),
  };
}

export interface ConditionResult {
  id: ConditionId;
  label: string;
  met: boolean;
  /** Human-readable evidence built from the actual numbers. */
  detail: string;
  weight: number;
  /** True when inputs were insufficient to evaluate (counts as not met). */
  unavailable: boolean;
}

const fmt = (v: number | null, d = 2) => (v === null ? 'n/a' : v.toFixed(d));

function cond(
  id: ConditionId,
  label: string,
  weights: Record<ConditionId, number>,
  met: boolean,
  detail: string,
  unavailable = false,
): ConditionResult {
  return { id, label, met: met && !unavailable, detail, weight: weights[id], unavailable };
}

/** Evaluate every condition for one direction. */
export function evaluateDirection(
  s: IndicatorSnapshot,
  p: StrategyParams,
  dir: SignalDirection,
): ConditionResult[] {
  const up = dir === 'CALL';
  const w = p.weights;
  const out: ConditionResult[] = [];

  // VWAP
  if (s.vwap === null) {
    out.push(cond('VWAP', p.vwapMode === 'cross' ? 'VWAP CROSS' : 'VWAP SIDE', w, false, 'VWAP unavailable', true));
  } else {
    const onSide = up ? s.close > s.vwap : s.close < s.vwap;
    if (p.vwapMode === 'cross') {
      const since = up ? s.barsSinceCrossUp : s.barsSinceCrossDown;
      const met = onSide && since !== null;
      out.push(
        cond(
          'VWAP',
          'VWAP CROSS',
          w,
          met,
          `close ${fmt(s.close)} ${up ? '>' : '<'} VWAP ${fmt(s.vwap)}` +
            (onSide ? (since !== null ? `, crossed ${since} bar${since === 1 ? '' : 's'} ago` : ', no recent cross') : ''),
        ),
      );
    } else {
      out.push(cond('VWAP', 'VWAP SIDE', w, onSide, `close ${fmt(s.close)} vs VWAP ${fmt(s.vwap)}`));
    }
  }

  // EMA50 — side and slope
  if (s.ema === null || s.emaPrev === null) {
    out.push(cond('EMA50', `EMA${p.emaPeriod}`, w, false, `EMA${p.emaPeriod} warming up (${s.barsAvailable} bars)`, true));
  } else {
    const side = up ? s.close > s.ema : s.close < s.ema;
    const slope = up ? s.ema >= s.emaPrev : s.ema <= s.emaPrev;
    out.push(
      cond(
        'EMA50',
        `EMA${p.emaPeriod}`,
        w,
        side && slope,
        `close ${fmt(s.close)} vs EMA ${fmt(s.ema)}, slope ${s.ema - s.emaPrev >= 0 ? '+' : ''}${fmt(s.ema - s.emaPrev, 3)}`,
      ),
    );
  }

  // Momentum in ATR units
  if (s.momentum === null) {
    out.push(cond('MOMENTUM', 'MOMENTUM', w, false, 'momentum unavailable (ATR warming up)', true));
  } else {
    const met = up ? s.momentum >= p.momentumThreshold : s.momentum <= -p.momentumThreshold;
    out.push(
      cond('MOMENTUM', 'MOMENTUM', w, met, `${fmt(s.momentum)} ATR over ${p.momentumLookback} bars (need ${up ? '≥' : '≤'} ${up ? '' : '-'}${p.momentumThreshold})`),
    );
  }

  // Opening range breakout
  if (s.orHigh === null || s.orLow === null) {
    out.push(cond('OPENING_RANGE', 'OPENING RANGE', w, false, 'opening range not formed', true));
  } else if (!s.orComplete) {
    out.push(cond('OPENING_RANGE', 'OPENING RANGE', w, false, `range forming ${fmt(s.orLow)}–${fmt(s.orHigh)}`));
  } else {
    const met = up ? s.close > s.orHigh : s.close < s.orLow;
    out.push(
      cond(
        'OPENING_RANGE',
        'OPENING RANGE',
        w,
        met,
        up ? `close ${fmt(s.close)} vs OR high ${fmt(s.orHigh)}` : `close ${fmt(s.close)} vs OR low ${fmt(s.orLow)}`,
      ),
    );
  }

  // Price structure
  if (s.structure === null) {
    out.push(cond('STRUCTURE', 'STRUCTURE', w, false, 'not enough bars', true));
  } else {
    const met = up ? s.structure === 'BULLISH' : s.structure === 'BEARISH';
    out.push(cond('STRUCTURE', 'STRUCTURE', w, met, s.structure.toLowerCase()));
  }

  // Relative volume (direction-agnostic participation filter)
  if (s.rvol === null) {
    out.push(cond('VOLUME', 'VOLUME', w, false, 'volume baseline unavailable', true));
  } else {
    out.push(cond('VOLUME', 'VOLUME', w, s.rvol >= p.rvolThreshold, `RVOL ${fmt(s.rvol)} (need ≥ ${p.rvolThreshold})`));
  }

  return out;
}

/** Weighted share of conditions met, 0–100 (integer). Never forced. */
export function computeCharge(results: readonly ConditionResult[]): number {
  const total = results.reduce((a, r) => a + r.weight, 0);
  if (total <= 0) return 0;
  const met = results.reduce((a, r) => a + (r.met ? r.weight : 0), 0);
  return Math.round((met / total) * 100);
}

export interface SignalEvaluation {
  direction: DirectionOrNeutral;
  charge: number;
  callCharge: number;
  putCharge: number;
  /** Conditions for the active direction (CALL when neutral). */
  conditions: ConditionResult[];
  requiredMet: boolean;
  barTime: number;
  barFinal: boolean;
}

export function evaluateSignal(s: IndicatorSnapshot, p: StrategyParams): SignalEvaluation {
  const call = evaluateDirection(s, p, 'CALL');
  const put = evaluateDirection(s, p, 'PUT');
  const callCharge = computeCharge(call);
  const putCharge = computeCharge(put);
  let direction: DirectionOrNeutral = 'NEUTRAL';
  if (callCharge > putCharge) direction = 'CALL';
  else if (putCharge > callCharge) direction = 'PUT';
  const conditions = direction === 'PUT' ? put : call;
  const charge = direction === 'NEUTRAL' ? Math.max(callCharge, putCharge) : direction === 'CALL' ? callCharge : putCharge;
  const requiredMet = direction !== 'NEUTRAL' && p.required.every((id) => conditions.find((c) => c.id === id)?.met === true);
  return { direction, charge, callCharge, putCharge, conditions, requiredMet, barTime: s.barTime, barFinal: s.barFinal };
}

/** Confirmed (closed-bar) setup state carried between evaluations. */
export interface SignalState {
  /** Deterministic id of the active setup: `${workerId}:${direction}:${formingBarTime}`. */
  setupId: string | null;
  direction: DirectionOrNeutral;
  phase: SignalPhase;
  charge: number;
  callCharge: number;
  putCharge: number;
  conditions: ConditionResult[];
  requiredMet: boolean;
  /** Bar time at which the active setup started forming. */
  formingSince: number | null;
  /** Bar time at which the setup first reached READY. */
  readySince: number | null;
  barTime: number | null;
  /** Set on the evaluation where a setup faded, for the event log. */
  fadedSetupId: string | null;
}

export const INITIAL_SIGNAL_STATE: SignalState = {
  setupId: null,
  direction: 'NEUTRAL',
  phase: 'IDLE',
  charge: 0,
  callCharge: 0,
  putCharge: 0,
  conditions: [],
  requiredMet: false,
  formingSince: null,
  readySince: null,
  barTime: null,
  fadedSetupId: null,
};

function rawPhase(e: SignalEvaluation, p: StrategyParams): SignalPhase {
  if (e.direction === 'NEUTRAL' || e.charge < p.formingThreshold) return 'IDLE';
  if (e.charge >= p.readyThreshold && e.requiredMet) return 'READY';
  if (e.charge >= p.chargingThreshold) return 'CHARGING';
  return 'FORMING';
}

/**
 * Advance the setup lifecycle with a closed-bar evaluation. Pure: same
 * inputs always yield the same state (and the same setup id), which is what
 * makes signal ids safe to use as idempotency keys across restarts.
 */
export function advanceSignal(
  prev: SignalState,
  e: SignalEvaluation,
  p: StrategyParams,
  workerId: string,
): SignalState {
  const phase = rawPhase(e, p);
  const wasStrong = prev.phase === 'CHARGING' || prev.phase === 'READY';
  const hadSetup = prev.setupId !== null;
  const sameDirection = hadSetup && prev.direction === e.direction;
  const base = {
    direction: e.direction,
    charge: e.charge,
    callCharge: e.callCharge,
    putCharge: e.putCharge,
    conditions: e.conditions,
    requiredMet: e.requiredMet,
    barTime: e.barTime,
  };

  // The previous setup survives while the direction holds and it has not
  // dropped from CHARGING/READY back to FORMING (or to nothing).
  const survives = hadSetup && sameDirection && phase !== 'IDLE' && !(wasStrong && phase === 'FORMING');
  const fadedSetupId = hadSetup && !survives && wasStrong ? prev.setupId : null;

  if (survives) {
    // A re-arming strategy treats each READY bar as a fresh opportunity: the id carries the bar time.
    const rearm = p.rearmEachBar === true && phase === 'READY';
    return {
      ...base,
      setupId: rearm ? `${workerId}:${e.direction}:${e.barTime}` : prev.setupId,
      phase,
      formingSince: prev.formingSince,
      readySince: phase === 'READY' ? (prev.readySince ?? e.barTime) : null,
      fadedSetupId: null,
    };
  }

  // A strong setup lost its conditions: report the fade for this bar.
  if (fadedSetupId !== null && (phase === 'IDLE' || sameDirection)) {
    return { ...base, setupId: null, phase: 'FADED', formingSince: null, readySince: null, fadedSetupId };
  }

  if (phase === 'IDLE') {
    return { ...base, setupId: null, phase: 'IDLE', formingSince: null, readySince: null, fadedSetupId: null };
  }

  // A new setup: fresh, or the opposite direction took over (fade reported alongside).
  return {
    ...base,
    setupId: `${workerId}:${e.direction}:${e.barTime}`,
    phase,
    formingSince: e.barTime,
    readySince: phase === 'READY' ? e.barTime : null,
    fadedSetupId,
  };
}
