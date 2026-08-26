/**
 * Per-price-level footprint — the "ladder".
 *
 * `footprint.js` folds a day of trades into buy/sell volume PER MINUTE. That is
 * enough for delta and CVD, and it is what the existing store holds. It is not
 * enough for an imbalance test, because an imbalance is a statement about two
 * adjacent PRICE LEVELS inside a single bar, and a per-minute aggregate has
 * already summed that structure away.
 *
 * Measured consequence: asked for levels showing a 400% imbalance across the
 * 65-day per-minute store, the answer was n=0 at >=3x and n=0 at >=4x — not
 * "rare", but inexpressible. This module is what makes the question askable.
 *
 * ── Aggressor side, restated because getting it backwards is silent ─────────
 * Databento's `side` is the side of the AGGRESSOR (see footprint.js, where the
 * convention was checked against the tape rather than assumed — bucketing one
 * day of NQ by minute and correlating (B - A) with the minute's price change
 * gives +0.70).
 *
 *   'B' buy aggressor  — lifted the offer  -> counts as ASK volume at that price
 *   'A' sell aggressor — hit the bid       -> counts as BID volume at that price
 *
 * Note the inversion in the naming: aggressive BUYING prints on the ASK side of
 * the ladder. That is the convention every footprint platform uses, and it is
 * the opposite of what the letters suggest.
 *
 * ── Why prices are keyed as integer ticks ───────────────────────────────────
 * A diagonal imbalance compares level P against level P-1 tick, so levels must
 * compare exactly. Keying a map by a float price makes 29835.25 and 29835.2499
 * different levels and the diagonal silently finds nothing. Everything here is
 * keyed by `Math.round(price / tickSize)` and converted back only on output.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { futuresDayKey } from '../core/sessions.js'
import { BUY_AGGRESSOR, SELL_AGGRESSOR } from './footprint.js'

/** Default NQ/MNQ tick. */
export const NQ_TICK = 0.25

/**
 * Fold a trades CSV into per-interval, per-price-level bid/ask volume.
 *
 * Parsed line by line rather than through a CSV library for the same reason
 * `aggregateTradesToFootprint` is: a day of NQ is ~415,000 rows.
 *
 * @param {string} text raw CSV from the trades schema
 * @param {{intervalSeconds?:number, tickSize?:number}} [opts]
 * @returns {{t:number, tickSize:number, levels:{tick:number, price:number, bidVolume:number, askVolume:number}[]}[]}
 *   one entry per interval that traded, levels ascending by price
 */
export function aggregateTradesToLadder(text, { intervalSeconds = 60, tickSize = NQ_TICK } = {}) {
  const lines = text.split('\n')
  if (lines.length < 2) return []

  const header = lines[0].split(',')
  const iTs = header.indexOf('ts_event')
  const iSide = header.indexOf('side')
  const iSize = header.indexOf('size')
  const iPrice = header.indexOf('price')
  if (iTs < 0 || iSide < 0 || iSize < 0 || iPrice < 0) {
    throw new Error(`Unexpected trades CSV header: ${lines[0].slice(0, 140)}`)
  }

  const step = intervalSeconds * 1000
  /** @type {Map<number, Map<number, {bidVolume:number, askVolume:number}>>} */
  const buckets = new Map()

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    const f = line.split(',')
    const side = f[iSide]
    if (side !== BUY_AGGRESSOR && side !== SELL_AGGRESSOR) continue   // 'N' = none, skip
    const size = Number(f[iSize])
    const price = Number(f[iPrice])
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(price)) continue
    const ts = Date.parse(f[iTs])
    if (!Number.isFinite(ts)) continue

    const t = Math.floor(ts / step) * step
    const tick = Math.round(price / tickSize)
    let levels = buckets.get(t)
    if (!levels) { levels = new Map(); buckets.set(t, levels) }
    let cell = levels.get(tick)
    if (!cell) { cell = { bidVolume: 0, askVolume: 0 }; levels.set(tick, cell) }
    if (side === BUY_AGGRESSOR) cell.askVolume += size
    else cell.bidVolume += size
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, levels]) => ({
      t,
      tickSize,
      levels: [...levels.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([tick, v]) => ({ tick, price: tick * tickSize, bidVolume: v.bidVolume, askVolume: v.askVolume })),
    }))
}

