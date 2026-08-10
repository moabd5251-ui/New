import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { aggregateTradesToFootprint, FootprintStore, alignFootprint, BUY_AGGRESSOR, SELL_AGGRESSOR } from '../src/data/footprint.js'
import { FootprintOrderflow } from '../src/core/orderflow.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'pf-fp-'))

const csv = (rows) =>
  ['ts_recv,ts_event,rtype,publisher_id,instrument_id,action,side,depth,price,size,flags,ts_in_delta,sequence']
    .concat(rows.map((r) => `${r.t},${r.t},0,1,42,T,${r.side},0,29835.0,${r.size},0,0,1`))
    .join('\n')

test('buy and sell aggressors are attributed to the right side', () => {
  // 'B' is the BUY aggressor — verified against the tape, not assumed.
  const text = csv([
    { t: '2026-08-05T00:00:10.000000000Z', side: BUY_AGGRESSOR, size: 10 },
    { t: '2026-08-05T00:00:20.000000000Z', side: SELL_AGGRESSOR, size: 4 },
    { t: '2026-08-05T00:00:30.000000000Z', side: BUY_AGGRESSOR, size: 6 },
  ])
  const [minute] = aggregateTradesToFootprint(text)
  assert.equal(minute.buyVolume, 16)
  assert.equal(minute.sellVolume, 4)
  assert.equal(minute.trades, 3)
})

test('trades with no reported side count but are attributed to neither', () => {
  const text = csv([
    { t: '2026-08-05T00:00:10.000000000Z', side: 'N', size: 99 },
    { t: '2026-08-05T00:00:20.000000000Z', side: BUY_AGGRESSOR, size: 1 },
  ])
  const [minute] = aggregateTradesToFootprint(text)
  assert.equal(minute.buyVolume, 1)
  assert.equal(minute.sellVolume, 0)
  assert.equal(minute.trades, 2, 'the unsided trade is still counted, just not guessed at')
})

test('trades fold into separate minute buckets', () => {
  const text = csv([
    { t: '2026-08-05T00:00:10.000000000Z', side: BUY_AGGRESSOR, size: 5 },
    { t: '2026-08-05T00:01:10.000000000Z', side: BUY_AGGRESSOR, size: 7 },
  ])
  const out = aggregateTradesToFootprint(text)
  assert.equal(out.length, 2)
  assert.equal(out[1].t - out[0].t, 60_000)
})

test('a malformed header fails loudly rather than silently zeroing', () => {
  assert.throws(() => aggregateTradesToFootprint('a,b,c\n1,2,3'), /Unexpected trades CSV header/)
})

test('the footprint store round-trips and merges idempotently', () => {
  const store = new FootprintStore(tmp(), 'NQ.v.0')
  const rows = [
    { t: Date.UTC(2026, 7, 5, 15, 0), buyVolume: 100, sellVolume: 40, trades: 12 },
    { t: Date.UTC(2026, 7, 5, 15, 1), buyVolume: 60, sellVolume: 90, trades: 9 },
  ]
  assert.equal(store.merge(rows).added, 2)
  assert.equal(store.merge(rows).added, 0, 'merging the same rows twice must add nothing')
  assert.deepEqual(store.load(), rows)
  assert.equal(store.coverage().totalVolume, 290)
})

test('alignment pads missing minutes rather than shortening the series', () => {
  const candles = [0, 1, 2].map((i) => ({ t: Date.UTC(2026, 7, 5, 15, i), o: 1, h: 1, l: 1, c: 1, v: 1 }))
  const rows = [{ t: candles[0].t, buyVolume: 10, sellVolume: 5, trades: 2 }]
  const { footprint, matched, missing } = alignFootprint(candles, rows)
  assert.equal(footprint.length, candles.length, 'index alignment must be preserved')
  assert.equal(matched, 1)
  assert.equal(missing, 2)
  assert.deepEqual(footprint[1], { buyVolume: 0, sellVolume: 0 })
})

test('an aligned footprint drives FootprintOrderflow without length errors', () => {
  const candles = Array.from({ length: 40 }, (_, i) => ({
    t: Date.UTC(2026, 7, 5, 15, i), o: 100, h: 101, l: 99, c: 100.8, v: 500,
  }))
  const rows = candles.map((c) => ({ t: c.t, buyVolume: 100, sellVolume: 400, trades: 5 }))
  const { footprint } = alignFootprint(candles, rows)
  const of = new FootprintOrderflow(candles, footprint)
  assert.equal(of.isProxy, false)
  // Bars close near their highs, so the proxy would infer buying; the real
  // tape says sellers were the aggressors and must win.
  assert.equal(of.at(39).delta, -300)
  assert.ok(of.at(39).cvd < 0)
})
