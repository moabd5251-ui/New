import test from 'node:test'
import assert from 'node:assert/strict'

import { PropAccount, INSTRUMENTS, ACCOUNT_PRESETS } from '../src/risk/propfirm.js'
import { sizePosition, roundToTick, toTicks, dollarsFor } from '../src/risk/sizing.js'
import { PositionManager } from '../src/risk/management.js'
import { monteCarlo, riskCurve } from '../src/risk/survival.js'
import { Journal } from '../src/journal/journal.js'
import { buildStats, recommendations } from '../src/journal/stats.js'

const NQ = INSTRUMENTS.NQ
const bar = (t, o, h, l, c, v = 1000) => ({ t, o, h, l, c, v })
/** 10:00 ET on a January weekday, well inside the session. */
const T = (m = 0) => Date.UTC(2026, 0, 15, 15, m)

/* ── the trailing drawdown ──────────────────────────────────────────────── */

test('the trailing floor follows unrealised equity, not just closed profit', () => {
  const a = new PropAccount({ startingBalance: 50000, drawdown: 2500 })
  assert.equal(a.floor, 47500)

  // Up $1,000 on an OPEN position — the floor moves even though nothing closed.
  a.mark(1000)
  assert.equal(a.floor, 48500)

  // Give it all back: the floor stays where the peak put it. This is what kills
  // accounts — flat on the day is not flat on the drawdown.
  a.mark(0)
  assert.equal(a.floor, 48500)
  assert.equal(a.room, 1500)
})

test('an end-of-day drawdown model ignores intraday peaks', () => {
  const a = new PropAccount({ startingBalance: 50000, drawdown: 2500, rules: { drawdownModel: 'trailing-eod' } })
  a.startDay('2026-01-15')
  a.mark(1000)
  assert.equal(a.floor, 47500, 'intraday spikes must not move an EOD floor')
  a.recordTrade({ pnl: 400 })
  a.startDay('2026-01-16')
  assert.equal(a.floor, 47900, 'the floor moves on the closing balance')
})

test('a static drawdown floor never moves', () => {
  const a = new PropAccount({ startingBalance: 50000, drawdown: 2500, rules: { drawdownModel: 'static' } })
  a.mark(5000)
  assert.equal(a.floor, 47500)
})

test('the floor locks once the account is far enough ahead', () => {
  const a = new PropAccount({ startingBalance: 50000, drawdown: 2500, rules: { lockBuffer: 100 } })
  a.mark(2700) // equity 52,700 ≥ 50,000 + 2,500 + 100
  assert.equal(a.floorLocked, true)
  assert.equal(a.floor, 50100)
  a.mark(10000)
  assert.equal(a.floor, 50100, 'a locked floor stops trailing')
})

test('breaching the floor ends the account', () => {
  const a = new PropAccount({ startingBalance: 50000, drawdown: 2500 })
  a.mark(-2500)
  assert.equal(a.breached, true)
  assert.match(a.canTrade(T()).reason, /breached/)
})

/* ── daily guardrails ───────────────────────────────────────────────────── */

test('the daily loss limit blocks further trades', () => {
  const a = new PropAccount({ startingBalance: 50000, drawdown: 2500 }) // limit = 30% = $750
  a.startDay('2026-01-15')
  assert.equal(a.dailyRoom, 750)
  a.recordTrade({ pnl: -800 })
  assert.equal(a.dailyRoom, 0)
  assert.match(a.canTrade(T()).reason, /daily loss limit/)
})

test('consecutive losses stop the day', () => {
  const a = new PropAccount({ startingBalance: 50000, drawdown: 2500, rules: { maxConsecutiveLosses: 2 } })
  a.startDay('2026-01-15')
  a.recordTrade({ pnl: -50 })
  a.recordTrade({ pnl: -50 })
  assert.match(a.canTrade(T()).reason, /consecutive losses/)
  // A new day resets the counter.
  a.startDay('2026-01-16')
  assert.equal(a.canTrade(T()).allowed, true)
})

