import test from 'node:test';
import assert from 'node:assert/strict';

import {
  simulateTrade,
  backtest,
  combine,
  summarize,
  hasLookahead,
  lookbackFor,
  warmupFor,
  resolveLadder,
  DEFAULT_BACKTEST_CONFIG,
} from '../lib/backtest.js';
import { LADDERS, readWindow } from '../lib/trend.js';
import { buildStack } from '../lib/timeframes.js';
import { analyzeStack } from '../lib/trend.js';
import { getHistory, symbols } from '../lib/providers/mock.js';

const START = Date.parse('2026-07-06T13:30:00Z');

/** One bar. Times step five minutes so the series is a real 5-minute chart. */
function bar(index, open, high, low, close) {
  return {
    time: new Date(START + index * 5 * 60_000).toISOString(),
    open,
    high,
    low,
    close,
    volume: 1000,
  };
}

/** Costs off by default, so a fill lands exactly where the arithmetic says. */
const FREE = { slippagePct: 0, commissionPerShare: 0, orderLifeBars: 20, maxHoldBars: 500 };

const LONG = { direction: 'long', entry: 100, stop: 99, placedAt: new Date(START).toISOString() };
const SHORT = { direction: 'short', entry: 100, stop: 101, placedAt: new Date(START).toISOString() };

/* ------------------------------------------------------------------ */
/* fills                                                               */
/* ------------------------------------------------------------------ */

test('a long fills at its trigger, scales out at 2R and takes the rest at 3R', () => {
  const bars = [
    bar(0, 98, 99.5, 97.5, 99.2), // nowhere near the trigger
    bar(1, 99.5, 100.4, 99.4, 100.3), // trigger at 100 is touched
    bar(2, 100.3, 102.2, 100.2, 102), // first target at 102
    bar(3, 102, 103.5, 101.9, 103.4), // second target at 103
  ];

  const { trade } = simulateTrade(LONG, bars, 0, FREE);
  assert.ok(trade);
  assert.equal(trade.entry, 100);
  assert.equal(trade.reason, 'target');
  // Half the position at 2R and half at 3R.
  assert.equal(trade.r, 2.5);
  assert.equal(trade.win, true);
});

test('a short is the mirror image, not a special case', () => {
  const bars = [
    bar(0, 102, 102.5, 100.6, 101),
    bar(1, 100.8, 100.9, 99.6, 99.7), // trigger at 100
    bar(2, 99.7, 99.8, 97.9, 98), // first target at 98
    bar(3, 98, 98.1, 96.5, 96.6), // second at 97
  ];

  const { trade } = simulateTrade(SHORT, bars, 0, FREE);
  assert.ok(trade);
  assert.equal(trade.direction, 'short');
  assert.equal(trade.entry, 100);
  assert.equal(trade.r, 2.5);
});

test('an order that gaps through its trigger fills at the open, and it costs', () => {
  const bars = [
    bar(0, 98, 99.4, 97.5, 99.2),
    bar(1, 102, 102.5, 101.8, 102), // opened two points through a 100 trigger
    bar(2, 102, 102.1, 98.9, 99), // and then back down to the 99 stop
  ];

  const { trade } = simulateTrade(LONG, bars, 0, FREE);
  assert.ok(trade);
  assert.equal(trade.entry, 102, 'filled at the open, not at the trigger');
  assert.equal(trade.riskPerShare, 1, 'size was set from the planned 1-point risk');
  // Bought at 102 with a stop at 99: three points lost on a position sized for
  // one. Reporting this as a tidy -1R is the lie this test exists to prevent.
  assert.equal(trade.r, -3);
});

test('a stop that gaps is filled at the open, below the stop', () => {
  const bars = [
    bar(0, 99.4, 100.5, 99.2, 100.2), // fills at 100
    bar(1, 96, 96.5, 95.5, 96), // gaps straight through the 99 stop
  ];

  const { trade } = simulateTrade(LONG, bars, 0, FREE);
  assert.equal(trade.reason, 'stop');
  assert.equal(trade.r, -4, 'the gap cost four points on a one-point stop');
});

/* ------------------------------------------------------------------ */
/* ambiguity                                                           */
/* ------------------------------------------------------------------ */

test('a bar covering both the stop and a target resolves against the trade', () => {
  const bars = [
    bar(0, 99.3, 100.2, 99.2, 100), // fills at 100
    // This bar reached 103 and 98.5. OHLC cannot say which came first.
    bar(1, 100, 103, 98.5, 102),
  ];

  const pessimistic = simulateTrade(LONG, bars, 0, FREE).trade;
  assert.equal(pessimistic.reason, 'stop');
  assert.equal(pessimistic.r, -1);

  const optimistic = simulateTrade(LONG, bars, 0, { ...FREE, pessimisticBars: false }).trade;
  assert.equal(optimistic.reason, 'target', 'the same bar, read the other way, is a winner');
  assert.ok(optimistic.r > 0, 'which is exactly why the pessimistic reading is the default');
});

