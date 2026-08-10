/**
 * The system: three steps, in order, every time.
 *
 *   1. Context      — what is the market doing, and what is it reaching for?
 *   2. Confirmation — has the structure shown me the weakness/strength yet?
 *   3. Trigger      — an entry model, with the aggressive volume behind it.
 *
 * Steps run in order and short-circuit. If step 1 has no read, the session is
 * over before it started. That is the point: the system exists to stop time
 * being wasted hunting entries in markets that have not told you anything.
 *
 * The output is a complete trade plan — entry, invalidation, targets, grade —
 * or a documented reason why there is no trade. Both are worth recording.
 */

import { readContext } from './context.js'
import { readConfirmation } from './confirmation.js'
import { readTrigger } from './trigger.js'
import { scoreSetup, withMeasuredExpectancy } from './confluence.js'
import { sessionOf, inKillzone, macroWindowOf } from '../core/sessions.js'

export const DEFAULT_CONFIG = {
  /** Only trigger inside a killzone. */
  killzoneOnly: true,
  /** Sessions the system is allowed to trade at all. */
  allowedSessions: ['asia', 'london', 'nyAM', 'nyPM'],
  /** Stand aside inside macro repricing windows — that is where manipulation lives. */
  avoidMacroWindows: true,
  /** Minimum reward:risk after target adjustment. Below this, no trade. */
  minRR: 1.5,
  /** Default scalp target, in R, when no liquidity target is nearer. */
  defaultTargetR: 2,
  /** Grades allowed to produce a signal. */
  tradeableGrades: ['A+', 'A', 'B'],
  /** Points of clearance to leave in front of a liquidity target. */
  targetBufferPoints: 3,
  minContextConfidence: 0.35,
  minConfirmationConfidence: 0.4,
  gateOptions: {},
  triggerOptions: {},
}

/**
 * @typedef {Object} Signal
 * @property {number} t
 * @property {number} index
 * @property {'long'|'short'} direction
 * @property {string} model
 * @property {number} entry
 * @property {number} stop
 * @property {{price:number, r:number, label:string}[]} targets
 * @property {number} riskPoints
 * @property {number} rr
 * @property {string} grade
 * @property {number} score
 * @property {number} sizeMultiplier
 */

export class TradingSystem {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.stats = config.stats ?? null
  }

  /**
   * Evaluate one bar.
   *
   * @param {import('../data/market.js').Market} market
   * @param {number} i base bar index
   * @returns {{signal:Signal|null, rejected:string|null, steps:object}}
   */
  evaluate(market, i) {
    const cfg = this.config
    const bar = market.base[i]
    const session = sessionOf(bar.t)
    const macro = macroWindowOf(bar.t)
    const steps = { session, macroWindow: macro }

    // ── Session filters ───────────────────────────────────────────────────
    if (!cfg.allowedSessions.includes(session)) {
      return reject(steps, `session ${session} not traded`)
    }
    if (cfg.killzoneOnly && !inKillzone(bar.t)) {
      return reject(steps, `outside killzone (${session})`)
    }
    if (cfg.avoidMacroWindows && macro) {
      return reject(steps, `inside ${macro} — algorithmic repricing window, standing aside`)
    }

    // ── Step 1 ────────────────────────────────────────────────────────────
    const context = readContext(market, i, { minConfidence: cfg.minContextConfidence })
    steps.context = context
    if (!context.tradeable) {
      return reject(steps, context.bias ? `context confidence ${context.confidence.toFixed(2)} below threshold` : 'no higher-timeframe bias')
    }

    // ── Step 2 ────────────────────────────────────────────────────────────
    const confirmation = readConfirmation(market, i, context.bias, { minConfidence: cfg.minConfirmationConfidence })
    steps.confirmation = confirmation
    if (!confirmation.confirmed) {
      return reject(steps, `structure has not confirmed the ${context.bias} bias yet`)
    }

    // ── Step 3 ────────────────────────────────────────────────────────────
    const trigger = readTrigger(market, i, context.bias, {
      ...cfg.triggerOptions,
      gateOptions: cfg.gateOptions,
    })
    steps.trigger = trigger
    if (!trigger.fired) {
      const why = trigger.model ? `${trigger.model} present but orderflow gate failed (${trigger.gate?.score.toFixed(2)})` : 'no entry model'
      return reject(steps, why)
    }

    // ── Grade ─────────────────────────────────────────────────────────────
    let scored = scoreSetup({ context, confirmation, trigger })
    if (this.stats) {
      scored = withMeasuredExpectancy(scored, { model: trigger.model, session }, this.stats)
    }
    steps.scored = scored
    if (!cfg.tradeableGrades.includes(scored.grade)) {
      return reject(steps, `setup graded ${scored.grade} (${scored.score.toFixed(2)}) — below the tradeable threshold`)
    }

    // ── Targets ───────────────────────────────────────────────────────────
    const plan = buildTargets(market, i, {
      direction: context.bias,
      entry: trigger.entry,
      stop: trigger.stop,
      draw: context.draw,
      cfg,
    })
    steps.plan = plan
    if (plan.rr < cfg.minRR) {
      return reject(steps, `reward:risk ${plan.rr.toFixed(2)} below minimum ${cfg.minRR} — ${plan.limitedBy}`)
    }

    const signal = {
      t: bar.t,
      index: i,
      session,
      direction: context.bias,
      model: trigger.model,
      entry: trigger.entry,
      stop: trigger.stop,
      riskPoints: trigger.riskPoints,
      targets: plan.targets,
      rr: plan.rr,
      grade: scored.grade,
      score: scored.score,
      sizeMultiplier: scored.sizeMultiplier,
      orderflowIsProxy: trigger.gate?.isProxy ?? true,
      reasons: [...context.reasons, ...confirmation.reasons, ...trigger.reasons],
      conflicts: [...context.conflicts, ...confirmation.conflicts, ...(trigger.conflicts ?? [])],
      limitedBy: plan.limitedBy,
    }
    return { signal, rejected: null, steps }
  }

  /**
   * Evaluate every bar in a series.
   *
   * The same setup stays valid for several bars, so without a cooldown one
   * opportunity reports as a dozen signals. `cooldownBars` collapses a repeat
   * of the same model and direction back into the single trade it really is.
   */
  scan(market, { from = 0, to = market.base.length - 1, cooldownBars = 15 } = {}) {
    const signals = []
    const rejections = new Map()
    let last = null
    for (let i = from; i <= to; i++) {
      const { signal, rejected } = this.evaluate(market, i)
      if (signal) {
        const duplicate =
          last && signal.model === last.model && signal.direction === last.direction && i - last.index <= cooldownBars
        if (duplicate) {
          rejections.set('duplicate of an active setup', (rejections.get('duplicate of an active setup') ?? 0) + 1)
          last = { ...last, index: i }
          continue
        }
        signals.push(signal)
        last = signal
      } else if (rejected) rejections.set(rejected, (rejections.get(rejected) ?? 0) + 1)
    }
    return { signals, rejections: [...rejections.entries()].sort((a, b) => b[1] - a[1]) }
  }
}

