import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, scan, summarize, freshNews, DEFAULT_CONFIG } from '../lib/criteria.js';
import { AlertTracker } from '../lib/alerts.js';
import { parseSymbols } from '../lib/watchlist.js';
import { getQuotes, sessionProgress } from '../lib/providers/mock.js';
import { deriveMetrics } from '../lib/providers/live.js';

const NOW = Date.parse('2026-08-05T14:00:00Z');

/** A quote that clears all five criteria; tests bend one field at a time. */
function baseQuote(overrides = {}) {
  return {
    symbol: 'TEST',
    price: 8.5,
    prevClose: 4.0,
    changeFromClosePct: 112.5,
    relativeVolume: 42,
    float: 2_400_000,
    gapPct: 30,
    volume: 5_000_000,
    news: [{ headline: 'Company reports positive trial data', datetime: new Date(NOW - 30 * 60_000).toISOString() }],
    ...overrides,
  };
}

test('a stock meeting all five criteria qualifies', () => {
  const result = evaluate(baseQuote(), {}, NOW);
  assert.equal(result.score, 5);
  assert.equal(result.qualified, true);
  assert.equal(result.grade, 'A+'); // 5/5 plus a gap up
  assert.ok(result.pillars.every((p) => p.passed));
});

test('each criterion can independently disqualify a stock', () => {
  const cases = [
    ['change', { changeFromClosePct: 6 }],
    ['relativeVolume', { relativeVolume: 2 }],
    ['news', { news: [] }],
    ['price', { price: 44 }],
    ['float', { float: 90_000_000 }],
  ];

  for (const [pillarId, override] of cases) {
    const result = evaluate(baseQuote(override), {}, NOW);
    assert.equal(result.qualified, false, `${pillarId} should disqualify`);
    assert.equal(result.score, 4, `${pillarId} should be the only failure`);
    const failed = result.pillars.find((p) => !p.passed);
    assert.equal(failed.id, pillarId);
  }
});

test('price is checked at both ends of the range', () => {
  assert.equal(evaluate(baseQuote({ price: 1.5 }), {}, NOW).qualified, false);
  assert.equal(evaluate(baseQuote({ price: 2 }), {}, NOW).qualified, true);
  assert.equal(evaluate(baseQuote({ price: 20 }), {}, NOW).qualified, true);
  assert.equal(evaluate(baseQuote({ price: 20.01 }), {}, NOW).qualified, false);
});

test('float is an exclusive bound at 20 million', () => {
  assert.equal(evaluate(baseQuote({ float: 19_999_999 }), {}, NOW).qualified, true);
  assert.equal(evaluate(baseQuote({ float: 20_000_000 }), {}, NOW).qualified, false);
});

test('stale headlines do not count as a catalyst', () => {
  const stale = baseQuote({
    news: [{ headline: 'Old news', datetime: new Date(NOW - 72 * 3600 * 1000).toISOString() }],
  });
  const result = evaluate(stale, {}, NOW);
  assert.equal(result.catalysts.length, 0);
  assert.equal(result.pillars.find((p) => p.id === 'news').passed, false);
});

test('freshNews returns matches newest first', () => {
  const news = [
    { headline: 'older', datetime: new Date(NOW - 5 * 3600 * 1000).toISOString() },
    { headline: 'newest', datetime: new Date(NOW - 1 * 3600 * 1000).toISOString() },
    { headline: 'expired', datetime: new Date(NOW - 40 * 3600 * 1000).toISOString() },
  ];
  const fresh = freshNews(news, 24, NOW);
  assert.deepEqual(fresh.map((n) => n.headline), ['newest', 'older']);
});

test('the news pillar can be switched off', () => {
  const result = evaluate(baseQuote({ news: [] }), { requireNews: false }, NOW);
  assert.equal(result.qualified, true);
});

