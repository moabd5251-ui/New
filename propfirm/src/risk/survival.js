/**
 * Survival analysis for a prop firm evaluation.
 *
 * Two separate problems get conflated when people talk about "passing":
 *
 *   1. Having an edge. Hard, uncertain, and not something a simulator can grant
 *      you.
 *   2. Converting an edge into a payout before the drawdown rule kills the
 *      account. This part is arithmetic, and most accounts die here — not from
 *      a bad strategy but from correct trades sized wrongly.
 *
 * This module answers the second question: given an edge you believe you have,
 * what fraction of the drawdown allowance should you risk per trade, and what
 * are the odds you reach the profit target before the floor reaches you?
 *
 * The answer is never "risk as little as possible". A trailing drawdown that
 * follows your equity peak means small size does not make you safe — it makes
 * the race longer, and variance has more time to grind you into a floor that
 * only ever moves up. There is an interior optimum, and it is usually lower
 * than gamblers think and higher than the cautious assume.
 *
 * The other thing this makes visible is that PASSING and BEING PAID are
 * different events. Size up and you pass more often and faster — and then fail
 * the consistency rule, because one outsized day dominates the profit. At 15%
 * risk on a good edge the simulation passes 37% of the time and gets paid 6%.
 * Optimising for the pass is optimising for the wrong outcome.
 *
 * ── What is modelled and what is not ────────────────────────────────────────
 * Modelled: trade-by-trade P&L, the trailing-unrealised floor including the
 * peak reached *inside* a trade, floor locking, daily loss limits,
 * consecutive-loss cutoffs, the daily trade cap and the payout consistency
 * rule.
 *
 * Serial correlation IS modelled, optionally, because it turned out to matter
 * far more than the intra-trade excursion effect this module was originally
 * written around. Real losses cluster: news days, regime changes, tilt. With
 * independent trades and a genuine edge, small size passes an evaluation almost
 * every time — which is true arithmetic and a poor description of reality.
 *
 * Still not modelled: an edge that decays, and execution failure. Both make
 * real outcomes worse. Treat the output as an upper bound, never a forecast.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { PropAccount, accountSpec } from './propfirm.js'
import { mulberry32 } from '../data/synthetic.js'

/**
 * @typedef {Object} EdgeAssumption
 * @property {number} winRate       0..1
 * @property {number} payoffRatio   average win in R (losses are -1R)
 * @property {number} [lossMfeR]    how far a losing trade runs in your favour
 *                                  before failing. Lifts the trailing peak. In
 *                                  practice this is a second-order effect —
 *                                  once the balance is climbing, realised gains
 *                                  set the peak, not excursions — so do not
 *                                  expect it to explain a blown account.
 * @property {number} [tradesPerDay]
 * @property {number} [badRunProb]      chance any given day enters a bad regime
 * @property {number} [badRunDays]      how long a bad regime lasts
 * @property {number} [badRunMultiplier] win rate multiplier while in one
 */

/**
 * Run one evaluation to its conclusion.
 *
 * @returns {{outcome:'pass'|'breach'|'timeout', trades:number, days:number,
 *            balance:number, peak:number, consistencyOk:boolean}}
 */
