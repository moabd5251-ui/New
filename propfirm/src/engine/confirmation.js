/**
 * STEP 2 — Confirmation.
 *
 * A high being taken is not a reason to sell. The reason to sell is the market
 * then showing weakness — a break of the secondary structure (the structure
 * that forms inside the higher-timeframe impulses and pullbacks), on volume,
 * with closure beyond the level.
 *
 * Volume confirms intent. A big move with no volume behind it is noise; a move
 * that closes decisively beyond a swing on above-average volume is participants
 * committing. This step is what stops step 1's bias from being traded too
 * early, which is the single most expensive habit in this style of trading.
 */

import { touchesAsOf } from '../core/structure.js'

/**
 * @typedef {Object} ConfirmationRead
 * @property {boolean} confirmed
 * @property {number} confidence 0..1
 * @property {object|null} breakEvent the structure break that confirmed it
 * @property {string[]} reasons
 * @property {string[]} conflicts
 */

/**
 * @param {import('../data/market.js').Market} market
 * @param {number} i base bar index
 * @param {'long'|'short'} bias from step 1
 */
export function readConfirmation(market, i, bias, opts = {}) {
  const {
    secondaryTf = 'secondary',
    trendTf = 'trend',
    maxBarsSinceBreak = 20,
    minConfidence = 0.4,
  } = opts

  const reasons = []
  const conflicts = []
  let score = 0
  const wanted = bias === 'long' ? 'up' : 'down'

  const secIndex = market.indexAt(secondaryTf, i)
  if (secIndex < 0) {
    return { confirmed: false, confidence: 0, breakEvent: null, reasons: [], conflicts: ['no closed secondary bar yet'] }
  }

  // ── The structural break in the bias direction ─────────────────────────
  const breaks = market.breaksAt(secondaryTf, i).filter((b) => b.direction === wanted)
  const recent = breaks.filter((b) => secIndex - b.index <= maxBarsSinceBreak)
  const breakEvent = recent.at(-1) ?? null

  if (!breakEvent) {
    conflicts.push(`no ${wanted} break of secondary structure in the last ${maxBarsSinceBreak} bars`)
  } else {
    const age = secIndex - breakEvent.index
    if (breakEvent.confirmed) {
      // Volume AND closure — this is the displacement that confirms intent.
      reasons.push(
        `${breakEvent.kind} ${wanted} through ${breakEvent.level.toFixed(2)} with displacement on ${breakEvent.relVolume.toFixed(1)}x volume (${age} bars ago)`,
      )
      score += 0.45
    } else if (breakEvent.volumeConfirmed) {
      reasons.push(`${breakEvent.kind} ${wanted} on ${breakEvent.relVolume.toFixed(1)}x volume but without a decisive close`)
      score += 0.2
    } else {
      conflicts.push(`${breakEvent.kind} ${wanted} occurred on only ${breakEvent.relVolume.toFixed(1)}x volume — no intent behind it`)
      score += 0.05
    }

    // A change of character carries more weight than continuation: it is the
    // market telling you the previous delivery has ended.
    if (breakEvent.kind === 'CHoCH') {
      reasons.push('break was a change of character, not just continuation')
      score += 0.1
    }
    // Freshness matters — a break 18 bars ago has usually already been traded.
    if (age <= 5) score += 0.1
    else if (age > 12) conflicts.push(`break is ${age} bars old — much of the move may be done`)
  }

  // ── The intermediate trend should not be fighting us ───────────────────
  const trend = market.trendAt(trendTf, i)
  if (trend.trend === 'range') {
    reasons.push('1h in a range — acceptable, the break is the signal')
    score += 0.05
  } else if ((trend.trend === 'up') === (bias === 'long')) {
    reasons.push(`1h trend ${trend.trend} aligns with the ${bias} bias`)
    score += 0.15
  } else {
    conflicts.push(`1h trend ${trend.trend} opposes the ${bias} bias — counter-trend, size down`)
    score -= 0.05
  }

  // ── Reaction at a level, not in open space ─────────────────────────────
  const price = market.base[i].c
  const view = market.view(secondaryTf)
  const nearApex = view.apex
    .filter((a) => a.index <= secIndex)
    .find((a) => Math.abs(a.price - price) <= (view.atr[secIndex] ?? 20) * 0.5)
  if (nearApex) {
    // Touch count as of now, never the level's lifetime total.
    const touches = touchesAsOf(nearApex, secIndex)
    reasons.push(`price reacting at a flipped level (${nearApex.price.toFixed(2)}, ${touches} touches so far)`)
    score += 0.15
  }

  // ── Failure to displace the opposite side ──────────────────────────────
  // "If we want to sell, we have to fail to displace this level." A rejection
  // that never closes beyond the opposing extreme is the cleanest confirmation
  // there is.
  const pd = market.premiumDiscountAt(secondaryTf, i)
  if (pd && pd.inOTE) {
    reasons.push('price retraced into the 0.618–0.79 optimal entry band')
    score += 0.15
  }

  const confidence = Math.max(0, Math.min(1, score))
  return {
    confirmed: confidence >= minConfidence && Boolean(breakEvent),
    confidence,
    breakEvent,
    reasons,
    conflicts,
  }
}
