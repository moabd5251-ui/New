import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resample,
  toDaily,
  mergeDaily,
  buildStack,
  minutesFromOpen,
  INTERVAL_MINUTES,
} from '../lib/timeframes.js';
import {
  analyzeStack,
  analyzeLadder,
  trendOf,
  swingPoints,
  ema,
  atr,
  LADDERS,
  DEFAULT_TREND_CONFIG,
} from '../lib/trend.js';
import { buildLadder, detectInterval } from '../lib/timeframes.js';
import { buildTradePlan } from '../lib/trade-plan.js';
import { parseHistory } from '../lib/providers/tradier.js';
import { parseChartBars } from '../lib/providers/live.js';
import { getHistory, sessionOpens, regimeFor, symbols } from '../lib/providers/mock.js';

/* ------------------------------------------------------------------ */
/* builders                                                            */
/* ------------------------------------------------------------------ */

/**
 * Bars from a list of closes, with symmetric wicks.
 *
 * Deliberately simple: every structural rule under test reads highs, lows and
 * closes, so a bar is fully described by its close plus a wick. Building them
 * from opens and closes instead introduces ties at every reversal — the peak
 * bar and the bar after it share a high — and a tie is not a confirmed pivot,
 * so the fixtures would stop testing the thing they were written for.
 */
function barsFrom(closes, { start = Date.parse('2026-07-06T13:30:00Z'), stepMinutes = 5, wick = 0.05 } = {}) {
  return closes.map((close, i) => ({
    time: new Date(start + i * stepMinutes * 60_000).toISOString(),
    open: close,
    high: close + wick,
    low: close - wick,
    close,
    volume: 1000,
  }));
}

/**
 * A trending zigzag: each cycle drives `impulsePct` and gives `giveBack` of it
 * back, so higher highs and higher lows accumulate. `giveBack: 1` produces a
 * market that swings without trending.
 */
function zigzag({ from = 100, cycles = 5, impulsePct = 4, giveBack = 0.5, upBars = 4, downBars = 3, sign = 1 } = {}) {
  const closes = [from];
  for (let c = 0; c < cycles; c += 1) {
    const base = closes.at(-1);
    const peak = base * (1 + (sign * impulsePct) / 100);
    for (let i = 1; i <= upBars; i += 1) closes.push(base + ((peak - base) * i) / upBars);
    const trough = peak - (peak - base) * giveBack;
    for (let i = 1; i <= downBars; i += 1) closes.push(peak + ((trough - peak) * i) / downBars);
  }
  return closes;
}

/** A clean uptrend on some timeframe, long enough for the moving averages. */
const upTrendCloses = () => zigzag({ from: 80, cycles: 7, impulsePct: 5, giveBack: 0.45 });
const downTrendCloses = () => zigzag({ from: 200, cycles: 7, impulsePct: 5, giveBack: 0.45, sign: -1 });
const chopCloses = () => zigzag({ from: 100, cycles: 7, impulsePct: 4, giveBack: 1 });

/**
 * A fast-timeframe series that ends in a controlled pullback: an uptrend, a
 * final leg up to `extreme`, then `pullbackBars` bars retracing `retracePct`
 * of that leg.
 */
function seriesWithPullback({
  base = 100,
  legPct = 3,
  retracePct = 40,
  pullbackBars = 3,
  cycles = 5,
  sign = 1,
} = {}) {
  const closes = zigzag({ from: base, cycles, impulsePct: 3, giveBack: 0.45, sign });
  const origin = closes.at(-1);
  const extreme = origin * (1 + (sign * legPct) / 100);

  const legBars = 6;
  for (let i = 1; i <= legBars; i += 1) closes.push(origin + ((extreme - origin) * i) / legBars);

  const end = extreme - sign * Math.abs(extreme - origin) * (retracePct / 100);
  for (let i = 1; i <= pullbackBars; i += 1) closes.push(extreme + ((end - extreme) * i) / pullbackBars);

  return closes;
}

/* ------------------------------------------------------------------ */
/* timeframes.js                                                       */
/* ------------------------------------------------------------------ */

test('hourly buckets are anchored to the 09:30 bell, not the wall clock', () => {
  // 09:30 to 11:29 ET, one bar a minute. Anchored at the bell this is exactly
  // two hourly bars; anchored to the clock it would be three, the first of
  // them a half-hour bar wearing an hourly label.
  const open = Date.parse('2026-07-06T13:30:00Z');
  const minutes = Array.from({ length: 120 }, (_, i) => 100 + i);
  const bars = barsFrom(minutes, { start: open, stepMinutes: 1 });

  const hourly = resample(bars, INTERVAL_MINUTES['1h'], { now: open + 120 * 60_000 });
  assert.equal(hourly.length, 2);
  assert.equal(hourly[0].open, 100);
  assert.equal(hourly[0].close, 159);
  assert.equal(hourly[0].sourceBars, 60);
  assert.equal(hourly[1].open, 160);
  assert.equal(hourly[1].close, 219);
});

