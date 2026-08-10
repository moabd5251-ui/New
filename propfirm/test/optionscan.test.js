import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OPTIONSCAN_SPEC, findReaction, buildVertical, spreadValueAtExpiry,
  sizeContracts, pickExpiration, appendCandidates, resolveExpired, scanScorecard,
} from '../src/research/optionscan.js'

const day = (i, o, c, v = 1_000_000, h = null, l = null) => ({
  date: `2026-07-${String(i + 1).padStart(2, '0')}`,
  o, h: h ?? Math.max(o, c) + 1, l: l ?? Math.min(o, c) - 1, c, v,
})

function flatSeries(n, price = 100) {
  return Array.from({ length: n }, (_, i) => day(i, price, price))
}

test('findReaction: detects an unfilled up-gap on volume, ignores quiet tape', () => {
  const bars = flatSeries(25)
  // Day 22 gaps up 5% on 3x volume; price holds above the pre-gap close.
  bars[22] = day(22, 105, 106, 3_000_000)
  bars[23] = day(23, 106, 107)
  bars[24] = day(24, 107, 108)
  const r = findReaction(bars)
  assert.ok(r)
  assert.equal(r.direction, 'up')
  assert.equal(r.reactionDay, bars[22].date)

  assert.equal(findReaction(flatSeries(25)), null, 'no gap → no reaction')

  // Same gap without the volume: not a reaction.
  const quiet = flatSeries(25)
  quiet[22] = day(22, 105, 106, 1_000_000)
  quiet[23] = day(23, 106, 107)
  quiet[24] = day(24, 107, 108)
  assert.equal(findReaction(quiet), null)
})

test('findReaction: a filled gap is dead', () => {
  const bars = flatSeries(25)
  bars[22] = day(22, 105, 106, 3_000_000)
  bars[23] = day(23, 105, 101)
  bars[24] = day(24, 100, 99) // closed back through the pre-gap close of 100
  assert.equal(findReaction(bars), null)
})

const leg = (type, strike, delta, bid, ask, oi = 500) => ({
  option_type: type, strike, bid, ask, open_interest: oi, greeks: { delta: type === 'put' ? -delta : delta },
})

test('buildVertical: picks delta-nearest strikes and prices the spread', () => {
  const chain = [
    leg('call', 95, 0.75, 7.0, 7.4),
    leg('call', 100, 0.62, 4.0, 4.4),
    leg('call', 105, 0.45, 2.0, 2.3),
    leg('call', 110, 0.30, 1.05, 1.15),
    leg('put', 100, 0.38, 3.0, 3.3),
  ]
  const { spread, reason } = buildVertical(chain, 'up')
  assert.equal(reason, null)
  assert.equal(spread.longStrike, 100)
  assert.equal(spread.shortStrike, 110)
  assert.ok(Math.abs(spread.debit - (4.2 - 1.1)) < 1e-9)
  assert.equal(spread.width, 10)
  assert.ok(Math.abs(spread.breakeven - 103.1) < 1e-9)
})

test('buildVertical: illiquidity is a reason, not a trade', () => {
  const wide = [leg('call', 100, 0.65, 1.0, 2.0), leg('call', 110, 0.30, 0.5, 1.5)]
  assert.match(buildVertical(wide, 'up').reason, /liquid/)
  const thin = [leg('call', 100, 0.65, 4.0, 4.2, 5), leg('call', 110, 0.30, 1.05, 1.15, 5)]
  assert.match(buildVertical(thin, 'up').reason, /liquid/)
})

test('buildVertical: an illiquid strike is skipped in favour of a liquid neighbour', () => {
  const chain = [
    leg('call', 100, 0.66, 4.0, 4.4, 10), // delta-nearest to 0.65 but thin
    leg('call', 102, 0.60, 3.4, 3.7, 800),
    leg('call', 110, 0.30, 1.05, 1.15, 800),
  ]
  const { spread, reason } = buildVertical(chain, 'up')
  assert.equal(reason, null)
  assert.equal(spread.longStrike, 102, 'liquid 102 beats illiquid 100')
})

test('spreadValueAtExpiry: intrinsic, bounded by width', () => {
  const call = { type: 'call', longStrike: 100, shortStrike: 110, width: 10 }
  assert.equal(spreadValueAtExpiry(call, 95), 0)
  assert.equal(spreadValueAtExpiry(call, 105), 5)
  assert.equal(spreadValueAtExpiry(call, 150), 10)
  const put = { type: 'put', longStrike: 100, shortStrike: 90, width: 10 }
  assert.equal(spreadValueAtExpiry(put, 84), 10)
  assert.equal(spreadValueAtExpiry(put, 96), 4)
})

test('sizing respects the risk budget', () => {
  // $750 budget at defaults; $310 debit → 2 contracts.
  assert.equal(sizeContracts(3.1), 2)
  assert.equal(sizeContracts(8), 0, 'a debit above budget buys nothing')
})

test('pickExpiration stays inside the DTE window', () => {
  const exps = ['2026-08-14', '2026-08-21', '2026-09-18', '2026-10-16', '2026-12-18']
  const pick = pickExpiration(exps, '2026-08-10')
  assert.equal(pick.d, '2026-09-18')
  assert.equal(pickExpiration(['2026-08-14'], '2026-08-10'), null)
})

test('journal: one candidate per (symbol, reactionDay); expiry resolution', async () => {
  const record = {
    symbol: 'TEST', reactionDay: '2026-07-23', scanDate: '2026-07-24', direction: 'up',
    expiration: '2026-08-07', contracts: 2,
    spread: { type: 'call', longStrike: 100, shortStrike: 110, width: 10, debit: 3 },
  }
  const { records, added } = appendCandidates([], [record])
  assert.equal(added.length, 1)
  assert.equal(appendCandidates(records, [{ ...record, scanDate: '2026-07-25' }]).added.length, 0)

  const resolved = await resolveExpired(records, '2026-08-10', async () => [
    { date: '2026-08-06', c: 104 }, { date: '2026-08-07', c: 106 },
  ])
  assert.equal(resolved, 1)
  assert.equal(records[0].outcome.valuePerShare, 6)
  assert.equal(records[0].outcome.pnlUsd, (6 - 3) * 100 * 2)

  const card = scanScorecard(records)
  assert.equal(card.resolved, 1)
  assert.equal(card.winRate, 1)
})
