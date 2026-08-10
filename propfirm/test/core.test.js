import test from 'node:test'
import assert from 'node:assert/strict'

import { aggregate, alignIndex, atr, volumeBaseline, validateSeries, closePosition, parseTimeframe, TF } from '../src/core/candles.js'
import { etParts, futuresDayKey, sessionOf, inKillzone, macroWindowOf, etMinuteOfDay, sessionBuckets } from '../src/core/sessions.js'
import { findSwings, alternate, labelSwings, detectBreaks, analyzeStructure, apexLevels, touchesAsOf } from '../src/core/structure.js'
import { findFVGs, resolveFVGs, invertedFVGs, detectCISD, displacement } from '../src/core/patterns.js'
import { volumeProfile, rollingPOC, vwap, cvd, detectAbsorption, BarOrderflow, FootprintOrderflow } from '../src/core/orderflow.js'
import { poolsFromSwings, markSweeps, drawOnLiquidity, premiumDiscount } from '../src/core/liquidity.js'

/** Build a candle from a compact spec. */
const bar = (t, o, h, l, c, v = 1000) => ({ t, o, h, l, c, v })
/** Minute-spaced series from [o,h,l,c,v] tuples starting at a fixed epoch. */
const series = (rows, start = Date.UTC(2026, 0, 5, 14, 30)) =>
  rows.map((r, i) => bar(start + i * 60_000, r[0], r[1], r[2], r[3], r[4] ?? 1000))

/* ── sessions ───────────────────────────────────────────────────────────── */

test('ET conversion handles standard time and DST', () => {
  // 2026-01-15 12:00 UTC = 07:00 EST (UTC-5)
  assert.equal(etParts(Date.UTC(2026, 0, 15, 12, 0)).hour, 7)
  // 2026-07-15 12:00 UTC = 08:00 EDT (UTC-4)
  assert.equal(etParts(Date.UTC(2026, 6, 15, 12, 0)).hour, 8)
})

test('midnight ET reports hour 0, not 24', () => {
  assert.equal(etParts(Date.UTC(2026, 0, 15, 5, 0)).hour, 0) // 00:00 EST
  assert.equal(etMinuteOfDay(Date.UTC(2026, 0, 15, 5, 0)), 0)
})

test('futures day rolls at 18:00 ET, not midnight', () => {
  const before = Date.UTC(2026, 0, 15, 22, 0) // 17:00 ET
  const after = Date.UTC(2026, 0, 15, 23, 30) // 18:30 ET
  assert.equal(futuresDayKey(before), '2026-01-15')
  assert.equal(futuresDayKey(after), '2026-01-16')
})

test('sessions and killzones map to the right windows', () => {
  const at = (h, m = 0) => Date.UTC(2026, 0, 15, h + 5, m) // ET → UTC in January
  assert.equal(sessionOf(at(9, 45)), 'nyAM')
  assert.equal(sessionOf(at(12, 30)), 'nyLunch')
  assert.equal(sessionOf(at(14, 0)), 'nyPM')
  assert.equal(sessionOf(at(3, 0)), 'london')
  assert.equal(sessionOf(at(20, 0)), 'asia')

  assert.equal(inKillzone(at(9, 45)), true)
  assert.equal(inKillzone(at(12, 30)), false) // lunch has no killzone
  assert.equal(inKillzone(at(20, 30)), true) // Asia killzone
})

test('macro windows are detected', () => {
  const at = (h, m) => Date.UTC(2026, 0, 15, h + 5, m)
  assert.equal(macroWindowOf(at(9, 55)), 'macro-0950')
  assert.equal(macroWindowOf(at(10, 30)), null)
})

test('session buckets carry per-session highs and lows', () => {
  const s = series([[100, 110, 95, 105], [105, 120, 100, 118]], Date.UTC(2026, 0, 15, 14, 30))
  const buckets = sessionBuckets(s)
  assert.equal(buckets.length, 1)
  assert.equal(buckets[0].session, 'nyAM')
  assert.equal(buckets[0].high, 120)
  assert.equal(buckets[0].low, 95)
})

/* ── candles ────────────────────────────────────────────────────────────── */

test('aggregation preserves OHLCV semantics', () => {
  const s = series([
    [100, 105, 99, 104, 10],
    [104, 108, 103, 107, 20],
    [107, 109, 101, 102, 30],
    [102, 103, 100, 101, 40],
    [101, 115, 101, 114, 50],
  ])
  const agg = aggregate(s, '5m')
  assert.equal(agg.length, 1)
  assert.equal(agg[0].o, 100)
  assert.equal(agg[0].h, 115)
  assert.equal(agg[0].l, 99)
  assert.equal(agg[0].c, 114)
  assert.equal(agg[0].v, 150)
})

