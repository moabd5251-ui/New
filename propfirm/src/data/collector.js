/**
 * Forward data collection.
 *
 * Two jobs, run together on a schedule:
 *
 *   1. Pull the provider's rolling window and merge it into the store, so a
 *      1-minute history accumulates that is longer than any single request can
 *      return.
 *
 *   2. Evaluate the newly closed bars once, and journal whatever the system
 *      says, marked as forward records.
 *
 * The second job is the valuable one and it needs one rule kept honestly: a bar
 * is evaluated exactly once, and the code that evaluated it is never afterwards
 * tuned against the result. A watermark enforces the first half. The second
 * half is a discipline, not a mechanism — if you change the engine, the forward
 * journal collected before the change belongs to the old engine, and the
 * `engineVersion` stamped on every record is there so you can tell them apart.
 *
 * Signals recorded here are paper: no fill, no slippage assumption, no P&L. The
 * question being answered is narrower and more useful than "did it make money"
 * — it is "when this system fires on data it has never seen, is it right?"
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { CandleStore } from './store.js'
import { Market } from './market.js'
import { aggregate } from '../core/candles.js'
import { TradingSystem } from '../engine/system.js'
import { auditSeries } from './quality.js'
import { futuresDayKey } from '../core/sessions.js'

/** Bump when the engine changes in a way that invalidates prior forward records. */
export const ENGINE_VERSION = '1.0.0'

/**
 * Higher-timeframe series are stored beside the 1-minute base under their own
 * suffix. Step 1 reads daily and 4-hour structure, and a 7-day window of
 * 1-minute bars aggregates to six daily candles with no swings at all — the
 * bias can never form. Providers that cap intraday history still serve years of
 * hourly and daily data, so those views are collected separately and injected.
 */
export const CONTEXT_STREAMS = {
  trend: { suffix: '@1h', interval: '1h', range: '60d' },
  context: { suffix: '@1d', interval: '1d', range: '2y' },
}

/**
 * Merge a fetched series into the store and, optionally, evaluate the new bars.
 *
 * @param {{candles:Array, root:string, symbol:string, instrument?:object,
 *          paper?:boolean, systemConfig?:object, now?:number}} args
 */
export function collect({ candles, root, symbol, instrument, contextSeries = {}, paper = true, systemConfig = {}, now = Date.now() }) {
  const store = new CandleStore(root, symbol)
  const before = store.coverage()
  const merge = store.merge(candles)
  const after = store.coverage()

  // Merge the higher-timeframe streams too, so a later `forward` run can
  // rebuild the same context without re-fetching.
  const context = {}
  for (const [name, cfg] of Object.entries(CONTEXT_STREAMS)) {
    const series = contextSeries[name]
    if (!series?.length) continue
    const s = new CandleStore(root, symbol + cfg.suffix)
    const m = s.merge(series)
    context[name] = { added: m.added, bars: s.coverage().bars }
  }

  const result = {
    fetched: candles.length,
    added: merge.added,
    updated: merge.updated,
    unchanged: merge.unchanged,
    daysTouched: merge.days,
    coverage: after,
    growth: { days: after.days - before.days, bars: after.bars - before.bars },
    context,
    paper: null,
  }

  if (paper && merge.added > 0) {
    result.paper = runForwardPass({ store, root, symbol, instrument, systemConfig, now })
  }
  return result
}

/**
 * Evaluate every stored bar past the watermark, exactly once.
 *
 * The Market is built from the full store — which is correct, because the
 * higher-timeframe context legitimately depends on history — while the as-of
 * accessors keep each individual evaluation from seeing past its own bar. That
 * property is covered by the no-lookahead test.
 */
