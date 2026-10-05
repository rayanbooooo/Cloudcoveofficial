import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  aggregateBars,
  atr,
  ema,
  isOandaSymbol,
  maskAccountNumber,
  parseOccSymbol,
  TIMEFRAMES,
  vwapSeries,
  type ChartResponse,
  type JournalTradeView,
  type ManualOrderRequest,
  type OrderPreview,
  type Timeframe,
} from '@scalp-city/shared';
import { SESSION_COOKIE } from '../auth/AuthService.js';
import { ms, n } from '../db/db.js';
import { nyDate } from '../market/MarketCalendar.js';
import { stockFeedLabel } from '../marketdata/MarketDataService.js';
import { rowToTrade } from '../positions/PositionLedger.js';
import { RiskLimitsError } from '../risk/RiskSettings.js';
import { LiveGateError } from '../safety/LiveGate.js';
import type { BreakerId } from '../safety/CircuitBreakers.js';
import { BREAKERS } from '../safety/CircuitBreakers.js';
import type { App } from '../system/App.js';
import { WorkerConfigError, mergeWorkerConfig, workerChangeIncreasesRisk } from '../workers/WorkerManager.js';
import { HttpError, parse, requireAuth } from './http.js';

const bool = z.boolean();
const positive = z.number().finite().positive();

const ManualOrderSchema = z
  .object({
    symbol: z.string().trim().toUpperCase().regex(/^[A-Z0-9._]{1,25}$/),
    assetClass: z.enum(['us_equity', 'us_option', 'cfd']),
    side: z.enum(['buy', 'sell']),
    qty: z.number().finite().positive().max(100_000_000),
    type: z.enum(['market', 'limit', 'stop', 'stop_limit']),
    limitPrice: positive.nullable().optional(),
    stopPrice: positive.nullable().optional(),
    intent: z.enum(['open', 'close']),
    stopLoss: positive.nullable().optional(),
  })
  .superRefine((r, ctx) => {
    if (r.assetClass !== 'cfd' && !Number.isInteger(r.qty)) ctx.addIssue({ code: 'custom', path: ['qty'], message: 'quantity must be a whole number' });
    if (r.assetClass !== 'cfd' && r.qty > 100_000) ctx.addIssue({ code: 'custom', path: ['qty'], message: 'quantity too large' });
    if (r.stopLoss != null && (r.assetClass !== 'cfd' || r.intent !== 'open')) ctx.addIssue({ code: 'custom', path: ['stopLoss'], message: 'a stop loss can only be attached to a CFD order that opens a position' });
  });

const RiskLimitsPatch = z
  .object({
    maxDailyLoss: positive,
    maxPositionNotional: positive,
    maxOrderNotional: positive,
    maxContracts: z.number().int().positive(),
    maxShares: z.number().int().positive(),
    maxConcurrentPositions: z.number().int().positive(),
    maxTradesPerDay: z.number().int().positive(),
    maxOrdersPerMinute: z.number().int().positive(),
    maxPriceDeviationPct: positive,
    noEntriesBeforeCloseMinutes: z.number().finite().min(0),
    pdtGuard: bool,
  })
  .partial();

interface StoredPreview {
  userId: string;
  env: 'paper' | 'live';
  request: ManualOrderRequest;
  expiresAt: number;
}

function actorOf(s: { username: string }): string {
  return s.username;
}

/** Contract multiplier and underlying for a manual order symbol. */
function instrumentInfo(req: ManualOrderRequest, cfdFactor: (symbol: string) => number | null): { multiplier: number; underlying: string } {
  if (req.assetClass === 'cfd') {
    if (!isOandaSymbol(req.symbol)) throw new HttpError(400, 'BAD_SYMBOL', 'not an OANDA instrument name (e.g. XAU_USD)');
    const f = cfdFactor(req.symbol);
    if (f === null) throw new HttpError(409, 'NO_CONVERSION', `no currency conversion rate for ${req.symbol} yet — try again in a few seconds`);
    return { multiplier: f, underlying: req.symbol };
  }
  if (isOandaSymbol(req.symbol)) throw new HttpError(400, 'BAD_SYMBOL', 'OANDA instruments trade as CFD/FX');
  if (req.assetClass === 'us_option') {
    const occ = parseOccSymbol(req.symbol);
    if (!occ) throw new HttpError(400, 'BAD_SYMBOL', 'not a valid OCC option symbol');
    return { multiplier: 100, underlying: occ.root };
  }
  if (parseOccSymbol(req.symbol)) throw new HttpError(400, 'BAD_SYMBOL', 'option symbol submitted as equity');
  return { multiplier: 1, underlying: req.symbol };
}

