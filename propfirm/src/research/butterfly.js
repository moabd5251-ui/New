/**
 * Butterfly journal — a parallel, independently-versioned forward test.
 *
 * Built at the user's explicit request after the arithmetic argued against
 * it, so the case against is recorded here rather than lost in conversation.
 * Priced on live chains on 2026-08-10, every butterfly available on the
 * qualifying names carried NEGATIVE expected value (−$58 to −$128) while the
 * verticals on the same names were +$15 to +$52. Three reasons:
 *
 *   1. Execution. Four contracts across three strikes means crossing three
 *      bid/ask spreads. On SHOP 150/160/170 the mid was $155 and the
 *      realistic fill $275 — 44% of the structure handed over at entry,
 *      against roughly 6% for a vertical.
 *   2. The headline reward/risk is paid for in hit rate. 2.5:1 sounds better
 *      than 1.13:1 until you notice the profit zone is reached 22-31% of the
 *      time and the payoff inside it is triangular.
 *   3. It fights the thesis. The measured signal is DIRECTIONAL — gap
 *      direction continues — and says nothing about magnitude. A butterfly
 *      needs price to stop in a narrow window, so a stronger-than-expected
 *      move, exactly what the thesis predicts, pays zero.
 *
 * Reason 3 is the one this module tries to answer honestly rather than
 * dodge: the body is centred on a chart-derived target (the next tested
 * resistance or support shelf), not on an arbitrary strike. That is the
 * steelman. Whether it survives is what the journal is for — and it is kept
 * in its own file with its own spec version so it can never be pooled with
 * the vertical record.
 *
 * Paper only. Nothing here places an order.
 */

import { join } from 'node:path'
import { loadJournal, saveJournal, appendCandidates } from './optionscan.js'

export const BUTTERFLY_SPEC = {
  version: 1,
  registered: '2026-08-10',
  dteMin: 20,
  dteMax: 45,
  maxSpreadPct: 0.12,
  minOpenInterest: 50,
  accountSize: 50000,
  /** Butterflies are cheap; the cap is per-position, not a target. */
  riskPct: 0.015,
  /** Reject a fly whose zone is so wide the structure is really a vertical. */
  minRewardRisk: 1.5,
  /** The body must sit at least this far from spot, in ATR, or there is no
   *  directional content — a fly centred on spot is a volatility trade. */
  minBodyAtr: 0.4,
  /**
   * Reject structures whose slippage exceeds this share of the fill.
   *
   * Cheap butterflies are the trap: a fly worth $0.22 at mid with $0.15-wide
   * legs fills near $0.65, a 189% markup, and sizing to a fixed dollar budget
   * then buys eleven of them and pays the markup eleven times. Journalling a
   * fill nobody would accept is not evidence, so those are refused and
   * reported. 35% is already generous.
   */
  maxDragRatio: 0.35,
  /** Per-contract commission, charged on all four legs at entry. */
  commissionPerContract: 0.65,
}

const mid = (o) => (o.bid > 0 && o.ask > 0 ? (o.bid + o.ask) / 2 : null)

const liquidEnough = (o, spec) =>
  o.bid > 0 &&
  (o.open_interest ?? 0) >= spec.minOpenInterest &&
  (o.ask - o.bid) / mid(o) <= spec.maxSpreadPct

/**
 * Build a symmetric butterfly centred as near the target as the strike grid
 * allows. Cost is quoted BOTH ways: mid-to-mid, and the realistic fill that
 * pays the ask on both wings and receives the bid on the body. The second is
 * the one the journal scores, because it is the one you would get.
 */
