import test from 'node:test'
import assert from 'node:assert/strict'
import { BUTTERFLY_SPEC, buildButterfly, flyValueAtExpiry, sizeFlies, resolveExpiredFlies, butterflyScorecard } from '../src/research/butterfly.js'
import { analyzeChart, targetFor } from '../src/research/chartanalysis.js'

const leg = (type, strike, bid, ask, oi = 800) => ({ option_type: type, strike, bid, ask, open_interest: oi })

/** A call chain at 5-point intervals with a plausible decaying premium. */
const chain = (spot, lo, hi, step = 5) => {
  const out = []
  for (let k = lo; k <= hi; k += step) {
    const intrinsic = Math.max(0, spot - k)
    const time = Math.max(0.4, 8 - Math.abs(k - spot) * 0.09)
    const m = intrinsic + time
    out.push(leg('call', k, +(m - 0.15).toFixed(2), +(m + 0.15).toFixed(2)))
  }
  return out
}

test('the body lands on the strike NEAREST the target, not the farthest', () => {
  // Regression: a swapped ternary once picked the lowest strike in the chain,
  // which then failed for "no symmetric wings" and looked like illiquidity.
  const { fly, reason } = buildButterfly(chain(155, 55, 180), 'up', 165, 155, 7.8)
  assert.equal(reason, null, `expected a structure, got: ${reason}`)
  assert.equal(fly.bodyStrike, 165)
  assert.ok(fly.lowerStrike < 165 && fly.upperStrike > 165, 'wings straddle the body')
  assert.equal(165 - fly.lowerStrike, fly.upperStrike - 165, 'wings are symmetric')
})

test('a butterfly centred on spot is refused — that is a volatility trade', () => {
  const { fly, reason } = buildButterfly(chain(155, 100, 200), 'up', 156, 155, 7.8)
  assert.equal(fly, null)
  assert.match(reason, /directional content/)
})

test('execution drag is reported, not buried in the debit', () => {
  const { fly } = buildButterfly(chain(155, 55, 180), 'up', 165, 155, 7.8)
  assert.ok(fly.debit > fly.debitMid, 'crossing three spreads costs more than mid')
  assert.ok(Math.abs(fly.executionDrag - (fly.debit - fly.debitMid)) < 1e-9)
  // Four contracts across three strikes at 0.30 wide = 0.60 of slippage.
  assert.ok(fly.executionDrag > 0.5, `expected real drag, got ${fly.executionDrag}`)
})

test('payoff at expiry peaks at the body and is zero beyond the wings', () => {
  const fly = { type: 'call', lowerStrike: 150, bodyStrike: 165, upperStrike: 180, width: 15 }
  assert.equal(flyValueAtExpiry(fly, 140), 0)
  assert.equal(flyValueAtExpiry(fly, 150), 0)
  assert.equal(flyValueAtExpiry(fly, 158), 8)
  assert.equal(flyValueAtExpiry(fly, 165), 15, 'max value sits exactly on the body')
  assert.equal(flyValueAtExpiry(fly, 172), 8)
  assert.equal(flyValueAtExpiry(fly, 180), 0)
  assert.equal(flyValueAtExpiry(fly, 250), 0, 'being very right pays nothing')

  const put = { type: 'put', lowerStrike: 90, bodyStrike: 100, upperStrike: 110, width: 10 }
  assert.equal(flyValueAtExpiry(put, 100), 10)
  assert.equal(flyValueAtExpiry(put, 85), 0)
})

test('sizing respects the per-position cap', () => {
  assert.equal(sizeFlies(2.5), 3) // $250 each against a $750 budget
  assert.equal(sizeFlies(9), 0)
})

test('resolution records how far price finished from the body', async () => {
  const records = [{
    symbol: 'T', expiration: '2026-08-01', contracts: 2,
    fly: { type: 'call', lowerStrike: 150, bodyStrike: 165, upperStrike: 180, width: 15, debit: 4, executionDrag: 0.6 },
  }]
  const n = await resolveExpiredFlies(records, '2026-08-10', async () => [{ date: '2026-08-01', c: 170 }])
  assert.equal(n, 1)
  assert.equal(records[0].outcome.valuePerShare, 10)
  assert.equal(records[0].outcome.pnlUsd, (10 - 4) * 100 * 2 - 0.65 * 4 * 2)
  assert.equal(records[0].outcome.distanceFromBody, 5)

  const card = butterflyScorecard(records)
  assert.equal(card.inZoneRate, 1)
  assert.ok(Math.abs(card.medianMissWidths - 5 / 15) < 1e-9)
  assert.ok(Math.abs(card.executionDragUsd - 0.6 * 100 * 2) < 1e-9)
})