test('resampling takes the extremes and sums volume across the bucket', () => {
  const open = Date.parse('2026-07-06T13:30:00Z');
  const bars = barsFrom([10, 12, 9, 11, 13], { start: open, stepMinutes: 1 });
  const [bar] = resample(bars, 5, { now: open + 5 * 60_000 });

  assert.equal(bar.open, 10);
  assert.equal(bar.close, 13);
  assert.equal(bar.high, 13.05); // 13 plus its wick
  assert.equal(bar.low, 8.95); // 9 minus its wick
  assert.equal(bar.volume, 5000);
  assert.equal(bar.partial, false);
});

test('a bucket still filling is flagged partial', () => {
  const open = Date.parse('2026-07-06T13:30:00Z');
  const bars = barsFrom([10, 11], { start: open, stepMinutes: 1 });
  // Two minutes into a five-minute bucket.
  const [bar] = resample(bars, 5, { now: open + 2 * 60_000 });
  assert.equal(bar.partial, true);
});

test('out-of-order bars are sorted before bucketing', () => {
  const open = Date.parse('2026-07-06T13:30:00Z');
  const ordered = barsFrom([10, 11, 12, 13, 14], { start: open, stepMinutes: 1 });
  const shuffled = [ordered[3], ordered[0], ordered[4], ordered[1], ordered[2]];

  const [bar] = resample(shuffled, 5, { now: open + 5 * 60_000 });
  assert.equal(bar.open, 10, 'open must come from the earliest bar, not the first in the array');
  assert.equal(bar.close, 14);
});

test('a session spanning midnight UTC stays in one Eastern trading day', () => {
  // 15:00-16:00 ET on 6 July is 19:00-20:00 UTC — same UTC day. The 20:00 ET
  // case is the one that breaks naive UTC bucketing, so use a late bar too.
  const bars = [
    ...barsFrom([10, 11], { start: Date.parse('2026-07-06T19:00:00Z'), stepMinutes: 30 }),
    ...barsFrom([12, 13], { start: Date.parse('2026-07-07T00:30:00Z'), stepMinutes: 30 }),
  ];
  const daily = toDaily(bars);
  assert.equal(daily.length, 1, 'both blocks are the same ET session');
  assert.equal(daily[0].session, '2026-07-06');
});

test("mergeDaily replaces the provider's copy of today with the live intraday bar", () => {
  const now = Date.parse('2026-07-06T17:00:00Z');
  const daily = [
    { time: '2026-07-02T12:00:00Z', open: 9, high: 10, low: 8, close: 9.5, volume: 1 },
    // A stale bar for today: the provider had it at the open.
    { time: '2026-07-06T12:00:00Z', open: 9.5, high: 9.6, low: 9.4, close: 9.5, volume: 1 },
  ];
  const intraday = barsFrom([10, 12, 11], { start: Date.parse('2026-07-06T13:30:00Z'), stepMinutes: 60 });

  const merged = mergeDaily(daily, intraday, { now });
  assert.equal(merged.length, 2);
  assert.equal(merged.at(-1).close, 11, "today's bar comes from the intraday series");
  assert.equal(merged.at(-1).high, 12.05);
  assert.equal(merged.at(-1).partial, true);
});

test('buildStack derives the hourly series from the same bars as the 5-minute one', () => {
  const open = Date.parse('2026-07-06T13:30:00Z');
  const intraday = barsFrom(Array.from({ length: 78 }, (_, i) => 100 + i), { start: open, stepMinutes: 5 });
  const stack = buildStack({ intraday, daily: [], now: open + 78 * 5 * 60_000 });

  assert.equal(stack.fiveMin.length, 78);
  assert.equal(stack.hourly.length, 7); // six full hours plus the 15:30-16:00 stub
  assert.equal(stack.daily.length, 1);
  assert.equal(stack.hourly[0].close, stack.fiveMin[11].close, 'the first hourly bar closes with the twelfth 5-minute bar');
});

test('minutesFromOpen is signed so premarket bars stay distinguishable', () => {
  assert.equal(minutesFromOpen('2026-07-06T13:30:00Z'), 0);
  assert.equal(minutesFromOpen('2026-07-06T14:30:00Z'), 60);
  assert.equal(minutesFromOpen('2026-07-06T12:30:00Z'), -60);
});

/* ------------------------------------------------------------------ */
/* structure and indicators                                            */
/* ------------------------------------------------------------------ */

test('a swing point needs bars on both sides to confirm it', () => {
  const bars = barsFrom([10, 11, 14, 11, 10, 9, 12, 15]);
  const { highs } = swingPoints(bars, 2);

  assert.equal(highs.length, 1);
  assert.equal(highs[0].index, 2, 'the 14 is the only confirmed pivot high');
  // The closing 15 is higher still, but nothing has printed to its right yet.
  assert.ok(!highs.some((h) => h.index >= bars.length - 2));
});

test('ema seeds on the simple average and atr measures true range', () => {
  assert.deepEqual(ema([1, 2, 3], 3), [2]);
  assert.equal(ema([1, 2], 3).length, 0, 'too few values yields no series');

  const flat = barsFrom([10, 10.5, 11], { wick: 0.25 });
  assert.ok(atr(flat, 14) > 0);
  assert.equal(atr([], 14), null);
});

