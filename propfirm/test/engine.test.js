import test from 'node:test'
import assert from 'node:assert/strict'

import { generateSeries } from '../src/data/synthetic.js'
import { Market } from '../src/data/market.js'
import { TradingSystem, buildTargets, DEFAULT_CONFIG } from '../src/engine/system.js'
import { scoreSetup, withMeasuredExpectancy } from '../src/engine/confluence.js'
import { orderflowGate } from '../src/engine/gate.js'
import { INSTRUMENTS } from '../src/risk/propfirm.js'
import { parseCSV, parseTimestamp } from '../src/data/csv.js'

const NQ = INSTRUMENTS.NQ

/* ── the no-lookahead guarantee ─────────────────────────────────────────── */

test('evaluating a bar gives the same answer whether or not future bars exist', () => {
  // This is the property that makes a backtest worth anything. Build the market
  // twice — once with the full series, once truncated at the bar under test —
  // and the decision must be identical.
  const full = generateSeries({ days: 12, seed: 99 })
  const system = new TradingSystem()

  const marketFull = new Market(full, { instrument: NQ })
  const checkpoints = [3000, 5000, 7000, 9000]

  for (const i of checkpoints) {
    if (i >= full.length) continue
    const truncated = full.slice(0, i + 1)
    const marketTruncated = new Market(truncated, { instrument: NQ })

    const a = system.evaluate(marketFull, i)
    const b = system.evaluate(marketTruncated, i)

    assert.equal(
      Boolean(a.signal),
      Boolean(b.signal),
      `bar ${i}: signal presence differs between full and truncated series — future data is leaking in`,
    )
    assert.equal(a.rejected, b.rejected, `bar ${i}: rejection reason differs`)
    if (a.signal && b.signal) {
      assert.equal(a.signal.model, b.signal.model, `bar ${i}: model differs`)
      assert.equal(a.signal.direction, b.signal.direction, `bar ${i}: direction differs`)
      assert.ok(Math.abs(a.signal.stop - b.signal.stop) < 1e-9, `bar ${i}: stop differs`)
      assert.ok(Math.abs(a.signal.score - b.signal.score) < 1e-9, `bar ${i}: score differs`)
    }
  }
})

test('higher-timeframe reads never use an unclosed bar', () => {
  const candles = generateSeries({ days: 6, seed: 11 })
  const market = new Market(candles, { instrument: NQ })
  for (const name of ['context', 'macro', 'trend', 'secondary']) {
    const view = market.view(name)
    for (let i = 500; i < candles.length; i += 373) {
      const k = market.indexAt(name, i)
      if (k < 0) continue
      const htfBar = view.candles[k]
      assert.ok(
        htfBar.t + view.seconds * 1000 <= candles[i].t,
        `${name}: bar at base index ${i} had not closed yet`,
      )
    }
  }
})

test('swings are only visible after their confirmation bars', () => {
  const candles = generateSeries({ days: 4, seed: 5 })
  const market = new Market(candles, { instrument: NQ })
  const view = market.view('secondary')
  for (let i = 400; i < candles.length; i += 211) {
    const k = market.indexAt('secondary', i)
    if (k < 0) continue
    for (const s of market.swingsAt('secondary', i)) {
      assert.ok(s.index + view.swing.right <= k, `swing at ${s.index} used before it could be known`)
    }
  }
})

/* ── the three steps run in order and short-circuit ─────────────────────── */

test('steps short-circuit: no context means confirmation never runs', () => {
  const candles = generateSeries({ days: 5, seed: 3 })
  const market = new Market(candles, { instrument: NQ })
  const system = new TradingSystem()
  let sawShortCircuit = false
  for (let i = 500; i < candles.length; i += 97) {
    const { steps } = system.evaluate(market, i)
    if (steps.context && !steps.context.tradeable) {
      assert.equal(steps.confirmation, undefined, 'step 2 ran despite step 1 producing no bias')
      sawShortCircuit = true
    }
  }
  assert.ok(sawShortCircuit, 'expected at least one bar with no higher-timeframe read')
})

test('session filters keep the system out of lunch and macro windows', () => {
  const candles = generateSeries({ days: 8, seed: 21 })
  const market = new Market(candles, { instrument: NQ })
  const system = new TradingSystem()
  const { signals } = system.scan(market, { from: 400 })
  for (const s of signals) {
    assert.notEqual(s.session, 'nyLunch', 'took a trade during lunch')
    assert.ok(DEFAULT_CONFIG.allowedSessions.includes(s.session))
  }
})