test('daily aggregation respects the 18:00 ET boundary', () => {
  const s = [
    bar(Date.UTC(2026, 0, 15, 20, 0), 100, 101, 99, 100), // 15:00 ET, day 01-15
    bar(Date.UTC(2026, 0, 15, 23, 30), 200, 201, 199, 200), // 18:30 ET, day 01-16
  ]
  const daily = aggregate(s, '1d')
  assert.equal(daily.length, 2, 'bars either side of 18:00 ET belong to different days')
})

test('parseTimeframe understands the usual specs', () => {
  assert.equal(parseTimeframe('30s'), 30)
  assert.equal(parseTimeframe('15m'), 900)
  assert.equal(parseTimeframe('4h'), TF.H4)
  assert.equal(parseTimeframe('1d'), 86400)
  assert.throws(() => parseTimeframe('7q'))
})

test('alignIndex never returns a bar that has not closed yet', () => {
  const base = series(Array.from({ length: 20 }, () => [1, 2, 0, 1]))
  const htf = aggregate(base, '5m')
  const align = alignIndex(base, htf, 300)
  // At base bar 4 the first 5m bar (bars 0-4) is still forming.
  assert.equal(align[4], -1)
  // At base bar 5 it has closed.
  assert.equal(align[5], 0)
  for (let i = 0; i < base.length; i++) {
    if (align[i] >= 0) {
      assert.ok(htf[align[i]].t + 300_000 <= base[i].t, `bar ${i} reads an unclosed HTF bar`)
    }
  }
})

test('atr and volume baseline are causal', () => {
  const s = series(Array.from({ length: 40 }, (_, i) => [100, 102, 98, 100 + (i % 3), 100 + i]))
  const a = atr(s, 14)
  assert.ok(Number.isNaN(a[5]), 'ATR is not defined before it is seeded')
  assert.ok(Number.isFinite(a[20]))
  const vb = volumeBaseline(s, 10)
  // Baseline at index 20 must exclude bar 20 itself.
  const expected = s.slice(10, 20).reduce((x, c) => x + c.v, 0) / 10
  assert.ok(Math.abs(vb[20] - expected) < 1e-9)
})

test('closePosition locates the close inside the bar', () => {
  assert.equal(closePosition(bar(0, 5, 10, 0, 10)), 1)
  assert.equal(closePosition(bar(0, 5, 10, 0, 0)), 0)
  assert.equal(closePosition(bar(0, 5, 10, 0, 5)), 0.5)
})

test('validateSeries catches corrupt bars', () => {
  const bad = [bar(1000, 10, 9, 11, 10)] // high < low, open outside range
  assert.ok(validateSeries(bad).length >= 1)
  const outOfOrder = [bar(2000, 10, 11, 9, 10), bar(1000, 10, 11, 9, 10)]
  assert.ok(validateSeries(outOfOrder).some((p) => p.includes('ascending')))
})

/* ── structure ──────────────────────────────────────────────────────────── */

test('swings are found at genuine pivots', () => {
  const s = series([
    [100, 101, 99, 100],
    [100, 103, 100, 102],
    [102, 110, 101, 109], // pivot high
    [109, 108, 104, 105],
    [105, 106, 100, 101],
    [101, 102, 95, 96], // pivot low
    [96, 101, 96, 100],
    [100, 104, 99, 103],
  ])
  const swings = findSwings(s, { left: 2, right: 2 })
  assert.ok(swings.some((x) => x.type === 'high' && x.price === 110))
  assert.ok(swings.some((x) => x.type === 'low' && x.price === 95))
})

test('alternate collapses same-side runs to the extreme', () => {
  const raw = [
    { index: 1, type: 'high', price: 100 },
    { index: 3, type: 'high', price: 105 },
    { index: 5, type: 'low', price: 90 },
  ]
  const alt = alternate(raw)
  assert.equal(alt.length, 2)
  assert.equal(alt[0].price, 105, 'keeps the higher of two consecutive highs')
})

test('swing labels follow Dow theory', () => {
  const labelled = labelSwings([
    { type: 'high', price: 100, index: 0 },
    { type: 'low', price: 90, index: 1 },
    { type: 'high', price: 110, index: 2 },
    { type: 'low', price: 95, index: 3 },
    { type: 'high', price: 105, index: 4 },
    { type: 'low', price: 85, index: 5 },
  ])
  assert.equal(labelled[2].label, 'HH')
  assert.equal(labelled[3].label, 'HL')
  assert.equal(labelled[4].label, 'LH')
  assert.equal(labelled[5].label, 'LL')
})

