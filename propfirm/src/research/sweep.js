/**
 * NY-open liquidity sweep reversal — registered forward validation.
 *
 * The one entry rule in this repository that beat its random-entry control.
 * Measured over 704,591 NQ bars before registration:
 *
 *   playbook entries   +0.842R in-sample (n 34), +0.683R out-of-sample (n 12)
 *   random killzone    −0.079R (n 310),          −0.002R (n 133)
 *                      ...same stop distance, same management
 *
 * That control is the reason this is worth tracking: it is what killed the
 * multi-timeframe result, where random entries matched the signal exactly and
 * exposed the "edge" as management plus drift. Here random returns zero.
 *
 * It is also NOT a strategy yet, and the scorecard is built to keep that
 * visible rather than let a headline number bury it:
 *   • median trade −1.02R — a full stop-out is the typical outcome
 *   • the top five of forty-six trades were 106% of all profit
 *   • t = 1.7 and 0.7, against the |t| ≥ 3 this project requires
 *   • twelve out-of-sample trades
 *   • the setup fires 1.9×/MONTH with every filter on, not ~1/day, so 30
 *     trades is well over a year on NQ alone
 *
 * Two variants are journaled from one pass, because the smaller-mean one has
 * the better sample and it is not obvious which is the real candidate:
 *   withChoch  — every filter (1.9 trades/month, +0.84R)
 *   noChoch    — CHoCH requirement dropped (~1/day, +0.160R IS / +0.158R OOS,
 *                strikingly stable across halves over 562 trades)
 * Each setup is journaled once and tagged, so the subset relationship is
 * preserved and the two are scored separately, never pooled.
 *
 * Paper only. Nothing here places an order.
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { CandleStore } from '../data/store.js'
import { atr } from '../core/candles.js'
import { etMinuteOfDay, futuresDayKey } from '../core/sessions.js'

export const SWEEP_SPEC = {
  version: 1,
  registered: '2026-08-11',
  killzoneStart: 7 * 60,
  killzoneEnd: 10 * 60,
  overnightStart: 18 * 60,
  overnightEnd: 7 * 60,
  timeStop: 11 * 60 + 30,
  /** Displacement bar range, in ATR. */
  displacementAtr: 1.2,
  /** Bars allowed between the sweep and the displacement. */
  displacementWindow: 15,
  /** Bars allowed between displacement and the OTE fill. */
  entryWindow: 40,
  oteLow: 0.62,
  oteHigh: 0.79,
  stopTicks: 3,
  tickSize: 0.25,
  firstTargetR: 2,
  /** Round-turn slippage + commission, in points, charged per trade. */
  costPts: 0.9,
  maxPerDay: 2,
  pointValue: 20, // NQ; MNQ is 2
}

/** Overnight range and prior-day RTH extremes, resolved causally per day. */
export function dayLevels(candles, spec = SWEEP_SPEC) {
  const days = new Map()
  let key = null
  let cur = null
  let prevRth = null
  for (const c of candles) {
    const k = futuresDayKey(c.t)
    const et = etMinuteOfDay(c.t)
    if (k !== key) {
      if (cur) days.set(key, cur)
      // Yesterday's RTH extremes become today's prior-day levels — carried
      // forward only after that day has closed, never peeked at.
      prevRth = cur && cur.rthHigh > -Infinity ? { h: cur.rthHigh, l: cur.rthLow } : prevRth
      key = k
      cur = {
        onHigh: -Infinity, onLow: Infinity,
        rthHigh: -Infinity, rthLow: Infinity,
        pdHigh: prevRth?.h ?? null, pdLow: prevRth?.l ?? null,
        lastIndex: -1,
      }
    }
    if (et >= spec.overnightStart || et < spec.overnightEnd) {
      cur.onHigh = Math.max(cur.onHigh, c.h)
      cur.onLow = Math.min(cur.onLow, c.l)
    }
    if (et >= 570 && et < 960) {
      cur.rthHigh = Math.max(cur.rthHigh, c.h)
      cur.rthLow = Math.min(cur.rthLow, c.l)
    }
  }
  if (cur) days.set(key, cur)
  return days
}