test('the flatten window covers the cash close but not the evening session', () => {
  const a = new PropAccount({ startingBalance: 50000, drawdown: 2500 })
  a.startDay('2026-01-15')
  assert.equal(a.canTrade(T(), 15 * 60 + 58).allowed, false, 'should stand aside into the close')
  // 20:00 ET is the Asia killzone — one of the better windows for this strategy.
  assert.equal(a.canTrade(T(), 20 * 60).allowed, true, 'the evening session must stay open')
})

test('the trade cap is per day and resets', () => {
  const a = new PropAccount({ startingBalance: 50000, drawdown: 2500, rules: { maxTradesPerDay: 2 } })
  a.startDay('2026-01-15')
  a.recordTrade({ pnl: 10 })
  a.recordTrade({ pnl: 10 })
  assert.match(a.canTrade(T()).reason, /trade cap/)
  a.startDay('2026-01-16')
  assert.equal(a.canTrade(T()).allowed, true)
})

test('the consistency rule flags an over-concentrated payout', () => {
  const a = new PropAccount({ startingBalance: 50000, drawdown: 2500 })
  a.startDay('d1')
  a.recordTrade({ pnl: 3000 })
  a.startDay('d2')
  a.recordTrade({ pnl: 200 })
  const c = a.consistency()
  assert.equal(c.ok, false)
  assert.ok(c.bestDayShare > 0.9)
  assert.match(c.note, /above the 30% limit/)
})

test('every preset is internally coherent', () => {
  for (const [name, p] of Object.entries(ACCOUNT_PRESETS)) {
    assert.ok(p.drawdown > 0, `${name}: no drawdown`)
    assert.ok(p.drawdown < p.startingBalance, `${name}: drawdown exceeds the account`)
    assert.ok(p.maxContracts > 0 && p.maxMicros >= p.maxContracts, `${name}: contract limits inconsistent`)
    const a = new PropAccount({ preset: name })
    assert.equal(a.floor, p.startingBalance - p.drawdown)
  }
  assert.throws(() => new PropAccount({ preset: 'NOPE' }), /Unknown account preset/)
})

/* ── sizing ─────────────────────────────────────────────────────────────── */

test('size comes from the stop distance', () => {
  const account = new PropAccount({ startingBalance: 50000, drawdown: 2500 }) // $250 risk budget
  const signal = { entry: 21000, stop: 20995, targets: [], sizeMultiplier: 1 } // 5 pts = $100/contract
  const s = sizePosition({ account, signal, instrument: NQ })
  assert.equal(s.contracts, 2)
  assert.equal(s.riskDollars, 200)
  assert.ok(s.riskDollars <= 250)
})

test('a wide stop falls back to micros rather than oversizing', () => {
  const account = new PropAccount({ startingBalance: 50000, drawdown: 2500 })
  const signal = { entry: 21000, stop: 20980, targets: [], sizeMultiplier: 1 } // 20 pts = $400 per NQ
  const s = sizePosition({ account, signal, instrument: NQ })
  assert.equal(s.symbol, 'MNQ')
  assert.equal(s.contracts, 6) // $250 / (20 pts * $2)
  assert.ok(s.riskDollars <= 250)
})

test('grade scales size down, never up', () => {
  const account = new PropAccount({ startingBalance: 50000, drawdown: 2500 })
  const full = sizePosition({ account, signal: { entry: 21000, stop: 20995, targets: [], sizeMultiplier: 1 }, instrument: NQ })
  const half = sizePosition({ account, signal: { entry: 21000, stop: 20995, targets: [], sizeMultiplier: 0.5 }, instrument: NQ })
  assert.ok(half.contracts < full.contracts)
})

test('sizing respects the remaining daily room', () => {
  const account = new PropAccount({ startingBalance: 50000, drawdown: 2500 })
  account.startDay('2026-01-15')
  account.recordTrade({ pnl: -700 }) // $50 of daily room left
  const s = sizePosition({ account, signal: { entry: 21000, stop: 20995, targets: [], sizeMultiplier: 1 }, instrument: NQ })
  assert.ok(!s.allowed || s.riskDollars <= 50, 'a trade must not exceed the room left for the day')
})

