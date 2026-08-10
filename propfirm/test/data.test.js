import test from 'node:test'
import assert from 'node:assert/strict'

import { parseYahooChart, YAHOO_LIMITS, fetchYahoo } from '../src/data/providers/yahoo.js'
import { fetchTradier, tradierQuote } from '../src/data/providers/tradier.js'
import { auditSeries, formatAudit } from '../src/data/quality.js'
import { sizePosition } from '../src/risk/sizing.js'
import { PropAccount, INSTRUMENTS, equityInstrument } from '../src/risk/propfirm.js'

/* ── Yahoo ──────────────────────────────────────────────────────────────── */

const yahooBody = (rows, { symbol = 'NQ=F' } = {}) => ({
  chart: {
    result: [
      {
        meta: { symbol, exchangeTimezoneName: 'America/New_York', currency: 'USD' },
        timestamp: rows.map((r) => r.t),
        indicators: { quote: [{
          open: rows.map((r) => r.o),
          high: rows.map((r) => r.h),
          low: rows.map((r) => r.l),
          close: rows.map((r) => r.c),
          volume: rows.map((r) => r.v),
        }] },
      },
    ],
    error: null,
  },
})

const minute = (n) => Math.floor(Date.UTC(2026, 0, 15, 15, n) / 1000)

test('Yahoo rows without a close are dropped, not zero-filled', () => {
  const body = yahooBody([
    { t: minute(0), o: 100, h: 101, l: 99, c: 100, v: 500 },
    { t: minute(1), o: null, h: null, l: null, c: null, v: null }, // padded hole
    { t: minute(2), o: 100, h: 102, l: 100, c: 101, v: 600 },
  ])
  const { candles, meta } = parseYahooChart(body, { dropUnclosed: false })
  assert.equal(candles.length, 2)
  assert.equal(meta.droppedNullRows, 1)
  assert.ok(candles.every((c) => Number.isFinite(c.c)))
})

test('a minute that traded with no volume is kept as a genuine zero', () => {
  const body = yahooBody([
    { t: minute(0), o: 100, h: 101, l: 99, c: 100, v: null },
    { t: minute(1), o: 100, h: 101, l: 99, c: 100, v: 20 },
  ])
  const { candles, meta } = parseYahooChart(body, { dropUnclosed: false })
  assert.equal(candles.length, 2)
  assert.equal(candles[0].v, 0)
  assert.equal(meta.nullVolumeBars, 1)
})

test('the in-progress final bar is dropped', () => {
  // A live bar is not aligned to the minute boundary.
  const body = yahooBody([
    { t: minute(0), o: 100, h: 101, l: 99, c: 100, v: 500 },
    { t: minute(1), o: 100, h: 101, l: 99, c: 100, v: 500 },
    { t: minute(2) + 37, o: 100, h: 100.5, l: 100, c: 100.25, v: 12 },
  ])
  const { candles, meta } = parseYahooChart(body)
  assert.equal(candles.length, 2)
  assert.ok(meta.droppedUnclosedBar, 'the partial bar should be reported')
})

test('Yahoo errors surface as errors', () => {
  assert.throws(
    () => parseYahooChart({ chart: { error: { code: 'Not Found', description: 'No data found' } } }),
    /No data found/,
  )
  assert.throws(() => parseYahooChart({ chart: { result: [] } }), /no chart result/)
})

test('requesting more history than Yahoo serves fails before the request', async () => {
  let called = false
  const fetchImpl = async () => {
    called = true
    return { ok: true, json: async () => ({}) }
  }
  await assert.rejects(
    () => fetchYahoo({ interval: '1m', range: '60d', fetchImpl }),
    /at most 7 days of 1m/,
  )
  assert.equal(called, false, 'a request that cannot succeed should not be sent')
  // The error should point at the way out.
  await assert.rejects(() => fetchYahoo({ interval: '1m', range: '30d', fetchImpl }), /5m gives 60 days/)
})

test('Yahoo interval limits are declared for every supported interval', () => {
  for (const [interval, limit] of Object.entries(YAHOO_LIMITS)) {
    assert.ok(limit.maxDays > 0, `${interval} has no declared limit`)
  }
})

test('a non-200 from Yahoo is reported with its status', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429 })
  await assert.rejects(() => fetchYahoo({ fetchImpl }), /HTTP 429/)
})

/* ── Tradier ────────────────────────────────────────────────────────────── */

const tradierResponse = (rows) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ series: { data: rows } }),
})

