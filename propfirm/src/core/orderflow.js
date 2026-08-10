/**
 * Orderflow: volume profile / point of control, VWAP, and delta.
 *
 * ── An honest note about data ────────────────────────────────────────────────
 * The edge described in the source material comes from real order-by-order
 * data: a heat map of resting passive liquidity, and the aggressive market
 * orders hitting it. That requires a depth-of-market feed (Bookmap, Rithmic,
 * Databento, a CME data subscription). It cannot be reconstructed from OHLCV
 * candles, and pretending otherwise is how backtests lie.
 *
 * So this module defines an interface, `OrderflowProvider`, with two
 * implementations:
 *
 *   BarOrderflow       — derives volume-at-price, POC, VWAP and a delta PROXY
 *                        from candles. The profile and VWAP are genuinely
 *                        accurate to the bar data. The delta is an ESTIMATE
 *                        inferred from where each bar closed in its range; it
 *                        is directionally useful and it is not real delta.
 *
 *   FootprintOrderflow — same interface, fed real bid/ask volume per bar or per
 *                        price level. Use this in production. Everything
 *                        downstream (the step-3 gate, the confluence score) is
 *                        written against the interface, so swapping the feed
 *                        changes nothing else.
 *
 * What is NOT modelled here, because bars cannot support it: the passive
 * heat map, resting-order spoofing, iceberg detection, and per-price absorption.
 * `FootprintOrderflow` exposes hooks for the first and last of those when a
 * real feed supplies them.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { atr, volumeBaseline, relativeVolume, closePosition } from './candles.js'
import { futuresDayKey, sessionOf } from './sessions.js'

/* ── Volume profile ─────────────────────────────────────────────────────── */

/**
 * Volume distributed across price. Each bar's volume is spread evenly over the
 * bins its range covers — the standard approximation when you have bars rather
 * than a tape.
 *
 * @returns {{bins:Map<number,number>, binSize:number, poc:number, vah:number,
 *            val:number, total:number, hvns:number[], lvns:number[]}}
 */
export function volumeProfile(candles, { binSize = 1, from = 0, to = candles.length - 1, valueArea = 0.7 } = {}) {
  const bins = new Map()
  let total = 0
  for (let i = from; i <= to && i < candles.length; i++) {
    const c = candles[i]
    const lo = Math.floor(c.l / binSize)
    const hi = Math.floor(c.h / binSize)
    const n = hi - lo + 1
    const share = c.v / n
    for (let b = lo; b <= hi; b++) {
      bins.set(b, (bins.get(b) ?? 0) + share)
    }
    total += c.v
  }
  return { ...profileStats(bins, binSize, total, valueArea), bins, binSize, total }
}

function profileStats(bins, binSize, total, valueArea) {
  let pocBin = null
  let pocVol = -1
  for (const [b, v] of bins) {
    if (v > pocVol) {
      pocVol = v
      pocBin = b
    }
  }
  if (pocBin === null) return { poc: NaN, vah: NaN, val: NaN, hvns: [], lvns: [] }

  // Value area: expand from the POC, always taking the richer neighbour, until
  // the configured share of total volume is enclosed.
  const sorted = [...bins.keys()].sort((a, b) => a - b)
  const minBin = sorted[0]
  const maxBin = sorted[sorted.length - 1]
  let lo = pocBin
  let hi = pocBin
  let acc = pocVol
  const target = total * valueArea
  while (acc < target && (lo > minBin || hi < maxBin)) {
    const below = lo > minBin ? bins.get(lo - 1) ?? 0 : -1
    const above = hi < maxBin ? bins.get(hi + 1) ?? 0 : -1
    if (above >= below) {
      hi++
      acc += Math.max(above, 0)
    } else {
      lo--
      acc += Math.max(below, 0)
    }
  }

  // High/low volume nodes relative to the mean bin.
  const values = [...bins.values()]
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const hvns = []
  const lvns = []
  for (const [b, v] of bins) {
    if (v >= mean * 1.8) hvns.push(b * binSize + binSize / 2)
    else if (v <= mean * 0.35) lvns.push(b * binSize + binSize / 2)
  }

  return {
    poc: pocBin * binSize + binSize / 2,
    vah: hi * binSize + binSize,
    val: lo * binSize,
    hvns: hvns.sort((a, b) => a - b),
    lvns: lvns.sort((a, b) => a - b),
  }
}

/**
 * The session volume profile, recalculated bar by bar — this is the moving
 * point of control the system watches.
 *
 * When the POC jumps, a large amount of volume just printed at a new price.
 * When price crosses from one side of the POC to the other, that is the "puck
 * flip": control changing hands. The POC then tends to act as support or
 * resistance for the rest of the session, which is what makes it usable both as
 * a trigger and as protection behind an open position.
 *
 * @returns {{poc:number[], pocShift:number[], flips:{index:number, direction:'up'|'down', poc:number}[]}}
 */
