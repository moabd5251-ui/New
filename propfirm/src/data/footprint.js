/**
 * Per-minute footprint: real buy and sell aggressor volume.
 *
 * This is the data the whole orderflow layer was written against and never had.
 * Everything else in this system infers delta from where a bar closed in its
 * range; a footprint states it, because every trade on CME carries the side
 * that initiated it.
 *
 * ── The convention, verified rather than assumed ────────────────────────────
 * In Databento's trades schema, `side` is the side of the AGGRESSOR's order:
 * 'B' (bid) is a buy aggressor, 'A' (ask) is a sell aggressor. That is the
 * opposite of the naive "a trade at the ask is a buy" reading, and getting it
 * backwards silently inverts every delta in the system.
 *
 * So it was checked against the tape instead of taken on trust: bucketing one
 * day of NQ trades by minute and correlating (B − A) against the price change
 * over that minute gives +0.70. The sign is not a matter of opinion.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Raw trades are enormous — roughly 48 MB of CSV for a single day of NQ, and
 * gigabytes for a useful span. Only the aggregate is kept: a few hundred KB per
 * month, which is small enough to commit and is all `FootprintOrderflow` needs.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { futuresDayKey } from '../core/sessions.js'

/** Aggressor side codes as they appear in the trades feed. */
export const BUY_AGGRESSOR = 'B'
export const SELL_AGGRESSOR = 'A'

/**
 * Fold a trades CSV into per-interval buy/sell volume.
 *
 * Parsed line by line rather than through a CSV library because a day of NQ is
 * ~415,000 rows and only four columns matter.
 *
 * @param {string} text raw CSV from the trades schema
 * @param {{intervalSeconds?:number}} [opts]
 * @returns {{t:number, buyVolume:number, sellVolume:number, trades:number}[]}
 */
export function aggregateTradesToFootprint(text, { intervalSeconds = 60 } = {}) {
  const lines = text.split('\n')
  if (lines.length < 2) return []

  const header = lines[0].split(',')
  const iTs = header.indexOf('ts_event')
  const iSide = header.indexOf('side')
  const iSize = header.indexOf('size')
  if (iTs < 0 || iSide < 0 || iSize < 0) {
    throw new Error(`Unexpected trades CSV header: ${lines[0].slice(0, 140)}`)
  }

  const step = intervalSeconds * 1000
  const buckets = new Map()

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    const cols = line.split(',')
    const ts = Date.parse(cols[iTs])
    if (!Number.isFinite(ts)) continue
    const size = Number(cols[iSize])
    if (!Number.isFinite(size)) continue

    const key = Math.floor(ts / step) * step
    let b = buckets.get(key)
    if (!b) {
      b = { t: key, buyVolume: 0, sellVolume: 0, trades: 0 }
      buckets.set(key, b)
    }
    const side = cols[iSide]
    if (side === BUY_AGGRESSOR) b.buyVolume += size
    else if (side === SELL_AGGRESSOR) b.sellVolume += size
    // 'N' — no side reported. Counted in `trades` but attributed to neither,
    // which is honest: guessing would add noise dressed as information.
    b.trades++
  }

  return [...buckets.values()].sort((a, b) => a.t - b.t)
}

/** Day-partitioned store for footprint rows. */
export class FootprintStore {
  constructor(root, symbol) {
    this.dir = join(root, `${symbol.replace(/[^A-Za-z0-9_-]/g, '_')}@footprint`)
  }

  days() {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort()
  }

  readDay(day) {
    const path = join(this.dir, `${day}.csv`)
    if (!existsSync(path)) return []
    const out = []
    for (const line of readFileSync(path, 'utf8').split('\n').slice(1)) {
      if (!line.trim()) continue
      const [t, buy, sell, trades] = line.split(',')
      out.push({ t: Date.parse(t), buyVolume: Number(buy), sellVolume: Number(sell), trades: Number(trades) })
    }
    return out
  }

  /** Merge rows in, keyed on timestamp. Idempotent, like the candle store. */
  merge(rows) {
    if (!rows.length) return { added: 0, days: [] }
    mkdirSync(this.dir, { recursive: true })
    const byDay = new Map()
    for (const r of rows) {
      const day = futuresDayKey(r.t)
      if (!byDay.has(day)) byDay.set(day, [])
      byDay.get(day).push(r)
    }

    let added = 0
    const touched = []
    for (const [day, incoming] of byDay) {
      const merged = new Map(this.readDay(day).map((r) => [r.t, r]))
      for (const r of incoming) {
        if (!merged.has(r.t)) added++
        merged.set(r.t, r)
      }
      const sorted = [...merged.values()].sort((a, b) => a.t - b.t)
      const lines = ['time,buyVolume,sellVolume,trades']
      for (const r of sorted) {
        lines.push(`${new Date(r.t).toISOString()},${r.buyVolume},${r.sellVolume},${r.trades}`)
      }
      writeFileSync(join(this.dir, `${day}.csv`), lines.join('\n') + '\n')
      touched.push(day)
    }
    return { added, days: touched.sort() }
  }

  load(range = {}) {
    const { from = '0000-00-00', to = '9999-99-99' } = range
    const out = []
    for (const day of this.days()) {
      if (day < from || day > to) continue
      out.push(...this.readDay(day))
    }
    return out.sort((a, b) => a.t - b.t)
  }

  coverage() {
    const days = this.days()
    const rows = this.load()
    return {
      days: days.length,
      rows: rows.length,
      first: days[0] ?? null,
      last: days.at(-1) ?? null,
      totalVolume: rows.reduce((a, r) => a + r.buyVolume + r.sellVolume, 0),
    }
  }
}

/**
 * Line footprint rows up with a candle series, so `FootprintOrderflow` gets one
 * entry per bar.
 *
 * Bars with no footprint row get zeroes rather than being dropped — a minute
 * that printed no trades genuinely has no delta, and silently shortening the
 * series would misalign every index downstream.
 *
 * @returns {{footprint:{buyVolume:number, sellVolume:number}[], matched:number, missing:number}}
 */
export function alignFootprint(candles, rows) {
  const byTime = new Map(rows.map((r) => [r.t, r]))
  let matched = 0
  let missing = 0
  const footprint = candles.map((c) => {
    const r = byTime.get(c.t)
    if (r) {
      matched++
      return { buyVolume: r.buyVolume, sellVolume: r.sellVolume }
    }
    missing++
    return { buyVolume: 0, sellVolume: 0 }
  })
  return { footprint, matched, missing }
}