test('chart analysis finds tested shelves and targets one of them', () => {
  // A range that repeatedly turns at 110 and 90, then sits at 100.
  const rows = []
  for (let i = 0; i < 120; i++) {
    const phase = i % 20
    const c = phase < 10 ? 90 + phase * 2 : 110 - (phase - 10) * 2
    rows.push({ date: `2026-0${1 + Math.floor(i / 31)}-${String((i % 31) + 1).padStart(2, '0')}`, o: c, h: c + 1.5, l: c - 1.5, c, v: 1e6 })
  }
  const chart = analyzeChart(rows)
  assert.ok(chart, 'expected an analysis')
  assert.ok(chart.resistance.length || chart.support.length, 'expected shelves')
  const t = targetFor(chart, 'up')
  assert.ok(t.price > chart.price, 'an upside target sits above price')

  assert.equal(analyzeChart(rows.slice(0, 10)), null, 'too little history yields nothing, not a guess')
})

test('an inferred target is labelled as inferred', () => {
  // Strictly rising series: no confirmed resistance above the last price.
  const rows = Array.from({ length: 120 }, (_, i) => {
    const c = 100 + i * 0.5 + Math.sin(i / 4) * 2
    return { date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, o: c, h: c + 1, l: c - 1, c, v: 1e6 }
  })
  const chart = analyzeChart(rows)
  const t = targetFor(chart, 'up')
  if (t.inferred) assert.match(t.basis, /projection/)
  else assert.ok(t.touches >= 1, 'a non-inferred target must come from a real shelf')
})

test('an untradeable fly is refused, with the markup stated', () => {
  // A structure worth pennies at mid but priced through three wide spreads:
  // exactly the cheap-fly trap that fixed-dollar sizing then multiplies.
  // Mid cost $50, filled cost $120: reward/risk still 3.2 so it clears that
  // floor, but 58% of what you pay is slippage.
  const wide = [
    leg('call', 160, 7.825, 8.175),
    leg('call', 165, 5.075, 5.425),
    leg('call', 170, 2.825, 3.175),
  ]
  const { fly, reason } = buildButterfly(wide, 'up', 165, 155, 7.8)
  assert.equal(fly, null)
  assert.match(reason, /untradeable/)
  assert.match(reason, /%/, 'the markup is quantified, not just asserted')
})

test('resolution reports P&L both at mid and crossing the spread', async () => {
  const records = [{
    symbol: 'T', expiration: '2026-08-01', contracts: 2,
    fly: { type: 'call', lowerStrike: 150, bodyStrike: 165, upperStrike: 180, width: 15, debit: 4, debitMid: 3, executionDrag: 1 },
  }]
  await resolveExpiredFlies(records, '2026-08-10', async () => [{ date: '2026-08-01', c: 165 }])
  const o = records[0].outcome
  const commission = 0.65 * 4 * 2
  assert.equal(o.pnlUsd, (15 - 4) * 100 * 2 - commission)
  assert.equal(o.pnlAtMidUsd, (15 - 3) * 100 * 2 - commission)
  assert.ok(o.pnlAtMidUsd > o.pnlUsd, 'a mid fill always beats crossing')
  assert.equal(butterflyScorecard(records).totalAtMidUsd, o.pnlAtMidUsd)
})

test('assessSpread says whether max gain needs a level broken', async () => {
  const { assessSpread } = await import('../src/research/chartanalysis.js')
  const chart = {
    price: 100, atr: 2,
    resistance: [{ price: 104, touches: 5 }, { price: 110, touches: 2 }],
    support: [{ price: 96, touches: 3 }, { price: 90, touches: 4 }],
  }
  // Short strike beyond the 5-touch shelf: max gain requires breaking it.
  const through = assessSpread({ longStrike: 100, shortStrike: 108, breakeven: 103 }, chart, 'up')
  assert.equal(through.maxGainNeedsBreak, true)
  assert.equal(through.hardestLevel, 104)
  assert.equal(through.reachAtr, 4)

  // Short strike at the shelf: the payoff is collected before it.
  const inside = assessSpread({ longStrike: 98, shortStrike: 104, breakeven: 101 }, chart, 'up')
  assert.equal(inside.maxGainNeedsBreak, false)
  assert.equal(inside.hardestLevel, null)

  // Puts read the mirror image against support.
  const down = assessSpread({ longStrike: 100, shortStrike: 92, breakeven: 97 }, chart, 'down')
  assert.equal(down.maxGainNeedsBreak, true)
  assert.equal(down.hardestLevel, 96)
  assert.equal(assessSpread({ longStrike: 100, shortStrike: 92, breakeven: 97 }, null, 'down'), null)
})
