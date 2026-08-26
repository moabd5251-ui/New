import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  aggregateTradesToLadder, diagonalImbalances, imbalanceProfile,
  serialiseLadder, parseLadder, LadderStore, NQ_TICK,
} from '../src/data/ladder.js'
import { aggregateTradesToFootprint, BUY_AGGRESSOR, SELL_AGGRESSOR } from '../src/data/footprint.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'pf-ld-'))
const T = '2026-08-05T00:00:10.000000000Z'

/** Same header the trades schema exports; price now varies per row. */
const csv = (rows) =>
  ['ts_recv,ts_event,rtype,publisher_id,instrument_id,action,side,depth,price,size,flags,ts_in_delta,sequence']
    .concat(rows.map((r) => `${r.t ?? T},${r.t ?? T},0,1,42,T,${r.side},0,${r.price},${r.size},0,0,1`))
    .join('\n')

/** Build a ladder directly, for imbalance tests that do not need CSV parsing. */
const ladder = (levels, tickSize = NQ_TICK) => ({
  t: 0, tickSize,
  levels: levels.map(([price, bidVolume, askVolume]) => ({
    tick: Math.round(price / tickSize), price, bidVolume, askVolume,
  })).sort((a, b) => a.tick - b.tick),
})

test('a buy aggressor prints on the ASK side of its price level', () => {
  // 'B' lifted the offer. Footprint convention puts aggressive buying on the ask.
  const bars = aggregateTradesToLadder(csv([{ side: BUY_AGGRESSOR, price: 29835.25, size: 7 }]))
  assert.equal(bars.length, 1)
  assert.deepEqual(bars[0].levels, [{ tick: 119341, price: 29835.25, bidVolume: 0, askVolume: 7 }])
})

test('a sell aggressor prints on the BID side of its price level', () => {
  const bars = aggregateTradesToLadder(csv([{ side: SELL_AGGRESSOR, price: 29835.25, size: 7 }]))
  assert.deepEqual(bars[0].levels, [{ tick: 119341, price: 29835.25, bidVolume: 7, askVolume: 0 }])
})

test('levels within one interval are kept separate and sorted by price', () => {
  const bars = aggregateTradesToLadder(csv([
    { side: BUY_AGGRESSOR, price: 29835.50, size: 3 },
    { side: SELL_AGGRESSOR, price: 29835.00, size: 5 },
    { side: BUY_AGGRESSOR, price: 29835.00, size: 2 },
  ]))
  assert.equal(bars[0].levels.length, 2)
  assert.deepEqual(bars[0].levels.map((l) => l.price), [29835.00, 29835.50])
  assert.deepEqual(bars[0].levels[0], { tick: 119340, price: 29835, bidVolume: 5, askVolume: 2 })
})

test('ladder totals reconcile exactly with the per-minute footprint aggregator', () => {
  // The per-minute path had its aggressor convention verified against the tape.
  // Tying to it means the ladder cannot silently invert the sign on its own.
  const rows = [
    { side: BUY_AGGRESSOR, price: 29835.00, size: 11 },
    { side: SELL_AGGRESSOR, price: 29835.25, size: 4 },
    { side: BUY_AGGRESSOR, price: 29835.75, size: 6 },
    { side: SELL_AGGRESSOR, price: 29834.75, size: 9 },
  ]
  const text = csv(rows)
  const [fp] = aggregateTradesToFootprint(text)
  const [ld] = aggregateTradesToLadder(text)
  const askTotal = ld.levels.reduce((a, l) => a + l.askVolume, 0)
  const bidTotal = ld.levels.reduce((a, l) => a + l.bidVolume, 0)
  assert.equal(askTotal, fp.buyVolume, 'ask volume must equal buy-aggressor volume')
  assert.equal(bidTotal, fp.sellVolume, 'bid volume must equal sell-aggressor volume')
})

test('trades with no aggressor side are skipped, not counted as either', () => {
  const bars = aggregateTradesToLadder(csv([
    { side: 'N', price: 29835.00, size: 100 },
    { side: BUY_AGGRESSOR, price: 29835.00, size: 1 },
  ]))
  assert.deepEqual(bars[0].levels, [{ tick: 119340, price: 29835, bidVolume: 0, askVolume: 1 }])
})

test('a header without a price column is rejected rather than silently mis-parsed', () => {
  assert.throws(() => aggregateTradesToLadder('ts_event,side,size\n'), /Unexpected trades CSV header/)
})

test('a 400% buy imbalance is flagged on the diagonal, not the horizontal', () => {
  // ask[P] vs bid[P-1tick]: 40 vs 10 == 4.0x, exactly the threshold.
  const bar = ladder([[100.00, 10, 1], [100.25, 2, 40]])
  const { buy } = diagonalImbalances(bar, { factor: 4 })
  assert.equal(buy.length, 1)
  assert.equal(buy[0].price, 100.25)
  assert.equal(buy[0].ratio, 4)
})