test('an uptrend is higher highs AND higher lows, not one of the two', () => {
  const up = trendOf(barsFrom(upTrendCloses()));
  assert.equal(up.direction, 'up');
  assert.ok(up.strength > 0.5);
  assert.ok(Number.isFinite(up.invalidation));

  const down = trendOf(barsFrom(downTrendCloses()));
  assert.equal(down.direction, 'down');

  const chop = trendOf(barsFrom(chopCloses()));
  assert.equal(chop.direction, 'none', 'swings that go nowhere are not a trend');
  assert.equal(chop.invalidation, null);
});

test('a timeframe with too few bars is unreadable, not trendless', () => {
  const thin = trendOf(barsFrom([10, 11, 12, 13, 14]));
  assert.equal(thin.usable, false);
  assert.equal(thin.direction, 'none');
  assert.match(thin.detail, /needs \d+ to read structure/);
});

test('the invalidation level is the last confirmed swing against the trend', () => {
  const bars = barsFrom(upTrendCloses());
  const read = trendOf(bars);
  const { lows } = swingPoints(bars, DEFAULT_TREND_CONFIG.swingSpan);
  assert.equal(read.invalidation, lows.at(-1).price);
});

/* ------------------------------------------------------------------ */
/* the strategy                                                        */
/* ------------------------------------------------------------------ */

/**
 * A stack whose three timeframes are priced consistently with each other.
 *
 * This matters more than it looks. The strategy compares a level read off the
 * hourly chart with prices read off the 5-minute chart, so fixtures built
 * independently at unrelated price levels will produce verdicts driven by that
 * accident rather than by the structure under test — a 5-minute series priced
 * above the hourly's lower high reads as "invalidated" no matter what shape it
 * has. So the fast series is anchored just beyond the hourly invalidation, in
 * the direction of the trend, exactly as a real one would be.
 */
function consistentStack(direction, fastOptions = {}) {
  const up = direction === 'up';
  const higher = up ? upTrendCloses() : downTrendCloses();
  const hourly = barsFrom(higher);
  const invalidation = trendOf(hourly).invalidation;
  const base = invalidation * (up ? 1.005 : 0.995);

  return {
    daily: barsFrom(higher),
    hourly,
    fiveMin: barsFrom(seriesWithPullback({ base, sign: up ? 1 : -1, ...fastOptions })),
    invalidation,
  };
}

/** The same, but with the fast series supplied directly. */
function stackAround(direction, fastCloses) {
  const higher = direction === 'up' ? upTrendCloses() : downTrendCloses();
  return { daily: barsFrom(higher), hourly: barsFrom(higher), fiveMin: barsFrom(fastCloses) };
}

test('daily and hourly disagreeing is the end of it', () => {
  const result = analyzeStack({
    daily: barsFrom(upTrendCloses()),
    hourly: barsFrom(downTrendCloses()),
    fiveMin: barsFrom(seriesWithPullback()),
  });

  assert.equal(result.state, 'not_aligned');
  assert.equal(result.setup, null);
  assert.equal(result.direction, null);
  assert.match(result.detail, /does not agree/);
});

test('aligned but still driving is "extended" — there is nothing to enter on', () => {
  const hourly = barsFrom(upTrendCloses());
  const level = trendOf(hourly).invalidation;
  // A fast series that ends on its own high: no pullback exists yet.
  const driving = zigzag({ from: level * 1.005, cycles: 6, impulsePct: 3, giveBack: 0.45 });
  const top = driving.at(-1);
  driving.push(top * 1.01, top * 1.02, top * 1.03);

  const result = analyzeStack(stackAround('up', driving));

  assert.equal(result.contextAligned, true);
  assert.equal(result.state, 'extended');
  assert.equal(result.setup, null);
});

test('an aligned stack with a healthy pullback produces a long setup', () => {
  const stack = consistentStack('up', { legPct: 3, retracePct: 40, pullbackBars: 3 });
  const fiveMin = stack.fiveMin;
  const result = analyzeStack(stack);

  assert.equal(result.direction, 'up');
  assert.equal(result.contextAligned, true);
  assert.ok(['armed', 'pullback_forming', 'triggered'].includes(result.state), `state was ${result.state}`);

  const setup = result.setup;
  assert.ok(setup, 'a setup is expected');
  assert.equal(setup.direction, 'long');
  assert.equal(setup.type, 'trend_continuation');

  const pullback = fiveMin.slice(-3);
  const pullbackHigh = Math.max(...pullback.map((b) => b.high));
  const pullbackLow = Math.min(...pullback.map((b) => b.low));
  assert.ok(setup.entry > pullbackHigh, 'entry is a break of the pause, not the pause itself');
  assert.ok(setup.stop < pullbackLow, 'stop sits beyond the pullback, with room for noise');
  assert.ok(setup.stop > result.invalidation - 1, 'the trade stop is tighter than the structural one');
  assert.ok(Math.abs(setup.retracePct - 40) < 6);
});

