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

import { writeFileSync } from 'node:fs'
import { loadCandles } from './data/csv.js'
import { generateSeries } from './data/synthetic.js'
import { Market } from './data/market.js'
import { TradingSystem } from './engine/system.js'
import { backtest } from './backtest/backtest.js'
import { PropAccount, INSTRUMENTS, ACCOUNT_PRESETS } from './risk/propfirm.js'
import { sizePosition } from './risk/sizing.js'
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

function getCandles(args) {
  if (args.csv) {
    const { candles, problems, gaps } = loadCandles(args.csv)
    if (problems.length) {
      console.error(C.red(`Data problems in ${args.csv}:`))
      for (const p of problems) console.error(`  ${p}`)
      process.exit(1)
    }
    if (gaps.length) {
      console.error(C.yellow(`${gaps.length} gap(s) in the series — largest ${Math.max(...gaps.map((g) => g.bars))} bars. Analysis continues.`))
    }
    console.error(C.dim(`Loaded ${candles.length} bars from ${args.csv}`))
    return candles
  }
  const days = Number(args.days ?? 30)
  console.error(C.yellow(`No --csv given: using SYNTHETIC data (${days} days, seed ${args.seed ?? 42}).`))
  console.error(C.yellow('Synthetic results measure whether the code works, never whether the strategy has an edge.'))
  return generateSeries({ days, seed: Number(args.seed ?? 42) })
}

function instrumentOf(args) {
  const sym = String(args.symbol ?? 'NQ').toUpperCase()
  const inst = INSTRUMENTS[sym]
  if (!inst) {
    console.error(C.red(`Unknown symbol ${sym}. Known: ${Object.keys(INSTRUMENTS).join(', ')}`))
    process.exit(1)
  }
  return inst
}

/* ── analyze: what is the system seeing right now? ──────────────────────── */

function cmdAnalyze(args) {
  const candles = getCandles(args)
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
    console.log(`  size      ${C.bold(`${sizing.contracts} ${sizing.symbol}`)}   risking ${C.bold(`$${sizing.riskDollars.toFixed(0)}`)}  ${C.dim(`(limited by ${sizing.limitedBy})`)}`)
  } else {
    console.log(`  size      ${C.red('no position')} — ${sizing.reason}`)
  }
  console.log()
}

/* ── levels: the map for the session ────────────────────────────────────── */

function cmdLevels(args) {
  const candles = getCandles(args)
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

function cmdBacktest(args) {
  const candles = getCandles(args)
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
const fmtConf = (c) => (c >= 0.6 ? C.green(c.toFixed(2)) : c >= 0.35 ? C.yellow(c.toFixed(2)) : C.red(c.toFixed(2)))
const colourR = (r) => (r >= 0 ? C.green(r.toFixed(2)) : C.red(r.toFixed(2)))
const colourMoney = (d) => (d >= 0 ? C.green(`$${d.toFixed(0)}`) : C.red(`-$${Math.abs(d).toFixed(0)}`))
const gradeColour = (g) => (g === 'A+' ? C.green(g) : g === 'A' ? C.cyan(g) : g === 'B' ? C.yellow(g) : C.dim(g))

function usage() {
  console.log(`
  ${C.bold('Prop firm trading system')} — three-step ICT + orderflow scalping engine

  ${C.bold('Commands')}
    demo                     end-to-end run on generated data
    analyze                  read the current setup, step by step
    levels                   liquidity, orderflow and range for the session
    backtest                 full backtest with prop firm rules + HTML report
    stats                    performance breakdown from a journal file

  ${C.bold('Options')}
    --csv <file>             1-minute OHLCV data (omit to use synthetic data)
    --symbol <NQ|MNQ|ES|MES> default NQ
    --account <${Object.keys(ACCOUNT_PRESETS).join('|')}>
    --days <n> --seed <n>    synthetic data size and seed
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
switch (cmd) {
  case 'demo':
    cmdBacktest({ ...args, days: args.days ?? 30 })
    break
  case 'analyze':
    cmdAnalyze(args)
    break
  case 'levels':
    cmdLevels(args)
    break
  case 'backtest':
    cmdBacktest(args)
    break
  case 'stats':
    cmdStats(args)
    break
  default:
    usage()
}
