import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { directionLabel, instrumentName, isOandaSymbol, maskAccountNumber, priceDecimals, quoteCurrency, sizeUnit } from '@scalp-city/shared';
import { configuredSessions, sessionClock, usEarlyCloses, usMarketHolidays } from '../src/broker/oanda/calendar.js';
import { cancelStatus, fillPrice, fillRealized, mapInstrument, mapOrder, num, oandaTime, priceString, priceTradeable, unitsString, withFill } from '../src/broker/oanda/mappers.js';
import { oandaErrorMessage } from '../src/broker/oanda/OandaHttp.js';
import { ConfigError, assertLiveEndpoints, hasCredentials, oandaStreamUrl, parseConfig, tradingBaseUrl } from '../src/config/env.js';
import { floorUnits, roundPrice } from '../src/market/InstrumentCatalog.js';
import { formatMoney, formatPrice, formatQty } from '../src/core/format.js';

const NY = 'America/New_York';
const ny = (iso: string) => DateTime.fromISO(iso, { zone: NY }).toMillis();

describe('OANDA wire formats', () => {
  it('parses nanosecond RFC3339 and UNIX timestamps to milliseconds', () => {
    expect(oandaTime('2026-10-05T15:00:00.123456789Z')).toBe(Date.parse('2026-10-05T15:00:00.123Z'));
    expect(oandaTime('2026-10-05T15:00:00Z')).toBe(Date.parse('2026-10-05T15:00:00Z'));
    expect(oandaTime('2026-10-05T11:00:00.5-04:00')).toBe(Date.parse('2026-10-05T15:00:00.500Z'));
    expect(oandaTime('1791212400.123456789')).toBe(1791212400123);
    expect(oandaTime('')).toBeNull();
    expect(oandaTime(undefined)).toBeNull();
    expect(oandaTime('not a time')).toBeNull();
  });

  it('reads whether a price is tradeable from either field, and only an explicit "no" blocks', () => {
    expect(priceTradeable({ tradeable: true })).toBe(true);
    expect(priceTradeable({ tradeable: false })).toBe(false);
    expect(priceTradeable({ status: 'tradeable' })).toBe(true);
    expect(priceTradeable({ status: 'non-tradeable' })).toBe(false);
    expect(priceTradeable({ status: 'invalid' })).toBe(false);
    expect(priceTradeable({ tradeable: true, status: 'non-tradeable' })).toBe(false);
    expect(priceTradeable({})).toBe(true); // silent price: the broker would still refuse the order on a closed market
  });

  it('parses numeric strings, and an absent value is null — never 0', () => {
    expect(num('2650.125')).toBe(2650.125);
    expect(num('-12')).toBe(-12);
    expect(num(undefined)).toBeNull();
    expect(num('')).toBeNull();
    expect(num('NaN')).toBeNull();
  });

  it('prices a fill from the units it actually opened or closed, volume-weighted', () => {
    const fill = { fullVWAP: '1.2345', tradesClosed: [{ units: '-100', price: '1.2000' }, { units: '-300', price: '1.2100' }], tradeReduced: { units: '-100', price: '1.2200' } };
    // (100×1.20 + 300×1.21 + 100×1.22) / 500 = 1.2100
    expect(fillPrice(fill)).toBeCloseTo(1.21, 10);
    expect(fillPrice({ tradeOpened: { units: '50', price: '2650.5' } })).toBe(2650.5);
    expect(fillPrice({ fullVWAP: '1.5' })).toBe(1.5);
    expect(fillPrice({})).toBeNull();
  });

  it('reports realized P&L net of financing, commission and fees (account currency)', () => {
    expect(fillRealized({ pl: '10.00', financing: '-0.50', commission: '0.25', guaranteedExecutionFee: '0.10' })).toBeCloseTo(9.15, 10);
    expect(fillRealized({ pl: '-4', commission: '-0.2' })).toBeCloseTo(-4.2, 10); // commission is always a cost, whatever its sign
    expect(fillRealized({})).toBe(0);
  });

  it('maps cancel reasons: refusals are rejections, routine cancels are not, expiry is expiry', () => {
    expect(cancelStatus('INSUFFICIENT_MARGIN')).toBe('rejected');
    expect(cancelStatus('MARKET_HALTED')).toBe('rejected');
    expect(cancelStatus('STOP_LOSS_ON_FILL_LOSS')).toBe('rejected');
    expect(cancelStatus('TIME_IN_FORCE_EXPIRED')).toBe('expired');
    expect(cancelStatus('CLIENT_REQUEST')).toBe('canceled');
    expect(cancelStatus('LINKED_TRADE_CLOSED')).toBe('canceled');
    expect(cancelStatus('BOUNDS_VIOLATION')).toBe('canceled');
    expect(cancelStatus(undefined)).toBe('canceled');
  });

  it('turns an order object into a broker-neutral order, with dependent orders taking side and size from their trade', () => {
    const market = mapOrder({ id: '12', createTime: '2026-10-05T15:00:00.000000000Z', state: 'FILLED', type: 'MARKET', instrument: 'XAU_USD', units: '-3', timeInForce: 'FOK', priceBound: '2640.100', positionFill: 'OPEN_ONLY', clientExtensions: { id: 'sc-P-entry-1' }, filledTime: '2026-10-05T15:00:00.100000000Z' }, null);
    expect(market).toMatchObject({ id: '12', clientOrderId: 'sc-P-entry-1', symbol: 'XAU_USD', assetClass: 'cfd', side: 'sell', qty: 3, status: 'filled', filledQty: 3, timeInForce: 'fok', limitPrice: 2640.1, positionIntent: 'sell_to_open', dependent: false });
    const stop = mapOrder({ id: '13', state: 'PENDING', type: 'STOP_LOSS', tradeID: '12', price: '2655.000', timeInForce: 'GTC', clientExtensions: { id: 'sc-P-entry-1.sl' } }, { instrument: 'XAU_USD', units: -3 });
    expect(stop).toMatchObject({ id: '13', clientOrderId: 'sc-P-entry-1.sl', symbol: 'XAU_USD', side: 'buy', qty: 3, stopPrice: 2655, status: 'new', dependent: true, positionIntent: 'buy_to_close' });
    const longStop = mapOrder({ id: '14', state: 'PENDING', type: 'STOP_LOSS', tradeID: '9', price: '2640.000' }, { instrument: 'XAU_USD', units: 2 });
    expect(longStop.side).toBe('sell');
    expect(mapOrder({ id: '15', state: 'CANCELLED', type: 'LIMIT', instrument: 'GBP_USD', units: '1000', price: '1.30000', timeInForce: 'GTC' }, null).status).toBe('canceled');
  });

  it('applies a fill to an order: partial vs complete, with the broker\'s own P&L', () => {
    const base = mapOrder({ id: '20', state: 'PENDING', type: 'MARKET', instrument: 'EUR_JPY', units: '1000', timeInForce: 'FOK' }, null);
    const full = withFill(base, { id: '21', time: '2026-10-05T15:00:01.000000000Z', units: '1000', tradeOpened: { units: '1000', price: '162.015' }, pl: '0', commission: '0.4' });
    expect(full).toMatchObject({ status: 'filled', filledQty: 1000, filledAvgPrice: 162.015 });
    expect(full.realizedPl).toBeCloseTo(-0.4, 10);
    const part = withFill(base, { id: '22', units: '400', tradeOpened: { units: '400', price: '162.01' } });
    expect(part).toMatchObject({ status: 'partially_filled', filledQty: 400 });
  });

  it('formats units and prices exactly as the instrument allows, never with float noise', () => {
    expect(unitsString(3, 'buy', 0)).toBe('3');
    expect(unitsString(3, 'sell', 0)).toBe('-3');
    expect(unitsString(0.2, 'sell', 1)).toBe('-0.2');
    expect(unitsString(0.1 + 0.2, 'buy', 1)).toBe('0.3');
    expect(priceString(2650.1234567, 3)).toBe('2650.123');
    expect(priceString(1.3, 5)).toBe('1.30000');
  });

  it('reads instrument metadata, with sensible unit and price rules', () => {
    const i = mapInstrument({ name: 'NAS100_USD', type: 'CFD', displayName: 'US Nas 100', pipLocation: 0, displayPrecision: 1, tradeUnitsPrecision: 1, minimumTradeSize: '0.1', maximumOrderUnits: '2000', marginRate: '0.05' });
    expect(i).toMatchObject({ symbol: 'NAS100_USD', displayPrecision: 1, unitsPrecision: 1, minUnits: 0.1, maxOrderUnits: 2000, marginRate: 0.05, baseCurrency: 'NAS100', quoteCurrency: 'USD' });
  });

  it('extracts the real reason from OANDA error bodies', () => {
    expect(oandaErrorMessage({ errorCode: 'INSUFFICIENT_MARGIN', errorMessage: 'Insufficient margin' }, 400)).toEqual({ message: 'Insufficient margin', code: 'INSUFFICIENT_MARGIN' });
    expect(oandaErrorMessage({ orderRejectTransaction: { rejectReason: 'UNITS_MINIMUM_NOT_MET' }, errorMessage: 'The units specified do not meet the minimum' }, 400).message).toBe('UNITS_MINIMUM_NOT_MET: The units specified do not meet the minimum');
    expect(oandaErrorMessage(undefined, 503)).toEqual({ message: 'HTTP 503', code: null });
  });
});

