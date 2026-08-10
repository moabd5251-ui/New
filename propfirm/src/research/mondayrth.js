/**
 * Monday day-session forward validation.
 *
 * The daily-classics sweep left exactly one INTRADAY cell sign-consistent in
 * both halves of the data: long the Monday RTH session, 09:30 open to 16:00
 * close (+33pt in-sample, +57pt out-of-sample, t ≈ 1.3–1.5). That is below
 * the significance bar and it was one cell among dozens tested — the classic
 * profile of a data-mined artifact. It is therefore registered here as a
 * frozen hypothesis, 2026-08-10, and judged only on nights that postdate the
 * registration. Expect it to die; if it does not, ~50 forward Mondays is a
 * year, so this one earns patience rather than money.
 *
 * Paper only, same rules as the overnight journal: each completed Monday is
 * evaluated exactly once and never re-evaluated.
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { CandleStore } from '../data/store.js'
import { etMinuteOfDay, futuresDayKey } from '../core/sessions.js'
import { loadOvernight } from './overnight.js'

export const MONDAY_RTH_SPEC = {
  version: 1,
  registered: '2026-08-10',
  entryEtMinute: 9 * 60 + 30,
  exitEtMinute: 16 * 60, // exclusive: exit is the last bar before 16:00
  stops: [null, 100],
  costPts: 1,
  stopSlipPts: 1,
  dollarsPerPoint: 2, // 1 MNQ
}

const isMonday = (dayKey) => new Date(`${dayKey}T12:00:00Z`).getUTCDay() === 1

/** Completed Monday RTH sessions: a 09:30 bar exists and the day has closed. */
export function extractMondays(candles) {
  const sessions = []
  let cur = null
  for (const c of candles) {
    const et = etMinuteOfDay(c.t)
    const key = futuresDayKey(c.t)
    if (cur && key !== cur.key) {
      if (cur.bars.length) sessions.push(cur)
      cur = null
    }
    if (et === MONDAY_RTH_SPEC.entryEtMinute && isMonday(key) && (!cur || cur.key !== key)) {
      cur = { key, t: c.t, entry: c.o, bars: [] }
    }
    if (cur && et >= MONDAY_RTH_SPEC.entryEtMinute && et < MONDAY_RTH_SPEC.exitEtMinute) {
      cur.bars.push(c)
      cur.exit = c.c
      cur.exitT = c.t
    }
  }
  // A session mid-series completes when the next trading day's bars appear
  // (handled in the loop). The final session in the series is complete only
  // if its last bar is the 15:59 close bar — an RTH bar never carries a
  // 16:00 stamp, and a series ending earlier may just be a partial day.
  if (cur && cur.bars.length && etMinuteOfDay(cur.exitT) === MONDAY_RTH_SPEC.exitEtMinute - 1) sessions.push(cur)
  return sessions
}

export function simulateMonday(session, stopPts) {
  const { costPts, stopSlipPts } = MONDAY_RTH_SPEC
  if (stopPts) {
    const stop = session.entry - stopPts
    for (const b of session.bars) {
      if (b.l <= stop) return { pts: stop - stopSlipPts - session.entry - costPts, exit: 'stop' }
    }
  }
  return { pts: session.exit - session.entry - costPts, exit: 'time' }
}

const variantKey = (stopPts) => (stopPts === null ? 'none' : `s${stopPts}`)

export function recordMondays({ root, symbol, journalPath = null }) {
  const path = journalPath ?? join(root, `${symbol.replace(/[^A-Za-z0-9]/g, '_')}-monday.jsonl`)
  const existing = loadOvernight(path) // same JSONL shape, same loader
  const watermark = existing.length ? existing[existing.length - 1].t : 0
  const registeredAt = Date.parse(`${MONDAY_RTH_SPEC.registered}T00:00:00Z`)

  const candles = new CandleStore(root, symbol).load()
  const fresh = extractMondays(candles).filter((s) => s.t > watermark && s.t >= registeredAt)

  const records = fresh.map((s) => {
    const variants = {}
    for (const stop of MONDAY_RTH_SPEC.stops) variants[variantKey(stop)] = simulateMonday(s, stop)
    return {
      spec: MONDAY_RTH_SPEC.version,
      monday: s.key,
      t: s.t,
      entry: s.entry,
      exit1600: s.exit,
      bars: s.bars.length,
      variants,
    }
  })

  if (records.length) {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  }
  return { path, added: records.length, records, total: existing.length + records.length }
}

export function mondayScorecard(records) {
  const out = { mondays: records.length, variants: {} }
  for (const stop of MONDAY_RTH_SPEC.stops) {
    const key = variantKey(stop)
    const pts = records.map((r) => r.variants[key].pts)
    const n = pts.length
    if (!n) {
      out.variants[key] = { n: 0 }
      continue
    }
    const mean = pts.reduce((a, b) => a + b, 0) / n
    const sd = n > 1 ? Math.sqrt(pts.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0
    out.variants[key] = {
      n,
      meanPts: mean,
      totalPts: pts.reduce((a, b) => a + b, 0),
      tStat: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0,
      winRate: pts.filter((p) => p > 0).length / n,
      worstPts: Math.min(...pts),
      stops: records.filter((r) => r.variants[key].exit === 'stop').length,
    }
  }
  return out
}

export const MONDAY_BACKTEST_REFERENCE = {
  window: '2024-08 → 2026-08, ~103 Mondays',
  meanPtsInSample: 32.8,
  meanPtsOutOfSample: 56.8,
  caution: 'one cell of dozens tested; t 1.3–1.5; contradicts the historical weekday literature',
}