test('a zero-distance stop is refused', () => {
  const account = new PropAccount({ startingBalance: 50000, drawdown: 2500 })
  const s = sizePosition({ account, signal: { entry: 21000, stop: 21000, targets: [] }, instrument: NQ })
  assert.equal(s.allowed, false)
  assert.match(s.reason, /invalidation/)
})

test('target allocation sums exactly to the position', () => {
  const account = new PropAccount({ startingBalance: 50000, drawdown: 2500 })
  for (const stop of [20999, 20997, 20995, 20990, 20985]) {
    const signal = {
      entry: 21000,
      stop,
      sizeMultiplier: 1,
      targets: [
        { price: 21005, r: 1, label: 'T1', size: 0.5 },
        { price: 21010, r: 2, label: 'T2', size: 0.5 },
      ],
    }
    const s = sizePosition({ account, signal, instrument: NQ })
    if (!s.allowed) continue
    const allocated = s.targets.reduce((a, t) => a + t.contracts, 0)
    assert.equal(allocated, s.contracts, `allocation ${allocated} != position ${s.contracts}`)
    for (const t of s.targets) assert.ok(t.contracts > 0, 'a zero-size target should have been dropped')
  }
})

test('a single contract runs to one target instead of scaling out of itself', () => {
  const account = new PropAccount({ startingBalance: 50000, drawdown: 2500, rules: { riskPerTradePct: 0.05 } })
  const signal = {
    entry: 21000,
    stop: 20994, // $120 per NQ, budget $125 → exactly 1 contract
    sizeMultiplier: 1,
    targets: [
      { price: 21006, r: 1, label: 'T1', size: 0.5 },
      { price: 21012, r: 2, label: 'T2', size: 0.5 },
    ],
  }
  const s = sizePosition({ account, signal, instrument: NQ })
  assert.equal(s.contracts, 1)
  assert.equal(s.targets.length, 1)
  assert.equal(s.targets[0].label, 'T2')
})

test('tick helpers', () => {
  assert.equal(roundToTick(21000.13), 21000.25)
  assert.equal(toTicks(5, 0.25), 20)
  assert.equal(dollarsFor(5, 2, NQ), 200)
})

/* ── trade management ───────────────────────────────────────────────────── */

const mkManager = (over = {}, cfg = {}) =>
  new PositionManager(
    {
      direction: 'long',
      entry: 100,
      stop: 90,
      contracts: 2,
      targets: [{ price: 110, r: 1, label: 'T1', contracts: 1 }, { price: 120, r: 2, label: 'T2', contracts: 1 }],
      ...over,
    },
    cfg,
  )

test('a bar that hits both the stop and the target is treated as a loss', () => {
  const m = mkManager()
  const r = m.update(bar(T(), 100, 125, 85, 120)) // spans everything
  assert.equal(r.closed, true)
  assert.equal(r.exitPrice, 90, 'the pessimistic assumption is the only safe one')
  assert.equal(r.exitReason, 'stop loss')
})

test('a close back through half the stop distance cuts the trade', () => {
  const m = mkManager()
  const r = m.update(bar(T(), 100, 101, 94, 94.5)) // closes below 95
  assert.equal(r.closed, true)
  assert.match(r.exitReason, /50%/)
})

test('scaling at T1 moves the stop to breakeven and keeps the runner', () => {
  const m = mkManager()
  const r = m.update(bar(T(), 100, 111, 99, 110))
  assert.equal(r.closed, false, 'half the position is still open')
  assert.equal(m.remaining, 1)
  assert.equal(m.position.stop, 100)
  assert.ok(r.actions.some((a) => a.type === 'scale-out'))
  assert.ok(r.actions.some((a) => a.type === 'stop-moved'))
})

test('after breakeven the trade cannot lose', () => {
  const m = mkManager()
  m.update(bar(T(1), 100, 111, 99, 110)) // T1 → stop to breakeven
  const r = m.update(bar(T(2), 110, 111, 95, 96)) // back through entry
  assert.equal(r.closed, true)
  assert.equal(r.exitPrice, 100)
  assert.equal(r.exitReason, 'stopped at breakeven')
})

test('the point of control flipping against an open trade closes it', () => {
  const m = mkManager()
  const r = m.update(bar(T(), 100, 106, 99, 105), { poc: 104, pocFlip: { direction: 'down' }, delta: -500 })
  assert.equal(r.closed, true)
  assert.match(r.exitReason, /point of control flipped/)
})