test('a break needs volume AND closure to be confirmed', () => {
  // 30 quiet bars establishing a swing high at 110, then two candidate breaks.
  const rows = []
  for (let i = 0; i < 8; i++) rows.push([100, 101, 99, 100, 1000])
  rows.push([100, 110, 100, 101, 1000]) // pivot high at 110
  for (let i = 0; i < 20; i++) rows.push([100, 101, 99, 100, 1000])
  const lowVolumeBreak = [...rows, [100, 112, 100, 111, 900]] // closes above on weak volume
  const strongBreak = [...rows, [100, 115, 99, 114.8, 5000]] // closes above with volume + range

  const weak = analyzeStructure(series(lowVolumeBreak))
  const strong = analyzeStructure(series(strongBreak))
  const weakBreak = weak.breaks.find((b) => b.direction === 'up')
  const strongBreakEvent = strong.breaks.find((b) => b.direction === 'up')

  assert.ok(weakBreak, 'the level was crossed')
  assert.equal(weakBreak.confirmed, false, 'crossing without volume is not a confirmed break')
  assert.ok(strongBreakEvent)
  assert.equal(strongBreakEvent.confirmed, true, 'volume + closure confirms')
})

test('apex touches are counted as-of a bar, never in total', () => {
  const level = { price: 100, index: 0, wasType: 'high', touchIndices: [5, 10, 20] }
  assert.equal(touchesAsOf(level, 4), 0)
  assert.equal(touchesAsOf(level, 10), 2)
  assert.equal(touchesAsOf(level, 99), 3)
})

test('apexLevels only reports levels that were broken', () => {
  const rows = []
  for (let i = 0; i < 6; i++) rows.push([100, 101, 99, 100, 1000])
  rows.push([100, 110, 100, 101, 1000])
  for (let i = 0; i < 6; i++) rows.push([100, 101, 99, 100, 1000])
  rows.push([100, 120, 100, 119, 4000]) // breaks the 110 high
  for (let i = 0; i < 6; i++) rows.push([115, 116, 109, 110, 1000]) // retests it
  const s = series(rows)
  const st = analyzeStructure(s)
  const apex = apexLevels(s, st.swings, { tolerance: 1 })
  assert.ok(apex.some((a) => Math.abs(a.price - 110) < 1e-9), 'the broken high became an apex level')
})

/* ── patterns ───────────────────────────────────────────────────────────── */

test('fair value gaps are three-bar imbalances', () => {
  const s = series([
    [100, 102, 99, 101],
    [101, 108, 101, 107],
    [107, 110, 105, 109], // bar1 high 102 < bar3 low 105 → bullish gap 102–105
  ])
  const gaps = findFVGs(s)
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].direction, 'bullish')
  assert.equal(gaps[0].bottom, 102)
  assert.equal(gaps[0].top, 105)
})

test('an FVG inverts only on a CLOSE through it, not a wick', () => {
  const base = [
    [100, 102, 99, 101, 1000],
    [101, 108, 101, 107, 1000],
    [107, 110, 105, 109, 1000], // bullish gap 102–105
  ]
  const pad = Array.from({ length: 22 }, () => [106, 107, 105.5, 106, 1000])

  const wickOnly = series([...base, ...pad, [106, 107, 101, 106, 3000]]) // wicks below 102, closes above
  const closeThrough = series([...base, ...pad, [106, 107, 100, 100.5, 3000]]) // closes below 102

  const a = resolveFVGs(wickOnly, findFVGs(wickOnly))[0]
  const b = resolveFVGs(closeThrough, findFVGs(closeThrough))[0]
  assert.equal(a.inverted, false, 'a wick through the gap is not an inversion')
  assert.equal(b.inverted, true, 'a close through the gap inverts it')
})

test('an inverted bullish gap becomes a bearish signal', () => {
  const rows = [
    [100, 102, 99, 101, 1000],
    [101, 108, 101, 107, 1000],
    [107, 110, 105, 109, 1000],
    ...Array.from({ length: 22 }, () => [106, 107, 105.5, 106, 1000]),
    [106, 107, 100, 100.5, 4000],
  ]
  const s = series(rows)
  const gaps = resolveFVGs(s, findFVGs(s))
  const inv = invertedFVGs(s, gaps, { minVolume: 1 })
  assert.equal(inv.length, 1)
  assert.equal(inv[0].direction, 'bearish', 'trade direction flips relative to the original gap')
})

