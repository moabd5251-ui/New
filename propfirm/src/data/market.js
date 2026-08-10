/**
 * The multi-timeframe market model.
 *
 * The system reads four timeframes at once and the split is deliberate:
 *
 *   macro     (1d / 4h) — context. Trend, cycle position, draw on liquidity.
 *   secondary (1h / 15m) — confirmation. Does the pullback structure agree?
 *   micro     (1m / 30s) — the trigger and the orderflow.
 *
 * "The higher timeframe has the strength of the movement, but every change
 * happens in the lower timeframes." Analysing one in isolation is the time sink
 * the system exists to remove.
 *
 * Everything here is derived once from a single base series, then queried
 * AS OF a given base-bar index. The as-of discipline is what keeps a backtest
 * honest: a swing pivot is not knowable until its confirmation bars have
 * printed, a higher-timeframe bar is not readable until it has closed, and a
 * liquidity pool is not "swept" until the sweep happens.
 */

import { aggregate, alignIndex, parseTimeframe, atr, volumeBaseline } from '../core/candles.js'
import { analyzeStructure, apexLevels } from '../core/structure.js'
import { mapLiquidity, drawOnLiquidity, premiumDiscount, liquidityCycle } from '../core/liquidity.js'
import { findFVGs, resolveFVGs, invertedFVGs, detectCISD, detectBreakAndRetest, displacement } from '../core/patterns.js'
import { BarOrderflow } from '../core/orderflow.js'

const DEFAULT_TIMEFRAMES = {
  context: '1d',
  macro: '4h',
  secondary: '15m',
  trend: '1h',
  micro: null, // the base series itself
}

export class Market {
  /**
   * @param {import('../core/candles.js').Candle[]} base base series (1m or 30s)
   * @param {{timeframes?:object, instrument?:object, swingLeft?:number, swingRight?:number,
   *          orderflow?:import('../core/orderflow.js').BarOrderflow}} [opts]
   */
  constructor(base, opts = {}) {
    if (!base?.length) throw new Error('Market requires a non-empty base series')
    this.base = base
    this.opts = opts
    this.instrument = opts.instrument ?? { tickSize: 0.25, tickValue: 5, symbol: 'NQ' }
    this.timeframes = { ...DEFAULT_TIMEFRAMES, ...(opts.timeframes ?? {}) }
    this.views = new Map()

    // Higher timeframes may be supplied directly instead of aggregated from
    // the base series. This matters more than it sounds: aggregating a daily
    // view out of a 7-day 1-minute window gives six daily bars and no swings
    // at all, so step 1 can never form a bias and the whole system is mute.
    // Providers that cap intraday history but serve years of hourly and daily
    // data can fill those views properly — see `opts.series`.
    const provided = opts.series ?? {}
    this.injected = []

    for (const [name, spec] of Object.entries(this.timeframes)) {
      let candles
      let seconds
      if (provided[name]?.length) {
        candles = provided[name]
        seconds = inferBaseSeconds(candles)
        this.injected.push(name)
      } else if (spec === null) {
        candles = base
        seconds = inferBaseSeconds(base)
      } else {
        candles = aggregate(base, spec)
        seconds = parseTimeframe(spec)
      }
      this.views.set(name, this.#buildView(name, candles, seconds))
    }

    this.orderflow = opts.orderflow ?? new BarOrderflow(base, { binSize: opts.profileBinSize ?? 1 })
  }

  #buildView(name, candles, seconds) {
    // Higher timeframes need looser swing settings; the micro series needs to
    // react fast or the trigger is always late.
    const isMicro = seconds <= 300
    const swing = {
      left: this.opts.swingLeft ?? (isMicro ? 2 : 3),
      right: this.opts.swingRight ?? (isMicro ? 2 : 3),
    }
    const structure = analyzeStructure(candles, swing)
    const gaps = resolveFVGs(candles, findFVGs(candles))
    const atrs = atr(candles, 14)

    // How close two highs must be to count as the same level.
    //
    // This has to be volatility-relative, not tick-relative. A tick-scaled
    // tolerance is really a tolerance tuned to whichever instrument it was
    // written for: 2.0 points on NQ is about 0.4 of a 1-minute bar's range,
    // but the same 8 ticks on QQQ is 1.25 bars — loose enough to merge levels
    // that have nothing to do with each other. Expressing it as a fraction of
    // ATR makes the same code correct on futures and on shares.
    const typicalAtr = median(atrs.filter(Number.isFinite))
    const tolerance = Math.max(this.instrument.tickSize * 2, typicalAtr * 0.4)
    const pools = mapLiquidity(candles, structure.swings, { tolerance })
    const apex = apexLevels(candles, structure.swings, { tolerance })

    const view = {
      name,
      seconds,
      candles,
      structure,
      gaps,
      inverted: invertedFVGs(candles, gaps),
      cisd: detectCISD(candles),
      breakRetest: detectBreakAndRetest(candles, apex, { tolerance }),
      displacement: displacement(candles),
      pools,
      apex,
      tolerance,
      atr: atrs,
      volBase: volumeBaseline(candles, 20),
      swing,
      align: candles === this.base ? null : alignIndex(this.base, candles, seconds),
    }

    // Sorted indexes for the as-of accessors.
    //
    // Every query below used to filter a whole array. That is invisible on a
    // week of data and ruinous on two years: the micro view holds 158k swings
    // and 89k break-and-retest events, and re-scanning those for each of 704k
    // bars is on the order of 10^11 operations. Sorting once and binary
    // searching per query turns each lookup into a handful of comparisons.
    //
    // A swing is only knowable `right` bars after it forms, so the index is
    // built on that availability, not on the pivot's own index.
    const avail = (sw) => sw.index + swing.right
    view.highsByAvail = structure.swings.filter((x) => x.type === 'high').sort((a, b) => avail(a) - avail(b))
    view.lowsByAvail = structure.swings.filter((x) => x.type === 'low').sort((a, b) => avail(a) - avail(b))
    view.swingsByAvail = [...structure.swings].sort((a, b) => avail(a) - avail(b))
    view.availOf = avail

    view.poolsByPrice = [...pools].sort((a, b) => a.price - b.price)
    view.sweptPools = pools.filter((p) => p.swept && p.sweptIndex !== null).sort((a, b) => a.sweptIndex - b.sweptIndex)

    return view
  }

