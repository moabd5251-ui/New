/**
 * Liquidity: where the stops are, whether they have been taken, and what price
 * is therefore reaching for next.
 *
 * The cycle the whole system is built on: price runs external range liquidity
 * (the stops beyond a high or low), then retraces to internal range liquidity
 * (an imbalance, or the 50% equilibrium of the range where supply and demand
 * are at fair value), then continues — until structure changes.
 *
 * Knowing WHERE in that cycle price sits is what turns "there is a high above"
 * into "a pullback is likely, so I want to be looking for sells".
 */

import { futuresDayKey, sessionBuckets } from './sessions.js'

/**
 * @typedef {Object} LiquidityPool
 * @property {'buyside'|'sellside'} side  buyside sits above highs, sellside below lows
 * @property {number} price
 * @property {number} touches      how many swings formed the pool (equal highs = stronger)
 * @property {number[]} indices
 * @property {number} formedIndex  bar at which the pool became visible
 * @property {string} origin       'equal-highs' | 'swing' | 'session-high' | 'prev-day-high' | …
 * @property {boolean} swept
 * @property {number|null} sweptIndex
 * @property {boolean} reclaimed   swept and price closed back inside — a failed break
 */

/**
 * Cluster swing highs/lows into pools. Two or more swings within `tolerance`
 * are "relative equal highs/lows" — the resting-stop clusters that price is
 * most strongly drawn to.
 *
 * @param {import('./candles.js').Candle[]} candles
 * @param {import('./structure.js').Swing[]} swings
 */
export function poolsFromSwings(candles, swings, { tolerance = 5 } = {}) {
  const build = (type, side) => {
    const list = swings.filter((s) => s.type === type)
    const clusters = []
    // Bucket by price so finding the cluster a swing belongs to is a couple of
    // map lookups rather than a scan of every cluster found so far. On a
    // two-year 1-minute series that difference is minutes versus hours.
    const buckets = new Map()
    const bucketOf = (price) => Math.floor(price / Math.max(tolerance, 1e-9))
    const findNear = (price) => {
      const b = bucketOf(price)
      for (const key of [b - 1, b, b + 1]) {
        const list = buckets.get(key)
        if (!list) continue
        for (const cl of list) if (Math.abs(cl.price - price) <= tolerance) return cl
      }
      return null
    }
    const index = (cl) => {
      const b = bucketOf(cl.price)
      if (!buckets.has(b)) buckets.set(b, [])
      buckets.get(b).push(cl)
    }

    for (const s of list) {
      const hit = findNear(s.price)
      if (hit) {
        const oldBucket = bucketOf(hit.price)
        hit.indices.push(s.index)
        hit.touches++
        // Anchor the pool at the extreme of the cluster: stops rest beyond the
        // furthest wick, not at the average.
        hit.price = side === 'buyside' ? Math.max(hit.price, s.price) : Math.min(hit.price, s.price)
        hit.formedIndex = Math.max(hit.formedIndex, s.index)
        // Re-index if the anchor moved into a different bucket.
        if (bucketOf(hit.price) !== oldBucket) {
          const prev = buckets.get(oldBucket)
          if (prev) {
            const at = prev.indexOf(hit)
            if (at >= 0) prev.splice(at, 1)
          }
          index(hit)
        }
      } else {
        clusters.push({
          side,
          price: s.price,
          touches: 1,
          indices: [s.index],
          formedIndex: s.index,
          origin: 'swing',
          swept: false,
          sweptIndex: null,
          reclaimed: false,
        })
        index(clusters[clusters.length - 1])
      }
    }
    for (const cl of clusters) if (cl.touches >= 2) cl.origin = side === 'buyside' ? 'equal-highs' : 'equal-lows'
    return clusters
  }
  return [...build('high', 'buyside'), ...build('low', 'sellside')]
}

/**
 * Session and previous-day levels. These are the pools that exist regardless of
 * swing geometry — the previous day's high/low, and each session's extremes.
 */
