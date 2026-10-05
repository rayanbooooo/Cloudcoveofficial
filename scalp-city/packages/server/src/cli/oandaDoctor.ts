/**
 * OANDA doctor: a READ-ONLY connectivity and capability check.
 *
 *   npm run oanda:doctor -w @scalp-city/server     (from a checkout, with a .env)
 *   node packages/server/dist/oanda-doctor.js      (Render → Shell)
 *
 * It uses the same client and settings as the trading app (BROKER=oanda, the
 * token and account id for TRADING_ENVIRONMENT) and tells you, before any
 * order exists: whether the token and account id work, which of the configured
 * markets your account is offered and with what rules, whether live prices and
 * candles come back, whether both streams stay up, and how far the server clock
 * is from OANDA's. It places, changes and cancels nothing, and never prints the
 * token. Its output contains no secrets, so it is safe to share when asking for help.
 */
import { OandaHttp } from '../broker/oanda/OandaHttp.js';
import { OandaStream } from '../broker/oanda/OandaStream.js';
import { mapInstrument, num, oandaTime, priceTradeable, type Raw } from '../broker/oanda/mappers.js';
import { ConfigError, loadEnvFile, oandaStreamUrl, parseConfig, tradingBaseUrl } from '../config/env.js';
import { createLogger } from '../core/logger.js';

type Mark = '✔' | '✖' | '⚠' | '•';
let failures = 0;
let warnings = 0;

function say(mark: Mark, text: string): void {
  if (mark === '✖') failures++;
  if (mark === '⚠') warnings++;
  console.log(`${mark} ${text}`);
}

function section(title: string): void {
  console.log(`\n── ${title}`);
}

const fixed = (v: number | null, d = 2): string => (v === null ? 'n/a' : v.toFixed(d));