test('THE rule: a pullback through the hourly swing low is a reversal, not a pause', () => {
  const hourly = barsFrom(upTrendCloses());
  const level = trendOf(hourly).invalidation;

  // Build a fast series whose pullback ends just below that hourly higher low.
  const closes = zigzag({ from: level * 0.97, cycles: 4, impulsePct: 3, giveBack: 0.45 });
  const top = level * 1.03;
  for (let i = 1; i <= 4; i += 1) closes.push(closes.at(-1) + (top - closes.at(-1)) * (i / 4));
  const through = level * 0.985;
  for (let i = 1; i <= 3; i += 1) closes.push(top + (through - top) * (i / 3));

  const result = analyzeStack({ daily: barsFrom(upTrendCloses()), hourly, fiveMin: barsFrom(closes) });

  assert.equal(result.state, 'invalidated');
  assert.equal(result.setup, null, 'no entry survives a broken hourly sequence');
  assert.match(result.detail, /break of \w+ structure/i);
  assert.ok(result.correction.pullbackExtreme < result.invalidation);
});

test('a pullback that tests the hourly low and holds is the setup, not a failure', () => {
  const hourly = barsFrom(upTrendCloses());
  const level = trendOf(hourly).invalidation;

  const closes = zigzag({ from: level * 0.99, cycles: 4, impulsePct: 3, giveBack: 0.45 });
  const top = closes.at(-1) * 1.03;
  for (let i = 1; i <= 5; i += 1) closes.push(closes.at(-1) + (top - closes.at(-1)) * (i / 5));
  // Ends a whisker above the level rather than through it.
  const held = level * 1.001;
  for (let i = 1; i <= 3; i += 1) closes.push(top + (held - top) * (i / 3));

  const result = analyzeStack({ daily: barsFrom(upTrendCloses()), hourly, fiveMin: barsFrom(closes) });

  assert.notEqual(result.state, 'invalidated');
  assert.ok(result.correction.pullbackExtreme >= result.invalidation - 0.2);
});

test('a retracement past the limit is reported as too deep, with structure still intact', () => {
  const result = analyzeStack(consistentStack('up', { legPct: 4, retracePct: 85, pullbackBars: 4 }));

  assert.equal(result.state, 'too_deep');
  assert.equal(result.setup, null);
  assert.match(result.detail, /closer to a reversal than a pause/);
});

test('a pullback longer than the bar limit is stalling, not pausing', () => {
  const stack = consistentStack('up', { legPct: 4, retracePct: 45, pullbackBars: 20 });
  const result = analyzeStack(stack, { maxPullbackBars: 6 });

  assert.equal(result.state, 'too_deep');
  assert.match(result.detail, /stopped pausing and started stalling/);
});

test('a few ticks off the high is not yet a correction', () => {
  const result = analyzeStack(consistentStack('up', { legPct: 4, retracePct: 5, pullbackBars: 2 }));

  assert.equal(result.state, 'extended');
  assert.equal(result.setup, null);
  assert.match(result.detail, /has to reach to be one/);
});

test('a down-aligned stack produces a short, with the stop above the entry', () => {
  const result = analyzeStack(consistentStack('down', { legPct: 3, retracePct: 40, pullbackBars: 3 }));

  assert.equal(result.direction, 'down');
  const setup = result.setup;
  assert.ok(setup, `expected a setup, got state ${result.state}`);
  assert.equal(setup.direction, 'short');
  assert.ok(setup.stop > setup.entry, 'a short stops out above where it got in');
  assert.ok(setup.measuredTarget < setup.entry);
  assert.ok(setup.structuralStop > setup.entry);
});

test('a timeframe without enough history makes the whole read unreadable', () => {
  const result = analyzeStack({
    daily: barsFrom(upTrendCloses()),
    hourly: barsFrom([10, 11, 12]),
    fiveMin: barsFrom(seriesWithPullback()),
  });

  assert.equal(result.state, 'unreadable');
  assert.match(result.detail, /Hourly/);
});

test('a setup already far through its trigger is dropped rather than chased', () => {
  // A near-zero chase limit means any close at or past the trigger counts as gone.
  const result = analyzeStack(consistentStack('up', { legPct: 3, retracePct: 40, pullbackBars: 3 }), {
    maxChasePct: 0.0001,
    minRetracePct: 1,
  });
  if (result.state === 'triggered') {
    assert.equal(result.setup, null);
    assert.match(result.detail, /paying up|already fired/);
  }
});

test('a shallow pullback projects further than a deep one, and says so', () => {
  const shallow = analyzeStack(consistentStack('up', { legPct: 4, retracePct: 25, pullbackBars: 3 }));
  const deep = analyzeStack(consistentStack('up', { legPct: 4, retracePct: 58, pullbackBars: 3 }));

  assert.ok(shallow.setup && deep.setup);
  assert.ok(
    shallow.setup.measuredR > deep.setup.measuredR,
    'the same leg pays less from a deeper entry — that is the arithmetic the caution reports',
  );
  assert.ok(deep.setup.cautions.length > 0);
});

