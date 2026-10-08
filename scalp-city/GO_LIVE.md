# Going live with Scalp City

Read this once, end to end, before starting. Everything here is arranged so that the first real
order goes out only after the connection to your broker has been proven with fake money, and with
limits small enough that a bad day is cheap. Nothing here is financial advice, and nothing here
suggests the strategy will make money.

## Choose the broker

Scalp City trades through **one broker per server**. The default is **Alpaca** (Part B): shares of ETF
stand-ins for gold, the Nasdaq, the Dow, GBP/USD and the euro, US stock hours only. **OANDA** (Part A)
trades the real markets nearly around the clock, but read the warning below first.

| You want to trade | Broker | `BROKER=` | "Paper" means |
|---|---|---|---|
| Shares of **GLD** (gold), **QQQ** (Nasdaq), **DIA** (US30), **FXB** (GBPUSD), **FXE** (euro), or options; US market hours only | **Alpaca** (the default in `render.yaml`) | `alpaca` | an Alpaca **Paper** account |
| Gold, Nasdaq 100, GBP/USD, EUR/JPY, US30 (FX, metals, index CFDs), nearly 24 hours on weekdays | OANDA (only where OANDA offers its API) | `oanda` | an OANDA fxTrade **Practice** account |

> **OANDA is not an option for clients in the EU.** OANDA's help pages say its API is not available to OANDA TMS
> clients (the entity EU accounts are moved to), and OANDA has restricted API trading for European clients since
> 2017 (MiFID II). A European OANDA account cannot generate the API token this bot needs. Confirm in your account
> ("Manage API Access" must exist) or with OANDA support before you open or fund an account for this.

Alpaca cannot trade spot gold, FX or index CFDs, so on Alpaca the bot trades ETF stand-ins: shares of
funds that follow those markets. They are real market data and real orders, but not the same
instruments, they only trade while the US market is open, and there is no ETF for EUR/JPY. Orders,
positions, risk limits and circuit breakers are kept per broker, so switching never mixes the two books.

**Part B** is Alpaca, **Part A** is OANDA, and the safety routine at the end applies to both.

---

## Part A — OANDA (gold, Nasdaq, FX, US30; not available to EU clients)

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
  account's own instrument list and leaves out any market that is not offered: its worker shows
  *"not offered to this account"* and never trades, a note appears in the timeline, and the other
  markets are unaffected. If you only get FX pairs, that is your account, not a bug.
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

- **Run the doctor first.** It is a read-only check that uses the same settings as the app and
  tells you, before any order exists, whether the token and account id work, **which of the five
  markets your account is offered** (with their size and margin rules), whether live prices and
  candles come back, whether both streams stay up, and how far the clock is from OANDA's. In
  Render open scalp-city → **Shell** and run `node packages/server/dist/oanda-doctor.js` (from a
  checkout: `npm run oanda:doctor`). It places and changes nothing and never prints the token, so
  its output is safe to copy when asking for help. Fix every ✖ before going on.
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
  inside `OANDA_SESSION` (default `00:00-16:30` New York time, weekdays; see A5). The
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


### A5. When it trades

Workers open positions only inside `OANDA_SESSION`, New York time, weekdays. The default is
`00:00-16:30`, which is 06:00 to 22:30 in Amsterdam. It stops there on purpose: OANDA's daily rollover is
at 17:00 New York (spreads blow up for a few minutes, which can trigger stops) and its weekly close is
Friday 17:00. Every position is closed 10 minutes before the window ends, so nothing is carried through a
rollover or a weekend, and there are no new entries in those last 10 minutes.

- **To trade through the evening too,** set `OANDA_SESSION=00:00-23:59` in Render and redeploy. Expect wider
  spreads around 17:00 New York and thinner markets overnight; the bot refuses a trade when the spread is
  too wide for its stop, but a stop can still trigger on a spread spike. Prefer the default until the Journal
  says otherwise.
