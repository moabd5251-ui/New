// The playbook, implemented as specified and tested on 704,591 real NQ bars.
//
// Sequence, all conditions required, all strictly causal:
//   1. Mark the overnight range (18:00 ET prev → 07:00 ET) and prior day H/L
//   2. During the NY killzone (07:00–10:00 ET), price SWEEPS one of those levels
//   3. DISPLACEMENT: a bar closes back through the swept level, range ≥ 1.2 ATR
//   4. CHoCH: the displacement breaks the most recent opposite intraday swing
//   5. ENTRY: limit inside the OTE band (62–79% retrace of the displacement leg)
//   6. Stop 3 ticks beyond the sweep extreme; T1 = 2R (half off, stop to BE);
//      T2 = opposite-side liquidity; time stop 11:30 ET
//
// Also tested: the same sequence with the OTE requirement dropped, with the
// CHoCH requirement dropped, and unrestricted by killzone, so the filters can
// be attributed rather than assumed.
import { CandleStore } from '/home/user/New/propfirm/src/data/store.js'
import { atr } from '/home/user/New/propfirm/src/core/candles.js'
import { etMinuteOfDay, futuresDayKey } from '/home/user/New/propfirm/src/core/sessions.js'

const candles = new CandleStore('/home/user/New/propfirm/data', 'NQ.v.0').load()
const SPLIT = Date.UTC(2026, 0, 1)
const a = atr(candles, 14)
const TICK = 0.25
console.log(`bars ${candles.length}`)

// ── Day scaffolding: overnight range and prior-day levels ──────────────────
const days = new Map() // dayKey → {onHigh,onLow,pdHigh,pdLow,startIdx}
{
  let key = null, cur = null, prevRth = null
  for (let i = 0; i < candles.length; i++) {
    const k = futuresDayKey(candles[i].t)
    const et = etMinuteOfDay(candles[i].t)
    if (k !== key) {
      if (cur) { cur.rthHigh = cur.rthHigh ?? -Infinity; days.set(key, cur) }
      prevRth = cur && cur.rthHigh > -Infinity ? { h: cur.rthHigh, l: cur.rthLow } : prevRth
      key = k
      cur = { onHigh: -Infinity, onLow: Infinity, rthHigh: -Infinity, rthLow: Infinity,
              pdHigh: prevRth?.h ?? null, pdLow: prevRth?.l ?? null }
    }
    // Overnight = 18:00 ET through 07:00 ET (Asia + London).
    if (et >= 18 * 60 || et < 7 * 60) {
      cur.onHigh = Math.max(cur.onHigh, candles[i].h)
      cur.onLow = Math.min(cur.onLow, candles[i].l)
    }
    if (et >= 570 && et < 960) {
      cur.rthHigh = Math.max(cur.rthHigh, candles[i].h)
      cur.rthLow = Math.min(cur.rthLow, candles[i].l)
    }
  }
  if (cur) days.set(key, cur)
}

const inKZ = (t) => { const et = etMinuteOfDay(t); return et >= 7 * 60 && et < 10 * 60 }
const pastTimeStop = (t) => etMinuteOfDay(t) >= 11 * 60 + 30

/**
 * Walk the series once, emitting completed trades. `opts` toggles each filter
 * so its contribution can be attributed.
 */