function reject(steps, reason) {
  return { signal: null, rejected: reason, steps }
}

/**
 * Build the target ladder.
 *
 * The rule from the source material: take profit just BEFORE the opposing
 * level, not at it. If there is a liquidity pool, a point of control or a
 * significant gap in front of the default target, the target moves in front of
 * that obstacle. If moving it leaves less than the minimum reward:risk, the
 * trade is not worth taking — "you don't sell towards the point of control".
 */
export function buildTargets(market, i, { direction, entry, stop, draw, cfg }) {
  const risk = Math.abs(entry - stop)
  const long = direction === 'long'
  const sign = long ? 1 : -1
  const buffer = cfg.targetBufferPoints

  if (risk <= 0) return { targets: [], rr: 0, limitedBy: 'zero risk distance' }

  let limitedBy = 'default target'
  let ceiling = entry + sign * risk * cfg.defaultTargetR

  const obstacles = []

  // The liquidity target from step 1 — this is where price is actually going.
  if (draw) obstacles.push({ price: draw.price, label: `${draw.origin} liquidity`, kind: 'liquidity' })

  // The point of control ahead of us is an obstacle, not a target.
  const poc = market.orderflow.poc[i]
  if (Number.isFinite(poc) && (long ? poc > entry : poc < entry)) {
    obstacles.push({ price: poc, label: 'session point of control', kind: 'poc' })
  }

  // Opposing pools between us and the target will slow price down.
  const pools = market.poolsAt('micro', i).filter((p) => {
    if (p.swept) return false
    return long ? p.price > entry : p.price < entry
  })
  for (const p of pools.slice(0, 8)) obstacles.push({ price: p.price, label: `${p.origin}`, kind: 'pool' })

  // Nearest obstacle in front of us caps the target.
  const ahead = obstacles
    .filter((o) => (long ? o.price > entry : o.price < entry))
    .sort((a, b) => (long ? a.price - b.price : b.price - a.price))

  const nearest = ahead[0]
  if (nearest) {
    const capped = nearest.price - sign * buffer
    const cappedIsCloser = long ? capped < ceiling : capped > ceiling
    if (cappedIsCloser) {
      ceiling = capped
      limitedBy = `capped just before ${nearest.label} at ${nearest.price.toFixed(2)}`
    } else if (nearest.kind === 'liquidity') {
      // The liquidity pool is beyond the default target: extend to it. This is
      // the 1:11 trade — you let it run when the draw is genuinely further out.
      ceiling = capped
      limitedBy = `extended to ${nearest.label} at ${nearest.price.toFixed(2)}`
    }
  }

  const totalR = (ceiling - entry) / (sign * risk)
  if (!Number.isFinite(totalR) || totalR <= 0) {
    return { targets: [], rr: 0, limitedBy: `no room to a target — ${limitedBy}` }
  }

  // Scale out: bank the first piece at 1R, run the rest to the ceiling.
  const targets = []
  if (totalR >= 2) {
    targets.push({ price: entry + sign * risk * 1, r: 1, label: 'T1 — first scale, cover costs', size: 0.5 })
    targets.push({ price: ceiling, r: round2(totalR), label: `T2 — ${limitedBy}`, size: 0.5 })
  } else {
    targets.push({ price: ceiling, r: round2(totalR), label: `T1 — ${limitedBy}`, size: 1 })
  }

  return { targets, rr: round2(totalR), limitedBy }
}

const round2 = (x) => Math.round(x * 100) / 100
