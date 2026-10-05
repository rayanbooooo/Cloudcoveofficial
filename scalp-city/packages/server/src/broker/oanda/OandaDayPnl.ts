import { DateTime } from 'luxon';
import type { Clock } from '../../core/clock.js';
import type { Logger } from '../../core/logger.js';
import { amt, num, oandaTime, type Raw } from './mappers.js';
import type { OandaHttp } from './OandaHttp.js';

const NY = 'America/New_York';

export const OANDA_DAY_PNL_NOTE =
  'Rebuilt from OANDA transactions since 00:00 New York: realized P&L, financing, fees and open positions. Positions opened before today count only while they are losing — so the daily loss limit can never be masked by an older gain.';

/**
 * OANDA has no "previous close equity", so day P&L is rebuilt from the
 * broker's own records:
 *
 *   realized today (fills, financing, fees — deposits and withdrawals excluded)
 * + unrealized P&L of trades opened today
 * + unrealized P&L of older trades, only while negative
 *
 * Trades are identified as "opened today" by id: OANDA trade ids are the
 * ids of the transactions that opened them, and transaction ids only grow,
 * so everything after the last transaction before 00:00 New York is today's.
 * The rule for older trades is deliberately one-sided: an overnight gain can
 * never make room for today's losses under the daily loss limit.
 *
 * Deterministic from broker data, so a restart can't reset it.
 */
export class OandaDayPnl {
  private day: string | null = null;
  private dayStartMs = 0;
  /** Id of the last transaction before 00:00 New York today. */
  private boundary: number | null = null;
  /** Last transaction id folded into `realized`. */
  private lastId: number | null = null;
  private realized = 0;

  constructor(
    private readonly http: OandaHttp,
    private readonly accountPath: string,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /** Bring the realized total up to `lastTransactionId` (the account's latest). */
  async sync(lastTransactionId: string | number): Promise<void> {
    const now = this.clock.now();
    const day = DateTime.fromMillis(now, { zone: NY }).toISODate()!;
    const last = Number(lastTransactionId);
    if (!Number.isFinite(last)) throw new Error('account has no lastTransactionID');
    if (this.day !== day || this.boundary === null || this.lastId === null) {
      await this.init(day, now, last);
      return;
    }
    if (last > this.lastId) await this.catchUp(last);
  }

  private async init(day: string, now: number, last: number): Promise<void> {
    const start = DateTime.fromISO(day, { zone: NY }).startOf('day').toMillis();
    const res = await this.http.get<Raw>(`${this.accountPath}/transactions`, {
      from: new Date(start).toISOString(),
      to: new Date(now).toISOString(),
      pageSize: 1000,
    });
    const ranges: { from: number; to: number }[] = [];
    for (const page of (res.pages ?? []) as string[]) {
      // Use only the id range from the page link; never follow a URL from a response.
      let u: URL;
      try {
        u = new URL(page);
      } catch {
        continue;
      }
      const from = Number(u.searchParams.get('from'));
      const to = Number(u.searchParams.get('to'));
      if (Number.isInteger(from) && Number.isInteger(to) && to >= from) ranges.push({ from, to });
    }
    const txs: Raw[] = [];
    for (const r of ranges) {
      const page = await this.http.get<Raw>(`${this.accountPath}/transactions/idrange`, { from: r.from, to: r.to });
      txs.push(...((page.transactions ?? []) as Raw[]));
    }
    const listed = Number(res.lastTransactionID);
    const firstToday = ranges.length ? Math.min(...ranges.map((r) => r.from)) : null;
    this.day = day;
    this.dayStartMs = start;
    this.boundary = firstToday !== null ? firstToday - 1 : Number.isFinite(listed) ? listed : last;
    this.realized = 0;
    this.lastId = this.boundary;
    for (const tx of txs.sort((a, b) => Number(a.id) - Number(b.id))) this.apply(tx);
    this.logger.info({ day, transactions: txs.length, boundary: this.boundary }, 'day P&L rebuilt from broker transactions');
    if (last > this.lastId) await this.catchUp(last);
  }

  private async catchUp(last: number): Promise<void> {
    for (let i = 0; i < 50 && this.lastId! < last; i++) {
      const res = await this.http.get<Raw>(`${this.accountPath}/transactions/sinceid`, { id: this.lastId! });
      const txs = ((res.transactions ?? []) as Raw[]).sort((a, b) => Number(a.id) - Number(b.id));
      if (txs.length === 0) break;
      for (const tx of txs) this.apply(tx);
    }
  }

  private openedToday(tradeId: unknown): boolean {
    return this.boundary !== null && Number(tradeId) > this.boundary;
  }

  /** Fold one transaction into today's realized total (idempotent by id). */
  private apply(tx: Raw): void {
    const id = Number(tx.id);
    if (!Number.isFinite(id) || (this.lastId !== null && id <= this.lastId)) return;
    this.lastId = id;
    const t = oandaTime(tx.time);
    if (t !== null && t < this.dayStartMs) return;
    switch (tx.type) {
      case 'ORDER_FILL': {
        const legs: Raw[] = [...((tx.tradesClosed ?? []) as Raw[]), ...(tx.tradeReduced ? [tx.tradeReduced as Raw] : [])];
        for (const leg of legs) {
          const v = amt(leg.realizedPL) + amt(leg.financing) - Math.abs(amt(leg.guaranteedExecutionFee));
          this.realized += this.openedToday(leg.tradeID) ? v : Math.min(0, v);
        }
        this.realized -= Math.abs(amt(tx.commission)) + Math.abs(amt((tx.tradeOpened as Raw | undefined)?.guaranteedExecutionFee));
        return;
      }
      case 'DAILY_FINANCING':
        this.realized += amt(tx.financing);
        return;
      case 'DIVIDEND_ADJUSTMENT':
        this.realized += amt(tx.dividendAdjustment);
        return;
      default:
        return; // deposits/withdrawals (TRANSFER_FUNDS) and non-monetary transactions don't count
    }
  }

  /** Day P&L given the account's open trades (from /openTrades). */
  total(openTrades: Raw[]): number {
    let unrealized = 0;
    for (const t of openTrades) {
      const u = num(t.unrealizedPL) ?? 0;
      unrealized += this.openedToday(t.id) ? u : Math.min(0, u);
    }
    return this.realized + unrealized;
  }

  get ready(): boolean {
    return this.boundary !== null;
  }
}
