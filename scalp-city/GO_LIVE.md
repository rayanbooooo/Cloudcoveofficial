# Going live with Scalp City

Read this once, end to end, before starting. Everything here is arranged so that the first real
order goes out only after the connection to your broker has been proven with fake money, and with
limits small enough that a bad day is cheap. Nothing here is financial advice, and nothing here
suggests the strategy will make money.

## Choose the broker

Scalp City trades through **one broker per server**. Pick by what you want to trade:

| You want to trade | Broker | `BROKER=` | "Paper" means |
|---|---|---|---|
| Gold, Nasdaq 100, GBP/USD, EUR/JPY, US30 (FX, metals, index CFDs) | **OANDA** | `oanda` | an OANDA fxTrade **Practice** account |
| US stocks and options (QQQ, SPY, IWM …) | **Alpaca** | `alpaca` | an Alpaca **Paper** account |

Alpaca cannot trade FX, metals or index CFDs, which is why OANDA exists here. Orders, positions,
risk limits and circuit breakers are kept per broker, so switching later never mixes the two books.

**Part A** is OANDA, **Part B** is Alpaca, and the safety routine at the end applies to both.

---

## Part A — OANDA (gold, Nasdaq, FX, US30)

### A0. What you need

- **An OANDA account** (start with a free **fxTrade Practice** account, which uses fake money)
  and, for real money later, a funded live **fxTrade** account.
- **A personal API token and the account id** for each (in your OANDA account, **Manage API
  Access**; the account id looks like `101-004-1234567-001`). Names in OANDA's site change from
  time to time; the token is the "personal access token" for the v20 REST API. **Never paste a
  token into a chat, an email or git**: it goes only into Render's settings, and treat it like a
  password.
- **Which instruments your account may trade.** CFDs on indices and metals are not offered to
  every OANDA account (it depends on the OANDA entity and your region). The app reads the
  account's own instrument list: any worker whose market is not offered shows *"not offered to
  this account"* and never trades. If you only get FX pairs, that is your account, not a bug.
