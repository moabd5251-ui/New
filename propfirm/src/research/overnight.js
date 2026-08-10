/**
 * Overnight-capture forward validation.
 *
 * The hypothesis, registered 2026-08-10 BEFORE any of the data this module
 * will judge it on existed: long NQ from the 18:00 ET Globex open to the next
 * 09:30 ET RTH open, disaster stop, no target. Backtested on 24 months it
 * showed +16.3pt/night in-sample (t +2.0) and +26.2pt out-of-sample (t +1.3),
 * with a 50–100pt stop cutting the worst night from −946pt to one stop while
 * leaving the mean intact.
 *
 * A t of 2 on a bull sample is a hypothesis, not an edge. This module is the
 * test: each completed night is evaluated exactly once, appended to a journal,
 * and never re-evaluated — the same discipline as the signal forward pass. The
 * spec below is frozen; changing it invalidates the journal, which is why the
 * record carries a spec version.
 *
 * Paper only. Nothing here places, routes, or sizes a real order.
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { CandleStore } from '../data/store.js'
import { etMinuteOfDay } from '../core/sessions.js'

export const OVERNIGHT_SPEC = {
  version: 1,
  registered: '2026-08-10',
  entryEtMinute: 18 * 60, // Globex open
  exitEtMinute: 9 * 60 + 30, // next RTH open
  /** Stop distances in points below entry; null = no stop. */
  stops: [null, 50, 100],
  /** Round-trip cost per night in points: MNQ commission + slippage. */
  costPts: 1,
  /** Extra slippage charged when a stop is the exit. */
  stopSlipPts: 1,
  dollarsPerPoint: 2, // 1 MNQ
}

/**
 * Cut a 1-minute series into completed nights. A night opens on the first bar
 * stamped 18:00 ET and completes on the next 09:30 ET bar; a night that never
 * meets a 09:30 bar (holiday, data gap) is dropped rather than guessed at.
 */
export function extractNights(candles) {
  const nights = []
  let cur = null
  for (const c of candles) {
    const et = etMinuteOfDay(c.t)
    if (et === OVERNIGHT_SPEC.entryEtMinute) {
      cur = { t: c.t, entry: c.o, bars: [] }
    }
    if (cur) {
      cur.bars.push(c)
      if (et === OVERNIGHT_SPEC.exitEtMinute) {
        cur.exit = c.o
        cur.exitT = c.t
        nights.push(cur)
        cur = null
      }
    }
  }
  return nights
}

/**
 * One night against one stop distance. The entry bar itself participates —
 * a stop can be hit in the first minute. Stop beats exit on any bar it prints.
 */
export function simulateNight(night, stopPts) {
  const { costPts, stopSlipPts } = OVERNIGHT_SPEC
  if (stopPts) {
    const stop = night.entry - stopPts
    for (const b of night.bars) {
      if (b.l <= stop) return { pts: stop - stopSlipPts - night.entry - costPts, exit: 'stop' }
    }
  }
  return { pts: night.exit - night.entry - costPts, exit: 'time' }
}

const variantKey = (stopPts) => (stopPts === null ? 'none' : `s${stopPts}`)

/**
 * Append any newly completed nights to the journal, each exactly once.
 * The watermark is the last journaled entry time; nights are strictly ordered.
 */
export function recordOvernight({ root, symbol, journalPath = null }) {
  const path = journalPath ?? join(root, `${symbol.replace(/[^A-Za-z0-9]/g, '_')}-overnight.jsonl`)
  const existing = loadOvernight(path)
  const watermark = existing.length ? existing[existing.length - 1].t : 0
  const registeredAt = Date.parse(`${OVERNIGHT_SPEC.registered}T00:00:00Z`)

  const candles = new CandleStore(root, symbol).load()
  const fresh = extractNights(candles).filter((n) => n.t > watermark && n.t >= registeredAt)

  const records = fresh.map((n) => {
    const variants = {}
    for (const stop of OVERNIGHT_SPEC.stops) variants[variantKey(stop)] = simulateNight(n, stop)
    return {
      spec: OVERNIGHT_SPEC.version,
      night: new Date(n.t).toISOString().slice(0, 10),
      t: n.t,
      entry: n.entry,
      exit930: n.exit,
      bars: n.bars.length,
      variants,
    }
  })

  if (records.length) {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  }
  return { path, added: records.length, records, total: existing.length + records.length }
}

export function loadOvernight(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

/**
 * The running verdict: per-variant forward statistics, plus what a Lucid Flex
 * 50K holding 1 MNQ on this spec would look like — trailing-EOD $2,000 floor
 * locking at the start balance, $3,000 target.
 */
export function overnightScorecard(records, { startingBalance = 50000, drawdown = 2000, target = 3000 } = {}) {
  const out = { nights: records.length, variants: {} }
  for (const stop of OVERNIGHT_SPEC.stops) {
    const key = variantKey(stop)
    const pts = records.map((r) => r.variants[key].pts)
    const n = pts.length
    if (!n) {
      out.variants[key] = { n: 0 }
      continue
    }
    const mean = pts.reduce((a, b) => a + b, 0) / n
    const sd = n > 1 ? Math.sqrt(pts.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0
    let bal = startingBalance
    let floor = startingBalance - drawdown
    let breached = null
    let passed = null
    for (const [i, p] of pts.entries()) {
      bal += p * OVERNIGHT_SPEC.dollarsPerPoint
      if (!breached && bal <= floor) breached = records[i].night
      floor = Math.min(Math.max(floor, bal - drawdown), startingBalance)
      if (!passed && !breached && bal >= startingBalance + target) passed = records[i].night
    }
    out.variants[key] = {
      n,
      meanPts: mean,
      totalPts: pts.reduce((a, b) => a + b, 0),
      tStat: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0,
      winRate: pts.filter((p) => p > 0).length / n,
      worstPts: Math.min(...pts),
      stops: records.filter((r) => r.variants[key].exit === 'stop').length,
      balance: bal,
      breached,
      passed,
    }
  }
  return out
}

/**
 * The backtested reference the forward sample is judged against. If the
 * forward mean settles far below this, the hypothesis failed; that outcome is
 * as valuable as the other one, and considerably cheaper than an evaluation.
 */
export const BACKTEST_REFERENCE = {
  window: '2024-08 → 2026-08, 511 nights',
  meanPtsNoStop: 19.3,
  meanPtsInSample: 16.3,
  meanPtsOutOfSample: 26.2,
  sdPts: 183,
}
