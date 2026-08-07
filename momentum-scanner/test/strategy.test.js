import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectPatterns, bestPattern, DEFAULT_PATTERN_CONFIG } from '../lib/patterns.js';
import { buildTradePlan, DEFAULT_RISK_CONFIG } from '../lib/trade-plan.js';
import { Journal, easternMinutes } from '../lib/journal.js';
import { getQuotes } from '../lib/providers/mock.js';
import { scan } from '../lib/criteria.js';

const NOW = Date.parse('2026-08-05T14:00:00Z');

/* ------------------------------------------------------------------ */
/* candle builders                                                     */
/* ------------------------------------------------------------------ */

let clock = 0;
function candle(open, high, low, close, volume = 1000) {
  clock += 60_000;
  return { time: new Date(NOW + clock).toISOString(), open, high, low, close, volume };
}

/** A rising leg followed by a shallow, low-volume pullback. */
function bullFlagCandles() {
  clock = 0;
  return [
    candle(10.0, 10.15, 9.98, 10.12, 5000),
    candle(10.12, 10.4, 10.1, 10.38, 8000),
    candle(10.38, 10.7, 10.35, 10.66, 9000),
    candle(10.66, 10.95, 10.62, 10.92, 9500),
    candle(10.92, 11.2, 10.9, 11.18, 10000),
    // pullback: lower highs, lighter volume, holding most of the leg
    candle(11.18, 11.19, 10.95, 11.0, 3000),
    candle(11.0, 11.05, 10.88, 10.94, 2500),
    candle(10.94, 11.02, 10.9, 10.98, 2200),
  ];
}

/** A single soft candle inside a strong drive. */
function microPullbackCandles() {
  clock = 0;
  return [
    candle(20.0, 20.3, 19.95, 20.28, 6000),
    candle(20.28, 20.7, 20.25, 20.66, 8000),
    candle(20.66, 21.1, 20.6, 21.05, 9000),
    candle(21.05, 21.5, 21.0, 21.45, 9500),
    candle(21.45, 21.9, 21.4, 21.85, 11000),
    candle(21.85, 21.88, 21.7, 21.78, 4000), // the one soft candle
  ];
}

/** Several candles capped at the same ceiling after a run up. */
function flatTopCandles() {
  clock = 0;
  return [
    candle(5.0, 5.1, 4.98, 5.08, 4000),
    candle(5.08, 5.35, 5.05, 5.32, 7000),
    candle(5.32, 5.6, 5.3, 5.58, 8000),
    candle(5.58, 5.8, 5.55, 5.76, 9000),
    // ceiling at 5.80 tested four times
    candle(5.76, 5.8, 5.7, 5.74, 5000),
    candle(5.74, 5.8, 5.68, 5.78, 4800),
    candle(5.78, 5.79, 5.71, 5.75, 4500),
    candle(5.75, 5.8, 5.72, 5.77, 4300),
  ];
}

/** Sideways chop that no detector should call a setup. */
function chopCandles() {
  clock = 0;
  return [
    candle(8.0, 8.04, 7.96, 7.99, 1000),
    candle(7.99, 8.03, 7.95, 8.01, 1000),
    candle(8.01, 8.05, 7.97, 7.98, 1000),
    candle(7.98, 8.02, 7.94, 8.0, 1000),
    candle(8.0, 8.04, 7.96, 7.97, 1000),
    candle(7.97, 8.01, 7.93, 7.99, 1000),
    candle(7.99, 8.03, 7.95, 8.0, 1000),
  ];
}

/* ------------------------------------------------------------------ */
/* pattern detection                                                   */
/* ------------------------------------------------------------------ */

test('bull flag is detected with the trigger above the pullback high', () => {
  const setups = detectPatterns(bullFlagCandles());
  const flag = setups.find((s) => s.type === 'bull_flag');
  assert.ok(flag, 'expected a bull flag');
  assert.equal(flag.entry, 11.2); // 11.19 pullback high + one tick
  assert.equal(flag.stop, 10.88); // lowest low of the pullback
  assert.ok(flag.entry > flag.stop);
  assert.equal(flag.volumeDrying, true);
});

