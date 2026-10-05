# Going live with Scalp City

Read this once, end to end, before starting. Everything here is arranged so that the first real
order goes out only after the connection to Alpaca has been proven with fake money, and with
limits small enough that a bad day is cheap. Nothing here is financial advice, and nothing
here suggests the strategy will make money.

## 0. What you need

- **An Alpaca live account, funded.** It needs options approval that allows buying calls and
  puts (if you trade options), plus API keys for both **Paper** and **Live** (each dashboard →
  API Keys). Never paste keys into a chat, an email or git; they only go into Render's settings.
- **The $25,000 rule.** Under $25k in a margin account, US rules allow 3 day trades per 5
  business days. The bot enforces it, so it will sit out rather than break the rule. A cash
  account avoids the rule but can only trade settled cash (options settle the next day).
- **Market data:**
  - **Shares:** the free IEX feed is enough.
  - **Options, live:** autotrading needs real-time OPRA quotes (Alpaca's paid data plan). The app
    blocks live options autotrading on the free feed on purpose: those prices aren't real quotes.
    Either subscribe and set `ALPACA_OPTIONS_FEED=opra`, or switch the worker to shares (Workers
    drawer → Instrument → EQUITY).
- **A Render account with a card.** An always-on web service plus a database; check Render's
  pricing.

## 1. Deploy, in PAPER first

1. **Create the Blueprint.** In Render: **New → Blueprint**. Connect GitHub, pick
   `rayanbooooo/Cloudcoveofficial`, branch `claude/zen-franklin-lzwngb`. Render reads
   `render.yaml` and proposes a web service plus a PostgreSQL database.
2. **Enter the paper keys.** When asked for secrets, fill in `ALPACA_PAPER_API_KEY` and
   `ALPACA_PAPER_API_SECRET`. Leave the LIVE pair empty for now.
3. **Wait for the first build.** It takes a few minutes. Then open the service's **Logs** and find:
   `FIRST RUN … setup code: XXXXX-XXXXX`.
4. **Create your account.** Open the service URL (`https://scalp-city-….onrender.com`) and
   **Create your account** with that code. The code changes on every restart until the account
   exists, so always use the latest one in the logs.

If Render rejects the Blueprint (plan or field names change over time), create the two pieces by
hand:

- **The database:** New → PostgreSQL, a paid plan (free databases expire), region Virginia.
- **The web service:** New → Web Service → this repo, with:
  - Root Directory `scalp-city`, Runtime **Docker**, instance type **Starter** or above.
  - Health check path `/api/healthz`, and **1 instance**.
  - Environment variables as listed in `render.yaml`. `DATABASE_URL` is the database's *Internal*
    URL, and `SESSION_SECRET` is any random string of 32+ characters.

## 2. Prove the connection on paper (required)

- **Health drawer:** everything green: broker, trade stream, market data, clock, reconciliation.
- **Complete one paper round trip.** During market hours, either let a worker trade
  (Autotrading ON, then enable one worker) or do it by hand: Trade drawer → buy 1 SPY share →
  sell it. Check it in Alpaca's **paper** dashboard. The LIVE checklist refuses to pass until a
  paper round trip exists. That's the first real proof that orders, fills and positions flow
  correctly.
- **Strongly recommended:** run paper for a couple of weeks and read the Journal before risking money.

## 3. Turn on LIVE, deliberately

Do this outside market hours.

1. **Configure Render.** In scalp-city → **Environment**, set:
   - `ALPACA_LIVE_API_KEY` and `ALPACA_LIVE_API_SECRET`
   - `LIVE_TRADING_ENABLED=true` (the server-side lock; while false, no live order can be sent)
   - `TRADING_ENVIRONMENT=live`
   - `ALPACA_OPTIONS_FEED=opra`, only if you subscribed to real-time options data

   Save, then **Manual Deploy**.
2. **Check the setup.** The app now shows the red **LIVE** badge and frame and your live account.
   Risk drawer: confirm the small starting limits:

   | Limit | Starting value |
   |---|---|
   | Daily loss | $100 |
   | Position size | $300 |
   | Contracts per order | 1 |
   | Open positions | 1 |
   | Trades per day | 3 |
3. **Arm LIVE.** In the Live drawer, every readiness check must be green. Click **Enable LIVE**,
   re-enter your password, type the masked account number, and confirm twice.
4. **Start one worker.** Enable **one** worker, then turn **Autotrading ON** (confirm). Watch the
   first trade end to end and compare it with Alpaca's live dashboard.
5. **Scale slowly.** Raise limits only after weeks of real results, in small steps.

## 4. Daily routine and safety

- **After any restart the bot stops trading.** Deploys, Render maintenance and crashes all bring
  it back disarmed, with autotrading OFF, until you re-arm. That's on purpose: it never resumes
  live trading on its own. Check it before the open.
- **The kill switch** stops every worker and cancels working orders. Positions stay open: use
  **FLATTEN ALL** to close them.
- **Alpaca is the source of truth.** If the app is unreachable, open Alpaca's own app to close
  positions or cancel orders.
- **Don't deploy during market hours with a position open.** Exits aren't managed while the server
  restarts.
- **Keep one instance.** A second copy waits in standby and never trades, but don't scale out.
- **Daily loss limit:** when hit, new entries stop for the day. Exits still run.

## 5. When something goes wrong

| Symptom | What it means / what to do |
|---|---|
| Phase `NOT_CONFIGURED` | Keys missing or mistyped for the current environment (Render → Environment). |
| Readiness item red | The checklist says exactly which item; LIVE stays locked until it's fixed. |
| Reconciliation mismatch | The broker and the app disagree. New entries halt. Review in the Risk drawer, then accept the broker's state. |
| Forgot your password | Render → Shell: `node packages/server/dist/create-user.js --username <you> --reset-password` |
| A worker isn't trading | Its scanner panel shows the conditions and the last risk check, with the reason it was blocked. |