test('a bar that fills the entry and reaches the stop is a loss, not a free trade', () => {
  const bars = [
    bar(0, 99, 99.5, 98.8, 99.2),
    bar(1, 99.2, 101, 98.5, 98.7), // filled at 100 on the way up, then through 99
  ];

  const { trade } = simulateTrade(LONG, bars, 0, FREE);
  assert.ok(trade);
  assert.equal(trade.entry, 100);
  assert.equal(trade.reason, 'stop');
  assert.equal(trade.barsHeld, 0);
});

/* ------------------------------------------------------------------ */
/* the rest of the lifecycle                                           */
/* ------------------------------------------------------------------ */

test('the stop moves to breakeven once the first target pays', () => {
  const bars = [
    bar(0, 99.3, 100.2, 99.2, 100), // fill at 100
    bar(1, 100, 102.2, 99.9, 102), // first target: +2R on half
    bar(2, 102, 102.1, 99.5, 99.6), // back to the entry — the rest exits flat
  ];

  const { trade } = simulateTrade(LONG, bars, 0, FREE);
  assert.equal(trade.reason, 'breakeven_stop');
  assert.equal(trade.r, 1, 'half the position banked 2R, the other half nothing');
});

test('an unfilled order expires rather than resting forever', () => {
  const bars = Array.from({ length: 10 }, (_, i) => bar(i, 98, 99.2, 97.5, 98.5));
  const { trade, endIndex } = simulateTrade(LONG, bars, 0, { ...FREE, orderLifeBars: 4 });

  assert.equal(trade, null);
  assert.equal(endIndex, 4, 'and the replay resumes deciding from there');
});

test('a position that goes nowhere is closed on time, not held forever', () => {
  const bars = [bar(0, 99.3, 100.3, 99.2, 100)];
  for (let i = 1; i <= 12; i += 1) bars.push(bar(i, 100, 100.4, 99.6, 100.1));

  const { trade } = simulateTrade(LONG, bars, 0, { ...FREE, maxHoldBars: 8 });
  assert.equal(trade.reason, 'time');
  assert.ok(Math.abs(trade.r) < 0.5);
});

test('a position still open when the data runs out is marked to market, not dropped', () => {
  const bars = [bar(0, 99.3, 100.3, 99.2, 100), bar(1, 100, 100.8, 99.5, 100.5)];
  const { trade } = simulateTrade(LONG, bars, 0, FREE);

  assert.equal(trade.reason, 'end_of_data');
  assert.equal(trade.r, 0.5);
});

/* ------------------------------------------------------------------ */
/* costs                                                               */
/* ------------------------------------------------------------------ */

test('slippage moves every fill against the trade, on both sides and both directions', () => {
  const bars = [
    bar(0, 99.3, 100.2, 99.2, 100),
    bar(1, 100, 103.5, 99.9, 103.4),
  ];

  const free = simulateTrade(LONG, bars, 0, FREE).trade;
  const costly = simulateTrade(LONG, bars, 0, { ...FREE, slippagePct: 0.1 }).trade;

  assert.ok(costly.entry > free.entry, 'a long pays up to get in');
  assert.ok(costly.r < free.r, 'and gives some back on the way out');

  const shortBars = [
    bar(0, 100.8, 100.9, 99.8, 100),
    bar(1, 100, 100.1, 96.5, 96.6),
  ];
  const freeShort = simulateTrade(SHORT, shortBars, 0, FREE).trade;
  const costlyShort = simulateTrade(SHORT, shortBars, 0, { ...FREE, slippagePct: 0.1 }).trade;

  assert.ok(costlyShort.entry < freeShort.entry, 'a short is filled lower than it wanted');
  assert.ok(costlyShort.r < freeShort.r);
});

test('commission is charged in R, so it bites a tight stop harder than a wide one', () => {
  const bars = [bar(0, 99.3, 100.2, 99.2, 100), bar(1, 100, 103.5, 99.9, 103.4)];

  const tight = simulateTrade(LONG, bars, 0, { ...FREE, commissionPerShare: 0.01 }).trade;
  const wide = simulateTrade(
    { direction: 'long', entry: 100, stop: 90 },
    [bar(0, 99.3, 100.2, 99.2, 100), bar(1, 100, 135, 99.9, 134)],
    0,
    { ...FREE, commissionPerShare: 0.01 },
  ).trade;

  const tightCost = tight.grossR - tight.r;
  const wideCost = wide.grossR - wide.r;
  assert.ok(tightCost > wideCost * 5, 'the same cents are a far bigger share of a 1-point stop');
});

