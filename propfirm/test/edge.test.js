import test from 'node:test'
import assert from 'node:assert/strict'
import { measureForwardEdge, baselineEdge, edgeReport, formatEdgeReport } from '../src/research/edge.js'

/** A series that rises `slope` points per bar, with a fixed 1-point range. */
const ramp = (n, slope) =>
  Array.from({ length: n }, (_, i) => ({
    t: Date.UTC(2026, 0, 5, 0, 0) + i * 60_000,
    o: 100 + i * slope, h: 100.5 + i * slope, l: 99.5 + i * slope, c: 100 + i * slope, v: 100,
  }))

test('a signal that predicts correctly scores positive, and the sign follows direction', () => {
  const candles = ramp(600, 0.5) // price always rises
  const events = Array.from({ length: 50 }, (_, k) => ({ index: 100 + k * 8 }))

  const long = measureForwardEdge(candles, events, { horizons: [10], direction: 1 })[0]
  const short = measureForwardEdge(candles, events, { horizons: [10], direction: -1 })[0]

  assert.ok(long.meanAtr > 0, 'a long call on a rising series must score positive')
  assert.ok(short.meanAtr < 0, 'the same call as a short must score negative')
  assert.ok(Math.abs(long.meanAtr + short.meanAtr) < 1e-9, 'the two are exact mirrors')
  assert.equal(long.hitRate, 1)
})

test('overlapping events are thinned so they are not counted as independent', () => {
  // Needs noise: a perfectly linear ramp gives every sample the same forward
  // return, so the variance is zero and both t-statistics are zero.
  const candles = ramp(600, 0.5).map((c, i) => {
    const wob = Math.sin(i / 3) * 2
    return { ...c, o: c.o + wob, h: c.h + wob, l: c.l + wob, c: c.c + wob }
  })
  // Events one bar apart: over a 30-bar horizon almost all of them overlap.
  const dense = Array.from({ length: 200 }, (_, k) => ({ index: 100 + k }))
  const thinned = measureForwardEdge(candles, dense, { horizons: [30], direction: 1 })[0]
  const raw = measureForwardEdge(candles, dense, { horizons: [30], direction: 1, thin: false })[0]

  assert.ok(thinned.n < raw.n / 5, `thinning should discard most of them, kept ${thinned.n} of ${raw.n}`)
  // The inflated sample is exactly the trap: same effect, far larger t.
  assert.ok(Math.abs(raw.tStat) > Math.abs(thinned.tStat))
})

test('unsorted events are measured identically to sorted ones', () => {
  // Detectors do not all emit events in index order — inverted FVGs come out
  // ordered by gap formation, not inversion. Unsorted input used to defeat the
  // thinning and produced a t of −24 on data whose real t was −1.3.
  const candles = ramp(600, 0.5).map((c, i) => {
    const wob = Math.sin(i / 3) * 2
    return { ...c, o: c.o + wob, h: c.h + wob, l: c.l + wob, c: c.c + wob }
  })
  const sorted = Array.from({ length: 200 }, (_, k) => ({ index: 100 + k }))
  const shuffled = [...sorted].sort(() => (Math.sin(sorted.length) > 0 ? 1 : -1)).reverse()

  const a = measureForwardEdge(candles, sorted, { horizons: [30], direction: 1 })[0]
  const b = measureForwardEdge(candles, shuffled, { horizons: [30], direction: 1 })[0]
  assert.deepEqual(b, a, 'event order must not change the measurement')
})

test('forward moves are scaled by volatility so regimes are comparable', () => {
  const quiet = ramp(600, 0.5)
  const wild = quiet.map((c) => ({ ...c, h: c.c + 20, l: c.c - 20 }))
  const events = Array.from({ length: 40 }, (_, k) => ({ index: 100 + k * 10 }))

  const q = measureForwardEdge(quiet, events, { horizons: [10], direction: 1 })[0]
  const w = measureForwardEdge(wild, events, { horizons: [10], direction: 1 })[0]
  // Identical price path, far higher volatility — the same move must score lower.
  assert.ok(w.meanAtr < q.meanAtr, 'the same move in a wilder regime is less impressive')
})

test('a signal with no predictive content scores near zero', () => {
  // Sawtooth: price ends every 10 bars exactly where it started.
  const candles = Array.from({ length: 600 }, (_, i) => {
    const p = 100 + (i % 10)
    return { t: Date.UTC(2026, 0, 5) + i * 60_000, o: p, h: p + 0.5, l: p - 0.5, c: p, v: 100 }
  })
  const events = Array.from({ length: 40 }, (_, k) => ({ index: 100 + k * 10 }))
  const r = measureForwardEdge(candles, events, { horizons: [10], direction: 1 })[0]
  assert.ok(Math.abs(r.meanAtr) < 0.01, `expected no edge, got ${r.meanAtr}`)
})

test('the baseline captures drift, which signals have to beat', () => {
  const candles = ramp(3000, 0.2)
  const base = baselineEdge(candles, { horizons: [30], direction: 1, spacing: 60 })[0]
  assert.ok(base.meanAtr > 0, 'a rising market gives every long signal a free head start')
  assert.ok(base.n > 30)
})

test('empty and too-short inputs degrade quietly', () => {
  const candles = ramp(100, 0.5)
  assert.deepEqual(measureForwardEdge(candles, [], { horizons: [10] })[0].n, 0)
  // Events too close to the end have no future to measure.
  const r = measureForwardEdge(candles, [{ index: 98 }], { horizons: [10] })[0]
  assert.equal(r.n, 0)
  const rows = edgeReport(candles, [{ name: 'nothing', events: [], direction: 1 }])
  assert.equal(rows[0].empty, true)
  assert.match(formatEdgeReport(rows), /no events/)
})
