/**
 * STEP 3 — The trigger.
 *
 * Three models, and nothing else:
 *
 *   IFVG           — a fair value gap that price closes back through, on
 *                    volume, after liquidity has been taken. The inverted gap
 *                    then acts as the opposite: a bullish gap becomes
 *                    resistance. This is the model that fails most often
 *                    without orderflow confirmation, so the gate is mandatory.
 *
 *   CISD           — change in state of delivery. Trend, reaction at a level,
 *                    manipulation, then a close back through the origin of the
 *                    opposing candles. The most complete of the three because
 *                    the whole cycle has to be present.
 *
 *   Break & retest — continuation only. Not a reversal model. Price has already
 *                    moved, left a gap displacing a level, and comes back to it.
 *
 * Each model returns an entry, and — more importantly — an invalidation. The
 * stop is not a round number of points; it is the price at which the reason for
 * the trade stopped being true.
 */

import { orderflowGate } from './gate.js'

/**
 * @typedef {Object} TriggerRead
 * @property {boolean} fired
 * @property {'IFVG'|'CISD'|'BREAK_RETEST'|null} model
 * @property {'long'|'short'|null} direction
 * @property {number} entry
 * @property {number} stop      the invalidation price
 * @property {number} confidence
 * @property {object} gate      the orderflow gate result
 * @property {string[]} reasons
 */

/**
 * @param {import('../data/market.js').Market} market
 * @param {number} i base bar index
 * @param {'long'|'short'} bias
 */
export function readTrigger(market, i, bias, opts = {}) {
  const {
    microTf = 'micro',
    maxAge = 3,
    stopBufferTicks = 4,
    requireGate = true,
    gateOptions = {},
    models = ['CISD', 'IFVG', 'BREAK_RETEST'],
    /** Floor on the stop distance, so an invalidation cannot sit inside noise. */
    minStopTicks = 8,
    minStopAtrFactor = 0.5,
  } = opts

  const wanted = bias === 'long' ? 'up' : 'down'
  const candidates = []
  for (const model of models) {
    const found = MODELS[model]?.(market, i, bias, wanted, { microTf, maxAge, stopBufferTicks })
    if (found) candidates.push(found)
  }

  if (!candidates.length) {
    return { fired: false, model: null, direction: null, confidence: 0, reasons: ['no entry model present'], gate: null }
  }

  // Price can run past a model's invalidation before the trigger is read — an
  // IFVG whose zone is now behind price, a CISD whose manipulation low has been
  // taken out. The stop would land on the wrong side of the entry, which is not
  // a trade at any size. Drop those outright rather than flipping the sign.
  const usable = candidates.filter((c) => (bias === 'long' ? c.stop < c.entry : c.stop > c.entry))
  if (!usable.length) {
    return {
      fired: false,
      model: null,
      direction: null,
      confidence: 0,
      reasons: ['entry model found but price is already beyond its invalidation'],
      gate: null,
    }
  }
  candidates.length = 0
  candidates.push(...usable)

  // Prefer the most complete model when several print together, then the
  // freshest, then the tightest invalidation.
  const rank = { CISD: 3, BREAK_RETEST: 2, IFVG: 1 }
  candidates.sort((a, b) => rank[b.model] - rank[a.model] || a.age - b.age || a.riskPoints - b.riskPoints)
  const best = candidates[0]

  // A structural invalidation only a few ticks away gets taken out by spread
  // and noise before the idea has been tested. Push it out to the noise floor
  // and say so — the trade is then risking more than the pattern implies, which
  // is information the sizing and the journal both need.
  const microView = market.view(microTf)
  const microIndex = market.indexAt(microTf, i)
  const microAtr = microView.atr[Math.max(0, microIndex)] ?? 0
  const minStop = Math.max(minStopTicks * market.instrument.tickSize, microAtr * minStopAtrFactor)
  if (best.riskPoints < minStop) {
    const sign = bias === 'long' ? -1 : 1
    best.stop = best.entry + sign * minStop
    best.widenedStop = { from: best.riskPoints, to: minStop }
    best.riskPoints = minStop
    best.reasons.push(`structural stop was inside the noise floor — widened to ${minStop.toFixed(2)} pts (0.5x micro ATR)`)
  }

  const gate = orderflowGate(market, i, bias, gateOptions)
  const confidence = Math.max(0, Math.min(1, best.baseConfidence * 0.5 + gate.score * 0.5))

  return {
    fired: (!requireGate || gate.pass) && best.riskPoints > 0,
    model: best.model,
    direction: bias,
    entry: best.entry,
    stop: best.stop,
    riskPoints: best.riskPoints,
    age: best.age,
    widenedStop: best.widenedStop ?? null,
    confidence,
    gate,
    reasons: [...best.reasons, ...gate.reasons],
    conflicts: gate.conflicts,
    detail: best.detail,
  }
}

/* ── The models ─────────────────────────────────────────────────────────── */

