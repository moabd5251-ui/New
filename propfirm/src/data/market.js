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

    for (const [name, spec] of Object.entries(this.timeframes)) {
      const candles = spec === null ? base : aggregate(base, spec)
      const seconds = spec === null ? inferBaseSeconds(base) : parseTimeframe(spec)
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

    return {
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
   */
  swingsAt(name, i) {
    const v = this.view(name)
    const k = this.indexAt(name, i)
    if (k < 0) return []
    return v.structure.swings.filter((s) => s.index + v.swing.right <= k)
  }

  /** Trend as of base bar `i`, recomputed from knowable swings only. */
  trendAt(name, i) {
    const swings = this.swingsAt(name, i)
    const highs = swings.filter((s) => s.type === 'high')
    const lows = swings.filter((s) => s.type === 'low')
    if (highs.length < 2 || lows.length < 2) return { trend: 'range', highs, lows }
    const risingHighs = highs.at(-1).price > highs.at(-2).price
    const risingLows = lows.at(-1).price > lows.at(-2).price
    let trend = 'range'
    if (risingHighs && risingLows) trend = 'up'
    else if (!risingHighs && !risingLows) trend = 'down'
    return { trend, highs, lows, lastHigh: highs.at(-1), lastLow: lows.at(-1) }
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
  breaksAt(name, i) {
    const v = this.view(name)
    const k = this.indexAt(name, i)
    if (k < 0) return []
    return v.structure.breaks.filter((b) => b.index <= k)
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

  /** Next liquidity target in `direction`, as of base bar `i`. */
  drawAt(name, i, direction) {
    const price = this.base[i].c
    return drawOnLiquidity(this.poolsAt(name, i), price, direction)
  }

  /** Premium / discount / OTE read for base bar `i` against `name`'s range. */
  premiumDiscountAt(name, i) {
    const r = this.rangeAt(name, i)
    if (!r) return null
    return premiumDiscount(this.base[i].c, r, r.direction)
  }

  /** Where we are in the external → internal liquidity cycle. */
  cycleAt(name, i) {
    const v = this.view(name)
    const k = this.indexAt(name, i)
    if (k < 0) return { state: 'undefined', note: 'no closed bar yet', sweptPool: null }
    return liquidityCycle(v.candles.slice(0, k + 1), this.poolsAt(name, i), this.rangeAt(name, i))
  }

  /** Pattern events of one kind that fired at or before base bar `i`. */
  eventsAt(name, kind, i, { withinBars = Infinity } = {}) {
    const v = this.view(name)
    const k = this.indexAt(name, i)
    if (k < 0) return []
    const list = v[kind] ?? []
    return list.filter((e) => e.index <= k && k - e.index <= withinBars)
  }
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
