/**
 * The orderflow gate.
 *
 * An entry model is a trigger, not a reason. This is the check that runs
 * between "the pattern printed" and "I am in the market": is the aggressive
 * volume actually on my side right now?
 *
 * What it looks for, in the language of the system:
 *   • a point-of-control flip — control changing hands, and the POC then
 *     standing behind the trade as protection rather than in front of it
 *   • POC migration in the direction of the trade (volume printing lower on a
 *     short means the sellers are the ones doing business)
 *   • aggressor delta and CVD leaning the right way
 *   • absorption of the other side at the extreme we are fading
 *
 * The gate is deliberately strict. Most of the time it says no, and the correct
 * response to that is to not take the trade — the pattern being there is not
 * enough. Every check reports itself so the journal records WHY a trade was
 * allowed, not just that it was.
 */

/**
 * @typedef {Object} GateResult
 * @property {boolean} pass
 * @property {number} score 0..1
 * @property {string[]} reasons
 * @property {string[]} conflicts
 * @property {boolean} isProxy true when running on bar-derived (estimated) delta
 */

/**
 * @param {import('../data/market.js').Market} market
 * @param {number} i base bar index
 * @param {'long'|'short'} direction
 * @returns {GateResult}
 */
export function orderflowGate(market, i, direction, opts = {}) {
  const {
    minScore = 0.5,
    deltaWindow = 5,
    pocShiftWindow = 10,
    cvdWindow = 15,
    minRelVolume = 1.2,
    flipLookback = 8,
  } = opts

  const of = market.orderflow
  const snap = of.at(i)
  const long = direction === 'long'
  const reasons = []
  const conflicts = []
  let score = 0

  // ── Point of control: which side of it are we, and is it moving with us? ──
  if (Number.isFinite(snap.poc)) {
    const price = snap.price
    const above = price > snap.poc
    if (above === long) {
      reasons.push(`price ${above ? 'above' : 'below'} session POC ${snap.poc.toFixed(2)} — POC sits behind the trade as protection`)
      score += 0.2
    } else {
      conflicts.push(`price ${above ? 'above' : 'below'} POC ${snap.poc.toFixed(2)} — trading into the point of control`)
      score -= 0.15
    }

    // A recent flip is stronger evidence than merely being on the right side.
    const flip = of.flips.find((f) => f.index <= i && i - f.index <= flipLookback && (f.direction === 'up') === long)
    if (flip) {
      reasons.push(`POC flip ${flip.direction} ${i - flip.index} bars ago — control changed hands`)
      score += 0.2
    }

    // POC migration: the profile recalculating in our direction means the
    // volume entering the market right now is on our side.
    let shift = 0
    for (let k = Math.max(1, i - pocShiftWindow + 1); k <= i; k++) shift += of.pocShift[k] ?? 0
    if (Math.abs(shift) > 0) {
      if ((shift > 0) === long) {
        reasons.push(`POC migrating ${shift > 0 ? 'up' : 'down'} (${shift.toFixed(2)} pts over ${pocShiftWindow} bars)`)
        score += 0.15
      } else {
        conflicts.push(`POC migrating ${shift > 0 ? 'up' : 'down'} against the trade`)
        score -= 0.1
      }
    }
  }

  // ── VWAP as the second reference of fair value ─────────────────────────
  if (Number.isFinite(snap.vwap)) {
    const above = snap.price > snap.vwap
    if (above === long) {
      reasons.push(`price ${above ? 'above' : 'below'} VWAP ${snap.vwap.toFixed(2)}`)
      score += 0.1
    } else {
      conflicts.push(`price on the wrong side of VWAP ${snap.vwap.toFixed(2)}`)
      score -= 0.05
    }
  }

  // ── Aggressors: is anyone actually hitting in our direction? ───────────
  const dWindow = of.deltaWindow(i, deltaWindow)
  if ((dWindow > 0) === long && Math.abs(dWindow) > 0) {
    reasons.push(`${deltaWindow}-bar delta ${dWindow > 0 ? '+' : ''}${dWindow.toFixed(0)} — aggressors on our side`)
    score += 0.2
  } else {
    conflicts.push(`${deltaWindow}-bar delta ${dWindow.toFixed(0)} is against the trade — no aggression supporting it`)
    score -= 0.2
  }

  // CVD slope over a longer window: the sustained balance, not one print.
  const cvdNow = of.cv.cumulative[i]
  const cvdThen = of.cv.cumulative[Math.max(0, i - cvdWindow)]
  const cvdSlope = cvdNow - cvdThen
  if ((cvdSlope > 0) === long) {
    reasons.push(`CVD ${cvdSlope > 0 ? 'rising' : 'falling'} over ${cvdWindow} bars`)
    score += 0.1
  } else {
    conflicts.push(`CVD moving against the trade over ${cvdWindow} bars`)
    score -= 0.05
  }

  // A spike of aggression on our side inside the last few bars is the "now"
  // signal — the moment the volume gets in.
  const spike = of.cv.spikes.find((s) => s.index <= i && i - s.index <= 3 && (s.direction === 'buy') === long)
  if (spike) {
    reasons.push(`${spike.sigma.toFixed(1)}σ ${spike.direction} aggression spike ${i - spike.index} bars ago`)
    score += 0.15
  }

  // ── Absorption of the opposing side ────────────────────────────────────
  const absorbed = of.absorption.find((a) => a.index <= i && i - a.index <= 5)
  if (absorbed) {
    const helpful = long ? absorbed.absorbedSide === 'sellers' : absorbed.absorbedSide === 'buyers'
    if (helpful) {
      reasons.push(`${absorbed.relVolume.toFixed(1)}x volume absorbed by the ${long ? 'buyers' : 'sellers'} without price moving — the other side is being filled into`)
      score += 0.15
    }
  }

  // ── Participation ──────────────────────────────────────────────────────
  if (snap.relVolume >= minRelVolume) {
    reasons.push(`trigger bar on ${snap.relVolume.toFixed(1)}x average volume`)
    score += 0.1
  } else {
    conflicts.push(`trigger bar volume only ${snap.relVolume.toFixed(1)}x average — no participation`)
    score -= 0.15
  }

  const finalScore = Math.max(0, Math.min(1, score))
  return {
    pass: finalScore >= minScore,
    score: finalScore,
    reasons,
    conflicts,
    isProxy: snap.isProxy,
    snapshot: snap,
  }
}
