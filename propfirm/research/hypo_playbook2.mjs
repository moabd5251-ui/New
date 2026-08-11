// Controls for the playbook result: is it the entry, or the tiny stop plus a
// huge target? Same question that killed the multi-timeframe "edge".
import { CandleStore } from '/home/user/New/propfirm/src/data/store.js'
import { atr } from '/home/user/New/propfirm/src/core/candles.js'
import { etMinuteOfDay, futuresDayKey } from '/home/user/New/propfirm/src/core/sessions.js'

const candles = new CandleStore('/home/user/New/propfirm/data', 'NQ.v.0').load()
const a = atr(candles, 14)
const TICK = 0.25, SPLIT = Date.UTC(2026, 0, 1)

// Rebuild day scaffolding (same as the playbook run).
const days = new Map()
{
  let key = null, cur = null, prevRth = null
  for (let i = 0; i < candles.length; i++) {
    const k = futuresDayKey(candles[i].t), et = etMinuteOfDay(candles[i].t)
    if (k !== key) {
      if (cur) days.set(key, cur)
      prevRth = cur && cur.rthHigh > -Infinity ? { h: cur.rthHigh, l: cur.rthLow } : prevRth
      key = k
      cur = { onHigh: -Infinity, onLow: Infinity, rthHigh: -Infinity, rthLow: Infinity,
              pdHigh: prevRth?.h ?? null, pdLow: prevRth?.l ?? null }
    }
    if (et >= 1080 || et < 420) { cur.onHigh = Math.max(cur.onHigh, candles[i].h); cur.onLow = Math.min(cur.onLow, candles[i].l) }
    if (et >= 570 && et < 960) { cur.rthHigh = Math.max(cur.rthHigh, candles[i].h); cur.rthLow = Math.min(cur.rthLow, candles[i].l) }
  }
  if (cur) days.set(key, cur)
}
const inKZ = (t) => { const et = etMinuteOfDay(t); return et >= 420 && et < 600 }
const pastTimeStop = (t) => etMinuteOfDay(t) >= 690

/** Manage a position identically to the playbook, from a given entry. */
function manage(entryIdx, entryPrice, dir, stopPrice, t2) {
  const risk = Math.abs(entryPrice - stopPrice)
  if (risk <= 0) return null
  const t1 = entryPrice + dir * 2 * risk
  let half = false, stopNow = stopPrice, realisedR = 0, reason = null, exitIdx = null
  let t2R = 0
  for (let j = entryIdx + 1; j < Math.min(entryIdx + 400, candles.length); j++) {
    const c = candles[j]
    if (dir > 0 ? c.l <= stopNow : c.h >= stopNow) {
      realisedR += (half ? 0.5 : 1) * ((dir * (stopNow - entryPrice)) / risk)
      exitIdx = j; reason = half ? 'be-stop' : 'stop'; break
    }
    if (!half && (dir > 0 ? c.h >= t1 : c.l <= t1)) { realisedR += 1; half = true; stopNow = entryPrice; continue }
    if (half && (dir > 0 ? c.h >= t2 : c.l <= t2)) {
      t2R = (dir * (t2 - entryPrice)) / risk
      realisedR += 0.5 * t2R; exitIdx = j; reason = 't2'; break
    }
    if (pastTimeStop(c.t)) {
      realisedR += (half ? 0.5 : 1) * ((dir * (c.c - entryPrice)) / risk)
      exitIdx = j; reason = 'time'; break
    }
  }
  if (exitIdx === null) return null
  return { r: realisedR - 0.9 / risk, riskPts: risk, reason, t2R }
}

