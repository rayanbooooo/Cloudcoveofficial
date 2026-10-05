import type { Db } from './db.js';

/**
 * Schema migrations, embedded so the bundled server carries them. Applied
 * in order inside a transaction each; `schema_migrations` records progress.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: /* sql */ `
CREATE TABLE users (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE sessions (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip text,
  user_agent text
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- Broker accounts this installation has connected to.
CREATE TABLE accounts (
  id text PRIMARY KEY,
  env text NOT NULL CHECK (env IN ('paper', 'live')),
  broker text NOT NULL,
  account_number_masked text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_status text
);

CREATE TABLE strategies (
  id text PRIMARY KEY,
  name text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  params jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workers (
  id text PRIMARY KEY,
  name text NOT NULL,
  symbol text NOT NULL,
  strategy_id text NOT NULL REFERENCES strategies(id),
  timeframe text NOT NULL,
  instrument text NOT NULL CHECK (instrument IN ('OPTIONS', 'EQUITY')),
  allow_short boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per setup. The id is deterministic (worker:direction:bar time),
-- so a re-evaluated setup can never be inserted twice.
CREATE TABLE signals (
  id text PRIMARY KEY,
  env text NOT NULL CHECK (env IN ('paper', 'live')),
  worker_id text NOT NULL REFERENCES workers(id),
  symbol text NOT NULL,
  direction text NOT NULL,
  charge integer NOT NULL,
  conditions jsonb NOT NULL,
  phase text NOT NULL,
  bar_time timestamptz NOT NULL,
  ready_at timestamptz,
  order_id text,
  outcome text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signals_worker_idx ON signals(worker_id, created_at DESC);

CREATE TABLE orders (
  id text PRIMARY KEY,
  env text NOT NULL CHECK (env IN ('paper', 'live')),
  client_order_id text NOT NULL UNIQUE,
  broker_order_id text UNIQUE,
  worker_id text REFERENCES workers(id),
  source text NOT NULL,
  purpose text NOT NULL,
  signal_id text,
  trade_id text,
  symbol text NOT NULL,
  underlying text,
  asset_class text NOT NULL,
  side text NOT NULL CHECK (side IN ('buy', 'sell')),
  position_intent text,
  type text NOT NULL,
  time_in_force text NOT NULL,
  qty numeric NOT NULL CHECK (qty > 0),
  limit_price numeric,
  stop_price numeric,
  state text NOT NULL,
  broker_status text,
  filled_qty numeric NOT NULL DEFAULT 0,
  filled_avg_price numeric,
  rejected_by text,
  reject_reason text,
  error_message text,
  risk jsonb,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  submitted_at timestamptz,
  updated_at timestamptz NOT NULL,
  filled_at timestamptz
);
-- The database itself refuses a second entry order for the same signal.
CREATE UNIQUE INDEX orders_entry_signal_uniq ON orders(signal_id) WHERE purpose = 'ENTRY' AND signal_id IS NOT NULL;
CREATE INDEX orders_env_state_idx ON orders(env, state);
CREATE INDEX orders_env_created_idx ON orders(env, created_at DESC);

CREATE TABLE order_events (
  id bigserial PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  event_key text NOT NULL UNIQUE,
  event text NOT NULL,
  from_state text,
  to_state text NOT NULL,
  broker_status text,
  filled_qty numeric,
  fill_qty numeric,
  fill_price numeric,
  payload jsonb,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order_idx ON order_events(order_id, id);

-- Local position ledger: what Scalp City believes it holds, by symbol.
CREATE TABLE positions (
  env text NOT NULL CHECK (env IN ('paper', 'live')),
  symbol text NOT NULL,
  worker_id text REFERENCES workers(id),
  trade_id text,
  asset_class text NOT NULL,
  underlying text,
  direction text,
  qty numeric NOT NULL,
  avg_price numeric NOT NULL,
  multiplier numeric NOT NULL,
  external boolean NOT NULL DEFAULT false,
  opened_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (env, symbol)
);

-- Trade journal: one row per round trip.
CREATE TABLE trades (
  id text PRIMARY KEY,
  env text NOT NULL CHECK (env IN ('paper', 'live')),
  worker_id text REFERENCES workers(id),
  strategy_id text,
  symbol text NOT NULL,
  underlying text,
  asset_class text NOT NULL,
  direction text NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  qty_opened numeric NOT NULL DEFAULT 0,
  qty_closed numeric NOT NULL DEFAULT 0,
  entry_value numeric NOT NULL DEFAULT 0,
  exit_value numeric NOT NULL DEFAULT 0,
  multiplier numeric NOT NULL,
  realized_pnl numeric,
  signal_id text,
  signal_snapshot jsonb,
  risk_snapshot jsonb,
  exit_reason text,
  daily_pnl_before numeric,
  daily_pnl_after numeric,
  trading_day date NOT NULL,
  opened_at timestamptz NOT NULL,
  closed_at timestamptz
);
CREATE INDEX trades_env_day_idx ON trades(env, trading_day);
CREATE INDEX trades_worker_idx ON trades(worker_id, opened_at DESC);

CREATE TABLE trade_events (
  id bigserial PRIMARY KEY,
  trade_id text NOT NULL REFERENCES trades(id),
  kind text NOT NULL,
  order_id text,
  qty numeric,
  price numeric,
  realized_pnl numeric,
  data jsonb,
  occurred_at timestamptz NOT NULL
);
CREATE INDEX trade_events_trade_idx ON trade_events(trade_id, id);

CREATE TABLE risk_events (
  id bigserial PRIMARY KEY,
  env text NOT NULL,
  worker_id text,
  order_id text,
  signal_id text,
  symbol text,
  purpose text,
  approved boolean NOT NULL,
  blocked_by text,
  checks jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX risk_events_env_idx ON risk_events(env, occurred_at DESC);

CREATE TABLE market_sessions (
  date date PRIMARY KEY,
  open_at timestamptz NOT NULL,
  close_at timestamptz NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only audit log. Each row carries the hash of the previous row, so
-- any edit or deletion anywhere in the chain is detectable; triggers refuse
-- UPDATE, DELETE and TRUNCATE outright.
CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  env text,
  worker_id text,
  symbol text,
  order_id text,
  client_order_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash text NOT NULL,
  hash text NOT NULL UNIQUE
);
CREATE INDEX audit_logs_action_idx ON audit_logs(action, occurred_at DESC);

CREATE FUNCTION audit_logs_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();
CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_append_only();

CREATE TABLE system_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

CREATE TABLE timeline_events (
  id text PRIMARY KEY,
  env text NOT NULL,
  ts timestamptz NOT NULL,
  kind text NOT NULL,
  severity text NOT NULL,
  worker_id text,
  symbol text,
  title text NOT NULL,
  detail text
);
CREATE INDEX timeline_events_env_ts_idx ON timeline_events(env, ts DESC);
`,
  },
  {
    version: 2,
    name: 'multiple brokers (venues) and CFD instruments',
    sql: /* sql */ `
-- Every trading record belongs to a venue (broker). Rows written before this
-- migration were all Alpaca. Switching brokers never mixes the two books.
ALTER TABLE workers ADD COLUMN venue text NOT NULL DEFAULT 'alpaca' CHECK (venue IN ('alpaca', 'oanda'));
ALTER TABLE workers DROP CONSTRAINT workers_instrument_check;
ALTER TABLE workers ADD CONSTRAINT workers_instrument_check CHECK (instrument IN ('OPTIONS', 'EQUITY', 'CFD'));

ALTER TABLE orders ADD COLUMN venue text NOT NULL DEFAULT 'alpaca' CHECK (venue IN ('alpaca', 'oanda'));
DROP INDEX orders_env_state_idx;
DROP INDEX orders_env_created_idx;
CREATE INDEX orders_venue_env_state_idx ON orders(venue, env, state);
CREATE INDEX orders_venue_env_created_idx ON orders(venue, env, created_at DESC);

ALTER TABLE positions ADD COLUMN venue text NOT NULL DEFAULT 'alpaca' CHECK (venue IN ('alpaca', 'oanda'));
ALTER TABLE positions DROP CONSTRAINT positions_pkey;
ALTER TABLE positions ADD PRIMARY KEY (venue, env, symbol);

ALTER TABLE trades ADD COLUMN venue text NOT NULL DEFAULT 'alpaca' CHECK (venue IN ('alpaca', 'oanda'));
DROP INDEX trades_env_day_idx;
CREATE INDEX trades_venue_env_day_idx ON trades(venue, env, trading_day);

ALTER TABLE timeline_events ADD COLUMN venue text NOT NULL DEFAULT 'alpaca';
DROP INDEX timeline_events_env_ts_idx;
CREATE INDEX timeline_events_venue_env_ts_idx ON timeline_events(venue, env, ts DESC);

ALTER TABLE risk_events ADD COLUMN venue text NOT NULL DEFAULT 'alpaca';
`,
  },
];

export async function migrate(db: Db, log?: (msg: string) => void): Promise<number> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version integer PRIMARY KEY,
    name text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const { rows } = await db.query<{ version: number }>('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => Number(r.version)));
  let count = 0;
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    log?.(`applying migration ${m.version}: ${m.name}`);
    await db.tx(async (q) => {
      // Statements run one by one so this works on drivers without multi-statement support.
      for (const stmt of splitSql(m.sql)) await q.query(stmt);
      await q.query('INSERT INTO schema_migrations(version, name) VALUES ($1, $2)', [m.version, m.name]);
    });
    count++;
  }
  return count;
}

/** Split a SQL script on top-level semicolons, keeping $$-quoted bodies intact. */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inDollar = false;
  let inLineComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (!inDollar && ch === '-' && next === '-') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '$' && next === '$') {
      inDollar = !inDollar;
      buf += '$$';
      i++;
      continue;
    }
    if (ch === ';' && !inDollar) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}
