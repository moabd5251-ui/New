/**
 * Deterministic synthetic market data.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 * Exercising and testing the engine without a data subscription: the generator
 * produces bars that contain the structures the system looks for — trends,
 * accumulations, liquidity sweeps, displacement legs and imbalances — inside a
 * realistic session clock.
 *
 * It is NOT a market. Backtest numbers produced on synthetic data measure
 * whether the code works, never whether the strategy has an edge. For that you
 * need real NQ data with real volume. Nothing here should ever be quoted as a
 * performance result.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { etParts, futuresDayKey, sessionOf, isMaintenanceBreak } from '../core/sessions.js'

/** Small, fast, seedable PRNG — reproducible series across runs and machines. */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Relative activity by session — Asia is quieter, the NY open is not. */
const SESSION_ACTIVITY = {
  asia: { vol: 0.55, volume: 0.5 },
  london: { vol: 0.9, volume: 0.85 },
  nyAM: { vol: 1.4, volume: 1.6 },
  nyLunch: { vol: 0.5, volume: 0.5 },
  nyPM: { vol: 1.0, volume: 1.0 },
  postClose: { vol: 0.4, volume: 0.3 },
  unknown: { vol: 0.5, volume: 0.4 },
}

const REGIMES = ['accumulation', 'expansion', 'retracement', 'sweep']

/**
 * @param {{days?:number, startDate?:string, seed?:number, startPrice?:number,
 *          tickSize?:number, baseVolume?:number, pointVol?:number}} [opts]
 * @returns {import('../core/candles.js').Candle[]} 1-minute bars
 */
export function generateSeries(opts = {}) {
  const {
    days = 10,
    startDate = '2026-01-05',
    seed = 20260105,
    startPrice = 21000,
    tickSize = 0.25,
    baseVolume = 900,
    pointVol = 3.2, // typical 1m standard deviation in points
  } = opts

  const rng = mulberry32(seed)
  const gauss = () => {
    // Box–Muller, so tails exist and displacement bars are possible.
    const u = Math.max(rng(), 1e-9)
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
  }
  const round = (p) => Math.round(p / tickSize) * tickSize

  const candles = []
  let price = startPrice
  let ms = Date.parse(`${startDate}T00:00:00Z`)
  const seenDays = new Set()

  let regime = { type: 'accumulation', left: 30, drift: 0, volMult: 0.6, target: null }
  const recent = [] // rolling window used to place sweeps at real extremes

  while (seenDays.size <= days) {
    const p = etParts(ms)
    const isWeekend =
      p.weekday === 6 || // Saturday
      (p.weekday === 5 && p.hour >= 17) || // after Friday's close
      (p.weekday === 0 && p.hour < 18) // before Sunday's open

    if (isWeekend || isMaintenanceBreak(ms)) {
      ms += 60_000
      continue
    }

    const session = sessionOf(ms)
    const activity = SESSION_ACTIVITY[session] ?? SESSION_ACTIVITY.unknown
    seenDays.add(futuresDayKey(ms))

    // ── Regime transitions ────────────────────────────────────────────────
    if (regime.left <= 0) regime = nextRegime(rng, recent, price)
    regime.left--

    // ── Price path for this minute ────────────────────────────────────────
    const vol = pointVol * activity.vol * regime.volMult
    let drift = regime.drift

    // A sweep aims at a specific level, then snaps back.
    if (regime.type === 'sweep' && regime.target !== null) {
      const gap = regime.target - price
      drift = Math.sign(gap) * Math.min(Math.abs(gap) * 0.35, vol * 2.5)
      if (Math.abs(gap) < tickSize * 4) {
        // Level taken — reverse hard. This is the manipulation leg the system
        // is built to trade against.
        regime = {
          type: 'expansion',
          left: 12 + Math.floor(rng() * 25),
          drift: -Math.sign(gap || 1) * (0.9 + rng() * 1.4),
          volMult: 1.5,
          target: null,
        }
      }
    }

    const open = price
    const steps = 6
    let hi = open
    let lo = open
    let cur = open
    for (let s = 0; s < steps; s++) {
      cur += drift / steps + gauss() * (vol / Math.sqrt(steps))
      hi = Math.max(hi, cur)
      lo = Math.min(lo, cur)
    }
    const close = cur

    // Volume tracks range: expansion bars print more, accumulation less. The
    // engine's displacement and relative-volume tests depend on this holding.
    const rangePts = hi - lo
    const volumeFactor = 0.6 + (rangePts / (pointVol * 2)) * 0.9 + rng() * 0.3
    const volume = Math.max(20, Math.round(baseVolume * activity.volume * volumeFactor))

    candles.push({
      t: ms,
      o: round(open),
      h: round(Math.max(hi, open, close)),
      l: round(Math.min(lo, open, close)),
      c: round(close),
      v: volume,
    })

    price = close
    recent.push({ h: hi, l: lo })
    if (recent.length > 180) recent.shift()
    ms += 60_000
  }

  return candles
}

function nextRegime(rng, recent, price) {
  const r = rng()
  let type
  if (r < 0.34) type = 'accumulation'
  else if (r < 0.64) type = 'expansion'
  else if (r < 0.86) type = 'retracement'
  else type = 'sweep'

  switch (type) {
    case 'accumulation':
      // Balance: low volatility, no drift. Builds the equal highs/lows that
      // become liquidity pools later.
      return { type, left: 25 + Math.floor(rng() * 60), drift: 0, volMult: 0.45 + rng() * 0.25, target: null }
    case 'expansion': {
      const dir = rng() < 0.5 ? -1 : 1
      return { type, left: 15 + Math.floor(rng() * 45), drift: dir * (0.6 + rng() * 1.6), volMult: 1.2 + rng() * 0.8, target: null }
    }
    case 'retracement': {
      const dir = rng() < 0.5 ? -1 : 1
      return { type, left: 12 + Math.floor(rng() * 30), drift: dir * (0.15 + rng() * 0.4), volMult: 0.7 + rng() * 0.4, target: null }
    }
    case 'sweep':
    default: {
      // Reach for the extreme of the recent range — where the stops are.
      if (!recent.length) return { type: 'accumulation', left: 20, drift: 0, volMult: 0.5, target: null }
      const hi = Math.max(...recent.map((x) => x.h))
      const lo = Math.min(...recent.map((x) => x.l))
      const up = rng() < 0.5
      const target = up ? hi + 2 + rng() * 6 : lo - 2 - rng() * 6
      return { type, left: 20 + Math.floor(rng() * 20), drift: 0, volMult: 1.1 + rng() * 0.6, target }
    }
  }
}

/**
 * Synthetic footprint (real-feed shape) to exercise `FootprintOrderflow`.
 * Splits each bar's volume into aggressive buys/sells using the bar's shape,
 * with noise so it is not a perfect mirror of the proxy.
 */
export function generateFootprint(candles, seed = 7) {
  const rng = mulberry32(seed)
  return candles.map((c) => {
    const range = Math.max(c.h - c.l, 0.25)
    const bias = (c.c - c.l) / range // 0 = closed on the low
    const noisy = Math.max(0.05, Math.min(0.95, bias + (rng() - 0.5) * 0.25))
    const buyVolume = Math.round(c.v * noisy)
    return { buyVolume, sellVolume: c.v - buyVolume }
  })
}