test('every signal carries a stop, a target and a reason', () => {
  const candles = generateSeries({ days: 20, seed: 8 })
  const market = new Market(candles, { instrument: NQ })
  const { signals } = new TradingSystem().scan(market, { from: 400 })
  assert.ok(signals.length > 0, 'expected the engine to find setups in 20 days of data')
  for (const s of signals) {
    assert.ok(s.riskPoints > 0, 'signal has no risk distance')
    assert.ok(s.targets.length > 0, 'signal has no target')
    assert.ok(s.reasons.length > 0, 'signal has no stated reason')
    assert.ok(s.rr >= DEFAULT_CONFIG.minRR, `signal R:R ${s.rr} below the configured minimum`)
    const stopOnRightSide = s.direction === 'long' ? s.stop < s.entry : s.stop > s.entry
    assert.ok(stopOnRightSide, 'stop is on the wrong side of the entry')
    for (const t of s.targets) {
      const targetOnRightSide = s.direction === 'long' ? t.price > s.entry : t.price < s.entry
      assert.ok(targetOnRightSide, 'target is on the wrong side of the entry')
    }
  }
})

test('scan collapses a setup that stays valid into one signal', () => {
  const candles = generateSeries({ days: 20, seed: 8 })
  const market = new Market(candles, { instrument: NQ })
  const system = new TradingSystem()
  const withCooldown = system.scan(market, { from: 400, cooldownBars: 15 }).signals
  const withoutCooldown = system.scan(market, { from: 400, cooldownBars: 0 }).signals
  assert.ok(withCooldown.length <= withoutCooldown.length)
})

/* ── targets ────────────────────────────────────────────────────────────── */

test('a target is capped in front of an obstacle, not at it', () => {
  const market = stubMarket({ price: 100, poc: 108, pools: [] })
  const plan = buildTargets(market, 0, {
    direction: 'long',
    entry: 100,
    stop: 95,
    draw: null,
    cfg: { ...DEFAULT_CONFIG, targetBufferPoints: 3 },
  })
  // Default 2R would be 110, but the POC at 108 is in the way → 105.
  assert.equal(plan.targets.at(-1).price, 105)
  assert.match(plan.limitedBy, /point of control/)
})

test('a target extends to a liquidity pool that sits beyond the default', () => {
  const market = stubMarket({ price: 100, poc: NaN, pools: [] })
  const plan = buildTargets(market, 0, {
    direction: 'long',
    entry: 100,
    stop: 99,
    draw: { price: 130, origin: 'prev-day-high', touches: 2 },
    cfg: { ...DEFAULT_CONFIG, targetBufferPoints: 3 },
  })
  assert.equal(plan.targets.at(-1).price, 127, 'runs to just before the pool')
  assert.ok(plan.rr > 20)
})

test('no room to a target means no trade', () => {
  const market = stubMarket({ price: 100, poc: 100.5, pools: [] })
  const plan = buildTargets(market, 0, {
    direction: 'long',
    entry: 100,
    stop: 95,
    draw: null,
    cfg: { ...DEFAULT_CONFIG, targetBufferPoints: 3 },
  })
  assert.ok(plan.rr <= 0 || plan.rr < DEFAULT_CONFIG.minRR, 'selling into the POC should not produce a tradeable plan')
})

test('the ladder scales out only when there is room for two targets', () => {
  const market = stubMarket({ price: 100, poc: NaN, pools: [] })
  const wide = buildTargets(market, 0, { direction: 'short', entry: 100, stop: 105, draw: null, cfg: DEFAULT_CONFIG })
  assert.equal(wide.targets.length, 2)
  assert.equal(wide.targets[0].r, 1)

  const tight = buildTargets(market, 0, {
    direction: 'short',
    entry: 100,
    stop: 105,
    draw: { price: 93, origin: 'swing', touches: 1 },
    cfg: { ...DEFAULT_CONFIG, targetBufferPoints: 1 },
  })
  assert.equal(tight.targets.length, 1, 'under 2R there is nothing to scale out of')
})

/* ── confluence ─────────────────────────────────────────────────────────── */

test('grades track the strength of the read', () => {
  const strong = scoreSetup({
    context: { confidence: 0.9, conflicts: [], premiumDiscount: { inOTE: true }, draw: { touches: 3 } },
    confirmation: { confidence: 0.9, conflicts: [], breakEvent: { kind: 'CHoCH', direction: 'up' } },
    trigger: { fired: true, model: 'CISD', gate: { score: 0.9, pass: true, reasons: ['POC flip up'], isProxy: false } },
  })
  const weak = scoreSetup({
    context: { confidence: 0.2, conflicts: ['a', 'b'], premiumDiscount: null, draw: null },
    confirmation: { confidence: 0.3, conflicts: ['x', 'y'], breakEvent: null },
    trigger: { fired: false, model: null, gate: { score: 0.2, pass: false, reasons: [], isProxy: true } },
  })
  assert.ok(strong.score > weak.score)
  assert.equal(strong.grade, 'A+')
  assert.equal(weak.grade, 'NO-TRADE')
  assert.equal(weak.sizeMultiplier, 0)
})

