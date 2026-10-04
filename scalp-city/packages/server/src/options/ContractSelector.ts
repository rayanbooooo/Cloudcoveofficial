import { DateTime } from 'luxon';
import type { OptionSelectionPrefs, SignalDirection } from '@scalp-city/shared';
import type { BrokerAdapter, BrokerOptionContract } from '../broker/types.js';
import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import type { MarketDataProvider, OptionSnapshot } from '../marketdata/types.js';

export interface ContractCandidate {
  symbol: string;
  underlying: string;
  expiration: string;
  dte: number;
  type: 'call' | 'put';
  strike: number;
  multiplier: number;
  tradable: boolean;
  status: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spread: number | null;
  spreadPct: number | null;
  bidSize: number | null;
  askSize: number | null;
  quoteTime: number | null;
  volume: number | null;
  openInterest: number | null;
  impliedVolatility: number | null;
  delta: number | null;
  /** Empty when the candidate passes every check. */
  failures: string[];
}

export interface ContractSelection {
  ok: boolean;
  contract: ContractCandidate | null;
  /** Every candidate evaluated, in preference order, with its failures. */
  evaluated: ContractCandidate[];
  reason: string;
}

export interface SelectionRequest {
  underlying: string;
  direction: SignalDirection;
  spot: number;
  prefs: OptionSelectionPrefs;
  maxQuoteAgeMs: number;
}

const NY = 'America/New_York';

/**
 * Options contract selection (spec §18–19). Contracts come exclusively from
 * the broker's listing — never constructed — and must pass tradability,
 * two-sided quote, spread, volume, open interest, size and quote-age checks.
 * A strong signal never overrides an illiquid contract.
 */
export class ContractSelector {
  private listingCache = new Map<string, { at: number; contracts: BrokerOptionContract[] }>();
  /** Latest evaluation per contract symbol, used by the risk engine. */
  private lastByContract = new Map<string, ContractCandidate>();

  constructor(
    private readonly broker: BrokerAdapter,
    private readonly data: MarketDataProvider,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  lastEvaluation(symbol: string): ContractCandidate | null {
    return this.lastByContract.get(symbol) ?? null;
  }

  private async listing(req: SelectionRequest, type: 'call' | 'put', from: string, to: string): Promise<BrokerOptionContract[]> {
    const band = Math.max(req.spot * 0.04, 3);
    const lo = Math.floor((req.spot - band) * 100) / 100;
    const hi = Math.ceil((req.spot + band) * 100) / 100;
    const key = `${req.underlying}|${type}|${from}|${to}|${Math.round(req.spot)}`;
    const cached = this.listingCache.get(key);
    if (cached && this.clock.now() - cached.at < 5 * 60_000) return cached.contracts;
    const contracts = await this.broker.getOptionContracts({
      underlying: req.underlying,
      type,
      expirationDateGte: from,
      expirationDateLte: to,
      strikeGte: lo,
      strikeLte: hi,
      limit: 1000,
    });
    this.listingCache.set(key, { at: this.clock.now(), contracts });
    return contracts;
  }

  async select(req: SelectionRequest): Promise<ContractSelection> {
    const type = req.direction === 'CALL' ? 'call' : 'put';
    const today = DateTime.fromMillis(this.clock.now(), { zone: NY }).startOf('day');
    const from = today.plus({ days: req.prefs.minDte }).toISODate()!;
    const to = today.plus({ days: Math.max(req.prefs.maxDte, req.prefs.minDte) }).toISODate()!;

    const listed = (await this.listing(req, type, from, to)).filter(
      (c) => c.underlyingSymbol === req.underlying && c.type === type && Number.isFinite(c.strikePrice),
    );
    if (listed.length === 0) {
      return { ok: false, contract: null, evaluated: [], reason: `no listed ${type}s for ${req.underlying} expiring ${from}…${to}` };
    }

    // Nearest expiration in the window.
    const expiration = [...new Set(listed.map((c) => c.expirationDate))].sort()[0]!;
    const chain = listed.filter((c) => c.expirationDate === expiration).sort((a, b) => a.strikePrice - b.strikePrice);
    let atm = 0;
    for (let i = 1; i < chain.length; i++) {
      if (Math.abs(chain[i]!.strikePrice - req.spot) < Math.abs(chain[atm]!.strikePrice - req.spot)) atm = i;
    }
    // OTM is above spot for calls and below for puts.
    const step = type === 'call' ? 1 : -1;
    const target = Math.min(chain.length - 1, Math.max(0, atm + step * req.prefs.strikeOffset));
    // Preference order: the target strike, then its neighbours by distance
    // (ties broken toward ATM, where liquidity is usually deepest).
    const picks = chain
      .map((_, i) => i)
      .sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || Math.abs(a - atm) - Math.abs(b - atm))
      .slice(0, 5)
      .map((i) => chain[i]!);

    let snaps: OptionSnapshot[] = [];
    try {
      snaps = await this.data.getOptionSnapshots(picks.map((c) => c.symbol));
    } catch (err) {
      return { ok: false, contract: null, evaluated: [], reason: `option quotes unavailable: ${(err as Error).message}` };
    }
    const bySymbol = new Map(snaps.map((s) => [s.symbol, s]));
    const now = this.clock.now();
    const dte = Math.round(DateTime.fromISO(expiration, { zone: NY }).diff(today, 'days').days);

    const evaluated = picks.map((c) => this.evaluate(c, bySymbol.get(c.symbol) ?? null, req, now, dte));
    for (const e of evaluated) this.lastByContract.set(e.symbol, e);
    const chosen = evaluated.find((e) => e.failures.length === 0) ?? null;
    if (!chosen) {
      const first = evaluated[0]!;
      return { ok: false, contract: null, evaluated, reason: `TRADE BLOCKED — ${first.symbol}: ${first.failures.join('; ')}` };
    }
    this.logger.info({ underlying: req.underlying, contract: chosen.symbol, bid: chosen.bid, ask: chosen.ask }, 'option contract selected');
    return { ok: true, contract: chosen, evaluated, reason: `${chosen.symbol} passed liquidity checks` };
  }