export function simulateEvaluation({
  preset = '50K',
  riskFraction = 0.05,
  edge,
  rng,
  maxDays = 250,
  rules = {},
  overrides = {},
}) {
  const account = new PropAccount({ preset, rules, ...overrides })
  const riskDollars = account.drawdown * riskFraction
  const { winRate, payoffRatio, lossMfeR = 0.35, tradesPerDay = 3 } = edge

  const { badRunProb = 0, badRunDays = 5, badRunMultiplier = 0.5 } = edge
  let day = 0
  let trades = 0
  let badDaysLeft = 0

  while (day < maxDays) {
    day++
    account.startDay(`d${day}`)

    // Losing stretches arrive together, not spread evenly. This is the
    // difference between a simulator that says you pass and a screen that says
    // you did not.
    if (badDaysLeft > 0) badDaysLeft--
    else if (badRunProb > 0 && rng() < badRunProb) badDaysLeft = badRunDays

    const effectiveWinRate = badDaysLeft > 0 ? winRate * badRunMultiplier : winRate

    for (let k = 0; k < tradesPerDay; k++) {
      const gate = account.canTrade(0, 10 * 60)
      if (!gate.allowed) break

      trades++
      const won = rng() < effectiveWinRate

      // Losers that run your way first still lift the trailing peak. Sweeping
      // this from 0R to 1R moves the breach rate by under a tenth of a percent,
      // though: once the balance is climbing, realised gains set the peak and
      // excursions are lost in the noise. Kept because it is free and correct,
      // not because it explains anything.
      const mfeR = won ? payoffRatio : lossMfeR
      account.mark(mfeR * riskDollars)
      if (account.breached) {
        return finish('breach', account, trades, day)
      }

      const pnl = (won ? payoffRatio : -1) * riskDollars
      account.recordTrade({ pnl })
      if (account.breached) return finish('breach', account, trades, day)
      if (account.passed) return finish('pass', account, trades, day)
    }
  }
  return finish('timeout', account, trades, day)
}

function finish(outcome, account, trades, days) {
  // Consistency gates the evaluation itself: you cannot pass on one outsized
  // day. Whether it also gates later withdrawals once funded is a separate
  // question this simulation does not reach — Lucid's Flex drops it after the
  // pass, which only matters for the funded phase.
  const consistency = account.consistency()
  const paid = outcome === 'pass' && consistency.ok
  const profit = account.balance - account.startingBalance
  // When the account withdraws at each target touch, the cash taken out is
  // already tracked and the closing balance understates what was earned.
  const withdrawn = account.withdrawn ?? 0
  return {
    outcome,
    trades,
    days,
    balance: account.balance,
    peak: account.peak,
    consistencyOk: consistency.ok,
    paid,
    // What actually reaches your bank, after the split.
    targetTouches: account.targetTouches,
    withdrawn,
    payout: paid ? (withdrawn > 0 ? withdrawn : profit * (account.payoutSplit ?? 1)) : 0,
  }
}

/**
 * Monte Carlo across many evaluations.
 *
 * @returns {{passRate:number, breachRate:number, timeoutRate:number,
 *            paidRate:number, medianDaysToPass:number|null, runs:number}}
 */
export function monteCarlo({ preset = '50K', riskFraction = 0.05, edge, runs = 2000, seed = 12345, maxDays = 250, rules = {}, overrides = {} }) {
  const rng = mulberry32(seed)
  let pass = 0
  let breach = 0
  let timeout = 0
  let paid = 0
  let payoutTotal = 0
  const daysToPass = []

  for (let i = 0; i < runs; i++) {
    const r = simulateEvaluation({ preset, riskFraction, edge, rng, maxDays, rules, overrides })
    if (r.outcome === 'pass') {
      pass++
      daysToPass.push(r.days)
      if (r.paid) {
        paid++
        payoutTotal += r.payout
      }
    } else if (r.outcome === 'breach') breach++
    else timeout++
  }

  daysToPass.sort((a, b) => a - b)
  return {
    runs,
    passRate: pass / runs,
    breachRate: breach / runs,
    timeoutRate: timeout / runs,
    paidRate: paid / runs,
    // Averaged over ALL runs, including the ones that breached — this is the
    // number to compare against the evaluation fee.
    expectedPayout: payoutTotal / runs,
    medianDaysToPass: daysToPass.length ? daysToPass[Math.floor(daysToPass.length / 2)] : null,
  }
}

/**
 * Sweep risk sizing to find where the odds peak.
 *
 * The shape of this curve is the whole point: pass probability rises with size,
 * turns over, and collapses. Both tails are ways to fail.
 */