  /** @returns {object} the raw view for a timeframe name. */
  view(name) {
    const v = this.views.get(name)
    if (!v) throw new Error(`Unknown timeframe view: ${name}`)
    return v
  }

  /**
   * Index into `view(name).candles` of the last bar CLOSED at or before base
   * bar `i`. -1 when nothing has closed yet.
   */
  indexAt(name, i) {
    const v = this.view(name)
    if (!v.align) return i
    return v.align[i]
  }

  /** The last closed candle of `name` as of base bar `i`. */
  candleAt(name, i) {
    const v = this.view(name)
    const k = this.indexAt(name, i)
    return k >= 0 ? v.candles[k] : null
  }

  /**
   * Swings that were actually knowable at base bar `i` — a pivot needs its
   * right-hand confirmation bars before it exists.
   *
   * `limit` bounds the slice to the most recent N, which is all any caller
   * actually reads; returning 158k swings per bar is what made this slow.
   */
  swingsAt(name, i, { limit = Infinity } = {}) {
    const v = this.view(name)
    const k = this.indexAt(name, i)
    if (k < 0) return []
    const end = countAtMost(v.swingsByAvail, k, v.availOf)
    const from = Number.isFinite(limit) ? Math.max(0, end - limit) : 0
    return v.swingsByAvail.slice(from, end)
  }

  /** Trend as of base bar `i`, recomputed from knowable swings only. */
  trendAt(name, i) {
    const v = this.view(name)
    const k = this.indexAt(name, i)
    if (k < 0) return { trend: 'range', highs: [], lows: [] }

    const hEnd = countAtMost(v.highsByAvail, k, v.availOf)
    const lEnd = countAtMost(v.lowsByAvail, k, v.availOf)
    if (hEnd < 2 || lEnd < 2) return { trend: 'range', highs: [], lows: [] }

    const h1 = v.highsByAvail[hEnd - 1]
    const h0 = v.highsByAvail[hEnd - 2]
    const l1 = v.lowsByAvail[lEnd - 1]
    const l0 = v.lowsByAvail[lEnd - 2]

    const risingHighs = h1.price > h0.price
    const risingLows = l1.price > l0.price
    let trend = 'range'
    if (risingHighs && risingLows) trend = 'up'
    else if (!risingHighs && !risingLows) trend = 'down'
    return { trend, highs: [h0, h1], lows: [l0, l1], lastHigh: h1, lastLow: l1 }
  }