describe('OANDA trading calendar', () => {
  it('knows the 2026 US market holidays', () => {
    const h = usMarketHolidays(2026);
    for (const d of ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25']) expect(h.has(d), d).toBe(true);
    expect(h.size).toBe(10);
    expect(h.has('2026-10-12')).toBe(false); // Columbus Day: exchanges are open
  });

  it('observes weekend holidays the way NYSE does (and not a Saturday New Year)', () => {
    expect(usMarketHolidays(2027).has('2027-12-24')).toBe(true); // Christmas on a Saturday → Friday
    expect(usMarketHolidays(2028).has('2027-12-31')).toBe(false);
    expect(usMarketHolidays(2028).has('2028-01-01')).toBe(false);
    expect(usMarketHolidays(2022).has('2022-12-26')).toBe(true); // Christmas on a Sunday → Monday
  });

  it('knows the early closes', () => {
    const e = usEarlyCloses(2026);
    expect(e.has('2026-11-27')).toBe(true); // day after Thanksgiving
    expect(e.has('2026-12-24')).toBe(true); // Christmas Eve (Thursday)
    expect(e.has('2026-07-03')).toBe(false); // that is the holiday itself
    expect(usEarlyCloses(2025).has('2025-07-03')).toBe(true);
  });

  const rules = { open: '09:30', close: '16:00', skipUsHolidays: true };

  it('builds weekday sessions in New York time and skips holidays', () => {
    const days = configuredSessions('2026-11-23', '2026-11-30', rules);
    expect(days.map((d) => d.date)).toEqual(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27', '2026-11-30']);
    const friday = days.find((d) => d.date === '2026-11-27')!;
    expect(friday.openMs).toBe(ny('2026-11-27T09:30'));
    expect(friday.closeMs).toBe(ny('2026-11-27T13:00')); // early close
    expect(days[0]!.closeMs).toBe(ny('2026-11-23T16:00'));
  });

  it('can run on holidays when asked to, and always skips weekends', () => {
    const days = configuredSessions('2026-11-25', '2026-11-30', { ...rules, skipUsHolidays: false });
    expect(days.map((d) => d.date)).toEqual(['2026-11-25', '2026-11-26', '2026-11-27', '2026-11-30']);
    expect(days.find((d) => d.date === '2026-11-27')!.closeMs).toBe(ny('2026-11-27T16:00'));
  });

  it('follows daylight saving: 09:30 New York is 13:30 UTC in summer and 14:30 UTC in winter', () => {
    const [summer] = configuredSessions('2026-07-06', '2026-07-06', rules);
    const [winter] = configuredSessions('2026-12-07', '2026-12-07', rules);
    expect(new Date(summer!.openMs).toISOString()).toBe('2026-07-06T13:30:00.000Z');
    expect(new Date(winter!.openMs).toISOString()).toBe('2026-12-07T14:30:00.000Z');
  });

  it('answers open/closed and the next open and close', () => {
    expect(sessionClock(ny('2026-10-05T11:00'), rules)).toMatchObject({ isOpen: true, nextClose: ny('2026-10-05T16:00'), nextOpen: ny('2026-10-06T09:30') });
    const before = sessionClock(ny('2026-10-05T08:00'), rules);
    expect(before.isOpen).toBe(false);
    expect(before.nextOpen).toBe(ny('2026-10-05T09:30'));
    const friday = sessionClock(ny('2026-10-09T17:00'), rules);
    expect(friday.isOpen).toBe(false);
    expect(friday.nextOpen).toBe(ny('2026-10-12T09:30')); // Monday
    expect(sessionClock(ny('2026-10-10T12:00'), rules).isOpen).toBe(false); // Saturday
  });

  it('the default window runs from midnight to 16:30 New York: nothing is open through the 17:00 rollover or the weekend', () => {
    const wide = { open: '00:00', close: '16:30', skipUsHolidays: false };
    expect(sessionClock(ny('2026-10-06T03:00'), wide)).toMatchObject({ isOpen: true, nextClose: ny('2026-10-06T16:30') }); // 09:00 in Amsterdam
    expect(sessionClock(ny('2026-10-06T16:29'), wide).isOpen).toBe(true);
    const evening = sessionClock(ny('2026-10-06T17:00'), wide); // the daily rollover
    expect(evening.isOpen).toBe(false);
    expect(evening.nextOpen).toBe(ny('2026-10-07T00:00'));
    const fridayClose = sessionClock(ny('2026-10-09T16:45'), wide); // before OANDA's Friday 17:00 close, already shut
    expect(fridayClose.isOpen).toBe(false);
    expect(fridayClose.nextOpen).toBe(ny('2026-10-12T00:00'));
    expect(sessionClock(ny('2026-10-11T20:00'), wide).isOpen).toBe(false); // Sunday evening
    // Holidays are traded when not skipped: Thanksgiving is just another day for FX and gold.
    expect(configuredSessions('2026-11-26', '2026-11-26', wide).map((d) => d.date)).toEqual(['2026-11-26']);
  });

  it('honors a different window (e.g. the London session)', () => {
    const london = { open: '03:00', close: '11:30', skipUsHolidays: true };
    expect(sessionClock(ny('2026-10-05T04:00'), london).isOpen).toBe(true);
    expect(sessionClock(ny('2026-10-05T12:00'), london).isOpen).toBe(false);
  });
});

describe('OANDA configuration', () => {
  const base = { NODE_ENV: 'test', BROKER: 'oanda', SESSION_SECRET: 'x'.repeat(40) };
  const creds = { OANDA_PRACTICE_TOKEN: 'abcdef0123456789-abcdef0123456789', OANDA_PRACTICE_ACCOUNT_ID: '101-004-12345678-001' };

  it('defaults to the five markets, the NY session, PAPER, and OANDA-specific limits', () => {
    const c = parseConfig({ ...base, ...creds });
    expect(c.venue).toBe('oanda');
    expect(c.tradingEnvironment).toBe('paper');
    expect(c.symbols).toEqual(['XAU_USD', 'NAS100_USD', 'GBP_USD', 'EUR_JPY', 'US30_USD']);
    // Most of the day, ending before OANDA's 17:00 New York rollover and weekly close; holidays are not skipped.
    expect(c.oanda.session).toEqual({ open: '00:00', close: '16:30' });
    expect(c.oanda.skipUsHolidays).toBe(false);
    expect(hasCredentials(c, 'paper')).toBe(true);
    expect(hasCredentials(c, 'live')).toBe(false);
    expect(tradingBaseUrl(c, 'paper')).toBe('https://api-fxpractice.oanda.com');
    expect(oandaStreamUrl(c, 'paper')).toBe('https://stream-fxpractice.oanda.com');
    expect(tradingBaseUrl(c, 'live')).toBe('https://api-fxtrade.oanda.com');
    expect(c.riskDefaults).toMatchObject({ maxDailyLoss: 100, maxRiskPerTrade: 20, maxPositionNotional: 10_000, maxOrderNotional: 10_000, maxConcurrentPositions: 3, pdtGuard: false });
    expect(c.nonStandardEndpoints).toEqual([]);
  });

  it('ignores the Alpaca-style dollar limits for OANDA, so a leftover MAX_POSITION_SIZE=300 cannot block every order', () => {
    const c = parseConfig({ ...base, ...creds, MAX_POSITION_SIZE: '300', MAX_ORDER_NOTIONAL: '300', MAX_DAILY_LOSS: '7', MAX_CONCURRENT_POSITIONS: '1' });
    expect(c.riskDefaults.maxPositionNotional).toBe(10_000);
    expect(c.riskDefaults.maxOrderNotional).toBe(10_000);
    expect(c.riskDefaults.maxDailyLoss).toBe(100);
    expect(c.riskDefaults.maxConcurrentPositions).toBe(3);
    const o = parseConfig({ ...base, ...creds, OANDA_MAX_POSITION_NOTIONAL: '2500', OANDA_MAX_DAILY_LOSS: '40', OANDA_MAX_RISK_PER_TRADE: '5', OANDA_MAX_CONCURRENT_POSITIONS: '1' });
    expect(o.riskDefaults).toMatchObject({ maxPositionNotional: 2500, maxOrderNotional: 2500, maxDailyLoss: 40, maxRiskPerTrade: 5, maxConcurrentPositions: 1 });
  });

  it('keeps Alpaca as the default broker, with its own limits and symbols', () => {
    const c = parseConfig({ NODE_ENV: 'test', ALPACA_PAPER_API_KEY: 'k', ALPACA_PAPER_API_SECRET: 's', MAX_POSITION_SIZE: '300' });
    expect(c.venue).toBe('alpaca');
    expect(c.alpacaWorkerSet).toBe('scalp');
    expect(c.symbols).toEqual(['GLD', 'QQQ', 'DIA', 'FXB', 'FXE']);
    const classic = parseConfig({ NODE_ENV: 'test', ALPACA_PAPER_API_KEY: 'k', ALPACA_PAPER_API_SECRET: 's', ALPACA_WORKER_SET: 'options' });
    expect(classic.symbols).toEqual(['QQQ', 'SPY', 'IWM']);
    expect(c.riskDefaults.maxPositionNotional).toBe(300);
    expect(c.riskDefaults.pdtGuard).toBe(true);
  });

  it('rejects a token without an account id, a malformed account id, and a token with whitespace', () => {
    expect(() => parseConfig({ ...base, OANDA_PRACTICE_TOKEN: 'abc' })).toThrow(ConfigError);
    expect(() => parseConfig({ ...base, OANDA_PRACTICE_TOKEN: 'abc', OANDA_PRACTICE_ACCOUNT_ID: '12345678' })).toThrow(/101-004-12345678-001/);
    expect(() => parseConfig({ ...base, OANDA_PRACTICE_TOKEN: 'abc def', OANDA_PRACTICE_ACCOUNT_ID: '101-004-12345678-001' })).toThrow(/whitespace/);
    expect(() => parseConfig({ ...base, OANDA_PRACTICE_ACCOUNT_ID: '101-004-12345678-001' })).toThrow(/both/);
  });

  it('pins the LIVE endpoints: they cannot be overridden', () => {
    expect(() => parseConfig({ ...base, ...creds, OANDA_LIVE_API_URL: 'https://evil.example.com' })).toThrow(/cannot be overridden/);
    expect(() => parseConfig({ ...base, ...creds, OANDA_LIVE_STREAM_URL: 'https://evil.example.com' })).toThrow(/cannot be overridden/);
    const ok = parseConfig({ ...base, ...creds, OANDA_LIVE_API_URL: 'https://api-fxtrade.oanda.com/', OANDA_LIVE_TOKEN: 'livetoken0123456789', OANDA_LIVE_ACCOUNT_ID: '001-004-1234567-001' });
    expect(() => assertLiveEndpoints(ok)).not.toThrow();
    // Practice may be pointed elsewhere (tests, a proxy) and is then flagged as non-standard.
    const odd = parseConfig({ ...base, ...creds, OANDA_PRACTICE_API_URL: 'http://127.0.0.1:9999' });
    expect(odd.nonStandardEndpoints).toEqual(['http://127.0.0.1:9999']);
  });

  it('validates the session window and the instrument list', () => {
    expect(parseConfig({ ...base, ...creds, OANDA_SESSION: '3:00-11:30' }).oanda.session).toEqual({ open: '03:00', close: '11:30' });
    for (const bad of ['16:00-09:30', '09:30-09:45', '9-17', '25:00-26:00', 'always']) expect(() => parseConfig({ ...base, ...creds, OANDA_SESSION: bad }), bad).toThrow(/OANDA_SESSION/);
    expect(parseConfig({ ...base, ...creds, OANDA_INSTRUMENTS: 'xau_usd, eur_usd' }).symbols).toEqual(['XAU_USD', 'EUR_USD']);
    expect(() => parseConfig({ ...base, ...creds, OANDA_INSTRUMENTS: 'XAUUSD' })).toThrow(/OANDA_INSTRUMENTS/);
    expect(() => parseConfig({ ...base, ...creds, OANDA_INSTRUMENTS: 'XAU_USD,XAU_USD' })).toThrow(/twice/);
  });
});

describe('instrument helpers', () => {
  it('names the five markets for people', () => {
    expect(instrumentName('XAU_USD')).toBe('GOLD');
    expect(instrumentName('NAS100_USD')).toBe('NAS100');
    expect(instrumentName('US30_USD')).toBe('US30');
    expect(instrumentName('GBP_USD')).toBe('GBP/USD');
    expect(instrumentName('EUR_JPY')).toBe('EUR/JPY');
    expect(instrumentName('QQQ')).toBe('QQQ');
    expect(isOandaSymbol('XAU_USD')).toBe(true);
    expect(isOandaSymbol('QQQ')).toBe(false);
    expect(isOandaSymbol('QQQ261005C00600000')).toBe(false);
    expect(quoteCurrency('EUR_JPY')).toBe('JPY');
  });

  it('labels a direction by what is traded: CALL/PUT for options, LONG/SHORT for everything else', () => {
    expect(directionLabel('CALL', 'us_option')).toBe('CALL');
    expect(directionLabel('PUT', 'us_option')).toBe('PUT');
    expect(directionLabel('CALL', 'cfd')).toBe('LONG');
    expect(directionLabel('PUT', 'cfd')).toBe('SHORT');
    expect(directionLabel('PUT', 'us_equity')).toBe('SHORT');
    expect(directionLabel('NEUTRAL', 'cfd')).toBe('NEUTRAL');
    expect(sizeUnit('cfd', 3)).toBe('units');
    expect(sizeUnit('cfd', 1)).toBe('unit');
    expect(sizeUnit('us_option', 2)).toBe('contracts');
  });

  it('shows the decimals each market is quoted with', () => {
    expect(priceDecimals('GBP_USD')).toBe(5);
    expect(priceDecimals('EUR_JPY')).toBe(3);
    expect(priceDecimals('XAU_USD')).toBe(3);
    expect(priceDecimals('NAS100_USD')).toBe(1);
    expect(priceDecimals('QQQ')).toBe(2);
  });

  it('masks OANDA account numbers without revealing them', () => {
    expect(maskAccountNumber('101-004-12345678-001')).toBe('••••5678-001');
    expect(maskAccountNumber('001-011-1234567-002')).toBe('••••4567-002');
    expect(maskAccountNumber('PA1234564821')).toBe('••••4821');
    expect(maskAccountNumber(null)).toBeNull();
  });

  it('rounds size DOWN to the unit step and prices in the requested direction', () => {
    expect(floorUnits(3.9, 0)).toBe(3);
    expect(floorUnits(0.29, 1)).toBe(0.2);
    expect(floorUnits(0.3, 1)).toBe(0.3); // float noise must not lose a step
    expect(floorUnits(0.1 + 0.2, 1)).toBe(0.3);
    expect(floorUnits(0.04, 1)).toBe(0);
    expect(roundPrice(2650.1236, 3, 'up')).toBe(2650.124);
    expect(roundPrice(2650.1236, 3, 'down')).toBe(2650.123);
    expect(roundPrice(2650.1236, 3, 'nearest')).toBe(2650.124);
    expect(roundPrice(1.3, 5, 'up')).toBe(1.3); // already on the grid: no extra step
    expect(roundPrice(1.3, 5, 'down')).toBe(1.3);
  });

  it('formats money in the account currency, never a hard-coded dollar', () => {
    expect(formatMoney(12.3, 'USD')).toBe('$12.30');
    expect(formatMoney(-4.1, 'GBP')).toBe('−£4.10');
    expect(formatMoney(3, 'EUR', { sign: true })).toBe('+€3.00');
    expect(formatMoney(5, null)).toBe('$5.00');
    expect(formatMoney(5, 'ZZZ')).toContain('5.00');
    expect(formatQty(0.30000000000000004)).toBe('0.3');
    expect(formatQty(1250)).toBe('1,250');
    expect(formatPrice(1.3, 'GBP_USD')).toBe('1.30000');
    expect(formatPrice(2650.1, 'XAU_USD')).toBe('2650.100');
  });
});
