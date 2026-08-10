/**
 * The three entry models, plus the imbalance primitives they are built from.
 *
 *   1. IFVG          — inverted fair value gap (the modern engulfing candle)
 *   2. CISD          — change in state of delivery
 *   3. Break & retest — continuation
 *
 * None of these is a signal on its own. They are triggers: the place you get
 * into a market you have already decided to be in. Confirmation lives in the
 * higher-timeframe analysis (step 1/2) and the orderflow (the gate in step 3).
 * Trading them blind — marking every fair value gap on the chart — is exactly
 * the failure mode the system is designed to avoid.
 */

import { atr, volumeBaseline, relativeVolume, closePosition, isBull, isBear } from './candles.js'

/**
 * @typedef {Object} FVG
 * @property {number} index      index of the third bar (gap confirmed here)
 * @property {number} originIndex index of the first bar
 * @property {number} t
 * @property {'bullish'|'bearish'} direction
 * @property {number} top
 * @property {number} bottom
 * @property {number} size
 * @property {boolean} filled     price traded fully through the gap
 * @property {number|null} filledIndex
 * @property {boolean} mitigated  price traded to the 50% of the gap
 * @property {boolean} inverted   price CLOSED through it the other way
 * @property {number|null} invertedIndex
 * @property {number} invertVolume relative volume of the inverting close
 */

/**
 * Three-bar imbalance: bar 1's high below bar 3's low (bullish) or bar 1's low
 * above bar 3's high (bearish). The untraded space between them is the gap.
 */
export function findFVGs(candles, { minSize = 0 } = {}) {
  const out = []
  for (let i = 2; i < candles.length; i++) {
    const a = candles[i - 2]
    const c = candles[i]
    if (a.h < c.l && c.l - a.h > minSize) {
      out.push(mkGap(i, 'bullish', c.l, a.h, candles[i].t))
    } else if (a.l > c.h && a.l - c.h > minSize) {
      out.push(mkGap(i, 'bearish', a.l, c.h, candles[i].t))
    }
  }
  return out
}

function mkGap(index, direction, top, bottom, t) {
  return {
    index,
    originIndex: index - 2,
    t,
    direction,
    top,
    bottom,
    size: top - bottom,
    midpoint: (top + bottom) / 2,
    filled: false,
    filledIndex: null,
    mitigated: false,
    mitigatedIndex: null,
    inverted: false,
    invertedIndex: null,
    invertVolume: 0,
  }
}

/**
 * Resolve fill / mitigation / inversion state for each gap.
 *
 * Inversion is the tradeable event and it has a strict definition here: a bar
 * must CLOSE beyond the far side of the gap, against the gap's direction. A
 * wick through is not an inversion. The relative volume of that closing bar is
 * recorded because an inversion without volume behind it is the version of this
 * model that fails most often.
 */
export function resolveFVGs(candles, fvgs, { volumePeriod = 20 } = {}) {
  const volBase = volumeBaseline(candles, volumePeriod)
  for (const g of fvgs) {
    for (let i = g.index + 1; i < candles.length; i++) {
      const c = candles[i]
      if (!g.mitigated && c.l <= g.midpoint && c.h >= g.midpoint) {
        g.mitigated = true
        g.mitigatedIndex = i
      }
      if (!g.filled) {
        const through = g.direction === 'bullish' ? c.l <= g.bottom : c.h >= g.top
        if (through) {
          g.filled = true
          g.filledIndex = i
        }
      }
      if (!g.inverted) {
        const closedThrough = g.direction === 'bullish' ? c.c < g.bottom : c.c > g.top
        if (closedThrough) {
          g.inverted = true
          g.invertedIndex = i
          g.invertVolume = relativeVolume(candles, i, volBase)
          break
        }
      }
    }
  }
  return fvgs
}

