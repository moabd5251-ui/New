/**
 * Confluence scoring and setup grading.
 *
 * "How many confluences do I have in one area" is the question, and the answer
 * decides whether a setup is A+ or something to leave alone. The weights below
 * are the starting point, not the truth — `withMeasuredExpectancy` reweights a
 * model's contribution using the expectancy actually recorded in the journal,
 * which is the only way these numbers should ever be set.
 *
 * The grade drives position size, not whether the entry criteria were met.
 */

export const DEFAULT_WEIGHTS = {
  context: 0.3,
  confirmation: 0.3,
  trigger: 0.2,
  orderflow: 0.2,
}

export const GRADE_THRESHOLDS = [
  { grade: 'A+', min: 0.8, sizeMultiplier: 1.0 },
  { grade: 'A', min: 0.7, sizeMultiplier: 0.8 },
  { grade: 'B', min: 0.58, sizeMultiplier: 0.5 },
  { grade: 'C', min: 0.45, sizeMultiplier: 0.25 },
  { grade: 'NO-TRADE', min: -Infinity, sizeMultiplier: 0 },
]

/**
 * @param {{context:object, confirmation:object, trigger:object}} steps
 * @param {{weights?:object, bonuses?:object}} [opts]
 */
export function scoreSetup({ context, confirmation, trigger }, opts = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(opts.weights ?? {}) }
  const factors = []

  const add = (name, value, weight, note) => {
    factors.push({ name, value, weight, contribution: value * weight, note })
  }

  add('context', context?.confidence ?? 0, weights.context, context?.cycleNote)
  add('confirmation', confirmation?.confidence ?? 0, weights.confirmation, confirmation?.breakEvent ? `${confirmation.breakEvent.kind} ${confirmation.breakEvent.direction}` : 'no break')
  add('trigger', trigger?.fired ? (trigger.detail?.sweptBefore === false ? 0.6 : 0.85) : 0, weights.trigger, trigger?.model ?? 'none')
  add('orderflow', trigger?.gate?.score ?? 0, weights.orderflow, trigger?.gate?.pass ? 'gate passed' : 'gate failed')

  let score = factors.reduce((a, f) => a + f.contribution, 0)

  // Extra confluences stack on top — these are the "how many things line up in
  // one area" adjustments.
  const bonuses = []
  const applyBonus = (cond, amount, label) => {
    if (!cond) return
    score += amount
    bonuses.push({ label, amount })
  }

  applyBonus(context?.premiumDiscount?.inOTE, 0.05, 'entry inside the optimal trade entry band')
  applyBonus(confirmation?.breakEvent?.kind === 'CHoCH', 0.04, 'confirmation was a change of character')
  applyBonus(trigger?.model === 'CISD', 0.04, 'CISD — the most complete of the three models')
  applyBonus(context?.draw != null && context.draw.touches >= 2, 0.05, 'target is a multi-touch liquidity pool')
  applyBonus((trigger?.gate?.reasons ?? []).some((r) => r.includes('POC flip')), 0.05, 'point of control flipped with the trade')
  applyBonus((trigger?.gate?.reasons ?? []).some((r) => r.includes('absorbed')), 0.04, 'absorption of the opposing side')

  // Penalties for the things that quietly ruin an otherwise clean setup.
  const penalties = []
  const applyPenalty = (cond, amount, label) => {
    if (!cond) return
    score -= amount
    penalties.push({ label, amount })
  }
  applyPenalty((context?.conflicts?.length ?? 0) > 0, 0.05 * (context?.conflicts?.length ?? 0), 'higher-timeframe conflicts')
  applyPenalty((confirmation?.conflicts?.length ?? 0) > 1, 0.05, 'multiple confirmation conflicts')
  applyPenalty(trigger?.gate?.isProxy, 0.05, 'orderflow is estimated from bars, not a real feed')

  score = Math.max(0, Math.min(1, score))
  const tier = GRADE_THRESHOLDS.find((t) => score >= t.min)

  return {
    score,
    grade: tier.grade,
    sizeMultiplier: tier.sizeMultiplier,
    factors,
    bonuses,
    penalties,
  }
}

/**
 * Reweight by measured performance.
 *
 * A model whose journalled expectancy is negative should stop earning score, no
 * matter how good it looks. Requires a meaningful sample — below `minSample`
 * the historical numbers are noise and the defaults stand.
 *
 * @param {object} scored output of scoreSetup
 * @param {{model:string, session:string}} setup
 * @param {object} stats output of journal/stats.js buildStats()
 */
export function withMeasuredExpectancy(scored, setup, stats, { minSample = 20 } = {}) {
  if (!stats) return scored
  const byModel = stats.byModel?.[setup.model]
  const bySession = stats.bySession?.[setup.session]
  const adjustments = []
  let score = scored.score

  if (byModel && byModel.count >= minSample) {
    // Map expectancy in R onto a modest multiplier: -0.2R → 0.8x, +0.4R → 1.1x.
    const factor = clamp(1 + byModel.expectancyR * 0.25, 0.6, 1.15)
    score *= factor
    adjustments.push({ label: `model ${setup.model} expectancy ${byModel.expectancyR.toFixed(2)}R over ${byModel.count} trades`, factor })
  }
  if (bySession && bySession.count >= minSample) {
    const factor = clamp(1 + bySession.expectancyR * 0.15, 0.7, 1.1)
    score *= factor
    adjustments.push({ label: `${setup.session} expectancy ${bySession.expectancyR.toFixed(2)}R over ${bySession.count} trades`, factor })
  }

  score = Math.max(0, Math.min(1, score))
  const tier = GRADE_THRESHOLDS.find((t) => score >= t.min)
  return { ...scored, score, grade: tier.grade, sizeMultiplier: tier.sizeMultiplier, adjustments }
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
