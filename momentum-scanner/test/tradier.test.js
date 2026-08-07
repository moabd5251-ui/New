import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toArray,
  parseQuotes,
  parseTimesales,
  parseClock,
  normalizeQuote,
  relativeVolume5Min,
  easternParts,
  tradierTimestamp,
  baseUrl,
  getQuotes,
} from '../lib/providers/tradier.js';
import { detectPatterns } from '../lib/patterns.js';
import { evaluate } from '../lib/criteria.js';

const OPEN_SESSION = { fraction: 0.5, live: true, state: 'open' };
const CLOSED_SESSION = { fraction: 1, live: false, state: 'closed' };

/* ------------------------------------------------------------------ */
/* the single-vs-array trap                                            */
/* ------------------------------------------------------------------ */

test('a single-symbol response is not collapsed into zero results', () => {
  // Tradier returns a bare object for one match and an array for many. Treating
  // the object as a list is how a one-symbol watchlist silently scans nothing.
  const single = parseQuotes({ quotes: { quote: { symbol: 'ABCD', last: 5 } } });
  assert.equal(single.quotes.length, 1);
  assert.equal(single.quotes[0].symbol, 'ABCD');

  const many = parseQuotes({
    quotes: { quote: [{ symbol: 'ABCD' }, { symbol: 'EFGH' }] },
  });
  assert.equal(many.quotes.length, 2);
});

test('toArray normalizes every list shape the API returns', () => {
  assert.deepEqual(toArray(null), []);
  assert.deepEqual(toArray(undefined), []);
  assert.deepEqual(toArray({ a: 1 }), [{ a: 1 }]);
  assert.deepEqual(toArray([1, 2]), [1, 2]);
});

test('unmatched symbols are reported, not silently dropped', () => {
  const parsed = parseQuotes({
    quotes: {
      quote: { symbol: 'REAL', last: 3 },
      unmatched_symbols: { symbol: 'NOPE' },
    },
  });
  assert.equal(parsed.quotes.length, 1);
  assert.deepEqual(parsed.unmatched, ['NOPE']);
});

test('an empty quote payload yields empty lists rather than throwing', () => {
  for (const payload of [{}, { quotes: {} }, { quotes: { quote: null } }, null]) {
    const parsed = parseQuotes(payload);
    assert.deepEqual(parsed.quotes, []);
    assert.deepEqual(parsed.unmatched, []);
  }
});

/* ------------------------------------------------------------------ */
/* quote normalization                                                 */
/* ------------------------------------------------------------------ */

test('a Tradier quote maps onto the scanner shape', () => {
  const quote = normalizeQuote(
    {
      symbol: 'RUNR',
      description: 'Runner Industries',
      last: 8.4,
      prevclose: 4.0,
      open: 5.2,
      volume: 12_000_000,
      average_volume: 400_000,
      change_percentage: 110.0,
      bid: 8.39,
      ask: 8.41,
      exch: 'Q',
    },
    CLOSED_SESSION,
  );

  assert.equal(quote.symbol, 'RUNR');
  assert.equal(quote.name, 'Runner Industries');
  assert.equal(quote.price, 8.4);
  assert.equal(quote.changeFromClosePct, 110);
  assert.equal(quote.gapPct, 30); // 5.20 open against a 4.00 close
  assert.equal(quote.relativeVolume, 30); // 12M against a 400k average day
});

test("Tradier's own change_percentage is preferred over recomputing it", () => {
  // A split-adjusted feed reports 25% even when raw prices imply something else;
  // recomputing from last/prevclose would silently disagree.
  const quote = normalizeQuote(
    { symbol: 'SPLT', last: 10, prevclose: 4, change_percentage: 25 },
    CLOSED_SESSION,
  );
  assert.equal(quote.changeFromClosePct, 25);
});

test('change is derived when the feed omits the percentage', () => {
  const quote = normalizeQuote({ symbol: 'X', last: 12, prevclose: 10 }, CLOSED_SESSION);
  assert.equal(quote.changeFromClosePct, 20);
});

test('relative volume is pro-rated only while the session is running', () => {
  const raw = { symbol: 'X', last: 5, prevclose: 5, volume: 500_000, average_volume: 1_000_000 };
  // Half a normal day's volume, half way through the session, is 1x.
  assert.equal(normalizeQuote(raw, OPEN_SESSION).relativeVolume, 1);
  // The same volume after the close is a completed day: 0.5x.
  assert.equal(normalizeQuote(raw, CLOSED_SESSION).relativeVolume, 0.5);
});