  /** Validate one contract against the liquidity rules. */
  evaluate(c: BrokerOptionContract, s: OptionSnapshot | null, req: SelectionRequest, now: number, dte: number): ContractCandidate {
    const p = req.prefs;
    const bid = s?.bid ?? null;
    const ask = s?.ask ?? null;
    const twoSided = bid !== null && ask !== null && bid > 0 && ask > 0 && ask >= bid;
    const mid = twoSided ? (bid! + ask!) / 2 : null;
    const spread = twoSided ? ask! - bid! : null;
    const spreadPct = twoSided && mid! > 0 ? (spread! / mid!) * 100 : null;
    const failures: string[] = [];
    if (!c.tradable) failures.push('contract not tradable');
    if (c.status !== 'active') failures.push(`contract status ${c.status}`);
    if (!twoSided) failures.push('no two-sided quote');
    if (spreadPct !== null && spreadPct > p.maxSpreadPct) failures.push(`spread ${spreadPct.toFixed(1)}% > ${p.maxSpreadPct}%`);
    if (spread !== null && spread > p.maxSpreadAbs) failures.push(`spread $${spread.toFixed(2)} > $${p.maxSpreadAbs.toFixed(2)}`);
    const volume = s?.volume ?? null;
    if (p.minVolume > 0 && (volume === null || volume < p.minVolume)) failures.push(volume === null ? 'volume unavailable' : `volume ${volume} < ${p.minVolume}`);
    if (p.minOpenInterest > 0 && (c.openInterest === null || c.openInterest < p.minOpenInterest)) {
      failures.push(c.openInterest === null ? 'open interest unavailable' : `open interest ${c.openInterest} < ${p.minOpenInterest}`);
    }
    if (p.minBidSize > 0 && (s?.bidSize ?? 0) < p.minBidSize) failures.push(`bid size ${s?.bidSize ?? 0} < ${p.minBidSize}`);
    const age = s?.quoteTime ? now - s.quoteTime : null;
    if (age === null || age > req.maxQuoteAgeMs) failures.push(age === null ? 'quote time unknown' : `quote ${(age / 1000).toFixed(1)}s old`);
    return {
      symbol: c.symbol,
      underlying: c.underlyingSymbol,
      expiration: c.expirationDate,
      dte,
      type: c.type,
      strike: c.strikePrice,
      multiplier: c.size,
      tradable: c.tradable,
      status: c.status,
      bid,
      ask,
      mid,
      spread,
      spreadPct,
      bidSize: s?.bidSize ?? null,
      askSize: s?.askSize ?? null,
      quoteTime: s?.quoteTime ?? null,
      volume,
      openInterest: c.openInterest,
      impliedVolatility: s?.impliedVolatility ?? null,
      delta: s?.greeks?.delta ?? null,
      failures,
    };
  }
}
