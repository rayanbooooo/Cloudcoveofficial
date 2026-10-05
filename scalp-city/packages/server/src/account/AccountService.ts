import { maskAccountNumber, type BrokerStatus, type TradingEnvironment } from '@scalp-city/shared';
import {
  BrokerError,
  type BrokerAccount,
  type BrokerAdapter,
  type BrokerOrder,
  type BrokerPosition,
} from '../broker/types.js';
import type { Clock } from '../core/clock.js';
import type { EventBus } from '../core/eventBus.js';
import type { Logger } from '../core/logger.js';
import type { Db } from '../db/db.js';

export interface AccountServiceOptions {
  env: TradingEnvironment;
  accountPollMs?: number;
  positionsPollMs?: number;
  ordersPollMs?: number;
  /** Broker considered unreachable if no successful call within this window. */
  okWindowMs?: number;
}

/**
 * Broker-authoritative account state (spec §15, §16). Values are exactly
 * what the broker returned; nothing is computed in their place.
 */
export class AccountService {
  account: BrokerAccount | null = null;
  accountAt: number | null = null;
  positions: BrokerPosition[] = [];
  positionsAt: number | null = null;
  openOrders: BrokerOrder[] = [];
  openOrdersAt: number | null = null;

  lastOkAt: number | null = null;
  lastError: BrokerError | null = null;
  lastErrorAt: number | null = null;
  /** Set if the broker starts returning a different account than the one we started with. */
  accountChanged: string | null = null;
  /** Paper/live mismatch the broker adapter can detect from the account itself. */
  environmentWarning: string | null = null;

  private timers: NodeJS.Timeout[] = [];
  private refreshTimer: NodeJS.Timeout | null = null;
  private inflight = new Map<string, Promise<void>>();
  private firstAccountId: string | null = null;

  constructor(
    private readonly broker: BrokerAdapter,
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly opts: AccountServiceOptions,
  ) {}

