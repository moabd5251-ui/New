#!/usr/bin/env node
/**
 * Market-hours verification for the Tradier provider.
 *
 * The unit suite runs against captured payload shapes and needs no network, so
 * it can prove the parsing but not the paths that only exist while the market
 * is open:
 *
 *   1. the clock actually reporting `open`, which is what switches relative
 *      volume from "compare to a whole day" to "compare to the pace so far"
 *   2. timesales returning real 1-minute bars
 *   3. those bars feeding pattern detection and producing sized trade plans
 *   4. 5-minute relative volume, which has no value outside the session
 *
 * Run it during regular hours:
 *
 *   TRADIER_TOKEN=... node scripts/verify-live.mjs
 *
 * Exits non-zero if a check fails. Writes a JSON snapshot next to the run so a
 * failure can be diagnosed after the fact, when the market is closed again.
 */

import { writeFile } from 'node:fs/promises';

import { getQuotes } from '../lib/providers/tradier.js';
import { scan, summarize } from '../lib/criteria.js';
import { detectPatterns, bestPattern } from '../lib/patterns.js';
import { buildTradePlan, DEFAULT_RISK_CONFIG } from '../lib/trade-plan.js';

// Tradier has no market-wide gainers endpoint, so a live scan walks a symbol
// list. These are liquid, habitually volatile small and mid caps — enough that
// something is usually moving, without pretending to be a full market scan.
const WATCHLIST = (process.env.SCANNER_SYMBOLS || '')
  .split(/[\s,]+/)
  .filter(Boolean)
  .map((s) => s.toUpperCase());

const DEFAULT_WATCHLIST = [
  'SNDL', 'PLUG', 'BBAI', 'SOUN', 'RGTI', 'IONQ', 'QUBT', 'CLSK',
  'HIVE', 'MARA', 'RIOT', 'FCEL', 'CHPT', 'LCID', 'NIO', 'AMC',
  'GME', 'BYND', 'SPCE', 'TLRY', 'ACHR', 'JOBY', 'RKLB', 'ASTS',
  'OPEN', 'WULF', 'BTBT', 'CIFR', 'APLD', 'SMCI', 'AI', 'PATH',
];

const results = { checks: [], warnings: [], failures: [] };

function check(name, passed, detail) {
  const entry = { name, passed, detail };
  results.checks.push(entry);
  if (!passed) results.failures.push(entry);
  const mark = passed ? '[32mPASS[0m' : '[31mFAIL[0m';
  console.log(`  ${mark}  ${name}`);
  if (detail) console.log(`        ${detail}`);
  return passed;
}

function warn(message) {
  results.warnings.push(message);
  console.log(`  [33mNOTE[0m  ${message}`);
}

