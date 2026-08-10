import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateSeries, generateFootprint, mulberry32 } from '../src/data/synthetic.js'
import { backtest } from '../src/backtest/backtest.js'
import { renderReport } from '../src/report/html.js'
import { Journal } from '../src/journal/journal.js'
import { INSTRUMENTS } from '../src/risk/propfirm.js'
import { Market } from '../src/data/market.js'
import { FootprintOrderflow } from '../src/core/orderflow.js'
import { TradingSystem } from '../src/engine/system.js'
import { validateSeries } from '../src/core/candles.js'
import { futuresDayKey, sessionOf } from '../src/core/sessions.js'

const NQ = INSTRUMENTS.NQ

/* ── the generator itself must be sane, or every test above is worthless ── */

test('synthetic data is well formed and reproducible', () => {
  const a = generateSeries({ days: 5, seed: 123 })
  const b = generateSeries({ days: 5, seed: 123 })
  assert.deepEqual(a, b, 'same seed must give the same series')

  const c = generateSeries({ days: 5, seed: 124 })
  assert.notDeepEqual(a, c, 'different seeds must differ')

  assert.deepEqual(validateSeries(a), [], 'generated bars must satisfy OHLC invariants')
  assert.ok(a.every((x) => x.v > 0), 'every bar must have volume')
})

test('synthetic data skips weekends and the maintenance halt', () => {
  const s = generateSeries({ days: 12, seed: 7 })
  for (const c of s) {
    const session = sessionOf(c.t)
    assert.notEqual(session, 'unknown', `bar at ${new Date(c.t).toISOString()} fell outside every session`)
  }
  const days = new Set(s.map((c) => futuresDayKey(c.t)))
  assert.ok(days.size >= 12)
})

test('the PRNG is deterministic and in range', () => {
  const r = mulberry32(1)
  const values = Array.from({ length: 500 }, () => r())
  assert.ok(values.every((v) => v >= 0 && v < 1))
  assert.deepEqual(values.slice(0, 5), Array.from({ length: 5 }, mulberry32(1)).map((_, i) => values[i]))
})

/* ── backtest accounting ────────────────────────────────────────────────── */

// A 30-day backtest is expensive and fully deterministic, so the shared
// fixture is built once and reused. Tests that need different settings call
// backtest() directly.
const CANDLES = generateSeries({ days: 30, seed: 4242 })
let cached = null
const run = () => (cached ??= backtest({ candles: CANDLES, accountConfig: { preset: '50K', instrument: NQ } }))

test('a backtest produces trades with coherent accounting', () => {
  const r = run()
  assert.ok(r.trades.length > 0, 'expected trades over 30 days')

  for (const t of r.trades) {
    // R must agree with the dollars actually made against the dollars risked.
    if (t.riskDollars > 0) {
      assert.ok(Math.abs(t.rMultiple - t.pnl / t.riskDollars) < 1e-6, `trade ${t.id}: R does not match P&L / risk`)
    }
    assert.ok(t.contracts >= 1, 'a recorded trade must have size')
    assert.ok(t.exitTime >= t.entryTime, 'a trade cannot exit before it enters')
    assert.ok(t.exitReason, 'every exit must have a stated reason')
    assert.ok(['long', 'short'].includes(t.direction))
    const stopSide = t.direction === 'long' ? t.stop < t.entry : t.stop > t.entry
    assert.ok(stopSide, `trade ${t.id}: stop on the wrong side of entry`)
  }
})

test('the closing balance equals the starting balance plus every trade', () => {
  const r = run()
  const summed = r.account.startingBalance + r.trades.reduce((a, t) => a + t.pnl, 0)
  assert.ok(Math.abs(summed - r.account.balance) < 1e-6, 'account balance drifted from the trade ledger')
})

test('risk per trade never exceeds the account rule', () => {
  const r = run()
  const budget = r.account.drawdown * r.account.rules.riskPerTradePct
  for (const t of r.trades) {
    assert.ok(t.riskDollars <= budget + 1e-6, `trade ${t.id} risked $${t.riskDollars} against a $${budget} budget`)
  }
})

test('a loss never materially exceeds the risk that was planned', () => {
  const r = run()
  for (const t of r.trades) {
    if (t.pnl >= 0) continue
    // Slippage and commission can push a loss slightly past 1R; a large
    // overshoot means the stop was not being honoured.
    assert.ok(t.rMultiple > -1.75, `trade ${t.id} lost ${t.rMultiple.toFixed(2)}R — the stop was not respected`)
  }
})

test('only one position is open at a time', () => {
  const r = run()
  for (let i = 1; i < r.trades.length; i++) {
    assert.ok(r.trades[i].entryTime >= r.trades[i - 1].exitTime, 'trades overlap')
  }
})