export function rollingPOC(candles, { binSize = 1, anchor = 'day' } = {}) {
  const poc = new Array(candles.length).fill(NaN)
  const pocShift = new Array(candles.length).fill(0)
  const flips = []

  let bins = new Map()
  let pocBin = null
  let pocVol = 0
  let anchorKey = null
  let prevSide = null

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const key = anchor === 'session' ? `${futuresDayKey(c.t)}:${sessionOf(c.t)}` : futuresDayKey(c.t)
    if (key !== anchorKey) {
      bins = new Map()
      pocBin = null
      pocVol = 0
      anchorKey = key
      prevSide = null
    }

    const lo = Math.floor(c.l / binSize)
    const hi = Math.floor(c.h / binSize)
    const share = c.v / (hi - lo + 1)
    // Volume only accumulates, so the POC can only move to a bin touched by
    // this bar — no full rescan needed.
    for (let b = lo; b <= hi; b++) {
      const v = (bins.get(b) ?? 0) + share
      bins.set(b, v)
      if (v > pocVol) {
        pocVol = v
        pocBin = b
      }
    }

    const p = pocBin * binSize + binSize / 2
    poc[i] = p
    if (i > 0 && Number.isFinite(poc[i - 1])) pocShift[i] = p - poc[i - 1]

    const side = c.c > p ? 'above' : c.c < p ? 'below' : prevSide
    if (prevSide && side && side !== prevSide) {
      flips.push({ index: i, t: c.t, direction: side === 'above' ? 'up' : 'down', poc: p })
    }
    prevSide = side
  }
  return { poc, pocShift, flips }
}

/* ── VWAP ───────────────────────────────────────────────────────────────── */

/**
 * Session-anchored VWAP with standard-deviation bands. More dynamic than the
 * POC — the two together bracket the area where the session's business is
 * being done.
 */
export function vwap(candles, { anchor = 'day', bands = [1, 2] } = {}) {
  const out = { vwap: new Array(candles.length).fill(NaN), upper: {}, lower: {} }
  for (const b of bands) {
    out.upper[b] = new Array(candles.length).fill(NaN)
    out.lower[b] = new Array(candles.length).fill(NaN)
  }

  let anchorKey = null
  let pv = 0
  let vol = 0
  let pv2 = 0

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const key = anchor === 'session' ? `${futuresDayKey(c.t)}:${sessionOf(c.t)}` : futuresDayKey(c.t)
    if (key !== anchorKey) {
      pv = 0
      vol = 0
      pv2 = 0
      anchorKey = key
    }
    const tp = (c.h + c.l + c.c) / 3
    pv += tp * c.v
    pv2 += tp * tp * c.v
    vol += c.v
    if (vol <= 0) continue
    const v = pv / vol
    out.vwap[i] = v
    const variance = Math.max(0, pv2 / vol - v * v)
    const sd = Math.sqrt(variance)
    for (const b of bands) {
      out.upper[b][i] = v + sd * b
      out.lower[b][i] = v - sd * b
    }
  }
  return out
}

/* ── Delta ──────────────────────────────────────────────────────────────── */

/**
 * Per-bar delta ESTIMATE from bar geometry.
 *
 * A bar that closes on its high is assumed to have been driven by aggressive
 * buyers; one that closes on its low by aggressive sellers. This is a proxy —
 * see the module header. Replace with `FootprintOrderflow` when a real feed is
 * available.
 */
export function deltaProxy(candles) {
  return candles.map((c) => c.v * (2 * closePosition(c) - 1))
}

/**
 * Cumulative volume delta, reset per anchor, plus the spikes of aggression that
 * matter more than the running total.
 */
export function cvd(candles, { anchor = 'day', deltas = null, spikeSigma = 2 } = {}) {
  const d = deltas ?? deltaProxy(candles)
  const cumulative = new Array(candles.length).fill(0)
  let anchorKey = null
  let acc = 0
  for (let i = 0; i < candles.length; i++) {
    const key = anchor === 'session' ? `${futuresDayKey(candles[i].t)}:${sessionOf(candles[i].t)}` : futuresDayKey(candles[i].t)
    if (key !== anchorKey) {
      acc = 0
      anchorKey = key
    }
    acc += d[i]
    cumulative[i] = acc
  }

  // Rolling sigma of delta so "a big print" is measured against recent activity
  // rather than an absolute contract count.
  const window = 30
  const spikes = []
  for (let i = window; i < d.length; i++) {
    const slice = d.slice(i - window, i)
    const mean = slice.reduce((a, b) => a + b, 0) / window
    const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / window)
    if (sd > 0 && Math.abs(d[i] - mean) >= sd * spikeSigma) {
      spikes.push({ index: i, delta: d[i], sigma: (d[i] - mean) / sd, direction: d[i] > 0 ? 'buy' : 'sell' })
    }
  }
  return { delta: d, cumulative, spikes }
}

/**
 * Absorption: heavy volume that fails to move price.
 *
 * A bar with well-above-average volume and a below-average range means one side
 * kept hitting and the other side kept filling them. At the top of a move that
 * is sellers absorbing buyers — the moment control changes, before price shows
 * it.
 */