export function sessionPools(candles) {
  const buckets = sessionBuckets(candles)
  const pools = []
  for (const b of buckets) {
    const base = {
      touches: 1,
      swept: false,
      sweptIndex: null,
      reclaimed: false,
      formedIndex: b.endIndex,
      indices: [b.endIndex],
      session: b.session,
      day: b.day,
    }
    pools.push({ ...base, side: 'buyside', price: b.high, origin: `${b.session}-high` })
    pools.push({ ...base, side: 'sellside', price: b.low, origin: `${b.session}-low` })
  }

  // Previous trading day's high/low — the single most respected pair of levels
  // on NQ intraday.
  const days = new Map()
  candles.forEach((c, i) => {
    const k = futuresDayKey(c.t)
    const d = days.get(k) ?? { high: -Infinity, low: Infinity, endIndex: i }
    d.high = Math.max(d.high, c.h)
    d.low = Math.min(d.low, c.l)
    d.endIndex = i
    days.set(k, d)
  })
  const dayList = [...days.entries()]
  for (let i = 0; i < dayList.length - 1; i++) {
    const [, d] = dayList[i]
    const base = {
      touches: 1,
      swept: false,
      sweptIndex: null,
      reclaimed: false,
      formedIndex: d.endIndex,
      indices: [d.endIndex],
    }
    pools.push({ ...base, side: 'buyside', price: d.high, origin: 'prev-day-high' })
    pools.push({ ...base, side: 'sellside', price: d.low, origin: 'prev-day-low' })
  }
  return pools
}

/**
 * Mark pools as swept, and note whether price reclaimed the level afterwards.
 *
 * The distinction matters more than the sweep itself. A sweep that closes back
 * inside is a failed break — that is the setup. A sweep that closes beyond and
 * holds is continuation — the pool simply stops being resistance. Assuming
 * every liquidity grab reverses is the mistake the source material calls out
 * explicitly: sometimes price displaces the liquidity and keeps going.
 *
 * @param {import('./candles.js').Candle[]} candles
 * @param {LiquidityPool[]} pools mutated in place
 */
export function markSweeps(candles, pools, { reclaimBars = 3, tolerance = 0.5 } = {}) {
  // One forward pass over the bars, with each side's unswept pools in a heap
  // ordered by how close they are to being taken. Scanning forward separately
  // for every pool is quadratic, which is invisible on a week of data and fatal
  // on two years of it.
  const pending = new Map()
  for (const pool of pools) {
    const at = pool.formedIndex
    if (!pending.has(at)) pending.set(at, [])
    pending.get(at).push(pool)
  }

  // Buyside pools are taken by a HIGH, so the lowest price goes first.
  const buy = new Heap((a, b) => a.price - b.price)
  // Sellside pools are taken by a LOW, so the highest price goes first.
  const sell = new Heap((a, b) => b.price - a.price)

  const reclaimCheck = (pool, i) => {
    for (let k = i; k < Math.min(candles.length, i + 1 + reclaimBars); k++) {
      const back = pool.side === 'buyside' ? candles[k].c < pool.price : candles[k].c > pool.price
      if (back) {
        pool.reclaimed = true
        pool.reclaimIndex = k
        return
      }
    }
  }

  for (let i = 0; i < candles.length; i++) {
    // A pool is only sweepable from the bar after it formed.
    const born = pending.get(i - 1)
    if (born) for (const p of born) (p.side === 'buyside' ? buy : sell).push(p)

    const c = candles[i]
    while (buy.size && buy.peek().price + tolerance < c.h) {
      const pool = buy.pop()
      pool.swept = true
      pool.sweptIndex = i
      reclaimCheck(pool, i)
    }
    while (sell.size && sell.peek().price - tolerance > c.l) {
      const pool = sell.pop()
      pool.swept = true
      pool.sweptIndex = i
      reclaimCheck(pool, i)
    }
  }
  return pools
}

/** Minimal binary heap; `cmp(a, b) < 0` means `a` comes out first. */
class Heap {
  constructor(cmp) {
    this.cmp = cmp
    this.items = []
  }
  get size() {
    return this.items.length
  }
  peek() {
    return this.items[0]
  }
  push(x) {
    const a = this.items
    a.push(x)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.cmp(a[i], a[p]) >= 0) break
      ;[a[i], a[p]] = [a[p], a[i]]
      i = p
    }
  }
  pop() {
    const a = this.items
    const top = a[0]
    const last = a.pop()
    if (a.length) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let m = i
        if (l < a.length && this.cmp(a[l], a[m]) < 0) m = l
        if (r < a.length && this.cmp(a[r], a[m]) < 0) m = r
        if (m === i) break
        ;[a[i], a[m]] = [a[m], a[i]]
        i = m
      }
    }
    return top
  }
}