test('micro pullback is detected and stops tighter than a flag would', () => {
  const setup = bestPattern(microPullbackCandles());
  assert.equal(setup.type, 'micro_pullback');
  assert.equal(setup.entry, 21.89);
  assert.equal(setup.stop, 21.7);
  assert.ok(setup.riskPct < 1.5, `stop should be tight, got ${setup.riskPct}%`);
});

test('flat top is detected at the ceiling', () => {
  const setups = detectPatterns(flatTopCandles());
  const flat = setups.find((s) => s.type === 'flat_top');
  assert.ok(flat, 'expected a flat top');
  assert.equal(flat.entry, 5.81); // ceiling 5.80 + one tick
  assert.ok(flat.stop < flat.entry);
});

test('sideways chop produces no setup', () => {
  assert.deepEqual(detectPatterns(chopCandles()), []);
  assert.equal(bestPattern(chopCandles()), null);
});

test('a pullback deeper than the retrace limit is not a flag', () => {
  clock = 0;
  const collapsed = [
    candle(10.0, 10.2, 9.98, 10.18, 5000),
    candle(10.18, 10.6, 10.15, 10.55, 8000),
    candle(10.55, 11.0, 10.5, 10.95, 9000),
    candle(10.95, 11.2, 10.9, 11.15, 9500),
    // gives back essentially the whole leg
    candle(11.15, 11.16, 10.1, 10.15, 12000),
    candle(10.15, 10.2, 10.0, 10.05, 11000),
  ];
  const setups = detectPatterns(collapsed);
  assert.equal(setups.find((s) => s.type === 'bull_flag'), undefined);
});

test('a setup already far below price is dropped rather than chased', () => {
  clock = 0;
  const extended = [
    ...bullFlagCandles(),
    // price rips well through the trigger before we look
    candle(10.98, 12.6, 10.97, 12.55, 20000),
  ];
  for (const setup of detectPatterns(extended)) {
    assert.ok(
      extended.at(-1).close <= setup.entry * 1.015,
      `${setup.type} trigger is ${setup.entry} against a close of ${extended.at(-1).close}`,
    );
  }
});

test('malformed or too-short candle series return no setups', () => {
  assert.deepEqual(detectPatterns([]), []);
  assert.deepEqual(detectPatterns(null), []);
  assert.deepEqual(detectPatterns([{ open: 1, high: 2, low: 3, close: NaN }]), []);
});

test('detected setups always have a stop below the entry', () => {
  for (const candles of [bullFlagCandles(), microPullbackCandles(), flatTopCandles()]) {
    for (const setup of detectPatterns(candles)) {
      assert.ok(setup.stop < setup.entry, `${setup.type}: stop ${setup.stop} >= entry ${setup.entry}`);
      assert.ok(setup.riskPerShare > 0);
    }
  }
});

/* ------------------------------------------------------------------ */
/* trade plan                                                          */
/* ------------------------------------------------------------------ */

test('position size comes from the risk budget divided by the stop distance', () => {
  // $25k account, 1% risk = $250. Stop is $0.50 away -> 500 shares.
  const plan = buildTradePlan({ entry: 10.5, stop: 10.0 }, { accountSize: 25_000, maxRiskPerTradePct: 1 });
  assert.equal(plan.shares, 500);
  assert.equal(plan.maxLoss, 250);
  assert.equal(plan.riskPerShare, 0.5);
  assert.equal(plan.tradable, true);
});

test('a tighter stop buys more shares at identical dollar risk', () => {
  const wide = buildTradePlan({ entry: 10.5, stop: 10.0 }, { accountSize: 25_000 });
  const tight = buildTradePlan({ entry: 10.5, stop: 10.25 }, { accountSize: 25_000 });
  assert.ok(tight.shares > wide.shares);
  assert.equal(tight.maxLoss, wide.maxLoss); // the whole point: same risk
});