export function riskCurve({ preset = '50K', edge, fractions = [0.02, 0.03, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3], runs = 2000, seed = 12345, maxDays = 250, overrides = {} }) {
  const drawdown = overrides.drawdown ?? accountSpec(preset)?.drawdown
  return fractions.map((riskFraction) => ({
    riskFraction,
    riskDollars: drawdown * riskFraction,
    ...monteCarlo({ preset, riskFraction, edge, runs, seed, maxDays, overrides }),
  }))
}

/**
 * Is buying the evaluation worth the fee?
 *
 * EV = P(paid) × E[payout | paid] − fee, with the payout averaged over every
 * run including the ones that breached. That is the only comparison that means
 * anything: the fee is paid up front and unconditionally, the payout is not.
 *
 * Two readings of a withdrawal threshold are supported, because firms word this
 * differently and the difference is large:
 *   'full'   — pass, then withdraw the whole profit at the split.
 *   'buffer' — only profit ABOVE the threshold is withdrawable; the buffer
 *              stays in the account.
 * If you are unsure which your agreement means, look at both.
 *
 * Not counted: the funded account you still hold after the first withdrawal.
 * A passed account is an ongoing asset with further payouts available, so this
 * is a floor on the value, not the whole of it.
 */
export function evaluationEV({
  preset = 'LUCID-FLEX-50K',
  riskFraction = 0.05,
  edge,
  fee = null,
  payoutMode = null,
  runs = 4000,
  seed = 12345,
  maxDays = 250,
  rules = {},
  overrides = {},
}) {
  const spec = accountSpec(preset) ?? {}
  const cost = fee ?? spec.evaluationFee ?? 0
  const threshold = spec.withdrawalThreshold ?? 0
  const split = spec.payoutSplit ?? 1
  const mode = payoutMode ?? spec.payoutMode ?? 'full'

  const mc = monteCarlo({ preset, riskFraction, edge, runs, seed, maxDays, rules, overrides })

  // `expectedPayout` already applies the split to the whole profit. Under the
  // buffer reading, only the excess above the threshold is withdrawable.
  let expectedPayout = mc.expectedPayout
  const withdrawsAtTouch = rules.withdrawAtTouch ?? spec.withdrawAtTouch ?? false
  if (mode === 'buffer' && !withdrawsAtTouch && mc.paidRate > 0) {
    const avgProfitWhenPaid = mc.expectedPayout / mc.paidRate / split
    const withdrawable = Math.max(0, avgProfitWhenPaid - threshold)
    expectedPayout = mc.paidRate * withdrawable * split
  }

  const payoutPerSuccess = mc.paidRate > 0 ? expectedPayout / mc.paidRate : 0

  return {
    ...mc,
    fee: cost,
    payoutMode: mode,
    withdrawalThreshold: threshold,
    // The payout rate the fee needs to break even. A small payout does not make
    // an attempt bad value on its own — it raises the hit rate required, and
    // that is the number worth comparing your real results against.
    payoutPerSuccess,
    breakevenPaidRate: payoutPerSuccess > 0 ? cost / payoutPerSuccess : Infinity,
    expectedPayout,
    ev: expectedPayout - cost,
    // How many times the fee you get back, on average, per attempt.
    returnOnFee: cost > 0 ? expectedPayout / cost : Infinity,
  }
}

/**
 * The minimum edge that gives a realistic chance, for a given sizing.
 *
 * Answers "what do I actually need to be able to do?" rather than "what would
 * happen if I were good?".
 */
export function requiredEdge({ preset = '50K', riskFraction = 0.05, payoffRatio = 2, target = 0.6, runs = 1000, seed = 999, maxDays = 250, overrides = {}, edgeExtras = {} }) {
  const out = []
  for (let winRate = 0.2; winRate <= 0.65; winRate += 0.05) {
    const mc = monteCarlo({ preset, riskFraction, edge: { winRate, payoffRatio, ...edgeExtras }, runs, seed, maxDays, overrides })
    out.push({ winRate, expectancyR: winRate * payoffRatio - (1 - winRate), ...mc })
  }
  const first = out.find((r) => r.paidRate >= target)
  return { curve: out, minimumWinRate: first?.winRate ?? null, target, payoffRatio }
}