const inKillzone = (t, spec) => {
  const et = etMinuteOfDay(t)
  return et >= spec.killzoneStart && et < spec.killzoneEnd
}

/**
 * Manage one position exactly as the playbook prescribes: 2R first target with
 * half off and the stop to breakeven, remainder to opposite-side liquidity,
 * flat at the time stop. Stop wins on any bar that touches both.
 */
function manage(candles, entryIdx, entryPrice, dir, stopPrice, t2, spec) {
  const risk = Math.abs(entryPrice - stopPrice)
  if (!(risk > 0)) return null
  const t1 = entryPrice + dir * spec.firstTargetR * risk
  let half = false
  let stopNow = stopPrice
  let realisedR = 0
  for (let j = entryIdx + 1; j < Math.min(entryIdx + 500, candles.length); j++) {
    const c = candles[j]
    if (dir > 0 ? c.l <= stopNow : c.h >= stopNow) {
      realisedR += (half ? 0.5 : 1) * ((dir * (stopNow - entryPrice)) / risk)
      return { realisedR, reason: half ? 'be-stop' : 'stop', exitIdx: j, risk }
    }
    if (!half && (dir > 0 ? c.h >= t1 : c.l <= t1)) {
      realisedR += 0.5 * spec.firstTargetR
      half = true
      stopNow = entryPrice
      continue
    }
    if (half && (dir > 0 ? c.h >= t2 : c.l <= t2)) {
      realisedR += 0.5 * ((dir * (t2 - entryPrice)) / risk)
      return { realisedR, reason: 't2', exitIdx: j, risk }
    }
    if (etMinuteOfDay(c.t) >= spec.timeStop) {
      realisedR += (half ? 0.5 : 1) * ((dir * (c.c - entryPrice)) / risk)
      return { realisedR, reason: 'time', exitIdx: j, risk }
    }
  }
  return null
}

/**
 * SMT divergence tagger: did the companion index sweep ITS matching level in
 * the same window? Divergence — NQ sweeps, ES does not — is the claimed
 * institutional footprint.
 *
 * Measured on 685 sweeps before registration, and the claim survives on the
 * raw setup: divergent sweeps returned +0.289R against +0.010R when both
 * indices swept, same sign in both halves (+0.363 vs +0.025 IS, +0.157 vs
 * −0.024 OOS). But t is only 1.2, the median trade is −1.07R in BOTH groups
 * so the filter moves the tail rather than the typical trade, and on the
 * strict CHoCH subset the effect vanishes (+0.795R divergent vs +0.860R
 * confirmed, n 11 and 25). Recorded, therefore, and not filtered on.
 */
export function makeSmtTagger(companionCandles, spec = SWEEP_SPEC) {
  if (!companionCandles?.length) return () => null
  const levels = dayLevels(companionCandles, spec)
  const byTime = new Map(companionCandles.map((c, i) => [c.t, i]))
  return (setup, windowMin = 15) => {
    const lv = levels.get(setup.day)
    if (!lv) return null
    const buyside = setup.direction === 'short'
    const level = setup.level.includes('overnight')
      ? (buyside ? lv.onHigh : lv.onLow)
      : (buyside ? lv.pdHigh : lv.pdLow)
    if (!Number.isFinite(level)) return null
    let i = byTime.get(setup.t)
    // ES and NQ share the CME clock, but a thin minute can be absent from one.
    for (let d = 1; d <= 2 && i === undefined; d++) {
      i = byTime.get(setup.t + d * 60_000) ?? byTime.get(setup.t - d * 60_000)
    }
    if (i === undefined) return null
    for (let j = Math.max(0, i - windowMin); j <= Math.min(companionCandles.length - 1, i + windowMin); j++) {
      if (futuresDayKey(companionCandles[j].t) !== setup.day) continue
      if (buyside ? companionCandles[j].h > level : companionCandles[j].l < level) {
        return { companionSwept: true, divergence: false }
      }
    }
    return { companionSwept: false, divergence: true }
  }
}

