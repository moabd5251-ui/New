/**
 * Tradier market data.
 *
 * ── What Tradier can and cannot do for this system ──────────────────────────
 * Tradier is an equities and options broker. It does NOT carry futures — NQ,
 * /NQ, NQZ25 and @NQ all come back unmatched. You cannot trade or backtest the
 * actual NASDAQ futures contract through it.
 *
 * What it does give you is excellent equity data: real consolidated-tape volume
 * (hundreds of thousands of shares a minute on QQQ, not an estimate) and a
 * per-bar VWAP straight from the exchange. For a NASDAQ-100 proxy, QQQ on
 * Tradier is better DATA than NQ on Yahoo — it is simply a different, and
 * smaller, instrument, with a 04:00–20:00 ET session rather than 23 hours.
 *
 * Practical limits:
 *   • 1-minute history reaches back roughly 20 days; older dates return empty.
 *   • Requests are made one day at a time, because long ranges get truncated.
 *   • `session_filter=all` is required to get pre- and post-market bars.
 *
 * Only read-only `/v1/markets/*` endpoints are used here. This module never
 * touches an account, a balance or an order.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const BASE = 'https://api.tradier.com/v1/markets'
const SANDBOX = 'https://sandbox.tradier.com/v1/markets'

export const TRADIER_INTERVALS = ['tick', '1min', '5min', '15min']

/**
 * Fetch intraday bars, one calendar day per request.
 *
 * @param {{symbol?:string, interval?:string, start:string, end:string,
 *          token?:string, sessionFilter?:string, sandbox?:boolean,
 *          fetchImpl?:Function, onProgress?:Function}} opts
 *        `start`/`end` are `YYYY-MM-DD` dates, inclusive.
 * @returns {Promise<{candles:import('../../core/candles.js').Candle[], meta:object}>}
 */
export async function fetchTradier(opts) {
  const {
    symbol = 'QQQ',
    interval = '1min',
    start,
    end,
    token = process.env.TRADIER_TOKEN,
    sessionFilter = 'all',
    sandbox = false,
    fetchImpl = globalThis.fetch,
    onProgress = null,
  } = opts

  if (!token) throw new Error('Tradier requires a token: set TRADIER_TOKEN or pass { token }')
  if (!TRADIER_INTERVALS.includes(interval)) {
    throw new Error(`Tradier interval must be one of ${TRADIER_INTERVALS.join(', ')}`)
  }
  if (!start || !end) throw new Error('fetchTradier needs { start, end } as YYYY-MM-DD')

  const base = sandbox ? SANDBOX : BASE
  const days = eachDay(start, end)
  const candles = []
  const emptyDays = []

  for (const day of days) {
    // Weekends never have data; skip them rather than burning a request.
    if (isWeekend(day)) continue
    const url =
      `${base}/timesales?symbol=${encodeURIComponent(symbol)}&interval=${interval}` +
      `&start=${day}%2000:00&end=${day}%2023:59&session_filter=${sessionFilter}`

    const rows = await requestJson(url, token, fetchImpl)
    const series = rows?.series?.data
    if (!series) {
      emptyDays.push(day)
      onProgress?.({ day, bars: 0 })
      continue
    }
    const list = Array.isArray(series) ? series : [series]
    for (const r of list) {
      const candle = toCandle(r)
      if (candle) candles.push(candle)
    }
    onProgress?.({ day, bars: list.length })
  }

  candles.sort((a, b) => a.t - b.t)
  // Tradier occasionally repeats the boundary minute across day requests.
  const deduped = []
  for (const c of candles) {
    if (deduped.length && deduped.at(-1).t === c.t) continue
    deduped.push(c)
  }

  return {
    candles: deduped,
    meta: {
      source: 'tradier',
      symbol,
      interval,
      sessionFilter,
      requestedDays: days.length,
      emptyDays,
      hasBidAskVolume: false,
      note: emptyDays.length
        ? `${emptyDays.length} day(s) returned no data — Tradier serves roughly 20 days of 1-minute history`
        : null,
    },
  }
}