test('a horizontal ratio at the same level does not flag', () => {
  // ask 40 vs bid 2 at the SAME price is 20x horizontally, but the diagonal
  // comparand bid[P-1] is 50, so 40/50 is not an imbalance.
  const bar = ladder([[100.00, 50, 1], [100.25, 2, 40]])
  assert.equal(diagonalImbalances(bar, { factor: 4 }).buy.length, 0)
})

test('a 400% sell imbalance uses bid[P] against ask[P+1tick]', () => {
  const bar = ladder([[100.00, 40, 3], [100.25, 1, 10]])
  const { sell } = diagonalImbalances(bar, { factor: 4 })
  assert.equal(sell.length, 1)
  assert.equal(sell[0].price, 100.00)
  assert.equal(sell[0].ratio, 4)
})

test('an unbounded imbalance reports ratio null and honours minVolume', () => {
  const bar = ladder([[100.00, 0, 0], [100.25, 0, 3]])
  assert.equal(diagonalImbalances(bar, { factor: 4, minVolume: 1 }).buy[0].ratio, null)
  // The same level does not flag once a floor is imposed — this is what keeps
  // thin edge levels, where the extremes are, from flooding the result.
  assert.equal(diagonalImbalances(bar, { factor: 4, minVolume: 10 }).buy.length, 0)
})

test('imbalanceProfile locates selling at the low extreme — the step-1 case', () => {
  // Heavy sell imbalances at the bottom of the range, none at the top.
  const bar = ladder([
    [100.00, 80, 1], [100.25, 60, 2], [100.50, 5, 5], [100.75, 4, 6], [101.00, 3, 8],
  ])
  const p = imbalanceProfile(bar, { factor: 4, zone: 0.25 })
  assert.ok(p.sellCount >= 2, 'expected sell imbalances near the low')
  assert.equal(p.sellAtLow, 1, 'all imbalanced sell volume sits in the bottom quarter')
})

test('the outermost level does not flag just for lacking a neighbour', () => {
  // Nothing trades below the low, so bid[low-1] is absent and any ask at the
  // low beats it. Treating that as a 400% imbalance fires on every bar's
  // extremes — which is precisely where this gets read.
  // Interior deliberately balanced, so anything that fires can only be the edge.
  const bar = ladder([[100.00, 10, 9], [100.25, 10, 10], [100.50, 9, 10]])
  const strict = diagonalImbalances(bar, { factor: 4, requireNeighbour: true })
  const loose = diagonalImbalances(bar, { factor: 4, requireNeighbour: false })
  assert.equal(strict.buy.length, 0, 'low edge must not flag on a missing neighbour')
  assert.equal(strict.sell.length, 0, 'high edge must not flag on a missing neighbour')
  assert.ok(loose.buy.length + loose.sell.length > 0, 'the old behaviour is still reachable')
})

test('a level that traded but was empty on one side is still an unbounded imbalance', () => {
  // Distinct from the case above: bid[P-1] exists and is genuinely zero.
  const bar = ladder([[100.00, 0, 2], [100.25, 0, 30], [100.50, 4, 4]])
  const { buy } = diagonalImbalances(bar, { factor: 4, minVolume: 1 })
  assert.ok(buy.some((b) => b.price === 100.25 && b.ratio === null))
})

test('an empty side reports null rather than zero', () => {
  // "No imbalances at all" must be distinguishable from "imbalances, none low".
  const bar = ladder([[100.00, 5, 5], [100.25, 5, 5]])
  const p = imbalanceProfile(bar, { factor: 4 })
  assert.equal(p.sellAtLow, null)
  assert.equal(p.buyAtHigh, null)
})

test('a single-level bar has no interior and does not divide by zero', () => {
  const p = imbalanceProfile(ladder([[100.00, 9, 0]]), { factor: 4 })
  assert.equal(p.sellAtLow, null)
  assert.ok(Number.isFinite(p.lowTick))
})

test('serialise/parse is a round trip', () => {
  const bars = aggregateTradesToLadder(csv([
    { side: BUY_AGGRESSOR, price: 29835.00, size: 11 },
    { side: SELL_AGGRESSOR, price: 29835.25, size: 4 },
  ]))
  assert.deepEqual(parseLadder(serialiseLadder(bars)), bars)
})

test('LadderStore merge is idempotent', () => {
  const root = tmp()
  const store = new LadderStore(root, 'MNQ.v.0')
  const bars = aggregateTradesToLadder(csv([
    { side: BUY_AGGRESSOR, price: 29835.00, size: 11 },
    { side: SELL_AGGRESSOR, price: 29835.25, size: 4 },
  ]))
  const first = store.merge(bars)
  assert.equal(first.added, 2)
  assert.equal(store.merge(bars).added, 0, 'a re-merge of the same rows adds nothing')
  assert.deepEqual(store.readDay(first.days[0]), bars)
})