/* ------------------------------------------------------------------ */
/* statistics                                                          */
/* ------------------------------------------------------------------ */

test('drawdown is the worst peak-to-trough run, not the worst single trade', () => {
  const at = (r, i) => ({ r, reason: 'stop', barsHeld: 1, closedAt: new Date(START + i * 60_000).toISOString() });
  // Up 3, then three losses of 1 each: the worst trade is -1, the drawdown is 3.
  const stats = summarize([at(3, 0), at(-1, 1), at(-1, 2), at(-1, 3)]);

  assert.equal(stats.totalR, 0);
  assert.equal(stats.maxDrawdownR, 3);
  assert.equal(stats.winRatePct, 25);
  assert.equal(stats.profitFactor, 1);
});

test('an empty run reports nothing rather than dividing by zero', () => {
  const stats = summarize([]);
  assert.equal(stats.trades, 0);
  assert.equal(stats.winRatePct, null);
  assert.equal(stats.totalR, 0);
});

test('combine merges per-symbol runs and keeps the symbol on each trade', () => {
  const merged = combine([
    { symbol: 'AAA', bars: 10, decisions: 5, states: { armed: 2 }, trades: [{ r: 1, reason: 'target', barsHeld: 3, closedAt: '2026-07-06T14:00:00Z' }] },
    { symbol: 'BBB', bars: 20, decisions: 7, states: { armed: 1, extended: 4 }, trades: [{ r: -1, reason: 'stop', barsHeld: 2, closedAt: '2026-07-06T15:00:00Z' }] },
  ]);

  assert.equal(merged.symbols, 2);
  assert.equal(merged.bars, 30);
  assert.deepEqual(merged.states, { armed: 3, extended: 4 });
  assert.deepEqual(merged.trades.map((t) => t.symbol), ['AAA', 'BBB']);
  assert.equal(merged.stats.totalR, 0);
});

/* ------------------------------------------------------------------ */
/* honesty                                                             */
/* ------------------------------------------------------------------ */

test('the replay does not read bars that had not printed', () => {
  const now = Date.parse('2026-07-08T17:00:00Z');
  for (const symbol of ['TRAQ', 'OESX', 'HLNX']) {
    const check = hasLookahead(getHistory({ symbol, now }));
    assert.equal(check.leaks, false, `${symbol} leaked future bars into its verdict`);
  }
});

test('the lookahead check is not vacuous — its poison really does change a verdict', () => {
  // A clean bill of health only means something if the poisoned series would
  // have been detected. Feed the poisoned bars in *without* truncating and the
  // verdict has to move; otherwise the check above proves nothing.
  const now = Date.parse('2026-07-08T17:00:00Z');
  const history = getHistory({ symbol: 'TRAQ', now });
  const cut = Math.floor(history.intraday.length * 0.7);

  const clean = analyzeStack(
    buildStack({ intraday: history.intraday.slice(0, cut + 1), daily: history.daily, now }),
  );
  const poisonedTail = history.intraday.map((b, i) =>
    i <= cut ? b : { ...b, open: b.open * 4, high: b.high * 4, low: b.low / 4, close: b.close * 4 },
  );
  const leaked = analyzeStack(buildStack({ intraday: poisonedTail, daily: history.daily, now }));

  assert.notEqual(
    `${clean.state}:${clean.invalidation}`,
    `${leaked.state}:${leaked.invalidation}`,
    'if quadrupling the future changes nothing, the detector cannot detect anything',
  );
});

test('a full replay produces coherent trades and never double-books a bar', () => {
  const now = Date.parse('2026-07-08T17:00:00Z');
  const run = backtest(getHistory({ symbol: 'TRAQ', now }), {
    backtest: { warmupBars: 300 },
  });

  assert.ok(run.decisions > 100);
  const reasons = new Set(['stop', 'breakeven_stop', 'target', 'time', 'end_of_data']);

  let previousClose = 0;
  for (const trade of run.trades) {
    assert.ok(Number.isFinite(trade.r), 'every trade resolves to a number of R');
    assert.ok(reasons.has(trade.reason), `unexpected exit reason ${trade.reason}`);
    assert.ok(trade.barsHeld >= 0);
    assert.equal(trade.win, trade.r > 0);

    const opened = new Date(trade.openedAt).getTime();
    assert.ok(opened >= previousClose, 'a trade opened before the previous one closed');
    previousClose = new Date(trade.closedAt).getTime();
  }
});