test('thresholds are configurable', () => {
  const quote = baseQuote({ price: 45, float: 50_000_000 });
  const loose = evaluate(quote, { maxPrice: 100, maxFloat: 80_000_000 }, NOW);
  assert.equal(loose.qualified, true);
});

test('a missing field marks the pillar unavailable rather than failed silently', () => {
  const result = evaluate(baseQuote({ relativeVolume: null }), {}, NOW);
  const pillar = result.pillars.find((p) => p.id === 'relativeVolume');
  assert.equal(pillar.unavailable, true);
  assert.equal(pillar.passed, false);
  assert.equal(result.qualified, false);
});

test('an estimated float is flagged but still evaluated', () => {
  const result = evaluate(baseQuote({ floatIsEstimated: true }), {}, NOW);
  const pillar = result.pillars.find((p) => p.id === 'float');
  assert.equal(pillar.estimated, true);
  assert.equal(pillar.passed, true);
  assert.match(pillar.detail, /estimated from shares outstanding/);
});

test('a feed with no news source reports the pillar as unavailable', () => {
  const result = evaluate(baseQuote({ news: [], newsAvailable: false }), {}, NOW);
  const pillar = result.pillars.find((p) => p.id === 'news');
  assert.equal(pillar.unavailable, true);
  assert.match(pillar.detail, /FINNHUB_API_KEY/);
});

test('invalid config values fall back to the defaults per field', () => {
  const result = evaluate(baseQuote(), { minRelativeVolume: 'not a number' }, NOW);
  const pillar = result.pillars.find((p) => p.id === 'relativeVolume');
  assert.equal(pillar.target, DEFAULT_CONFIG.minRelativeVolume);
});

test('an inverted price range is corrected rather than rejecting everything', () => {
  const result = evaluate(baseQuote({ price: 8.5 }), { minPrice: 20, maxPrice: 2 }, NOW);
  assert.equal(result.pillars.find((p) => p.id === 'price').passed, true);
});

test('scan ranks qualified stocks above everything else', () => {
  const results = scan(
    [
      baseQuote({ symbol: 'WEAK', changeFromClosePct: 3, relativeVolume: 1, news: [], float: 5e7, price: 55 }),
      baseQuote({ symbol: 'GOOD' }),
      baseQuote({ symbol: 'NEAR', float: 90_000_000 }),
    ],
    {},
    NOW,
  );
  assert.deepEqual(results.map((r) => r.symbol), ['GOOD', 'NEAR', 'WEAK']);
});

test('summary counts qualifiers and per-pillar passes', () => {
  const results = scan([baseQuote({ symbol: 'A' }), baseQuote({ symbol: 'B', price: 60 })], {}, NOW);
  const summary = summarize(results);
  assert.equal(summary.scanned, 2);
  assert.equal(summary.qualified, 1);
  assert.equal(summary.pillarCounts.price, 1);
  assert.equal(summary.pillarCounts.float, 2);
});

test('alerts fire on the transition into qualifying, not on every scan', () => {
  const tracker = new AlertTracker();
  const results = scan([baseQuote({ symbol: 'RUNR' })], {}, NOW);

  assert.equal(tracker.ingest(results, NOW).length, 1);
  assert.equal(tracker.ingest(results, NOW + 30_000).length, 0, 'still qualifying, no re-alert');

  // After the re-arm window it can alert again.
  const later = NOW + 20 * 60_000;
  assert.equal(tracker.ingest(results, later).length, 1);
  assert.equal(tracker.list().length, 2);
});

test('alerts ignore stocks that never qualified', () => {
  const tracker = new AlertTracker();
  const results = scan([baseQuote({ symbol: 'MEH', float: 9e7 })], {}, NOW);
  assert.equal(tracker.ingest(results, NOW).length, 0);
  assert.equal(tracker.list().length, 0);
});