test('displacement needs range, volume and a decisive close together', () => {
  const quiet = Array.from({ length: 25 }, () => [100, 101, 99, 100, 1000])
  const bigRangeNoVolume = series([...quiet, [100, 112, 99, 111.5, 900]])
  const bigRangeAndVolume = series([...quiet, [100, 112, 99, 111.5, 6000]])
  const bigRangeWeakClose = series([...quiet, [100, 112, 99, 104, 6000]])

  assert.equal(displacement(bigRangeNoVolume).at(-1), null, 'no volume, no displacement')
  assert.ok(displacement(bigRangeAndVolume).at(-1), 'range + volume + close = displacement')
  assert.equal(displacement(bigRangeWeakClose).at(-1), null, 'closing mid-range is not displacement')
})

test('CISD fires when price closes through the origin of the opposing run', () => {
  const quiet = Array.from({ length: 25 }, () => [100, 100.5, 99.5, 100, 1000])
  const rows = [
    ...quiet,
    [100, 104, 100, 103.5, 1200], // up run starts here → CISD level = open 100
    [103.5, 106, 103, 105.5, 1200],
    [105.5, 106, 98, 99, 5000], // closes below 100 with volume
  ]
  const events = detectCISD(series(rows))
  const ev = events.at(-1)
  assert.ok(ev, 'a change in state of delivery was detected')
  assert.equal(ev.direction, 'down')
  assert.equal(ev.level, 100)
})

/* ── orderflow ──────────────────────────────────────────────────────────── */

test('volume profile puts the POC where the volume is', () => {
  const s = series([
    [100, 101, 100, 100.5, 100],
    [100, 101, 100, 100.5, 100],
    [110, 111, 110, 110.5, 5000], // overwhelming volume up here
  ])
  const p = volumeProfile(s, { binSize: 1 })
  assert.ok(p.poc >= 110 && p.poc < 112, `POC ${p.poc} should sit at the heavy node`)
  assert.equal(p.total, 5200)
})

test('rolling POC resets per day and reports flips', () => {
  const day1 = Array.from({ length: 10 }, (_, i) => bar(Date.UTC(2026, 0, 15, 15, i), 100, 101, 99, 100, 1000))
  const day2 = Array.from({ length: 10 }, (_, i) => bar(Date.UTC(2026, 0, 16, 15, i), 200, 201, 199, 200, 1000))
  const { poc } = rollingPOC([...day1, ...day2], { binSize: 1 })
  assert.ok(poc[9] >= 99 && poc[9] <= 101)
  assert.ok(poc[19] >= 199 && poc[19] <= 201, 'the profile restarted on the new day')
})

test('VWAP sits inside the traded range, with bands that widen on dispersion', () => {
  // Prices must actually vary, or the standard deviation is zero and the bands
  // correctly collapse onto the VWAP.
  const s = Array.from({ length: 10 }, (_, i) =>
    bar(Date.UTC(2026, 0, 15, 15, i), 100 + i, 110 + i, 90 + i, 100 + i, 1000))
  const v = vwap(s)
  assert.ok(v.vwap[9] > 90 && v.vwap[9] < 120)
  assert.ok(v.upper[1][9] > v.vwap[9])
  assert.ok(v.lower[1][9] < v.vwap[9])

  const flat = Array.from({ length: 10 }, (_, i) => bar(Date.UTC(2026, 0, 15, 15, i), 100, 110, 90, 100, 1000))
  const fv = vwap(flat)
  assert.ok(Math.abs(fv.upper[1][9] - fv.vwap[9]) < 1e-6, 'no dispersion means no band width')
})

test('CVD rises when bars close on their highs', () => {
  const s = Array.from({ length: 10 }, (_, i) => bar(Date.UTC(2026, 0, 15, 15, i), 100, 110, 100, 110, 1000))
  const { cumulative } = cvd(s)
  assert.ok(cumulative[9] > 0)
  const sellers = Array.from({ length: 10 }, (_, i) => bar(Date.UTC(2026, 0, 15, 15, i), 110, 110, 100, 100, 1000))
  assert.ok(cvd(sellers).cumulative[9] < 0)
})

test('absorption is heavy volume with no range', () => {
  const normal = Array.from({ length: 25 }, () => [100, 105, 95, 100, 1000])
  const s = series([...normal, [100, 100.5, 99.5, 99.6, 6000]])
  const abs = detectAbsorption(s)
  assert.ok(abs.some((a) => a.index === s.length - 1), 'the tiny-range heavy-volume bar is absorption')
})