/* ------------------------------------------------------------------ */
/* sizing and journalling a short                                      */
/* ------------------------------------------------------------------ */

test('a short is sized off the same risk budget as a long', () => {
  const plan = buildTradePlan(
    { direction: 'short', entry: 50, stop: 51 },
    { accountSize: 25_000, maxRiskPerTradePct: 1, targetRatios: [2, 3] },
  );

  assert.equal(plan.direction, 'short');
  assert.equal(plan.tradable, true);
  assert.equal(plan.riskPerShare, 1);
  assert.equal(plan.shares, 250);
  assert.deepEqual(plan.targets.map((t) => t.price), [48, 47], 'targets run down from a short entry');
});

test('a short with the stop below the entry has no valid risk', () => {
  const plan = buildTradePlan({ direction: 'short', entry: 50, stop: 49 }, {});
  assert.equal(plan.tradable, false);
  assert.match(plan.blockers[0], /below its stop/);
});

test('a long plan is unchanged by the direction field existing', () => {
  const withField = buildTradePlan({ direction: 'long', entry: 10, stop: 9.5 }, { accountSize: 10_000 });
  const without = buildTradePlan({ entry: 10, stop: 9.5 }, { accountSize: 10_000 });
  assert.equal(withField.shares, without.shares);
  assert.equal(without.direction, 'long');
  assert.deepEqual(withField.targets, without.targets);
});

/* ------------------------------------------------------------------ */
/* providers                                                           */
/* ------------------------------------------------------------------ */

test('Tradier daily bars are stamped inside the Eastern day they belong to', () => {
  const bars = parseHistory({
    history: {
      day: [
        { date: '2026-07-06', open: 10, high: 11, low: 9, close: 10.5, volume: 100 },
        { date: '2026-07-07', open: 10.5, high: 12, low: 10, close: 11.8, volume: 120 },
      ],
    },
  });

  assert.equal(bars.length, 2);
  assert.equal(toDaily(bars)[0].session, '2026-07-06', 'a midnight stamp would file this under 5 July');
  assert.equal(bars[1].close, 11.8);
});

test('Tradier collapses a one-element history into a bare object', () => {
  const bars = parseHistory({ history: { day: { date: '2026-07-06', open: 1, high: 2, low: 0.5, close: 1.5 } } });
  assert.equal(bars.length, 1);
});

test('Yahoo chart bars drop periods that never traded', () => {
  const bars = parseChartBars({
    chart: {
      result: [
        {
          timestamp: [1751808600, 1751808900, 1751809200],
          indicators: {
            quote: [
              {
                open: [10, null, 11],
                high: [10.5, null, 11.5],
                low: [9.8, null, 10.9],
                close: [10.2, null, 11.4],
                volume: [500, null, 700],
              },
            ],
          },
        },
      ],
    },
  });

  assert.equal(bars.length, 2, 'the padded null minute is dropped, not repaired');
  assert.equal(bars[0].close, 10.2);
  assert.equal(bars[1].volume, 700);
});

test('an empty Yahoo payload yields no bars rather than throwing', () => {
  assert.deepEqual(parseChartBars({}), []);
  assert.deepEqual(parseChartBars(null), []);
});

/* ------------------------------------------------------------------ */
/* simulated history                                                   */
/* ------------------------------------------------------------------ */

test('simulated session opens skip weekends and land on the bell', () => {
  // A Wednesday.
  const opens = sessionOpens(Date.parse('2026-07-08T20:00:00Z'), 5);
  assert.equal(opens.length, 5);
  for (const ms of opens) {
    assert.equal(minutesFromOpen(ms), 0, 'every session starts at 09:30 ET');
    const weekday = new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
    assert.ok(!['Sat', 'Sun'].includes(weekday));
  }
  assert.ok(opens[0] < opens.at(-1), 'oldest first');
});

test('simulated history is long enough to read all three timeframes', () => {
  const now = Date.parse('2026-07-08T17:00:00Z');
  const history = getHistory({ symbol: 'TRAQ', now });
  const stack = buildStack({ intraday: history.intraday, daily: history.daily, now });

  assert.ok(stack.fiveMin.length > 300);
  assert.ok(stack.hourly.length > 40);
  assert.ok(stack.daily.length > 100);

  const read = analyzeStack(stack);
  assert.ok(read.timeframes.daily.usable);
  assert.ok(read.timeframes.hourly.usable);
  assert.ok(read.timeframes.fiveMin.usable);
});

test('the simulated daily series agrees with the intraday bars it overlaps', () => {
  const now = Date.parse('2026-07-08T17:00:00Z');
  const { intraday, daily } = getHistory({ symbol: 'HLNX', now });

  const lastDay = daily.at(-1);
  const lastSession = intraday.filter((bar) => bar.time.slice(0, 10) === lastDay.time.slice(0, 10));
  assert.ok(lastSession.length > 0);
  assert.equal(lastDay.close, lastSession.at(-1).close, 'the daily close is the session close');
  assert.equal(lastDay.high, Math.max(...lastSession.map((b) => b.high)));
});