test('targets are priced in R and scale out of the position', () => {
  const plan = buildTradePlan(
    { entry: 10.0, stop: 9.5 },
    { accountSize: 20_000, maxRiskPerTradePct: 1, targetRatios: [2, 3], scaleOutPct: 50 },
  );
  const [first, second] = plan.targets;
  assert.equal(first.ratio, 2);
  assert.equal(first.price, 11.0); // entry + 2 x 0.50
  assert.equal(second.price, 11.5); // entry + 3 x 0.50
  assert.equal(first.sharesOut + second.sharesOut, plan.shares);
  assert.ok(plan.blendedRatio >= 2, `blended payoff ${plan.blendedRatio} should clear 2:1`);
});

test('the stop moves to breakeven once the first target pays', () => {
  const plan = buildTradePlan({ entry: 10.0, stop: 9.5 }, {});
  assert.equal(plan.stopAfterFirstTarget, 10.0);
});

test('a stop wider than the limit blocks the trade with a reason', () => {
  const plan = buildTradePlan({ entry: 10.0, stop: 8.5 }, { maxRiskPerSharePct: 8 });
  assert.equal(plan.tradable, false);
  assert.match(plan.blockers.join(' '), /wider than the 8% limit/);
});

test('size is trimmed to what the tape can absorb', () => {
  // Risk budget alone would want 500 shares; 2% of a 5,000-share minute is 100.
  const plan = buildTradePlan(
    { entry: 10.5, stop: 10.0 },
    { accountSize: 25_000, maxRiskPerTradePct: 1, maxPctOfCandleVolume: 2 },
    { recentCandleVolume: 5000 },
  );
  assert.equal(plan.shares, 100);
  assert.match(plan.sizingNotes.join(' '), /per-minute volume/);
  assert.ok(plan.maxLoss < 250, 'trimming size must reduce the risk, not just the count');
});

test('size is capped by the account notional', () => {
  const plan = buildTradePlan(
    { entry: 50, stop: 49.9 },
    { accountSize: 10_000, maxRiskPerTradePct: 5, maxPositionPctOfAccount: 100, maxRiskPerSharePct: 8 },
  );
  assert.ok(plan.positionCost <= 10_000, `position cost ${plan.positionCost} exceeds the account`);
});

test('an unaffordable stop distance blocks rather than rounding to zero shares', () => {
  // $50 account risking 1% is a $0.50 budget against $1.00 of risk per share —
  // not even one share fits, so the plan must say so rather than return zero.
  const plan = buildTradePlan({ entry: 100, stop: 99 }, { accountSize: 50, maxRiskPerTradePct: 1 });
  assert.equal(plan.tradable, false);
  assert.equal(plan.shares, 0);
  assert.match(plan.blockers.join(' '), /too small/);
});

test('a budget that affords exactly one share is tradable', () => {
  const plan = buildTradePlan({ entry: 100, stop: 95 }, { accountSize: 500, maxRiskPerTradePct: 1 });
  assert.equal(plan.shares, 1);
  assert.equal(plan.tradable, true);
  assert.equal(plan.maxLoss, 5);
});

test('an invalid setup returns a blocked plan instead of throwing', () => {
  for (const bad of [null, {}, { entry: 5, stop: 5 }, { entry: 5, stop: 9 }]) {
    const plan = buildTradePlan(bad, {});
    assert.equal(plan.tradable, false);
    assert.ok(plan.blockers.length > 0);
  }
});

/* ------------------------------------------------------------------ */
/* journal and daily rules                                             */
/* ------------------------------------------------------------------ */

async function tempJournal() {
  const dir = await mkdtemp(join(tmpdir(), 'journal-'));
  return { journal: new Journal(join(dir, 'trades.json')), dir };
}

