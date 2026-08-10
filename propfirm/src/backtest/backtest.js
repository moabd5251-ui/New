/**
 * Backtest harness.
 *
 * Deliberately pessimistic, because the point of a backtest is to find out
 * whether something survives reality, not to produce a nice equity curve:
 *
 *   • Signals are generated on a bar's CLOSE and filled at that close plus
 *     slippage. No same-bar lookahead.
 *   • Where a bar touches both the stop and a target, the STOP is taken.
 *   • Commission and slippage are charged on every side of every fill.
 *   • Prop firm rules are enforced live — a breach ends the run, exactly as it
 *     ends a real account. A curve that ignores the drawdown floor is fiction.
 *
 * The output is a journal, not just a number, so every trade can be inspected
 * for why it was taken.
 */

import { Market } from '../data/market.js'
import { TradingSystem } from '../engine/system.js'
import { PropAccount, INSTRUMENTS } from '../risk/propfirm.js'
import { sizePosition } from '../risk/sizing.js'
import { PositionManager } from '../risk/management.js'
import { Journal } from '../journal/journal.js'
import { buildStats } from '../journal/stats.js'
import { futuresDayKey, etMinuteOfDay } from '../core/sessions.js'

export const DEFAULT_BACKTEST = {
  /** Bars to skip before trading, so ATR/volume baselines are seeded. */
  warmupBars: 400,
  /** Slippage per side, in ticks. */
  slippageTicks: 1,
  /** Round-turn commission per contract, in dollars. */
  commissionPerContract: 4,
  journalPath: null,
  verbose: false,
}

/**
 * @param {{candles:Array, systemConfig?:object, accountConfig?:object,
 *          managementConfig?:object, marketConfig?:object, options?:object}} args
 */