  /** The working dealing range as of base bar `i`. */
  rangeAt(name, i) {
    const { lastHigh, lastLow } = this.trendAt(name, i)
    if (!lastHigh || !lastLow) return null
    const high = Math.max(lastHigh.price, lastLow.price)
    const low = Math.min(lastHigh.price, lastLow.price)
    return { high, low, equilibrium: (high + low) / 2, direction: lastHigh.index > lastLow.index ? 'up' : 'down' }
  }

  /** Structure breaks that had already happened by base bar `i`. */
  breaksAt(name, i, { limit = 200 } = {}) {
    const v = this.view(name)
    const k = this.indexAt(name, i)
    if (k < 0) return []
    const end = countAtMost(v.structure.breaks, k, (b) => b.index)
    return v.structure.breaks.slice(Math.max(0, end - limit), end)
  }

  /**
   * Liquidity pools with sweep state resolved as of base bar `i` — a pool swept
   * in the future must read as unswept now.
   */
  poolsAt(name, i) {
    const v = this.view(name)
    const k = this.indexAt(name, i)
    if (k < 0) return []
    return v.pools
      .filter((p) => p.formedIndex <= k)
      .map((p) => ({
        ...p,
        swept: p.swept && p.sweptIndex !== null && p.sweptIndex <= k,
        sweptIndex: p.swept && p.sweptIndex <= k ? p.sweptIndex : null,
        reclaimed: p.reclaimed && p.reclaimIndex !== undefined && p.reclaimIndex <= k,
      }))
  }

  /**
   * Next liquidity target in `direction`, as of base bar `i`.
   *
   * Walks outward from the current price through the price-sorted pool list
   * rather than filtering every pool, and stops as soon as it has enough
   * candidates to rank.
   */
  drawAt(name, i, direction, { scan = 40 } = {}) {
    const v = this.view(name)
    const k = this.indexAt(name, i)
    if (k < 0) return null
    const price = this.base[i].c
    const list = v.poolsByPrice
    if (!list.length) return null

    const up = direction === 'up'
    const side = up ? 'buyside' : 'sellside'
    let idx = lowerBoundBy(list, price, (p) => p.price)
    const candidates = []
    const step = up ? 1 : -1
    if (!up) idx -= 1

    for (let n = 0; n < scan && idx >= 0 && idx < list.length; idx += step) {
      const p = list[idx]
      if (p.formedIndex > k) continue
      if (p.side !== side) continue
      if (up ? p.price <= price : p.price >= price) continue
      const swept = p.swept && p.sweptIndex !== null && p.sweptIndex <= k
      if (swept) continue
      candidates.push({ ...p, swept: false, distance: Math.abs(p.price - price) })
      n++
    }
    if (!candidates.length) return null
    const strength = (p) =>
      p.touches * 2 + (p.origin.startsWith('prev-day') ? 3 : 0) + (p.origin.startsWith('equal') ? 2 : 0)
    candidates.sort((a, b) => a.distance - b.distance || strength(b) - strength(a))
    return candidates[0]
  }

  /**
   * Unswept pools between `price` and the direction of travel — the obstacles a
   * target has to clear.
   */
  poolsAhead(name, i, price, direction, { limit = 8 } = {}) {
    const v = this.view(name)
    const k = this.indexAt(name, i)
    if (k < 0) return []
    const list = v.poolsByPrice
    const up = direction === 'up'
    let idx = lowerBoundBy(list, price, (p) => p.price)
    const out = []
    const step = up ? 1 : -1
    if (!up) idx -= 1
    while (out.length < limit && idx >= 0 && idx < list.length) {
      const p = list[idx]
      idx += step
      if (p.formedIndex > k) continue
      if (p.swept && p.sweptIndex !== null && p.sweptIndex <= k) continue
      if (up ? p.price <= price : p.price >= price) continue
      out.push(p)
    }
    return out
  }