/**
 * Inverted fair value gaps as tradeable zones.
 *
 * Once inverted, a bullish gap becomes resistance and a bearish gap becomes
 * support. The trigger fires when price retests the inverted zone and rejects.
 *
 * @returns {{index:number, direction:'bullish'|'bearish', top:number, bottom:number,
 *            volume:number, gap:FVG}[]} direction = the direction to TRADE
 */
export function invertedFVGs(candles, fvgs, { minVolume = 1.2 } = {}) {
  return fvgs
    .filter((g) => g.inverted && g.invertVolume >= minVolume)
    .map((g) => ({
      index: g.invertedIndex,
      t: candles[g.invertedIndex].t,
      // A bullish gap that inverts is now a bearish signal.
      direction: g.direction === 'bullish' ? 'bearish' : 'bullish',
      top: g.top,
      bottom: g.bottom,
      volume: g.invertVolume,
      gap: g,
    }))
}

/**
 * Balanced price range: a bullish and a bearish gap that overlap. The overlap
 * is a zone price tends to respect on the retest.
 */
export function balancedPriceRanges(fvgs, { maxBarsApart = 30 } = {}) {
  const out = []
  for (let i = 0; i < fvgs.length; i++) {
    for (let j = i + 1; j < fvgs.length; j++) {
      const a = fvgs[i]
      const b = fvgs[j]
      if (b.index - a.index > maxBarsApart) break
      if (a.direction === b.direction) continue
      const top = Math.min(a.top, b.top)
      const bottom = Math.max(a.bottom, b.bottom)
      if (top > bottom) {
        out.push({ index: b.index, top, bottom, midpoint: (top + bottom) / 2, from: [a.index, b.index] })
      }
    }
  }
  return out
}

/**
 * Displacement: an expansion bar that means it.
 *
 * Range well above ATR, volume above baseline, and the close held near the
 * extreme of the bar. Volume confirms intent; closure proves it was not a wick.
 */
export function displacement(candles, opts = {}) {
  const {
    atrPeriod = 14,
    volumePeriod = 20,
    atrFactor = 1.2,
    volumeFactor = 1.3,
    closeStrength = 0.65,
  } = opts
  const atrs = atr(candles, atrPeriod)
  const volBase = volumeBaseline(candles, volumePeriod)
  const out = new Array(candles.length).fill(null)

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const a = atrs[i]
    if (!Number.isFinite(a) || a <= 0) continue
    const atrMultiple = (c.h - c.l) / a
    const rv = relativeVolume(candles, i, volBase)
    const cp = closePosition(c)
    if (atrMultiple < atrFactor || rv < volumeFactor) continue
    if (cp >= closeStrength) out[i] = { index: i, direction: 'up', atrMultiple, relVolume: rv, closePosition: cp }
    else if (cp <= 1 - closeStrength) out[i] = { index: i, direction: 'down', atrMultiple, relVolume: rv, closePosition: cp }
  }
  return out
}

/**
 * Change in state of delivery.
 *
 * The full cycle, as described in the source material: price is trending, it
 * reaches a level, it prints the opposing candles that make you think the trend
 * continues, then it manipulates (sweeps), then it closes back through the
 * origin of those opposing candles with volume — and that close is the change
 * in how price is being delivered.
 *
 * The CISD level is the OPEN of the first candle in the last run of same-side
 * closes. A close beyond that level flips delivery.
 *
 * @returns {{index:number, direction:'up'|'down', level:number, runStart:number,
 *            runEnd:number, relVolume:number, displaced:boolean}[]}
 */
