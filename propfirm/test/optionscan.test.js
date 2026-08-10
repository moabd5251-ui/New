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

test('pickExpiration prefers the monthly over a nearer weekly', () => {
  // 2026-09-04 and 2026-09-11 are weeklies; 2026-09-18 is the third Friday.
  // The weeklies sit closer to the window's midpoint and must still lose:
  // measured on the live book they carry 10-120x less open interest.
  const exps = ['2026-08-14', '2026-09-04', '2026-09-11', '2026-09-18', '2026-12-18']
  assert.equal(pickExpiration(exps, '2026-08-10').d, '2026-09-18')
  // With no monthly in the window, a weekly is better than nothing.
  assert.equal(pickExpiration(['2026-09-04', '2026-09-11'], '2026-08-10').d, '2026-09-11')
  assert.equal(pickExpiration(['2026-08-14'], '2026-08-10'), null)
})

test('buildVertical narrows the spread to fit the risk budget', () => {
  // A $500 stock: the 0.32-delta strike is 40 wide and costs $1,600 — over
  // the $750 budget. A narrower short must be chosen rather than the name
  // being rejected.
  const chain = [
    leg('call', 500, 0.65, 21.0, 21.4, 900),
    leg('call', 510, 0.52, 15.65, 15.95, 900),
    leg('call', 520, 0.44, 10.4, 10.7, 900),
    leg('call', 540, 0.32, 5.1, 5.3, 900),
  ]
  const { spread, reason } = buildVertical(chain, 'up')
  assert.equal(reason, null)
  assert.ok(spread.debit * 100 <= OPTIONSCAN_SPEC.accountSize * OPTIONSCAN_SPEC.riskPct,
    `debit $${(spread.debit * 100).toFixed(0)} must fit the budget`)
  assert.ok(spread.shortStrike < 540, 'the textbook 0.32-delta short is unaffordable here')
  assert.ok(spread.rewardRisk >= OPTIONSCAN_SPEC.minRewardRisk)
})

test('buildVertical reports why when nothing fits', () => {
  const chain = [leg('call', 100, 0.65, 40.0, 40.4, 900), leg('call', 200, 0.30, 1.0, 1.05, 900)]
  const { spread, reason } = buildVertical(chain, 'up')
  assert.equal(spread, null)
  assert.match(reason, /budget/)
})

test('renderOptionsPage: shows open and resolved records in both states', async () => {
  const { renderOptionsPage } = await import('../src/report/optionspage.js')
  const open = {
    symbol: 'AAPL', reactionDay: '2026-07-31', direction: 'down', gapPct: -8.6,
    expiration: '2026-09-11', dte: 32, contracts: 1, riskUsd: 715,
    spread: { type: 'put', longStrike: 315, shortStrike: 300, width: 15, debit: 7.15, maxGain: 7.85, breakeven: 307.85, rewardRisk: 1.1 },
  }
  const done = {
    ...open, symbol: 'MSFT', reactionDay: '2026-06-01', expiration: '2026-07-10',
    outcome: { resolvedAt: '2026-07-11', underlyingClose: 290, valuePerShare: 15, pnlUsd: 785, r: 1.1 },
  }
  const html = renderOptionsPage([open, done], { generatedAt: '2026-08-10T22:00:00Z' })
  assert.match(html, /AAPL/)
  assert.match(html, /MSFT/)
  assert.match(html, /PUT spread/)
  assert.doesNotMatch(html, /undefined|NaN/)
  const empty = renderOptionsPage([], { generatedAt: '2026-08-10T22:00:00Z' })
  assert.match(empty, /Nothing open/)
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
