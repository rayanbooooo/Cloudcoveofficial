import pino, { type Logger } from 'pino';

export type { Logger };

/**
 * Structured logger. Anything that could carry a credential is redacted at
 * the serializer level so a careless `log.info({ headers })` can never leak
 * an API secret or session token (spec §88).
 */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'secret',
  '*.secret',
  'secretKey',
  '*.secretKey',
  'keyId',
  '*.keyId',
  'key',
  '*.key',
  'token',
  '*.token',
  'csrfToken',
  '*.csrfToken',
  'headers["apca-api-key-id"]',
  'headers["apca-api-secret-key"]',
  '*.headers["apca-api-key-id"]',
  '*.headers["apca-api-secret-key"]',
  'headers.cookie',
  'headers.authorization',
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
];

/** Shared logger options (exported so tests can verify redaction on the real config). */
export function loggerOptions(level: string): pino.LoggerOptions {
  return {
    level,
    base: { service: 'scalp-city' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  };
}

export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    ...loggerOptions(level),
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
          },
        }
      : {}),
  });
}

/** Silent logger for tests. */
export function createTestLogger(): Logger {
  return pino({ level: process.env.TEST_LOG_LEVEL ?? 'silent', redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } });
}
