/**
 * Market structure — the Dow-theory backbone of the system.
 *
 * "The market moves in trends and cycles": price makes higher highs and higher
 * lows until it doesn't, and the moment it stops is the moment a pullback into
 * internal liquidity becomes likely. This module finds the swings, labels them
 * HH/HL/LH/LL, derives the trend, and detects breaks.
 *
 * A break is only ever "confirmed" with volume AND closure beyond the level.
 * A wick through a swing high is not a break; a close through it on volume is.
 */

import { atr, volumeBaseline, relativeVolume, closePosition } from './candles.js'

/**
 * @typedef {Object} Swing
 * @property {number} index
 * @property {number} t
 * @property {number} price
 * @property {'high'|'low'} type
 * @property {'HH'|'LH'|'HL'|'LL'|null} label
 */

/**
 * Fractal pivots. A pivot high needs `left` bars with lower-or-equal highs
 * before it and `right` bars with strictly lower highs after it. The strict
 * side prevents a flat double-top from registering twice.
 *
 * A pivot is only knowable `right` bars after the fact — callers running in
 * replay must respect that lag rather than reading the array as if it were
 * available in real time.
 *
 * @param {import('./candles.js').Candle[]} candles
 * @returns {Swing[]}
 */
export function findSwings(candles, { left = 2, right = 2 } = {}) {
  const swings = []
  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i]
    let isHigh = true
    let isLow = true
    for (let k = 1; k <= left && (isHigh || isLow); k++) {
      if (candles[i - k].h > c.h) isHigh = false
      if (candles[i - k].l < c.l) isLow = false
    }
    for (let k = 1; k <= right && (isHigh || isLow); k++) {
      if (candles[i + k].h >= c.h) isHigh = false
      if (candles[i + k].l <= c.l) isLow = false
    }
    if (isHigh) swings.push({ index: i, t: c.t, price: c.h, type: 'high', label: null })
    if (isLow) swings.push({ index: i, t: c.t, price: c.l, type: 'low', label: null })
  }
  swings.sort((a, b) => a.index - b.index || (a.type === 'high' ? -1 : 1))
  return swings
}

/**
 * Reduce a raw pivot list to a strictly alternating high/low sequence, keeping
 * the most extreme pivot of each run. Without this a choppy leg produces three
 * highs in a row and every downstream "higher high" test becomes noise.
 */
export function alternate(swings) {
  const out = []
  for (const s of swings) {
    const last = out[out.length - 1]
    if (!last || last.type !== s.type) {
      out.push({ ...s })
      continue
    }
    const moreExtreme = s.type === 'high' ? s.price >= last.price : s.price <= last.price
    if (moreExtreme) out[out.length - 1] = { ...s }
  }
  return out
}

/** Label each swing HH/LH/HL/LL against the previous swing of the same type. */
export function labelSwings(swings) {
  let lastHigh = null
  let lastLow = null
  for (const s of swings) {
    if (s.type === 'high') {
      if (lastHigh !== null) s.label = s.price > lastHigh ? 'HH' : 'LH'
      lastHigh = s.price
    } else {
      if (lastLow !== null) s.label = s.price < lastLow ? 'LL' : 'HL'
      lastLow = s.price
    }
  }
  return swings
}

/**
 * @typedef {Object} StructureBreak
 * @property {number} index      bar that closed beyond the level
 * @property {number} t
 * @property {'BOS'|'CHoCH'} kind  continuation vs. shift in state
 * @property {'up'|'down'} direction
 * @property {number} level      the swing price that was broken
 * @property {number} swingIndex
 * @property {boolean} volumeConfirmed
 * @property {boolean} displaced
 * @property {boolean} confirmed volume AND closure — the only kind we trade
 * @property {number} relVolume
 */

/**
 * Detect breaks of structure and changes of character.
 *
 * BOS   — close beyond the last swing in the direction of the prevailing trend.
 * CHoCH — close beyond the last opposing swing, against the prevailing trend.
 *         This is the "weakness in the market telling me it's time for a
 *         pullback" that promotes a bias into a tradeable direction.
 *
 * @param {import('./candles.js').Candle[]} candles
 * @param {Swing[]} swings alternating + labelled
 */