export function detectAbsorption(candles, opts = {}) {
  const { volumeFactor = 1.7, rangeFactor = 0.7, atrPeriod = 14, volumePeriod = 20 } = opts
  const atrs = atr(candles, atrPeriod)
  const volBase = volumeBaseline(candles, volumePeriod)
  const out = []
  for (let i = 0; i < candles.length; i++) {
    const a = atrs[i]
    if (!Number.isFinite(a) || a <= 0) continue
    const rv = relativeVolume(candles, i, volBase)
    const rangeRatio = (candles[i].h - candles[i].l) / a
    if (rv >= volumeFactor && rangeRatio <= rangeFactor) {
      const cp = closePosition(candles[i])
      out.push({
        index: i,
        t: candles[i].t,
        relVolume: rv,
        rangeRatio,
        // Closing low on heavy volume = buyers absorbed; the sellers won.
        absorbedSide: cp < 0.4 ? 'buyers' : cp > 0.6 ? 'sellers' : 'both',
      })
    }
  }
  return out
}

/* ── Providers ──────────────────────────────────────────────────────────── */

/**
 * Bar-derived orderflow. Accurate profile/VWAP, proxied delta.
 */
export class BarOrderflow {
  /**
   * @param {import('./candles.js').Candle[]} candles
   */
  constructor(candles, opts = {}) {
    this.candles = candles
    this.opts = opts
    this.binSize = opts.binSize ?? 1
    this.isProxy = true
    const { poc, pocShift, flips } = rollingPOC(candles, { binSize: this.binSize, anchor: opts.anchor ?? 'day' })
    this.poc = poc
    this.pocShift = pocShift
    this.flips = flips
    this.flipsByIndex = new Map(flips.map((f) => [f.index, f]))
    this.vw = vwap(candles, { anchor: opts.anchor ?? 'day' })
    this.cv = cvd(candles, { anchor: opts.anchor ?? 'day' })
    this.absorption = detectAbsorption(candles, opts)
    this.absorptionByIndex = new Map(this.absorption.map((a) => [a.index, a]))
    this.volBase = volumeBaseline(candles, opts.volumePeriod ?? 20)
    this.profileCache = new Map()
  }

  /** Everything the decision layer needs about bar `i`, in one object. */
  at(i) {
    return {
      index: i,
      price: this.candles[i].c,
      poc: this.poc[i],
      pocShift: this.pocShift[i],
      pocFlip: this.flipsByIndex.get(i) ?? null,
      vwap: this.vw.vwap[i],
      vwapUpper1: this.vw.upper[1][i],
      vwapLower1: this.vw.lower[1][i],
      delta: this.cv.delta[i],
      cvd: this.cv.cumulative[i],
      relVolume: relativeVolume(this.candles, i, this.volBase),
      absorption: this.absorptionByIndex.get(i) ?? null,
      isProxy: true,
    }
  }

  /** Sum of delta over the trailing `n` bars — short-term aggressor balance. */
  deltaWindow(i, n = 5) {
    let sum = 0
    for (let k = Math.max(0, i - n + 1); k <= i; k++) sum += this.cv.delta[k]
    return sum
  }

  /** Session profile up to bar `i` (low-volume nodes, value area). */
  profileTo(i, lookback = 240) {
    const key = `${i}:${lookback}`
    const hit = this.profileCache.get(key)
    if (hit) return hit
    const p = volumeProfile(this.candles, {
      binSize: this.binSize,
      from: Math.max(0, i - lookback),
      to: i,
    })
    this.profileCache.set(key, p)
    return p
  }
}

/**
 * Real-feed orderflow. Same interface; supply true buy/sell volume per bar and
 * optionally a resting-liquidity snapshot per bar.
 *
 * @param {import('./candles.js').Candle[]} candles
 * @param {{buyVolume:number, sellVolume:number, restingBid?:number, restingAsk?:number}[]} footprint
 */
export class FootprintOrderflow extends BarOrderflow {
  constructor(candles, footprint, opts = {}) {
    super(candles, opts)
    if (footprint.length !== candles.length) {
      throw new Error(`footprint length ${footprint.length} !== candles length ${candles.length}`)
    }
    this.footprint = footprint
    this.isProxy = false
    // Replace the proxy delta with the real thing and recompute CVD.
    const deltas = footprint.map((f) => f.buyVolume - f.sellVolume)
    this.cv = cvd(candles, { anchor: opts.anchor ?? 'day', deltas })
  }

  at(i) {
    const base = super.at(i)
    const f = this.footprint[i]
    return {
      ...base,
      isProxy: false,
      delta: this.cv.delta[i],
      cvd: this.cv.cumulative[i],
      buyVolume: f.buyVolume,
      sellVolume: f.sellVolume,
      restingBid: f.restingBid ?? null,
      restingAsk: f.restingAsk ?? null,
    }
  }
}