const MODELS = {
  /**
   * Inverted fair value gap. Requires: the inversion happened recently, on
   * volume, and liquidity was taken before it. Entry on the retest of the
   * inverted zone; invalidation beyond the far side of the zone.
   */
  IFVG(market, i, bias, wanted, { microTf, maxAge, stopBufferTicks }) {
    const tick = market.instrument.tickSize
    const events = market.eventsAt(microTf, 'inverted', i, { withinBars: maxAge })
    const wantedDir = bias === 'long' ? 'bullish' : 'bearish'
    const ev = events.filter((e) => e.direction === wantedDir).at(-1)
    if (!ev) return null

    // Liquidity must have been taken before the inversion, otherwise this is
    // just a gap being filled in open space.
    const microIndex = market.indexAt(microTf, i)
    const sweptBefore = market.sweptRecently(
      microTf,
      i,
      bias === 'short' ? 'buyside' : 'sellside',
      Math.max(20, microIndex - ev.index + 20),
    )

    const price = market.base[i].c
    const buffer = stopBufferTicks * tick
    const entry = price
    const stop = bias === 'short' ? ev.top + buffer : ev.bottom - buffer
    const riskPoints = Math.abs(entry - stop)

    const reasons = [`IFVG: ${ev.gap.direction} gap ${ev.bottom.toFixed(2)}–${ev.top.toFixed(2)} inverted on ${ev.volume.toFixed(1)}x volume`]
    if (sweptBefore) reasons.push('liquidity was taken before the inversion')

    return {
      model: 'IFVG',
      entry,
      stop,
      riskPoints,
      age: microIndex - ev.index,
      // Without a preceding sweep this model is materially weaker.
      baseConfidence: sweptBefore ? 0.7 : 0.4,
      reasons,
      detail: { zone: { top: ev.top, bottom: ev.bottom }, sweptBefore },
    }
  },

  /**
   * Change in state of delivery. The invalidation is the extreme of the
   * manipulation leg — if price goes back beyond it, delivery did not change.
   */
  CISD(market, i, bias, wanted, { microTf, maxAge, stopBufferTicks }) {
    const tick = market.instrument.tickSize
    const events = market.eventsAt(microTf, 'cisd', i, { withinBars: maxAge })
    const ev = events.filter((e) => e.direction === wanted).at(-1)
    if (!ev) return null

    const view = market.view(microTf)
    const microIndex = market.indexAt(microTf, i)
    // Extreme of the run that got flipped = the manipulation high/low.
    let extreme = bias === 'short' ? -Infinity : Infinity
    for (let k = ev.runStart; k <= ev.runEnd; k++) {
      const c = view.candles[k]
      extreme = bias === 'short' ? Math.max(extreme, c.h) : Math.min(extreme, c.l)
    }

    const buffer = stopBufferTicks * tick
    const entry = market.base[i].c
    const stop = bias === 'short' ? extreme + buffer : extreme - buffer
    const riskPoints = Math.abs(entry - stop)

    const reasons = [
      `CISD ${wanted}: closed through delivery origin ${ev.level.toFixed(2)} on ${ev.relVolume.toFixed(1)}x volume`,
    ]
    if (ev.displaced) reasons.push('the flip bar was a displacement')

    return {
      model: 'CISD',
      entry,
      stop,
      riskPoints,
      age: microIndex - ev.index,
      baseConfidence: ev.displaced ? 0.8 : 0.6,
      reasons,
      detail: { level: ev.level, manipulationExtreme: extreme },
    }
  },

  /**
   * Break and retest. Continuation only — the invalidation is the far side of
   * the level being reclaimed.
   */
  BREAK_RETEST(market, i, bias, wanted, { microTf, maxAge, stopBufferTicks }) {
    const tick = market.instrument.tickSize
    const events = market.eventsAt(microTf, 'breakRetest', i, { withinBars: maxAge })
    const ev = events.filter((e) => e.direction === wanted).at(-1)
    if (!ev) return null

    const view = market.view(microTf)
    const microIndex = market.indexAt(microTf, i)
    // Stop beyond the retest wick, not just the level — the retest bar's
    // extreme is where the market proved the level held.
    let extreme = bias === 'short' ? -Infinity : Infinity
    for (let k = ev.retestIndex; k <= Math.min(ev.index, view.candles.length - 1); k++) {
      const c = view.candles[k]
      extreme = bias === 'short' ? Math.max(extreme, c.h) : Math.min(extreme, c.l)
    }
    const buffer = stopBufferTicks * tick
    const entry = market.base[i].c
    const stop = bias === 'short' ? Math.max(extreme, ev.level) + buffer : Math.min(extreme, ev.level) - buffer
    const riskPoints = Math.abs(entry - stop)

    return {
      model: 'BREAK_RETEST',
      entry,
      stop,
      riskPoints,
      age: microIndex - ev.index,
      baseConfidence: 0.65,
      reasons: [
        `break & retest ${wanted} of ${ev.level.toFixed(2)}: displacement with a gap, retest held, close back through on ${ev.relVolume.toFixed(1)}x volume`,
      ],
      detail: { level: ev.level, gap: ev.gap },
    }
  },
}