test('Tradier timesales rows convert to candles and keep the exchange VWAP', async () => {
  const fetchImpl = async () =>
    tradierResponse([
      { time: '2026-08-07T09:30:00', timestamp: 1786109400, open: 720.15, high: 720.73, low: 719.5, close: 720.59, volume: 448048, vwap: 720.16 },
    ])
  const { candles } = await fetchTradier({ symbol: 'QQQ', start: '2026-08-07', end: '2026-08-07', token: 'x', fetchImpl })
  assert.equal(candles.length, 1)
  assert.equal(candles[0].t, 1786109400 * 1000)
  assert.equal(candles[0].v, 448048)
  assert.equal(candles[0].vwap, 720.16)
})

test('Tradier returns a single object rather than an array for one bar', async () => {
  const fetchImpl = async () =>
    tradierResponse({ time: '2026-08-07T09:30:00', timestamp: 1786109400, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 })
  const { candles } = await fetchTradier({ start: '2026-08-07', end: '2026-08-07', token: 'x', fetchImpl })
  assert.equal(candles.length, 1)
})

test('weekends are skipped without a request', async () => {
  const requested = []
  const fetchImpl = async (url) => {
    requested.push(url.match(/start=(\d{4}-\d{2}-\d{2})/)[1])
    return tradierResponse([])
  }
  // 2026-08-08 and 09 are a Saturday and Sunday.
  await fetchTradier({ start: '2026-08-07', end: '2026-08-10', token: 'x', fetchImpl })
  assert.deepEqual(requested, ['2026-08-07', '2026-08-10'])
})

test('duplicate boundary bars across day requests are removed', async () => {
  const row = { time: '2026-08-07T09:30:00', timestamp: 1786109400, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }
  const fetchImpl = async () => tradierResponse([row, row])
  const { candles } = await fetchTradier({ start: '2026-08-07', end: '2026-08-07', token: 'x', fetchImpl })
  assert.equal(candles.length, 1)
})

test('an HTML error page from Tradier produces a readable error', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '<html>Bad Request</html>' })
  await assert.rejects(
    () => fetchTradier({ start: '2020-01-01', end: '2020-01-01', token: 'x', fetchImpl }),
    /non-JSON response.*history window/s,
  )
})

test('auth and rate-limit failures are named', async () => {
  await assert.rejects(
    () => fetchTradier({ start: '2026-08-07', end: '2026-08-07', token: 'x', fetchImpl: async () => ({ ok: false, status: 401 }) }),
    /rejected the token/,
  )
  await assert.rejects(
    () => fetchTradier({ start: '2026-08-07', end: '2026-08-07', token: 'x', fetchImpl: async () => ({ ok: false, status: 429 }) }),
    /rate limit/,
  )
})

test('a missing token is caught before any network call', async () => {
  await assert.rejects(
    () => fetchTradier({ start: '2026-08-07', end: '2026-08-07', token: '', fetchImpl: async () => { throw new Error('should not be called') } }),
    /TRADIER_TOKEN/,
  )
})

test('unmatched symbols are reported rather than thrown away', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ quotes: { unmatched_symbols: { symbol: 'NQ' } } }),
  })
  const out = await tradierQuote('NQ', { token: 'x', fetchImpl })
  assert.deepEqual(out.unmatched, ['NQ'])
  assert.equal(out.matched.length, 0)
})

/* ── quality audit ──────────────────────────────────────────────────────── */

const mkSeries = (n, fn) =>
  Array.from({ length: n }, (_, i) => ({
    t: Date.UTC(2026, 0, 15, 15, 0) + i * 60_000,
    o: 100,
    h: 101,
    l: 99,
    c: 100,
    v: 1000,
    ...fn?.(i),
  }))

test('an empty series is rejected', () => {
  const a = auditSeries([])
  assert.equal(a.tradeable, false)
  assert.match(a.problems[0], /empty/)
})

test('a series with no volume at all is rejected', () => {
  const a = auditSeries(mkSeries(600, () => ({ v: 0 })))
  assert.equal(a.tradeable, false)
  assert.match(a.problems.join(' '), /zero volume|cannot run on price alone/)
})

test('constant volume is rejected — it makes every volume test meaningless', () => {
  const a = auditSeries(mkSeries(600, () => ({ v: 500 })))
  assert.equal(a.tradeable, false)
  assert.match(a.problems.join(' '), /effectively constant/)
})

test('too short a series is rejected with the reason', () => {
  const a = auditSeries(mkSeries(50, (i) => ({ v: 100 + i })))
  assert.equal(a.tradeable, false)
  assert.match(a.problems.join(' '), /at least 400/)
})