- **To trade only some hours,** narrow it, e.g. `02:00-16:30` starts at the London open.
- **US holidays** are traded by default (`OANDA_SKIP_US_HOLIDAYS=false`): FX and gold are open, but US index
  CFDs can be thin. Set it to `true` to skip them.
- **Autotrading** must still be switched on (top bar, then each worker), and the instrument itself must be
  tradeable at that moment: OANDA also pauses some markets for a daily break.

---

## Part B — Alpaca (ETF stand-ins, stocks and options)

### B0. What you need

- **An Alpaca live account, funded,** plus API keys for both **Paper** and **Live** (each
  dashboard → API Keys). Never paste keys into a chat, an email or git; they only go into
  Render's settings.
- **The $25,000 rule.** Under $25k in a margin account, US rules allow 3 day trades per 5
  business days. A scalper makes day trades, so on a small margin account the bot will take at
  most three round trips per five days and then sit out (it enforces the rule; it never breaks it).
  A cash account avoids the rule but can only trade settled cash.
- **Market data:** the free IEX feed is enough for shares. It carries only part of the volume, so
  VWAP and volume readings are IEX-only; the app labels this everywhere.
- **A Render account with a card.**

### B1. Deploy, in PAPER first

1. **Create the Blueprint** (`render.yaml`). It already says `BROKER=alpaca` and the ETF worker set.
2. **Enter the paper keys:** `ALPACA_PAPER_API_KEY` and `ALPACA_PAPER_API_SECRET`. Leave the LIVE
   pair empty for now.
3. **Wait for the first build,** then find `FIRST RUN … setup code: XXXXX-XXXXX` in the logs and
   **Create your account** with it. (The code changes on every restart until the account exists.)

Right after a deploy the server answers with a "starting up" page for a minute or two while the
previous copy finishes. The app says so and reconnects by itself; just wait.

### B2. Prove the connection on paper (required)

- **Health drawer:** everything green: broker, trade stream, market data, clock, reconciliation.
- **Complete one paper round trip.** During market hours, either let a worker trade
  (Autotrading ON, then enable one worker) or do it by hand: Trade drawer → buy 1 GLD share →
  sell it. Check it in Alpaca's **paper** dashboard. The LIVE checklist refuses to pass until a
  paper round trip exists.
- **Strongly recommended:** run paper for a couple of weeks and read the Journal before risking money.

### B3. The fast scalpers (the default set)

`ALPACA_WORKER_SET=scalp` runs five **1-minute scalpers**: **GOLD (GLD)**, **NAS (QQQ)**, **US30 (DIA)**,
**GBPUSD (FXB)** and **EURO (FXE)**, long **and short**.

- **How often.** Each worker looks at every closed 1-minute bar. If price is on the right side of VWAP and a fast
  EMA with real momentum behind it (about a third of an ATR over three bars), it enters, and **every bar that
  qualifies can take its own entry**: expect several trades an hour per worker when a market is moving, none when it
  is flat. A patient strategy takes one trade per setup; this one does not wait.
- **How it leaves.** 1 ATR stop, 1.2 ATR target, a 4-minute time stop, or when price loses VWAP. It is back in the
  market a bar later. Everything is flattened 5 minutes before the close.
- **Size.** Each entry risks at most $5 at its stop (whole shares, capped by your position limits).
- **Open the throttle.** The account-wide limits in the **Risk drawer** decide how fast it can really go. A fresh
  install is deliberately slow (a few trades a day, one position at a time). Use **Fast scalping preset**
  in the Risk drawer, review, confirm: up to 300 trades a day, 5 positions at once, $5,000 per position. Then turn
  on **Autotrading** and **All on** (Workers panel).