test('simulated trending symbols align and choppy ones do not', () => {
  const now = Date.parse('2026-07-08T17:00:00Z');
  const byRegime = { up: [], down: [], chop: [] };

  for (const symbol of symbols) {
    const history = getHistory({ symbol, now });
    const read = analyzeStack(buildStack({ intraday: history.intraday, daily: history.daily, now }));
    byRegime[regimeFor(symbol)].push(read);
  }

  const share = (list, fn) => list.filter(fn).length / list.length;

  assert.ok(
    share(byRegime.up, (r) => r.direction === 'up') > 0.7,
    'symbols simulated in an uptrend should mostly read as one',
  );
  assert.ok(
    share(byRegime.down, (r) => r.direction === 'down') > 0.7,
    'symbols simulated in a downtrend should mostly read as one',
  );
  assert.ok(
    share(byRegime.chop, (r) => r.contextAligned) < 0.35,
    'a market that swings without trending should mostly refuse to align',
  );
});

test('an unknown simulated symbol returns empty series rather than inventing them', () => {
  const history = getHistory({ symbol: 'NOPE', now: Date.now() });
  assert.deepEqual(history.intraday, []);
  assert.deepEqual(history.daily, []);
  assert.equal(history.regime, null);
});

/* ------------------------------------------------------------------ */
/* the ladder is scale-invariant                                       */
/* ------------------------------------------------------------------ */

test('analyzeStack is the swing ladder, nothing more', () => {
  const stack = consistentStack('up', { legPct: 3, retracePct: 40, pullbackBars: 3 });
  const viaStack = analyzeStack(stack);
  const viaLadder = analyzeLadder([
    { key: '1d', bars: stack.daily },
    { key: '1h', bars: stack.hourly },
    { key: '5m', bars: stack.fiveMin },
  ]);

  assert.equal(viaStack.state, viaLadder.state);
  assert.equal(viaStack.detail, viaLadder.detail);
  assert.deepEqual(viaStack.setup, viaLadder.setup);
  assert.deepEqual(viaLadder.ladder, LADDERS.swing);
});

test('the same rules run on a fast ladder, with the fast labels', () => {
  // 15m -> 5m -> 1m is the same relationship as 1d -> 1h -> 5m. Feed the
  // identical fixtures in under fast keys and the verdict must be identical
  // apart from what the sentences call the timeframes.
  const stack = consistentStack('up', { legPct: 3, retracePct: 40, pullbackBars: 3 });
  const slow = analyzeStack(stack);
  const fast = analyzeLadder([
    { key: '15m', bars: stack.daily },
    { key: '5m', bars: stack.hourly },
    { key: '1m', bars: stack.fiveMin },
  ]);

  assert.equal(fast.state, slow.state);
  assert.equal(fast.direction, slow.direction);
  assert.equal(fast.setup?.entry, slow.setup?.entry);
  assert.equal(fast.setup?.stop, slow.setup?.stop);

  assert.match(slow.setup.rationale, /Hourly/);
  assert.match(fast.setup.rationale, /5-minute/);
  assert.ok(!/Hourly|Daily/.test(fast.setup.rationale), 'a fast ladder must not talk about the daily');
  assert.equal(fast.setup.timingTimeframe, '1m');
  assert.equal(fast.setup.structureTimeframe, '5m');
});

test('two rungs is a real ladder: structure and timing, no permission layer', () => {
  const stack = consistentStack('up', { legPct: 3, retracePct: 40, pullbackBars: 3 });
  const result = analyzeLadder([
    { key: '5m', bars: stack.hourly },
    { key: '1m', bars: stack.fiveMin },
  ]);

  assert.equal(result.contextAligned, true);
  assert.ok(result.setup, `expected a setup, got ${result.state}`);
  assert.equal(result.rungs.length, 2);
  assert.deepEqual(result.rungs.map((r) => r.role), ['structure', 'timing']);
  // "5-minute agree" is not a sentence; the phrasing has to follow the shape.
  assert.ok(!/5-minute agree|5-minute all/.test(result.setup.rationale), result.setup.rationale);
});

test('one rung cannot tell a pause from a reversal, and says so', () => {
  const result = analyzeLadder([{ key: '5m', bars: barsFrom(upTrendCloses()) }]);
  assert.equal(result.state, 'unreadable');
  assert.match(result.detail, /at least two timeframes/);
});

test('every rung above the timing one has to agree, not just the nearest', () => {
  const stack = consistentStack('up', { legPct: 3, retracePct: 40, pullbackBars: 3 });
  // A four-rung ladder whose slowest rung is fighting the other three.
  const result = analyzeLadder([
    { key: '1d', bars: barsFrom(downTrendCloses()) },
    { key: '1h', bars: stack.daily },
    { key: '15m', bars: stack.hourly },
    { key: '5m', bars: stack.fiveMin },
  ]);

  assert.equal(result.state, 'not_aligned');
  assert.equal(result.setup, null);
  assert.match(result.detail, /Daily is trending down/);
});