test('sustained opposing aggression takes what is there', () => {
  const m = mkManager({}, { opposingDeltaBars: 3, orderflowExitMinR: 0.3 })
  const flow = { poc: 95, pocFlip: null, delta: -400 }
  m.update(bar(T(1), 100, 106, 100, 105), flow)
  m.update(bar(T(2), 105, 106, 104, 105), flow)
  const r = m.update(bar(T(3), 105, 106, 104, 105), flow)
  assert.equal(r.closed, true)
  assert.match(r.exitReason, /opposing aggression/)
})

test('the stop trails behind the point of control, never away from it', () => {
  const m = mkManager({}, { breakevenAtR: 1, trailBufferPoints: 2 })
  m.update(bar(T(1), 100, 111, 100, 110), { poc: 105, pocFlip: null, delta: 500 })
  const trailed = m.position.stop
  assert.ok(trailed >= 100, 'the stop moved up behind the POC')
  m.update(bar(T(2), 110, 112, 109, 111), { poc: 80, pocFlip: null, delta: 500 })
  assert.equal(m.position.stop, trailed, 'a POC that drops must not loosen the stop')
})

test('a short is managed as the mirror of a long', () => {
  const m = new PositionManager({
    direction: 'short',
    entry: 100,
    stop: 110,
    contracts: 1,
    targets: [{ price: 90, r: 1, label: 'T1', contracts: 1 }],
  })
  const r = m.update(bar(T(), 100, 101, 89, 90))
  assert.equal(r.closed, true)
  assert.equal(r.exitPrice, 90)
  assert.match(r.exitReason, /target/)
})

test('the time stop closes a scalp that never worked', () => {
  const m = mkManager({}, { maxBarsInTrade: 3, adverseCloseFraction: 0.99 })
  m.update(bar(T(1), 100, 101, 99, 100))
  m.update(bar(T(2), 100, 101, 99, 100))
  const r = m.update(bar(T(3), 100, 101, 99, 100))
  assert.equal(r.closed, true)
  assert.match(r.exitReason, /time stop/)
})

/* ── journal and statistics ─────────────────────────────────────────────── */

test('the journal derives R when it is not supplied', () => {
  const j = new Journal(null)
  const e = j.add({ entryTime: T(), exitTime: T(5), direction: 'long', entry: 100, stop: 95, exit: 110, pnl: 200, model: 'CISD' })
  assert.equal(e.rMultiple, 2)
  assert.ok(e.day)
  assert.ok(e.session)
})

test('a short trade gets a positive R when it works', () => {
  const j = new Journal(null)
  const e = j.add({ entryTime: T(), exitTime: T(5), direction: 'short', entry: 100, stop: 105, exit: 90, pnl: 200 })
  assert.equal(e.rMultiple, 2)
})

test('statistics compute expectancy, profit factor and drawdown', () => {
  const trades = [
    { rMultiple: 2, pnl: 200, model: 'CISD', session: 'nyAM', grade: 'A' },
    { rMultiple: -1, pnl: -100, model: 'CISD', session: 'nyAM', grade: 'B' },
    { rMultiple: 2, pnl: 200, model: 'IFVG', session: 'asia', grade: 'A' },
    { rMultiple: -1, pnl: -100, model: 'IFVG', session: 'asia', grade: 'B' },
  ]
  const s = buildStats(trades)
  assert.equal(s.count, 4)
  assert.equal(s.winRate, 0.5)
  assert.equal(s.expectancyR, 0.5)
  assert.equal(s.totalR, 2)
  assert.equal(s.profitFactor, 2)
  assert.equal(s.byModel.CISD.count, 2)
  assert.equal(s.bySession.asia.expectancyR, 0.5)
  assert.ok(s.sampleWarning, 'four trades must carry a sample warning')
})

test('max drawdown is measured peak-to-trough in R', () => {
  const s = buildStats([{ rMultiple: 3, pnl: 0 }, { rMultiple: -1, pnl: 0 }, { rMultiple: -1, pnl: 0 }, { rMultiple: 2, pnl: 0 }])
  assert.equal(s.maxDrawdownR, 2)
})

