/**
 * Playbook B — Killzone Trend Continuation. Registered forward validation.
 *
 * Measured before registration over 704,591 NQ bars, and the better-shaped of
 * the two playbooks despite a much smaller per-trade edge:
 *
 *                       Playbook A (sweep)     Playbook B (this)
 *   in-sample           +0.840R  (n 26)        +0.108R  (n 379)
 *   out-of-sample       +0.839R  (n 10)        +0.254R  (n 142)
 *   t                    1.4 / 0.7              1.3 / 1.7
 *   median trade        −1.02R                 −1.04R
 *   top 5 = % of profit  139% / 163%            86% / 85%
 *   frequency            1.5/month              21.7/month
 *   R per month         ~1.3R                  ~3.2R
 *
 * B earns more per month from frequency alone, its profit is not hostage to
 * five trades, and thirty trades takes six weeks rather than twenty months —
 * which is the difference between a hypothesis that can be tested and one that
 * cannot.
 *
 * Both of its filters are load-bearing, which is the reason to take it
 * seriously. Randomise the direction and it returns −0.009R / +0.036R; enter
 * at market on the trigger instead of waiting for the FVG and it returns
 * −0.089R / +0.098R. Two independent components each carrying the result.
 *
 * A LOOKAHEAD BUG WAS FOUND AND FIXED while measuring this, and it is worth
 * stating because it flattered the result: a futures daily bar OPENS at 18:00
 * ET the previous evening, so the "last daily bar before now" at 07:00 is
 * today's, still forming. Reading its close was reading the future and lifted
 * the numbers to +0.158R / +0.286R. The figures above are post-fix.
 *
 * Still not significant — t below 2, median trade a full stop-out. Paper only.
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { CandleStore } from '../data/store.js'
import { aggregate, atr } from '../core/candles.js'
import { findSwings } from '../core/structure.js'
import { volumeProfile } from '../core/orderflow.js'
import { etMinuteOfDay, futuresDayKey } from '../core/sessions.js'

export const TRENDCONT_SPEC = {
  version: 1,
  registered: '2026-08-11',
  killzoneStart: 7 * 60,
  killzoneEnd: 10 * 60,
  flatBy: 15 * 60 + 45,
  emaPeriod: 20,
  /** Minimum pullback depth, in ATR, or it is noise rather than a retrace. */
  minPullbackAtr: 0.5,
  pullbackLookback: 30,
  entryWindow: 40,
  stopTicks: 2,
  tickSize: 0.25,
  firstTargetR: 2,
  costPts: 0.9,
  maxPerDay: 2,
  /** Prior-day value area, for scoring level quality — recorded, not filtered on. */
  valueAreaPct: 0.7,
  profileBinSize: 1,
}

/** Last break-of-structure direction per bar, from confirmed swings only. */
function bosTimeline(bars) {
  const swings = findSwings(bars, { left: 2, right: 2 })
  const byConfirm = new Map()
  for (const s of swings) {
    const at = s.index + 2
    if (!byConfirm.has(at)) byConfirm.set(at, [])
    byConfirm.get(at).push(s)
  }
  const out = new Array(bars.length).fill(null)
  let lastHigh = null
  let lastLow = null
  let dir = null
  for (let i = 0; i < bars.length; i++) {
    for (const s of byConfirm.get(i) ?? []) {
      if (s.type === 'high') lastHigh = s.price
      else lastLow = s.price
    }
    if (lastHigh !== null && bars[i].c > lastHigh) { dir = 'up'; lastHigh = bars[i].c }
    if (lastLow !== null && bars[i].c < lastLow) { dir = 'down'; lastLow = bars[i].c }
    out[i] = dir
  }
  return out
}