test('proxy orderflow is penalised relative to a real feed', () => {
  const base = {
    context: { confidence: 0.7, conflicts: [], premiumDiscount: null, draw: null },
    confirmation: { confidence: 0.7, conflicts: [], breakEvent: { kind: 'BOS' } },
    trigger: { fired: true, model: 'CISD', gate: { score: 0.7, pass: true, reasons: [], isProxy: true } },
  }
  const real = { ...base, trigger: { ...base.trigger, gate: { ...base.trigger.gate, isProxy: false } } }
  assert.ok(scoreSetup(real).score > scoreSetup(base).score)
})

test('measured expectancy can demote a setup below the trading threshold', () => {
  const scored = scoreSetup({
    context: { confidence: 0.8, conflicts: [], premiumDiscount: null, draw: null },
    confirmation: { confidence: 0.8, conflicts: [], breakEvent: { kind: 'BOS' } },
    trigger: { fired: true, model: 'IFVG', gate: { score: 0.8, pass: true, reasons: [], isProxy: false } },
  })
  const stats = {
    byModel: { IFVG: { count: 60, expectancyR: -1.2 } },
    bySession: { nyAM: { count: 60, expectancyR: -1.5 } },
  }
  const adjusted = withMeasuredExpectancy(scored, { model: 'IFVG', session: 'nyAM' }, stats)
  assert.ok(adjusted.score < scored.score, 'a losing model must lose score')
  assert.ok(adjusted.adjustments.length === 2)
})

test('measured expectancy is ignored on a small sample', () => {
  const scored = scoreSetup({
    context: { confidence: 0.8, conflicts: [], premiumDiscount: null, draw: null },
    confirmation: { confidence: 0.8, conflicts: [], breakEvent: { kind: 'BOS' } },
    trigger: { fired: true, model: 'IFVG', gate: { score: 0.8, pass: true, reasons: [], isProxy: false } },
  })
  const adjusted = withMeasuredExpectancy(
    scored,
    { model: 'IFVG', session: 'nyAM' },
    { byModel: { IFVG: { count: 4, expectancyR: -3 } }, bySession: {} },
  )
  assert.equal(adjusted.score, scored.score, 'four trades is not evidence')
})

/* ── the orderflow gate ─────────────────────────────────────────────────── */

test('the gate rejects a trade with the aggression against it', () => {
  const candles = generateSeries({ days: 6, seed: 55 })
  const market = new Market(candles, { instrument: NQ })
  let longScore = 0
  let shortScore = 0
  let n = 0
  for (let i = 600; i < candles.length; i += 53) {
    longScore += orderflowGate(market, i, 'long').score
    shortScore += orderflowGate(market, i, 'short').score
    n++
  }
  // Long and short cannot both be well supported on average; the gate must
  // discriminate rather than waving everything through.
  assert.ok(n > 0)
  assert.ok(longScore / n < 0.9 && shortScore / n < 0.9, 'the gate is passing almost everything')
})

test('the gate reports whether it ran on estimated data', () => {
  const candles = generateSeries({ days: 3, seed: 2 })
  const market = new Market(candles, { instrument: NQ })
  const g = orderflowGate(market, candles.length - 1, 'long')
  assert.equal(g.isProxy, true)
  assert.ok(Array.isArray(g.reasons))
})

/* ── CSV ────────────────────────────────────────────────────────────────── */

test('CSV parsing handles the common export shapes', () => {
  const withHeader = parseCSV('time,open,high,low,close,volume\n2026-01-15T14:30:00Z,100,101,99,100.5,1234')
  assert.equal(withHeader.length, 1)
  assert.equal(withHeader[0].c, 100.5)
  assert.equal(withHeader[0].v, 1234)

  const headerless = parseCSV('1768487400,100,101,99,100.5,1234')
  assert.equal(headerless.length, 1)
  assert.equal(headerless[0].o, 100)

  const alternates = parseCSV('Date,Open,High,Low,Last,Total_Volume\n2026-01-15 09:30:00,100,101,99,100.5,10')
  assert.equal(alternates.length, 1)
  assert.equal(alternates[0].c, 100.5)
})

test('timestamps parse from seconds, millis and strings', () => {
  assert.equal(parseTimestamp('1768487400'), 1768487400000)
  assert.equal(parseTimestamp('1768487400000'), 1768487400000)
  assert.equal(parseTimestamp('2026-01-15T14:30:00Z'), Date.UTC(2026, 0, 15, 14, 30))
  assert.throws(() => parseTimestamp('not a date'))
})

test('CSV rows are sorted and bad rows dropped', () => {
  const out = parseCSV('time,open,high,low,close,volume\n2026-01-15T14:31:00Z,2,2,2,2,1\n2026-01-15T14:30:00Z,1,1,1,1,1\nbroken')
  assert.equal(out.length, 2)
  assert.ok(out[0].t < out[1].t)
})

/* ── helpers ────────────────────────────────────────────────────────────── */

function stubMarket({ price, poc, pools }) {
  return {
    base: [{ t: Date.UTC(2026, 0, 15, 15, 0), o: price, h: price, l: price, c: price, v: 1 }],
    orderflow: { poc: [poc] },
    poolsAt: () => pools,
    instrument: NQ,
  }
}