test('FootprintOrderflow replaces the proxy delta with real delta', () => {
  const s = Array.from({ length: 30 }, (_, i) => bar(Date.UTC(2026, 0, 15, 15, i), 100, 101, 99, 100.9, 1000))
  const proxy = new BarOrderflow(s)
  assert.equal(proxy.isProxy, true)
  assert.ok(proxy.at(29).delta > 0, 'proxy infers buying from the close near the high')

  // Real data says the opposite: sellers were the aggressors.
  const footprint = s.map(() => ({ buyVolume: 100, sellVolume: 900 }))
  const real = new FootprintOrderflow(s, footprint)
  assert.equal(real.isProxy, false)
  assert.equal(real.at(29).delta, -800, 'real delta overrides the estimate')
  assert.ok(real.at(29).cvd < 0)
})

test('FootprintOrderflow rejects a mismatched feed', () => {
  const s = Array.from({ length: 5 }, (_, i) => bar(i * 60000, 100, 101, 99, 100, 10))
  assert.throws(() => new FootprintOrderflow(s, [{ buyVolume: 1, sellVolume: 1 }]), /length/)
})

/* ── liquidity ──────────────────────────────────────────────────────────── */

test('equal highs cluster into a single stronger pool', () => {
  const swings = [
    { index: 5, type: 'high', price: 100 },
    { index: 15, type: 'high', price: 100.5 },
    { index: 25, type: 'low', price: 90 },
  ]
  const pools = poolsFromSwings([], swings, { tolerance: 2 })
  const buyside = pools.filter((p) => p.side === 'buyside')
  assert.equal(buyside.length, 1)
  assert.equal(buyside[0].touches, 2)
  assert.equal(buyside[0].origin, 'equal-highs')
  assert.equal(buyside[0].price, 100.5, 'the pool anchors at the extreme, where the stops are')
})

test('a sweep that closes back inside is marked reclaimed', () => {
  const s = series([
    [100, 101, 99, 100],
    [100, 101, 99, 100],
    [100, 105, 99, 98], // pierces 102 then closes back below
    [98, 99, 97, 98],
  ])
  const pools = [{ side: 'buyside', price: 102, touches: 1, indices: [0], formedIndex: 0, origin: 'swing', swept: false, sweptIndex: null, reclaimed: false }]
  markSweeps(s, pools)
  assert.equal(pools[0].swept, true)
  assert.equal(pools[0].reclaimed, true)
})

test('a sweep that holds beyond the level is NOT a reclaim', () => {
  const s = series([
    [100, 101, 99, 100],
    [100, 101, 99, 100],
    [100, 106, 99, 105],
    [105, 107, 104, 106],
    [106, 108, 105, 107],
    [107, 109, 106, 108],
  ])
  const pools = [{ side: 'buyside', price: 102, touches: 1, indices: [0], formedIndex: 0, origin: 'swing', swept: false, sweptIndex: null, reclaimed: false }]
  markSweeps(s, pools)
  assert.equal(pools[0].swept, true)
  assert.equal(pools[0].reclaimed, false, 'taking liquidity and holding is continuation, not a reversal setup')
})

test('drawOnLiquidity picks the nearest unswept pool in the direction of travel', () => {
  const pools = [
    { side: 'buyside', price: 110, touches: 1, swept: false, origin: 'swing' },
    { side: 'buyside', price: 105, touches: 2, swept: false, origin: 'equal-highs' },
    { side: 'buyside', price: 103, touches: 1, swept: true, origin: 'swing' },
    { side: 'sellside', price: 90, touches: 1, swept: false, origin: 'swing' },
  ]
  const draw = drawOnLiquidity(pools, 100, 'up')
  assert.equal(draw.price, 105, 'nearest unswept buyside pool')
  assert.equal(drawOnLiquidity(pools, 100, 'down').price, 90)
})

test('premium / discount and the OTE band', () => {
  const range = { high: 200, low: 100 }
  assert.equal(premiumDiscount(180, range, 'up').zone, 'premium')
  assert.equal(premiumDiscount(120, range, 'up').zone, 'discount')
  assert.equal(premiumDiscount(150, range, 'up').zone, 'equilibrium')
  // A 0.7 retracement of an up leg = price at 130, inside the OTE band.
  assert.equal(premiumDiscount(130, range, 'up').inOTE, true)
  assert.equal(premiumDiscount(190, range, 'up').inOTE, false)
})
