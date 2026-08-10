/**
 * STEP 1 — Context.
 *
 * Before anything else: what is the market doing, and where is it in the
 * liquidity cycle? Price is always reaching for the liquidity above or below,
 * then rebalancing to fair value, then continuing. If external liquidity has
 * just been taken, a rotation is likely and we start hunting the other way.
 *
 * This step never produces a trade. It produces a direction to look in, and a
 * target for price to travel toward. If it produces neither, the day is a
 * no-trade day and steps 2 and 3 never run — which is most of the value.
 */

/**
 * @typedef {Object} ContextRead
 * @property {'long'|'short'|null} bias
 * @property {number} confidence 0..1
 * @property {string} cycle
 * @property {object|null} draw the liquidity target price is reaching for
 * @property {string[]} reasons
 * @property {string[]} conflicts
 */

/**
 * @param {import('../data/market.js').Market} market
 * @param {number} i base bar index
 * @returns {ContextRead}
 */
export function readContext(market, i, opts = {}) {
  const { contextTf = 'context', macroTf = 'macro', minConfidence = 0.35 } = opts

  const reasons = []
  const conflicts = []
  let score = 0
  let bias = null

  const daily = market.trendAt(contextTf, i)
  const macro = market.trendAt(macroTf, i)
  const price = market.base[i].c

  // ── Trend agreement across the two context timeframes ──────────────────
  if (daily.trend !== 'range') {
    reasons.push(`daily structure ${daily.trend} (${describeSwings(daily)})`)
    bias = daily.trend === 'up' ? 'long' : 'short'
    score += 0.25
  }
  if (macro.trend !== 'range') {
    if (bias === null) {
      bias = macro.trend === 'up' ? 'long' : 'short'
      reasons.push(`4h structure ${macro.trend}, daily unclear`)
      score += 0.15
    } else if ((macro.trend === 'up') === (bias === 'long')) {
      reasons.push(`4h agrees with daily (${macro.trend})`)
      score += 0.15
    } else {
      conflicts.push(`4h ${macro.trend} against daily ${daily.trend}`)
      score -= 0.1
    }
  }

  // ── Liquidity cycle: the part that can flip the bias ───────────────────
  const cycle = market.cycleAt(macroTf, i)
  if (cycle.state === 'swept-erl-expect-pullback' && cycle.sweptPool) {
    // External liquidity taken and reclaimed: expect rotation the other way.
    // This is the "we made a new high, took the liquidity, now a pullback is
    // very likely" read — and it overrides a stale trend bias.
    const rotation = cycle.sweptPool.side === 'buyside' ? 'short' : 'long'
    if (bias && bias !== rotation) {
      conflicts.push(`trend says ${bias} but ${cycle.sweptPool.origin} was just swept and reclaimed`)
      // Trust the fresher information — the sweep is the more recent event.
      bias = rotation
      score += 0.2
      reasons.push(`rotation bias ${rotation}: ${cycle.note}`)
    } else {
      bias = rotation
      score += 0.3
      reasons.push(cycle.note)
    }
  } else if (cycle.state === 'seeking-erl') {
    reasons.push(cycle.note)
    score += 0.05
  }

  if (!bias) {
    return {
      bias: null,
      confidence: 0,
      cycle: cycle.state,
      cycleNote: cycle.note,
      draw: null,
      premiumDiscount: null,
      reasons: reasons.length ? reasons : ['no directional read on the higher timeframes'],
      conflicts,
      tradeable: false,
    }
  }

  // ── Draw on liquidity: what is price actually travelling toward? ───────
  const direction = bias === 'long' ? 'up' : 'down'
  const draw = market.drawAt(macroTf, i, direction) ?? market.drawAt(contextTf, i, direction)
  if (draw) {
    reasons.push(`draw on liquidity: ${draw.origin} at ${draw.price.toFixed(2)} (${Math.abs(draw.price - price).toFixed(1)} pts away)`)
    score += 0.2
  } else {
    conflicts.push('no unswept liquidity pool in the bias direction — no obvious target')
    score -= 0.15
  }

  // ── Premium / discount: are we on the right side of the range? ─────────
  const pd = market.premiumDiscountAt(macroTf, i)
  if (pd) {
    const rightSide = (bias === 'short' && pd.zone === 'premium') || (bias === 'long' && pd.zone === 'discount')
    if (rightSide) {
      reasons.push(`price in ${pd.zone} of the 4h range — correct side for a ${bias}`)
      score += 0.15
    } else if (pd.zone === 'equilibrium') {
      reasons.push('price at equilibrium — acceptable but not ideal')
    } else {
      conflicts.push(`price in ${pd.zone} of the 4h range, which is the wrong side for a ${bias}`)
      score -= 0.1
    }
  }

  const confidence = clamp01(score)
  return {
    bias,
    confidence,
    cycle: cycle.state,
    cycleNote: cycle.note,
    draw,
    premiumDiscount: pd,
    reasons,
    conflicts,
    tradeable: confidence >= minConfidence,
  }
}

function describeSwings(t) {
  if (!t.lastHigh || !t.lastLow) return 'insufficient swings'
  return `${t.lastHigh.label ?? '?'}/${t.lastLow.label ?? '?'}`
}

const clamp01 = (x) => Math.max(0, Math.min(1, x))
