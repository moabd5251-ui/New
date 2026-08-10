/**
 * Yahoo Finance chart API.
 *
 * The useful thing about Yahoo for this system is that it carries the actual
 * futures contract (`NQ=F`) with the full 23-hour session, so the Asia and
 * London killzones exist in the data. Its volume is credible: daily totals line
 * up with real NQ turnover, and the 1-minute bars sum to the daily bars.
 *
 * The constraints are real and worth knowing before you plan a backtest:
 *
 *   • 1-minute data goes back 7 days. That is the hard limit.
 *   • 5-minute goes back 60 days, 1-hour 730 days.
 *   • Roughly a fifth of overnight 1m bars carry no volume, because no trade
 *     printed in that minute. Those are genuine zeros, not missing data.
 *   • There is no bid/ask split, so orderflow stays a proxy.
 *
 * No API key required. Unofficial endpoint — it can change without notice.
 */

/** Maximum lookback Yahoo will serve per interval. */
export const YAHOO_LIMITS = {
  '1m': { maxDays: 7, note: 'and only within the last 30 days' },
  '2m': { maxDays: 60 },
  '5m': { maxDays: 60 },
  '15m': { maxDays: 60 },
  '30m': { maxDays: 60 },
  '60m': { maxDays: 730 },
  '1h': { maxDays: 730 },
  '1d': { maxDays: 10000 },
}

/** Common futures symbols on Yahoo. */
export const YAHOO_SYMBOLS = {
  NQ: 'NQ=F',
  ES: 'ES=F',
  YM: 'YM=F',
  RTY: 'RTY=F',
  CL: 'CL=F',
  GC: 'GC=F',
}

const BASE = 'https://query1.finance.yahoo.com/v8/finance/chart'

/**
 * Fetch OHLCV bars.
 *
 * @param {{symbol?:string, interval?:string, range?:string, prepost?:boolean,
 *          fetchImpl?:Function, dropUnclosed?:boolean}} [opts]
 * @returns {Promise<{candles:import('../../core/candles.js').Candle[], meta:object}>}
 */
export async function fetchYahoo(opts = {}) {
  const {
    symbol = 'NQ=F',
    interval = '1m',
    range = '7d',
    prepost = true,
    fetchImpl = globalThis.fetch,
    dropUnclosed = true,
  } = opts

  const limit = YAHOO_LIMITS[interval]
  if (!limit) {
    throw new Error(`Yahoo does not serve interval "${interval}". Supported: ${Object.keys(YAHOO_LIMITS).join(', ')}`)
  }
  const requestedDays = rangeToDays(range)
  if (requestedDays !== null && requestedDays > limit.maxDays) {
    throw new Error(
      `Yahoo serves at most ${limit.maxDays} days of ${interval} data${limit.note ? ` (${limit.note})` : ''}; ${range} was requested. ` +
        `For a longer history use a coarser interval — 5m gives 60 days, 1h gives 730.`,
    )
  }

  const url = `${BASE}/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=${prepost}`
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Yahoo returned HTTP ${res.status} for ${symbol}`)

  const body = await res.json()
  return parseYahooChart(body, { interval, dropUnclosed })
}

/**
 * Parse a chart-API payload into candles. Exported so it can be tested against
 * a fixture without touching the network.
 */
export function parseYahooChart(body, { interval = '1m', dropUnclosed = true } = {}) {
  const err = body?.chart?.error
  if (err) throw new Error(`Yahoo error: ${err.code ?? ''} ${err.description ?? JSON.stringify(err)}`.trim())

  const result = body?.chart?.result?.[0]
  if (!result) throw new Error('Yahoo returned no chart result')

  const timestamps = result.timestamp ?? []
  const q = result.indicators?.quote?.[0]
  if (!q) throw new Error('Yahoo returned no quote series')

  const stepMs = intervalMs(interval)
  const candles = []
  let droppedNull = 0
  let nullVolume = 0

  for (let i = 0; i < timestamps.length; i++) {
    const o = q.open?.[i]
    const h = q.high?.[i]
    const l = q.low?.[i]
    const c = q.close?.[i]
    // Yahoo pads its timestamp array for minutes with no data at all. A row
    // without a close is a hole, not a bar — dropping it is correct.
    if (o == null || h == null || l == null || c == null) {
      droppedNull++
      continue
    }
    const v = q.volume?.[i]
    if (v == null) nullVolume++

    candles.push({
      t: timestamps[i] * 1000,
      o,
      h,
      l,
      c,
      // A minute where price moved but nothing printed is a real zero.
      v: v ?? 0,
    })
  }

  // The final bar of a live session is still forming. Its timestamp is not
  // aligned to the interval, and its volume is partial — trading off it would
  // be reading a bar that has not happened yet.
  let unclosed = null
  if (dropUnclosed && candles.length) {
    const last = candles.at(-1)
    const aligned = last.t % stepMs === 0
    const stale = Date.now() - last.t >= stepMs
    if (!aligned || !stale) {
      unclosed = candles.pop()
    }
  }

  return {
    candles,
    meta: {
      source: 'yahoo',
      symbol: result.meta?.symbol,
      interval,
      timezone: result.meta?.exchangeTimezoneName,
      currency: result.meta?.currency,
      droppedNullRows: droppedNull,
      nullVolumeBars: nullVolume,
      droppedUnclosedBar: unclosed ? new Date(unclosed.t).toISOString() : null,
      hasBidAskVolume: false,
    },
  }
}

function intervalMs(interval) {
  const m = /^(\d+)(m|h|d)$/.exec(interval)
  if (!m) return 60_000
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]]
}

function rangeToDays(range) {
  const m = /^(\d+)(d|mo|y)$/.exec(range)
  if (!m) return null
  const n = Number(m[1])
  return n * { d: 1, mo: 30, y: 365 }[m[2]]
}