test('empty statistics do not throw or report nonsense', () => {
  const s = buildStats([])
  assert.equal(s.count, 0)
  assert.equal(s.expectancyR, 0)
  assert.equal(s.profitFactor, 0)
})

test('recommendations separate what to keep from what to drop', () => {
  const trades = []
  for (let i = 0; i < 30; i++) trades.push({ rMultiple: 1, pnl: 100, model: 'CISD', session: 'nyAM', grade: 'A' })
  for (let i = 0; i < 30; i++) trades.push({ rMultiple: -0.5, pnl: -50, model: 'IFVG', session: 'london', grade: 'B' })
  const rec = recommendations(buildStats(trades))
  assert.ok(rec.keep.some((r) => r.includes('CISD')))
  assert.ok(rec.drop.some((r) => r.includes('IFVG')))
})

/* ── survival analysis ──────────────────────────────────────────────────── */

test('a negative edge cannot be sized into a pass', () => {
  for (const riskFraction of [0.02, 0.05, 0.1, 0.2]) {
    const m = monteCarlo({ riskFraction, edge: { winRate: 0.25, payoffRatio: 2 }, runs: 300 })
    assert.ok(m.paidRate < 0.05, `risking ${riskFraction} turned a -0.25R edge into a ${(m.paidRate * 100).toFixed(1)}% payout rate`)
  }
})

test('a real edge with independent trades passes at small size', () => {
  // Arithmetically true, and the reason the clustered case below matters: this
  // is what a simulator says when it is allowed to assume too much.
  const m = monteCarlo({ riskFraction: 0.03, edge: { winRate: 0.45, payoffRatio: 2 }, runs: 300 })
  assert.ok(m.paidRate > 0.9)
})

test('clustered losses collapse the odds on the same edge', () => {
  const clean = monteCarlo({ riskFraction: 0.05, edge: { winRate: 0.45, payoffRatio: 2 }, runs: 400 })
  const clustered = monteCarlo({
    riskFraction: 0.05,
    edge: { winRate: 0.45, payoffRatio: 2, badRunProb: 0.2, badRunDays: 5, badRunMultiplier: 0.45 },
    runs: 400,
  })
  assert.ok(clustered.breachRate > clean.breachRate * 5, 'loss clustering must dominate the outcome')
})

test('oversizing separates passing from being paid', () => {
  const edge = { winRate: 0.45, payoffRatio: 2 }
  const small = monteCarlo({ riskFraction: 0.03, edge, runs: 400 })
  const large = monteCarlo({ riskFraction: 0.2, edge, runs: 400 })
  assert.ok(large.medianDaysToPass < small.medianDaysToPass, 'bigger size should pass faster')
  assert.ok(large.paidRate < small.paidRate * 0.3, 'a fast pass should fail the consistency rule')
})

test('the risk curve is not monotonic — both tails fail', () => {
  const curve = riskCurve({
    edge: { winRate: 0.45, payoffRatio: 2, badRunProb: 0.2, badRunDays: 5, badRunMultiplier: 0.45 },
    fractions: [0.01, 0.03, 0.05, 0.15, 0.3],
    runs: 400,
  })
  const paid = curve.map((c) => c.paidRate)
  const best = paid.indexOf(Math.max(...paid))
  assert.ok(best > 0 && best < paid.length - 1, `optimum should be interior, got index ${best}`)
})

test('the drawdown model only matters at large position size', () => {
  // Counter-intuitive and worth pinning: at sane sizes the intraday-unrealised
  // floor and the end-of-day floor produce nearly the same odds, because a
  // day's excursion is small next to the drawdown allowance. The distinction
  // only bites when a single day can swing a large share of the buffer.
  const edge = { winRate: 0.4, payoffRatio: 2, badRunProb: 0.2, badRunDays: 5, badRunMultiplier: 0.45 }
  const at = (dm, f) =>
    monteCarlo({ preset: 'LUCID-FLEX-50K', riskFraction: f, edge, rules: { drawdownModel: dm }, runs: 800 }).breachRate

  assert.ok(Math.abs(at('trailing-unrealised', 0.05) - at('trailing-eod', 0.05)) < 0.04, 'at 5% risk the models should barely differ')
  assert.ok(at('trailing-unrealised', 0.3) - at('trailing-eod', 0.3) > 0.03, 'at 30% risk the unrealised floor should be clearly worse')
})