test('sparse overnight volume warns but stays usable', () => {
  // 20% empty bars, as Yahoo's overnight futures data really looks.
  const a = auditSeries(mkSeries(600, (i) => ({ v: i % 5 === 0 ? 0 : 100 + (i % 37) })))
  assert.equal(a.tradeable, true)
  assert.match(a.warnings.join(' '), /zero volume/)
})

test('a regular-hours instrument is flagged, with the config to fix it', () => {
  // Ten sessions of 09:30-16:00 ET only — no Asia, no London.
  const rth = []
  for (let d = 0; d < 10; d++) {
    for (let m = 0; m < 390; m++) {
      rth.push({
        t: Date.UTC(2026, 0, 5 + d, 14, 30) + m * 60_000,
        o: 100, h: 101, l: 99, c: 100, v: 1000 + (m % 91),
      })
    }
  }
  const a = auditSeries(rth)
  assert.match(a.warnings.join(' '), /not a 23-hour futures contract/)
  assert.match(a.notes.join(' '), /allowedSessions/)
})

test('duplicate timestamps are a problem, not a warning', () => {
  const s = mkSeries(600, (i) => ({ v: 100 + i }))
  s[10] = { ...s[9] }
  const a = auditSeries(s)
  assert.equal(a.tradeable, false)
  assert.match(a.problems.join(' '), /duplicate/)
})

test('the audit formats without throwing on any outcome', () => {
  assert.equal(typeof formatAudit(auditSeries([])), 'string')
  assert.ok(formatAudit(auditSeries(mkSeries(600, (i) => ({ v: 100 + i })))).includes('bars'))
})

/* ── equities ───────────────────────────────────────────────────────────── */

test('an equity position is sized in shares, with no micro fallback', () => {
  // Large enough that the risk rule binds before capital does.
  const account = new PropAccount({ startingBalance: 500000, drawdown: 2500, instrument: INSTRUMENTS.QQQ })
  // $0.50 stop on QQQ = $0.50 risk per share; budget $250 → 500 shares.
  const s = sizePosition({
    account,
    signal: { entry: 720, stop: 719.5, targets: [], sizeMultiplier: 1 },
    instrument: INSTRUMENTS.QQQ,
  })
  assert.equal(s.allowed, true)
  assert.equal(s.symbol, 'QQQ', 'an equity must never fall back to a micro future')
  assert.equal(s.unit, 'shares')
  assert.equal(s.contracts, 500)
  assert.ok(s.riskDollars <= 250)
})

test('capital, not the risk rule, caps an equity position on a small account', () => {
  const account = new PropAccount({ startingBalance: 50000, drawdown: 2500, instrument: INSTRUMENTS.QQQ })
  // The risk rule alone would allow 500 shares — $360k of QQQ on a $50k
  // account. Unleveraged capital is the binding constraint.
  const s = sizePosition({
    account,
    signal: { entry: 720, stop: 719.5, targets: [], sizeMultiplier: 1 },
    instrument: INSTRUMENTS.QQQ,
  })
  assert.equal(s.contracts, Math.floor(50000 / 720))
  assert.equal(s.limitedBy, 'available capital')
})

test('share count is capped by capital, not by a futures contract limit', () => {
  const account = new PropAccount({ startingBalance: 5000, drawdown: 2500, instrument: INSTRUMENTS.QQQ })
  const s = sizePosition({
    account,
    signal: { entry: 720, stop: 719.99, targets: [], sizeMultiplier: 1 },
    instrument: INSTRUMENTS.QQQ,
  })
  // $5,000 of capital cannot hold more than 6 shares of a $720 stock.
  assert.ok(s.contracts <= Math.floor(5000 / 720))
  assert.equal(s.limitedBy, 'available capital')
})

test('an arbitrary ticker becomes a penny-tick equity spec', () => {
  const inst = equityInstrument('aapl')
  assert.equal(inst.symbol, 'AAPL')
  assert.equal(inst.kind, 'equity')
  assert.equal(inst.pointValue, 1)
  assert.equal(inst.tickSize, 0.01)
})

test('futures still size in contracts and still fall back to micros', () => {
  const account = new PropAccount({ startingBalance: 50000, drawdown: 2500 })
  const s = sizePosition({
    account,
    signal: { entry: 21000, stop: 20980, targets: [], sizeMultiplier: 1 },
    instrument: INSTRUMENTS.NQ,
  })
  assert.equal(s.unit, 'contracts')
  assert.equal(s.symbol, 'MNQ')
})