/**
 * Every setup in the series, tagged with whether it also satisfied CHoCH.
 * The per-day cap is NOT applied here — it is applied per variant when
 * scoring, so that two non-CHoCH setups cannot silently displace a CHoCH one.
 */
export function findSetups(candles, spec = SWEEP_SPEC) {
  const days = dayLevels(candles, spec)
  const atrs = atr(candles, 14)
  const out = []
  let i = 20

  while (i < candles.length - 10) {
    const bar = candles[i]
    const key = futuresDayKey(bar.t)
    const d = days.get(key)
    const a = atrs[i]
    if (!d || !Number.isFinite(a) || a <= 0 || !inKillzone(bar.t, spec)) { i++; continue }

    const levels = [
      { price: d.onHigh, side: 'buyside', name: 'overnight high' },
      { price: d.pdHigh, side: 'buyside', name: 'prior day high' },
      { price: d.onLow, side: 'sellside', name: 'overnight low' },
      { price: d.pdLow, side: 'sellside', name: 'prior day low' },
    ].filter((l) => Number.isFinite(l.price))

    let swept = null
    for (const l of levels) {
      const crossedUp = l.side === 'buyside' && bar.h > l.price && candles[i - 1].h <= l.price
      const crossedDown = l.side === 'sellside' && bar.l < l.price && candles[i - 1].l >= l.price
      if (crossedUp) swept = { ...l, extreme: bar.h }
      if (crossedDown) swept = { ...l, extreme: bar.l }
      if (swept) break
    }
    if (!swept) { i++; continue }

    // A buyside sweep sets up a SHORT.
    const dir = swept.side === 'buyside' ? -1 : 1

    let dispEnd = null
    for (let j = i + 1; j <= Math.min(i + spec.displacementWindow, candles.length - 1); j++) {
      if (!inKillzone(candles[j].t, spec)) break
      // Price extending well past the extreme means it was a break, not a grab.
      const extended = dir < 0 ? candles[j].h > swept.extreme + 2 * atrs[j] : candles[j].l < swept.extreme - 2 * atrs[j]
      if (extended) break
      const backThrough = dir < 0 ? candles[j].c < swept.price : candles[j].c > swept.price
      const big = candles[j].h - candles[j].l >= spec.displacementAtr * atrs[j]
      if (backThrough && big) { dispEnd = j; break }
    }
    if (dispEnd === null) { i++; continue }

    // CHoCH: does the displacement close beyond the last opposing extreme?
    let pivot = dir < 0 ? Infinity : -Infinity
    for (let k = Math.max(1, i - 30); k < i; k++) {
      pivot = dir < 0 ? Math.min(pivot, candles[k].l) : Math.max(pivot, candles[k].h)
    }
    const choch = dir < 0 ? candles[dispEnd].c < pivot : candles[dispEnd].c > pivot

    const legSize = Math.abs(candles[dispEnd].c - swept.extreme)
    if (!(legSize > 0)) { i++; continue }
    const bandA = candles[dispEnd].c - dir * legSize * spec.oteLow
    const bandB = candles[dispEnd].c - dir * legSize * spec.oteHigh
    const bandLow = Math.min(bandA, bandB)
    const bandHigh = Math.max(bandA, bandB)

    let entryIdx = null
    let entryPrice = null
    for (let j = dispEnd + 1; j <= Math.min(dispEnd + spec.entryWindow, candles.length - 1); j++) {
      if (etMinuteOfDay(candles[j].t) >= spec.timeStop) break
      if (candles[j].l <= bandHigh && candles[j].h >= bandLow) {
        entryIdx = j
        // Fill at the conservative edge of the band: the worse price of the two.
        entryPrice = dir < 0 ? bandLow : bandHigh
        break
      }
      const invalidated = dir < 0 ? candles[j].h > swept.extreme : candles[j].l < swept.extreme
      if (invalidated) break
    }
    if (entryIdx === null) { i++; continue }

    const stopPrice = swept.extreme + (dir < 0 ? 1 : -1) * spec.stopTicks * spec.tickSize
    const oppLiquidity = dir < 0
      ? (Number.isFinite(d.onLow) ? d.onLow : null)
      : (Number.isFinite(d.onHigh) ? d.onHigh : null)
    const fallbackT2 = entryPrice + dir * 4 * Math.abs(entryPrice - stopPrice)
    const t2 = oppLiquidity !== null && (dir > 0 ? oppLiquidity > entryPrice : oppLiquidity < entryPrice)
      ? oppLiquidity
      : fallbackT2

    const m = manage(candles, entryIdx, entryPrice, dir, stopPrice, t2, spec)
    if (!m) { i++; continue }

    out.push({
      day: key,
      t: bar.t,
      direction: dir > 0 ? 'long' : 'short',
      level: swept.name,
      choch,
      entry: entryPrice,
      stop: stopPrice,
      riskPts: m.risk,
      r: m.realisedR - spec.costPts / m.risk,
      grossR: m.realisedR,
      reason: m.reason,
      barsHeld: m.exitIdx - entryIdx,
    })
    i = m.exitIdx + 1
  }
  return out
}

