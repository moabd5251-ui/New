/**
 * Options swing scanner — the defined-risk expression of the one measured
 * options signal this project's research supports.
 *
 * The signal (measured on 151 post-earnings reactions in the companion
 * project): after a large gap on volume, direction continues — with-gap beat
 * against-gap by +0.261R, t = 2.22. The strategy return itself was +0.072R
 * and NOT distinguishable from zero, with 99% of profit in 5 trades. So this
 * scanner is a paper journal with tilted odds, not a money machine, and its
 * own forward record is the only thing that can promote it.
 *
 * The expression is structural, per the playbook:
 *   • reaction: |open gap| ≥ 3% on ≥ 1.5× 20-day volume, within the last 10
 *     sessions, gap still unfilled — direction = gap direction
 *   • vertical debit spread in that direction, 20–45 DTE: long the ~0.65Δ
 *     strike, short the ~0.32Δ — low vega AFTER the event, defined risk
 *   • both legs liquid: bid > 0, spread ≤ 12% of mid, open interest ≥ 50
 *   • size = floor(riskBudget / debit); risk budget defaults to 1.5% of a
 *     $50k account
 *
 * Resolution is honest and needs no historical options data: a vertical held
 * to expiration is worth exactly its intrinsic value, which the underlying's
 * daily close determines. Records resolve themselves once expiry has passed.
 *
 * Read-only market data throughout. Nothing here places an order.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

export const OPTIONSCAN_SPEC = {
  // v2 (2026-08-10, same day, nothing resolved): expiration selection now
  // prefers standard monthlies, and short-strike selection is budget-aware.
  // v1 records were artifacts of routing every name into a weekly chain with
  // a tenth of the open interest, so the v1 journal was discarded rather than
  // pooled — a record the current scanner would never produce is not evidence
  // about the current scanner. Discarding was safe here only because no v1
  // record had resolved; once outcomes exist, a version bump must keep them
  // and segregate them, never delete them.
  version: 2,
  registered: '2026-08-10',
  gapPct: 0.03,
  volFactor: 1.5,
  volPeriod: 20,
  reactionLookbackDays: 10,
  dteMin: 20,
  dteMax: 45,
  longDelta: 0.65,
  shortDelta: 0.32,
  maxSpreadPct: 0.12,
  minOpenInterest: 50,
  /** Floor on (width − debit) / debit, so budget-driven narrowing can't
   *  degenerate into a spread that pays less than it risks. */
  minRewardRisk: 0.8,
  accountSize: 50000,
  riskPct: 0.015,
}

/**
 * Most recent unfilled reaction gap in a daily series, or null.
 * `bars` ascending [{date,o,h,l,c,v}].
 */
export function findReaction(bars, spec = OPTIONSCAN_SPEC) {
  if (bars.length < spec.volPeriod + 2) return null
  const last = bars.length - 1
  for (let i = last; i > Math.max(spec.volPeriod, last - spec.reactionLookbackDays); i--) {
    const prev = bars[i - 1]
    const day = bars[i]
    const gap = (day.o - prev.c) / prev.c
    if (Math.abs(gap) < spec.gapPct) continue
    let vol = 0
    for (let k = i - spec.volPeriod; k < i; k++) vol += bars[k].v
    const avgVol = vol / spec.volPeriod
    if (avgVol <= 0 || day.v < spec.volFactor * avgVol) continue
    // Unfilled: price has not closed back through the pre-gap close.
    const filled = gap > 0 ? bars[last].c < prev.c : bars[last].c > prev.c
    if (filled) return null // the newest reaction is dead; older ones are stale
    return {
      reactionDay: day.date,
      direction: gap > 0 ? 'up' : 'down',
      gapPct: gap,
      preGapClose: prev.c,
      daysSince: last - i,
      lastClose: bars[last].c,
    }
  }
  return null
}

const mid = (o) => (o.bid > 0 && o.ask > 0 ? (o.bid + o.ask) / 2 : null)