  start(): void {
    this.timers.push(setInterval(() => void this.refreshAccount().catch(() => undefined), this.opts.accountPollMs ?? 5000));
    this.timers.push(setInterval(() => void this.refreshPositions().catch(() => undefined), this.opts.positionsPollMs ?? 5000));
    this.timers.push(setInterval(() => void this.refreshOpenOrders().catch(() => undefined), this.opts.ordersPollMs ?? 15_000));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  /** Full refresh — used by recovery and after reconnects. Throws if any part fails. */
  async refreshAll(): Promise<void> {
    await this.refreshAccount();
    await Promise.all([this.refreshPositions(), this.refreshOpenOrders()]);
  }

  /** Debounced refresh after fills so balances catch up quickly without spamming the API. */
  requestRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshAll().catch(() => undefined);
    }, 400);
  }

  private once(key: string, fn: () => Promise<void>): Promise<void> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private ok(): void {
    this.lastOkAt = this.clock.now();
    if (this.lastError) {
      this.lastError = null;
      this.bus.emit('BROKER_STATUS', {});
    }
  }

  private fail(err: unknown, what: string): never {
    const e = err instanceof BrokerError ? err : new BrokerError('NETWORK', (err as Error).message);
    const changed = this.lastError?.kind !== e.kind;
    this.lastError = e;
    this.lastErrorAt = this.clock.now();
    this.logger.warn({ what, kind: e.kind, status: e.status, msg: e.message }, 'broker request failed');
    if (changed) this.bus.emit('BROKER_STATUS', {});
    throw e;
  }

  refreshAccount(): Promise<void> {
    return this.once('account', async () => {
      let acct: BrokerAccount;
      try {
        acct = await this.broker.getAccount();
      } catch (err) {
        this.fail(err, 'account');
      }
      this.ok();
      if (this.firstAccountId === null) {
        this.firstAccountId = acct.id;
        this.checkEnvironment(acct);
        await this.recordAccount(acct).catch((err) => this.logger.warn({ err }, 'could not record account'));
      } else if (acct.id !== this.firstAccountId && !this.accountChanged) {
        this.accountChanged = `broker returned account ${maskAccountNumber(acct.accountNumber)}, expected the account this session started with`;
        this.logger.error({ masked: maskAccountNumber(acct.accountNumber) }, 'ACCOUNT CHANGED UNDERNEATH THE SESSION');
      }
      this.account = acct;
      this.accountAt = this.clock.now();
      this.bus.emit('ACCOUNT_UPDATED', {});
    });
  }

  refreshPositions(): Promise<void> {
    return this.once('positions', async () => {
      let rows: BrokerPosition[];
      try {
        rows = await this.broker.getPositions();
      } catch (err) {
        this.fail(err, 'positions');
      }
      this.ok();
      this.positions = rows;
      this.positionsAt = this.clock.now();
      this.bus.emit('POSITION_UPDATED', { symbol: '*' });
    });
  }

  refreshOpenOrders(): Promise<void> {
    return this.once('orders', async () => {
      let rows: BrokerOrder[];
      try {
        rows = await this.broker.getOrders({ status: 'open', limit: 500 });
      } catch (err) {
        this.fail(err, 'orders');
      }
      this.ok();
      this.openOrders = rows;
      this.openOrdersAt = this.clock.now();
    });
  }

  private checkEnvironment(acct: BrokerAccount): void {
    this.environmentWarning = this.broker.environmentWarning?.(acct) ?? null;
    if (this.environmentWarning) this.logger.error(this.environmentWarning);
  }

  private async recordAccount(acct: BrokerAccount): Promise<void> {
    await this.db.query(
      `INSERT INTO accounts(id, env, broker, account_number_masked, last_status) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET last_seen_at = now(), last_status = EXCLUDED.last_status`,
      [acct.id, this.opts.env, this.broker.name, maskAccountNumber(acct.accountNumber) ?? '••••', acct.status],
    );
  }

  /** Why the account cannot trade, or null if it can. */
  restriction(): string | null {
    const a = this.account;
    if (!a) return null;
    if (a.status !== 'ACTIVE') return `account status ${a.status}`;
    if (a.accountBlocked) return 'account blocked by broker';
    if (a.tradingBlocked) return 'trading blocked by broker';
    if (a.tradeSuspendedByUser) return 'trading suspended by user at broker';
    return null;
  }

  /** Broker connectivity as the risk engine sees it (spec §34). Uncertain = not CONNECTED. */
  status(tradeStreamConnected: boolean): { status: BrokerStatus; detail: string | null } {
    const now = this.clock.now();
    const window = this.opts.okWindowMs ?? 20_000;
    if (this.lastError?.kind === 'AUTH') return { status: 'AUTHENTICATION_ERROR', detail: this.lastError.message };
    if (this.lastError?.kind === 'RATE_LIMITED') return { status: 'RATE_LIMITED', detail: this.lastError.message };
    if (this.accountChanged) return { status: 'ACCOUNT_RESTRICTED', detail: this.accountChanged };
    const restricted = this.restriction();
    if (restricted) return { status: 'ACCOUNT_RESTRICTED', detail: restricted };
    if (this.lastOkAt === null) return { status: this.lastError ? 'DISCONNECTED' : 'UNKNOWN', detail: this.lastError?.message ?? null };
    if (now - this.lastOkAt > window) return { status: 'DISCONNECTED', detail: this.lastError?.message ?? 'no successful broker response recently' };
    if (!tradeStreamConnected) return { status: 'DISCONNECTED', detail: 'order update stream not connected — fills cannot be observed' };
    return { status: 'CONNECTED', detail: null };
  }

  /**
   * Account day P&L from broker numbers: equity − last_equity (Alpaca), or
   * the adapter's own figure built from broker transactions (OANDA). Unknown
   * is null — never 0.
   */
  dayPnl(): number | null {
    const a = this.account;
    if (!a) return null;
    if (a.dayPnl !== undefined) return a.dayPnl;
    if (a.equity === null || a.lastEquity === null) return null;
    return a.equity - a.lastEquity;
  }

  brokerPosition(symbol: string): BrokerPosition | null {
    return this.positions.find((p) => p.symbol === symbol) ?? null;
  }
}