/* ── Two-stage programs: evaluation, then funded ────────────────────────── */

/**
 * Trade an account forward until a stop condition fires.
 *
 * Shared by both stages so the drawdown, daily limits and clustering behave
 * identically either side of the pass.
 *
 * @returns {{days:number, trades:number, stopped:'condition'|'breach'|'timeout'}}
 */
function tradePhase(account, { edge, rng, riskDollars, maxDays, done, onDayEnd }) {
  const { winRate, payoffRatio, lossMfeR = 0.35, tradesPerDay = 3 } = edge
  const { badRunProb = 0, badRunDays = 5, badRunMultiplier = 0.5 } = edge
  let day = 0
  let trades = 0
  let badDaysLeft = 0

  while (day < maxDays) {
    day++
    account.startDay(`d${day}`)
    if (badDaysLeft > 0) badDaysLeft--
    else if (badRunProb > 0 && rng() < badRunProb) badDaysLeft = badRunDays
    const effectiveWinRate = badDaysLeft > 0 ? winRate * badRunMultiplier : winRate

    for (let k = 0; k < tradesPerDay; k++) {
      if (!account.canTrade(0, 10 * 60).allowed) break
      trades++
      const won = rng() < effectiveWinRate
      account.mark((won ? payoffRatio : lossMfeR) * riskDollars)
      if (account.breached) return { day, trades, stopped: 'breach' }
      account.recordTrade({ pnl: (won ? payoffRatio : -1) * riskDollars })
      if (account.breached) return { day, trades, stopped: 'breach' }
      if (done?.(account)) return { day, trades, stopped: 'condition' }
    }
    onDayEnd?.(account, day)
    if (account.breached) return { day, trades, stopped: 'breach' }
    if (done?.(account)) return { day, trades, stopped: 'condition' }
  }
  return { day, trades, stopped: 'timeout' }
}

/**
 * The full journey: pass the evaluation, then draw payouts from the funded
 * account.
 *
 * Structure modelled — reach the profit target to pass (consistency applies),
 * then withdraw anything above the buffer from the funded account (consistency
 * no longer applies). Withdrawals are checked once a day, which is closer to
 * how payouts are actually requested than checking every tick.
 *
 * `fundedResets` covers the ambiguity in how the funded stage begins:
 *   true  — a fresh account at the starting balance, so the buffer has to be
 *           earned again before any cash comes out.
 *   false — the same account carries on from where the evaluation ended, so
 *           the profit already above the buffer is withdrawable immediately.
 * They differ by roughly the size of the first payout; check the agreement.
 */