/**
 * Build the vertical from one expiration's chain. Returns null with a reason
 * when no liquid structure exists — a null is a result, not an error.
 */
export function buildVertical(chain, direction, spec = OPTIONSCAN_SPEC) {
  const type = direction === 'up' ? 'call' : 'put'
  // Liquidity first, then delta: choosing the delta-nearest strike and only
  // then checking its book rejects names whose neighbouring strikes are
  // perfectly tradeable. The structure is built from what can be traded.
  const liquid = chain
    .filter((o) => o.option_type === type && Number.isFinite(o.strike))
    .map((o) => ({ ...o, delta: Math.abs(o.greeks?.delta ?? NaN), mid: mid(o) }))
    .filter(
      (o) =>
        Number.isFinite(o.delta) &&
        o.mid !== null &&
        o.bid > 0 &&
        (o.open_interest ?? 0) >= spec.minOpenInterest &&
        (o.ask - o.bid) / o.mid <= spec.maxSpreadPct,
    )
  if (liquid.length < 2) return { spread: null, reason: `only ${liquid.length} liquid ${type} strike(s) — need 2` }

  const long = liquid.reduce((best, o) =>
    Math.abs(o.delta - spec.longDelta) < Math.abs(best.delta - spec.longDelta) ? o : best,
  )

  // Short-leg choice is budget-aware, not purely delta-driven. On a $500
  // stock the textbook 0.65→0.32 vertical can be $40 wide and cost $1,600 a
  // contract, which no 1.5% risk budget can hold — and rejecting the NAME for
  // that is wrong when a narrower structure on the same thesis fits. So:
  // consider every liquid strike further out than the long leg, keep the ones
  // that fit the budget and still pay enough to be worth doing, and among
  // those take the delta closest to target. Narrowing lowers reward/risk, so
  // the floor is what stops this from degenerating into a hair-thin spread.
  const budget = spec.accountSize * spec.riskPct
  const candidates = []
  for (const o of liquid) {
    if (o.delta >= long.delta) continue
    const width = Math.abs(o.strike - long.strike)
    const debit = long.mid - o.mid
    if (width <= 0 || debit <= 0 || debit >= width) continue
    candidates.push({ short: o, width, debit, rewardRisk: (width - debit) / debit })
  }
  if (!candidates.length) return { spread: null, reason: 'no liquid short strike beyond the long leg' }

  const affordable = candidates.filter((c) => c.debit * 100 <= budget && c.rewardRisk >= spec.minRewardRisk)
  if (!affordable.length) {
    const cheapest = candidates.reduce((a, b) => (a.debit < b.debit ? a : b))
    return {
      spread: null,
      reason: cheapest.debit * 100 > budget
        ? `cheapest structure $${(cheapest.debit * 100).toFixed(0)} exceeds the $${budget.toFixed(0)} budget`
        : `nothing within budget clears ${spec.minRewardRisk} reward/risk`,
    }
  }
  const pick = affordable.reduce((a, b) =>
    Math.abs(a.short.delta - spec.shortDelta) < Math.abs(b.short.delta - spec.shortDelta) ? a : b,
  )

  return {
    spread: {
      type,
      longStrike: long.strike,
      shortStrike: pick.short.strike,
      longDelta: long.delta,
      shortDelta: pick.short.delta,
      debit: pick.debit,
      width: pick.width,
      maxGain: pick.width - pick.debit,
      breakeven: type === 'call' ? long.strike + pick.debit : long.strike - pick.debit,
      rewardRisk: pick.rewardRisk,
    },
    reason: null,
  }
}

/** Intrinsic value of the vertical at expiration, per share. */
export function spreadValueAtExpiry(spread, underlyingClose) {
  const intrinsic = (strike) =>
    spread.type === 'call' ? Math.max(0, underlyingClose - strike) : Math.max(0, strike - underlyingClose)
  return Math.min(spread.width, Math.max(0, intrinsic(spread.longStrike) - intrinsic(spread.shortStrike)))
}