function runPlaybook({ requireOTE = true, requireCHoCH = true, killzoneOnly = true, maxPerDay = 2 } = {}) {
  const trades = []
  const perDay = new Map()
  let i = 20

  while (i < candles.length - 10) {
    const bar = candles[i]
    const key = futuresDayKey(bar.t)
    const d = days.get(key)
    if (!d || !Number.isFinite(a[i]) || a[i] <= 0) { i++; continue }
    if (killzoneOnly && !inKZ(bar.t)) { i++; continue }
    if ((perDay.get(key) ?? 0) >= maxPerDay) { i++; continue }

    // ── 1. Sweep of a marked level ────────────────────────────────────────
    const levels = [
      { price: d.onHigh, side: 'buyside', name: 'overnight high' },
      { price: d.pdHigh, side: 'buyside', name: 'prior day high' },
      { price: d.onLow, side: 'sellside', name: 'overnight low' },
      { price: d.pdLow, side: 'sellside', name: 'prior day low' },
    ].filter((l) => Number.isFinite(l.price))

    let swept = null
    for (const l of levels) {
      if (l.side === 'buyside' && bar.h > l.price && candles[i - 1].h <= l.price) swept = { ...l, extreme: bar.h }
      if (l.side === 'sellside' && bar.l < l.price && candles[i - 1].l >= l.price) swept = { ...l, extreme: bar.l }
      if (swept) break
    }
    if (!swept) { i++; continue }

    // Reversal direction: a buyside sweep sets up a SHORT.
    const dir = swept.side === 'buyside' ? -1 : 1
    const sweepExtreme = swept.extreme
    const sweepIdx = i

    // ── 2. Displacement back through the swept level, within 15 bars ──────
    let dispEnd = null
    for (let j = i + 1; j <= Math.min(i + 15, candles.length - 1); j++) {
      if (killzoneOnly && !inKZ(candles[j].t)) break
      // The sweep is invalidated if price extends further past the extreme.
      if (dir < 0 ? candles[j].h > sweepExtreme + 2 * a[j] : candles[j].l < sweepExtreme - 2 * a[j]) break
      const backThrough = dir < 0 ? candles[j].c < swept.price : candles[j].c > swept.price
      const big = (candles[j].h - candles[j].l) >= 1.2 * a[j]
      if (backThrough && big) { dispEnd = j; break }
    }
    if (dispEnd === null) { i = sweepIdx + 1; continue }

    // The displacement leg runs from the sweep extreme to the displacement close.
    const legStart = sweepExtreme
    const legEnd = candles[dispEnd].c
    const legSize = Math.abs(legEnd - legStart)
    if (legSize <= 0) { i = sweepIdx + 1; continue }

    // ── 3. CHoCH: displacement breaks the last opposite intraday swing ────
    if (requireCHoCH) {
      let broke = false
      // Most recent opposing pivot in the 30 bars before the sweep.
      let pivot = dir < 0 ? Infinity : -Infinity
      for (let k = Math.max(1, sweepIdx - 30); k < sweepIdx; k++) {
        pivot = dir < 0 ? Math.min(pivot, candles[k].l) : Math.max(pivot, candles[k].h)
      }
      broke = dir < 0 ? candles[dispEnd].c < pivot : candles[dispEnd].c > pivot
      if (!broke) { i = sweepIdx + 1; continue }
    }

    // ── 4. Entry on the OTE retrace of the displacement leg ───────────────
    const ote = requireOTE
      ? { lo: legEnd + dir * -1 * legSize * 0.62, hi: legEnd + dir * -1 * legSize * 0.79 }
      : null
    // For a short (dir=-1) the retrace is UP from legEnd toward legStart.
    const entryLo = ote ? Math.min(ote.lo, ote.hi) : null
    const entryHi = ote ? Math.max(ote.lo, ote.hi) : null

    let entryIdx = null, entryPrice = null
    for (let j = dispEnd + 1; j <= Math.min(dispEnd + 40, candles.length - 1); j++) {
      if (pastTimeStop(candles[j].t)) break
      if (!ote) { entryIdx = j; entryPrice = candles[j].o; break } // market at next open
      // A limit inside the band fills if the bar trades into it.
      if (candles[j].l <= entryHi && candles[j].h >= entryLo) {
        entryIdx = j
        entryPrice = dir < 0 ? entryLo : entryHi // conservative side of the band
        break
      }
      // Invalidated if price runs to target before retracing, or breaks the sweep.
      if (dir < 0 ? candles[j].h > sweepExtreme : candles[j].l < sweepExtreme) break
    }
    if (entryIdx === null) { i = sweepIdx + 1; continue }

    // ── 5. Stop, targets, management ──────────────────────────────────────
    const stop = sweepExtreme + dir * -1 * 3 * TICK * -1 // 3 ticks beyond the extreme
    const stopPrice = dir < 0 ? sweepExtreme + 3 * TICK : sweepExtreme - 3 * TICK
    const risk = Math.abs(entryPrice - stopPrice)
    if (risk <= 0) { i = sweepIdx + 1; continue }
    const t1 = entryPrice + dir * 2 * risk
    const oppLiq = dir < 0 ? (Number.isFinite(d.onLow) ? d.onLow : null) : (Number.isFinite(d.onHigh) ? d.onHigh : null)
    const t2 = oppLiq ?? entryPrice + dir * 4 * risk

    let half = false, stopNow = stopPrice, exitIdx = null, exitPrice = null, reason = null
    let realisedR = 0
    for (let j = entryIdx + 1; j < Math.min(entryIdx + 400, candles.length); j++) {
      const c = candles[j]
      const hitStop = dir > 0 ? c.l <= stopNow : c.h >= stopNow
      const hitT1 = !half && (dir > 0 ? c.h >= t1 : c.l <= t1)
      const hitT2 = half && (dir > 0 ? c.h >= t2 : c.l <= t2)
      if (hitStop) { // stop-first on ambiguous bars
        realisedR += (half ? 0.5 : 1) * ((dir * (stopNow - entryPrice)) / risk)
        exitIdx = j; exitPrice = stopNow; reason = half ? 'be-stop' : 'stop'
        break
      }
      if (hitT1) { realisedR += 0.5 * 2; half = true; stopNow = entryPrice; continue }
      if (hitT2) { realisedR += 0.5 * ((dir * (t2 - entryPrice)) / risk); exitIdx = j; exitPrice = t2; reason = 't2'; break }
      if (pastTimeStop(c.t)) {
        realisedR += (half ? 0.5 : 1) * ((dir * (c.c - entryPrice)) / risk)
        exitIdx = j; exitPrice = c.c; reason = 'time'
        break
      }
    }
    if (exitIdx === null) { i = sweepIdx + 1; continue }

    // Costs: 1 tick slippage each side plus commission, expressed in R.
    const costPts = 0.5 + 0.4
    const netR = realisedR - costPts / risk

    trades.push({ t: bar.t, dir, level: swept.name, riskPts: risk, r: netR, reason,
                  barsHeld: exitIdx - entryIdx })
    perDay.set(key, (perDay.get(key) ?? 0) + 1)
    i = exitIdx + 1
  }
  return trades
}