test('the invalidation ladder is nested, slowest first, with the decisive one marked', () => {
  const stack = consistentStack('up', { legPct: 3, retracePct: 40, pullbackBars: 3 });
  const result = analyzeLadder([
    { key: '1d', bars: stack.daily },
    { key: '1h', bars: stack.hourly },
    { key: '5m', bars: stack.fiveMin },
  ]);

  const levels = result.invalidations;
  assert.equal(levels.length, 3);
  assert.deepEqual(levels.map((l) => l.key), ['1d', '1h', '5m']);

  const decisive = levels.find((l) => l.role === 'structure');
  assert.equal(decisive.key, '1h');
  assert.equal(
    decisive.level,
    result.invalidation,
    'the level the setup is built against is the structure rung, not the slowest',
  );
});

test('the trade stop sits inside the structural stop', () => {
  const stack = consistentStack('up', { legPct: 3, retracePct: 40, pullbackBars: 3 });
  const result = analyzeStack(stack);
  assert.ok(result.setup);
  assert.ok(
    result.setup.stop > result.setup.structuralStop,
    'the sized stop is tighter than the one that says the reason is gone',
  );
});

test('slower rungs sit further away, because their swings are older and wider', () => {
  // A property of markets rather than of this code, so it is checked against
  // generated bars rather than a hand-built fixture: the daily higher low is
  // below the hourly one, which is below the 5-minute one. If it ever stops
  // holding, the "nested levels" framing in the drawer is misleading.
  const now = Date.parse('2026-07-08T17:00:00Z');
  let checked = 0;

  for (const symbol of symbols) {
    const history = getHistory({ symbol, now });
    const result = analyzeStack(
      buildStack({ intraday: history.intraday, daily: history.daily, now }),
    );
    if (!result.contextAligned || result.invalidations.length < 3) continue;

    const [slow, mid, fast] = result.invalidations.map((l) => l.level);
    const ordered = result.direction === 'up' ? slow <= mid && mid <= fast : slow >= mid && mid >= fast;
    assert.ok(ordered, `${symbol}: levels out of order — ${slow}, ${mid}, ${fast}`);
    checked += 1;
  }

  assert.ok(checked >= 5, `only ${checked} symbols were aligned enough to check`);
});

/* ------------------------------------------------------------------ */
/* building ladders from a feed                                        */
/* ------------------------------------------------------------------ */

test('detectInterval reads the bar width from the bars, ignoring session breaks', () => {
  const day1 = barsFrom([10, 11, 12, 13], { start: Date.parse('2026-07-06T19:00:00Z'), stepMinutes: 5 });
  const day2 = barsFrom([13, 14, 15, 16], { start: Date.parse('2026-07-07T13:30:00Z'), stepMinutes: 5 });
  assert.equal(detectInterval([...day1, ...day2]), 5, 'the overnight gap is not the bar interval');

  assert.equal(detectInterval(barsFrom([1, 2, 3, 4, 5], { stepMinutes: 1 })), 1);
  assert.equal(detectInterval([]), null);
});

test('a ladder rung finer than the feed is refused, not fabricated', () => {
  const now = Date.parse('2026-07-08T17:00:00Z');
  const history = getHistory({ symbol: 'TRAQ', now, interval: '5m' });

  const rungs = buildLadder({ ladder: LADDERS.scalp, intraday: history.intraday, daily: history.daily, now });
  const oneMinute = rungs.find((r) => r.key === '1m');

  assert.deepEqual(oneMinute.bars, [], 'no bars rather than five fabricated ones per real bar');
  assert.match(oneMinute.problem, /combined but never split/);

  const result = analyzeLadder(rungs);
  assert.equal(result.state, 'unreadable');
  assert.match(result.detail, /1-minute:.*cannot be built/);
});

test('the simulator generates the resolution asked for, not a relabelled one', () => {
  const now = Date.parse('2026-07-08T17:00:00Z');
  const fine = getHistory({ symbol: 'TRAQ', now, interval: '1m', sessions: 4 });
  const coarse = getHistory({ symbol: 'TRAQ', now, interval: '5m', sessions: 4 });

  assert.equal(detectInterval(fine.intraday), 1);
  assert.equal(detectInterval(coarse.intraday), 5);
  assert.ok(fine.intraday.length > coarse.intraday.length * 4);

  // The finer feed has to be a closer look at the *same* market, not a
  // different one that happens to share a ticker. Rolling the 1-minute bars up
  // to 5 minutes should land on the natively generated 5-minute series.
  const rolled = resample(fine.intraday, 5, { now });
  assert.equal(rolled.length, coarse.intraday.length);

  const drift = Math.abs(rolled.at(-1).close - coarse.intraday.at(-1).close) / coarse.intraday.at(-1).close;
  assert.ok(drift < 0.01, `the two resolutions disagree by ${(drift * 100).toFixed(2)}% at the last bar`);
  assert.equal(trendOf(rolled.slice(-120)).direction, trendOf(coarse.intraday.slice(-120)).direction);
});