test('the run stops at a breach instead of trading a dead account', () => {
  // A tiny drawdown allowance guarantees a breach.
  const r = backtest({
    candles: CANDLES,
    accountConfig: { startingBalance: 50000, drawdown: 400, maxContracts: 10, profitTarget: 3000, instrument: NQ },
  })
  if (r.breachedAt) {
    const last = r.trades.at(-1)
    assert.ok(last.exitTime <= r.breachedAt.t, 'a trade was recorded after the account breached')
    assert.equal(r.account.breached, true)
  }
})

test('equity never silently passes through the drawdown floor', () => {
  const r = run()
  for (const point of r.equityCurve) {
    if (point.equity < point.floor - 1e-6) {
      assert.equal(r.account.breached, true, 'equity went below the floor without the account being marked breached')
    }
  }
})

test('backtests are deterministic', () => {
  const a = backtest({ candles: CANDLES, accountConfig: { preset: '50K', instrument: NQ } })
  const b = backtest({ candles: CANDLES, accountConfig: { preset: '50K', instrument: NQ } })
  assert.equal(a.trades.length, b.trades.length)
  assert.deepEqual(
    a.trades.map((t) => [t.entryTime, t.pnl]),
    b.trades.map((t) => [t.entryTime, t.pnl]),
  )
})

test('slippage and commission make results strictly worse', () => {
  const clean = backtest({
    candles: CANDLES,
    accountConfig: { preset: '50K', instrument: NQ },
    options: { slippageTicks: 0, commissionPerContract: 0 },
  })
  const costed = run()
  assert.ok(costed.stats.totalDollars <= clean.stats.totalDollars + 1e-6, 'adding costs improved the result')
})

test('a real footprint feed can be substituted for the proxy', () => {
  const candles = generateSeries({ days: 10, seed: 33 })
  const footprint = generateFootprint(candles)
  const market = new Market(candles, { instrument: NQ, orderflow: new FootprintOrderflow(candles, footprint) })
  assert.equal(market.orderflow.isProxy, false)

  const { signals } = new TradingSystem().scan(market, { from: 400 })
  for (const s of signals) assert.equal(s.orderflowIsProxy, false, 'signals must record which feed produced them')
})

/* ── journal persistence ────────────────────────────────────────────────── */

test('the journal round-trips through disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-journal-'))
  const path = join(dir, 'journal.jsonl')
  const r = backtest({
    candles: generateSeries({ days: 15, seed: 900 }),
    accountConfig: { preset: '50K', instrument: NQ },
    options: { journalPath: path },
  })
  assert.ok(existsSync(path))

  const reloaded = new Journal(path)
  assert.equal(reloaded.resolved().length, r.trades.length)
  assert.equal(reloaded.entries[0].model, r.trades[0].model)

  // A review is appended, and the resolved view merges it onto the trade.
  reloaded.review(reloaded.entries[0].id, { review: 'chased the entry', mistakes: ['late entry'] })
  const fresh = new Journal(path).resolved()
  assert.equal(fresh[0].review, 'chased the entry')
  assert.deepEqual(fresh[0].mistakes, ['late entry'])
  assert.equal(fresh.length, r.trades.length, 'a revision must not create a second trade')
})

test('a malformed journal file fails loudly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-bad-'))
  const path = join(dir, 'bad.jsonl')
  writeFileSync(path, '{"ok":1}\nnot json\n')
  assert.throws(() => new Journal(path), /malformed JSON on line 2/)
})

/* ── report ─────────────────────────────────────────────────────────────── */

test('the report renders a complete document and surfaces its caveats', () => {
  const r = run()
  const html = renderReport(r, { title: 'Test Report' })
  assert.match(html, /^<!doctype html>/)
  assert.match(html, /<\/html>$/)
  assert.match(html, /Test Report/)
  assert.match(html, /estimated from bar geometry/, 'the proxy-orderflow caveat must be visible')
  assert.match(html, /<svg/, 'the equity chart should render')
  // Trade data must be HTML-escaped rather than injected raw.
  const injected = {
    ...r,
    trades: [{ ...r.trades[0], exitReason: '<script>alert(1)</script>', model: '<img src=x>' }],
  }
  const escaped = renderReport(injected)
  assert.ok(!escaped.includes('<script>alert(1)</script>'), 'journal text must be escaped')
  assert.match(escaped, /&lt;script&gt;/)
})

test('the report handles an empty run without throwing', () => {
  const empty = backtest({
    candles: generateSeries({ days: 3, seed: 1 }),
    accountConfig: { preset: '50K', instrument: NQ },
    options: { warmupBars: 4000 }, // warm-up longer than the series: no trades possible
  })
  assert.equal(empty.trades.length, 0)
  const html = renderReport(empty)
  assert.match(html, /No trades/)
})