- **Go aggressive (paper only).** The limits above are small on purpose: each trade risks $5 and a position is about
  $5,000, so on a $100,000 paper account a whole day moves by dollars. **Risk drawer → Aggressive preset (paper)**
  sizes the share scalpers from the account instead: positions of 30% of equity ($30,000 on $100,000), a stop-out
  risks up to 0.25% ($250), up to 1,000 trades a day, and the account stops taking new entries for the day at a 5%
  loss ($5,000; each worker stands down alone at 1.5%). You can change the two percentages, preview exactly what
  changes (the account limits and each worker's), and confirm; it is audit-logged. It is not available on a live
  account: real money gets its limits set by hand, small. The numbers are fixed dollar amounts from the account's size
  at the moment you confirm. Expect swings of thousands of dollars in BOTH directions, and the same costs per trade
  (spread, slippage) on much bigger size. The daily-loss stop is the brake; limits cannot be switched off.
- **Honest expectations.** More trades is not more profit. Each trade pays the spread and gives up a little to
  slippage, and a quick 1-minute momentum rule has no proven edge: with small targets those costs can eat all of
  it. Paper fills are also optimistic (no queue, no market impact). Use this to collect many trades quickly and read
  the Journal; do not read a good paper day as a plan.
- **Paper only, in practice.** A margin account under $25,000 may make 3 day trades per 5 business days, and a
  scalper makes dozens a day: live, the bot hits that limit and sits out (it enforces the rule). A cash account can
  only trade settled cash. Short selling needs a margin account with shorting enabled.
- **FXB and FXE** trade little and their spreads are wide against a 1-minute move: expect "spread too wide" and
  stale-data blocks there; most of the action will be GLD, QQQ and DIA. On the free IEX feed they often go minutes
  without a quote, so they will mostly sit out. The app says so without calling it a halt: the data chip reads
  `3/5 LIVE`, the status line notes `NO FRESH PRICE: FXB · FXE`, and only their own workers wait while GLD, QQQ and DIA
  trade. Switch those two workers off to make the note go away, or subscribe to SIP (`ALPACA_STOCK_FEED=sip`), where
  consolidated quotes keep them fresh. "Market data stale" becomes a halt for everything only when NO market has a
  fresh price.

### B3a. Every session: pre-market, after-hours, overnight

`ALPACA_SESSIONS` (Render → Environment; the blueprint sets `all`) decides which hours the scalpers trade, New York time:

| Setting | Trades |
|---|---|
| `regular` | 09:30–16:00 |
| `extended` | 04:00–20:00: pre-market, regular and after-hours |
| `all` | also the overnight session: Sunday 20:00 to Friday 20:00 without a break (Monday 02:00 to Saturday 02:00 in Belgium, except for the few weeks a year when the US and Europe change their clocks on different days) |

After changing it, **Manual Deploy**. The switches (Autotrading, each worker) are off again after a deploy; turn them on.

- **Orders at those hours.** Alpaca takes only **limit orders** outside 09:30–16:00. Entries already are. Exits that
  would be market orders (stop loss, end of day, FLATTEN ALL, the kill switch, a manual close) become limit orders
  priced 0.5% through the touch (`ALPACA_OFFHOURS_EXIT_BUFFER_PCT`): they fill at the book's prices like a market
  order, and 0.5% is the most they can be worse than the quote they were priced from. The app never sends an
  opening market order or an options order at those hours; it refuses them and says why.
- **Prices decide whether it can trade at all.** A worker enters only on a price that is fresh *for that hour* (30 s
  old at most outside the regular session). What exists depends on your Alpaca data plan:

  | New York time | Free plan (`ALPACA_STOCK_FEED=iex`) | Paid plan (`ALPACA_STOCK_FEED=sip`) |
  |---|---|---|
  | 04:00–08:00 | no data | SIP |
  | 08:00–17:00 | IEX | SIP |
  | 17:00–20:00 | no data | SIP |
  | 20:00–04:00 | `overnight` feed: quotes real time, **trades 15 minutes late** | `boats` feed, real time |

  **The honest summary for the free plan: `all` adds only the IEX hours around the regular session** (08:00–09:30 and
  16:00–17:00 New York, 14:00–15:30 and 22:00–23:00 in Belgium), with the thin books those hours have. The free
  overnight feed is derived from BOATS and delivers trades 15 minutes late, so the bars and signals built from it are
  old news: the app refuses to enter on it (risk check "Live bars", data chip `QUOTES ONLY`). To trade the early
  morning, the evening and the night you need Alpaca's paid data plan: set `ALPACA_STOCK_FEED=sip` (the overnight feed
  then follows: `boats`). If your plan does not include the feed asked for, the Health drawer says so (the stream is
  refused); the fix is a different `ALPACA_OVERNIGHT_FEED`, or `ALPACA_SESSIONS=extended`.
  The free IEX feed also goes quiet at 17:00, so there are no entries in the last 10 minutes before it ("Data
  hours") and a position is closed 5 minutes before: nothing is left without a price overnight.
- **Thin markets wait.** Outside the regular session a worker needs four 1-minute bars in a row, each with a trade in
  it, before it enters (risk check "Unbroken bars"). A quiet night therefore means few trades, which is the point: a
  move measured over bars with holes in them is not a move.
- **"Today" is the trading day.** Under `all` it runs 04:00 to 04:00 New York time, so trades per day and a worker's daily
  goal and loss limit do not start over at midnight in the middle of the night. The account-level daily-loss limit uses
  Alpaca's own day P&L.
- **No weekend risk.** Everything is flattened 5 minutes before the end of the unbroken run of trading time (20:00 each
  day under `extended`; Friday 20:00, or the evening before a holiday or an early close, under `all`), and there are
  no entries in the last 10 minutes of it.
- **What can go wrong that the day does not show.** Overnight books are thin: spreads are wide (so you will see
  "spread too wide" blocks), prices jump, and a limit order through the touch can fill worse than the quote in a fast
  move. Alpaca may refuse something at night that it accepts by day (short selling, for one); a refusal shows on the
  order, and three in ten minutes trip the REJECTED ORDERS breaker, which you reset in the Risk drawer once you know why.
- **Not yet run against real Alpaca.** It has been exercised against a fake that enforces Alpaca's session rules and
  each feed's hours. Run **paper** through at least one night with the Health drawer open and read what Alpaca
  actually did before this goes anywhere near real money.

### B3b. The patient ETF set, and what protects you

`ALPACA_WORKER_SET=etf` runs the same five markets with the six-condition strategy (a few trades a day, long only).

The five workers: **GOLD (GLD)**, **NAS (QQQ)**, **US30 (DIA)**, **GBPUSD (FXB)**, **EURO (FXE)**. Everything below about stops, size and limits applies to both sets.

- **One signal, mechanical rules.** Six checks (VWAP, EMA50, momentum, opening range, structure,
  volume) must all agree before an entry. Nothing here has been shown to make money; paper trading
  exists to find out.
- **Every entry is sized from the stop.** The stop sits 1.5 ATR away (ATR = the market's own recent
  range) and the number of shares is chosen so that being stopped out costs at most the
  per-trade risk limit ($10 by default), then capped by the position size limit and the share
  limit. Whole shares only. One QQQ share can cost several hundred dollars, so with a $1,000 position
  limit expect 1–3 shares: tiny trades and tiny results.
- **The stop is held by this server, not by Alpaca.** If the server is down (a deploy, a crash),
  open positions have no stop until it is back. Keep positions small, avoid deploying with one
  open, and use the broker's own app if you ever need to close something while the server is off.
- **Exits:** stop (1.5 ATR), target (2 ATR), 45 minutes at most (90 for the currency ETFs), loss of
  VWAP, and everything is flattened 15 minutes before the close. No entries in the last 10 minutes.
- **Long only by default.** Turn shorting on per worker (Workers drawer → Allow shorts) only if your
  account is a margin account with shorting enabled. Short losses are not capped by the share price.
- **Currency ETFs are thin.** FXB and FXE trade little, especially on the free feed: their spreads can
  be wider than a one-minute move and their quotes can be seconds old. The bot refuses to trade on
  stale data or a spread that is too wide for the stop, so these two will often sit out. They use
  5-minute bars. That is the safe behaviour, not a bug.
- **Your stored limits win.** The `MAX_*` values only seed the risk limits the first time the database
  is used; after that the **Risk drawer** is the source of truth. If an entry is blocked with
  "one share costs $… over the $… position limit", raise the position size there (loosening a limit
  asks for confirmation).

### B4. Turn on LIVE, deliberately

Do this outside market hours.

1. **Configure Render.** Set `ALPACA_LIVE_API_KEY` and `ALPACA_LIVE_API_SECRET`,
   `LIVE_TRADING_ENABLED=true` and `TRADING_ENVIRONMENT=live`. Save, then **Manual Deploy**.
2. **Check the setup.** The app now shows the red **LIVE** badge and frame and your live account.
   Risk drawer: confirm small limits that fit your account. The blueprint seeds these on a fresh
   database; lower them for real money:

   | Limit | Starting value |
   |---|---|
   | Daily loss | $100 |
   | Position size | $1,000 |
   | Shares per order | 50 |
   | Open positions | 2 |
   | Trades per day | 6 |
3. **Arm LIVE** (Live drawer: every readiness check green; password; masked account number; two
   confirmations), **start one worker**, then **Autotrading ON**. Watch the first trade end to end
   and compare it with Alpaca's live dashboard.
4. **Scale slowly,** after weeks of real results.

### B5. The original options workers

`ALPACA_WORKER_SET=options` runs the original QQQ, SPY and IWM options workers instead (buying calls
and puts). Live options autotrading needs real-time OPRA quotes (Alpaca's paid data plan): set
`ALPACA_OPTIONS_FEED=opra` once subscribed. The app blocks live options autotrading on the free
feed on purpose, because those prices are not real quotes. Switching sets is a redeploy; the other
set's workers and history stay in the database untouched.

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
| The "Starting up" page never goes away | Another copy is holding the trading lock. If it is a dead copy (no heartbeat for a minute), the new one ends its stale database session and takes over by itself, with a warning in the log. If it is a live copy, you have two services on one database: delete one. |
| The app says "The server is starting up" | Normal for a minute or two after a deploy: the previous copy is finishing. It reconnects by itself. If it lasts more than a few minutes, check Render → Logs, and that only one `scalp-city` service exists. |
| An entry is blocked: "one share costs … over the … position limit" | The position size limit is lower than one share of that ETF. Raise it in the Risk drawer (it asks for confirmation). |
| On first start the app halts with "unexpected position" for QQQ, GLD, DIA, FXB or FXE | Your Alpaca account already holds shares of an ETF the bot trades, and Scalp City has no record of opening them, so it stops to be safe. Review them in the Health drawer, then **Accept broker state**. The bot only ever manages positions it opened: it will not sell your shares, but that worker will not trade that symbol while you hold them. |
| A worker shows a stale-data or "spread too wide" block | The bot will not trade on data older than 5 seconds or a spread too wide for its stop. Normal for FXB and FXE on the free feed. |
| Phase `NOT_CONFIGURED` | Token/keys missing or mistyped for the current environment (Render → Environment). |
| OANDA: `not offered to this account` | Your OANDA account cannot trade that instrument; the worker won't trade it and the other markets are unaffected. The doctor lists exactly which markets your account is offered. |
| OANDA: nothing connects | Run `node packages/server/dist/oanda-doctor.js` in the Render Shell: it names the failing step (token, account id, practice vs live, instruments, prices, streams, clock). |
| OANDA: market shows `CLOSED` | OANDA reports that market as not tradeable right now; entries wait. |
| `NO BROKER-SIDE STOP` | A CFD position has no stop at OANDA (it was removed or canceled there). While Scalp City runs it still exits at its own stop, but if the app goes down nothing protects the position: close it, or add a stop in OANDA's platform. |
| Readiness item red | The checklist says exactly which item; LIVE stays locked until it's fixed. |
| Reconciliation mismatch | The broker and the app disagree. New entries halt. Review in the Risk drawer, then accept the broker's state. |
| Forgot your password | Render → Shell: `node packages/server/dist/create-user.js --username <you> --reset-password` |
| A worker isn't trading | Open its tower: the scanner shows the conditions, the sizing and the last risk check, with the reason it was blocked. |
