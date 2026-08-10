/**
 * Day-partitioned candle store.
 *
 * The point of this module is accumulation. Yahoo only serves 7 days of
 * 1-minute data, which is nowhere near enough to judge a strategy — but the
 * window moves. Pull it regularly and merge, and after a few months you own a
 * 1-minute history nobody will sell you cheaply, at the timeframe the system
 * actually trades.
 *
 * Design constraints that follow from that:
 *
 *   • Partition granularity follows the bar size. A minute series gets one CSV
 *     per CME trading day (18:00 ET boundary, matching every other date
 *     decision here); hourly bars get one per month and daily bars one per
 *     year, because a file holding a single row is not a partition, it is
 *     litter — 500 daily bars should not mean 500 files in the diff.
 *   • Closed partitions are rarely rewritten, so the store stays append-only in
 *     git terms and diffs stay small and reviewable.
 *   • Merging is idempotent and keyed on timestamp. Collecting twice in an
 *     hour adds nothing; a gap filled later slots into the right day.
 *   • Bars already stored are never deleted. A provider revision updates a
 *     bar in place; it cannot remove history.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseCSV } from './csv.js'
import { futuresDayKey } from '../core/sessions.js'

export class CandleStore {
  /**
   * @param {string} root directory to hold the store
   * @param {string} symbol e.g. "NQ=F" (sanitised for the filesystem)
   * @param {{partition?:'day'|'month'|'year'|'auto'}} [opts]
   */
  constructor(root, symbol, opts = {}) {
    this.root = root
    this.symbol = symbol
    this.dir = join(root, symbol.replace(/[^A-Za-z0-9_-]/g, '_'))
    this.partition = opts.partition ?? 'auto'
  }

  /** Partition keys present in the store, ascending. */
  days() {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter((f) => /^\d{4}(-\d{2}){0,2}\.csv$/.test(f))
      .map((f) => f.replace(/\.csv$/, ''))
      .sort()
  }

  pathFor(day) {
    return join(this.dir, `${day}.csv`)
  }

  /** Bars in one partition, or [] if it is not stored. */
  readDay(day) {
    const path = this.pathFor(day)
    if (!existsSync(path)) return []
    return parseCSV(readFileSync(path, 'utf8'))
  }

  /**
   * Choose a partition key. `auto` infers granularity from the bar spacing of
   * the incoming series, so callers do not have to declare it.
   */
  #keyFor(t, granularity) {
    const day = futuresDayKey(t)
    if (granularity === 'year') return day.slice(0, 4)
    if (granularity === 'month') return day.slice(0, 7)
    return day
  }

  #granularity(candles) {
    if (this.partition !== 'auto') return this.partition
    // Existing files win, so a store never changes shape underneath itself.
    const existing = this.days()[0]
    if (existing) return existing.length === 4 ? 'year' : existing.length === 7 ? 'month' : 'day'
    // Judge spacing from the median gap, not the first pair: a session break or
    // a weekend between the opening bars would otherwise make a minute series
    // look hourly. Too few bars to judge means the finest granularity, which is
    // always safe.
    if (candles.length < 10) return 'day'
    const gaps = []
    for (let i = 1; i < Math.min(candles.length, 200); i++) gaps.push((candles[i].t - candles[i - 1].t) / 1000)
    gaps.sort((a, b) => a - b)
    const step = gaps[Math.floor(gaps.length / 2)]
    if (step >= 86_400) return 'year'
    if (step >= 3_600) return 'month'
    return 'day'
  }

  /**
   * Merge bars into the store.
   *
   * @param {import('../core/candles.js').Candle[]} candles
   * @returns {{added:number, updated:number, unchanged:number, days:string[]}}
   */
  merge(candles) {
    if (!candles.length) return { added: 0, updated: 0, unchanged: 0, days: [] }
    mkdirSync(this.dir, { recursive: true })

    // Group incoming bars by partition so each file is written once.
    const granularity = this.#granularity(candles)
    const byDay = new Map()
    for (const c of candles) {
      const day = this.#keyFor(c.t, granularity)
      if (!byDay.has(day)) byDay.set(day, [])
      byDay.get(day).push(c)
    }

    let added = 0
    let updated = 0
    let unchanged = 0
    const touched = []

    for (const [day, incoming] of byDay) {
      const existing = this.readDay(day)
      const merged = new Map(existing.map((c) => [c.t, c]))

      let dayChanged = false
      for (const c of incoming) {
        const prev = merged.get(c.t)
        if (!prev) {
          merged.set(c.t, c)
          added++
          dayChanged = true
        } else if (prev.o !== c.o || prev.h !== c.h || prev.l !== c.l || prev.c !== c.c || prev.v !== c.v) {
          // A provider revision. Take the newer values, but never drop a bar.
          merged.set(c.t, c)
          updated++
          dayChanged = true
        } else {
          unchanged++
        }
      }

      if (!dayChanged) continue
      const rows = [...merged.values()].sort((a, b) => a.t - b.t)
      writeFileSync(this.pathFor(day), serialise(rows))
      touched.push(day)
    }

    return { added, updated, unchanged, days: touched.sort() }
  }

  /**
   * Load the whole store, or a date range, as one ascending series.
   * @param {{from?:string, to?:string}} [range] trading-day keys, inclusive
   */
  load(range = {}) {
    const { from = '0000-00-00', to = '9999-99-99' } = range
    const out = []
    for (const day of this.days()) {
      // A coarse partition can straddle the range, so filter per bar rather
      // than per file.
      for (const c of this.readDay(day)) {
        const key = futuresDayKey(c.t)
        if (key < from || key > to) continue
        out.push(c)
      }
    }
    out.sort((a, b) => a.t - b.t)
    return out
  }

  /** What the store currently holds. */
  coverage() {
    const days = this.days()
    if (!days.length) return { days: 0, bars: 0, first: null, last: null, byDay: [] }
    const byDay = days.map((d) => ({ day: d, bars: this.readDay(d).length }))
    const all = this.load()
    return {
      // `days` counts partitions; for a minute store that is trading days.
      days: days.length,
      partitions: days.length,
      bars: byDay.reduce((a, d) => a + d.bars, 0),
      first: all.length ? futuresDayKey(all[0].t) : days[0],
      last: all.length ? futuresDayKey(all.at(-1).t) : days.at(-1),
      byDay,
    }
  }
}

function serialise(candles) {
  const rows = ['time,open,high,low,close,volume']
  for (const c of candles) {
    rows.push(`${new Date(c.t).toISOString()},${c.o},${c.h},${c.l},${c.c},${c.v}`)
  }
  return rows.join('\n') + '\n'
}