export function backtest({
  candles,
  systemConfig = {},
  accountConfig = {},
  managementConfig = {},
  marketConfig = {},
  /**
   * A prebuilt Market, reused across runs. Building one from two years of
   * 1-minute data takes minutes, so comparing configuration variants without
   * this means rebuilding identical state for every variant.
   */
  market: prebuiltMarket = null,
  options = {},
}) {
  const opts = { ...DEFAULT_BACKTEST, ...options }
  const account = new PropAccount(accountConfig)
  const instrument = account.instrument ?? INSTRUMENTS.NQ
  const market = prebuiltMarket ?? new Market(candles, { instrument, ...marketConfig })
  if (prebuiltMarket && prebuiltMarket.base !== candles) {
    throw new Error('a prebuilt market must have been built from the same candle series')
  }
  const system = new TradingSystem(systemConfig)
  const journal = new Journal(opts.journalPath)

  const tick = instrument.tickSize
  const slip = opts.slippageTicks * tick

  let position = null
  let manager = null
  const equityCurve = []
  const rejections = new Map()
  const skipped = new Map()
  let breachedAt = null

  for (let i = opts.warmupBars; i < candles.length; i++) {
    const bar = candles[i]
    account.startDay(futuresDayKey(bar.t))
    const flow = market.orderflow.at(i)

    // ── Manage an open position first ─────────────────────────────────────
    if (position) {
      const result = manager.update(bar, flow)
      const openPnL = unrealised(position, bar.c, manager.remaining, position.instrument)
      account.mark(openPnL)

      for (const action of result.actions) {
        if (action.type === 'scale-out') {
          const fill = action.price - direction(position) * slip
          position.realised += pnlFor(position, fill, action.contracts, position.instrument)
          position.commission += action.contracts * opts.commissionPerContract
          position.scaleOuts.push({ ...action, fill })
        }
      }

      if (result.closed) {
        const fill = result.exitPrice - direction(position) * slip
        const exitContracts = manager.remaining > 0 ? manager.remaining : lastExitContracts(result)
        position.realised += pnlFor(position, fill, exitContracts, position.instrument)
        position.commission += exitContracts * opts.commissionPerContract

        const pnl = position.realised - position.commission
        const risk = Math.abs(position.entry - position.initialStop) * position.instrument.pointValue * position.contracts
        const entry = journal.add({
          entryTime: position.t,
          exitTime: bar.t,
          direction: position.direction,
          model: position.model,
          session: position.session,
          grade: position.grade,
          score: position.score,
          entry: position.entry,
          exit: fill,
          stop: position.initialStop,
          contracts: position.contracts,
          symbol: position.symbol,
          pnl,
          rMultiple: risk > 0 ? pnl / risk : 0,
          riskDollars: risk,
          exitReason: result.exitReason,
          barsHeld: manager.barsHeld,
          reasons: position.reasons,
          conflicts: position.conflicts,
          orderflowIsProxy: position.orderflowIsProxy,
          scaleOuts: position.scaleOuts,
          plannedTargets: position.targets,
        })
        account.recordTrade({ pnl, rMultiple: entry.rMultiple, model: position.model, session: position.session, t: bar.t })
        position = null
        manager = null
      }
    } else {
      account.mark(0)
    }

    equityCurve.push({
      t: bar.t,
      equity: account.balance + (position ? unrealised(position, bar.c, manager.remaining, position.instrument) : 0),
      floor: account.floor,
    })

    if (account.breached) {
      breachedAt = { t: bar.t, reason: account.breachReason }
      break
    }
    if (position) continue

    // ── Look for a new trade ──────────────────────────────────────────────
    const gate = account.canTrade(bar.t, etMinuteOfDay(bar.t))
    if (!gate.allowed) {
      skipped.set(gate.reason, (skipped.get(gate.reason) ?? 0) + 1)
      continue
    }

    const { signal, rejected } = system.evaluate(market, i)
    if (!signal) {
      if (rejected) rejections.set(rejected, (rejections.get(rejected) ?? 0) + 1)
      continue
    }

    // Fill at the close of the signal bar, paying slippage. Size against that
    // fill, not the intended entry — a stop that is one tick further away than
    // planned is one tick more risk per contract, and sizing off the intended
    // price is how a position quietly ends up over the risk budget.
    const fillPrice = signal.entry + (signal.direction === 'long' ? slip : -slip)
    const sizing = sizePosition({ account, signal: { ...signal, entry: fillPrice }, instrument })
    if (!sizing.allowed) {
      skipped.set(`sizing: ${sizing.reason}`, (skipped.get(`sizing: ${sizing.reason}`) ?? 0) + 1)
      continue
    }
    position = {
      t: bar.t,
      index: i,
      direction: signal.direction,
      entry: fillPrice,
      initialStop: signal.stop,
      contracts: sizing.contracts,
      symbol: sizing.symbol,
      // The size step may have dropped to micros; every P&L calculation from
      // here on must use the contract actually traded, not the account default.
      instrument: sizing.instrument,
      model: signal.model,
      session: signal.session,
      grade: signal.grade,
      score: signal.score,
      targets: sizing.targets,
      reasons: signal.reasons,
      conflicts: signal.conflicts,
      orderflowIsProxy: signal.orderflowIsProxy,
      realised: 0,
      commission: sizing.contracts * opts.commissionPerContract, // entry side
      scaleOuts: [],
    }
    manager = new PositionManager(
      {
        direction: signal.direction,
        entry: fillPrice,
        stop: signal.stop,
        contracts: sizing.contracts,
        targets: sizing.targets,
      },
      managementConfig,
    )
  }

  const trades = journal.resolved()
  const stats = buildStats(trades)

  return {
    trades,
    stats,
    journal,
    account,
    equityCurve,
    breachedAt,
    consistency: account.consistency(),
    rejections: [...rejections.entries()].sort((a, b) => b[1] - a[1]),
    skipped: [...skipped.entries()].sort((a, b) => b[1] - a[1]),
    market,
    meta: {
      bars: candles.length,
      from: candles[0]?.t ?? null,
      to: candles.at(-1)?.t ?? null,
      orderflowIsProxy: market.orderflow.isProxy,
      instrument: instrument.symbol,
      warmupBars: opts.warmupBars,
    },
  }
}

const direction = (p) => (p.direction === 'long' ? 1 : -1)

function pnlFor(position, price, contracts, instrument) {
  const move = position.direction === 'long' ? price - position.entry : position.entry - price
  return move * instrument.pointValue * contracts
}

function unrealised(position, price, contracts, instrument) {
  return pnlFor(position, price, contracts ?? position.contracts, instrument) - position.commission
}

function lastExitContracts(result) {
  const exit = result.actions.find((a) => a.type === 'exit')
  return exit?.contracts ?? 0
}