- **A Render account with a card** (an always-on web service plus a database; check Render's pricing).

### A1. Deploy, in PRACTICE first

1. **Create the Blueprint** (skip if you already deployed Scalp City): in Render **New →
   Blueprint**, connect GitHub, pick `rayanbooooo/Cloudcoveofficial`, branch
   `claude/zen-franklin-lzwngb`. Render reads `render.yaml` and proposes a web service plus a
   PostgreSQL database.
2. **Set the OANDA variables** in Render → scalp-city → **Environment**:
   - `BROKER=oanda`
   - `OANDA_PRACTICE_TOKEN` = your practice token
   - `OANDA_PRACTICE_ACCOUNT_ID` = your practice account id
   - `TRADING_ENVIRONMENT=paper`, `LIVE_TRADING_ENABLED=false`

   Leave the `OANDA_LIVE_*` pair empty for now. The Alpaca keys can stay as they are: they are not
   used while `BROKER=oanda`.
3. **Deploy outside market hours** (Manual Deploy: a deploy restarts the trader).
4. **Create your account.** On a brand-new service, open the logs for
   `FIRST RUN … setup code: XXXXX-XXXXX`, then open the service URL and **Create your account**
   with that code. (If you already have an account, sign in.)

Until the OANDA token and account id are present, the app stays in `NOT CONFIGURED` and places
nothing.

If Render rejects the Blueprint (plan or field names change over time), create the two pieces by
hand:

- **The database:** New → PostgreSQL, a paid plan (free databases expire), region Virginia.
- **The web service:** New → Web Service → this repo, with Root Directory `scalp-city`, Runtime
  **Docker**, instance type **Starter** or above, health check path `/api/healthz`, **1 instance**,
  and the environment variables from `render.yaml` (`DATABASE_URL` is the database's *Internal*
  URL; `SESSION_SECRET` is any random string of 32+ characters).

### A2. Prove the connection on PRACTICE (required)

- The top bar shows **PRACTICE**, `BROKER CONNECTED` with your masked account, and `DATA LIVE`.
- **Health drawer:** all green: broker, the *OANDA transaction stream*, the *OANDA price stream*,
  clock, reconciliation. The Market panel shows the five markets with live prices.
- **Complete one practice round trip.** Switch Autotrading ON and enable **one** worker, or place
  a small order by hand (Trade drawer → pick the market → size → the ticket shows the stop the
  broker will hold). Check the position and the fill in OANDA's own practice platform. The LIVE
  checklist refuses to pass until a practice round trip exists.
- Click a **tower** to open its desk: the little robot at its monitors shows the real 1-minute
  bars, the worker's signal and the broker-confirmed position.
- **Strongly recommended:** run practice for a couple of weeks and read the Journal before risking money.

### A3. Turn on LIVE, deliberately

Do this outside market hours.

1. **Configure Render.** Set `OANDA_LIVE_TOKEN` and `OANDA_LIVE_ACCOUNT_ID` (from the funded live
   account), `LIVE_TRADING_ENABLED=true` (the server-side lock; while false, no live order can be
   sent) and `TRADING_ENVIRONMENT=live`. Save, then **Manual Deploy**.
2. **Check the setup.** The app now shows the red **LIVE** badge and frame and your live account.
   Risk drawer: confirm the small starting limits. They come from the `OANDA_MAX_*` variables, are
   in your account currency, and are **separate from Alpaca's `MAX_*`**:

   | Limit | Starting value |
   |---|---|
   | Daily loss | 100 |
   | Max loss per trade (at the stop) | 20 |
   | Position value per market | 10,000 |
   | Open positions | 3 |
   | Trades per day | 10 |
3. **Arm LIVE.** In the Live drawer, every readiness check must be green. Click **Enable LIVE**,
   re-enter your password, type the masked account number, and confirm twice.
4. **Start one worker.** Enable **one** worker, then turn **Autotrading ON** (confirm). Watch the
   first trade end to end and compare it with OANDA's live platform.
5. **Scale slowly.** Raise limits only after weeks of real results, in small steps.

### A4. How OANDA trading works here, and what protects you

- **Long and short.** CFD workers go long on a bullish setup and short on a bearish one (the UI
  says LONG / SHORT, not CALL / PUT). A worker can be switched to long-only in the Workers drawer.
- **Size is risk-based.** Units = (what the worker may lose at its stop) ÷ (stop distance), rounded
  down to the broker's unit step, then capped by the position-value limit, margin and the
  per-trade risk cap. The stop is 1.5 × ATR and the target 2 × ATR by default. The sizing line in
  the scanner shows what the next entry would be, and why when it can't be sized.
- **Every entry carries a stop held by OANDA.** If this app, Render or your connection goes down,
  the stop is still at the broker. The bot adopts that stop as a protective order and shows it
  (*Stop (held by OANDA)*). While the app runs it also exits at the same stop itself. A position
  that has no broker stop is flagged **NO BROKER-SIDE STOP**.
  A stop reduces risk; it does not remove it: in a gap or a halted market a stop can fill at a
  worse price.
- **No double orders.** Entries are fill-or-kill market orders with a worst-acceptable price; exits
  can only reduce a position (they can never open a reverse one). An order whose result is unclear
  (timeout, dropped connection) is looked up at OANDA by its client id and is never resubmitted blindly.
- **Fills come from OANDA's transaction stream**, with a replay of anything missed after a
  reconnect. A position or a fill is never assumed; P&L is OANDA's own figure per fill, in account currency.
- **Trading window.** OANDA markets trade nearly 24 hours, so workers open new positions only
  inside `OANDA_SESSION` (default `09:30-16:00` New York time, weekdays, skipping US holidays). The
  top bar shows it as **Session**. Workers flatten 10 minutes before the window ends. OANDA's own
  per-market *tradeable* flag has the last word: a closed or halted market shows **CLOSED** and
  entries are refused.
- **Prices are mid prices.** OANDA is an over-the-counter market: charts show the midpoint of bid
  and ask, and *volume* is the number of price updates (tick volume), not traded size. VWAP and
  relative volume are computed from that, and the UI says so.
- **Margin.** The account view shows margin used and available. OANDA closes positions at 100%
  margin closeout; the app warns from 50%.
- **Day P&L** has no "last equity" at OANDA: it is rebuilt from OANDA's transactions since
  midnight New York (realized fills + financing − fees; deposits excluded) and fails closed (no new
  entries) if it can't be established.
- **After any restart** the bot stops trading and comes back disarmed with autotrading OFF. Open
  positions keep their broker-held stops while it is down.

---

## Part B — Alpaca (US stocks and options)

### B0. What you need

- **An Alpaca live account, funded.** It needs options approval that allows buying calls and puts
  (if you trade options), plus API keys for both **Paper** and **Live** (each dashboard → API
  Keys). Never paste keys into a chat, an email or git; they only go into Render's settings.
- **The $25,000 rule.** Under $25k in a margin account, US rules allow 3 day trades per 5
  business days. The bot enforces it, so it will sit out rather than break the rule. A cash
  account avoids the rule but can only trade settled cash (options settle the next day).
- **Market data:**
  - **Shares:** the free IEX feed is enough.
  - **Options, live:** autotrading needs real-time OPRA quotes (Alpaca's paid data plan). The app
    blocks live options autotrading on the free feed on purpose: those prices aren't real quotes.
    Either subscribe and set `ALPACA_OPTIONS_FEED=opra`, or switch the worker to shares (Workers
    drawer → Instrument → EQUITY).
- **A Render account with a card.**

### B1. Deploy, in PAPER first

1. **Create the Blueprint** as in A1, but set `BROKER=alpaca`.
2. **Enter the paper keys:** `ALPACA_PAPER_API_KEY` and `ALPACA_PAPER_API_SECRET`. Leave the LIVE
   pair empty for now.
3. **Wait for the first build,** then find `FIRST RUN … setup code: XXXXX-XXXXX` in the logs and
   **Create your account** with it. (The code changes on every restart until the account exists.)

### B2. Prove the connection on paper (required)

- **Health drawer:** everything green: broker, trade stream, market data, clock, reconciliation.
- **Complete one paper round trip.** During market hours, either let a worker trade
  (Autotrading ON, then enable one worker) or do it by hand: Trade drawer → buy 1 SPY share →
  sell it. Check it in Alpaca's **paper** dashboard. The LIVE checklist refuses to pass until a
  paper round trip exists.
- **Strongly recommended:** run paper for a couple of weeks and read the Journal before risking money.

### B3. Turn on LIVE, deliberately

Do this outside market hours.

1. **Configure Render.** Set `ALPACA_LIVE_API_KEY` and `ALPACA_LIVE_API_SECRET`,
   `LIVE_TRADING_ENABLED=true`, `TRADING_ENVIRONMENT=live`, and `ALPACA_OPTIONS_FEED=opra` only if
   you subscribed to real-time options data. Save, then **Manual Deploy**.
2. **Check the setup.** The app now shows the red **LIVE** badge and frame and your live account.
   Risk drawer: confirm the small starting limits (from `MAX_*`):

   | Limit | Starting value |
   |---|---|
   | Daily loss | $100 |
   | Position size | $300 |
   | Contracts per order | 1 |
   | Open positions | 1 |
   | Trades per day | 3 |
3. **Arm LIVE** (Live drawer: every readiness check green; password; masked account number; two
   confirmations), **start one worker**, then **Autotrading ON**. Watch the first trade end to end
   and compare it with Alpaca's live dashboard.
4. **Scale slowly,** after weeks of real results.

---

## Daily routine and safety (both brokers)

- **After any restart the bot stops trading.** Deploys, Render maintenance and crashes all bring
  it back disarmed, with autotrading OFF, until you re-arm. That's on purpose: it never resumes
  live trading on its own. Check it before the open.
- **The kill switch** stops every worker and cancels working orders. Positions stay open: use
  **FLATTEN ALL** to close them.
- **The broker is the source of truth.** If the app is unreachable, use the broker's own app or
  site to close positions or cancel orders.
- **Don't deploy during market hours with a position open.** Exits aren't managed while the server
  restarts. (OANDA positions keep their broker-held stop meanwhile; options and shares have none.)
- **Keep one instance.** A second copy waits in standby and never trades, but don't scale out.
- **Daily loss limit:** when hit, new entries stop for the day. Exits still run.
- **Switching broker** (`BROKER=alpaca` ↔ `oanda`) is a deliberate redeploy. Each broker's orders,
  positions, journal and limits are kept separately.

## When something goes wrong

| Symptom | What it means / what to do |
|---|---|
| Phase `NOT_CONFIGURED` | Token/keys missing or mistyped for the current environment (Render → Environment). |
| OANDA: `not offered to this account` | Your OANDA account cannot trade that instrument; the worker won't trade it. |
| OANDA: market shows `CLOSED` | OANDA reports that market as not tradeable right now; entries wait. |
| `NO BROKER-SIDE STOP` | A CFD position has no stop at OANDA (it was removed or canceled there). While Scalp City runs it still exits at its own stop, but if the app goes down nothing protects the position: close it, or add a stop in OANDA's platform. |
| Readiness item red | The checklist says exactly which item; LIVE stays locked until it's fixed. |
| Reconciliation mismatch | The broker and the app disagree. New entries halt. Review in the Risk drawer, then accept the broker's state. |
| Forgot your password | Render → Shell: `node packages/server/dist/create-user.js --username <you> --reset-password` |
| A worker isn't trading | Open its tower: the scanner shows the conditions, the sizing and the last risk check, with the reason it was blocked. |