/* ── journal ──────────────────────────────────────────────────────────────── */

export const sweepJournalPath = (root, symbol) =>
  join(root, `${symbol.replace(/[^A-Za-z0-9]/g, '_')}-sweep.jsonl`)

export function loadSweeps(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

/**
 * Journal setups from days that are COMPLETE (past the time stop) and postdate
 * registration, each exactly once. The watermark is the last journaled day, so
 * a day is either fully recorded or not recorded at all — never half.
 */
export function recordSweeps({ root, symbol, journalPath = null, spec = SWEEP_SPEC, companionSymbol = null }) {
  const path = journalPath ?? sweepJournalPath(root, symbol)
  const existing = loadSweeps(path)
  const seenDays = new Set(existing.map((r) => r.day))
  const registeredAt = Date.parse(`${spec.registered}T00:00:00Z`)

  const candles = new CandleStore(root, symbol).load()
  if (!candles.length) return { path, added: 0, records: [], total: existing.length }

  // A day is complete once the series holds a bar at or past its time stop.
  const complete = new Set()
  for (const c of candles) {
    if (etMinuteOfDay(c.t) >= spec.timeStop) complete.add(futuresDayKey(c.t))
  }

  const fresh = findSetups(candles, spec).filter(
    (s) => !seenDays.has(s.day) && complete.has(s.day) && s.t >= registeredAt,
  )

  // SMT is best-effort: if the companion index has not been collected, the
  // field is null rather than the setup being dropped. A missing companion
  // must never silently shrink the primary record.
  let tag = () => null
  if (companionSymbol) {
    try {
      tag = makeSmtTagger(new CandleStore(root, companionSymbol).load(), spec)
    } catch { /* companion store absent — SMT stays null */ }
  }
  const records = fresh.map((s) => ({ spec: spec.version, ...s, smt: tag(s) }))
  if (records.length) {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  }
  return { path, added: records.length, records, total: existing.length + records.length }
}

/** Apply the playbook's two-trades-a-day cap within one variant. */
function capPerDay(records, maxPerDay) {
  const perDay = new Map()
  const kept = []
  for (const r of records) {
    const n = perDay.get(r.day) ?? 0
    if (n >= maxPerDay) continue
    perDay.set(r.day, n + 1)
    kept.push(r)
  }
  return kept
}

function describe(records, spec) {
  const n = records.length
  if (!n) return { n: 0 }
  const rs = records.map((r) => r.r)
  const total = rs.reduce((a, b) => a + b, 0)
  const mean = total / n
  const sd = n > 1 ? Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0
  const sorted = [...rs].sort((a, b) => a - b)
  const wins = rs.filter((x) => x > 0)
  const grossLoss = -rs.filter((x) => x <= 0).reduce((a, b) => a + b, 0)
  const topFive = [...rs].sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0)
  let worstStreak = 0
  let run = 0
  for (const r of rs) { run = r < 0 ? run + 1 : 0; worstStreak = Math.max(worstStreak, run) }
  return {
    n,
    expR: mean,
    tStat: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0,
    winRate: wins.length / n,
    avgWin: wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0,
    profitFactor: grossLoss > 0 ? wins.reduce((a, b) => a + b, 0) / grossLoss : Infinity,
    totalR: total,
    totalPts: records.reduce((a, r) => a + r.r * r.riskPts, 0),
    /** The two numbers the headline hides. */
    medianR: sorted[Math.floor(n / 2)],
    topFiveShare: total !== 0 ? topFive / total : 0,
    worstStreak,
    medianRiskPts: [...records.map((r) => r.riskPts)].sort((a, b) => a - b)[Math.floor(n / 2)],
    perMonth: null, // filled by the caller, which knows the elapsed window
  }
}

