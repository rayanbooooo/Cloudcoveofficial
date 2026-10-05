import type { BrokerAccount, BrokerAdapter, BrokerInstrument } from '../broker/types.js';
import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';

/**
 * Size and margin rules for CFD instruments, straight from the broker
 * (OANDA's account instrument list): unit precision, minimum size, quote
 * decimals and margin rate. Orders are sized and validated against these;
 * nothing is assumed. Empty for brokers without instrument metadata.
 */
export class InstrumentCatalog {
  private bySymbol = new Map<string, BrokerInstrument>();
  loadedAt: number | null = null;
  lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly broker: BrokerAdapter,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  get supported(): boolean {
    return typeof this.broker.getInstruments === 'function';
  }

  get loaded(): boolean {
    return this.loadedAt !== null;
  }

  async start(): Promise<void> {
    if (!this.supported) return;
    await this.refresh().catch(() => undefined);
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), 30 * 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  refresh(): Promise<void> {
    if (!this.broker.getInstruments) return Promise.resolve();
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const list = await this.broker.getInstruments!();
        this.bySymbol = new Map(list.map((i) => [i.symbol, i]));
        this.loadedAt = this.clock.now();
        this.lastError = null;
      } catch (err) {
        this.lastError = (err as Error).message;
        this.logger.warn({ err: this.lastError }, 'instrument list refresh failed');
        throw err;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Make sure the list is loaded (used before sizing or validating a CFD order). */
  async ensure(): Promise<void> {
    if (!this.supported || this.loaded) return;
    await this.refresh();
  }

  get(symbol: string): BrokerInstrument | null {
    return this.bySymbol.get(symbol) ?? null;
  }

  /** Account-currency value of a 1.0 price move on one unit (null = unknown). */
  homeFactor(symbol: string): number | null {
    const f = this.broker.homeFactor?.(symbol) ?? null;
    return f !== null && Number.isFinite(f) && f > 0 ? f : null;
  }

  /**
   * Margin rate the broker will apply: the instrument's own rate, or the
   * account's lower-leverage setting when that is stricter.
   */
  marginRate(symbol: string, account: BrokerAccount | null): number | null {
    const i = this.get(symbol);
    if (!i) return null;
    return Math.max(i.marginRate, account?.marginRate ?? 0);
  }
}

/** Round `units` DOWN to the instrument's unit step (never sizes up). */
export function floorUnits(units: number, precision: number): number {
  const f = 10 ** precision;
  return Math.floor(units * f + 1e-9) / f;
}

/** Round a price to the instrument's quote decimals in the given direction. */
export function roundPrice(price: number, decimals: number, direction: 'up' | 'down' | 'nearest'): number {
  const f = 10 ** decimals;
  const steps = price * f;
  const r = direction === 'up' ? Math.ceil(steps - 1e-7) : direction === 'down' ? Math.floor(steps + 1e-7) : Math.round(steps);
  return Number((r / f).toFixed(decimals));
}
