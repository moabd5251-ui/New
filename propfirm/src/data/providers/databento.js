/**
 * Databento historical CME data.
 *
 * This is the provider that can actually answer whether the strategy works.
 * Yahoo caps 1-minute futures history at 7 days; Databento serves CME Globex
 * back to 2010, and — with the `trades` schema — every trade tagged with the
 * aggressor side, which is real delta rather than the bar-geometry estimate
 * everything else here falls back on.
 *
 * ── Money ───────────────────────────────────────────────────────────────────
 * Unlike the other providers, requests here are billed by volume of data. The
 * cost difference between schemas is enormous — roughly, for front-month NQ:
 *
 *   ohlcv-1m   24 months   ~$2.56      39 MB
 *   trades      3 months  ~$32.44     1.2 GB
 *   trades     12 months ~$114.50     4.4 GB
 *   mbp-10      1 month   ~$77.31     166 GB
 *
 * So every fetch here is preceded by a free `metadata.get_cost` call and
 * refuses to proceed past `maxCostUsd`. A typo in a date range should cost
 * nothing, not a hundred dollars. The guard is mandatory and has a low default.
 *
 * And because the bytes are paid for the moment they arrive, `onChunk` hands
 * each month to the caller to persist immediately. Buffering a whole range in
 * memory and writing at the end means any later failure — a bad parse, an
 * out-of-memory, a crash in an unrelated validation step — throws away data you
 * have already been billed for and cannot get back for free. Learned the
 * expensive way.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const BASE = 'https://hist.databento.com/v0'

/** Continuous-contract symbology: v = volume roll, c = calendar, n = open interest. */
export const CONTINUOUS = {
  NQ: 'NQ.v.0',
  ES: 'ES.v.0',
  CL: 'CL.v.0',
  GC: 'GC.v.0',
}

export const DEFAULT_DATASET = 'GLBX.MDP3'

function auth(apiKey) {
  if (!apiKey) throw new Error('Databento requires an API key: set DATABENTO_API_KEY or pass { apiKey }')
  // HTTP basic, key as username and an empty password.
  return `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`
}

async function call(path, params, apiKey, fetchImpl, { raw = false } = {}) {
  const url = new URL(`${BASE}/${path}`)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
  }
  const res = await fetchImpl(url.toString(), { headers: { Authorization: auth(apiKey) } })
  const text = await res.text()
  if (res.status === 401) throw new Error('Databento rejected the API key (401)')
  if (res.status === 422) throw new Error(`Databento rejected the request (422): ${text.slice(0, 200)}`)
  if (!res.ok) throw new Error(`Databento returned HTTP ${res.status}: ${text.slice(0, 200)}`)
  return raw ? text : text.trim()
}

/**
 * What a query would cost, in USD. Free to call, and never returns data.
 */