/**
 * Score both variants separately. They are never pooled: `withChoch` is a
 * strict subset of `noChoch`, so adding them would double-count.
 */
export function sweepScorecard(records, spec = SWEEP_SPEC) {
  const noChoch = capPerDay(records, spec.maxPerDay)
  const withChoch = capPerDay(records.filter((r) => r.choch), spec.maxPerDay)
  const months = records.length
    ? (Math.max(...records.map((r) => r.t)) - Math.min(...records.map((r) => r.t))) / (30.44 * 86_400_000)
    : 0
  const a = describe(withChoch, spec)
  const b = describe(noChoch, spec)
  if (months > 0.5) {
    a.perMonth = a.n / months
    b.perMonth = b.n / months
  }

  // The registered SMT question, on the loose variant where the sample lives.
  const withSmt = noChoch.filter((r) => r.smt)
  const meanOf = (xs) => (xs.length ? xs.reduce((p, q) => p + q.r, 0) / xs.length : null)
  const divergent = withSmt.filter((r) => r.smt.divergence)
  const confirmed = withSmt.filter((r) => !r.smt.divergence)

  return {
    months,
    withChoch: a,
    noChoch: b,
    smt: {
      tagged: withSmt.length,
      divergent: { n: divergent.length, meanR: meanOf(divergent) },
      confirmed: { n: confirmed.length, meanR: meanOf(confirmed) },
    },
  }
}

/**
 * The pre-registration measurement, produced by THIS module over the same
 * 704,591 bars, so the forward record is compared against a like-for-like
 * baseline rather than the exploratory script's.
 *
 * The two differ slightly and the reason is worth keeping: the research script
 * applied the CHoCH filter DURING the scan, so a rejected setup could not
 * block a later one, and it found 46 qualifying trades. This module finds
 * every setup first and filters after, which is the more faithful reading of
 * "two trades a day" and yields 36. Expectancy was unchanged either way
 * (+0.84R), but the smaller sample makes the concentration worse, not better.
 */
export const SWEEP_BACKTEST = {
  window: '2024-08 → 2026-08, 704,591 NQ bars',
  withChoch: { isR: 0.840, isN: 26, oosR: 0.839, oosN: 10, medianR: -1.02, topFiveShare: 1.39, perMonth: 1.5 },
  noChoch: { isR: 0.160, isN: 382, oosR: 0.158, oosN: 180, perMonth: 24 },
  randomControl: { isR: -0.079, oosR: -0.002 },
  smt: {
    divergentR: 0.289, divergentN: 220, confirmedR: 0.010, confirmedN: 465,
    note: 'divergent sweeps beat confirmed ones in both halves (+0.363 vs +0.025 IS, ' +
      '+0.157 vs −0.024 OOS) but t is 1.2, the median is −1.07R in BOTH groups, ' +
      'and the effect vanishes on the CHoCH subset',
  },
  caution:
    'median trade −1.02R; the best five trades were 139% of all profit (IS) and 163% (OOS); ' +
    't 1.4 and 0.7; ten out-of-sample trades; ~1.5 setups a month',
}