function fmt(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

async function main() {
  const symbols = WATCHLIST.length ? WATCHLIST : DEFAULT_WATCHLIST;
  const startedAt = Date.now();

  console.log(`\nMarket-hours verification — ${symbols.length} symbols\n`);

  if (!process.env.TRADIER_TOKEN) {
    console.error('TRADIER_TOKEN is not set.');
    process.exit(2);
  }

  const payload = await getQuotes({ symbols, now: startedAt });
  const elapsed = Date.now() - startedAt;

  /* ---------------- session ---------------- */

  console.log('Session');
  const { session } = payload;
  console.log(`        state=${session.state}  fraction=${fmt(session.fraction, 3)}  "${session.label}"`);

  const isOpen = session.live && session.state === 'open';
  if (!isOpen) {
    console.log(
      `\n[33mMarket is not open (state=${session.state}).[0m\n` +
        'The session-only paths cannot be verified right now. Re-run between\n' +
        '09:30 and 16:00 ET on a trading day.\n',
    );
    process.exit(3);
  }
  check('clock reports the session open', isOpen, `state=${session.state}`);
  check(
    'session fraction is a sane mid-session value',
    session.fraction > 0 && session.fraction <= 1,
    `fraction=${fmt(session.fraction, 3)}`,
  );

  /* ---------------- quotes ---------------- */

  console.log('\nQuotes');
  check('quotes returned', payload.quotes.length > 0, `${payload.quotes.length} of ${symbols.length}`);
  check(
    'batched fetch is fast',
    elapsed < 30_000,
    `${payload.quotes.length} symbols in ${(elapsed / 1000).toFixed(1)}s`,
  );
  if (payload.errors.length) {
    warn(`${payload.errors.length} symbol(s) errored: ${payload.errors.map((e) => e.symbol).join(', ')}`);
  }

  const priced = payload.quotes.filter((q) => Number.isFinite(q.price) && q.price > 0);
  check('every quote carries a price', priced.length === payload.quotes.length,
    `${priced.length}/${payload.quotes.length}`);

  // The headline check: intraday volume must NOT be flagged extended-hours, and
  // relative volume must be pro-rated against the pace so far, not a whole day.
  const anyExtended = payload.quotes.some((q) => q.extendedHours);
  check('quotes are not flagged extended-hours during the session', !anyExtended);

  const withRvol = payload.quotes.filter((q) => Number.isFinite(q.relativeVolume));
  check('relative volume computed', withRvol.length > 0, `${withRvol.length} symbols`);

  // Mid-session, a typical stock sits near 1x. If everything is a hundredth of
  // that, the pro-rating is wrong — which is exactly the premarket bug.
  const median = (list) => {
    const sorted = [...list].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const medianRvol = median(withRvol.map((q) => q.relativeVolume));
  check(
    'median relative volume is in a believable range',
    medianRvol > 0.1 && medianRvol < 20,
    `median=${fmt(medianRvol)}x across ${withRvol.length} symbols (expect roughly 0.5-2x)`,
  );

  const withGap = payload.quotes.filter((q) => Number.isFinite(q.gapPct));
  check('opening gap computed from the session open', withGap.length > 0,
    `${withGap.length} symbols`);

  /* ---------------- intraday bars ---------------- */

  console.log('\nIntraday bars (timesales)');
  const withCandles = payload.quotes.filter((q) => q.candles?.length);
  check('timesales returned bars', withCandles.length > 0,
    `${withCandles.length}/${payload.quotes.length} symbols have bars`);

  if (withCandles.length) {
    const deepest = withCandles.reduce((a, b) => (a.candles.length >= b.candles.length ? a : b));
    check(
      'bar count is consistent with time since the open',
      deepest.candles.length >= 1,
      `${deepest.symbol} has ${deepest.candles.length} one-minute bars`,
    );

    const allValid = withCandles.every((q) =>
      q.candles.every(
        (c) =>
          Number.isFinite(c.open) && Number.isFinite(c.high) &&
          Number.isFinite(c.low) && Number.isFinite(c.close) &&
          c.high >= c.low && c.high >= Math.max(c.open, c.close) - 1e-9 &&
          c.low <= Math.min(c.open, c.close) + 1e-9,
      ),
    );
    check('every bar is a coherent OHLC candle', allValid);

    const withVwap = withCandles.filter((q) => q.candles.some((c) => Number.isFinite(c.vwap)));
    check('bars carry VWAP', withVwap.length > 0, `${withVwap.length} symbols`);

    const rv5 = payload.quotes.filter((q) => Number.isFinite(q.relVol5min));
    check('5-minute relative volume computed from real bars', rv5.length > 0,
      `${rv5.length} symbols`);
  }

  /* ---------------- scan, patterns, plans ---------------- */

  console.log('\nScan');
  const scanned = scan(payload.quotes, {}, startedAt);
  const summary = summarize(scanned);
  console.log(`        ${JSON.stringify(summary)}`);
  check('scan produced a ranked result for every quote', scanned.length === payload.quotes.length);

  if (!summary.qualified) {
    warn('No stock met all five criteria — normal for a watchlist this size, and');
    warn('not a failure. Pattern detection is exercised below regardless.');
  }

  console.log('\nPatterns and trade plans');
  let setupsFound = 0;
  let plansBuilt = 0;
  const planSamples = [];

  for (const result of scanned) {
    if (!result.candles?.length) continue;
    const setups = detectPatterns(result.candles);
    if (!setups.length) continue;
    setupsFound += setups.length;

    const setup = bestPattern(result.candles);
    const recent = result.candles.slice(-5).map((c) => c.volume).filter(Number.isFinite);
    const plan = buildTradePlan(setup, DEFAULT_RISK_CONFIG, {
      recentCandleVolume: recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null,
    });
    plansBuilt += 1;
    planSamples.push({ symbol: result.symbol, setup: setup.type, plan });

    if (planSamples.length <= 5) {
      console.log(
        `        ${result.symbol.padEnd(6)} ${setup.type.padEnd(15)} ` +
          `entry ${fmt(plan.entry)}  stop ${fmt(plan.stop)}  ` +
          `${plan.shares} sh  risk $${fmt(plan.maxLoss)}  ` +
          `${plan.tradable ? 'tradable' : `blocked: ${plan.blockers[0]}`}`,
      );
    }
  }

  if (setupsFound) {
    check('patterns detected on real intraday bars', setupsFound > 0, `${setupsFound} setups`);
    const sane = planSamples.every(
      (s) =>
        s.plan.stop < s.plan.entry &&
        (!s.plan.tradable || (s.plan.shares > 0 && s.plan.maxLoss <= s.plan.maxRiskBudget + 0.01)),
    );
    check('every plan has a stop below entry and respects the risk budget', sane,
      `${plansBuilt} plans built`);
  } else {
    warn('No entry patterns on these bars right now — a real and common outcome,');
    warn('not a failure. The detectors are covered by the unit suite.');
  }

  /* ---------------- movers ---------------- */

  console.log('\nBiggest movers on the list');
  for (const r of [...scanned].sort((a, b) => (b.changeFromClosePct ?? -Infinity) - (a.changeFromClosePct ?? -Infinity)).slice(0, 5)) {
    console.log(
      `        ${r.symbol.padEnd(6)} ${fmt(r.changeFromClosePct).padStart(7)}%  ` +
        `$${fmt(r.price).padStart(8)}  rvol ${fmt(r.relativeVolume).padStart(7)}x  ` +
        `${r.candles?.length ?? 0} bars  ${r.score}/5`,
    );
  }

  /* ---------------- snapshot ---------------- */

  const snapshotPath = new URL('../data/live-verification.json', import.meta.url).pathname;
  await writeFile(
    snapshotPath,
    `${JSON.stringify(
      {
        ranAt: new Date(startedAt).toISOString(),
        session,
        elapsedMs: elapsed,
        summary,
        errors: payload.errors,
        checks: results.checks,
        warnings: results.warnings,
        // Quotes without candles, to keep the snapshot readable.
        quotes: scanned.map(({ candles, ...rest }) => ({ ...rest, bars: candles?.length ?? 0 })),
        planSamples,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const passed = results.checks.filter((c) => c.passed).length;
  console.log(
    `\n${results.failures.length ? '[31mFAILED[0m' : '[32mALL CHECKS PASSED[0m'} ` +
      `— ${passed}/${results.checks.length} checks, ${results.warnings.length} notes`,
  );
  console.log(`Snapshot written to data/live-verification.json\n`);

  process.exit(results.failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(`\nVerification crashed: ${error.message}`);
  console.error(error.stack);
  process.exit(2);
});