async function requestJson(url, token, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (res.status === 401) throw new Error('Tradier rejected the token (401). Check TRADIER_TOKEN.')
  if (res.status === 429) throw new Error('Tradier rate limit hit (429). Wait and retry with a smaller range.')
  if (!res.ok) throw new Error(`Tradier returned HTTP ${res.status}`)

  // Out-of-range dates can come back as an HTML error page rather than JSON.
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Tradier returned a non-JSON response (${text.slice(0, 80).replace(/\s+/g, ' ')}…) — usually a date outside its history window`)
  }
}

/** Convert one timesales row. Tradier timestamps are epoch seconds, ET-based. */
function toCandle(r) {
  if (r?.open == null || r?.close == null) return null
  return {
    t: (r.timestamp ?? Math.floor(Date.parse(`${r.time}Z`) / 1000)) * 1000,
    o: r.open,
    h: r.high,
    l: r.low,
    c: r.close,
    v: r.volume ?? 0,
    // Exchange-computed VWAP — more accurate than deriving it from OHLC.
    vwap: r.vwap ?? null,
  }
}

/** Quotes for one or more symbols. Useful for checking a symbol exists. */
export async function tradierQuote(symbols, opts = {}) {
  const { token = process.env.TRADIER_TOKEN, sandbox = false, fetchImpl = globalThis.fetch } = opts
  if (!token) throw new Error('Tradier requires a token: set TRADIER_TOKEN or pass { token }')
  const base = sandbox ? SANDBOX : BASE
  const list = Array.isArray(symbols) ? symbols.join(',') : symbols
  const body = await requestJson(`${base}/quotes?symbols=${encodeURIComponent(list)}`, token, fetchImpl)
  const q = body?.quotes
  if (!q || q.unmatched_symbols) {
    return { matched: [], unmatched: [].concat(q?.unmatched_symbols?.symbol ?? list) }
  }
  const quotes = Array.isArray(q.quote) ? q.quote : [q.quote]
  return { matched: quotes, unmatched: [] }
}

/** Daily OHLCV history. Tradier serves years of dailies, unlike its 1m data. */
export async function tradierHistory(symbol, opts = {}) {
  const { token = process.env.TRADIER_TOKEN, sandbox = false, fetchImpl = globalThis.fetch, start, end } = opts
  if (!token) throw new Error('Tradier requires a token: set TRADIER_TOKEN or pass { token }')
  const base = sandbox ? SANDBOX : BASE
  const from = start ?? new Date(Date.now() - 200 * 86_400_000).toISOString().slice(0, 10)
  const to = end ?? new Date().toISOString().slice(0, 10)
  const body = await requestJson(
    `${base}/history?symbol=${encodeURIComponent(symbol)}&interval=daily&start=${from}&end=${to}`,
    token,
    fetchImpl,
  )
  const days = body?.history?.day
  if (!days) return []
  return (Array.isArray(days) ? days : [days]).map((d) => ({
    date: d.date,
    o: d.open,
    h: d.high,
    l: d.low,
    c: d.close,
    v: d.volume ?? 0,
  }))
}

/** Option expiration dates for a symbol, ascending YYYY-MM-DD strings. */
export async function tradierExpirations(symbol, opts = {}) {
  const { token = process.env.TRADIER_TOKEN, sandbox = false, fetchImpl = globalThis.fetch } = opts
  if (!token) throw new Error('Tradier requires a token: set TRADIER_TOKEN or pass { token }')
  const base = sandbox ? SANDBOX : BASE
  const body = await requestJson(
    `${base}/options/expirations?symbol=${encodeURIComponent(symbol)}&includeAllRoots=true`,
    token,
    fetchImpl,
  )
  const dates = body?.expirations?.date
  return dates ? [].concat(dates) : []
}

/**
 * One expiration's full chain with greeks (ORATS-supplied; occasionally null
 * on illiquid strikes — callers must tolerate missing greeks).
 */
export async function tradierChain(symbol, expiration, opts = {}) {
  const { token = process.env.TRADIER_TOKEN, sandbox = false, fetchImpl = globalThis.fetch } = opts
  if (!token) throw new Error('Tradier requires a token: set TRADIER_TOKEN or pass { token }')
  const base = sandbox ? SANDBOX : BASE
  const body = await requestJson(
    `${base}/options/chains?symbol=${encodeURIComponent(symbol)}&expiration=${expiration}&greeks=true`,
    token,
    fetchImpl,
  )
  const options = body?.options?.option
  return options ? [].concat(options) : []
}

function eachDay(start, end) {
  const out = []
  const a = new Date(`${start}T00:00:00Z`)
  const b = new Date(`${end}T00:00:00Z`)
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) throw new Error('start/end must be YYYY-MM-DD')
  for (let d = a; d <= b; d = new Date(d.getTime() + 86_400_000)) {
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}

function isWeekend(day) {
  const wd = new Date(`${day}T12:00:00Z`).getUTCDay()
  return wd === 0 || wd === 6
}
