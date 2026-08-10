/**
 * Position sizing.
 *
 * Size comes from the stop distance, never from conviction. The grade only
 * scales an already-correct number down; it never scales it up beyond the risk
 * budget. On a trailing-drawdown account the binding constraint is usually not
 * the risk-per-trade rule but the remaining room to the floor — so the smaller
 * of the two always wins, and micros are used when a single mini is too much
 * account to put at risk.
 */

import { INSTRUMENTS } from './propfirm.js'

/**
 * @param {{account:import('./propfirm.js').PropAccount, signal:object,
 *          instrument?:object, useMicros?:boolean}} args
 * @returns {{contracts:number, symbol:string, riskDollars:number, riskPerContract:number,
 *            limitedBy:string, allowed:boolean, reason:string|null, targets:object[]}}
 */
export function sizePosition({ account, signal, instrument = null, useMicros = 'auto' }) {
  const inst = instrument ?? account.instrument ?? INSTRUMENTS.NQ
  const stopPoints = Math.abs(signal.entry - signal.stop)
  if (!(stopPoints > 0)) {
    return deny('stop distance is zero — no valid invalidation')
  }

  const rules = account.rules
  // Three independent ceilings; the tightest one binds.
  const byRiskRule = account.drawdown * rules.riskPerTradePct
  const byDailyRoom = account.dailyRoom
  const byAccountRoom = account.room * 0.5 // never risk more than half the remaining account in one trade
  const budget = Math.min(byRiskRule, byDailyRoom, byAccountRoom) * (signal.sizeMultiplier ?? 1)

  const limitedBy =
    budget === byDailyRoom * (signal.sizeMultiplier ?? 1) ? 'daily loss room'
      : budget === byAccountRoom * (signal.sizeMultiplier ?? 1) ? 'remaining drawdown room'
        : 'risk-per-trade rule'

  if (budget <= 0) return deny('no risk budget available')

  const pick = (spec) => {
    const riskPerContract = stopPoints * spec.pointValue
    return { spec, riskPerContract, contracts: Math.floor(budget / riskPerContract) }
  }

  let chosen = pick(inst)
  // Fall back to micros when the budget cannot afford a single mini.
  if (chosen.contracts < 1 && useMicros !== false) {
    const micro = microOf(inst)
    if (micro) chosen = pick(micro)
  }

  if (chosen.contracts < 1) {
    return deny(
      `stop of ${stopPoints.toFixed(2)} pts risks $${chosen.riskPerContract.toFixed(2)} per contract, above the $${budget.toFixed(2)} budget — stop is too wide for this account`,
    )
  }

  const isMicroContract = chosen.spec.symbol.startsWith('M')
  const cap = isMicroContract ? (account.maxMicros ?? account.maxContracts * 10) : account.maxContracts
  const contracts = Math.min(chosen.contracts, cap)
  const riskDollars = contracts * chosen.riskPerContract

  return {
    allowed: true,
    reason: null,
    contracts,
    symbol: chosen.spec.symbol,
    instrument: chosen.spec,
    riskPerContract: chosen.riskPerContract,
    riskDollars,
    stopPoints,
    limitedBy: contracts === cap ? 'firm contract limit' : limitedBy,
    budget,
    targets: allocateTargets(signal.targets ?? [], contracts, signal.entry, chosen.spec),
  }
}

/**
 * Split the position across the target ladder.
 *
 * Whole contracts only, and the total must equal the position — rounding each
 * target independently is how a 1-lot ends up with a 2-lot exit plan. Any
 * remainder goes to the final target, so a single contract simply runs to the
 * last target instead of pretending to scale out of itself.
 */
function allocateTargets(targets, contracts, entry, spec) {
  if (!targets.length) return []
  const alloc = targets.map((t) => Math.floor(contracts * (t.size ?? 1)))
  const assigned = alloc.reduce((a, b) => a + b, 0)
  alloc[alloc.length - 1] += contracts - assigned
  return targets
    .map((t, i) => ({
      ...t,
      contracts: alloc[i],
      dollars: Math.abs(t.price - entry) * spec.pointValue * alloc[i],
    }))
    .filter((t) => t.contracts > 0)
}

function microOf(inst) {
  const map = { NQ: INSTRUMENTS.MNQ, ES: INSTRUMENTS.MES }
  return map[inst.symbol] ?? null
}

function deny(reason) {
  return { allowed: false, reason, contracts: 0, riskDollars: 0, targets: [] }
}

/** Round a price to the instrument's tick grid. */
export function roundToTick(price, tickSize = 0.25) {
  return Math.round(price / tickSize) * tickSize
}

/** Convert a price distance into ticks. */
export function toTicks(points, tickSize = 0.25) {
  return Math.round(points / tickSize)
}

/** Dollar value of a price move for a given size. */
export function dollarsFor(points, contracts, instrument) {
  return points * instrument.pointValue * contracts
}