export function sizeContracts(debit, spec = OPTIONSCAN_SPEC) {
  const budget = spec.accountSize * spec.riskPct
  return Math.max(0, Math.floor(budget / (debit * 100)))
}

/** A standard monthly expiration is the third Friday of its month. */
export function isMonthlyExpiration(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`)
  const dom = d.getUTCDate()
  return d.getUTCDay() === 5 && dom >= 15 && dom <= 21
}

/**
 * Pick the expiration inside the DTE window, preferring standard monthlies.
 *
 * This is not cosmetic. Measured on the live book, the weeklies inside the
 * window carry 10–120× LESS open interest than the monthly beside them — LLY
 * had 2,180 contracts open across its Sep-4 weekly against 32,225 on the
 * Sep-18 monthly, which is the difference between zero tradeable strikes and
 * forty-nine. Choosing purely by "nearest the middle of the window" quietly
 * routed every name into the illiquid chain and then blamed the name.
 */
export function pickExpiration(expirations, today, spec = OPTIONSCAN_SPEC) {
  const t0 = Date.parse(`${today}T00:00:00Z`)
  const inWindow = expirations
    .map((d) => ({ d, dte: Math.round((Date.parse(`${d}T00:00:00Z`) - t0) / 86_400_000), monthly: isMonthlyExpiration(d) }))
    .filter((x) => x.dte >= spec.dteMin && x.dte <= spec.dteMax)
  if (!inWindow.length) return null
  const monthlies = inWindow.filter((x) => x.monthly)
  const pool = monthlies.length ? monthlies : inWindow
  const midDte = (spec.dteMin + spec.dteMax) / 2
  return pool.reduce((a, b) => (Math.abs(a.dte - midDte) < Math.abs(b.dte - midDte) ? a : b))
}

/* ── journal ──────────────────────────────────────────────────────────────── */

export function loadJournal(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

export function saveJournal(path, records) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''))
}

/** One candidate per (symbol, reactionDay): re-scans must not duplicate. */
export function appendCandidates(records, candidates) {
  const seen = new Set(records.map((r) => `${r.symbol}|${r.reactionDay}`))
  const fresh = candidates.filter((c) => !seen.has(`${c.symbol}|${c.reactionDay}`))
  return { records: [...records, ...fresh], added: fresh }
}

/**
 * Resolve any record whose expiration has passed, from the underlying's
 * close on the last trading day at or before expiry.
 * `historyFor(symbol)` → daily bars; only called for symbols that need it.
 */
export async function resolveExpired(records, today, historyFor) {
  let resolved = 0
  for (const r of records) {
    if (r.outcome || r.expiration >= today) continue
    const bars = await historyFor(r.symbol)
    const at = [...bars].reverse().find((b) => b.date <= r.expiration)
    if (!at) continue
    const value = spreadValueAtExpiry(r.spread, at.c)
    const pnl = (value - r.spread.debit) * 100 * r.contracts
    r.outcome = {
      resolvedAt: today,
      underlyingClose: at.c,
      valuePerShare: value,
      pnlUsd: Math.round(pnl * 100) / 100,
      r: r.spread.debit > 0 ? (value - r.spread.debit) / r.spread.debit : 0,
    }
    resolved++
  }
  return resolved
}

export function scanScorecard(records) {
  const done = records.filter((r) => r.outcome)
  const open = records.length - done.length
  if (!done.length) return { open, resolved: 0 }
  const rs = done.map((r) => r.outcome.r)
  const pnls = done.map((r) => r.outcome.pnlUsd)
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length
  return {
    open,
    resolved: done.length,
    winRate: rs.filter((x) => x > 0).length / rs.length,
    meanR: mean,
    totalUsd: pnls.reduce((a, b) => a + b, 0),
  }
}