export function buildButterfly(chain, direction, target, spot, atr, spec = BUTTERFLY_SPEC) {
  const type = direction === 'up' ? 'call' : 'put'
  const usable = chain
    .filter((o) => o.option_type === type && Number.isFinite(o.strike) && mid(o) !== null && liquidEnough(o, spec))
    .sort((a, b) => a.strike - b.strike)
  if (usable.length < 3) return { fly: null, reason: `only ${usable.length} liquid ${type} strike(s)` }

  const byStrike = new Map(usable.map((o) => [o.strike, o]))
  const strikes = usable.map((o) => o.strike)

  // Body: the liquid strike nearest the chart target. (The arms of this
  // ternary were once swapped, which silently selected the FARTHEST strike —
  // SHOP's body landed on 55 against a 166.84 target and every butterfly was
  // then rejected for having no symmetric wings, a failure that reads exactly
  // like an illiquid chain. Hence the test pinning it.)
  const body = strikes.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a))
  if (Math.abs(body - spot) < spec.minBodyAtr * atr) {
    return { fly: null, reason: `body ${body} sits within ${spec.minBodyAtr} ATR of spot — no directional content` }
  }

  // Widest symmetric wings that exist in the grid and are liquid.
  let best = null
  let worstDrag = null // best of the ones refused for slippage, for the message
  for (const w of [...new Set(strikes.map((k) => Math.abs(k - body)))].filter((w) => w > 0).sort((a, b) => a - b)) {
    const lower = byStrike.get(body - w)
    const upper = byStrike.get(body + w)
    if (!lower || !upper) continue
    const b = byStrike.get(body)
    const costMid = mid(lower) - 2 * mid(b) + mid(upper)
    const costReal = lower.ask - 2 * b.bid + upper.ask
    if (!(costReal > 0) || costReal >= w) continue
    if (costReal * 100 > spec.accountSize * spec.riskPct) continue
    const rr = (w - costReal) / costReal
    if (rr < spec.minRewardRisk) continue
    // Tradeability is a property of each width, not of the name. The
    // narrowest flies carry the flashiest reward/risk AND the worst markup,
    // so testing drag only on the winner lets a 100%-slippage 5-wide reject
    // a name whose 15-wide fills fine. Skip the width, keep looking.
    const dragRatio = (costReal - costMid) / costReal
    const cand = { w, lower, body: b, upper, costMid, costReal, rr, dragRatio }
    if (dragRatio > spec.maxDragRatio) {
      if (!worstDrag || dragRatio < worstDrag.dragRatio) worstDrag = cand
      continue
    }
    if (!best || cand.rr > best.rr) best = cand
  }
  if (!best) {
    if (worstDrag) {
      return {
        fly: null,
        reason: `slippage is ${(worstDrag.dragRatio * 100).toFixed(0)}% of the fill ($${(worstDrag.costMid * 100).toFixed(0)} mid → $${(worstDrag.costReal * 100).toFixed(0)}) — untradeable`,
      }
    }
    return { fly: null, reason: 'no liquid symmetric wings inside budget clearing the reward/risk floor' }
  }

  const { w, costReal, costMid, rr, dragRatio } = best
  return {
    fly: {
      type,
      lowerStrike: body - w,
      bodyStrike: body,
      upperStrike: body + w,
      width: w,
      debit: costReal,
      debitMid: costMid,
      /** What crossing three spreads costs, stated rather than buried. */
      executionDrag: costReal - costMid,
      dragRatio,
      maxGain: w - costReal,
      lowerBreakeven: body - w + costReal,
      upperBreakeven: body + w - costReal,
      rewardRisk: rr,
    },
    reason: null,
  }
}

/** Intrinsic value of a butterfly at expiration, per share. */
export function flyValueAtExpiry(fly, close) {
  const { lowerStrike: k1, bodyStrike: k2, upperStrike: k3, type } = fly
  const intrinsic = (k) => (type === 'call' ? Math.max(0, close - k) : Math.max(0, k - close))
  return Math.max(0, intrinsic(k1) - 2 * intrinsic(k2) + intrinsic(k3))
}

export const butterflyJournalPath = (root, symbol) =>
  join(root, `${symbol.replace(/[^A-Za-z0-9]/g, '_')}-butterfly.jsonl`)

export function sizeFlies(debit, spec = BUTTERFLY_SPEC) {
  return Math.max(0, Math.floor((spec.accountSize * spec.riskPct) / (debit * 100)))
}

export async function resolveExpiredFlies(records, today, historyFor) {
  let resolved = 0
  for (const r of records) {
    if (r.outcome || r.expiration >= today) continue
    const bars = await historyFor(r.symbol)
    const at = [...bars].reverse().find((b) => b.date <= r.expiration)
    if (!at) continue
    const value = flyValueAtExpiry(r.fly, at.c)
    const commission = (r.fly.commissionPerContract ?? 0.65) * 4 * r.contracts
    const pnl = (value - r.fly.debit) * 100 * r.contracts - commission
    // Scored two ways on purpose. Whether a butterfly can be filled near mid
    // or only by crossing three spreads is the single biggest unknown in this
    // structure, and it is a fact about the user's broker, not about the
    // market. Reporting both brackets the answer instead of guessing it.
    const pnlAtMid = (value - r.fly.debitMid) * 100 * r.contracts - commission
    r.outcome = {
      resolvedAt: today,
      underlyingClose: at.c,
      valuePerShare: value,
      commissionUsd: Math.round(commission * 100) / 100,
      pnlUsd: Math.round(pnl * 100) / 100,
      pnlAtMidUsd: Math.round(pnlAtMid * 100) / 100,
      r: r.fly.debit > 0 ? (value - r.fly.debit) / r.fly.debit : 0,
      /** Did price actually stop near the chart target the body was set on? */
      distanceFromBody: at.c - r.fly.bodyStrike,
    }
    resolved++
  }
  return resolved
}

export function butterflyScorecard(records) {
  const done = records.filter((r) => r.outcome)
  const open = records.length - done.length
  const dragTotal = records.reduce((a, r) => a + (r.fly.executionDrag ?? 0) * 100 * r.contracts, 0)
  if (!done.length) return { open, resolved: 0, executionDragUsd: dragTotal }
  const rs = done.map((r) => r.outcome.r)
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length
  // How close did price finish to the target, in wing-widths? This is the
  // question the structure lives or dies on, and the count alone hides it.
  const inZone = done.filter((r) => r.outcome.valuePerShare > 0).length
  return {
    open,
    resolved: done.length,
    winRate: rs.filter((x) => x > 0).length / rs.length,
    inZoneRate: inZone / done.length,
    meanR: mean,
    totalUsd: done.reduce((a, r) => a + r.outcome.pnlUsd, 0),
    totalAtMidUsd: done.reduce((a, r) => a + (r.outcome.pnlAtMidUsd ?? r.outcome.pnlUsd), 0),
    executionDragUsd: dragTotal,
    medianMissWidths: median(done.map((r) => Math.abs(r.outcome.distanceFromBody) / r.fly.width)),
  }
}

function median(xs) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

export { loadJournal, saveJournal, appendCandidates }
