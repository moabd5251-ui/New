/**
 * Candle model, multi-timeframe aggregation and the small statistics the rest
 * of the engine leans on (ATR, volume baselines, body/wick geometry).
 *
 * @typedef {Object} Candle
 * @property {number} t  epoch millis of the bar OPEN
 * @property {number} o
 * @property {number} h
 * @property {number} l
 * @property {number} c
 * @property {number} v  contracts traded
 */

import { futuresDayKey } from './sessions.js'

/** Timeframes, in seconds. The system spans 30s micro to daily macro. */
export const TF = {
  S30: 30,
  M1: 60,
  M5: 300,
  M15: 900,
  M30: 1800,
  H1: 3600,
  H4: 14400,
  D1: 86400,
}

export const TF_NAME = {
  30: '30s',
  60: '1m',
  300: '5m',
  900: '15m',
  1800: '30m',
  3600: '1h',
  14400: '4h',
  86400: '1d',
}

/** Parse `"15m"` / `"4h"` / `"30s"` / `"1d"` into seconds. */
export function parseTimeframe(spec) {
  if (typeof spec === 'number') return spec
  const m = /^(\d+)\s*(s|m|h|d)$/i.exec(String(spec).trim())
  if (!m) throw new Error(`Unrecognised timeframe: ${spec}`)
  const n = Number(m[1])
  const unit = m[2].toLowerCase()
  return n * { s: 1, m: 60, h: 3600, d: 86400 }[unit]
}

function emptyBucket(t, c) {
  return { t, o: c.o, h: c.h, l: c.l, c: c.c, v: 0 }
}

/**
 * Aggregate a base series into a higher timeframe.
 *
 * Intraday buckets are aligned to the epoch (so 4h bars break at 00/04/08…
 * UTC, matching what most futures charts show). Daily bars are bucketed by the
 * CME trading day, which starts at 18:00 ET — a daily candle that ignored that
 * boundary would misplace the previous-day high/low the system trades against.
 *
 * @param {Candle[]} candles ascending by time
 * @param {number|string} timeframe seconds, or a spec like "15m"
 * @returns {Candle[]}
 */
export function aggregate(candles, timeframe) {
  const tf = parseTimeframe(timeframe)
  if (!candles.length) return []
  const out = []
  let bucket = null
  let bucketKey = null

  for (const c of candles) {
    const key = tf >= TF.D1 ? futuresDayKey(c.t) : Math.floor(c.t / (tf * 1000))
    if (key !== bucketKey) {
      if (bucket) out.push(bucket)
      const start = tf >= TF.D1 ? c.t : Math.floor(c.t / (tf * 1000)) * tf * 1000
      bucket = emptyBucket(start, c)
      bucketKey = key
    }
    bucket.h = Math.max(bucket.h, c.h)
    bucket.l = Math.min(bucket.l, c.l)
    bucket.c = c.c
    bucket.v += c.v
  }
  if (bucket) out.push(bucket)
  return out
}

/**
 * For every bar of `base`, the index of the last CLOSED higher-timeframe bar.
 *
 * This is what keeps multi-timeframe analysis honest during a backtest: at
 * 09:47 the current 15m bar is still forming, so step 2 may only read the bar
 * that closed at 09:45. Returns -1 where no HTF bar has closed yet.
 *
 * @param {Candle[]} base
 * @param {Candle[]} htf
 * @param {number} htfSeconds
 * @returns {number[]}
 */
export function alignIndex(base, htf, htfSeconds) {
  const out = new Array(base.length).fill(-1)
  let j = -1
  for (let i = 0; i < base.length; i++) {
    const t = base[i].t
    while (j + 1 < htf.length && htf[j + 1].t + htfSeconds * 1000 <= t) j++
    out[i] = j
  }
  return out
}

export const range = (c) => c.h - c.l
export const body = (c) => Math.abs(c.c - c.o)
export const isBull = (c) => c.c > c.o
export const isBear = (c) => c.c < c.o
export const upperWick = (c) => c.h - Math.max(c.o, c.c)
export const lowerWick = (c) => Math.min(c.o, c.c) - c.l

/** Where the close sits inside the bar's range: 0 = on the low, 1 = on the high. */
export function closePosition(c) {
  const r = range(c)
  if (r <= 0) return 0.5
  return (c.c - c.l) / r
}

/** Wilder-smoothed ATR, index-aligned with `candles` (NaN until seeded). */
export function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(NaN)
  if (candles.length < 2) return out
  let sum = 0
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]
    const c = candles[i]
    const tr = Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c))
    if (i <= period) {
      sum += tr
      if (i === period) out[i] = sum / period
    } else {
      out[i] = (out[i - 1] * (period - 1) + tr) / period
    }
  }
  return out
}

/**
 * Trailing simple moving average of volume, index-aligned. Deliberately
 * excludes the current bar so "volume above average" never compares a bar to
 * itself.
 */
export function volumeBaseline(candles, period = 20) {
  const out = new Array(candles.length).fill(NaN)
  let sum = 0
  for (let i = 0; i < candles.length; i++) {
    if (i > 0) sum += candles[i - 1].v
    if (i > period) sum -= candles[i - period - 1].v
    if (i >= period) out[i] = sum / period
  }
  return out
}

/** Volume of bar `i` as a multiple of its trailing baseline. */
export function relativeVolume(candles, i, baseline) {
  const b = baseline[i]
  if (!Number.isFinite(b) || b <= 0) return 1
  return candles[i].v / b
}

/** Highest high / lowest low over the trailing `n` bars ending at `i`. */
export function highestHigh(candles, i, n) {
  let hi = -Infinity
  for (let k = Math.max(0, i - n + 1); k <= i; k++) hi = Math.max(hi, candles[k].h)
  return hi
}

export function lowestLow(candles, i, n) {
  let lo = Infinity
  for (let k = Math.max(0, i - n + 1); k <= i; k++) lo = Math.min(lo, candles[k].l)
  return lo
}

/**
 * Extremes of a large array.
 *
 * `Math.max(...xs)` passes every element as an argument and blows the call
 * stack somewhere around a hundred thousand of them — which is a bug that only
 * appears once the data gets real. A 2-year 1-minute series is 700k bars.
 */
export function maxOf(xs, fallback = -Infinity) {
  let m = fallback
  for (const x of xs) if (x > m) m = x
  return m
}

export function minOf(xs, fallback = Infinity) {
  let m = fallback
  for (const x of xs) if (x < m) m = x
  return m
}

/** Assert the series is ascending and free of obvious corruption. */
export function validateSeries(candles) {
  const problems = []
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    if (!Number.isFinite(c.t) || !Number.isFinite(c.o) || !Number.isFinite(c.h) ||
        !Number.isFinite(c.l) || !Number.isFinite(c.c)) {
      problems.push(`bar ${i}: non-finite field`)
      continue
    }
    if (c.h < c.l) problems.push(`bar ${i}: high < low`)
    if (c.o > c.h || c.o < c.l) problems.push(`bar ${i}: open outside range`)
    if (c.c > c.h || c.c < c.l) problems.push(`bar ${i}: close outside range`)
    if (i > 0 && c.t <= candles[i - 1].t) problems.push(`bar ${i}: timestamp not ascending`)
  }
  return problems
}