test('extended-hours volume is flagged, with the % of an average day traded', () => {
  // AAPL-shaped: 84,655 shares traded premarket against a 57.3M average day.
  const premarket = normalizeQuote(
    { symbol: 'AAPL', last: 312.41, prevclose: 312.41, volume: 84_655, average_volume: 57_289_903 },
    { fraction: 1, live: false, state: 'premarket' },
  );
  assert.equal(premarket.extendedHours, true);
  assert.equal(premarket.marketState, 'premarket');
  // The ratio must not round away to a flat zero — it is small, not absent.
  assert.ok(premarket.relativeVolume > 0, 'relative volume rounded away to zero');
  assert.equal(premarket.volumePctOfAvgDay, 0.15);

  // During the session it is an ordinary reading, not an extended-hours one.
  const open = normalizeQuote(
    { symbol: 'AAPL', last: 312, prevclose: 300, volume: 30_000_000, average_volume: 57_289_903 },
    { fraction: 0.5, live: true, state: 'open' },
  );
  assert.equal(open.extendedHours, false);
});

test('missing fields become null rather than a misleading zero', () => {
  const quote = normalizeQuote({ symbol: 'THIN' }, CLOSED_SESSION);
  assert.equal(quote.price, null);
  assert.equal(quote.relativeVolume, null);
  assert.equal(quote.changeFromClosePct, null);
  assert.equal(quote.gapPct, null);

  // And those nulls must reach the pillars as "unavailable", not as failures.
  const result = evaluate({ ...quote, float: null, newsAvailable: false }, {}, Date.now());
  assert.equal(result.qualified, false);
  assert.ok(result.pillars.filter((p) => p.unavailable).length >= 4);
});

test('empty strings from the feed are treated as missing', () => {
  const quote = normalizeQuote({ symbol: 'E', last: '', prevclose: '', volume: '' }, CLOSED_SESSION);
  assert.equal(quote.price, null);
  assert.equal(quote.volume, null);
});

/* ------------------------------------------------------------------ */
/* timesales                                                           */
/* ------------------------------------------------------------------ */

test('timesales bars parse into candles the detectors can read', () => {
  const candles = parseTimesales({
    series: {
      data: [
        { time: '2026-08-05T09:30:00', open: 10, high: 10.2, low: 9.9, close: 10.15, volume: 5000, vwap: 10.05 },
        { time: '2026-08-05T09:31:00', open: 10.15, high: 10.5, low: 10.1, close: 10.45, volume: 8000, vwap: 10.3 },
      ],
    },
  });
  assert.equal(candles.length, 2);
  assert.equal(candles[0].open, 10);
  assert.equal(candles[1].volume, 8000);
  assert.equal(candles[1].vwap, 10.3);
});

test('a single timesales bar is not collapsed away', () => {
  const candles = parseTimesales({
    series: { data: { time: 't', open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 } },
  });
  assert.equal(candles.length, 1);
});