export function simulateProgram({
  preset = 'LUCID-FLEX-50K',
  riskFraction = 0.05,
  /**
   * Sizing can differ by stage, and probably should. Breaching the evaluation
   * costs the fee and nothing else — you buy another for $150. Breaching a
   * funded account destroys an income stream that pays repeatedly. The downside
   * is asymmetric, so the optimal size is too.
   */
  evalRiskFraction = null,
  fundedRiskFraction = null,
  edge,
  rng,
  evalMaxDays = 250,
  fundedDays = 120,
  fundedResets = null,
}) {
  const spec = accountSpec(preset) ?? {}
  const resets = fundedResets ?? spec.fundedResets ?? true
  const evalRisk = spec.drawdown * (evalRiskFraction ?? riskFraction)
  const fundedRisk = spec.drawdown * (fundedRiskFraction ?? riskFraction)
  const riskDollars = evalRisk
  const buffer = spec.withdrawalThreshold ?? 0
  const split = spec.payoutSplit ?? 1

  // ── Stage 1: the evaluation ───────────────────────────────────────────
  const evaluation = new PropAccount({ preset, rules: { targetTouchesRequired: 1, withdrawAtTouch: false } })
  const evalRun = tradePhase(evaluation, {
    edge,
    rng,
    riskDollars,
    maxDays: evalMaxDays,
    done: (a) => a.passed,
  })

  if (!evaluation.passed) {
    return { outcome: evalRun.stopped === 'breach' ? 'breached-eval' : 'timeout-eval', payout: 0, evalDays: evalRun.day, fundedDays: 0, withdrawals: 0 }
  }
  if (!evaluation.consistency().ok) {
    return { outcome: 'failed-consistency', payout: 0, evalDays: evalRun.day, fundedDays: 0, withdrawals: 0 }
  }

  // ── Stage 2: funded ───────────────────────────────────────────────────
  const funded = new PropAccount({
    preset,
    // Consistency is dropped once funded, and there is no target to "pass" —
    // the account simply runs and pays out above the buffer.
    rules: { consistencyPct: 1, targetTouchesRequired: Number.MAX_SAFE_INTEGER },
    ...(resets ? {} : { startingBalance: evaluation.balance }),
  })
  if (!resets) {
    // Carrying on means the drawdown floor carries too, not a fresh one.
    funded.floor = evaluation.floor
    funded.floorLocked = evaluation.floorLocked
    funded.peak = evaluation.peak
  }

  let withdrawn = 0
  let withdrawals = 0
  const base = resets ? funded.startingBalance : 50000

  const fundedRun = tradePhase(funded, {
    edge,
    rng,
    riskDollars: fundedRisk,
    maxDays: fundedDays,
    onDayEnd: (a) => {
      const profit = a.balance - base
      const excess = profit - buffer
      if (excess > 0) {
        withdrawn += excess * split
        withdrawals++
        a.balance -= excess
      }
    },
  })

  return {
    outcome: withdrawals > 0 ? 'paid' : fundedRun.stopped === 'breach' ? 'breached-funded' : 'funded-no-payout',
    payout: withdrawn,
    withdrawals,
    evalDays: evalRun.day,
    fundedDays: fundedRun.day,
    passedEval: true,
  }
}

/** Monte Carlo over the full two-stage program. */
export function programMonteCarlo({ preset = 'LUCID-FLEX-50K', riskFraction = 0.05, evalRiskFraction = null, fundedRiskFraction = null, edge, runs = 3000, seed = 12345, fee = null, fundedResets = null, fundedDays = 120, evalMaxDays = 250 }) {
  const rng = mulberry32(seed)
  const spec = accountSpec(preset) ?? {}
  const cost = fee ?? spec.evaluationFee ?? 0

  const tally = { paid: 0, passedEval: 0, breachedEval: 0, failedConsistency: 0, breachedFunded: 0 }
  let payoutTotal = 0
  let withdrawalTotal = 0

  for (let i = 0; i < runs; i++) {
    const r = simulateProgram({ preset, riskFraction, evalRiskFraction, fundedRiskFraction, edge, rng, fundedResets, fundedDays, evalMaxDays })
    if (r.passedEval) tally.passedEval++
    if (r.outcome === 'breached-eval') tally.breachedEval++
    if (r.outcome === 'failed-consistency') tally.failedConsistency++
    if (r.outcome === 'breached-funded') tally.breachedFunded++
    if (r.payout > 0) {
      tally.paid++
      payoutTotal += r.payout
      withdrawalTotal += r.withdrawals
    }
  }

  const expectedPayout = payoutTotal / runs
  return {
    runs,
    passEvalRate: tally.passedEval / runs,
    paidRate: tally.paid / runs,
    breachedEvalRate: tally.breachedEval / runs,
    failedConsistencyRate: tally.failedConsistency / runs,
    breachedFundedRate: tally.breachedFunded / runs,
    expectedPayout,
    avgWithdrawals: tally.paid > 0 ? withdrawalTotal / tally.paid : 0,
    fee: cost,
    ev: expectedPayout - cost,
  }
}
