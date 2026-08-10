/**
 * Component-level edge measurement.
 *
 * The full system produces about fifty trades in two years, which is far too
 * few to learn anything from — tuning entry rules against a sample that size is
 * curve-fitting with extra steps. But the *components* those rules are built
 * from fire thousands of times over the same data, and each one makes a
 * falsifiable claim: after this fires, price tends to move that way.
 *
 * So the question becomes tractable. Rather than asking "does the strategy
 * work", which fifty trades cannot answer, ask "does a CISD predict the next
 * fifteen minutes", which several thousand events can.
 *
 * A component with no forward edge cannot be rescued by recombining it with
 * other components that also have none. Measuring first is what stops an entry
 * rewrite from being a random walk through parameter space.
 *
 * ── On the statistics ───────────────────────────────────────────────────────
 * Forward returns are scaled by ATR at the signal, so a 10-point move in a
 * quiet session and a 40-point move in a violent one are comparable.
 *
 * Overlapping windows are the trap here: two events six bars apart measured
 * over a sixty-bar horizon share most of their outcome, and treating them as
 * independent inflates any t-statistic enormously. Events are therefore thinned
 * so that no two retained events overlap within the horizon being measured, and
 * the reported count is the thinned one.
 *
 * Even thinned, a t-statistic on financial data overstates confidence — returns
 * are fat-tailed and regimes cluster. Treat |t| under about 3 as nothing.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { atr } from '../core/candles.js'

/**
 * Forward-return statistics for one set of signal events.
 *
 * @param {import('../core/candles.js').Candle[]} candles
 * @param {{index:number}[]} events
 * @param {{horizons?:number[], direction?:1|-1, atrPeriod?:number, thin?:boolean}} [opts]
 *        `direction` is +1 when the signal predicts up, -1 for down, so a
 *        positive mean always means "the signal was right".
 * @returns {{horizon:number, n:number, meanAtr:number, medianAtr:number,
 *            hitRate:number, tStat:number}[]}
 */
export function measureForwardEdge(candles, events, { horizons = [5, 15, 30, 60], direction = 1, atrPeriod = 14, thin = true } = {}) {
  const atrs = atr(candles, atrPeriod)
  const out = []

  for (const horizon of horizons) {
    const samples = []
    let lastUsed = -Infinity

    for (const ev of events) {
      const i = ev.index
      // Thin to non-overlapping events: two signals inside one horizon of each
      // other share most of their outcome and are not independent evidence.
      if (thin && i - lastUsed < horizon) continue
      const j = i + horizon
      if (j >= candles.length) break
      const a = atrs[i]
      if (!Number.isFinite(a) || a <= 0) continue

      samples.push((direction * (candles[j].c - candles[i].c)) / a)
      lastUsed = i
    }

    out.push({ horizon, ...summarise(samples) })
  }
  return out
}

function summarise(xs) {
  const n = xs.length
  if (n < 2) return { n, meanAtr: 0, medianAtr: 0, hitRate: 0, tStat: 0 }
  const mean = xs.reduce((a, b) => a + b, 0) / n
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)
  const sd = Math.sqrt(variance)
  const sorted = [...xs].sort((a, b) => a - b)
  return {
    n,
    meanAtr: mean,
    medianAtr: sorted[Math.floor(n / 2)],
    hitRate: xs.filter((x) => x > 0).length / n,
    // Standard error of the mean. See the header: this flatters itself.
    tStat: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0,
  }
}

/**
 * A baseline to compare every component against.
 *
 * Without this the numbers are meaningless: if NQ drifted up over the sample,
 * every long signal looks predictive and every short one looks broken. Sampling
 * random bars at the same spacing gives the drift a component has to beat.
 */
export function baselineEdge(candles, { horizons = [5, 15, 30, 60], direction = 1, spacing = 60, atrPeriod = 14 } = {}) {
  const events = []
  for (let i = 400; i < candles.length; i += spacing) events.push({ index: i })
  return measureForwardEdge(candles, events, { horizons, direction, atrPeriod, thin: false })
}

/**
 * Run a batch of named components and return a comparable table.
 *
 * @param {import('../core/candles.js').Candle[]} candles
 * @param {{name:string, events:Array, direction:1|-1}[]} components
 */
export function edgeReport(candles, components, { horizons = [5, 15, 30, 60] } = {}) {
  const rows = []
  for (const c of components) {
    if (!c.events?.length) {
      rows.push({ name: c.name, empty: true, results: [] })
      continue
    }
    rows.push({
      name: c.name,
      count: c.events.length,
      results: measureForwardEdge(candles, c.events, { horizons, direction: c.direction }),
    })
  }
  return rows
}

/** Format an edge report for a terminal. */
export function formatEdgeReport(rows, { horizons = [5, 15, 30, 60] } = {}) {
  const lines = []
  lines.push(`${'component'.padEnd(30)}${horizons.map((h) => `${h}b: mean/hit/t`.padStart(22)).join('')}`)
  for (const r of rows) {
    if (r.empty) {
      lines.push(`${r.name.padEnd(30)}${'(no events)'.padStart(22)}`)
      continue
    }
    const cells = r.results.map((x) => `${x.meanAtr >= 0 ? '+' : ''}${x.meanAtr.toFixed(3)}/${(x.hitRate * 100).toFixed(0)}%/${x.tStat >= 0 ? '+' : ''}${x.tStat.toFixed(1)} (${x.n})`.padStart(22))
    lines.push(`${r.name.padEnd(30)}${cells.join('')}`)
  }
  return lines.join('\n')
}
