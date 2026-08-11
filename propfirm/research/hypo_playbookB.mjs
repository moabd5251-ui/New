// Playbook B — Killzone Trend Continuation, tested as specified.
//
//   Bias filter (all required): daily and 4H last-BOS agree, and price sits on
//   the trend side of the daily 20 EMA.
//   Entry: in the killzone, price pulls back against the trend; a 1m BOS back
//   in the trend direction confirms; enter on the retrace into the FVG that
//   trigger leaves; stop beyond the pullback extreme.
//   Manage: 2R half off and stop to breakeven, runner trailed below each new
//   15m higher low (mirrored for shorts), flat 15:45 ET.
//
// Everything causal: daily/4H structure is read as of the PREVIOUS completed
// bar, so a day never uses its own unfinished structure.
import { CandleStore } from '/home/user/New/propfirm/src/data/store.js'
import { aggregate, atr } from '/home/user/New/propfirm/src/core/candles.js'
import { findSwings } from '/home/user/New/propfirm/src/core/structure.js'
import { etMinuteOfDay, futuresDayKey } from '/home/user/New/propfirm/src/core/sessions.js'

const m1 = new CandleStore('/home/user/New/propfirm/data', 'NQ.v.0').load()
const SPLIT = Date.UTC(2026, 0, 1)
const m15 = aggregate(m1, '15m')
const h4 = aggregate(m1, '4h')
const d1 = aggregate(m1, '1d')
const a1 = atr(m1, 14)
console.log(`1m ${m1.length}  15m ${m15.length}  4h ${h4.length}  1d ${d1.length}`)

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
  let lastHigh = null, lastLow = null, dir = null
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

const dBos = bosTimeline(d1), hBos = bosTimeline(h4), dEma = ema(d1, 20)

/** Index of the last bar of `bars` closed strictly before time t. */
function asOf(bars, t) {
  let lo = 0, hi = bars.length - 1, ans = -1
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (bars[mid].t < t) { ans = mid; lo = mid + 1 } else hi = mid - 1 }
  return ans
}

const KZ_START = 7 * 60, KZ_END = 10 * 60, FLAT = 15 * 60 + 45
const inKZ = (t) => { const et = etMinuteOfDay(t); return et >= KZ_START && et < KZ_END }

/** The day's bias, decided from structure completed before the killzone. */
function biasFor(t) {
  const di = asOf(d1, t), hi = asOf(h4, t)
  if (di < 1 || hi < 1) return null
  const d = dBos[di - 1], h = hBos[hi - 1]
  if (!d || !h || d !== h) return null            // daily and 4H must agree
  // A futures daily bar OPENS at 18:00 ET the previous evening, so the bar
  // `asOf` returns at 07:00 is today's — still forming. Reading its close here
  // is reading the future. Use the last COMPLETED day's close.
  const price = d1[di - 1].c
  const e = dEma[di - 1]
  if (!Number.isFinite(e)) return null
  if (d === 'up' && !(price > e)) return null      // must be on the trend side
  if (d === 'down' && !(price < e)) return null
  return d === 'up' ? 1 : -1
}