async function main(): Promise<void> {
  loadEnvFile();
  // The doctor never touches the database or sessions; placeholders only satisfy the shared config parser.
  process.env.DATABASE_URL ||= 'postgres://doctor:doctor@localhost:5432/doctor';
  process.env.SESSION_SECRET ||= 'oanda-doctor-placeholder-secret-not-used-0123456789';
  const config = parseConfig(process.env);

  section('Settings');
  if (config.venue !== 'oanda') {
    say('✖', `BROKER is "${config.venue}". Set BROKER=oanda to check OANDA.`);
    return;
  }
  const env = config.tradingEnvironment;
  const creds = config.oanda.credentials[env];
  say('•', `environment: ${env === 'live' ? 'LIVE (real money)' : 'PRACTICE (fxTrade Practice)'}`);
  if (!creds) {
    say('✖', env === 'live' ? 'OANDA_LIVE_TOKEN / OANDA_LIVE_ACCOUNT_ID are not set.' : 'OANDA_PRACTICE_TOKEN / OANDA_PRACTICE_ACCOUNT_ID are not set.');
    return;
  }
  const api = tradingBaseUrl(config, env);
  const streamBase = oandaStreamUrl(config, env);
  const acct = `/v3/accounts/${encodeURIComponent(creds.accountId)}`;
  const masked = creds.accountId.replace(/^(\d{3}-\d{3}-)(\d+)(-\d{3})$/, (_m, a: string, b: string, c: string) => `${a}${'•'.repeat(Math.max(0, b.length - 4))}${b.slice(-4)}${c}`);
  say('✔', `token and account id are set (account ${masked}), REST host ${new URL(api).host}, stream host ${new URL(streamBase).host}`);
  say('•', `markets configured: ${config.symbols.join(', ')}`);

  const logger = createLogger('silent', false);
  const http = new OandaHttp({ baseUrl: api, token: creds.token, logger });

  // ── Account ───────────────────────────────────────────────────────────────
  section('Account');
  let currency: string | null = null;
  try {
    const t0 = Date.now();
    const r = await http.getWithDate<{ account?: Raw }>(`${acct}/summary`);
    const a = r.body.account ?? {};
    currency = typeof a.currency === 'string' ? a.currency : null;
    say('✔', `the token is accepted and the account exists (${Date.now() - t0} ms)`);
    say('•', `currency ${currency ?? 'n/a'} · NAV ${fixed(num(a.NAV))} · balance ${fixed(num(a.balance))} · margin available ${fixed(num(a.marginAvailable))} · margin used ${fixed(num(a.marginUsed))}`);
    say('•', `open trades ${num(a.openTradeCount) ?? 'n/a'} · open positions ${num(a.openPositionCount) ?? 'n/a'} · pending orders ${num(a.pendingOrderCount) ?? 'n/a'}${a.hedgingEnabled === undefined ? '' : ` · hedging ${a.hedgingEnabled ? 'on' : 'off'}`}`);
    if (!currency) say('⚠', 'the account summary has no currency field; money values cannot be labelled');
    if (r.date !== null) {
      const skew = Date.now() - r.date;
      // The Date header has one-second resolution; allow for it.
      if (Math.abs(skew) > 5000) say('✖', `this machine's clock differs from OANDA's by ${(skew / 1000).toFixed(1)} s — fix the clock before trading`);
      else say('✔', `clock within ${(Math.abs(skew) / 1000).toFixed(1)} s of OANDA's`);
    } else {
      say('⚠', 'OANDA sent no Date header, so the clock could not be compared');
    }
  } catch (err) {
    say('✖', `the account summary failed: ${(err as Error).message}`);
    say('•', 'Check the token (Manage API Access), that it belongs to this account, and that practice/live match TRADING_ENVIRONMENT.');
    return;
  }

  // ── Instruments ───────────────────────────────────────────────────────────
  section('Markets this account may trade');
  // Like the app, everything below uses only the configured markets the account is offered: OANDA refuses a
  // whole request or stream that names one it does not offer.
  let markets = [...config.symbols];
  try {
    const r = await http.get<{ instruments?: Raw[] }>(`${acct}/instruments`);
    const all = r.instruments ?? [];
    const byType = new Map<string, number>();
    for (const i of all) byType.set(String(i.type), (byType.get(String(i.type)) ?? 0) + 1);
    say('•', `${all.length} instruments offered: ${[...byType].map(([t, n]) => `${t} ${n}`).join(', ') || 'none'}`);
    markets = [];
    for (const s of config.symbols) {
      const raw = all.find((i) => i.name === s);
      if (!raw) {
        say('⚠', `${s}: NOT offered to this account — its worker will show "not offered" and never trade; the other markets are unaffected`);
        continue;
      }
      markets.push(s);
      const i = mapInstrument(raw);
      say('✔', `${s} (${i.displayName}, ${i.type}): units step ${i.unitsPrecision === 0 ? '1' : `0.${'0'.repeat(i.unitsPrecision - 1)}1`}, min ${i.minUnits}, max ${i.maxOrderUnits ?? 'n/a'}, ${i.displayPrecision} price decimals, margin ${(i.marginRate * 100).toFixed(1)}%`);
    }
    if (markets.length === 0) {
      say('✖', 'none of the configured markets is offered to this account, so there is nothing to trade. Change OANDA_INSTRUMENTS, or check the account type / region with OANDA.');
      return;
    }
  } catch (err) {
    say('⚠', `the instrument list failed (${(err as Error).message}); checking every configured market instead`);
  }

  // ── Prices ────────────────────────────────────────────────────────────────
  section('Live prices');
  try {
    const r = await http.get<{ prices?: Raw[]; homeConversions?: Raw[] }>(`${acct}/pricing`, { instruments: markets.join(','), includeHomeConversions: true });
    const prices = r.prices ?? [];
    for (const s of markets) {
      const p = prices.find((x) => x.instrument === s);
      if (!p) {
        say('⚠', `${s}: no price returned`);
        continue;
      }
      const bid = num((p.bids as Raw[] | undefined)?.[0]?.price);
      const ask = num((p.asks as Raw[] | undefined)?.[0]?.price);
      const t = oandaTime(p.time);
      const age = t === null ? null : (Date.now() - t) / 1000;
      const flag = `status=${p.status ?? 'absent'} tradeable=${p.tradeable ?? 'absent'}`;
      if (bid === null || ask === null) say('⚠', `${s}: no bid/ask (${flag})`);
      else if (!priceTradeable(p)) say('⚠', `${s}: bid ${bid} / ask ${ask} but the market is not tradeable right now (${flag})`);
      else say('✔', `${s}: bid ${bid} / ask ${ask}, spread ${fixed(ask - bid, 5)}, ${age === null ? 'no timestamp' : `${age.toFixed(1)} s old`} (${flag})`);
    }
    const conv = (r.homeConversions ?? []).map((c) => String(c.currency)).join(', ');
    say('•', `home conversions returned for: ${conv || 'none'} (needed to size positions in ${currency ?? 'the account currency'})`);
  } catch (err) {
    say('✖', `the pricing request failed: ${(err as Error).message}`);
  }

  // ── Candles ───────────────────────────────────────────────────────────────
  section('1-minute candles');
  for (const s of markets) {
    try {
      const r = await http.get<{ candles?: Raw[] }>(`/v3/instruments/${encodeURIComponent(s)}/candles`, { price: 'M', granularity: 'M1', count: 3 });
      const c = r.candles ?? [];
      const last = c[c.length - 1];
      if (!last) say('⚠', `${s}: no candles returned`);
      else {
        const mid = (last.mid ?? {}) as Raw;
        say('✔', `${s}: ${c.length} candles, last ${new Date(oandaTime(last.time) ?? 0).toISOString().slice(11, 19)}Z ${last.complete ? 'complete' : 'forming'} close ${mid.c ?? 'n/a'} (tick volume ${last.volume ?? 'n/a'})`);
      }
    } catch (err) {
      say('⚠', `${s}: candles failed: ${(err as Error).message}`);
    }
  }

  // ── Streams ───────────────────────────────────────────────────────────────
  section('Streams (listening for 8 seconds each)');
  const listen = async (name: string, url: string): Promise<{ counts: Map<string, number>; state: string; error: string | null }> => {
    const stream = new OandaStream({ name, url: () => url, token: creds.token, logger, silenceTimeoutMs: 12_000 });
    const counts = new Map<string, number>();
    stream.onMessage((m) => counts.set(String(m.type ?? '?'), (counts.get(String(m.type ?? '?')) ?? 0) + 1));
    stream.start();
    await new Promise((r) => setTimeout(r, 8000));
    const st = stream.getStatus();
    await stream.stop();
    return { counts, state: st.state, error: st.lastError };
  };
  const fmt = (c: Map<string, number>) => [...c].map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing';
  const [prices, txns] = await Promise.all([
    listen('pricing', `${streamBase}${acct}/pricing/stream?instruments=${encodeURIComponent(markets.join(','))}&snapshot=true`),
    listen('transactions', `${streamBase}${acct}/transactions/stream`),
  ]);
  if (prices.state === 'CONNECTED' && (prices.counts.get('PRICE') ?? 0) > 0) say('✔', `pricing stream: ${fmt(prices.counts)}`);
  else say('✖', `pricing stream ${prices.state}${prices.error ? ` (${prices.error})` : ''}: received ${fmt(prices.counts)}`);
  if (txns.state === 'CONNECTED' && (txns.counts.get('HEARTBEAT') ?? 0) > 0) say('✔', `transaction stream: ${fmt(txns.counts)} (fills and stops arrive here)`);
  else say('✖', `transaction stream ${txns.state}${txns.error ? ` (${txns.error})` : ''}: received ${fmt(txns.counts)}`);
}

main()
  .then(() => {
    console.log(`\n${failures ? `✖ NOT READY — ${failures} problem(s)` : warnings ? `✔ Connected, with ${warnings} warning(s) above` : '✔ Everything checked out'}. Nothing was ordered or changed.`);
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    console.error(err instanceof ConfigError ? `✖ ${err.message}` : err);
    process.exit(1);
  });