test('a user-supplied account resolves and carries its own rules', async () => {
  const { PropAccount, accountSpec } = await import('../src/risk/propfirm.js')
  assert.ok(accountSpec('LUCID-FLEX-50K'), 'user accounts must resolve alongside the published presets')
  const a = new PropAccount({ preset: 'LUCID-FLEX-50K' })
  assert.equal(a.rules.drawdownModel, 'trailing-eod')
  assert.equal(a.rules.consistencyPct, 0.5)
  assert.equal(a.payoutSplit, 0.9)
  assert.equal(a.floor, 48000)
  assert.equal(a.profitTargetAssumed, true, 'an assumed profit target must be flagged as such')
})

test('hitting the target in a single day fails the consistency rule', async () => {
  const { simulateEvaluation } = await import('../src/risk/survival.js')
  const rng = () => 0 // every trade wins
  const r = simulateEvaluation({ preset: 'LUCID-FLEX-50K', riskFraction: 0.2, edge: { winRate: 1, payoffRatio: 2 }, rng })
  assert.equal(r.outcome, 'pass', 'a perfect run reaches the target')
  assert.equal(r.consistencyOk, false, 'all the profit landed on one day')
  assert.equal(r.paid, false, 'passing on one day is not a payout')
  assert.equal(r.payout, 0)
})

test('the payout split is applied once profit is spread across days', async () => {
  const { simulateEvaluation } = await import('../src/risk/survival.js')
  // Small size and one trade a day, so no single day can dominate the total.
  const rng = () => 0
  const r = simulateEvaluation({
    preset: 'LUCID-FLEX-50K',
    riskFraction: 0.02,
    edge: { winRate: 1, payoffRatio: 2, tradesPerDay: 1 },
    rng,
  })
  assert.equal(r.outcome, 'pass')
  assert.equal(r.paid, true, 'profit spread over many days satisfies a 50% consistency limit')
  const profit = r.balance - 50000
  assert.ok(Math.abs(r.payout - profit * 0.9) < 1e-6, 'payout must be net of the 90% split')
})

test('evaluation EV is negative below the edge that justifies the fee', async () => {
  const { evaluationEV } = await import('../src/risk/survival.js')
  const clustered = { badRunProb: 0.2, badRunDays: 5, badRunMultiplier: 0.45 }
  const weak = evaluationEV({ riskFraction: 0.05, edge: { winRate: 0.3, payoffRatio: 2, ...clustered }, runs: 800 })
  const strong = evaluationEV({ riskFraction: 0.05, edge: { winRate: 0.5, payoffRatio: 2, ...clustered }, runs: 800 })
  assert.ok(weak.ev < 0, 'a losing edge cannot justify the fee')
  assert.ok(strong.ev > 0, 'a solid edge should clear it comfortably')
  assert.equal(weak.fee, 150, 'the fee should come from the account spec')
})

test('the buffer reading of the withdrawal threshold pays materially less', async () => {
  const { evaluationEV } = await import('../src/risk/survival.js')
  const edge = { winRate: 0.5, payoffRatio: 2 }
  const full = evaluationEV({ riskFraction: 0.05, edge, payoutMode: 'full', runs: 800 })
  const buffer = evaluationEV({ riskFraction: 0.05, edge, payoutMode: 'buffer', runs: 800 })
  assert.ok(buffer.expectedPayout < full.expectedPayout, 'holding back a buffer must reduce the payout')
  assert.ok(buffer.expectedPayout > 0)
})

test('EV never counts a payout on a breached run', async () => {
  const { evaluationEV } = await import('../src/risk/survival.js')
  const e = evaluationEV({ riskFraction: 0.05, edge: { winRate: 0.05, payoffRatio: 2 }, runs: 400 })
  assert.equal(e.expectedPayout, 0)
  assert.equal(e.ev, -150, 'with no chance of passing, EV is exactly the fee')
})