/**
 * Diagonal bid/ask imbalances within one bar's ladder.
 *
 * The diagonal, not the horizontal, because a resting order at price P is hit
 * by an aggressor at P while the offer one tick up is lifted at P+1: the two
 * sides of the same decision sit on a diagonal, not across from each other.
 *
 *   buy  imbalance at P:  ask[P]  >= factor * bid[P - 1 tick]
 *   sell imbalance at P:  bid[P]  >= factor * ask[P + 1 tick]
 *
 * Two guards, both learned from the test suite rather than assumed:
 *
 * `requireNeighbour` (default true) skips a level whose diagonal comparand did
 * not trade at all. Without it the outermost level of EVERY bar flags, because
 * nothing trades below the low or above the high, so the comparand is missing
 * and any print beats it. That is not an imbalance, it is the edge of the bar —
 * and it would fire hardest exactly where this gets read, at the extremes. A
 * level that traded with zero volume on the relevant side is a real unbounded
 * imbalance; a level that never traded is no information.
 *
 * `minVolume` then guards the genuinely thin levels that remain.
 *
 * @param {{levels:{tick:number, price:number, bidVolume:number, askVolume:number}[]}} bar
 * @param {{factor?:number, minVolume?:number, requireNeighbour?:boolean}} [opts]
 *   factor 4 == the 400% threshold
 * @returns {{buy:{tick:number, price:number, ratio:number|null, volume:number}[],
 *            sell:{tick:number, price:number, ratio:number|null, volume:number}[]}}
 *   `ratio` is null where the comparand was zero (an unbounded imbalance).
 */
export function diagonalImbalances(bar, { factor = 4, minVolume = 1, requireNeighbour = true } = {}) {
  const byTick = new Map(bar.levels.map((l) => [l.tick, l]))
  const buy = []
  const sell = []
  for (const l of bar.levels) {
    const below = byTick.get(l.tick - 1)
    const above = byTick.get(l.tick + 1)
    if (requireNeighbour && !below && !above) continue
    const bidBelow = below ? below.bidVolume : 0
    const askAbove = above ? above.askVolume : 0

    if ((below || !requireNeighbour) && l.askVolume >= minVolume && l.askVolume >= factor * bidBelow) {
      buy.push({ tick: l.tick, price: l.price, ratio: bidBelow > 0 ? l.askVolume / bidBelow : null, volume: l.askVolume })
    }
    if ((above || !requireNeighbour) && l.bidVolume >= minVolume && l.bidVolume >= factor * askAbove) {
      sell.push({ tick: l.tick, price: l.price, ratio: askAbove > 0 ? l.bidVolume / askAbove : null, volume: l.bidVolume })
    }
  }
  return { buy, sell }
}

/**
 * Where a bar's imbalances sit within its own range.
 *
 * This is the measurement the playbook actually needs: Kmer's step 1 is not
 * "there was selling", it is selling concentrated at the LOW extreme that then
 * fails to produce downside. `sellAtLow` / `buyAtHigh` are the fractions of
 * imbalanced volume falling in the bottom / top `zone` of the ladder's range.
 *
 * Returns nulls rather than zeros for an empty side, so "no imbalances" is
 * distinguishable from "imbalances, none at the extreme".
 *
 * @param {{levels:{tick:number}[]}} bar
 * @param {{factor?:number, minVolume?:number, zone?:number}} [opts]
 */
