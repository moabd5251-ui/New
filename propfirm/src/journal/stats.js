/**
 * Performance statistics.
 *
 * Expectancy is the number that decides whether a setup gets traded: the
 * average R you expect per trade. Win rate on its own says nothing — a 40%
 * strategy taking 1:3 is far better than a 70% strategy taking 1:0.5.
 *
 * Everything is broken down by model, session, grade and hour, because that is
 * how you find out that one of the three entry models is carrying the account
 * and another is bleeding it.
 */

import { maxOf, minOf } from '../core/candles.js'

/**
 * @param {import('./journal.js').JournalEntry[]} trades
 */
export function buildStats(trades) {
  const all = trades.filter((t) => Number.isFinite(t.rMultiple))
  return {
    ...summarise(all),
    byModel: groupBy(all, (t) => t.model ?? 'unknown'),
    bySession: groupBy(all, (t) => t.session ?? 'unknown'),
    byGrade: groupBy(all, (t) => t.grade ?? 'ungraded'),
    byDirection: groupBy(all, (t) => t.direction ?? 'unknown'),
    byDay: groupBy(all, (t) => t.day ?? 'unknown'),
    byExitReason: groupBy(all, (t) => t.exitReason ?? 'unknown'),
    equityCurveR: equityCurve(all, 'rMultiple'),
    equityCurveDollars: equityCurve(all, 'pnl'),
  }
}

function summarise(trades) {
  const count = trades.length
  if (!count) {
    return {
      count: 0, wins: 0, losses: 0, winRate: 0, expectancyR: 0, expectancyDollars: 0,
      totalR: 0, totalDollars: 0, profitFactor: 0, avgWinR: 0, avgLossR: 0,
      maxDrawdownR: 0, maxWinStreak: 0, maxLossStreak: 0, largestWinR: 0, largestLossR: 0,
      payoffRatio: 0, sampleWarning: 'no trades',
    }
  }

  const rs = trades.map((t) => t.rMultiple)
  const dollars = trades.map((t) => t.pnl ?? 0)
  const wins = trades.filter((t) => t.rMultiple > 0)
  const losses = trades.filter((t) => t.rMultiple <= 0)

  const grossWin = wins.reduce((a, t) => a + t.rMultiple, 0)
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.rMultiple, 0))
  const totalR = rs.reduce((a, b) => a + b, 0)
  const avgWinR = wins.length ? grossWin / wins.length : 0
  const avgLossR = losses.length ? grossLoss / losses.length : 0

  return {
    count,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length / count,
    expectancyR: totalR / count,
    expectancyDollars: dollars.reduce((a, b) => a + b, 0) / count,
    totalR,
    totalDollars: dollars.reduce((a, b) => a + b, 0),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    avgWinR,
    avgLossR,
    payoffRatio: avgLossR > 0 ? avgWinR / avgLossR : 0,
    largestWinR: maxOf(rs, 0),
    largestLossR: minOf(rs, 0),
    maxDrawdownR: maxDrawdown(rs),
    maxWinStreak: maxStreak(rs, (r) => r > 0),
    maxLossStreak: maxStreak(rs, (r) => r <= 0),
    // Below ~30 trades the numbers are noise. Say so, loudly, so nobody
    // reweights a live system off a handful of results.
    sampleWarning: count < 30 ? `only ${count} trades — not a usable sample, treat every figure below as provisional` : null,
  }
}

function groupBy(trades, keyFn) {
  const groups = new Map()
  for (const t of trades) {
    const k = keyFn(t)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(t)
  }
  const out = {}
  for (const [k, list] of groups) out[k] = summarise(list)
  return out
}

function equityCurve(trades, field) {
  let acc = 0
  return trades.map((t) => {
    acc += t[field] ?? 0
    return { t: t.exitTime ?? t.entryTime, value: acc }
  })
}

function maxDrawdown(values) {
  let peak = 0
  let acc = 0
  let worst = 0
  for (const v of values) {
    acc += v
    peak = Math.max(peak, acc)
    worst = Math.min(worst, acc - peak)
  }
  return Math.abs(worst)
}

function maxStreak(values, predicate) {
  let best = 0
  let cur = 0
  for (const v of values) {
    if (predicate(v)) cur++
    else cur = 0
    best = Math.max(best, cur)
  }
  return best
}

/**
 * Rank the breakdowns by expectancy so the obvious action is visible: which
 * model to keep trading, which session to drop.
 *
 * @returns {{keep:string[], review:string[], drop:string[]}}
 */
export function recommendations(stats, { minSample = 20 } = {}) {
  const keep = []
  const review = []
  const drop = []

  for (const [dimension, groups] of Object.entries({ model: stats.byModel, session: stats.bySession, grade: stats.byGrade })) {
    for (const [name, s] of Object.entries(groups)) {
      const label = `${dimension}:${name} — ${s.expectancyR.toFixed(2)}R over ${s.count} trades (${(s.winRate * 100).toFixed(0)}% win rate)`
      if (s.count < minSample) review.push(`${label} — sample too small to judge`)
      else if (s.expectancyR >= 0.15) keep.push(label)
      else if (s.expectancyR <= -0.05) drop.push(label)
      else review.push(`${label} — marginal`)
    }
  }
  return { keep, review, drop }
}
