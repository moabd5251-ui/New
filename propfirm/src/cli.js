#!/usr/bin/env node
/**
 * Command line interface.
 *
 *   node src/cli.js demo                          run on generated data
 *   node src/cli.js analyze --csv nq_1m.csv       read the current setup
 *   node src/cli.js backtest --csv nq_1m.csv      full backtest + HTML report
 *   node src/cli.js levels   --csv nq_1m.csv      today's levels and liquidity
 *   node src/cli.js stats    --journal j.jsonl    performance from the journal
 */

import { writeFileSync, readFileSync } from 'node:fs'
import { loadCandles, writeCandles } from './data/csv.js'
import { fetchYahoo, YAHOO_SYMBOLS, YAHOO_LIMITS } from './data/providers/yahoo.js'
import { fetchTradier, tradierHistory, tradierExpirations, tradierChain } from './data/providers/tradier.js'
import { fetchDatabento, databentoCost, CONTINUOUS, DEFAULT_DATASET } from './data/providers/databento.js'
import { auditSeries, formatAudit } from './data/quality.js'
import { CandleStore } from './data/store.js'
import { collect, resolveForward, ENGINE_VERSION, CONTEXT_STREAMS } from './data/collector.js'
import { generateSeries } from './data/synthetic.js'
import { Market } from './data/market.js'
import { TradingSystem } from './engine/system.js'
import { backtest } from './backtest/backtest.js'
import { PropAccount, INSTRUMENTS, ACCOUNT_PRESETS, equityInstrument } from './risk/propfirm.js'
import { sizePosition } from './risk/sizing.js'
import { riskCurve, requiredEdge } from './risk/survival.js'
import { recordOvernight, loadOvernight, overnightScorecard, OVERNIGHT_SPEC, BACKTEST_REFERENCE } from './research/overnight.js'
import { recordMondays, mondayScorecard, MONDAY_RTH_SPEC, MONDAY_BACKTEST_REFERENCE } from './research/mondayrth.js'
import { SWEEP_SPEC, SWEEP_BACKTEST, recordSweeps, loadSweeps, sweepScorecard } from './research/sweep.js'
import { TRENDCONT_SPEC, TRENDCONT_BACKTEST, recordTrendSetups, loadTrendSetups, trendScorecard } from './research/trendcont.js'
import { OPTIONSCAN_SPEC, findReaction, buildVertical, pickExpiration, sizeContracts, loadJournal, saveJournal, appendCandidates, resolveExpired, scanScorecard } from './research/optionscan.js'
import { renderOptionsPage } from './report/optionspage.js'
import { analyzeChart, targetFor, assessSpread } from './research/chartanalysis.js'
import { BUTTERFLY_SPEC, buildButterfly, sizeFlies, butterflyJournalPath, resolveExpiredFlies, butterflyScorecard } from './research/butterfly.js'
import { Journal } from './journal/journal.js'
import { buildStats, recommendations } from './journal/stats.js'
import { renderReport } from './report/html.js'
import { sessionOf, inKillzone, macroWindowOf } from './core/sessions.js'

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) args[key] = true
      else {
        args[key] = next
        i++
      }
    } else args._.push(a)
  }
  return args
}

/**
 * Resolve the bar series from whichever source was asked for, then audit it.
 * Nothing runs on data that cannot support the engine.
 */
async function getCandles(args, { audit = true } = {}) {
  let candles
  let label

  if (args.csv) {
    const { candles: loaded, problems } = loadCandles(args.csv)
    if (problems.length) {
      console.error(C.red(`Data problems in ${args.csv}:`))
      for (const p of problems) console.error(`  ${p}`)
      process.exit(1)
    }
    candles = loaded
    label = args.csv
  } else if (args.source === 'yahoo') {
    const symbol = resolveYahooSymbol(args.symbol ?? 'NQ')
    const interval = String(args.interval ?? '1m')
    const range = String(args.range ?? '7d')
    console.error(C.dim(`Fetching ${symbol} ${interval} (${range}) from Yahoo…`))
    const out = await fetchYahoo({ symbol, interval, range })
    candles = out.candles
    label = `yahoo:${symbol} ${interval}/${range}`
    if (out.meta.droppedUnclosedBar) console.error(C.dim(`  dropped in-progress bar at ${out.meta.droppedUnclosedBar}`))
    if (out.meta.droppedNullRows) console.error(C.dim(`  dropped ${out.meta.droppedNullRows} empty row(s)`))
  } else if (args.source === 'databento') {
    const symbols = args.symbols ?? CONTINUOUS[String(args.symbol ?? 'NQ').toUpperCase()] ?? args.symbol
    const schema = String(args.schema ?? 'ohlcv-1m')
    const { start, end } = dateWindow({ ...args, days: args.days ?? 730 })
    console.error(C.dim(`Pricing ${symbols} ${schema} ${start} → ${end} from Databento…`))
    const out = await fetchDatabento({
      symbols,
      schema,
      start,
      end,
      maxCostUsd: Number(args.maxCost ?? 5),
      onProgress: (p) => {
        if (p.phase === 'cost') console.error(C.yellow(`  this query costs $${p.cost.toFixed(2)}`))
        else process.stderr.write(C.dim(`  ${p.from} → ${p.to}: ${p.bars} bars (${p.total} total)\n`))
      },
    })
    candles = out.candles
    label = `databento:${symbols} ${schema}`
    console.error(C.dim(`  billed $${out.meta.costUsd.toFixed(2)}`))
  } else if (args.source === 'tradier') {
    const symbol = String(args.symbol ?? 'QQQ').toUpperCase()
    const { start, end } = dateWindow(args)
    console.error(C.dim(`Fetching ${symbol} ${args.interval ?? '1min'} from Tradier, ${start} → ${end}…`))
    const out = await fetchTradier({
      symbol,
      interval: String(args.interval ?? '1min'),
      start,
      end,
      onProgress: ({ day, bars }) => process.stderr.write(C.dim(`  ${day}: ${bars} bars\n`)),
    })
    candles = out.candles
    label = `tradier:${symbol}`
    if (out.meta.note) console.error(C.yellow(`  ${out.meta.note}`))
  } else {
    const days = Number(args.days ?? 30)
    console.error(C.yellow(`No data source given: using SYNTHETIC data (${days} days, seed ${args.seed ?? 42}).`))
    console.error(C.yellow('Synthetic results measure whether the code works, never whether the strategy has an edge.'))
    console.error(C.dim('Use --source yahoo (NQ futures) or --source tradier (equities), or --csv <file>.'))
    candles = generateSeries({ days, seed: Number(args.seed ?? 42) })
    label = 'synthetic'
  }

  if (audit) {
    const report = auditSeries(candles)
    console.error(C.dim(`\n  DATA — ${label}`))
    console.error(formatAudit(report))
    console.error('')
    if (!report.tradeable) {
      console.error(C.red('  This data cannot support the system. Fix the problems above first.\n'))
      process.exit(1)
    }
  }
  return candles
}

function resolveYahooSymbol(sym) {
  const upper = String(sym).toUpperCase()
  return YAHOO_SYMBOLS[upper] ?? sym
}