/** Time in force for a manual ticket: CFD market orders fill-or-kill, CFD limits rest for the day. */
function manualTif(r: ManualOrderRequest): 'day' | 'fok' {
  return r.assetClass === 'cfd' && r.type === 'market' ? 'fok' : 'day';
}

export function registerRoutes(fastify: FastifyInstance, app: App): void {
  const previews = new Map<string, StoredPreview>();
  const ctx = () => app.ctx;
  const requireConfigured = () => {
    if (!ctx().configured) throw new HttpError(409, 'NOT_CONFIGURED', 'broker credentials are not configured for this environment');
    if (app.isSwitching) throw new HttpError(409, 'SWITCHING', 'environment switch in progress');
  };
  const isLive = () => ctx().env === 'live';

  // ── Public ───────────────────────────────────────────────────────────────
  fastify.get('/api/healthz', async () => ({ ok: true, phase: ctx().phase, env: ctx().env }));

  fastify.get('/api/session', async (req) => ({
    authenticated: req.session !== null,
    username: req.session?.username ?? null,
    csrfToken: req.session?.csrfToken ?? null,
    hasUsers: (await app.auth.userCount()) > 0,
  }));

  fastify.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const body = parse(z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) }), req.body);
    const result = await app.auth.login(body.username, body.password, { ip: req.ip, userAgent: req.headers['user-agent'] ?? null });
    if (!result) {
      void app.audit.record({ action: 'LOGIN_FAILED', actor: body.username.slice(0, 64), details: { ip: req.ip } });
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'invalid username or password');
    }
    void app.audit.record({ action: 'LOGIN', actor: result.session.username, details: { ip: req.ip } });
    reply.setCookie(SESSION_COOKIE, result.token, {
      httpOnly: true,
      secure: app.config.cookieSecure,
      sameSite: 'strict',
      path: '/',
      expires: new Date(result.session.expiresAt),
    });
    return { authenticated: true, username: result.session.username, csrfToken: result.session.csrfToken };
  });

  // First run only: create the owner account with the setup code printed on the server console.
  fastify.post('/api/auth/setup', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const body = parse(z.object({ setupCode: z.string().min(1).max(64), username: z.string().min(3).max(32), password: z.string().min(12).max(256) }), req.body);
    let outcome: 'ok' | 'closed' | 'bad_code';
    try {
      outcome = await app.auth.setupOwner(body.setupCode, body.username, body.password);
    } catch (err) {
      throw new HttpError(400, 'INVALID_ACCOUNT', (err as Error).message);
    }
    if (outcome === 'closed') throw new HttpError(409, 'SETUP_CLOSED', 'an account already exists — sign in instead');
    if (outcome === 'bad_code') {
      void app.audit.record({ action: 'SETUP_FAILED', actor: 'anonymous', details: { ip: req.ip } });
      throw new HttpError(403, 'BAD_SETUP_CODE', 'wrong setup code — use the code printed in the server log when Scalp City started');
    }
    app.setupCode = null;
    const result = await app.auth.login(body.username, body.password, { ip: req.ip, userAgent: req.headers['user-agent'] ?? null });
    if (!result) throw new HttpError(500, 'SETUP_LOGIN_FAILED', 'account created, but signing in failed — sign in manually');
    void app.audit.record({ action: 'OWNER_CREATED', actor: result.session.username, details: { ip: req.ip } });
    reply.setCookie(SESSION_COOKIE, result.token, {
      httpOnly: true,
      secure: app.config.cookieSecure,
      sameSite: 'strict',
      path: '/',
      expires: new Date(result.session.expiresAt),
    });
    return { authenticated: true, username: result.session.username, csrfToken: result.session.csrfToken };
  });

  fastify.post('/api/auth/logout', async (req, reply) => {
    const s = requireAuth(req);
    await app.auth.logout(req.cookies[SESSION_COOKIE]);
    void app.audit.record({ action: 'LOGOUT', actor: s.username });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // ── State ────────────────────────────────────────────────────────────────
  fastify.get('/api/snapshot', async (req) => {
    requireAuth(req);
    return app.views.snapshot(ctx(), app.availableEnvs());
  });

  fastify.get('/api/readiness', async (req) => {
    requireAuth(req);
    await app.views.refresh(ctx().env);
    return app.views.readiness(ctx());
  });

  // ── Live trading gate ────────────────────────────────────────────────────
  fastify.post('/api/live/enable', async (req) => {
    const s = requireAuth(req);
    requireConfigured();
    const body = parse(
      z.object({ password: z.string().min(1).max(256), confirmAccount: z.string().max(32), acknowledgeRealMoney: bool, secondConfirmation: bool }),
      req.body,
    );
    const c = ctx();
    await app.views.refresh(c.env);
    try {
      await c.liveGate.arm({
        actor: actorOf(s),
        passwordOk: await app.auth.verifyUserPassword(s.userId, body.password),
        confirmAccount: body.confirmAccount,
        expectedAccount: maskAccountNumber(c.account.account?.accountNumber),
        acknowledgeRealMoney: body.acknowledgeRealMoney,
        secondConfirmation: body.secondConfirmation,
        readiness: app.views.readiness(c),
      });
    } catch (err) {
      if (err instanceof LiveGateError) throw new HttpError(err.status, 'LIVE_REFUSED', err.message);
      throw err;
    }
    return app.views.system(c, app.availableEnvs());
  });

  fastify.post('/api/live/disarm', async (req) => {
    const s = requireAuth(req);
    ctx().liveGate.disarm(actorOf(s), 'disarmed by user');
    return app.views.system(ctx(), app.availableEnvs());
  });

  fastify.post('/api/env/switch', async (req) => {
    const s = requireAuth(req);
    const body = parse(z.object({ target: z.enum(['paper', 'live']), password: z.string().min(1).max(256), confirmed: z.literal(true) }), req.body);
    if (!(await app.auth.verifyUserPassword(s.userId, body.password))) throw new HttpError(401, 'REAUTH_FAILED', 'password re-authentication failed');
    if (ctx().workers && ctx().orders?.workingOrders().length) {
      throw new HttpError(409, 'ORDERS_WORKING', 'cancel working orders before switching environments');
    }
    try {
      await app.switchEnvironment(body.target, actorOf(s));
    } catch (err) {
      throw new HttpError(409, 'SWITCH_FAILED', (err as Error).message);
    }
    return app.views.system(ctx(), app.availableEnvs());
  });

  // ── Controls (spec §100: always accessible) ─────────────────────────────
  fastify.post('/api/controls/autotrading', async (req) => {
    const s = requireAuth(req);
    const body = parse(z.object({ enabled: bool, confirmed: bool.optional() }), req.body);
    if (body.enabled && isLive() && !body.confirmed) throw new HttpError(428, 'CONFIRMATION_REQUIRED', 'enabling autotrading in LIVE requires confirmation');
    const r = ctx().controls.setAutotrading(body.enabled, actorOf(s));
    if (!r.ok) throw new HttpError(409, 'REFUSED', r.message);
    return app.views.system(ctx(), app.availableEnvs());
  });

  fastify.post('/api/controls/pause', async (req) => {
    const s = requireAuth(req);
    const body = parse(z.object({ paused: bool }), req.body);
    ctx().controls.setEntriesPaused(body.paused, actorOf(s));
    return app.views.system(ctx(), app.availableEnvs());
  });

  fastify.post('/api/controls/kill-switch', async (req) => {
    const s = requireAuth(req);
    const body = parse(z.object({ reason: z.string().max(200).optional() }), req.body ?? {});
    const c = ctx();
    c.workers?.disableAll(actorOf(s));
    const r = await c.controls.activateKillSwitch(actorOf(s), body.reason ?? 'manual', c.configured ? c.orders : null);
    return { system: app.views.system(c, app.availableEnvs()), canceled: r.canceled, failed: r.failed };
  });

  fastify.post('/api/controls/kill-switch/release', async (req) => {
    const s = requireAuth(req);
    parse(z.object({ confirmed: z.literal(true) }), req.body);
    await ctx().controls.releaseKillSwitch(actorOf(s));
    return app.views.system(ctx(), app.availableEnvs());
  });

  fastify.post('/api/controls/flatten', async (req) => {
    const s = requireAuth(req);
    requireConfigured();
    parse(z.object({ confirmed: z.literal(true) }), req.body);
    const c = ctx();
    void c.controls.flattenAll(actorOf(s), { broker: c.broker, account: c.account, orders: c.orders });
    return { started: true };
  });

  // ── Workers ──────────────────────────────────────────────────────────────
  fastify.post('/api/workers/:id/enabled', async (req) => {
    const s = requireAuth(req);
    requireConfigured();
    const { id } = parse(z.object({ id: z.string().max(64) }), req.params);
    const body = parse(z.object({ enabled: bool, confirmed: bool.optional() }), req.body);
    // Enabling a worker capable of autonomous execution requires confirmation (spec §101).
    if (body.enabled && !body.confirmed) throw new HttpError(428, 'CONFIRMATION_REQUIRED', 'enabling autonomous execution requires confirmation');
    try {
      ctx().workers.setEnabled(id, body.enabled, actorOf(s));
    } catch (err) {
      if (err instanceof WorkerConfigError) throw new HttpError(404, 'UNKNOWN_WORKER', err.message);
      throw err;
    }
    return ctx().workers.get(id)!.view();
  });

  fastify.patch('/api/workers/:id', async (req) => {
    const s = requireAuth(req);
    requireConfigured();
    const { id } = parse(z.object({ id: z.string().max(64) }), req.params);
    const body = parse(
      z.object({
        limits: z.record(z.string(), z.number()).optional(),
        exits: z.record(z.string(), z.union([z.number(), z.boolean()])).optional(),
        options: z.record(z.string(), z.number()).optional(),
        instrument: z.enum(['OPTIONS', 'EQUITY', 'CFD']).optional(),
        allowShort: bool.optional(),
        confirmed: bool.optional(),
        password: z.string().max(256).optional(),
      }),
      req.body,
    );
    const w = ctx().workers.get(id);
    if (!w) throw new HttpError(404, 'UNKNOWN_WORKER', `unknown worker ${id}`);
    let next;
    try {
      next = mergeWorkerConfig(w.config, body as never);
    } catch (err) {
      if (err instanceof WorkerConfigError) throw new HttpError(400, 'INVALID_CONFIG', err.message);
      throw err;
    }
    if (workerChangeIncreasesRisk(w.config, next)) {
      if (!body.confirmed) throw new HttpError(428, 'CONFIRMATION_REQUIRED', 'this change increases risk and requires confirmation');
      if (isLive() && !(body.password && (await app.auth.verifyUserPassword(s.userId, body.password)))) {
        throw new HttpError(401, 'REAUTH_REQUIRED', 'increasing risk while LIVE requires your password');
      }
    }
    try {
      await ctx().workers.updateConfig(id, body as never, actorOf(s));
    } catch (err) {
      if (err instanceof WorkerConfigError) throw new HttpError(400, 'INVALID_CONFIG', err.message);
      throw err;
    }
    return ctx().workers.get(id)!.view();
  });

  // ── Risk limits (spec §102, §104) ───────────────────────────────────────
  fastify.get('/api/risk/limits', async (req) => {
    requireAuth(req);
    return { limits: ctx().riskSettings.get() };
  });

  fastify.post('/api/risk/limits/preview', async (req) => {
    requireAuth(req);
    const body = parse(z.object({ limits: RiskLimitsPatch }), req.body);
    try {
      return ctx().riskSettings.preview(body.limits, isLive()).preview;
    } catch (err) {
      if (err instanceof RiskLimitsError) throw new HttpError(400, 'INVALID_LIMITS', err.message);
      throw err;
    }
  });

  fastify.put('/api/risk/limits', async (req) => {
    const s = requireAuth(req);
    const body = parse(z.object({ limits: RiskLimitsPatch, confirmed: bool.optional(), password: z.string().max(256).optional() }), req.body);
    const rs = ctx().riskSettings;
    let result;
    try {
      result = rs.preview(body.limits, isLive());
    } catch (err) {
      if (err instanceof RiskLimitsError) throw new HttpError(400, 'INVALID_LIMITS', err.message);
      throw err;
    }
    if (result.preview.increasesRisk && !body.confirmed) throw new HttpError(428, 'CONFIRMATION_REQUIRED', 'this change increases the maximum potential loss and requires confirmation');
    if (result.preview.requiresPassword && !(body.password && (await app.auth.verifyUserPassword(s.userId, body.password)))) {
      throw new HttpError(401, 'REAUTH_REQUIRED', 'increasing risk while LIVE requires your password');
    }
    const before = rs.get();
    await rs.apply(result.next, actorOf(s));
    void app.audit.record({ action: 'RISK_LIMITS_CHANGED', actor: actorOf(s), env: ctx().env, details: { before, after: result.next, changes: result.preview.changes } });
    ctx().timeline.add({ kind: 'control', severity: result.preview.increasesRisk ? 'warn' : 'info', title: 'Risk limits changed', detail: result.preview.changes.map((c) => `${c.key}: ${c.from} → ${c.to}`).join(', ') });
    app.bus.emit('SYSTEM_UPDATED', {});
    return { limits: rs.get() };
  });

  // ── Manual trading (same RiskEngine — spec §55) ─────────────────────────
  fastify.post('/api/orders/preview', async (req) => {
    const s = requireAuth(req);
    requireConfigured();
    const r = parse(ManualOrderSchema, req.body) as ManualOrderRequest;
    const c = ctx();
    if ((r.assetClass === 'cfd') !== (c.venue === 'oanda')) {
      throw new HttpError(400, 'WRONG_BROKER', c.venue === 'oanda' ? 'this installation trades through OANDA — use an OANDA instrument (CFD/FX)' : 'CFD/FX instruments need BROKER=oanda');
    }
    const { multiplier, underlying } = instrumentInfo(r, (s) => c.instruments.homeFactor(s));
    const warnings: string[] = [];
    if (r.assetClass === 'cfd' && r.intent === 'open' && !r.stopLoss) {
      warnings.push('No stop loss: this position will have no broker-side protection if Scalp City goes offline.');
    }
    if (r.assetClass === 'us_option') {
      c.marketData.watchOptions('manual', [r.symbol]);
      if (!c.marketData.status().optionsRealtimeNbbo) warnings.push('Options quotes come from the INDICATIVE feed — not the real NBBO.');
    }
    let estimatedPrice = r.limitPrice ?? null;
    if (estimatedPrice === null) {
      if (r.assetClass === 'us_option') {
        const q = c.marketData.optionQuote(r.symbol);
        estimatedPrice = (r.side === 'buy' ? q?.ask : q?.bid) ?? q?.mid ?? null;
      } else if (r.assetClass === 'cfd') {
        const st = c.marketData.state(r.symbol);
        estimatedPrice = (r.side === 'buy' ? st?.ask : st?.bid) ?? null;
      } else {
        const st = c.marketData.state(r.symbol);
        estimatedPrice = (r.side === 'buy' ? st?.ask : st?.bid) ?? st?.last ?? null;
      }
      if (r.type === 'market') warnings.push('Market order: the fill price can differ from the estimate.');
    }
    const estimatedNotional = estimatedPrice === null ? null : estimatedPrice * r.qty * multiplier;
    const equity = c.account.account?.equity ?? null;
    const isOpt = r.assetClass === 'us_option';
    const isCfd = r.assetClass === 'cfd';
    const marginRate = isCfd ? c.instruments.marginRate(r.symbol, c.account.account) : null;
    const risk = await c.orders.previewRisk({
      workerId: null,
      source: 'MANUAL',
      purpose: r.intent === 'open' ? 'MANUAL_OPEN' : 'MANUAL_CLOSE',
      signalId: null,
      symbol: r.symbol,
      underlying,
      assetClass: r.assetClass,
      side: r.side,
      positionIntent: isOpt || isCfd ? (r.intent === 'open' ? (r.side === 'buy' ? 'buy_to_open' : 'sell_to_open') : r.side === 'sell' ? 'sell_to_close' : 'buy_to_close') : null,
      type: r.type,
      timeInForce: manualTif(r),
      qty: r.qty,
      limitPrice: r.limitPrice ?? null,
      stopPrice: r.stopPrice ?? null,
      meta: { multiplier, protectiveStop: r.stopLoss ? { price: r.stopLoss } : null },
      actor: actorOf(s),
    });
    const token = randomBytes(24).toString('base64url');
    const expiresAt = app.clock.now() + 60_000;
    previews.set(token, { userId: s.userId, env: c.env, request: r, expiresAt });
    for (const [k, v] of previews) if (v.expiresAt < app.clock.now()) previews.delete(k);
    const preview: OrderPreview = {
      request: r,
      env: c.env,
      estimatedPrice,
      estimatedNotional,
      buyingPower: isOpt ? (c.account.account?.optionsBuyingPower ?? null) : (c.account.account?.buyingPower ?? null),
      estimatedMargin: isCfd && estimatedNotional !== null && marginRate !== null ? estimatedNotional * marginRate : null,
      marginAvailable: c.account.account?.marginAvailable ?? null,
      riskAtStop: isCfd && r.stopLoss && estimatedPrice !== null ? r.qty * Math.abs(estimatedPrice - r.stopLoss) * multiplier : null,
      currency: c.account.account?.currency ?? null,
      riskPct: estimatedNotional !== null && equity ? (estimatedNotional / equity) * 100 : null,
      risk,
      previewToken: token,
      expiresAt,
      warnings,
    };
    return preview;
  });

  fastify.post('/api/orders', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const s = requireAuth(req);
    requireConfigured();
    const body = parse(z.object({ previewToken: z.string().min(10).max(100), confirmed: z.literal(true) }), req.body);
    const p = previews.get(body.previewToken);
    previews.delete(body.previewToken);
    if (!p || p.userId !== s.userId) throw new HttpError(410, 'PREVIEW_EXPIRED', 'order preview not found — preview the order again');
    if (p.expiresAt < app.clock.now()) throw new HttpError(410, 'PREVIEW_EXPIRED', 'order preview expired — preview the order again');
    const c = ctx();
    if (p.env !== c.env) throw new HttpError(409, 'ENV_CHANGED', 'environment changed since the preview');
    const r = p.request;
    const { multiplier, underlying } = instrumentInfo(r, (sym) => c.instruments.homeFactor(sym));
    const isOpt = r.assetClass === 'us_option';
    const isCfd = r.assetClass === 'cfd';
    const order = await c.orders.submit({
      workerId: null,
      source: 'MANUAL',
      purpose: r.intent === 'open' ? 'MANUAL_OPEN' : 'MANUAL_CLOSE',
      signalId: null,
      symbol: r.symbol,
      underlying,
      assetClass: r.assetClass,
      side: r.side,
      positionIntent: isOpt || isCfd ? (r.intent === 'open' ? (r.side === 'buy' ? 'buy_to_open' : 'sell_to_open') : r.side === 'sell' ? 'sell_to_close' : 'buy_to_close') : null,
      type: r.type,
      timeInForce: manualTif(r),
      qty: r.qty,
      limitPrice: r.limitPrice ?? null,
      stopPrice: r.stopPrice ?? null,
      meta: { multiplier, exitReason: r.intent === 'close' ? 'MANUAL_CLOSE' : undefined, protectiveStop: r.stopLoss ? { price: r.stopLoss } : null },
      actor: actorOf(s),
    });
    return c.orders.view(order);
  });

  fastify.post('/api/orders/:id/cancel', async (req) => {
    const s = requireAuth(req);
    requireConfigured();
    const { id } = parse(z.object({ id: z.string().max(80) }), req.params);
    const r = await ctx().orders.cancel(id, actorOf(s));
    if (!r.ok) throw new HttpError(409, 'CANCEL_FAILED', r.message);
    const o = ctx().orders.get(id)!;
    return { message: r.message, order: ctx().orders.view(o) };
  });

  fastify.get('/api/orders', async (req) => {
    requireAuth(req);
    if (!ctx().configured) return [];
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    const rows = await ctx().orders.repository.listRecent(ctx().venue, ctx().env, q.limit);
    return rows.map((o) => ctx().orders.view(ctx().orders.get(o.id) ?? o));
  });

  fastify.get('/api/orders/:id/events', async (req) => {
    requireAuth(req);
    const { id } = parse(z.object({ id: z.string().max(80) }), req.params);
    return ctx().configured ? ctx().orders.repository.events(id) : [];
  });

  // ── Breakers & reconciliation ───────────────────────────────────────────
  fastify.post('/api/breakers/:id/reset', async (req) => {
    const s = requireAuth(req);
    const { id } = parse(z.object({ id: z.string() }), req.params);
    parse(z.object({ confirmed: z.literal(true) }), req.body);
    if (!(id in BREAKERS)) throw new HttpError(404, 'UNKNOWN_BREAKER', id);
    await ctx().breakers.reset(id as BreakerId, actorOf(s));
    return app.views.system(ctx(), app.availableEnvs());
  });

  fastify.post('/api/reconciliation/run', async (req) => {
    requireAuth(req);
    requireConfigured();
    return ctx().reconciler.run();
  });

  fastify.post('/api/reconciliation/accept', async (req) => {
    const s = requireAuth(req);
    requireConfigured();
    parse(z.object({ confirmed: z.literal(true) }), req.body);
    return ctx().reconciler.acceptBrokerState(actorOf(s));
  });

  // ── Charts (real data only — spec §46, §86) ─────────────────────────────
  fastify.get('/api/chart', async (req) => {
    requireAuth(req);
    requireConfigured();
    const q = parse(
      z.object({
        symbol: z.string().toUpperCase().regex(/^([A-Z.]{1,10}|[A-Z0-9]{2,12}_[A-Z0-9]{2,12})$/),
        tf: z.enum(TIMEFRAMES).default('1Min'),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
      req.query,
    );
    const c = ctx();
    const now = app.clock.now();
    let bars;
    let source: string;
    if (q.date && q.date !== nyDate(now)) {
      const session = c.calendar.sessionFor(q.date);
      if (!session) throw new HttpError(404, 'NO_SESSION', `${q.date} was not a trading session (or is outside the loaded calendar)`);
      bars = (await c.provider.getHistoricalBars([q.symbol], session.openMs, session.closeMs)).filter((b) => c.calendar.sessionKey(b.t) !== null);
      source = 'historical';
    } else {
      if (!c.marketData.symbols.includes(q.symbol)) throw new HttpError(404, 'NOT_STREAMED', `${q.symbol} is not a streamed symbol`);
      bars = c.marketData.bars(q.symbol).filter((b) => c.calendar.sessionKey(b.t) !== null);
      source = 'live';
    }
    const tfBars = q.tf === '1Min' ? bars : aggregateBars(bars, q.tf as Timeframe, now);
    const closes = tfBars.map((b) => b.c);
    const response: ChartResponse = {
      symbol: q.symbol,
      timeframe: q.tf,
      bars: tfBars,
      vwap: vwapSeries(tfBars, c.calendar.sessionKey),
      ema: ema(closes, 50),
      atr: atr(tfBars, 14),
      source,
      feedLabel: `${stockFeedLabel(app.config.venue === 'oanda' ? 'oanda' : app.config.stockFeed).label}${app.config.venue === 'oanda' ? ' · MID · TICK VOLUME' : ''}`,
    };
    return response;
  });

  // ── Trade journal & review (spec §117, §118) ────────────────────────────
  const toJournal = (t: ReturnType<typeof rowToTrade>, names: Map<string, { name: string; strategy: string }>, orders: { id: string; purpose: string }[]): JournalTradeView => {
    const occ = parseOccSymbol(t.symbol);
    const snap = t.signalSnapshot as { charge?: number; conditions?: unknown[] } | null;
    return {
      id: t.id,
      env: t.env,
      workerId: t.workerId,
      workerName: t.workerId ? (names.get(t.workerId)?.name ?? t.workerId) : null,
      strategyName: t.workerId ? (names.get(t.workerId)?.strategy ?? null) : null,
      symbol: t.symbol,
      underlying: t.underlying ?? occ?.root ?? null,
      assetClass: t.assetClass,
      direction: t.direction,
      qty: t.qtyOpened,
      entryAvgPrice: t.qtyOpened > 0 ? t.entryValue / (t.qtyOpened * t.multiplier) : null,
      exitAvgPrice: t.qtyClosed > 0 ? t.exitValue / (t.qtyClosed * t.multiplier) : null,
      realizedPnl: t.realizedPnl,
      status: t.status,
      openedAt: t.openedAt,
      closedAt: t.closedAt,
      signalId: t.signalId,
      signalConditions: (snap?.conditions as JournalTradeView['signalConditions']) ?? null,
      signalCharge: snap?.charge ?? null,
      entryOrderIds: orders.filter((o) => o.purpose === 'ENTRY' || o.purpose === 'MANUAL_OPEN').map((o) => o.id),
      exitOrderIds: orders.filter((o) => o.purpose !== 'ENTRY' && o.purpose !== 'MANUAL_OPEN').map((o) => o.id),
      exitReason: t.exitReason,
      dailyPnlBefore: t.dailyPnlBefore,
      dailyPnlAfter: t.dailyPnlAfter,
      positionNotional: (t.riskSnapshot?.positionNotional as number | undefined) ?? null,
      option: occ ? { underlying: occ.root, expiration: occ.expiration, type: occ.type, strike: occ.strike } : null,
    };
  };

  const workerNames = async () => {
    const { rows } = await app.db.query<{ id: string; name: string; strategy: string }>('SELECT w.id, w.name, s.name AS strategy FROM workers w JOIN strategies s ON s.id = w.strategy_id');
    return new Map(rows.map((r) => [r.id, { name: r.name, strategy: r.strategy }]));
  };

  fastify.get('/api/journal', async (req) => {
    requireAuth(req);
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), worker: z.string().max(64).optional() }), req.query);
    const params: unknown[] = [ctx().env, app.config.venue];
    let where = 'env = $1 AND venue = $2';
    if (q.worker) {
      params.push(q.worker);
      where += ` AND worker_id = $${params.length}`;
    }
    params.push(q.limit);
    const { rows } = await app.db.query(`SELECT * FROM trades WHERE ${where} ORDER BY opened_at DESC LIMIT $${params.length}`, params);
    const names = await workerNames();
    const trades = rows.map(rowToTrade);
    const ids = trades.map((t) => t.id);
    const orders = ids.length ? (await app.db.query<{ id: string; purpose: string; trade_id: string }>('SELECT id, purpose, trade_id FROM orders WHERE trade_id = ANY($1)', [ids])).rows : [];
    return trades.map((t) => toJournal(t, names, orders.filter((o) => o.trade_id === t.id)));
  });

  fastify.get('/api/journal/:id', async (req) => {
    requireAuth(req);
    const { id } = parse(z.object({ id: z.string().max(80) }), req.params);
    const { rows } = await app.db.query('SELECT * FROM trades WHERE id = $1', [id]);
    if (!rows[0]) throw new HttpError(404, 'NOT_FOUND', 'trade not found');
    const t = rowToTrade(rows[0]);
    const orders = (await app.db.query<{ id: string; purpose: string; trade_id: string }>('SELECT id, purpose, trade_id FROM orders WHERE trade_id = $1', [id])).rows;
    const events = (await app.db.query('SELECT kind, order_id, qty, price, realized_pnl, occurred_at FROM trade_events WHERE trade_id = $1 ORDER BY id', [id])).rows.map((e: Record<string, unknown>) => ({
      kind: e.kind,
      orderId: e.order_id,
      qty: n(e.qty),
      price: n(e.price),
      realizedPnl: n(e.realized_pnl),
      at: ms(e.occurred_at),
    }));
    return { trade: toJournal(t, await workerNames(), orders), events };
  });

  // ── Audit (spec §38) ─────────────────────────────────────────────────────
  fastify.get('/api/audit', async (req) => {
    requireAuth(req);
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), beforeId: z.coerce.number().int().positive().optional(), action: z.string().max(40).optional() }), req.query);
    return app.audit.list(q);
  });

  fastify.get('/api/audit/verify', async (req) => {
    requireAuth(req);
    return app.audit.verify();
  });

  // ── Options helpers for the manual ticket ───────────────────────────────
  fastify.get('/api/options/contracts', async (req) => {
    requireAuth(req);
    requireConfigured();
    const q = parse(
      z.object({ underlying: z.string().toUpperCase().regex(/^[A-Z.]{1,10}$/), type: z.enum(['call', 'put']), expiration: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
      req.query,
    );
    const c = ctx();
    const spot = c.marketData.state(q.underlying)?.last ?? null;
    const contracts = await c.broker.getOptionContracts({
      underlying: q.underlying,
      type: q.type,
      expirationDate: q.expiration,
      expirationDateGte: q.expiration ? undefined : nyDate(app.clock.now()),
      strikeGte: spot ? Math.floor(spot * 0.95) : undefined,
      strikeLte: spot ? Math.ceil(spot * 1.05) : undefined,
      limit: 500,
    });
    return contracts
      .sort((a, b) => a.expirationDate.localeCompare(b.expirationDate) || a.strikePrice - b.strikePrice)
      .slice(0, 200)
      .map((x) => ({ symbol: x.symbol, expiration: x.expirationDate, strike: x.strikePrice, type: x.type, tradable: x.tradable, openInterest: x.openInterest }));
  });
}