test('losses cluster at -1R, because that is what the stop is for', () => {
  const now = Date.parse('2026-07-08T17:00:00Z');
  const runs = symbols.slice(0, 8).map((symbol) => backtest(getHistory({ symbol, now }), {}));
  const trades = combine(runs).trades;
  assert.ok(trades.length > 10, 'need trades to say anything');

  const losers = trades.filter((t) => t.r < 0);
  const nearOneR = losers.filter((t) => t.r > -1.6);
  assert.ok(
    nearOneR.length / losers.length > 0.7,
    'most losers should cost about one planned R; many costing far more means ' +
      'the stop is not being respected or gaps are not being modelled',
  );
});

test('costs only ever make results worse', () => {
  const now = Date.parse('2026-07-08T17:00:00Z');
  const histories = symbols.slice(0, 8).map((symbol) => getHistory({ symbol, now }));

  const at = (slippagePct) =>
    combine(histories.map((h) => backtest(h, { backtest: { slippagePct } }))).stats.totalR;

  const free = at(0);
  const cheap = at(0.05);
  const dear = at(0.2);

  assert.ok(cheap < free, 'slippage cannot improve a result');
  assert.ok(dear < cheap, 'and more of it cannot improve it either');
});

test('the default config is the one the CLI and the tests actually share', () => {
  // A guard against the defaults drifting away from what is documented.
  assert.equal(DEFAULT_BACKTEST_CONFIG.pessimisticBars, true);
  assert.ok(DEFAULT_BACKTEST_CONFIG.slippagePct > 0, 'a zero-cost default would flatter every run');
  assert.deepEqual(DEFAULT_BACKTEST_CONFIG.targetRatios, [2, 3]);
});

/* ------------------------------------------------------------------ */
/* sizing the replay to its ladder                                     */
/* ------------------------------------------------------------------ */

test('the lookback covers the slowest rung, in units of the fastest', () => {
  // The scalp ladder's 15-minute rung wants the same number of *bars* as the
  // swing ladder's hourly rung, but those bars are built from 1-minute data,
  // so it takes three times as many of them. A flat number cannot serve both.
  const swing = lookbackFor(LADDERS.swing);
  const scalp = lookbackFor(LADDERS.scalp);

  assert.ok(swing >= readWindow('1h') * 12, `swing lookback ${swing} starves the hourly rung`);
  assert.ok(scalp >= readWindow('15m') * 15, `scalp lookback ${scalp} starves the 15-minute rung`);
  assert.ok(scalp > swing);

  // A two-rung ladder reaching only 5 minutes needs far less than either.
  assert.ok(lookbackFor(LADDERS.micro) < swing);
});

test('a narrower window asks for less history', () => {
  const wide = lookbackFor(LADDERS.scalp);
  const narrow = lookbackFor(LADDERS.scalp, { windows: { '15m': 30 } });
  assert.ok(narrow < wide, 'the lookback follows the configured window, not a constant');
});

test('warmup is when the rungs become readable, not when the window is full', () => {
  for (const ladder of Object.values(LADDERS)) {
    const warmup = warmupFor(ladder);
    const lookback = lookbackFor(ladder);
    assert.ok(
      warmup < lookback,
      'waiting for a full window would be stricter than the live scanner and cost decisions for nothing',
    );
    assert.ok(warmup > 0);
  }
  assert.ok(warmupFor(LADDERS.scalp) > warmupFor(LADDERS.swing), 'a 1-minute ladder needs more bars');
});

test('an explicit lookback still wins over the derived one', () => {
  const now = Date.parse('2026-07-08T17:00:00Z');
  const run = backtest(getHistory({ symbol: 'TRAQ', now }), {
    backtest: { maxIntradayLookback: 400, warmupBars: 420 },
  });
  assert.ok(run.decisions > 0);
});

test('resolveLadder takes a name, a list, or falls back', () => {
  assert.deepEqual(resolveLadder('scalp'), LADDERS.scalp);
  assert.deepEqual(resolveLadder(['1h', '15m', '5m']), ['1h', '15m', '5m']);
  assert.deepEqual(resolveLadder('nonsense'), LADDERS.swing);
  assert.deepEqual(resolveLadder(['5m']), LADDERS.swing, 'one rung is not a ladder');
});

test('a fast ladder replays without lookahead, same as a slow one', () => {
  const now = Date.parse('2026-07-08T17:00:00Z');
  const history = getHistory({ symbol: 'TRAQ', now, interval: '1m', sessions: 4 });
  const check = hasLookahead(history, { backtest: { ladder: 'scalp' } });
  assert.equal(check.leaks, false);

  const run = backtest(history, { backtest: { ladder: 'scalp' } });
  assert.deepEqual(run.ladder, LADDERS.scalp);
  assert.ok(run.decisions > 100);
  for (const trade of run.trades) assert.ok(Number.isFinite(trade.r));
});