export function detectCISD(candles, opts = {}) {
  const { minRun = 1, volumeFactor = 1.3, volumePeriod = 20 } = opts
  const volBase = volumeBaseline(candles, volumePeriod)
  const disp = displacement(candles, opts)
  const out = []

  let runStart = 0
  let runDir = null

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const dir = isBull(c) ? 'up' : isBear(c) ? 'down' : null
    if (dir === null) continue

    if (dir !== runDir) {
      // The run that just ended is the delivery being challenged.
      if (runDir !== null) {
        const runEnd = i - 1
        const runLength = runEnd - runStart + 1
        if (runLength >= minRun) {
          const level = candles[runStart].o
          const flipped = runDir === 'up' ? c.c < level : c.c > level
          if (flipped) {
            const rv = relativeVolume(candles, i, volBase)
            if (rv >= volumeFactor) {
              out.push({
                index: i,
                t: c.t,
                direction: runDir === 'up' ? 'down' : 'up',
                level,
                runStart,
                runEnd,
                relVolume: rv,
                displaced: Boolean(disp[i]),
              })
            }
          }
        }
      }
      runDir = dir
      runStart = i
    }
  }
  return out
}

/**
 * Break and retest — the continuation model.
 *
 * Requirements, in order:
 *   1. a displacement leg through the level, leaving a fair value gap behind it
 *   2. price returns to the level (the retest)
 *   3. a close back in the direction of the break, off the level
 *
 * Without the gap the "break" is drift, and drift does not continue.
 *
 * @param {import('./candles.js').Candle[]} candles
 * @param {{price:number}[]} levels apex / flip levels to watch
 */
export function detectBreakAndRetest(candles, levels, opts = {}) {
  const { tolerance = 5, maxRetestBars = 40, minRetestBars = 1, volumeFactor = 1.1, volumePeriod = 20, nearestLevels = 10 } = opts
  const volBase = volumeBaseline(candles, volumePeriod)
  const fvgs = resolveFVGs(candles, findFVGs(candles))
  const disp = displacement(candles, opts)
  const out = []

  // Walk bars once, and at each displacement consider only levels that had
  // already formed — scanning every level against every bar is both slow and a
  // lookahead leak, since the level list is ranked by information from later.
  const sorted = [...levels].sort((a, b) => a.index - b.index)
  let formed = 0
  const active = []

  for (let i = 1; i < candles.length; i++) {
    while (formed < sorted.length && sorted[formed].index < i) active.push(sorted[formed++])
    const d = disp[i]
    if (!d) continue
    const c = candles[i]
    const prev = candles[i - 1]

    // Nearest levels to the current price are the only ones that can be broken
    // by this bar.
    const candidatesForBar = active
      .map((l) => ({ l, dist: Math.abs(l.price - c.c) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, nearestLevels)
      .map((x) => x.l)

    for (const level of candidatesForBar) {
      const brokeUp = d.direction === 'up' && prev.c <= level.price && c.c > level.price
      const brokeDown = d.direction === 'down' && prev.c >= level.price && c.c < level.price
      if (!brokeUp && !brokeDown) continue

      // The displacement leg must leave an imbalance behind it.
      const gap = fvgs.find(
        (g) => g.index >= i - 1 && g.index <= i + 2 && g.direction === (brokeUp ? 'bullish' : 'bearish'),
      )
      if (!gap) continue

      // Wait for the retest of the level itself.
      for (let k = i + minRetestBars; k < Math.min(candles.length, i + maxRetestBars); k++) {
        const r = candles[k]
        const touched = r.l - tolerance <= level.price && r.h + tolerance >= level.price
        if (!touched) continue
        // Invalidated if it closes back through the level.
        const failed = brokeUp ? r.c < level.price - tolerance : r.c > level.price + tolerance
        if (failed) break
        // Confirmation: a close back in the break direction, away from the level.
        for (let m = k; m < Math.min(candles.length, k + 5); m++) {
          const conf = candles[m]
          const held = brokeUp ? conf.c > level.price + tolerance : conf.c < level.price - tolerance
          const rv = relativeVolume(candles, m, volBase)
          if (held && rv >= volumeFactor) {
            out.push({
              index: m,
              t: conf.t,
              direction: brokeUp ? 'up' : 'down',
              level: level.price,
              breakIndex: i,
              retestIndex: k,
              gap: { top: gap.top, bottom: gap.bottom },
              relVolume: rv,
            })
            break
          }
        }
        break
      }
    }
  }
  return out.sort((a, b) => a.index - b.index)
}