test('a closed trade derives P&L and R', async () => {
  const { journal, dir } = await tempJournal();
  try {
    const trade = await journal.record({ symbol: 'runr', entry: 10, stop: 9.5, shares: 200 }, NOW);
    assert.equal(trade.symbol, 'RUNR');
    assert.equal(trade.plannedRisk, 100);

    const closed = await journal.close(trade.id, 11, NOW + 60_000);
    assert.equal(closed.pnl, 200); // (11 - 10) x 200
    assert.equal(closed.rMultiple, 2); // 1.00 gain on 0.50 of risk
    assert.equal(closed.status, 'closed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stats report win rate, payoff ratio and expectancy', async () => {
  const { journal, dir } = await tempJournal();
  try {
    const a = await journal.record({ symbol: 'AAA', entry: 10, stop: 9.5, shares: 100 }, NOW);
    const b = await journal.record({ symbol: 'BBB', entry: 20, stop: 19.5, shares: 100 }, NOW);
    const c = await journal.record({ symbol: 'CCC', entry: 30, stop: 29.5, shares: 100 }, NOW);
    await journal.close(a.id, 11, NOW); // +100, +2R
    await journal.close(b.id, 19.5, NOW); // -50, -1R
    await journal.close(c.id, 29.5, NOW); // -50, -1R

    const stats = journal.stats();
    assert.equal(stats.closed, 3);
    assert.equal(stats.wins, 1);
    assert.equal(stats.losses, 2);
    assert.equal(stats.winRatePct, 33.33);
    assert.equal(stats.netPnl, 0);
    assert.equal(stats.profitLossRatio, 2); // avg win 100 / avg loss 50
    assert.equal(stats.totalR, 0);
    // A 33% win rate at 2:1 is break-even — the arithmetic the target protects.
    assert.equal(stats.expectancyR, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an implausible exit price is refused rather than poisoning the stats', async () => {
  const { journal, dir } = await tempJournal();
  try {
    const trade = await journal.record({ symbol: 'TYPO', entry: 7.32, stop: 7.18, shares: 100 }, NOW);
    // A day trade does not go from $7.32 to $99 — that is a fat finger.
    await assert.rejects(() => journal.close(trade.id, 99, NOW), RangeError);
    assert.equal(journal.trades[0].status, 'open', 'the trade must stay open');
    assert.equal(journal.stats().closed, 0);

    // A realistic exit still works.
    const closed = await journal.close(trade.id, 7.6, NOW);
    assert.equal(closed.status, 'closed');
    assert.equal(closed.pnl, 28);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a zero or negative exit price is rejected', async () => {
  const { journal, dir } = await tempJournal();
  try {
    const trade = await journal.record({ symbol: 'ZERO', entry: 10, stop: 9.5, shares: 100 }, NOW);
    assert.equal(await journal.close(trade.id, 0, NOW), null);
    assert.equal(await journal.close(trade.id, -5, NOW), null);
    assert.equal(journal.trades[0].status, 'open');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('open trades are excluded from results but counted', async () => {
  const { journal, dir } = await tempJournal();
  try {
    await journal.record({ symbol: 'OPEN', entry: 10, stop: 9.5, shares: 100 }, NOW);
    const stats = journal.stats();
    assert.equal(stats.open, 1);
    assert.equal(stats.closed, 0);
    assert.equal(stats.winRatePct, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the daily loss limit blocks further trading', async () => {
  const { journal, dir } = await tempJournal();
  try {
    const day = easternMinutes(new Date(NOW)).date;
    const trade = await journal.record({ symbol: 'BAD', entry: 10, stop: 9, shares: 400 }, NOW);
    await journal.close(trade.id, 9.0, NOW); // -$400 on a $10k account = -4%

    const check = journal.checkRules(10_000, { maxDailyLossPct: 3 }, NOW);
    assert.equal(check.allowed, false);
    assert.match(check.blockers.join(' '), /Daily loss limit hit/);
    assert.equal(check.state.tradingDay, day);
    assert.equal(check.state.netPnl, -400);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the trade cap blocks further trading', async () => {
  const { journal, dir } = await tempJournal();
  try {
    for (let i = 0; i < 3; i += 1) {
      await journal.record({ symbol: `S${i}`, entry: 10, stop: 9.9, shares: 10 }, NOW);
    }
    const check = journal.checkRules(50_000, { maxTradesPerDay: 3 }, NOW);
    assert.equal(check.allowed, false);
    assert.match(check.blockers.join(' '), /Trade cap reached/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('consecutive losses trigger a cooldown', async () => {
  const { journal, dir } = await tempJournal();
  try {
    for (let i = 0; i < 3; i += 1) {
      const t = await journal.record({ symbol: `L${i}`, entry: 10, stop: 9.9, shares: 10 }, NOW);
      await journal.close(t.id, 9.9, NOW + i * 1000); // small losses
    }
    const check = journal.checkRules(100_000, { maxConsecutiveLosses: 3 }, NOW);
    assert.equal(check.allowed, false);
    assert.match(check.blockers.join(' '), /losses in a row/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a clean slate allows trading', async () => {
  const { journal, dir } = await tempJournal();
  try {
    const check = journal.checkRules(25_000, {}, NOW);
    assert.equal(check.allowed, true);
    assert.deepEqual(check.blockers, []);
    assert.equal(check.state.tradesToday, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('trades persist across journal instances', async () => {
  const { journal, dir } = await tempJournal();
  try {
    await journal.record({ symbol: 'PERS', entry: 10, stop: 9.5, shares: 100 }, NOW);
    const reopened = new Journal(journal.path);
    await reopened.load();
    assert.equal(reopened.trades.length, 1);
    assert.equal(reopened.trades[0].symbol, 'PERS');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* end to end over the mock feed                                       */
/* ------------------------------------------------------------------ */

test('qualified mock stocks produce sized, coherent trade plans', () => {
  const { quotes } = getQuotes({ now: NOW });
  const qualified = scan(quotes, {}, NOW).filter((r) => r.qualified);
  assert.ok(qualified.length >= 3);

  let planned = 0;
  for (const result of qualified) {
    assert.ok(Array.isArray(result.candles) && result.candles.length >= 20, `${result.symbol} candles`);

    const setup = bestPattern(result.candles);
    if (!setup) continue;
    planned += 1;

    const plan = buildTradePlan(setup, DEFAULT_RISK_CONFIG, { recentCandleVolume: 10_000 });
    assert.ok(plan.stop < plan.entry, `${result.symbol} stop below entry`);
    if (plan.tradable) {
      assert.ok(plan.shares > 0, `${result.symbol} shares`);
      // Risk must never exceed the budget it was sized from.
      assert.ok(
        plan.maxLoss <= plan.maxRiskBudget + 0.01,
        `${result.symbol} risks ${plan.maxLoss} against a ${plan.maxRiskBudget} budget`,
      );
      assert.ok(plan.targets.every((t) => t.price > plan.entry));
    }
  }
  assert.ok(planned > 0, 'expected at least one qualified stock to present a setup');
});

test('mock candles are internally consistent OHLC bars', () => {
  const { quotes } = getQuotes({ now: NOW });
  for (const quote of quotes) {
    for (const c of quote.candles) {
      assert.ok(c.high >= c.low, `${quote.symbol} high<low`);
      assert.ok(c.high >= Math.max(c.open, c.close) - 1e-9, `${quote.symbol} high below body`);
      assert.ok(c.low <= Math.min(c.open, c.close) + 1e-9, `${quote.symbol} low above body`);
      assert.ok(c.low > 0 && c.volume > 0, `${quote.symbol} non-positive value`);
    }
  }
});