test('watchlist parsing normalizes, dedupes and rejects junk', () => {
  assert.deepEqual(parseSymbols('aapl, msft aapl'), ['AAPL', 'MSFT']);
  assert.deepEqual(parseSymbols(['brk.b', 'bad/../symbol', '']), ['BRK.B']);
  assert.deepEqual(parseSymbols(null), []);
});

test('the mock provider returns a usable universe with qualifiers', () => {
  const { quotes, session } = getQuotes({ now: NOW });
  assert.ok(quotes.length >= 20);
  assert.ok(session.fraction > 0 && session.fraction <= 1);

  for (const quote of quotes) {
    assert.ok(Number.isFinite(quote.price) && quote.price > 0, `${quote.symbol} price`);
    assert.ok(Number.isFinite(quote.relativeVolume), `${quote.symbol} rvol`);
    assert.ok(Number.isFinite(quote.float) && quote.float > 0, `${quote.symbol} float`);
  }

  const results = scan(quotes, {}, NOW);
  const qualified = results.filter((r) => r.qualified);
  assert.ok(qualified.length >= 3, `expected several qualifiers, got ${qualified.length}`);
  assert.ok(qualified.length < quotes.length, 'the scanner must reject something');
});

test('mock prices drift smoothly rather than jumping between scans', () => {
  const first = getQuotes({ now: NOW }).quotes.find((q) => q.symbol === 'VXTQ');
  const second = getQuotes({ now: NOW + 5000 }).quotes.find((q) => q.symbol === 'VXTQ');
  const driftPct = Math.abs(second.price - first.price) / first.price;
  assert.ok(driftPct > 0, 'price should move');
  assert.ok(driftPct < 0.05, `price jumped ${(driftPct * 100).toFixed(1)}% in 5 seconds`);
});

test('live metrics: relative volume is pro-rated only during the session', () => {
  // Half a normal day's volume, half way through the session, is exactly 1x.
  const midSession = deriveMetrics(
    { price: 10, prevClose: 10, open: 10, volume: 500_000, avgVolume: 1_000_000 },
    { fraction: 0.5, live: true },
  );
  assert.equal(midSession.relativeVolume, 1);

  // The same volume outside regular hours is a *completed* session, so it must
  // compare against the full average — 0.5x, not 1x.
  const afterHours = deriveMetrics(
    { price: 10, prevClose: 10, open: 10, volume: 500_000, avgVolume: 1_000_000 },
    { fraction: 1, live: false },
  );
  assert.equal(afterHours.relativeVolume, 0.5);
});

test('live metrics: change and gap are measured against the prior close', () => {
  const metrics = deriveMetrics(
    { price: 12, prevClose: 10, open: 11, volume: 1, avgVolume: 1 },
    { fraction: 1, live: false },
  );
  assert.equal(metrics.changeFromClosePct, 20);
  assert.equal(metrics.gapPct, 10);
});

test('live metrics: missing inputs yield null rather than a bogus zero', () => {
  const metrics = deriveMetrics(
    { price: 12, prevClose: null, open: null, volume: null, avgVolume: null },
    { fraction: 1, live: false },
  );
  assert.equal(metrics.changeFromClosePct, null);
  assert.equal(metrics.gapPct, null);
  assert.equal(metrics.relativeVolume, null);

  // And those nulls must reach the pillars as "unavailable", not as failures.
  const result = evaluate({ symbol: 'X', price: 12, ...metrics, float: null }, {}, NOW);
  const unavailable = result.pillars.filter((p) => p.unavailable).map((p) => p.id);
  assert.deepEqual(unavailable.sort(), ['change', 'float', 'relativeVolume']);
});

test('session progress stays inside the session and never divides by zero', () => {
  for (const iso of ['2026-08-05T13:35:00Z', '2026-08-05T19:55:00Z', '2026-08-09T15:00:00Z']) {
    const progress = sessionProgress(new Date(iso));
    assert.ok(progress.fraction > 0 && progress.fraction <= 1, iso);
    assert.ok(progress.label.length > 0);
  }
});
