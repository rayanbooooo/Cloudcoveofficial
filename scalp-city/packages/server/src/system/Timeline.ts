import type { AlertCode, AlertView, Severity, TimelineEvent, TimelineKind, TradingEnvironment } from '@scalp-city/shared';
import type { Clock } from '../core/clock.js';
import type { EventBus } from '../core/eventBus.js';
import { newId } from '../core/ids.js';
import type { Logger } from '../core/logger.js';
import { iso, ms, type Db } from '../db/db.js';

export interface TimelineInput {
  kind: TimelineKind;
  severity?: Severity;
  workerId?: string | null;
  symbol?: string | null;
  title: string;
  detail?: string | null;
  /** Event time (e.g. broker or exchange timestamp). Defaults to server now. */
  ts?: number;
}

/** Session activity log (spec §45, §85). Every entry carries the real event time. */
export class Timeline {
  private events: TimelineEvent[] = [];
  private readonly max = 500;

  constructor(
    private readonly env: TradingEnvironment,
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async load(sinceMs: number): Promise<void> {
    const { rows } = await this.db.query(
      `SELECT * FROM timeline_events WHERE env = $1 AND ts >= $2 ORDER BY ts DESC LIMIT $3`,
      [this.env, iso(sinceMs), this.max],
    );
    this.events = rows
      .map((r: Record<string, unknown>) => ({
        id: String(r.id),
        ts: ms(r.ts)!,
        kind: r.kind as TimelineKind,
        severity: r.severity as Severity,
        workerId: (r.worker_id as string | null) ?? null,
        symbol: (r.symbol as string | null) ?? null,
        title: String(r.title),
        detail: (r.detail as string | null) ?? null,
      }))
      .reverse();
  }

  add(input: TimelineInput): TimelineEvent {
    const e: TimelineEvent = {
      id: newId('tl'),
      ts: input.ts ?? this.clock.now(),
      kind: input.kind,
      severity: input.severity ?? 'info',
      workerId: input.workerId ?? null,
      symbol: input.symbol ?? null,
      title: input.title,
      detail: input.detail ?? null,
    };
    this.events.push(e);
    if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max);
    this.bus.emit('TIMELINE', e);
    void this.db
      .query(
        `INSERT INTO timeline_events(id, env, ts, kind, severity, worker_id, symbol, title, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [e.id, this.env, iso(e.ts), e.kind, e.severity, e.workerId, e.symbol, e.title, e.detail],
      )
      .catch((err) => this.logger.warn({ err }, 'timeline persist failed'));
    return e;
  }

  list(limit = 200): TimelineEvent[] {
    return this.events.slice(-limit);
  }
}

/** User-facing alerts (spec §119). Repeats of the same alert within a minute are collapsed. */
export class Alerts {
  private alerts: AlertView[] = [];
  private lastByKey = new Map<string, number>();

  constructor(
    private readonly bus: EventBus,
    private readonly clock: Clock,
  ) {}

  raise(code: AlertCode, severity: Severity, title: string, message: string): AlertView | null {
    const now = this.clock.now();
    const key = `${code}|${title}|${message}`;
    const last = this.lastByKey.get(key);
    if (last !== undefined && now - last < 60_000) return null;
    this.lastByKey.set(key, now);
    const a: AlertView = { id: newId('al'), ts: now, code, severity, title, message };
    this.alerts.push(a);
    if (this.alerts.length > 100) this.alerts.shift();
    this.bus.emit('ALERT', a);
    return a;
  }

  list(): AlertView[] {
    return this.alerts.slice(-50);
  }
}