test('bars with missing prices are dropped, not passed through as nulls', () => {
  const candles = parseTimesales({
    series: {
      data: [
        { time: 'a', open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
        { time: 'b', open: null, high: 2, low: 0.5, close: 1.5, volume: 10 },
        { time: 'c', open: 1, high: 2, low: 0.5, close: null, volume: 10 },
      ],
    },
  });
  assert.equal(candles.length, 1);
  assert.equal(candles[0].time, 'a');
});

test('an empty or absent series yields no candles', () => {
  for (const payload of [{ series: null }, {}, null, { series: { data: [] } }]) {
    assert.deepEqual(parseTimesales(payload), []);
  }
});

test('parsed timesales flow into pattern detection', () => {
  // A rising leg then a shallow pullback, in Tradier's payload shape.
  const bars = [
    [10.0, 10.15, 9.98, 10.12, 5000],
    [10.12, 10.4, 10.1, 10.38, 8000],
    [10.38, 10.7, 10.35, 10.66, 9000],
    [10.66, 10.95, 10.62, 10.92, 9500],
    [10.92, 11.2, 10.9, 11.18, 10000],
    [11.18, 11.19, 10.95, 11.0, 3000],
    [11.0, 11.05, 10.88, 10.94, 2500],
    [10.94, 11.02, 10.9, 10.98, 2200],
  ].map(([open, high, low, close, volume], i) => ({
    time: `2026-08-05T09:${String(30 + i).padStart(2, '0')}:00`,
    open, high, low, close, volume,
  }));

  const candles = parseTimesales({ series: { data: bars } });
  const flag = detectPatterns(candles).find((s) => s.type === 'bull_flag');
  assert.ok(flag, 'expected a bull flag from Tradier bars');
  assert.equal(flag.entry, 11.2);
  assert.equal(flag.stop, 10.88);
});

/* ------------------------------------------------------------------ */
/* 5-minute relative volume                                            */
/* ------------------------------------------------------------------ */

test('5-minute relative volume measures against the normal per-minute pace', () => {
  // Normal pace: 390,000 / 390 = 1,000 shares a minute, so 5,000 over 5 minutes.
  // Trading 50,000 in those 5 minutes is 10x normal = 1000%.
  const candles = Array.from({ length: 5 }, () => ({ volume: 10_000 }));
  assert.equal(relativeVolume5Min(candles, 390_000), 1000);
});

test('5-minute relative volume is null when the inputs are missing', () => {
  assert.equal(relativeVolume5Min([], 390_000), null);
  assert.equal(relativeVolume5Min([{ volume: 100 }], null), null);
  assert.equal(relativeVolume5Min([{ volume: 0 }], 390_000), null);
  assert.equal(relativeVolume5Min(null, 390_000), null);
});

/* ------------------------------------------------------------------ */
/* clock                                                               */
/* ------------------------------------------------------------------ */

test("the clock's state decides whether volume is pro-rated", () => {
  const openClock = parseClock(
    { clock: { state: 'open', description: 'Market is open' } },
    new Date('2026-08-05T17:00:00Z'), // 13:00 ET
  );
  assert.equal(openClock.live, true);
  assert.ok(openClock.fraction > 0 && openClock.fraction < 1);
  assert.equal(openClock.label, 'Market is open');

  // A holiday reads as closed even at 13:00 ET — the reason to use the clock at
  // all, since the calendar cannot be derived from the time of day.
  const holiday = parseClock(
    { clock: { state: 'closed', description: 'Market is closed for Independence Day' } },
    new Date('2026-08-05T17:00:00Z'),
  );
  assert.equal(holiday.live, false);
  assert.equal(holiday.fraction, 1);
  assert.match(holiday.label, /Independence Day/);
});

test('premarket and postmarket are not treated as an open session', () => {
  for (const state of ['premarket', 'postmarket', 'closed']) {
    const clock = parseClock({ clock: { state } }, new Date('2026-08-05T12:00:00Z'));
    assert.equal(clock.live, false, state);
    assert.equal(clock.fraction, 1, state);
  }
});

test('a missing clock payload still produces a usable session', () => {
  const clock = parseClock({}, new Date('2026-08-05T17:00:00Z'));
  assert.ok(Number.isFinite(clock.fraction) && clock.fraction > 0);
  assert.equal(clock.live, false);
  assert.ok(clock.label.length > 0);
});

/* ------------------------------------------------------------------ */
/* request construction                                                */
/* ------------------------------------------------------------------ */

test('timestamps are formatted in Eastern time, as the API requires', () => {
  // 17:00 UTC is 13:00 in New York during daylight saving.
  const stamp = tradierTimestamp(new Date('2026-08-05T17:00:00Z'));
  assert.equal(stamp, '2026-08-05 13:00');

  // The session start override is what the timesales window uses.
  assert.equal(
    tradierTimestamp(new Date('2026-08-05T17:00:00Z'), { hour: '09', minute: '30' }),
    '2026-08-05 09:30',
  );
});

test('an evening UTC time maps back to the correct Eastern date', () => {
  // 01:00 UTC on the 6th is still 21:00 on the 5th in New York.
  const parts = easternParts(new Date('2026-08-06T01:00:00Z'));
  assert.equal(parts.day, '05');
  assert.equal(parts.hour, '21');
});

test('sandbox and production hosts are distinct', () => {
  assert.match(baseUrl({ sandbox: true }), /sandbox\.tradier\.com/);
  assert.match(baseUrl({ sandbox: false }), /api\.tradier\.com/);
  assert.match(baseUrl(), /api\.tradier\.com/);
});

test('a missing token fails loudly instead of scanning an empty market', async () => {
  await assert.rejects(
    () => getQuotes({ symbols: ['AAPL'], token: '' }),
    /TRADIER_TOKEN/,
  );
});
