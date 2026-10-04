import type { Db } from '../db/db.js';

/** Typed key/value settings persisted in `system_settings`. */
export class SettingsStore {
  private cache = new Map<string, unknown>();

  constructor(private readonly db: Db) {}

  async get<T>(key: string, fallback: T): Promise<T> {
    if (this.cache.has(key)) return this.cache.get(key) as T;
    const { rows } = await this.db.query<{ value: unknown }>('SELECT value FROM system_settings WHERE key = $1', [key]);
    const raw = rows[0]?.value;
    const value = raw === undefined ? fallback : ((typeof raw === 'string' ? JSON.parse(raw) : raw) as T);
    this.cache.set(key, value);
    return value;
  }

  async set<T>(key: string, value: T, by: string): Promise<void> {
    await this.db.query(
      `INSERT INTO system_settings(key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [key, JSON.stringify(value), by],
    );
    this.cache.set(key, value);
  }
}

export const SETTINGS = {
  riskLimits: 'risk.limits',
  killSwitch: 'control.killSwitch',
  latchedBreakers: 'breakers.latched',
} as const;