  /** Was a pool on `side` swept in the window ending at HTF index `k`? */
  sweptRecently(name, i, side, withinBars) {
    const v = this.view(name)
    const k = this.indexAt(name, i)
    if (k < 0) return false
    const end = countAtMost(v.sweptPools, k, (p) => p.sweptIndex)
    for (let x = end - 1; x >= 0; x--) {
      const p = v.sweptPools[x]
      if (k - p.sweptIndex > withinBars) break
      if (p.side === side) return true
    }
    return false
  }

  /** Premium / discount / OTE read for base bar `i` against `name`'s range. */
  premiumDiscountAt(name, i) {
    const r = this.rangeAt(name, i)
    if (!r) return null
    return premiumDiscount(this.base[i].c, r, r.direction)
  }

  /**
   * Where we are in the external → internal liquidity cycle.
   *
   * Takes the most recent sweeps directly instead of copying the candle history
   * and re-filtering every pool — that slice alone was an O(n) allocation on
   * every single bar.
   */
  cycleAt(name, i, { lookback = 60 } = {}) {
    const v = this.view(name)
    const k = this.indexAt(name, i)
    if (k < 0) return { state: 'undefined', note: 'no closed bar yet', sweptPool: null }

    const end = countAtMost(v.sweptPools, k, (p) => p.sweptIndex)
    let fresh = null
    for (let x = end - 1; x >= 0; x--) {
      const p = v.sweptPools[x]
      if (k - p.sweptIndex > lookback) break
      fresh = p
      break
    }

    if (fresh) {
      const reclaimed = fresh.reclaimed && fresh.reclaimIndex !== undefined && fresh.reclaimIndex <= k
      if (reclaimed) {
        return {
          state: 'swept-erl-expect-pullback',
          note: `${fresh.origin} at ${fresh.price.toFixed(2)} swept and reclaimed — external liquidity taken, expect rotation toward internal range`,
          sweptPool: fresh,
        }
      }
      return {
        state: 'seeking-erl',
        note: `${fresh.origin} at ${fresh.price.toFixed(2)} taken and held — expansion continuing toward the next external pool`,
        sweptPool: fresh,
      }
    }

    const rangeInfo = this.rangeAt(name, i)
    if (rangeInfo) {
      const pd = premiumDiscount(v.candles[k].c, rangeInfo, rangeInfo.direction)
      if (Math.abs(pd.ratio - 0.5) < 0.15) {
        return { state: 'rebalancing-irl', note: 'price at equilibrium of the range — rebalancing internal liquidity', sweptPool: null }
      }
    }
    return { state: 'seeking-erl', note: 'no recent sweep — price working toward external liquidity', sweptPool: null }
  }

  /**
   * Pattern events of one kind that fired at or before base bar `i`.
   *
   * Event lists are already in index order, so the window is found by binary
   * search and walked backwards — the micro view holds ~89k break-and-retest
   * events and filtering all of them per bar was the single worst hot spot.
   */
  eventsAt(name, kind, i, { withinBars = Infinity } = {}) {
    const v = this.view(name)
    const k = this.indexAt(name, i)
    if (k < 0) return []
    const list = v[kind] ?? []
    if (!list.length) return []
    const end = countAtMost(list, k, (e) => e.index)
    if (!Number.isFinite(withinBars)) return list.slice(0, end)
    let from = end
    while (from > 0 && k - list[from - 1].index <= withinBars) from--
    return list.slice(from, end)
  }
}

/** Number of leading entries whose key is <= `value`, on a key-sorted array. */
function countAtMost(arr, value, key) {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (key(arr[mid]) <= value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** First index whose key is >= `value`, on a key-sorted array. */
function lowerBoundBy(arr, value, key) {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (key(arr[mid]) < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

function median(xs) {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function inferBaseSeconds(base) {
  if (base.length < 2) return 60
  // Modal gap, so a session break or a data hole doesn't skew the estimate.
  const counts = new Map()
  for (let i = 1; i < Math.min(base.length, 200); i++) {
    const d = (base[i].t - base[i - 1].t) / 1000
    counts.set(d, (counts.get(d) ?? 0) + 1)
  }
  let best = 60
  let bestN = 0
  for (const [d, n] of counts) {
    if (n > bestN) {
      bestN = n
      best = d
    }
  }
  return best
}
