/**
 * Daily-bar chart analysis for an equity.
 *
 * Two jobs. First, describe where a name actually sits — trend by Dow
 * structure, the support and resistance shelves price has respected, its
 * position in the recent range, and volatility. Second, and the reason this
 * exists at all: supply a defensible TARGET.
 *
 * A vertical spread only needs a direction. A butterfly needs to know where
 * price is going to stop, and picking that by eye is how a structure with a
 * genuine payoff profile becomes a guess with four commissions. Resistance
 * shelves — prices that have repeatedly turned the market — are the least
 * arbitrary target available from the chart alone.
 *
 * Everything is computed from completed daily bars, causally: a swing is only
 * counted once its confirmation bars exist.
 */

import { atr } from '../core/candles.js'
import { findSwings } from '../core/structure.js'

export const CHART_DEFAULTS = {
  swingLeft: 2,
  swingRight: 2,
  atrPeriod: 14,
  /** Levels within this fraction of ATR merge into one shelf. */
  clusterAtrFraction: 0.6,
  rangeLookback: 60,
}

/** Tradier daily rows → engine candles. */
export const toCandles = (rows) =>
  rows.map((d) => ({ t: Date.parse(`${d.date}T00:00:00Z`), o: d.o, h: d.h, l: d.l, c: d.c, v: d.v }))

/**
 * Cluster swing prices into shelves, weighted by how often price turned there.
 * A level touched four times is a different object from one touched once.
 */
function shelves(swings, tolerance) {
  const out = []
  for (const s of [...swings].sort((a, b) => a.price - b.price)) {
    const last = out[out.length - 1]
    if (last && s.price - last.price <= tolerance) {
      last.touches++
      last.price = (last.price * (last.touches - 1) + s.price) / last.touches
      last.lastIndex = Math.max(last.lastIndex, s.index)
    } else {
      out.push({ price: s.price, touches: 1, type: s.type, lastIndex: s.index })
    }
  }
  return out
}

/**
 * @param {{date:string,o:number,h:number,l:number,c:number,v:number}[]} rows
 * @returns {object|null} null when there is not enough history to say anything
 */
export function analyzeChart(rows, opts = {}) {
  const cfg = { ...CHART_DEFAULTS, ...opts }
  const candles = toCandles(rows)
  if (candles.length < cfg.rangeLookback) return null

  const atrs = atr(candles, cfg.atrPeriod)
  const last = candles.length - 1
  const price = candles[last].c
  const a = atrs[last]
  if (!Number.isFinite(a) || a <= 0) return null

  // Swings are only knowable `swingRight` bars after they print; the most
  // recent unconfirmed pivots are excluded rather than assumed.
  const swings = findSwings(candles, { left: cfg.swingLeft, right: cfg.swingRight })
    .filter((s) => s.index + cfg.swingRight <= last)

  const highs = swings.filter((s) => s.type === 'high')
  const lows = swings.filter((s) => s.type === 'low')
  const tolerance = a * cfg.clusterAtrFraction

  const resistance = shelves(highs, tolerance)
    .filter((l) => l.price > price)
    .sort((x, y) => x.price - y.price)
  const support = shelves(lows, tolerance)
    .filter((l) => l.price < price)
    .sort((x, y) => y.price - x.price)

  // Dow structure on the last two confirmed pivots of each kind.
  const h1 = highs.at(-1)?.price, h2 = highs.at(-2)?.price
  const l1 = lows.at(-1)?.price, l2 = lows.at(-2)?.price
  const trend =
    h1 != null && h2 != null && l1 != null && l2 != null
      ? h1 > h2 && l1 > l2 ? 'up' : h1 < h2 && l1 < l2 ? 'down' : 'mixed'
      : 'unknown'

  const window = candles.slice(-cfg.rangeLookback)
  const hi = Math.max(...window.map((c) => c.h))
  const lo = Math.min(...window.map((c) => c.l))
  const position = hi > lo ? (price - lo) / (hi - lo) : 0.5

  return {
    price,
    atr: a,
    atrPct: a / price,
    trend,
    resistance: resistance.slice(0, 4),
    support: support.slice(0, 4),
    range: { high: hi, low: lo, position },
    zone: position >= 0.7 ? 'premium' : position <= 0.3 ? 'discount' : 'equilibrium',
    lastSwingHigh: h1 ?? null,
    lastSwingLow: l1 ?? null,
  }
}

/**
 * The target a butterfly should be centred on, and why.
 *
 * For an up-gap the natural stopping place is the next resistance shelf; for
 * a down-gap, the next support. A shelf touched more than once is preferred
 * over a nearer single touch, because repetition is the only evidence a chart
 * offers that a level means something. Falling back to "one ATR away" is
 * flagged as such — an unlabelled fallback is how a guess gets mistaken for
 * analysis.
 */
export function targetFor(chart, direction, { minAtr = 0.5, maxAtr = 6 } = {}) {
  if (!chart) return null
  const levels = direction === 'up' ? chart.resistance : chart.support
  const away = (l) => Math.abs(l.price - chart.price) / chart.atr

  const usable = levels.filter((l) => away(l) >= minAtr && away(l) <= maxAtr)
  if (usable.length) {
    // Prefer a repeatedly-tested shelf; among equals take the nearest.
    const best = usable.reduce((a, b) => (b.touches > a.touches ? b : a))
    return {
      price: best.price,
      basis: `${best.touches > 1 ? `${best.touches}-touch ` : ''}${direction === 'up' ? 'resistance' : 'support'} shelf`,
      atrAway: away(best),
      touches: best.touches,
      inferred: false,
    }
  }
  const fallback = chart.price + (direction === 'up' ? 1 : -1) * chart.atr * 1.5
  return {
    price: fallback,
    basis: 'no shelf in range — 1.5 ATR projection',
    atrAway: 1.5,
    touches: 0,
    inferred: true,
  }
}