export function detectBreaks(candles, swings, opts = {}) {
  const {
    volumeFactor = 1.3,
    displacementAtrFactor = 1.2,
    closeStrength = 0.6,
    atrPeriod = 14,
    volumePeriod = 20,
  } = opts

  const atrs = atr(candles, atrPeriod)
  const volBase = volumeBaseline(candles, volumePeriod)
  const breaks = []

  // Walk bars forward, tracking the most recent confirmed swing on each side
  // and the trend implied by the labels seen so far.
  let si = 0
  let lastHigh = null
  let lastLow = null
  let trend = 'range'
  const recentHighs = []
  const recentLows = []

  for (let i = 0; i < candles.length; i++) {
    // A pivot at index p is only visible once `right` bars have printed; the
    // swing list already encodes that, so admit swings whose index < i.
    while (si < swings.length && swings[si].index < i) {
      const s = swings[si]
      if (s.type === 'high') {
        lastHigh = s
        recentHighs.push(s.price)
        if (recentHighs.length > 2) recentHighs.shift()
      } else {
        lastLow = s
        recentLows.push(s.price)
        if (recentLows.length > 2) recentLows.shift()
      }
      if (recentHighs.length === 2 && recentLows.length === 2) {
        const risingHighs = recentHighs[1] > recentHighs[0]
        const risingLows = recentLows[1] > recentLows[0]
        if (risingHighs && risingLows) trend = 'up'
        else if (!risingHighs && !risingLows) trend = 'down'
        else trend = 'range'
      }
      si++
    }

    const c = candles[i]
    const rv = relativeVolume(candles, i, volBase)
    const a = atrs[i]
    const displacedUp =
      Number.isFinite(a) && c.h - c.l >= a * displacementAtrFactor && closePosition(c) >= closeStrength
    const displacedDown =
      Number.isFinite(a) && c.h - c.l >= a * displacementAtrFactor && closePosition(c) <= 1 - closeStrength

    if (lastHigh && !lastHigh.brokenUp && c.c > lastHigh.price) {
      lastHigh.brokenUp = true
      const volumeConfirmed = rv >= volumeFactor
      breaks.push({
        index: i,
        t: c.t,
        kind: trend === 'down' ? 'CHoCH' : 'BOS',
        direction: 'up',
        level: lastHigh.price,
        swingIndex: lastHigh.index,
        volumeConfirmed,
        displaced: displacedUp,
        confirmed: volumeConfirmed && displacedUp,
        relVolume: rv,
      })
    }
    if (lastLow && !lastLow.brokenDown && c.c < lastLow.price) {
      lastLow.brokenDown = true
      const volumeConfirmed = rv >= volumeFactor
      breaks.push({
        index: i,
        t: c.t,
        kind: trend === 'up' ? 'CHoCH' : 'BOS',
        direction: 'down',
        level: lastLow.price,
        swingIndex: lastLow.index,
        volumeConfirmed,
        displaced: displacedDown,
        confirmed: volumeConfirmed && displacedDown,
        relVolume: rv,
      })
    }
  }
  return breaks
}

/**
 * Full structural read of a series.
 *
 * @returns {{swings:Swing[], breaks:StructureBreak[], trend:'up'|'down'|'range',
 *            lastHigh:Swing|null, lastLow:Swing|null, lastBreak:StructureBreak|null,
 *            range:{high:number, low:number, equilibrium:number}|null}}
 */
export function analyzeStructure(candles, opts = {}) {
  const { left = 2, right = 2 } = opts
  const swings = labelSwings(alternate(findSwings(candles, { left, right })))
  const breaks = detectBreaks(candles, swings, opts)

  const highs = swings.filter((s) => s.type === 'high')
  const lows = swings.filter((s) => s.type === 'low')
  const lastHigh = highs[highs.length - 1] ?? null
  const lastLow = lows[lows.length - 1] ?? null

  let trend = 'range'
  if (highs.length >= 2 && lows.length >= 2) {
    const risingHighs = highs[highs.length - 1].price > highs[highs.length - 2].price
    const risingLows = lows[lows.length - 1].price > lows[lows.length - 2].price
    if (risingHighs && risingLows) trend = 'up'
    else if (!risingHighs && !risingLows) trend = 'down'
  }

  // The working range: the most recent swing high/low pair. Premium/discount
  // and every fib measurement is taken from this.
  let rangeInfo = null
  if (lastHigh && lastLow) {
    const high = Math.max(lastHigh.price, lastLow.price)
    const low = Math.min(lastHigh.price, lastLow.price)
    rangeInfo = { high, low, equilibrium: (high + low) / 2 }
  }

  return {
    swings,
    breaks,
    trend,
    lastHigh,
    lastLow,
    lastBreak: breaks[breaks.length - 1] ?? null,
    range: rangeInfo,
  }
}

/**
 * Levels that flipped polarity — a broken swing high that price later leans on
 * as support, or vice versa. The source material calls these "apex" levels and
 * treats them as the anchor for the break-and-retest model.
 *
 * Touches are stored as the bar indices where they happened, not as a total.
 * A total would be a lookahead leak: ranking levels by how often price WILL
 * touch them tells you something the market has not said yet. Use
 * `touchesAsOf()` to read the count that was knowable at a given bar.
 *
 * Returned in formation order.
 *
 * @returns {{price:number, index:number, wasType:'high'|'low', touchIndices:number[]}[]}
 */
export function apexLevels(candles, swings, { tolerance = 2.5, window = 500 } = {}) {
  const out = []
  for (const s of swings) {
    const broken = s.type === 'high' ? s.brokenUp : s.brokenDown
    if (!broken) continue
    const touchIndices = []
    const end = Math.min(candles.length, s.index + 1 + window)
    for (let i = s.index + 1; i < end; i++) {
      const c = candles[i]
      if (c.l - tolerance <= s.price && c.h + tolerance >= s.price) touchIndices.push(i)
    }
    out.push({ price: s.price, index: s.index, wasType: s.type, touchIndices })
  }
  return out.sort((a, b) => a.index - b.index)
}

/** How many times a level had been touched as of bar `k`. */
export function touchesAsOf(level, k) {
  let n = 0
  for (const i of level.touchIndices) {
    if (i > k) break
    n++
  }
  return n
}