export function runForwardPass({ store, root, symbol, instrument, systemConfig = {}, now = Date.now(), warmupBars = 400 }) {
  const series = store.load()
  if (series.length < warmupBars + 1) {
    return { evaluated: 0, signals: 0, note: `only ${series.length} bars stored; need ${warmupBars + 1} before evaluating` }
  }

  const audit = auditSeries(series)
  if (!audit.tradeable) {
    return { evaluated: 0, signals: 0, note: `store not tradeable: ${audit.problems[0]}` }
  }

  const statePath = join(root, '.state', `${safe(symbol)}.json`)
  const state = readState(statePath)
  const watermark = state.watermark ?? 0

  const market = new Market(series, { instrument, series: loadContext(root, symbol) })
  const system = new TradingSystem(systemConfig)
  const journalPath = join(root, `${safe(symbol)}-forward.jsonl`)

  let evaluated = 0
  let signals = 0
  const recorded = []

  for (let i = warmupBars; i < series.length; i++) {
    const bar = series[i]
    // Only bars never seen before, and only bars that have closed.
    if (bar.t <= watermark) continue
    evaluated++

    const { signal } = system.evaluate(market, i)
    if (!signal) continue

    // Collapse a setup that stays valid across several bars into one record.
    const last = recorded.at(-1)
    if (last && last.model === signal.model && last.direction === signal.direction && i - last.index <= 15) continue

    const record = {
      recordedAt: new Date(now).toISOString(),
      engineVersion: ENGINE_VERSION,
      forward: true,
      symbol,
      day: futuresDayKey(bar.t),
      barTime: new Date(bar.t).toISOString(),
      index: i,
      session: signal.session,
      direction: signal.direction,
      model: signal.model,
      grade: signal.grade,
      score: signal.score,
      entry: signal.entry,
      stop: signal.stop,
      riskPoints: signal.riskPoints,
      targets: signal.targets.map((t) => ({ price: t.price, r: t.r })),
      rr: signal.rr,
      orderflowIsProxy: signal.orderflowIsProxy,
      reasons: signal.reasons,
      conflicts: signal.conflicts,
      // Filled in later by `resolveForward` once enough bars exist to know.
      outcome: null,
    }
    recorded.push({ ...record, index: i })
    mkdirSync(dirname(journalPath), { recursive: true })
    appendFileSync(journalPath, JSON.stringify(record) + '\n')
    signals++
  }

  if (series.length) {
    writeState(statePath, { ...state, watermark: series.at(-1).t, lastRun: new Date(now).toISOString() })
  }

  return { evaluated, signals, journalPath, records: recorded }
}

/**
 * Score forward records whose outcome is now knowable.
 *
 * Walks the bars after each signal and decides whether the stop or the target
 * came first, using the same pessimistic rule as the backtester: a bar that
 * spans both counts as the stop.
 *
 * @returns {{resolved:number, pending:number, wins:number, losses:number, expectancyR:number}}
 */
export function resolveForward({ root, symbol, maxBars = 120 }) {
  const journalPath = join(root, `${safe(symbol)}-forward.jsonl`)
  if (!existsSync(journalPath)) return { resolved: 0, pending: 0, wins: 0, losses: 0, expectancyR: 0, records: [] }

  const store = new CandleStore(root, symbol)
  const series = store.load()
  const byTime = new Map(series.map((c, i) => [c.t, i]))

  const lines = readFileSync(journalPath, 'utf8').split('\n').filter((l) => l.trim())
  const records = lines.map((l) => JSON.parse(l))

  let resolved = 0
  let pending = 0
  const rs = []

  for (const rec of records) {
    const start = byTime.get(Date.parse(rec.barTime))
    if (start === undefined) {
      pending++
      continue
    }
    const long = rec.direction === 'long'
    const target = rec.targets.at(-1)?.price
    if (target == null) {
      pending++
      continue
    }
    const risk = Math.abs(rec.entry - rec.stop)
    let outcome = null

    for (let i = start + 1; i < Math.min(series.length, start + 1 + maxBars); i++) {
      const b = series[i]
      const hitStop = long ? b.l <= rec.stop : b.h >= rec.stop
      const hitTarget = long ? b.h >= target : b.l <= target
      // Stop first when a single bar spans both — the safe assumption.
      if (hitStop) {
        outcome = { result: 'stop', r: -1, bars: i - start, at: new Date(b.t).toISOString() }
        break
      }
      if (hitTarget) {
        outcome = { result: 'target', r: risk > 0 ? Math.abs(target - rec.entry) / risk : 0, bars: i - start, at: new Date(b.t).toISOString() }
        break
      }
    }

    if (!outcome) {
      // Either still open, or the store does not yet reach far enough.
      const exhausted = start + 1 + maxBars <= series.length
      if (exhausted) {
        const lastBar = series[Math.min(series.length - 1, start + maxBars)]
        const move = long ? lastBar.c - rec.entry : rec.entry - lastBar.c
        outcome = { result: 'timeout', r: risk > 0 ? move / risk : 0, bars: maxBars, at: new Date(lastBar.t).toISOString() }
      } else {
        pending++
        continue
      }
    }

    rec.outcome = outcome
    rs.push(outcome.r)
    resolved++
  }

  const wins = rs.filter((r) => r > 0).length
  return {
    resolved,
    pending,
    wins,
    losses: resolved - wins,
    winRate: resolved ? wins / resolved : 0,
    expectancyR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0,
    totalR: rs.reduce((a, b) => a + b, 0),
    records: records.filter((r) => r.outcome),
  }
}

/**
 * Rebuild the injected higher-timeframe views from their own stores. The 4-hour
 * view is aggregated from stored hourly bars, since providers rarely serve 4h
 * directly and aggregating hourly into it is exact.
 */
export function loadContext(root, symbol) {
  const out = {}
  for (const [name, cfg] of Object.entries(CONTEXT_STREAMS)) {
    const series = new CandleStore(root, symbol + cfg.suffix).load()
    if (series.length) out[name] = series
  }
  if (out.trend?.length) out.macro = aggregate(out.trend, '4h')
  return out
}

const safe = (s) => s.replace(/[^A-Za-z0-9_-]/g, '_')

function readState(path) {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n')
}
