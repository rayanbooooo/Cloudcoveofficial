import { fileURLToPath } from 'node:url';
import { buildServer } from './api/server.js';
import { ConfigError, loadEnvFile, parseConfig } from './config/env.js';
import { systemClock } from './core/clock.js';
import { createLogger } from './core/logger.js';
import { PgDb } from './db/db.js';
import { App } from './system/App.js';

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
      `    Open http://${config.host}:${config.port} and create your account with setup code:  ${app.setupCode}`,
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
