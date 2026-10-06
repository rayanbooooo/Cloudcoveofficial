import { fileURLToPath } from 'node:url';
import { buildServer } from './api/server.js';
import { ConfigError, loadEnvFile, parseConfig } from './config/env.js';
import { systemClock } from './core/clock.js';
import { createLogger } from './core/logger.js';
import { PgDb } from './db/db.js';
import { App } from './system/App.js';
import { InstanceLock, startStandbyServer } from './system/InstanceLock.js';

/** Where people open the app (hosting platforms publish it in the environment). */
function publicUrl(host: string, port: number): string {
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : undefined;
  return process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? railway ?? `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
}

async function main(): Promise<void> {
  loadEnvFile();
  let config;
  try {
    config = parseConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n✖ ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(config.logLevel, config.nodeEnv !== 'production' && process.stdout.isTTY === true);
  const db = new PgDb(config.databaseUrl);
  if (!(await db.ping())) {
    logger.fatal('cannot connect to PostgreSQL — check DATABASE_URL (see README: npm run db:up)');
    process.exit(1);
  }

  // Only one process may trade against this database (and so this account).
  // A second instance (zero-downtime deploy, wrong instance count) waits in
  // standby — answering health checks, never trading — until the lock frees.
  let trading = false;
  const early = () => {
    if (!trading) process.exit(0);
  };
  process.on('SIGINT', early);
  process.on('SIGTERM', early);
  const lock = new InstanceLock(config.databaseUrl, (reason) => {
    logger.fatal({ reason }, 'lost the single-instance trading lock — exiting so the platform restarts this process cleanly');
    process.exit(1);
  });
  let standby: { close(): Promise<void> } | null = null;
  await lock.acquire({
    onWait: async () => {
      logger.warn('another Scalp City instance is trading against this database — standing by (no trading) until it stops');
      standby = await startStandbyServer(config.host, config.port);
    },
    onError: (err) => logger.warn({ err: err.message }, 'trading lock attempt failed; retrying'),
    // A previous instance that vanished without closing its connection would otherwise hold the lock for hours.
    staleHolderMs: 60_000,
    onEvict: (h) => logger.warn({ pid: h.pid, idleSeconds: Math.round(h.idleMs / 1000) }, 'the previous trading instance stopped responding; ended its stale database session to take over'),
  });
  if (standby) await (standby as { close(): Promise<void> }).close();
  trading = true;
  process.off('SIGINT', early);
  process.off('SIGTERM', early);
  logger.info('trading lock acquired: this is the only instance trading against this database');

  const app = new App({ config, db, clock: systemClock, logger });
  await app.init();

  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
  const { fastify } = await buildServer(app, { webDist });
  await fastify.listen({ host: config.host, port: config.port });

  const env = config.tradingEnvironment.toUpperCase();
  const lines = [
    '',
    '  ███ SCALP CITY',
    `  environment      ${env}${config.tradingEnvironment === 'live' ? '   ← REAL MONEY ACCOUNT' : ''}`,
    `  live lock        LIVE_TRADING_ENABLED=${config.liveTradingEnabled}`,
    `  credentials      paper: ${config.credentials.paper ? 'set' : '—'}   live: ${config.credentials.live ? 'set' : '—'}`,
    `  data feeds       stocks: ${config.stockFeed}   options: ${config.optionsFeed}`,
    config.nonStandardEndpoints.length ? `  ⚠ NON-STANDARD ENDPOINTS: ${config.nonStandardEndpoints.join(', ')}` : null,
    `  listening        http://${config.host}:${config.port}`,
    '',
  ].filter((l): l is string => l !== null);
  for (const l of lines) logger.info(l);
  if (app.setupCode) {
    for (const l of [
      '',
      '  ⚑ FIRST RUN: no account exists yet.',
      `    Open ${publicUrl(config.host, config.port)} and create your account with setup code:  ${app.setupCode}`,
      '    (single use; it stops working once the account exists. Alternative: npm run user:create)',
      '',
    ])
      logger.warn(l);
  }

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    try {
      await fastify.close();
      await app.shutdown();
      await db.close();
      await lock.release();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
