import { describe, expect, it } from 'vitest';
import { hashPassword, safeEqual, verifyPassword } from '../src/auth/AuthService.js';
import { ConfigError, parseConfig, tradingStreamUrl } from '../src/config/env.js';
import { Writable } from 'node:stream';
import pino from 'pino';
import { loggerOptions } from '../src/core/logger.js';
import { canonicalJson, scrub } from '../src/audit/AuditLog.js';
import { evaluateRisk } from '../src/risk/RiskEngine.js';
import { nyTimeToMs } from '../src/broker/alpaca/mappers.js';
import { priceStr } from '../src/broker/alpaca/AlpacaBrokerAdapter.js';
import { roundToTick } from '../src/workers/Worker.js';
import { optionEntry, riskState } from './support/riskFixtures.js';

const base = { NODE_ENV: 'test' as const };

describe('configuration', () => {
  it('defaults to PAPER even when live credentials exist (spec §3)', () => {
    const c = parseConfig({ ...base, ALPACA_LIVE_API_KEY: 'AK', ALPACA_LIVE_API_SECRET: 'S' });
    expect(c.tradingEnvironment).toBe('paper');
    expect(c.liveTradingEnabled).toBe(false);
    expect(c.credentials.live).not.toBeNull();
    expect(c.credentials.paper).toBeNull();
  });

  it('pins the live trading endpoint — it cannot be pointed anywhere else', () => {
    expect(() => parseConfig({ ...base, ALPACA_LIVE_BASE_URL: 'https://evil.example' })).toThrow(ConfigError);
    expect(() => parseConfig({ ...base, ALPACA_LIVE_BASE_URL: 'https://api.alpaca.markets' })).not.toThrow();
  });

  it('flags non-standard paper/data endpoints', () => {
    const c = parseConfig({ ...base, ALPACA_PAPER_BASE_URL: 'http://127.0.0.1:9999' });
    expect(c.nonStandardEndpoints).toEqual(['http://127.0.0.1:9999']);
    expect(tradingStreamUrl(c, 'paper')).toBe('ws://127.0.0.1:9999/stream');
    expect(tradingStreamUrl(c, 'live')).toBe('wss://api.alpaca.markets/stream');
  });

  it('rejects half-configured credentials and bad values', () => {
    expect(() => parseConfig({ ...base, ALPACA_API_KEY: 'only-key' })).toThrow(/both the key and the secret/);
    expect(() => parseConfig({ ...base, MAX_DAILY_LOSS: '-5' })).toThrow(/positive/);
    expect(() => parseConfig({ ...base, LIVE_TRADING_ENABLED: 'maybe' })).toThrow(/true or false/);
    expect(() => parseConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x' })).toThrow(/SESSION_SECRET/);
  });

  it('accepts MAX_POSITION_SIZE from the spec as the position notional limit', () => {
    expect(parseConfig({ ...base, MAX_POSITION_SIZE: '2500' }).riskDefaults.maxPositionNotional).toBe(2500);
  });
});

describe('secrets never leak', () => {
  it('redacts credentials in logs', () => {
    let out = '';
    const sink = new Writable({
      write(chunk, _enc, cb) {
        out += chunk.toString();
        cb();
      },
    });
    const logger = pino(loggerOptions('info'), sink);
    logger.info({ headers: { 'apca-api-key-id': 'PKLIVEKEY123', 'apca-api-secret-key': 'SUPERSECRET' }, password: 'hunter2hunter2', creds: { secretKey: 'S2' } }, 'request');
    expect(out).not.toContain('SUPERSECRET');
    expect(out).not.toContain('PKLIVEKEY123');
    expect(out).not.toContain('hunter2hunter2');
    expect(out).not.toContain('"S2"');
    expect(out).toContain('[REDACTED]');
  });

  it('scrubs secret-looking keys from audit details deterministically', () => {
    expect(scrub({ password: 'x', nested: { secretKey: 'y', ok: 1 } })).toEqual({ password: '[REDACTED]', nested: { secretKey: '[REDACTED]', ok: 1 } });
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});

describe('passwords', () => {
  it('hashes with scrypt and verifies in constant time', async () => {
    const h = await hashPassword('correct-horse-battery');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct-horse-battery', h)).toBe(true);
    expect(await verifyPassword('wrong-password-123', h)).toBe(false);
    await expect(hashPassword('short')).rejects.toThrow(/12 characters/);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
  });
});

describe('wire formats', () => {
  it('converts Alpaca calendar times in New York time (EDT and EST)', () => {
    expect(new Date(nyTimeToMs('2026-10-05', '09:30')).toISOString()).toBe('2026-10-05T13:30:00.000Z');
    expect(new Date(nyTimeToMs('2026-12-24', '13:00')).toISOString()).toBe('2026-12-24T18:00:00.000Z'); // early close, EST
  });

  it('formats prices to valid ticks', () => {
    expect(priceStr(3.6800000001, true)).toBe('3.68');
    expect(priceStr(0.5, true)).toBe('0.50'); // options: pennies even below $1
    expect(priceStr(0.5123, false)).toBe('0.5123');
    expect(roundToTick(1.2342, true, 'up')).toBe(1.24);
    expect(roundToTick(1.2342, true, 'down')).toBe(1.23);
    expect(roundToTick(2.43, true, 'down')).toBe(2.43);
  });
});

describe('risk regression', () => {
  it('values a market order from the live reference price in the risk snapshot', () => {
    const o = optionEntry({ type: 'market', limitPrice: null, referencePrice: null });
    expect(evaluateRisk(o, riskState({ referencePrice: null })).blockedBy?.id).toBe('order_notional');
    expect(evaluateRisk(o, riskState({ referencePrice: 3.68 })).approved).toBe(true);
  });
});
