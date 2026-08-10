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
  version: 1,
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

  const nearest = (target) =>
    liquid.reduce((best, o) => (Math.abs(o.delta - target) < Math.abs(best.delta - target) ? o : best))
  const long = nearest(spec.longDelta)
  const short = nearest(spec.shortDelta)
  if (long.strike === short.strike) return { spread: null, reason: 'delta targets collapse to one strike' }

  const debit = long.mid - short.mid
  const width = Math.abs(short.strike - long.strike)
  if (debit <= 0 || debit >= width) return { spread: null, reason: 'debit outside (0, width) — quotes crossed or stale' }

  return {
    spread: {
      type,
      longStrike: long.strike,
      shortStrike: short.strike,
      longDelta: long.delta,
      shortDelta: short.delta,
      debit,
      width,
      maxGain: width - debit,
      breakeven: type === 'call' ? long.strike + debit : long.strike - debit,
      rewardRisk: (width - debit) / debit,
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

/** Pick the expiration inside the DTE window, nearest its middle. */
export function pickExpiration(expirations, today, spec = OPTIONSCAN_SPEC) {
  const t0 = Date.parse(`${today}T00:00:00Z`)
  const inWindow = expirations
    .map((d) => ({ d, dte: Math.round((Date.parse(`${d}T00:00:00Z`) - t0) / 86_400_000) }))
    .filter((x) => x.dte >= spec.dteMin && x.dte <= spec.dteMax)
  if (!inWindow.length) return null
  const midDte = (spec.dteMin + spec.dteMax) / 2
  return inWindow.reduce((a, b) => (Math.abs(a.dte - midDte) < Math.abs(b.dte - midDte) ? a : b))
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