test('every named ladder builds and reads, given a feed fine and long enough', () => {
  const now = Date.parse('2026-07-08T17:00:00Z');

  // Two constraints pull opposite ways: a ladder's fastest rung sets how fine
  // the feed has to be, and its slowest sets how long. `wide` reaches 4-hour
  // bars, so it needs months of intraday history — which is why it is only
  // reachable on a feed that serves them (Yahoo's 2-year hourly series does).
  const feeds = {
    swing: { interval: '5m', sessions: 12 },
    intraday: { interval: '5m', sessions: 12 },
    scalp: { interval: '1m', sessions: 6 },
    micro: { interval: '1m', sessions: 6 },
    wide: { interval: '15m', sessions: 120 },
  };

  for (const [name, ladder] of Object.entries(LADDERS)) {
    const history = getHistory({ symbol: 'TRAQ', now, ...feeds[name] });
    const rungs = buildLadder({ ladder, intraday: history.intraday, daily: history.daily, now });

    for (const rung of rungs) {
      assert.equal(rung.problem, null, `${name}/${rung.key}: ${rung.problem}`);
      assert.ok(rung.bars.length > 0, `${name}/${rung.key} produced no bars`);
    }

    const result = analyzeLadder(rungs);
    assert.notEqual(result.state, 'unreadable', `${name} was unreadable: ${result.detail}`);
    assert.deepEqual(result.rungs.map((r) => r.key), ladder);
  }
});

test('an unknown interval is reported rather than silently skipped', () => {
  const now = Date.parse('2026-07-08T17:00:00Z');
  const history = getHistory({ symbol: 'TRAQ', now });
  const [rung] = buildLadder({ ladder: ['3s'], intraday: history.intraday, daily: history.daily, now });
  assert.match(rung.problem, /Unknown interval/);
});

test('each rung reads a window sized to its own interval', () => {
  const now = Date.parse('2026-07-08T17:00:00Z');
  const history = getHistory({ symbol: 'TRAQ', now, interval: '1m', sessions: 6 });
  const rungs = buildLadder({ ladder: LADDERS.scalp, intraday: history.intraday, daily: history.daily, now });

  // The 1-minute rung has thousands of bars available; the read is windowed.
  const oneMinute = rungs.find((r) => r.key === '1m');
  assert.ok(oneMinute.bars.length > 1000);

  const result = analyzeLadder(rungs);
  const read = result.rungs.find((r) => r.key === '1m');
  assert.ok(read.bars <= 240, `read ${read.bars} bars, expected the 1m window of 240`);

  const narrower = analyzeLadder(rungs, { windows: { '1m': 60 } });
  assert.equal(narrower.rungs.find((r) => r.key === '1m').bars, 60);
});

test('the leg filter is measured in bar ranges, so it survives a change of scale', () => {
  // The same market sampled twice: once as-is, once with every price scaled and
  // the bars a fifth the size. A percent-of-price floor would admit the first
  // and reject the second; a bar-range floor treats them alike.
  const stack = consistentStack('up', { legPct: 3, retracePct: 40, pullbackBars: 3 });
  const coarse = analyzeStack(stack);
  assert.ok(coarse.setup, `expected a setup, got ${coarse.state}`);
  assert.ok(coarse.correction.legAtr >= DEFAULT_TREND_CONFIG.minLegAtr);

  // Shrink every move to a fifth without changing the shape: prices stay put,
  // the distances between them compress. Percent-wise every leg is now five
  // times smaller; in bar ranges nothing has changed at all.
  const compress = (bars) => {
    const base = bars[0].close;
    return bars.map((b) => ({
      ...b,
      open: base + (b.open - base) / 5,
      high: base + (b.high - base) / 5,
      low: base + (b.low - base) / 5,
      close: base + (b.close - base) / 5,
    }));
  };

  const fine = analyzeStack({
    daily: compress(stack.daily),
    hourly: compress(stack.hourly),
    fiveMin: compress(stack.fiveMin),
  });

  assert.equal(fine.state, coarse.state, 'the verdict must not depend on the size of the moves');
  assert.ok(fine.setup, 'a fifth-sized version of the same structure is still the same setup');
  assert.ok(
    Math.abs(fine.correction.legAtr - coarse.correction.legAtr) < 0.2,
    `leg was ${coarse.correction.legAtr} ATR coarse and ${fine.correction.legAtr} ATR fine`,
  );
  assert.ok(
    fine.correction.legPct < coarse.correction.legPct / 4,
    'and the percent measure really did collapse, which is what used to break it',
  );
});

test('a drive smaller than a couple of bar ranges is not a leg', () => {
  const stack = consistentStack('up', { legPct: 3, retracePct: 40, pullbackBars: 3 });
  // Demanding a 50-ATR drive is a floor nothing realistic clears.
  const result = analyzeStack(stack, { minLegAtr: 50 });

  assert.equal(result.setup, null);
  assert.equal(result.state, 'extended');
  assert.match(result.detail, /No drive of at least 50 bar ranges/);
});