function ema(bars, period) {
  const k = 2 / (period + 1)
  const out = new Array(bars.length).fill(NaN)
  let prev = null
  for (let i = 0; i < bars.length; i++) {
    prev = prev === null ? bars[i].c : bars[i].c * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

/** Index of the last bar closed strictly before time t. */
function asOf(bars, t) {
  let lo = 0
  let hi = bars.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (bars[mid].t < t) { ans = mid; lo = mid + 1 } else hi = mid - 1
  }
  return ans
}

/**
 * Prior completed day's value area, per trading day. Recorded on every setup
 * so the claim "levels inside the value area are better levels" becomes a
 * measurement the forward journal can settle, rather than an assumption baked
 * into the filter. Nothing is rejected for it.
 */
export function priorValueAreas(candles, spec = TRENDCONT_SPEC) {
  const byDay = new Map()
  let key = null
  let start = 0
  const order = []
  for (let i = 0; i < candles.length; i++) {
    const k = futuresDayKey(candles[i].t)
    if (k !== key) {
      if (key !== null) { byDay.set(key, [start, i - 1]); order.push(key) }
      key = k
      start = i
    }
  }
  if (key !== null) { byDay.set(key, [start, candles.length - 1]); order.push(key) }

  const out = new Map()
  for (let n = 1; n < order.length; n++) {
    const [from, to] = byDay.get(order[n - 1])
    const p = volumeProfile(candles, { binSize: spec.profileBinSize, from, to, valueArea: spec.valueAreaPct })
    out.set(order[n], { poc: p.poc, vah: p.vah, val: p.val })
  }
  return out
}

/**
 * Every Playbook B setup in the series. The per-day cap is applied here
 * because, unlike the sweep spec, there is only one variant to score.
 */
export function findTrendSetups(candles, spec = TRENDCONT_SPEC) {
  const m15 = aggregate(candles, '15m')
  const h4 = aggregate(candles, '4h')
  const d1 = aggregate(candles, '1d')
  const a1 = atr(candles, 14)
  const dBos = bosTimeline(d1)
  const hBos = bosTimeline(h4)
  const dEma = ema(d1, spec.emaPeriod)
  const valueAreas = priorValueAreas(candles, spec)

  const inKZ = (t) => {
    const et = etMinuteOfDay(t)
    return et >= spec.killzoneStart && et < spec.killzoneEnd
  }

  const biasFor = (t) => {
    const di = asOf(d1, t)
    const hi = asOf(h4, t)
    if (di < 1 || hi < 1) return null
    const d = dBos[di - 1]
    const h = hBos[hi - 1]
    if (!d || !h || d !== h) return null
    // The bar `asOf` returns at 07:00 is TODAY's daily bar, opened at 18:00 the
    // previous evening and still forming. Its close is the future — use the
    // last completed day.
    const price = d1[di - 1].c
    const e = dEma[di - 1]
    if (!Number.isFinite(e)) return null
    if (d === 'up' && !(price > e)) return null
    if (d === 'down' && !(price < e)) return null
    return d === 'up' ? 1 : -1
  }

  const out = []
  const perDay = new Map()
  let i = 60

  while (i < candles.length - 10) {
    const bar = candles[i]
    if (!inKZ(bar.t) || !Number.isFinite(a1[i]) || a1[i] <= 0) { i++; continue }
    const key = futuresDayKey(bar.t)
    if ((perDay.get(key) ?? 0) >= spec.maxPerDay) { i++; continue }
    const dir = biasFor(bar.t)
    if (!dir) { i++; continue }

    // Pullback: the extreme against the trend inside the recent killzone window.
    let ext = dir > 0 ? Infinity : -Infinity
    let extIdx = null
    for (let k = Math.max(0, i - spec.pullbackLookback); k <= i; k++) {
      if (!inKZ(candles[k].t)) continue
      const v = dir > 0 ? candles[k].l : candles[k].h
      if (dir > 0 ? v < ext : v > ext) { ext = v; extIdx = k }
    }
    if (extIdx === null || extIdx === i) { i++; continue }

    let priorSwing = dir > 0 ? -Infinity : Infinity
    for (let k = Math.max(0, extIdx - spec.pullbackLookback); k < extIdx; k++) {
      priorSwing = dir > 0 ? Math.max(priorSwing, candles[k].h) : Math.min(priorSwing, candles[k].l)
    }
    if (!Number.isFinite(priorSwing)) { i++; continue }
    if (Math.abs(priorSwing - ext) < spec.minPullbackAtr * a1[i]) { i++; continue }

    // Continuation trigger: a close through the local structure, back in trend.
    let swing = dir > 0 ? -Infinity : Infinity
    for (let k = extIdx; k < i; k++) swing = dir > 0 ? Math.max(swing, candles[k].h) : Math.min(swing, candles[k].l)
    if (!Number.isFinite(swing)) { i++; continue }
    if (!(dir > 0 ? bar.c > swing : bar.c < swing)) { i++; continue }

    // Entry: the retrace into the FVG the trigger leg left behind.
    let gapTop = null
    let gapBottom = null
    for (let k = i; k >= Math.max(extIdx + 2, i - 20); k--) {
      const A = candles[k - 2]
      const C = candles[k]
      if (dir > 0 && C.l > A.h) { gapTop = C.l; gapBottom = A.h; break }
      if (dir < 0 && C.h < A.l) { gapTop = A.l; gapBottom = C.h; break }
    }
    if (gapTop === null) { i++; continue }

    let entryIdx = null
    let entryPrice = null
    for (let j = i + 1; j <= Math.min(i + spec.entryWindow, candles.length - 1); j++) {
      if (etMinuteOfDay(candles[j].t) >= spec.flatBy) break
      if (candles[j].l <= gapTop && candles[j].h >= gapBottom) {
        entryIdx = j
        entryPrice = dir > 0 ? gapTop : gapBottom
        break
      }
      if (dir > 0 ? candles[j].l < ext : candles[j].h > ext) break
    }
    if (entryIdx === null) { i++; continue }

    const stopPrice = ext - dir * spec.stopTicks * spec.tickSize
    const risk = Math.abs(entryPrice - stopPrice)
    if (!(risk > 0)) { i++; continue }
    const t1 = entryPrice + dir * spec.firstTargetR * risk

    let half = false
    let stopNow = stopPrice
    let realisedR = 0
    let reason = null
    let exitIdx = null
    for (let j = entryIdx + 1; j < Math.min(entryIdx + 600, candles.length); j++) {
      const c = candles[j]
      if (dir > 0 ? c.l <= stopNow : c.h >= stopNow) {
        realisedR += (half ? 0.5 : 1) * ((dir * (stopNow - entryPrice)) / risk)
        exitIdx = j
        reason = half ? 'trail' : 'stop'
        break
      }
      if (!half && (dir > 0 ? c.h >= t1 : c.l <= t1)) {
        realisedR += 0.5 * spec.firstTargetR
        half = true
        stopNow = entryPrice
        continue
      }
      if (half) {
        const gi = asOf(m15, c.t)
        if (gi > 0) {
          const cand = dir > 0 ? m15[gi - 1].l : m15[gi - 1].h
          if (dir > 0 ? cand > stopNow : cand < stopNow) stopNow = cand
        }
      }
      if (etMinuteOfDay(c.t) >= spec.flatBy) {
        realisedR += (half ? 0.5 : 1) * ((dir * (c.c - entryPrice)) / risk)
        exitIdx = j
        reason = 'flat'
        break
      }
    }
    if (exitIdx === null) { i++; continue }

    const va = valueAreas.get(key) ?? null
    out.push({
      day: key,
      t: bar.t,
      direction: dir > 0 ? 'long' : 'short',
      entry: entryPrice,
      stop: stopPrice,
      riskPts: risk,
      r: realisedR - spec.costPts / risk,
      reason,
      barsHeld: exitIdx - entryIdx,
      // Level quality, recorded for later analysis rather than filtered on.
      valueArea: va && Number.isFinite(va.poc)
        ? {
            poc: Math.round(va.poc * 100) / 100,
            vah: Math.round(va.vah * 100) / 100,
            val: Math.round(va.val * 100) / 100,
            entryInValueArea: entryPrice >= va.val && entryPrice <= va.vah,
            atrFromPoc: Math.round((Math.abs(entryPrice - va.poc) / a1[i]) * 100) / 100,
          }
        : null,
    })
    perDay.set(key, (perDay.get(key) ?? 0) + 1)
    i = exitIdx + 1
  }
  return out
}

/* ── journal ──────────────────────────────────────────────────────────────── */

export const trendJournalPath = (root, symbol) =>
  join(root, `${symbol.replace(/[^A-Za-z0-9]/g, '_')}-trendcont.jsonl`)

export function loadTrendSetups(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

export function recordTrendSetups({ root, symbol, journalPath = null, spec = TRENDCONT_SPEC }) {
  const path = journalPath ?? trendJournalPath(root, symbol)
  const existing = loadTrendSetups(path)
  const seenDays = new Set(existing.map((r) => r.day))
  const registeredAt = Date.parse(`${spec.registered}T00:00:00Z`)

  const candles = new CandleStore(root, symbol).load()
  if (!candles.length) return { path, added: 0, records: [], total: existing.length }

  const complete = new Set()
  for (const c of candles) {
    if (etMinuteOfDay(c.t) >= spec.flatBy) complete.add(futuresDayKey(c.t))
  }

  const fresh = findTrendSetups(candles, spec).filter(
    (s) => !seenDays.has(s.day) && complete.has(s.day) && s.t >= registeredAt,
  )
  const records = fresh.map((s) => ({ spec: spec.version, ...s }))
  if (records.length) {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  }
  return { path, added: records.length, records, total: existing.length + records.length }
}

export function trendScorecard(records) {
  const n = records.length
  if (!n) return { n: 0 }
  const rs = records.map((r) => r.r)
  const total = rs.reduce((a, b) => a + b, 0)
  const mean = total / n
  const sd = n > 1 ? Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0
  const sorted = [...rs].sort((a, b) => a - b)
  const wins = rs.filter((x) => x > 0)
  const grossLoss = -rs.filter((x) => x <= 0).reduce((a, b) => a + b, 0)
  const top5 = [...rs].sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0)
  let worstStreak = 0
  let run = 0
  for (const r of rs) { run = r < 0 ? run + 1 : 0; worstStreak = Math.max(worstStreak, run) }
  const months = (Math.max(...records.map((r) => r.t)) - Math.min(...records.map((r) => r.t))) / (30.44 * 86_400_000)

  // The registered side-question: does entering inside the prior day's value
  // area actually produce better trades? Reported, never filtered on.
  const inVa = records.filter((r) => r.valueArea?.entryInValueArea)
  const outVa = records.filter((r) => r.valueArea && !r.valueArea.entryInValueArea)
  const meanOf = (xs) => (xs.length ? xs.reduce((a, b) => a + b.r, 0) / xs.length : null)

  return {
    n,
    expR: mean,
    tStat: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0,
    winRate: wins.length / n,
    avgWin: wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0,
    profitFactor: grossLoss > 0 ? wins.reduce((a, b) => a + b, 0) / grossLoss : Infinity,
    totalR: total,
    medianR: sorted[Math.floor(n / 2)],
    topFiveShare: total !== 0 ? top5 / total : 0,
    worstStreak,
    perMonth: months > 0.5 ? n / months : null,
    valueArea: {
      inside: { n: inVa.length, meanR: meanOf(inVa) },
      outside: { n: outVa.length, meanR: meanOf(outVa) },
    },
  }
}

export const TRENDCONT_BACKTEST = {
  window: '2024-08 → 2026-08, 704,591 NQ bars',
  isR: 0.108, isN: 379, oosR: 0.254, oosN: 142,
  medianR: -1.04, topFiveShare: 0.86, perMonth: 21.7,
  withoutBias: { isR: -0.009, oosR: 0.036 },
  withoutFvg: { isR: -0.089, oosR: 0.098 },
  caution: 't 1.3 and 1.7 — below the |t| ≥ 3 bar; median trade is a full stop-out',
}