function runPlaybookB({ requireBias = true, requireFvg = true } = {}) {
  const trades = []
  const perDay = new Map()
  let i = 60

  while (i < m1.length - 10) {
    const bar = m1[i]
    if (!inKZ(bar.t) || !Number.isFinite(a1[i]) || a1[i] <= 0) { i++; continue }
    const key = futuresDayKey(bar.t)
    if ((perDay.get(key) ?? 0) >= 2) { i++; continue }
    const dir = requireBias ? biasFor(bar.t) : (i % 2 ? 1 : -1)
    if (!dir) { i++; continue }

    // ── Pullback against the trend, measured over the last 30 killzone bars
    let ext = dir > 0 ? Infinity : -Infinity, extIdx = null
    for (let k = Math.max(0, i - 30); k <= i; k++) {
      if (!inKZ(m1[k].t)) continue
      if (dir > 0 ? m1[k].l < ext : m1[k].h > ext) { ext = dir > 0 ? m1[k].l : m1[k].h; extIdx = k }
    }
    if (extIdx === null || extIdx === i) { i++; continue }
    // The pullback must actually be a retrace: price came off a local extreme.
    let priorSwing = dir > 0 ? -Infinity : Infinity
    for (let k = Math.max(0, extIdx - 30); k < extIdx; k++) {
      priorSwing = dir > 0 ? Math.max(priorSwing, m1[k].h) : Math.min(priorSwing, m1[k].l)
    }
    if (!Number.isFinite(priorSwing)) { i++; continue }
    const pullbackDepth = Math.abs(priorSwing - ext)
    if (pullbackDepth < 0.5 * a1[i]) { i++; continue }

    // ── Continuation trigger: 1m close breaks the local structure back in trend
    let swing = dir > 0 ? -Infinity : Infinity
    for (let k = extIdx; k < i; k++) swing = dir > 0 ? Math.max(swing, m1[k].h) : Math.min(swing, m1[k].l)
    const triggered = dir > 0 ? bar.c > swing : bar.c < swing
    if (!triggered || !Number.isFinite(swing)) { i++; continue }
    const trigStart = extIdx, trigEnd = i

    // ── Entry on the retrace into the FVG left by the trigger move ────────
    let entryIdx = null, entryPrice = null
    if (requireFvg) {
      // Three-bar imbalance inside the trigger leg, nearest to the trigger bar.
      let gapTop = null, gapBottom = null
      for (let k = trigEnd; k >= Math.max(trigStart + 2, trigEnd - 20); k--) {
        const A = m1[k - 2], C = m1[k]
        if (dir > 0 && C.l > A.h) { gapTop = C.l; gapBottom = A.h; break }
        if (dir < 0 && C.h < A.l) { gapTop = A.l; gapBottom = C.h; break }
      }
      if (gapTop === null) { i++; continue }
      for (let j = i + 1; j <= Math.min(i + 40, m1.length - 1); j++) {
        if (etMinuteOfDay(m1[j].t) >= FLAT) break
        if (m1[j].l <= gapTop && m1[j].h >= gapBottom) {
          entryIdx = j
          entryPrice = dir > 0 ? gapTop : gapBottom  // conservative edge
          break
        }
        if (dir > 0 ? m1[j].l < ext : m1[j].h > ext) break // pullback broken
      }
    } else {
      entryIdx = i + 1
      entryPrice = m1[i + 1]?.o ?? null
    }
    if (entryIdx === null || entryPrice === null) { i++; continue }

    const stopPrice = dir > 0 ? ext - 2 * 0.25 : ext + 2 * 0.25
    const risk = Math.abs(entryPrice - stopPrice)
    if (!(risk > 0)) { i++; continue }
    const t1 = entryPrice + dir * 2 * risk

    // ── Manage: 2R half off, then trail the runner under 15m structure ────
    let half = false, stopNow = stopPrice, realisedR = 0, reason = null, exitIdx = null
    for (let j = entryIdx + 1; j < Math.min(entryIdx + 600, m1.length); j++) {
      const c = m1[j]
      if (dir > 0 ? c.l <= stopNow : c.h >= stopNow) {
        realisedR += (half ? 0.5 : 1) * ((dir * (stopNow - entryPrice)) / risk)
        exitIdx = j; reason = half ? 'trail' : 'stop'; break
      }
      if (!half && (dir > 0 ? c.h >= t1 : c.l <= t1)) { realisedR += 1; half = true; stopNow = entryPrice; continue }
      if (half) {
        // Trail below the last completed 15m bar's extreme in trend direction.
        const gi = asOf(m15, c.t)
        if (gi > 0) {
          const cand = dir > 0 ? m15[gi - 1].l : m15[gi - 1].h
          if (dir > 0 ? cand > stopNow : cand < stopNow) stopNow = cand
        }
      }
      if (etMinuteOfDay(c.t) >= FLAT) {
        realisedR += (half ? 0.5 : 1) * ((dir * (c.c - entryPrice)) / risk)
        exitIdx = j; reason = 'flat'; break
      }
    }
    if (exitIdx === null) { i++; continue }

    trades.push({ t: bar.t, dir, riskPts: risk, r: realisedR - 0.9 / risk, reason })
    perDay.set(key, (perDay.get(key) ?? 0) + 1)
    i = exitIdx + 1
  }
  return trades
}

const stat = (ts) => {
  const n = ts.length
  if (!n) return 'n 0'
  const rs = ts.map((x) => x.r)
  const total = rs.reduce((a, b) => a + b, 0), mean = total / n
  const sd = n > 1 ? Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0
  const sorted = [...rs].sort((a, b) => a - b)
  const wins = rs.filter((x) => x > 0)
  const top5 = [...rs].sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0)
  return `n ${String(n).padStart(4)}  exp ${(mean >= 0 ? '+' : '') + mean.toFixed(3)}R  win ${(wins.length / n * 100).toFixed(0)}%  ` +
    `avgWin ${(wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0).toFixed(2)}R  ` +
    `median ${sorted[Math.floor(n / 2)].toFixed(2)}R  top5 ${total !== 0 ? (top5 / total * 100).toFixed(0) : '—'}%  ` +
    `t ${(sd > 0 ? mean / (sd / Math.sqrt(n)) : 0).toFixed(1)}`
}
const show = (name, ts) => {
  console.log(`${name}\n   IS: ${stat(ts.filter((x) => x.t < SPLIT))}\n  OOS: ${stat(ts.filter((x) => x.t >= SPLIT))}`)
}

console.log('\n=== PLAYBOOK B AS WRITTEN ===')
const full = runPlaybookB()
show('bias filter + FVG entry + trail', full)
const months = 24
console.log(`  frequency: ${(full.length / months).toFixed(1)} trades/month`)

console.log('\n=== ATTRIBUTION ===')
show('without the bias filter (random direction)', runPlaybookB({ requireBias: false }))
show('without the FVG entry (market on trigger)', runPlaybookB({ requireFvg: false }))