export function imbalanceProfile(bar, { factor = 4, minVolume = 1, zone = 0.25, requireNeighbour = true } = {}) {
  const { buy, sell } = diagonalImbalances(bar, { factor, minVolume, requireNeighbour })
  const ticks = bar.levels.map((l) => l.tick)
  const lo = Math.min(...ticks)
  const hi = Math.max(...ticks)
  const span = hi - lo
  // A one-level bar has no interior; position is undefined rather than 0 or 1.
  const posOf = (t) => (span > 0 ? (t - lo) / span : null)

  const share = (list, pick) => {
    if (!list.length || span <= 0) return null
    const total = list.reduce((a, x) => a + x.volume, 0)
    if (total <= 0) return null
    const inZone = list.filter((x) => pick(posOf(x.tick))).reduce((a, x) => a + x.volume, 0)
    return inZone / total
  }

  return {
    buyCount: buy.length,
    sellCount: sell.length,
    sellAtLow: share(sell, (p) => p !== null && p <= zone),
    buyAtHigh: share(buy, (p) => p !== null && p >= 1 - zone),
    lowTick: lo,
    highTick: hi,
  }
}

/* ── persistence ─────────────────────────────────────────────────────────── */

/** Long-form CSV: one row per (interval, price level). */
export function serialiseLadder(bars) {
  const out = ['time,price,bidVolume,askVolume']
  for (const b of bars) {
    const iso = new Date(b.t).toISOString()
    for (const l of b.levels) out.push(`${iso},${l.price},${l.bidVolume},${l.askVolume}`)
  }
  return out.join('\n') + '\n'
}

export function parseLadder(text, { tickSize = NQ_TICK } = {}) {
  const byTime = new Map()
  for (const line of text.split('\n').slice(1)) {
    if (!line.trim()) continue
    const [iso, price, bid, ask] = line.split(',')
    const t = Date.parse(iso)
    if (!byTime.has(t)) byTime.set(t, [])
    byTime.get(t).push({
      tick: Math.round(Number(price) / tickSize), price: Number(price),
      bidVolume: Number(bid), askVolume: Number(ask),
    })
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0])
    .map(([t, levels]) => ({ t, tickSize, levels: levels.sort((a, b) => a.tick - b.tick) }))
}

/** Day-partitioned ladder store, mirroring FootprintStore's layout. */
export class LadderStore {
  constructor(root, symbol) {
    this.dir = join(root, `${symbol.replace(/[^A-Za-z0-9]/g, '_')}@ladder`)
  }

  days() {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir).filter((f) => f.endsWith('.csv')).map((f) => f.slice(0, -4)).sort()
  }

  readDay(day, opts = {}) {
    const path = join(this.dir, `${day}.csv`)
    return existsSync(path) ? parseLadder(readFileSync(path, 'utf8'), opts) : []
  }

  /** Idempotent, like the candle and footprint stores: keyed on (t, tick). */
  merge(bars) {
    if (!bars.length) return { added: 0, days: [] }
    mkdirSync(this.dir, { recursive: true })
    const byDay = new Map()
    for (const b of bars) {
      const day = futuresDayKey(b.t)
      if (!byDay.has(day)) byDay.set(day, [])
      byDay.get(day).push(b)
    }
    let added = 0
    const touched = []
    for (const [day, incoming] of byDay) {
      const merged = new Map()
      for (const b of this.readDay(day)) for (const l of b.levels) merged.set(`${b.t}:${l.tick}`, { t: b.t, ...l })
      for (const b of incoming) {
        for (const l of b.levels) {
          const k = `${b.t}:${l.tick}`
          if (!merged.has(k)) added++
          merged.set(k, { t: b.t, ...l })
        }
      }
      const rows = [...merged.values()].sort((a, b) => a.t - b.t || a.tick - b.tick)
      const grouped = []
      for (const r of rows) {
        if (!grouped.length || grouped.at(-1).t !== r.t) grouped.push({ t: r.t, tickSize: NQ_TICK, levels: [] })
        grouped.at(-1).levels.push({ tick: r.tick, price: r.price, bidVolume: r.bidVolume, askVolume: r.askVolume })
      }
      writeFileSync(join(this.dir, `${day}.csv`), serialiseLadder(grouped))
      touched.push(day)
    }
    return { added, days: touched.sort() }
  }
}