/** All pools for a series, swept-state resolved. */
export function mapLiquidity(candles, swings, opts = {}) {
  const pools = [...poolsFromSwings(candles, swings, opts), ...sessionPools(candles)]
  markSweeps(candles, pools, opts)
  return pools.sort((a, b) => b.price - a.price)
}

/**
 * The next pool price is reaching for — the "draw on liquidity".
 *
 * Unswept pools only, nearest first, weighted by strength: equal highs/lows and
 * previous-day levels outrank a lone swing.
 *
 * @param {LiquidityPool[]} pools
 * @param {number} price current price
 * @param {'up'|'down'} direction
 */
export function drawOnLiquidity(pools, price, direction, { maxDistance = Infinity } = {}) {
  const side = direction === 'up' ? 'buyside' : 'sellside'
  const candidates = pools
    .filter((p) => !p.swept && p.side === side)
    .filter((p) => (direction === 'up' ? p.price > price : p.price < price))
    .filter((p) => Math.abs(p.price - price) <= maxDistance)
    .map((p) => ({ ...p, distance: Math.abs(p.price - price) }))

  if (!candidates.length) return null
  const strength = (p) =>
    p.touches * 2 + (p.origin.startsWith('prev-day') ? 3 : 0) + (p.origin.startsWith('equal') ? 2 : 0)
  candidates.sort((a, b) => a.distance - b.distance || strength(b) - strength(a))
  return candidates[0]
}

/**
 * Where price sits inside its dealing range.
 *
 * Below equilibrium is discount (favour buys), above is premium (favour sells).
 * The optimal trade entry band — 0.618 to 0.79 of the retracement — is where
 * the system wants to be filled on a continuation.
 *
 * @param {number} price
 * @param {{high:number, low:number}} rangeInfo
 * @param {'up'|'down'} direction leg direction the range was drawn from
 */
export function premiumDiscount(price, rangeInfo, direction = 'up') {
  const { high, low } = rangeInfo
  const span = high - low
  if (span <= 0) return { ratio: 0.5, zone: 'equilibrium', inOTE: false, equilibrium: high }
  // Ratio measured as retracement depth from the end of the leg.
  const ratio = direction === 'up' ? (price - low) / span : (high - price) / span
  let zone = 'equilibrium'
  if (ratio > 0.55) zone = 'premium'
  else if (ratio < 0.45) zone = 'discount'
  const retracement = 1 - ratio
  return {
    ratio,
    zone,
    equilibrium: low + span * 0.5,
    goldenRatio: direction === 'up' ? high - span * 0.618 : low + span * 0.618,
    // OTE for a continuation entry: a 0.618–0.79 retracement of the impulse.
    inOTE: retracement >= 0.618 && retracement <= 0.79,
    retracement,
  }
}

/**
 * Position in the external → internal liquidity cycle.
 *
 * @returns {{state:'swept-erl-expect-pullback'|'seeking-erl'|'rebalancing-irl'|'undefined',
 *            note:string, sweptPool:LiquidityPool|null}}
 */
export function liquidityCycle(candles, pools, rangeInfo, lookback = 60) {
  const last = candles.length - 1
  if (last < 0) return { state: 'undefined', note: 'no data', sweptPool: null }
  const price = candles[last].c

  const recentSweeps = pools
    .filter((p) => p.swept && p.sweptIndex >= last - lookback)
    .sort((a, b) => b.sweptIndex - a.sweptIndex)

  const fresh = recentSweeps[0] ?? null
  if (fresh && fresh.reclaimed) {
    return {
      state: 'swept-erl-expect-pullback',
      note: `${fresh.origin} at ${fresh.price.toFixed(2)} swept and reclaimed — external liquidity taken, expect rotation toward internal range`,
      sweptPool: fresh,
    }
  }
  if (fresh && !fresh.reclaimed) {
    return {
      state: 'seeking-erl',
      note: `${fresh.origin} at ${fresh.price.toFixed(2)} taken and held — expansion continuing toward the next external pool`,
      sweptPool: fresh,
    }
  }
  if (rangeInfo) {
    const pd = premiumDiscount(price, rangeInfo)
    if (Math.abs(pd.ratio - 0.5) < 0.15) {
      return { state: 'rebalancing-irl', note: 'price at equilibrium of the range — rebalancing internal liquidity', sweptPool: null }
    }
  }
  return { state: 'seeking-erl', note: 'no recent sweep — price working toward external liquidity', sweptPool: null }
}