export async function databentoCost({
  dataset = DEFAULT_DATASET,
  symbols,
  schema = 'ohlcv-1m',
  start,
  end,
  stypeIn = 'continuous',
  apiKey = process.env.DATABENTO_API_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  const text = await call(
    'metadata.get_cost',
    { dataset, symbols, schema, start, end, stype_in: stypeIn, mode: 'historical-streaming' },
    apiKey,
    fetchImpl,
  )
  const cost = Number(text)
  if (!Number.isFinite(cost)) throw new Error(`Databento returned an unreadable cost: ${text.slice(0, 100)}`)
  return cost
}

/**
 * Fetch OHLCV bars, chunked by month.
 *
 * Chunking keeps individual responses small enough to stream and lets a long
 * pull report progress; billing is by bytes, so it costs the same as one
 * request.
 *
 * @param {{dataset?:string, symbols?:string, schema?:string, start:string, end:string,
 *          stypeIn?:string, apiKey?:string, maxCostUsd?:number, fetchImpl?:Function,
 *          onProgress?:Function, confirmCost?:Function}} opts
 * @returns {Promise<{candles:Array, meta:object}>}
 */
export async function fetchDatabento(opts) {
  const {
    dataset = DEFAULT_DATASET,
    symbols = CONTINUOUS.NQ,
    schema = 'ohlcv-1m',
    start,
    end,
    stypeIn = 'continuous',
    apiKey = process.env.DATABENTO_API_KEY,
    // Deliberately low. Raising it is a decision the caller has to make
    // explicitly, because the schemas differ in price by two orders of
    // magnitude and a slip of the keyboard is otherwise expensive.
    maxCostUsd = 5,
    fetchImpl = globalThis.fetch,
    onProgress = null,
    /** Called with each month's bars as they arrive. Persist here. */
    onChunk = null,
    /** Skip accumulating in memory when onChunk is doing the persisting. */
    retain = true,
  } = opts

  if (!start || !end) throw new Error('fetchDatabento needs { start, end } as YYYY-MM-DD')

  const cost = await databentoCost({ dataset, symbols, schema, start, end, stypeIn, apiKey, fetchImpl })
  if (cost > maxCostUsd) {
    throw new Error(
      `This query would cost $${cost.toFixed(2)}, above the $${maxCostUsd.toFixed(2)} limit. ` +
        `Raise maxCostUsd deliberately if that is the intended spend — schemas differ hugely in price ` +
        `(ohlcv-1m is cents per year; trades and mbp-10 are tens to hundreds of dollars).`,
    )
  }
  onProgress?.({ phase: 'cost', cost })

  const chunks = monthChunks(start, end)
  const candles = []
  for (const [from, to] of chunks) {
    const text = await call(
      'timeseries.get_range',
      {
        dataset,
        symbols,
        schema,
        start: from,
        end: to,
        stype_in: stypeIn,
        encoding: 'csv',
        pretty_px: 'true',
        pretty_ts: 'true',
      },
      apiKey,
      fetchImpl,
      { raw: true },
    )
    const parsed = parseDatabentoCsv(text)
    // Persist before anything else can fail. These bytes are already billed.
    await onChunk?.(parsed, { from, to })
    if (retain) {
      // Not push(...parsed): a month of 1-minute bars is 30k arguments, and the
      // whole point of this provider is ranges large enough for that to matter.
      for (const c of parsed) candles.push(c)
    }
    onProgress?.({ phase: 'chunk', from, to, bars: parsed.length, total: retain ? candles.length : undefined })
  }

  candles.sort((a, b) => a.t - b.t)
  const deduped = []
  for (const c of candles) {
    if (deduped.length && deduped.at(-1).t === c.t) continue
    deduped.push(c)
  }

  return {
    candles: deduped,
    meta: {
      source: 'databento',
      dataset,
      symbols,
      schema,
      costUsd: cost,
      chunks: chunks.length,
      // ohlcv carries no aggressor side; only `trades`/`tbbo` do.
      hasBidAskVolume: false,
    },
  }
}

/**
 * Parse Databento CSV (`pretty_px` + `pretty_ts`).
 *
 * Without `pretty_px` the price columns are int64 fixed-point at 1e-9, which
 * silently produces prices in the trillions if treated as decimals — so the
 * scale is detected rather than assumed.
 */
export function parseDatabentoCsv(text) {
  const lines = text.split('\n').filter((l) => l.trim())
  if (!lines.length) return []
  const header = lines[0].split(',').map((h) => h.trim())
  const col = (name) => header.indexOf(name)

  const iTs = col('ts_event')
  const iO = col('open')
  const iH = col('high')
  const iL = col('low')
  const iC = col('close')
  const iV = col('volume')
  if (iTs < 0 || iO < 0 || iC < 0) throw new Error(`Unexpected Databento CSV header: ${lines[0].slice(0, 120)}`)

  const out = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',')
    if (cols.length < header.length) continue
    const t = /^\d+$/.test(cols[iTs]) ? Math.floor(Number(cols[iTs]) / 1e6) : Date.parse(cols[iTs])
    const px = (raw) => {
      const n = Number(raw)
      if (!Number.isFinite(n)) return NaN
      // Fixed-point 1e-9 integers arrive when pretty_px is off.
      return raw.includes('.') ? n : n / 1e9
    }
    const candle = { t, o: px(cols[iO]), h: px(cols[iH]), l: px(cols[iL]), c: px(cols[iC]), v: Number(cols[iV] ?? 0) }
    if (!Number.isFinite(candle.t) || !Number.isFinite(candle.c)) continue
    out.push(candle)
  }
  return out
}

/** Split an inclusive date range into [start, end) month-sized pairs. */
export function monthChunks(start, end) {
  const out = []
  let cursor = new Date(`${start}T00:00:00Z`)
  const stop = new Date(`${end}T00:00:00Z`)
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(stop.getTime())) throw new Error('start/end must be YYYY-MM-DD')
  while (cursor < stop) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))
    const chunkEnd = next < stop ? next : stop
    out.push([cursor.toISOString().slice(0, 10), chunkEnd.toISOString().slice(0, 10)])
    cursor = chunkEnd
  }
  return out
}
