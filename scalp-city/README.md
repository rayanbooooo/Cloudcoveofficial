# Scalp City

A self-hosted, single-user trading command center for **Alpaca** (Trading API, personal account). Five
autonomous scalping workers watch QQQ, SPY and IWM, build a "charge" from six technical conditions, and,
only if every risk check passes, trade options (or shares) through Alpaca. A 3D city visualizes what
the workers are doing. Every number on screen comes from the broker or the market data feed.

> **Real money is at risk in LIVE mode.** Scalp City defaults to PAPER. Nothing here is financial advice,
> and nothing here claims the strategy is profitable. Read [Honest limitations](#honest-limitations)
> before trusting it with anything.

```
packages/
  shared/   TypeScript types, indicators, signal engine, OCC parser (used by server and UI)
  server/   Fastify API + WebSocket, Alpaca adapters, risk engine, order engine, workers, audit log
  web/      React + Vite + Tailwind UI, Zustand store, lightweight-charts, React Three Fiber city
```

## Try it in two minutes (no broker, no database)

```bash
npm install
npm run demo          # builds the UI, starts http://127.0.0.1:8787
# sign in: demo / scalp-city-demo
DEMO_AUTOTRADE=1 npm run demo   # same, with autotrading switched on so you can watch workers trade
```

`npm run demo` starts the **dev harness** (`packages/server/test/harness/devServer.ts`). It runs the real
server and UI against `FakeAlpaca`, the protocol-level fake broker the end-to-end tests use, with a
synthetic random-walk market, an in-memory PostgreSQL (PGlite) and a virtual clock pinned to a regular
session. It never contacts Alpaca, and the UI shows a `NON-STANDARD BROKER ENDPOINT` warning the
whole time. The prices are synthetic and say nothing about real markets.

To show the demo at a public URL (for example a Vercel Sandbox), start it with `HOST=0.0.0.0`,
`PUBLIC_URL` and `ALLOWED_ORIGINS` set to that URL, `COOKIE_SECURE=true` and a strong
`DEMO_PASSWORD`. Vercel's regular serverless hosting can't run this server: it needs a long-running
process for its WebSocket, broker streams and timers. For real (paper or live) use, host it on an
always-on Node host with PostgreSQL.

## Run against Alpaca PAPER

Requirements: Node 22+, PostgreSQL 16 (Docker is easiest), Alpaca **paper** API keys.

```bash
cp .env.example .env     # fill ALPACA_API_KEY / ALPACA_API_SECRET (paper), SESSION_SECRET, DATABASE_URL
npm run db:up            # postgres:16 in Docker (scalp/scalp/scalp_city on localhost:5432)
npm run migrate
npm run user:create -- --username you      # prompts for a password (or SCALP_PASSWORD=…)
npm run dev              # server :8787 + UI :5173 (Vite proxies /api and /ws)
# production-style: npm run build && npm start   → UI served by the server on :8787
```

Set `ALPACA_STOCK_FEED` / `ALPACA_OPTIONS_FEED` to what your data plan actually includes. The UI labels
the feeds from these values (`LIVE · IEX ONLY`, `LIVE · SIP`, `DELAYED 15 MIN`).

First paper session checklist:

1. Health drawer is all green: broker, trade stream, market data, clock skew, reconciliation.
2. Autotrading is **off** after every restart. Turn on one worker, then autotrading.
3. Watch a worker go WATCHING → FORMING → CHARGING → READY, then follow the risk check, order, fill,
   exit, and the journal entry. Confirm each against the Alpaca dashboard.
4. Try the kill switch and FLATTEN ALL on paper so you know exactly what they do.

## Going LIVE (only after paper is stable)

LIVE needs four independent gates. Any one of them missing means no live order:

| Gate | Where | Notes |
|---|---|---|
| `TRADING_ENVIRONMENT=live` | server `.env` | Live keys. The live URL is pinned to `https://api.alpaca.markets`; anything else refuses to start. |
| `LIVE_TRADING_ENABLED=true` | server `.env` | Server-side lock. While false, every live order is refused, whatever the UI does. |
| Arming | in-app | Re-enter your password, type the masked account number, two confirmations, and the readiness checklist must pass. That includes a verified **paper round trip**. Arming is never persisted: a restart disarms. |
| Autotrading | in-app | Off after every restart. In LIVE, turning it on requires an explicit confirmation. |

LIVE is unmistakable: a striped red `LIVE` badge, a red frame around the whole app, and a red emblem
on the vault. The app never switches between PAPER and LIVE silently. A switch requires your
password and a confirmation, and it is refused while orders are working. The new environment starts
disarmed, with autotrading off.

## Safety model (what actually stops bad orders)

**Orders and risk**
- **One path to the broker.** Every order, including manual tickets, flatten and exits, goes through
  `OrderEngine.submit()`, which runs `evaluateRisk()` first. There is no `forceOrder()`.
- **Risk engine (pure function), checked on every order:**
  - Account and controls: kill switch, autotrading and worker state, broker and account status.
  - Market: market hours, clock skew, time to close, data freshness (stale data = no entries).
  - Signal: age and reuse (one order per setup, also enforced by a DB unique index).
  - Order: price sanity (fat-finger guard), order rate.
  - Options: permissions, data feed, contract liquidity and quote freshness.
  - Size: notional, contracts, shares, buying power, open positions, trades per day.
  - Account rules: daily loss, PDT.
  - Workers: duplicate orders and position conflicts, per-worker trade, loss and goal limits.
  - Exits: may only reduce a position.
- **Idempotent orders.**
  - Each order gets a `clientOrderId` and is written to the database as `SUBMITTING` *before* the
    broker call.
  - An ambiguous result (timeout, network error, 5xx, 429) is resolved by looking the order up by
    client order id. It is **never blindly resubmitted**.
  - Fills are de-duplicated by event key and applied in the same transaction as the position ledger.
    Filled quantity can only grow.

**Account and data**
- **Reconciliation.** Broker positions and orders are compared with the ledger on start-up and
  periodically.
  - A mismatch trips a breaker and stops autonomous trading until you review it. Accepting the
    broker's state is itself audited.
  - Holdings the app didn't open are adopted as *external*, and workers never touch them.
- **Circuit breakers:** API errors, rejected orders, account mismatch, unexpected position, daily loss
  (exits still allowed), clock problem, account changed. Each trips automatically and is reset by a
  person.
- **Market data:**
  - WebSocket streams with reconnect and backoff, heartbeats, resubscribe, de-duplication and
    gap backfill.
  - Freshness is tracked per symbol. Stale data blocks entries and is labelled stale in the UI.

**Controls and the record**
- **Kill switch** (one click) stops all workers and cancels working orders. Positions stay open: use
  **FLATTEN ALL** (confirmed) to close them.
- **Audit log** is append-only and hash-chained. Database triggers block UPDATE, DELETE and TRUNCATE,
  and `/api/audit/verify` re-checks the chain.

**Access and secrets**
- **Secrets stay on the server.** The browser talks only to this server, never to Alpaca. Logs redact
  keys, tokens and passwords. `.env` is git-ignored.
- **Auth:**
  - scrypt passwords and HTTP-only `SameSite=Strict` session cookies (HMAC-hashed at rest).
  - CSRF header on every mutation, WebSocket Origin check.
  - Rate limits: login 10 per 15 minutes, orders 30 per minute.

## How a worker decides

1. **Indicators** come from real 1-minute bars (5-minute for the trend worker): session VWAP, EMA50 with
   slope, ATR momentum, opening range, price structure, relative volume.
2. **Charge.** Each condition met in one direction adds its weight: VWAP 20, EMA50 20, momentum 20,
   opening range 20, structure 10, volume 10. VWAP and EMA50 are required. The phases are FORMING
   (≥30), CHARGING (≥60) and READY (100).
3. **Only the confirmed evaluation trades.** It runs on the last closed bar. A preview of the forming
   bar is shown faintly in the UI and is labelled *preview never trades*.
4. **READY does not mean trade.**
   - Before submitting, the worker dry-runs the risk engine so a transient block doesn't burn the
     setup.
   - It then picks a contract within the worker's expiration and strike preferences that passes the
     liquidity checks: two-sided quote, spread, volume, open interest, size and quote age.
   - It submits a marketable limit order capped by a slippage limit.
5. **Exits:**
   - Take profit or time stop: limit at the bid, repriced to market after 10 seconds.
   - Stop loss and end of day: market.
   - VWAP lost: the position is closed when price crosses back through VWAP.
   - Per-worker daily goal: the worker stands down once it reaches it.

## The city

Each tower is a worker and every visual maps to real state:

- **Color.** Hue is the direction: green CALL, red PUT, blue no setup, amber order pending, grey stood
  down. Brightness is the confirmed charge.
- **Edge strips** fill up with the charge. A faint ghost shows the forming-bar preview.
- **Dial** above the robot: segmented charge with ticks at the 30/60/100 thresholds.
- **Sky beam** only for an engaged worker (ready, ordering, or holding). A READY setup that already
  produced an order is marked *SIGNAL USED* and gets no beam.
- **Robots** watch, analyze, type while trading, celebrate profits, and slump when halted.
- **The vault** shows broker-reported equity and day P&L. Its emblem is blue for PAPER and red for LIVE.
- **Traffic** moves only while the market is open and the stock feed is connected.
- **Event effects** (pulses, fill labels, P&L) fire only from server events emitted after the broker
  confirms. Events older than 8 seconds are not replayed.

If WebGL is unavailable, the city is replaced by a notice. All trading state and controls live in the
panels anyway.

## Tests

```bash
npm test         # 129 tests (31 shared + 98 server), ~30 s, no network, no database server needed
npm run typecheck
```

| Suite | What it proves |
|---|---|
| `shared/indicators`, `shared/signal` | VWAP, EMA, ATR, opening range, aggregation; charge, phases, setup survival and fading. |
| `risk` | Every risk check, including exit-only allowances under breakers and kill switch, and failing closed when P&L is unknown. |
| `workerStats` | A worker's day P&L is reported as unknown, never as $0, when an open position has no mark. |
| `orders` | The state machine, idempotency, ambiguous-submit resolution, fill de-duplication and the ledger. |
| `marketdata` | Stream protocol (msgpack), reconnect and resubscribe, staleness, bar lifecycle, mute detection. |
| `safety` | Kill switch, flatten, breakers, live gate, restart behaviour. |
| `reconciliation` | Mismatch detection, external holdings, accepting broker state. |
| `config-auth` | Paper default, live lock, endpoint pinning, auth, CSRF, WebSocket origin, log redaction. |
| `db` | Migrations and the audit log's immutability triggers. |
| `e2e.paper` | Boots the real app against `FakeAlpaca` under a virtual clock and runs the full flow end to end. |

The `e2e.paper` flow:

1. Login and startup reconciliation.
2. Live data, then a signal that goes FORMING → CHARGING → READY.
3. Risk approval and the option order.
4. Broker fill, position, and the city event.
5. Take-profit exit and realized P&L in the vault, leaderboard, journal and audit log.
6. Readiness reports the paper round trip as verified.

Automated tests never use live credentials.

## Honest limitations

- **Not yet exercised against the real Alpaca servers.** This build environment had no network access
  to Alpaca.
  - The adapters follow Alpaca's documented protocols: REST endpoints; JSON-over-binary trade
    stream; msgpack data streams with `connected → auth → subscribe`; error codes 402, 406 and 409.
  - They are tested against a protocol-level fake.
  - Your first real run must be PAPER, with the health drawer open.
- **IEX feed (free plan) covers only part of the volume.** VWAP and relative volume are IEX-only and
  labelled as such. SIP needs a paid data plan.
- **The indicative options feed is not the NBBO.** Automated options trading is blocked on it unless
  you opt in for paper only (`PAPER_ALLOW_INDICATIVE_OPTIONS`). Live always needs OPRA.
- **P&L is gross.** Regulatory and exchange fees on options are not deducted.
- **No backtester, no performance claims.** The strategy is a transparent rules engine, not an edge.
  Expect losing days. Daily loss limits exist for a reason.
- **Pattern-day-trader rule.** Under $25k equity, the PDT check will block round trips after 3 day
  trades in 5 days.
- **Single user, single process.** Not designed for multiple users or multiple server instances on one
  account.