// ── The playbook's own trades, with points and dollars exposed ─────────────
const trades = []
let i = 20
while (i < candles.length - 10) {
  const bar = candles[i], key = futuresDayKey(bar.t), d = days.get(key)
  if (!d || !Number.isFinite(a[i]) || a[i] <= 0 || !inKZ(bar.t)) { i++; continue }
  const levels = [
    { p: d.onHigh, side: 'b' }, { p: d.pdHigh, side: 'b' },
    { p: d.onLow, side: 's' }, { p: d.pdLow, side: 's' },
  ].filter((l) => Number.isFinite(l.p))
  let swept = null
  for (const l of levels) {
    if (l.side === 'b' && bar.h > l.p && candles[i - 1].h <= l.p) swept = { ...l, ex: bar.h }
    if (l.side === 's' && bar.l < l.p && candles[i - 1].l >= l.p) swept = { ...l, ex: bar.l }
    if (swept) break
  }
  if (!swept) { i++; continue }
  const dir = swept.side === 'b' ? -1 : 1
  let dispEnd = null
  for (let j = i + 1; j <= Math.min(i + 15, candles.length - 1); j++) {
    if (!inKZ(candles[j].t)) break
    if (dir < 0 ? candles[j].h > swept.ex + 2 * a[j] : candles[j].l < swept.ex - 2 * a[j]) break
    if ((dir < 0 ? candles[j].c < swept.p : candles[j].c > swept.p) && (candles[j].h - candles[j].l) >= 1.2 * a[j]) { dispEnd = j; break }
  }
  if (dispEnd === null) { i++; continue }
  let pivot = dir < 0 ? Infinity : -Infinity
  for (let k = Math.max(1, i - 30); k < i; k++) pivot = dir < 0 ? Math.min(pivot, candles[k].l) : Math.max(pivot, candles[k].h)
  if (!(dir < 0 ? candles[dispEnd].c < pivot : candles[dispEnd].c > pivot)) { i++; continue }
  const legSize = Math.abs(candles[dispEnd].c - swept.ex)
  if (legSize <= 0) { i++; continue }
  const lo = Math.min(candles[dispEnd].c - dir * legSize * 0.62, candles[dispEnd].c - dir * legSize * 0.79)
  const hi = Math.max(candles[dispEnd].c - dir * legSize * 0.62, candles[dispEnd].c - dir * legSize * 0.79)
  let entryIdx = null, entryPrice = null
  for (let j = dispEnd + 1; j <= Math.min(dispEnd + 40, candles.length - 1); j++) {
    if (pastTimeStop(candles[j].t)) break
    if (candles[j].l <= hi && candles[j].h >= lo) { entryIdx = j; entryPrice = dir < 0 ? lo : hi; break }
    if (dir < 0 ? candles[j].h > swept.ex : candles[j].l < swept.ex) break
  }
  if (entryIdx === null) { i++; continue }
  const stopPrice = dir < 0 ? swept.ex + 3 * TICK : swept.ex - 3 * TICK
  const t2 = dir < 0 ? (Number.isFinite(d.onLow) ? d.onLow : entryPrice - 4 * Math.abs(entryPrice - stopPrice))
                     : (Number.isFinite(d.onHigh) ? d.onHigh : entryPrice + 4 * Math.abs(entryPrice - stopPrice))
  const m = manage(entryIdx, entryPrice, dir, stopPrice, t2)
  if (!m) { i++; continue }
  trades.push({ t: bar.t, dir, entryIdx, entryPrice, stopPrice, t2, ...m })
  i = m ? entryIdx + 1 : i + 1
}

const sum = (xs) => xs.reduce((p, q) => p + q, 0)
console.log(`playbook trades: ${trades.length}`)
const rs = trades.map(t => t.riskPts).sort((x, y) => x - y)
console.log(`stop size: median ${rs[Math.floor(rs.length/2)].toFixed(1)}pt, min ${rs[0].toFixed(1)}, max ${rs.at(-1).toFixed(1)}`)
console.log(`total R ${sum(trades.map(t=>t.r)).toFixed(1)}   total POINTS ${sum(trades.map(t=>t.r*t.riskPts)).toFixed(0)}   ≈ $${(sum(trades.map(t=>t.r*t.riskPts))*20).toFixed(0)} on 1 NQ`)
const t2s = trades.filter(t => t.reason === 't2')
console.log(`\nT2 hits: ${t2s.length}, median T2 distance ${t2s.length ? t2s.map(t=>t.t2R).sort((x,y)=>x-y)[Math.floor(t2s.length/2)].toFixed(1) : '-'}R`)
const sorted = [...trades].sort((x, y) => y.r - x.r)
console.log(`top 5 trades contribute ${(sum(sorted.slice(0,5).map(t=>t.r)) / sum(trades.map(t=>t.r)) * 100).toFixed(0)}% of total R`)
console.log(`median trade: ${[...trades].map(t=>t.r).sort((x,y)=>x-y)[Math.floor(trades.length/2)].toFixed(2)}R`)

// ── CONTROL: random entries in the killzone, same stop distance + management
const medRisk = rs[Math.floor(rs.length / 2)]
const control = []
const step = Math.max(1, Math.floor(candles.length / 4000))
for (let k = 500; k < candles.length - 500; k += step) {
  if (!inKZ(candles[k].t)) continue
  const d = days.get(futuresDayKey(candles[k].t))
  if (!d) continue
  const dir = (k % 2 === 0) ? 1 : -1
  const entryPrice = candles[k].c
  const stopPrice = entryPrice - dir * medRisk
  const t2 = dir > 0 ? (Number.isFinite(d.onHigh) ? d.onHigh : entryPrice + 4 * medRisk)
                     : (Number.isFinite(d.onLow) ? d.onLow : entryPrice - 4 * medRisk)
  if (dir > 0 ? t2 <= entryPrice : t2 >= entryPrice) continue
  const m = manage(k, entryPrice, dir, stopPrice, t2)
  if (m) control.push({ t: candles[k].t, ...m })
}
const stat = (ts) => {
  const n = ts.length; if (!n) return 'n 0'
  const r = ts.map(x => x.r), mean = sum(r) / n
  const sd = Math.sqrt(sum(r.map(x => (x - mean) ** 2)) / Math.max(1, n - 1))
  return `n ${String(n).padStart(4)}  exp ${(mean>=0?'+':'')+mean.toFixed(3)}R  win ${(r.filter(x=>x>0).length/n*100).toFixed(0)}%  t ${(mean/(sd/Math.sqrt(n))).toFixed(1)}`
}
console.log('\n=== CONTROL: random killzone entries, same stop distance, same 2R/half-off/opposite-liquidity management ===')
console.log(`  playbook  IS ${stat(trades.filter(t=>t.t<SPLIT))}`)
console.log(`            OOS ${stat(trades.filter(t=>t.t>=SPLIT))}`)
console.log(`  random    IS ${stat(control.filter(t=>t.t<SPLIT))}`)
console.log(`            OOS ${stat(control.filter(t=>t.t>=SPLIT))}`)