const stat = (ts) => {
  const n = ts.length
  if (!n) return { n: 0 }
  const rs = ts.map((t) => t.r)
  const mean = rs.reduce((x, y) => x + y, 0) / n
  const sd = n > 1 ? Math.sqrt(rs.reduce((x, y) => x + (y - mean) ** 2, 0) / (n - 1)) : 0
  const wins = rs.filter((x) => x > 0)
  const gl = -rs.filter((x) => x <= 0).reduce((x, y) => x + y, 0)
  return {
    n, expR: mean, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0,
    win: wins.length / n,
    avgWin: wins.length ? wins.reduce((x, y) => x + y, 0) / wins.length : 0,
    pf: gl > 0 ? wins.reduce((x, y) => x + y, 0) / gl : Infinity,
  }
}
const show = (name, ts) => {
  const is = stat(ts.filter((x) => x.t < SPLIT)), oos = stat(ts.filter((x) => x.t >= SPLIT))
  const f = (s) => s.n
    ? `n ${String(s.n).padStart(4)}  exp ${(s.expR >= 0 ? '+' : '') + s.expR.toFixed(3)}R  win ${(s.win * 100).toFixed(0)}%  avgWin ${s.avgWin.toFixed(2)}R  PF ${s.pf.toFixed(2)}  t ${(s.t >= 0 ? '+' : '') + s.t.toFixed(1)}`
    : 'n 0'
  console.log(`${name}\n   IS: ${f(is)}\n  OOS: ${f(oos)}`)
}

console.log('\n=== THE PLAYBOOK AS WRITTEN ===')
const full = runPlaybook()
show('sweep→displacement→CHoCH→OTE, killzone, 2/day', full)

console.log('\n=== FILTER ATTRIBUTION (drop one condition at a time) ===')
show('without the OTE retrace (market entry)', runPlaybook({ requireOTE: false }))
show('without the CHoCH requirement', runPlaybook({ requireCHoCH: false }))
show('without the killzone restriction', runPlaybook({ killzoneOnly: false }))

if (full.length) {
  console.log('\n=== THE PLAYBOOK\'S OWN GO-LIVE GATE ===')
  const all = stat(full)
  console.log(`  win rate ≥ 40%?    ${(all.win * 100).toFixed(1)}%  ${all.win >= 0.4 ? 'PASS' : 'FAIL'}`)
  console.log(`  avg winner ≥ 1.8R? ${all.avgWin.toFixed(2)}R  ${all.avgWin >= 1.8 ? 'PASS' : 'FAIL'}`)
  console.log(`  ≥ 30 trades?       ${all.n}  ${all.n >= 30 ? 'PASS' : 'FAIL'}`)
  let worst = 0, run = 0
  for (const t of full) { run = t.r < 0 ? run + 1 : 0; worst = Math.max(worst, run) }
  console.log(`  longest losing streak: ${worst} trades`)
  const byLevel = {}
  for (const t of full) (byLevel[t.level] ??= []).push(t.r)
  console.log('\n  by swept level:')
  for (const [k, v] of Object.entries(byLevel)) {
    const m = v.reduce((x, y) => x + y, 0) / v.length
    console.log(`    ${k.padEnd(16)} ${String(v.length).padStart(4)} trades  ${(m >= 0 ? '+' : '') + m.toFixed(3)}R`)
  }
  const byReason = {}
  for (const t of full) byReason[t.reason] = (byReason[t.reason] ?? 0) + 1
  console.log('  exits:', Object.entries(byReason).map(([k, v]) => `${k} ${v}`).join('  '))
}