/** Default to the last N calendar days when no explicit window is given. */
function dateWindow(args) {
  const days = Number(args.days ?? 15)
  const end = args.end ?? new Date().toISOString().slice(0, 10)
  const start = args.start ?? new Date(Date.parse(`${end}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10)
  return { start, end }
}

function instrumentOf(args) {
  const sym = String(args.symbol ?? (args.source === 'tradier' ? 'QQQ' : 'NQ')).toUpperCase()
  if (INSTRUMENTS[sym]) return INSTRUMENTS[sym]
  // Tradier is equities-only, so an unrecognised ticker there is a share.
  if (args.source === 'tradier' || args.equity) return equityInstrument(sym)
  console.error(C.red(`Unknown symbol ${sym}. Known: ${Object.keys(INSTRUMENTS).join(', ')} (or pass --equity for any ticker)`))
  process.exit(1)
}

/* ── analyze: what is the system seeing right now? ──────────────────────── */

async function cmdAnalyze(args) {
  const candles = await getCandles(args)
  const instrument = instrumentOf(args)
  const market = new Market(candles, { instrument })
  const system = new TradingSystem(configFrom(args))
  const i = candles.length - 1
  const bar = candles[i]

  console.log(C.bold(`\n  ${instrument.symbol} @ ${bar.c.toFixed(2)}  ${new Date(bar.t).toISOString()}`))
  console.log(C.dim(`  session ${sessionOf(bar.t)}${inKillzone(bar.t) ? ' (killzone)' : ''}${macroWindowOf(bar.t) ? ` · ${macroWindowOf(bar.t)}` : ''}\n`))

  const { signal, rejected, steps } = system.evaluate(market, i)

  section('STEP 1 — CONTEXT')
  if (steps.context) {
    const c = steps.context
    console.log(`  bias      ${c.bias ? C.bold(c.bias.toUpperCase()) : C.dim('none')}   confidence ${fmtConf(c.confidence)}`)
    console.log(`  cycle     ${c.cycle}`)
    for (const r of c.reasons) console.log(C.green(`  + ${r}`))
    for (const r of c.conflicts) console.log(C.red(`  - ${r}`))
  } else console.log(C.dim('  not evaluated'))

  section('STEP 2 — CONFIRMATION')
  if (steps.confirmation) {
    const c = steps.confirmation
    console.log(`  confirmed ${c.confirmed ? C.green('yes') : C.red('no')}   confidence ${fmtConf(c.confidence)}`)
    for (const r of c.reasons) console.log(C.green(`  + ${r}`))
    for (const r of c.conflicts) console.log(C.red(`  - ${r}`))
  } else console.log(C.dim('  not evaluated'))

  section('STEP 3 — TRIGGER & ORDERFLOW')
  if (steps.trigger) {
    const t = steps.trigger
    console.log(`  model     ${t.model ?? C.dim('none')}   fired ${t.fired ? C.green('yes') : C.red('no')}`)
    if (t.gate) console.log(`  gate      ${t.gate.pass ? C.green('pass') : C.red('fail')} (${t.gate.score.toFixed(2)})${t.gate.isProxy ? C.yellow('  [orderflow estimated from bars]') : ''}`)
    for (const r of t.reasons) console.log(C.green(`  + ${r}`))
    for (const r of t.conflicts ?? []) console.log(C.red(`  - ${r}`))
  } else console.log(C.dim('  not evaluated'))

  if (!signal) {
    console.log(`\n  ${C.yellow('NO TRADE')} — ${rejected}\n`)
    return
  }

  const account = new PropAccount({ preset: args.account ?? '50K', instrument })
  const sizing = sizePosition({ account, signal, instrument })

  section('TRADE PLAN')
  console.log(`  ${C.bold(signal.direction.toUpperCase())} ${signal.model}   grade ${gradeColour(signal.grade)}  score ${signal.score.toFixed(2)}`)
  console.log(`  entry     ${signal.entry.toFixed(2)}`)
  console.log(`  stop      ${signal.stop.toFixed(2)}   (${signal.riskPoints.toFixed(2)} pts)`)
  for (const t of signal.targets) console.log(`  target    ${t.price.toFixed(2)}   ${t.r}R  ${C.dim(t.label)}`)
  console.log(`  R:R       ${signal.rr}`)
  if (sizing.allowed) {
    console.log(`  size      ${C.bold(`${sizing.contracts} ${sizing.symbol}`)} ${C.dim(sizing.unit)}   risking ${C.bold(`$${sizing.riskDollars.toFixed(0)}`)}  ${C.dim(`(limited by ${sizing.limitedBy})`)}`)
  } else {
    console.log(`  size      ${C.red('no position')} — ${sizing.reason}`)
  }
  console.log()
}

/* ── levels: the map for the session ────────────────────────────────────── */

async function cmdLevels(args) {
  const candles = await getCandles(args)
  const instrument = instrumentOf(args)
  const market = new Market(candles, { instrument })
  const i = candles.length - 1
  const price = candles[i].c

  console.log(C.bold(`\n  ${instrument.symbol} @ ${price.toFixed(2)}\n`))

  section('LIQUIDITY (unswept, nearest first)')
  const pools = market
    .poolsAt('micro', i)
    .filter((p) => !p.swept)
    .map((p) => ({ ...p, d: Math.abs(p.price - price) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 14)
  for (const p of pools) {
    const side = p.side === 'buyside' ? C.green('buyside ') : C.red('sellside')
    console.log(`  ${side}  ${p.price.toFixed(2).padStart(10)}  ${C.dim(`${p.d.toFixed(1).padStart(7)} pts  ${p.origin}${p.touches > 1 ? ` x${p.touches}` : ''}`)}`)
  }

  section('ORDERFLOW')
  const f = market.orderflow.at(i)
  console.log(`  POC       ${fmtN(f.poc)}  ${f.price > f.poc ? C.green('price above') : C.red('price below')}`)
  console.log(`  VWAP      ${fmtN(f.vwap)}  ${C.dim(`bands ${fmtN(f.vwapLower1)} / ${fmtN(f.vwapUpper1)}`)}`)
  console.log(`  CVD       ${fmtN(f.cvd, 0)}   last-bar delta ${fmtN(f.delta, 0)}`)
  console.log(`  rel vol   ${fmtN(f.relVolume)}x`)
  console.log(C.yellow('  orderflow estimated from bars — not a depth-of-market feed'))

  section('RANGE')
  const pd = market.premiumDiscountAt('macro', i)
  const range = market.rangeAt('macro', i)
  if (range && pd) {
    console.log(`  4h range  ${range.low.toFixed(2)} – ${range.high.toFixed(2)}`)
    console.log(`  equilib.  ${range.equilibrium.toFixed(2)}`)
    console.log(`  zone      ${pd.zone}${pd.inOTE ? C.cyan('  (in OTE band)') : ''}`)
  } else console.log(C.dim('  insufficient structure'))
  console.log()
}

/* ── backtest ───────────────────────────────────────────────────────────── */

async function cmdBacktest(args) {
  const candles = await getCandles(args)
  const instrument = instrumentOf(args)
  const result = backtest({
    candles,
    systemConfig: configFrom(args),
    accountConfig: { preset: args.account ?? '50K', instrument },
    options: { journalPath: args.journal ?? null },
  })

  const s = result.stats
  section('RESULT')
  console.log(`  trades        ${s.count}`)
  console.log(`  win rate      ${(s.winRate * 100).toFixed(1)}%`)
  console.log(`  expectancy    ${colourR(s.expectancyR)}R per trade`)
  console.log(`  total         ${colourR(s.totalR)}R   ${colourMoney(s.totalDollars)}`)
  console.log(`  profit factor ${s.profitFactor.toFixed(2)}`)
  console.log(`  max drawdown  ${s.maxDrawdownR.toFixed(2)}R`)
  if (s.sampleWarning) console.log(C.yellow(`  ${s.sampleWarning}`))

  section('ACCOUNT')
  const snap = result.account.snapshot()
  console.log(`  balance       ${colourMoney(snap.balance - result.account.startingBalance)} → $${snap.balance.toFixed(0)}`)
  console.log(`  floor         $${snap.floor.toFixed(0)}${snap.floorLocked ? C.green(' (locked)') : ''}`)
  console.log(`  status        ${snap.breached ? C.red('BREACHED — ' + snap.breachReason) : snap.passed ? C.green('PASSED') : 'active'}`)
  console.log(`  consistency   ${result.consistency.ok ? C.green('ok') : C.yellow(result.consistency.note)}`)

  section('BY MODEL')
  table(s.byModel)
  section('BY SESSION')
  table(s.bySession)

  section('WHY MOST BARS WERE SKIPPED')
  for (const [reason, n] of result.rejections.slice(0, 8)) console.log(`  ${String(n).padStart(6)}  ${C.dim(reason)}`)

  const out = args.report ?? 'backtest-report.html'
  writeFileSync(out, renderReport(result, { title: `${instrument.symbol} — Backtest Report` }))
  console.log(`\n  report written to ${C.cyan(out)}\n`)
}

/* ── fetch: pull data down to a CSV for repeated use ────────────────────── */

async function cmdFetch(args) {
  if (!args.source) {
    console.error(C.red('--source yahoo|tradier is required'))
    process.exit(1)
  }
  const candles = await getCandles(args, { audit: true })
  const out = args.out ?? `${String(args.symbol ?? (args.source === 'tradier' ? 'QQQ' : 'NQ')).replace(/[^A-Za-z0-9]/g, '')}_${args.interval ?? '1m'}.csv`
  writeCandles(out, candles)
  console.log(`  ${candles.length} bars written to ${C.cyan(out)}`)
  console.log(C.dim(`  reuse with: node src/cli.js backtest --csv ${out}\n`))
}

/* ── collect: accumulate 1m history past the provider's window ──────────── */

const DEFAULT_STORE = 'data'

async function cmdCollect(args) {
  const source = args.source ?? 'yahoo'
  if (source === 'databento') return cmdCollectDatabento(args)
  const symbol = source === 'yahoo' ? resolveYahooSymbol(args.symbol ?? 'NQ') : String(args.symbol ?? 'QQQ').toUpperCase()
  const root = args.store ?? DEFAULT_STORE
  const instrument = instrumentOf(args)

  const candles = await getCandles({ ...args, source, symbol, interval: args.interval ?? (source === 'tradier' ? '1min' : '1m') }, { audit: false })

  // Step 1 reads daily and 4h structure, which a one-week window of 1-minute
  // bars cannot provide. Pull those streams separately.
  const contextSeries = {}
  if (source === 'yahoo') {
    for (const [name, cfg] of Object.entries(CONTEXT_STREAMS)) {
      try {
        const out = await fetchYahoo({ symbol, interval: cfg.interval, range: cfg.range })
        contextSeries[name] = out.candles
        console.error(C.dim(`  context ${cfg.interval}: ${out.candles.length} bars`))
      } catch (err) {
        console.error(C.yellow(`  context ${cfg.interval} unavailable: ${err.message}`))
      }
    }
  }

  const result = collect({
    candles,
    root,
    symbol,
    instrument,
    contextSeries,
    paper: args.paper !== false && args.noPaper !== true,
    systemConfig: configFrom(args),
  })

  section('COLLECTED')
  console.log(`  fetched     ${result.fetched} bars`)
  console.log(`  new         ${C.green(String(result.added))} added, ${result.updated} revised, ${result.unchanged} already stored`)
  console.log(`  store       ${result.coverage.bars.toLocaleString()} bars over ${result.coverage.days} day(s)  ${C.dim(`${result.coverage.first ?? '—'} → ${result.coverage.last ?? '—'}`)}`)
  for (const [name, c] of Object.entries(result.context ?? {})) {
    console.log(`  context     ${name.padEnd(8)} ${String(c.bars).padStart(5)} bars ${C.dim(`(+${c.added})`)}`)
  }

  if (result.paper) {
    const p = result.paper
    if (p.note) {
      console.log(`  forward     ${C.dim(p.note)}`)
    } else {
      console.log(`  forward     evaluated ${p.evaluated} new bar(s), recorded ${C.bold(String(p.signals))} signal(s)`)
      for (const r of (p.records ?? []).slice(-5)) {
        console.log(`              ${C.dim(r.barTime)}  ${r.direction === 'long' ? C.green('LONG ') : C.red('SHORT')} ${r.model.padEnd(13)} ${gradeColour(r.grade)}  entry ${r.entry.toFixed(2)} stop ${r.stop.toFixed(2)}`)
      }
    }
  }

  // The container is ephemeral; the store only survives if it is committed.
  console.log(C.dim(`\n  Store lives in ${root}/. Commit it — this container does not persist.`))
  console.log(C.dim(`  Run this daily; Yahoo's window is 7 days, so anything longer than a week between runs loses bars.\n`))
}

/**
 * Databento collection writes each month into the store as it arrives, rather
 * than buffering the whole range. The data is billed on download, so it must be
 * on disk before any later step gets the chance to fail.
 */
async function cmdCollectDatabento(args) {
  const symbol = String(args.symbol ?? 'NQ').toUpperCase()
  const symbols = args.symbols ?? CONTINUOUS[symbol] ?? symbol
  const schema = String(args.schema ?? 'ohlcv-1m')
  const root = args.store ?? DEFAULT_STORE
  const instrument = instrumentOf(args)
  const { start, end } = dateWindow({ ...args, days: args.days ?? 730 })
  const store = new CandleStore(root, symbols)

  let added = 0
  const out = await fetchDatabento({
    symbols,
    schema,
    start,
    end,
    maxCostUsd: Number(args.maxCost ?? 5),
    retain: false,
    onChunk: (chunk) => {
      const m = store.merge(chunk)
      added += m.added
    },
    onProgress: (p) => {
      if (p.phase === 'cost') console.error(C.yellow(`  this query costs $${p.cost.toFixed(2)}`))
      else process.stderr.write(C.dim(`  ${p.from} → ${p.to}: ${p.bars} bars stored\n`))
    },
  })

  const cov = store.coverage()
  section('COLLECTED (databento)')
  console.log(`  billed      $${out.meta.costUsd.toFixed(2)}`)
  console.log(`  new         ${C.green(String(added))} bars added`)
  console.log(`  store       ${cov.bars.toLocaleString()} bars over ${cov.days} day(s)  ${C.dim(`${cov.first} → ${cov.last}`)}`)
  console.log(C.dim(`\n  Stored under ${root}/. Commit it — this container does not persist.\n`))
}

async function cmdForward(args) {
  const source = args.source ?? 'yahoo'
  const symbol = source === 'yahoo' ? resolveYahooSymbol(args.symbol ?? 'NQ') : String(args.symbol ?? 'QQQ').toUpperCase()
  const root = args.store ?? DEFAULT_STORE
  const store = new CandleStore(root, symbol)
  const cov = store.coverage()

  section(`FORWARD RECORD — ${symbol}`)
  console.log(`  store       ${cov.bars.toLocaleString()} bars over ${cov.days} day(s)  ${C.dim(`${cov.first ?? '—'} → ${cov.last ?? '—'}`)}`)
  console.log(`  engine      v${ENGINE_VERSION}`)

  const out = resolveForward({ root, symbol })
  console.log(`  signals     ${out.resolved} resolved, ${out.pending} still open`)
  if (!out.resolved) {
    console.log(C.dim('\n  Nothing resolved yet. Keep collecting.\n'))
    return
  }
  console.log(`  win rate    ${(out.winRate * 100).toFixed(1)}%`)
  console.log(`  expectancy  ${colourR(out.expectancyR)}R per signal`)
  console.log(`  total       ${colourR(out.totalR)}R`)

  const byModel = {}
  for (const r of out.records) {
    const k = r.model
    byModel[k] ??= { n: 0, sum: 0 }
    byModel[k].n++
    byModel[k].sum += r.outcome.r
  }
  section('BY MODEL')
  for (const [k, v] of Object.entries(byModel).sort((a, b) => b[1].sum / b[1].n - a[1].sum / a[1].n)) {
    console.log(`  ${k.padEnd(14)} ${String(v.n).padStart(4)} signals  ${colourR(v.sum / v.n)}R`)
  }

  if (out.resolved < 30) {
    console.log(C.yellow(`\n  ${out.resolved} resolved signals is not yet a sample. Do not act on these numbers.`))
  }
  console.log(C.dim('\n  These are paper signals: no fill, no slippage, no commission.\n'))
}

/* ── overnight: forward-validate the Globex-open capture, paper only ────── */

function cmdOvernight(args) {
  const source = args.source ?? 'yahoo'
  const symbol = source === 'yahoo' ? resolveYahooSymbol(args.symbol ?? 'NQ') : String(args.symbol ?? 'NQ').toUpperCase()
  const root = args.store ?? DEFAULT_STORE

  const { path, added, records, total } = recordOvernight({ root, symbol })
  section(`OVERNIGHT FORWARD — ${symbol} (spec v${OVERNIGHT_SPEC.version}, registered ${OVERNIGHT_SPEC.registered})`)
  console.log(`  journal     ${C.cyan(path)}`)
  console.log(`  new nights  ${added ? C.green(String(added)) : '0'}  (${total} total)`)
  for (const r of records) {
    const v = r.variants.s100
    console.log(`              ${r.night}  entry ${r.entry.toFixed(2)} → 9:30 ${r.exit930.toFixed(2)}  100pt-stop ${colourR(v.pts)}pt ${C.dim(`(${v.exit})`)}`)
  }

  const all = loadOvernight(path)
  if (!all.length) {
    console.log(C.dim('\n  Nothing recorded yet. Nights accrue as collection runs.\n'))
    return
  }
  const card = overnightScorecard(all)
  section('RUNNING SCORECARD (paper, 1 MNQ)')
  console.log('  variant   nights   mean/night   total     win%   worst   stops   sim balance')
  for (const [key, v] of Object.entries(card.variants)) {
    if (!v.n) continue
    const status = v.breached ? C.red(`breached ${v.breached}`) : v.passed ? C.green(`passed ${v.passed}`) : ''
    console.log(
      `  ${key.padEnd(8)} ${String(v.n).padStart(5)}   ${colourR(v.meanPts).padStart(14)}pt ${colourR(v.totalPts).padStart(12)}pt   ${(v.winRate * 100).toFixed(0).padStart(3)}%  ${String(v.worstPts.toFixed(0)).padStart(6)}  ${String(v.stops).padStart(5)}   $${v.balance.toFixed(0)} ${status}`,
    )
  }
  console.log(C.dim(`\n  Backtest reference: ${BACKTEST_REFERENCE.meanPtsNoStop}pt/night over ${BACKTEST_REFERENCE.window} (sd ${BACKTEST_REFERENCE.sdPts}pt).`))
  console.log(C.dim(`  Under ~30 nights the mean is noise — judge nothing before that.`))
  if (card.nights < 30) console.log(C.yellow(`  ${card.nights} night(s) so far: keep collecting.`))
  console.log(C.dim('\n  Paper only. No orders are placed by anything in this repository.\n'))
}

/* ── monday: forward-validate the Monday day-session cell, paper only ───── */

function cmdMonday(args) {
  const source = args.source ?? 'yahoo'
  const symbol = source === 'yahoo' ? resolveYahooSymbol(args.symbol ?? 'NQ') : String(args.symbol ?? 'NQ').toUpperCase()
  const root = args.store ?? DEFAULT_STORE

  const { path, added, records, total } = recordMondays({ root, symbol })
  section(`MONDAY RTH FORWARD — ${symbol} (spec v${MONDAY_RTH_SPEC.version}, registered ${MONDAY_RTH_SPEC.registered})`)
  console.log(`  journal     ${C.cyan(path)}`)
  console.log(`  new         ${added ? C.green(String(added)) : '0'} Monday(s)  (${total} total)`)
  for (const r of records) {
    console.log(`              ${r.monday}  9:30 ${r.entry.toFixed(2)} → 16:00 ${r.exit1600.toFixed(2)}  no-stop ${colourR(r.variants.none.pts)}pt`)
  }

  const all = loadOvernight(path)
  if (!all.length) return console.log(C.dim('\n  Nothing recorded yet. Mondays accrue weekly — this one is slow by nature.\n'))
  const card = mondayScorecard(all)
  section('RUNNING SCORECARD (paper, 1 MNQ)')
  for (const [key, v] of Object.entries(card.variants)) {
    if (!v.n) continue
    console.log(`  ${key.padEnd(6)} ${String(v.n).padStart(4)} Mondays  mean ${colourR(v.meanPts)}pt  total ${colourR(v.totalPts)}pt  win ${(v.winRate * 100).toFixed(0)}%  worst ${v.worstPts.toFixed(0)}  stops ${v.stops}`)
  }
  console.log(C.dim(`\n  Backtest reference: +${MONDAY_BACKTEST_REFERENCE.meanPtsInSample}/+${MONDAY_BACKTEST_REFERENCE.meanPtsOutOfSample}pt over ${MONDAY_BACKTEST_REFERENCE.window}.`))
  console.log(C.yellow(`  Caution on the record: ${MONDAY_BACKTEST_REFERENCE.caution}.`))
  console.log(C.dim('  ~50 Mondays is a year. This hypothesis earns patience, not money.\n'))
}

/* ── sweep: NY-open liquidity sweep reversal, registered forward test ───── */

function cmdSweep(args) {
  const source = args.source ?? 'yahoo'
  const symbol = source === 'yahoo' ? resolveYahooSymbol(args.symbol ?? 'NQ') : String(args.symbol ?? 'NQ').toUpperCase()
  const root = args.store ?? DEFAULT_STORE

  // ES is the SMT companion for NQ and vice versa; absent, SMT stays null.
  const companion = args.companion ?? (symbol.includes('NQ') ? 'ES.v.0' : symbol.includes('ES') ? 'NQ.v.0' : null)
  const { path, added, records, total } = recordSweeps({ root, symbol, companionSymbol: companion })
  section(`SWEEP REVERSAL FORWARD — ${symbol} (spec v${SWEEP_SPEC.version}, registered ${SWEEP_SPEC.registered})`)
  console.log(`  journal     ${C.cyan(path)}`)
  console.log(`  new setups  ${added ? C.green(String(added)) : '0'}  (${total} total)`)
  for (const r of records) {
    console.log(
      `              ${r.day}  ${r.direction === 'long' ? C.green('LONG ') : C.red('SHORT')} ${r.level.padEnd(15)} ` +
        `risk ${r.riskPts.toFixed(1)}pt  ${colourR(r.r)}R  ${C.dim(r.reason)}${r.choch ? C.cyan('  CHoCH') : ''}`,
    )
  }

  const all = loadSweeps(path)
  if (!all.length) {
    console.log(C.dim('\n  Nothing recorded yet. Measured frequency is ~1.9 setups a month with every'))
    console.log(C.dim('  filter on, so patience is the expected experience here.\n'))
    return
  }

  const card = sweepScorecard(all)
  section('RUNNING SCORECARD (paper, both variants, never pooled)')
  for (const [name, v] of [['every filter', card.withChoch], ['CHoCH dropped', card.noChoch]]) {
    if (!v.n) { console.log(`  ${name.padEnd(14)} ${C.dim('no trades yet')}`); continue }
    console.log(
      `  ${name.padEnd(14)} n ${String(v.n).padStart(4)}  exp ${colourR(v.expR)}R  win ${(v.winRate * 100).toFixed(0)}%  ` +
        `avgWin ${v.avgWin.toFixed(2)}R  PF ${v.profitFactor.toFixed(2)}  t ${(v.tStat >= 0 ? '+' : '') + v.tStat.toFixed(1)}`,
    )
    console.log(
      C.dim(`                 median ${v.medianR.toFixed(2)}R · top-5 share ${(v.topFiveShare * 100).toFixed(0)}% · ` +
        `worst streak ${v.worstStreak} · ${v.perMonth ? v.perMonth.toFixed(1) + '/month' : '—'} · ${v.totalPts.toFixed(0)}pt`),
    )
  }

  if (card.smt?.tagged) {
    section('SMT DIVERGENCE vs the companion index (recorded, never filtered on)')
    const f = (x) => (x.meanR === null ? '—' : `${(x.meanR >= 0 ? '+' : '') + x.meanR.toFixed(3)}R`)
    console.log(`  divergent — companion did NOT sweep   n ${String(card.smt.divergent.n).padStart(4)}   ${f(card.smt.divergent)}`)
    console.log(`  confirmed — both indices swept        n ${String(card.smt.confirmed.n).padStart(4)}   ${f(card.smt.confirmed)}`)
    console.log(C.dim(`  Pre-registration: +${SWEEP_BACKTEST.smt.divergentR}R divergent vs +${SWEEP_BACKTEST.smt.confirmedR}R confirmed.`))
    console.log(C.dim(`  ${SWEEP_BACKTEST.smt.note}.`))
  }

  section("THE PLAYBOOK'S OWN GO-LIVE GATE")
  const g = card.withChoch
  if (!g.n) console.log(C.dim('  no qualifying trades yet'))
  else {
    console.log(`  ≥ 30 trades?        ${String(g.n).padStart(4)}   ${g.n >= 30 ? C.green('PASS') : C.yellow('not yet')}`)
    console.log(`  win rate ≥ 40%?    ${(g.winRate * 100).toFixed(1)}%   ${g.winRate >= 0.4 ? C.green('PASS') : C.red('FAIL')}`)
    console.log(`  avg winner ≥ 1.8R? ${g.avgWin.toFixed(2)}R   ${g.avgWin >= 1.8 ? C.green('PASS') : C.red('FAIL')}`)
  }
  console.log(C.dim(`\n  Pre-registration measurement: ${SWEEP_BACKTEST.withChoch.isR}R IS / ${SWEEP_BACKTEST.withChoch.oosR}R OOS`))
  console.log(C.dim(`  against a random control at ${SWEEP_BACKTEST.randomControl.isR}R / ${SWEEP_BACKTEST.randomControl.oosR}R.`))
  console.log(C.yellow(`  Caution on that record: ${SWEEP_BACKTEST.caution}.`))
  console.log(C.dim('\n  Paper only — nothing here places orders.\n'))
}

/* ── trend: Playbook B killzone continuation, registered forward test ───── */

function cmdTrend(args) {
  const source = args.source ?? 'yahoo'
  const symbol = source === 'yahoo' ? resolveYahooSymbol(args.symbol ?? 'NQ') : String(args.symbol ?? 'NQ').toUpperCase()
  const root = args.store ?? DEFAULT_STORE

  const { path, added, records, total } = recordTrendSetups({ root, symbol })
  section(`TREND CONTINUATION FORWARD — ${symbol} (spec v${TRENDCONT_SPEC.version}, registered ${TRENDCONT_SPEC.registered})`)
  console.log(`  journal     ${C.cyan(path)}`)
  console.log(`  new setups  ${added ? C.green(String(added)) : '0'}  (${total} total)`)
  for (const r of records) {
    console.log(
      `              ${r.day}  ${r.direction === 'long' ? C.green('LONG ') : C.red('SHORT')} risk ${r.riskPts.toFixed(1)}pt  ` +
        `${colourR(r.r)}R  ${C.dim(r.reason)}${r.valueArea?.entryInValueArea ? C.dim('  in-VA') : ''}`,
    )
  }

  const all = loadTrendSetups(path)
  if (!all.length) {
    console.log(C.dim('\n  Nothing recorded yet. Measured frequency is ~22 setups a month, so this'))
    console.log(C.dim('  journal fills far faster than the sweep one — 30 trades in about six weeks.\n'))
    return
  }

  const c = trendScorecard(all)
  section('RUNNING SCORECARD (paper)')
  console.log(
    `  n ${String(c.n).padStart(4)}  exp ${colourR(c.expR)}R  win ${(c.winRate * 100).toFixed(0)}%  avgWin ${c.avgWin.toFixed(2)}R  ` +
      `PF ${c.profitFactor.toFixed(2)}  t ${(c.tStat >= 0 ? '+' : '') + c.tStat.toFixed(1)}`,
  )
  console.log(
    C.dim(`        median ${c.medianR.toFixed(2)}R · top-5 share ${(c.topFiveShare * 100).toFixed(0)}% · ` +
      `worst streak ${c.worstStreak} · ${c.perMonth ? c.perMonth.toFixed(1) + '/month' : '—'}`),
  )

  const v = c.valueArea
  if (v.inside.n || v.outside.n) {
    section('LEVEL QUALITY — prior-day value area (recorded, never filtered on)')
    const f = (x) => (x.meanR === null ? '—' : `${(x.meanR >= 0 ? '+' : '') + x.meanR.toFixed(3)}R`)
    console.log(`  entry inside the value area   n ${String(v.inside.n).padStart(4)}   ${f(v.inside)}`)
    console.log(`  entry outside it              n ${String(v.outside.n).padStart(4)}   ${f(v.outside)}`)
    console.log(C.dim('  Pre-registration measurement said OUTSIDE was better in both halves'))
    console.log(C.dim('  (+0.182R vs +0.017R IS, +0.268R vs +0.230R OOS) — the opposite of the'))
    console.log(C.dim('  usual claim that value-area levels are higher quality.'))
  }

  section("THE PLAYBOOK'S OWN GO-LIVE GATE")
  console.log(`  ≥ 30 trades?        ${String(c.n).padStart(4)}   ${c.n >= 30 ? C.green('PASS') : C.yellow('not yet')}`)
  console.log(`  win rate ≥ 40%?    ${(c.winRate * 100).toFixed(1)}%   ${c.winRate >= 0.4 ? C.green('PASS') : C.red('FAIL')}`)
  console.log(`  avg winner ≥ 1.8R? ${c.avgWin.toFixed(2)}R   ${c.avgWin >= 1.8 ? C.green('PASS') : C.red('FAIL')}`)
  console.log(C.dim(`\n  Pre-registration: ${TRENDCONT_BACKTEST.isR}R IS (n ${TRENDCONT_BACKTEST.isN}) / ${TRENDCONT_BACKTEST.oosR}R OOS (n ${TRENDCONT_BACKTEST.oosN}).`))
  console.log(C.dim(`  Randomise the direction → ${TRENDCONT_BACKTEST.withoutBias.isR}R / ${TRENDCONT_BACKTEST.withoutBias.oosR}R. Skip the FVG → ${TRENDCONT_BACKTEST.withoutFvg.isR}R / ${TRENDCONT_BACKTEST.withoutFvg.oosR}R.`))
  console.log(C.yellow(`  ${TRENDCONT_BACKTEST.caution}.`))
  console.log(C.dim('\n  Paper only — nothing here places orders.\n'))
}

/* ── options: post-reaction debit-spread scanner, paper journal ─────────── */

async function cmdOptions(args) {
  const root = args.store ?? DEFAULT_STORE
  const watchlistPath = args.watchlist ?? `${root}/options-watchlist.json`
  const journalPath = args.journal ?? `${root}/options-scan.jsonl`
  const symbols = JSON.parse(readFileSync(watchlistPath, 'utf8'))
  const today = new Date().toISOString().slice(0, 10)

  section(`OPTIONS SCAN — ${symbols.length} names (spec v${OPTIONSCAN_SPEC.version}, registered ${OPTIONSCAN_SPEC.registered})`)

  const records = loadJournal(journalPath)
  const historyCache = new Map()
  const historyFor = async (sym) => {
    if (!historyCache.has(sym)) historyCache.set(sym, await tradierHistory(sym))
    return historyCache.get(sym)
  }

  // 1. Settle anything that has expired — the scorecard is the point.
  const settled = await resolveExpired(records, today, historyFor)
  if (settled) console.log(`  resolved    ${C.green(String(settled))} expired position(s)`)

  // 2. Scan for new reactions.
  const candidates = []
  const flyCandidates = []
  const flyNotes = []
  const charts = new Map()
  for (const symbol of symbols) {
    try {
      const bars = await historyFor(symbol)
      const reaction = findReaction(bars)
      if (!reaction) continue
      const expirations = await tradierExpirations(symbol)
      const exp = pickExpiration(expirations, today)
      if (!exp) {
        console.log(`  ${symbol.padEnd(6)} reaction ${reaction.reactionDay} ${reaction.direction} — ${C.dim('no expiration in 20–45 DTE')}`)
        continue
      }
      const chain = await tradierChain(symbol, exp.d)

      // Chart analysis runs for every reaction, whether or not a structure
      // ends up being built — it is the record of what the name looked like
      // at the moment the signal fired.
      const chart = analyzeChart(bars)
      const target = targetFor(chart, reaction.direction)
      charts.set(symbol, { chart, target, reaction, expiration: exp.d })

      // Butterfly candidate, centred on the chart target. Independent of the
      // vertical: a name can qualify for one, both, or neither.
      if (chart && target) {
        const { fly, reason: flyReason } = buildButterfly(chain, reaction.direction, target.price, chart.price, chart.atr)
        if (fly) {
          const n = sizeFlies(fly.debit)
          if (n) {
            flyCandidates.push({
              spec: BUTTERFLY_SPEC.version, scanDate: today, symbol,
              reactionDay: reaction.reactionDay, direction: reaction.direction,
              gapPct: Math.round(reaction.gapPct * 1000) / 10,
              expiration: exp.d, dte: exp.dte, fly, contracts: n,
              riskUsd: Math.round(fly.debit * 100 * n),
              target: { price: target.price, basis: target.basis, atrAway: Math.round(target.atrAway * 100) / 100, inferred: target.inferred },
              chart: { trend: chart.trend, zone: chart.zone, atr: Math.round(chart.atr * 100) / 100 },
            })
          }
        } else flyNotes.push(`${symbol}: ${flyReason}`)
      }

      const { spread, reason } = buildVertical(chain, reaction.direction)
      if (!spread) {
        console.log(`  ${symbol.padEnd(6)} reaction ${reaction.reactionDay} ${reaction.direction} — ${C.dim(reason)}`)
        continue
      }
      const contracts = sizeContracts(spread.debit)
      if (!contracts) {
        console.log(`  ${symbol.padEnd(6)} ${C.dim(`debit $${(spread.debit * 100).toFixed(0)} exceeds the risk budget — skipped`)}`)
        continue
      }
      candidates.push({
        spec: OPTIONSCAN_SPEC.version,
        scanDate: today,
        symbol,
        reactionDay: reaction.reactionDay,
        direction: reaction.direction,
        gapPct: Math.round(reaction.gapPct * 1000) / 10,
        expiration: exp.d,
        dte: exp.dte,
        spread,
        contracts,
        riskUsd: Math.round(spread.debit * 100 * contracts),
        // What the chart looked like when this fired, and whether the payoff
        // this structure caps at is actually reachable from here.
        chart: chart ? { trend: chart.trend, zone: chart.zone, atr: Math.round(chart.atr * 100) / 100, price: chart.price } : null,
        assessment: assessSpread(spread, chart, reaction.direction),
      })
    } catch (err) {
      console.log(`  ${symbol.padEnd(6)} ${C.red(err.message)}`)
    }
  }

  const { records: updated, added } = appendCandidates(records, candidates)
  saveJournal(journalPath, updated)

  // ── Butterfly journal: separate file, separate spec, never pooled ───────
  const flyPath = butterflyJournalPath(root, 'options')
  const flyRecords = loadJournal(flyPath)
  const flySettled = await resolveExpiredFlies(flyRecords, today, historyFor)
  const { records: flyUpdated, added: flyAdded } = appendCandidates(flyRecords, flyCandidates)
  saveJournal(flyPath, flyUpdated)

  section('CHART ANALYSIS (at the moment each signal fired)')
  if (!charts.size) console.log(C.dim('  no live reactions on the watchlist'))
  for (const [sym, { chart, target, reaction }] of charts) {
    if (!chart) { console.log(`  ${sym.padEnd(6)} ${C.dim('insufficient history')}`); continue }
    const arrow = reaction.direction === 'up' ? C.green('▲') : C.red('▼')
    console.log(`  ${C.bold(sym.padEnd(6))} ${arrow} ${chart.price.toFixed(2)}  trend ${chart.trend.padEnd(7)} ${chart.zone.padEnd(12)} ATR ${chart.atr.toFixed(2)} (${(chart.atrPct * 100).toFixed(1)}%)`)
    console.log(`         range ${chart.range.low.toFixed(2)}–${chart.range.high.toFixed(2)}, ${(chart.range.position * 100).toFixed(0)}% of it`)
    const fmtL = (l) => `${l.price.toFixed(2)}${l.touches > 1 ? C.cyan(`×${l.touches}`) : ''}`
    if (chart.resistance.length) console.log(`         resistance ${chart.resistance.map(fmtL).join('  ')}`)
    if (chart.support.length) console.log(`         support    ${chart.support.map(fmtL).join('  ')}`)
    if (target) console.log(`         target ${C.bold(target.price.toFixed(2))} — ${target.inferred ? C.yellow(target.basis) : target.basis} (${target.atrAway.toFixed(1)} ATR away)`)
  }

  section('BUTTERFLY CANDIDATES (parallel journal, centred on the chart target)')
  for (const n of flyNotes) console.log(`  ${C.dim(n)}`)
  if (!flyAdded.length) console.log(C.dim('  none new'))
  for (const c of flyAdded) {
    const f = c.fly
    console.log(
      `  ${C.bold(c.symbol.padEnd(6))} ${f.type === 'call' ? C.green('CALL') : C.red('PUT ')} fly ${f.lowerStrike}/${f.bodyStrike}/${f.upperStrike} ${c.expiration}  ` +
        `cost $${(f.debit * 100).toFixed(0)} ×${c.contracts}  max +$${(f.maxGain * 100 * c.contracts).toFixed(0)}  RR ${f.rewardRisk.toFixed(1)}`,
    )
    console.log(`         profit zone ${f.lowerBreakeven.toFixed(2)}–${f.upperBreakeven.toFixed(2)}  ${C.dim(`body on ${c.target.basis}`)}  ${C.red(`execution drag $${(f.executionDrag * 100 * c.contracts).toFixed(0)}`)}`)
  }
  if (flySettled) console.log(`  resolved    ${flySettled} expired butterfly position(s)`)
  const flyCard = butterflyScorecard(flyUpdated)
  if (flyUpdated.length) {
    console.log(`\n  open ${flyCard.open}   resolved ${flyCard.resolved}${flyCard.resolved ? `   in-zone ${(flyCard.inZoneRate * 100).toFixed(0)}%   mean ${colourR(flyCard.meanR)}R   median miss ${flyCard.medianMissWidths?.toFixed(2)} wing-widths` : ''}`)
    if (flyCard.resolved) {
      console.log(`  P&L crossing the spread ${colourMoney(flyCard.totalUsd)}   ·   filling at mid ${colourMoney(flyCard.totalAtMidUsd)}`)
    }
    console.log(C.red(`  slippage paid on entry so far: $${flyCard.executionDragUsd.toFixed(0)}`))
    console.log(C.yellow('  Priced on 2026-08-10 every available butterfly had NEGATIVE EV (−$58 to −$128)'))
    console.log(C.yellow('  against +$15 to +$52 on the verticals. This journal exists to test that verdict.'))
  }

  section('NEW CANDIDATES')
  if (!added.length) console.log(C.dim('  none — most days this is the correct output'))
  for (const c of added) {
    const s = c.spread
    console.log(
      `  ${C.bold(c.symbol.padEnd(6))} ${c.direction === 'up' ? C.green('CALL') : C.red('PUT ')} ${s.longStrike}/${s.shortStrike} ${c.expiration} (${c.dte}d)  ` +
        `debit $${(s.debit * 100).toFixed(0)} ×${c.contracts}  max +$${(s.maxGain * 100 * c.contracts).toFixed(0)}  RR ${s.rewardRisk.toFixed(2)}  ${C.dim(`gap ${c.gapPct}% on ${c.reactionDay}`)}`,
    )
  }

  if (args.html) {
    const chartRows = [...charts.entries()]
      .filter(([, v]) => v.chart)
      .map(([symbol, { chart, reaction }]) => ({
        symbol,
        price: chart.price,
        trend: chart.trend,
        zone: chart.zone,
        rangePosition: chart.range.position,
        atr: chart.atr,
        levels: (reaction.direction === 'up' ? chart.resistance : chart.support).slice(0, 3),
      }))
    writeFileSync(args.html, renderOptionsPage(updated, { flies: flyUpdated.filter((f) => !f.outcome), charts: chartRows }))
    console.log(`\n  page written to ${C.cyan(args.html)}`)
  }

  const card = scanScorecard(updated)
  section('FORWARD RECORD (paper, held to expiry)')
  console.log(`  open ${card.open}   resolved ${card.resolved}${card.resolved ? `   win ${(card.winRate * 100).toFixed(0)}%   mean ${colourR(card.meanR)}R   total ${colourMoney(card.totalUsd)}` : ''}`)
  console.log(`  clusters    ${card.expirations} distinct expiration(s), largest holds ${card.largestCluster}   open exposure ${colourMoney(-card.exposureUsd).replace('-', '')}`)
  if (card.largestCluster > 1) {
    console.log(C.dim(`              only one monthly falls in a ${OPTIONSCAN_SPEC.dteMin}–${OPTIONSCAN_SPEC.dteMax} DTE window, so same-day candidates always share it`))
  }
  if (card.resolved < 30) console.log(C.yellow(`  ${card.resolved} resolved is not a sample — and correlated records count for less than their number.`))
  console.log(C.dim('\n  Paper journal only — nothing here places orders. Commit data/ to keep it.\n'))
}

/* ── survival: what edge and what size actually pass an evaluation ──────── */

function cmdSurvival(args) {
  const preset = args.account ?? '50K'
  const winRate = Number(args.winRate ?? 0.45)
  const payoffRatio = Number(args.payoff ?? 2)
  const badRunProb = Number(args.clustering ?? 0.2)
  const edge = { winRate, payoffRatio, badRunProb, badRunDays: 5, badRunMultiplier: 0.45 }

  section(`RISK SIZING — ${preset}, ${(winRate * 100).toFixed(0)}% win at ${payoffRatio}R (${(winRate * payoffRatio - (1 - winRate)).toFixed(2)}R expectancy)`)
  console.log(C.dim(`  loss clustering: ${(badRunProb * 100).toFixed(0)}% of days start a bad run\n`))
  console.log('  risk%    $risk    pass   breach    PAID   median days')
  for (const r of riskCurve({ preset, edge, runs: Number(args.runs ?? 3000) })) {
    console.log(
      `  ${(r.riskFraction * 100).toFixed(1).padStart(5)}% ${String('$' + r.riskDollars.toFixed(0)).padStart(7)}  ${fmtPct(r.passRate)} ${fmtPct(r.breachRate)}  ${C.bold(fmtPct(r.paidRate))}   ${r.medianDaysToPass ?? '—'}`,
    )
  }
  console.log(C.dim('\n  PAID is the column that matters. Passing fast concentrates profit into'))
  console.log(C.dim('  one day and fails the consistency rule.'))

  section('REQUIRED EDGE (at 5% risk)')
  console.log('  win%   expectancy    PAID')
  for (const r of requiredEdge({ preset, payoffRatio, riskFraction: 0.05, runs: Number(args.runs ?? 1500) }).curve) {
    console.log(`  ${(r.winRate * 100).toFixed(0).padStart(4)}%   ${(r.expectancyR >= 0 ? '+' : '') + r.expectancyR.toFixed(2)}R       ${fmtPct(r.paidRate)}`)
  }
  console.log(C.dim('\n  Below break-even expectancy no position size helps. Sizing is how you'))
  console.log(C.dim('  keep an edge you already have — it cannot manufacture one.\n'))
}

/* ── stats from a journal ───────────────────────────────────────────────── */

function cmdStats(args) {
  if (!args.journal) {
    console.error(C.red('--journal <file.jsonl> is required'))
    process.exit(1)
  }
  const journal = new Journal(args.journal)
  const stats = buildStats(journal.resolved())
  section('OVERALL')
  console.log(`  trades ${stats.count}   win rate ${(stats.winRate * 100).toFixed(1)}%   expectancy ${colourR(stats.expectancyR)}R   PF ${stats.profitFactor.toFixed(2)}`)
  if (stats.sampleWarning) console.log(C.yellow(`  ${stats.sampleWarning}`))
  section('BY MODEL')
  table(stats.byModel)
  section('BY SESSION')
  table(stats.bySession)

  const rec = recommendations(stats)
  section('WHAT THE NUMBERS SAY')
  for (const r of rec.keep) console.log(C.green(`  keep    ${r}`))
  for (const r of rec.review) console.log(C.dim(`  review  ${r}`))
  for (const r of rec.drop) console.log(C.red(`  drop    ${r}`))
  console.log()
}

/* ── helpers ────────────────────────────────────────────────────────────── */

function configFrom(args) {
  const cfg = {}
  if (args.allSessions) cfg.killzoneOnly = false
  if (args.minRR) cfg.minRR = Number(args.minRR)
  if (args.grades) cfg.tradeableGrades = String(args.grades).split(',')
  return cfg
}

function section(title) {
  console.log(`\n  ${C.bold(title)}`)
  console.log(C.dim(`  ${'─'.repeat(Math.max(20, title.length))}`))
}

function table(groups) {
  const rows = Object.entries(groups).sort((a, b) => b[1].expectancyR - a[1].expectancyR)
  if (!rows.length) return console.log(C.dim('  no data'))
  for (const [name, s] of rows) {
    console.log(
      `  ${name.padEnd(14)} ${String(s.count).padStart(4)} trades  ${(s.winRate * 100).toFixed(0).padStart(3)}% win  ${colourR(s.expectancyR).padStart(14)}R  ${colourMoney(s.totalDollars)}`,
    )
  }
}

const fmtN = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '—')
const fmtPct = (x) => `${(x * 100).toFixed(1).padStart(5)}%`
const fmtConf = (c) => (c >= 0.6 ? C.green(c.toFixed(2)) : c >= 0.35 ? C.yellow(c.toFixed(2)) : C.red(c.toFixed(2)))
const colourR = (r) => (r >= 0 ? C.green(r.toFixed(2)) : C.red(r.toFixed(2)))
const colourMoney = (d) => (d >= 0 ? C.green(`$${d.toFixed(0)}`) : C.red(`-$${Math.abs(d).toFixed(0)}`))
const gradeColour = (g) => (g === 'A+' ? C.green(g) : g === 'A' ? C.cyan(g) : g === 'B' ? C.yellow(g) : C.dim(g))

function usage() {
  console.log(`
  ${C.bold('Prop firm trading system')} — three-step ICT + orderflow scalping engine

  ${C.bold('Commands')}
    demo                     end-to-end run on generated data
    fetch                    download bars to a CSV
    collect                  merge the provider window into a growing store,
                             and journal signals on the newly closed bars
    forward                  score the accumulated out-of-sample signals
    overnight                journal completed 18:00→9:30 nights against the
                             registered overnight-capture spec (paper only)
    analyze                  read the current setup, step by step
    levels                   liquidity, orderflow and range for the session
    backtest                 full backtest with prop firm rules + HTML report
    stats                    performance breakdown from a journal file
    survival                 what edge and what position size actually pass
                             an evaluation, by Monte Carlo

  ${C.bold('Data sources')}
    --csv <file>             OHLCV file you already have
    --source yahoo           NQ=F and other futures, full 23h session
                             1m: 7 days max · 5m: 60 days · 1h: 730 days
    --source databento       real CME history back to 2010. BILLED BY VOLUME —
                             every fetch is priced first and refuses to run
                             above --maxCost (default $5). ohlcv-1m is cents
                             per year; trades and mbp-10 are far more.
                             Needs DATABENTO_API_KEY.
    --source tradier         equities and ETFs only — NO futures.
                             Real consolidated volume; ~20 days of 1m,
                             04:00-20:00 ET with session_filter=all.
                             Needs TRADIER_TOKEN.
    (none)                   synthetic data, for testing the engine only

  ${C.bold('Options')}
    --symbol <sym>           NQ, ES, QQQ, SPY… (default NQ, or QQQ on tradier)
    --equity                 treat an unknown symbol as shares
    --interval <1m|5m|1h>    bar size (tradier: 1min|5min|15min)
    --range <7d|60d>         yahoo lookback
    --start/--end <date>     tradier window (YYYY-MM-DD)
    --days <n>               tradier lookback / synthetic length
    --out <file.csv>         fetch destination
    --store <dir>            collector store (default ./data)
    --schema <s>             databento schema (default ohlcv-1m)
    --maxCost <usd>          databento spend ceiling (default 5)
    --noPaper                collect bars only, skip forward evaluation
    --account <${Object.keys(ACCOUNT_PRESETS).join('|')}>
    --journal <file.jsonl>   journal to write (backtest) or read (stats)
    --report <file.html>     backtest report path
    --grades <A+,A,B>        grades allowed to trade
    --minRR <n>              minimum reward:risk
    --allSessions            do not restrict to killzones

  ${C.dim('Orderflow is estimated from bars unless a real depth-of-market feed is wired in.')}
`)
}

const args = parseArgs(process.argv.slice(2))
const cmd = args._[0] ?? 'help'
const commands = {
  demo: () => cmdBacktest({ ...args, days: args.days ?? 30 }),
  fetch: () => cmdFetch(args),
  collect: () => cmdCollect(args),
  forward: () => cmdForward(args),
  overnight: () => cmdOvernight(args),
  monday: () => cmdMonday(args),
  sweep: () => cmdSweep(args),
  trend: () => cmdTrend(args),
  options: () => cmdOptions(args),
  analyze: () => cmdAnalyze(args),
  levels: () => cmdLevels(args),
  backtest: () => cmdBacktest(args),
  stats: () => cmdStats(args),
  survival: () => cmdSurvival(args),
}

try {
  await (commands[cmd] ?? usage)()
} catch (err) {
  // Network and provider failures should read as one clear line, not a stack.
  console.error(`\n  ${C.red('error')}  ${err.message}\n`)
  process.exitCode = 1
}
