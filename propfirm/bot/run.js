#!/usr/bin/env node
/**
 * Overnight-capture bot runner.
 *
 *   node bot/run.js                     demo environment, DRY RUN (default)
 *   node bot/run.js --execute           demo environment, real demo orders
 *   node bot/run.js --live --armed --execute
 *                                       live account. All three flags are
 *                                       required on purpose.
 *
 * The runner ticks once a minute. On 'enter' it authenticates, resolves the
 * front MNQ contract, and places a market buy with the stop bracketed in the
 * same call. On 'exit' it liquidates and cancels the leftover stop. Every
 * action and every fill is appended to bot/log.jsonl; durable state (one
 * entry per night, circuit breaker) lives in bot/state.json.
 *
 * Touch bot/KILL to make the next tick flatten everything and stop the bot.
 *
 * DISCLOSURE: this trades a hypothesis measured at t ≈ 2 on a bull sample.
 * Run it against demo until the paper journal clears ~30 nights. The --armed
 * flag exists so that going live is a decision, never a default.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Tradovate } from './tradovate.js'
import { BOT_SPEC, decide, stopPriceFor, nightPnlUsd } from './overnight.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const STATE_PATH = join(HERE, 'state.json')
const LOG_PATH = join(HERE, 'log.jsonl')
const KILL_PATH = join(HERE, 'KILL')
const HOLIDAYS_PATH = join(HERE, 'holidays.json')

const args = new Set(process.argv.slice(2))
const env = args.has('--live') ? 'live' : 'demo'
const execute = args.has('--execute')
if (env === 'live' && !(args.has('--armed') && execute)) {
  console.error('refusing: --live requires BOTH --armed and --execute. Demo is the default for a reason.')
  process.exit(1)
}

const state = existsSync(STATE_PATH)
  ? JSON.parse(readFileSync(STATE_PATH, 'utf8'))
  : { lastEntryNight: null, halted: null, realizedUsd: 0, openEntry: null }
const holidays = new Set(existsSync(HOLIDAYS_PATH) ? JSON.parse(readFileSync(HOLIDAYS_PATH, 'utf8')) : [])

const log = (event) => {
  const line = { t: new Date().toISOString(), env, execute, ...event }
  appendFileSync(LOG_PATH, JSON.stringify(line) + '\n')
  console.log(JSON.stringify(line))
}
const save = () => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))

async function enter(night) {
  state.lastEntryNight = night
  save() // before the order: a crash must not double-enter
  if (!execute) return log({ action: 'enter', night, dryRun: true, note: `would buy ${BOT_SPEC.qty} ${BOT_SPEC.root}, stop ${BOT_SPEC.stopPts}pt below fill` })

  const tv = new Tradovate({ env })
  await tv.auth()
  const account = await tv.account()
  const contract = await tv.frontContract(BOT_SPEC.root)

  const positions = await tv.positions()
  if (positions.some((p) => p.contractId === contract.id && p.netPos !== 0)) {
    return log({ action: 'enter-skip', night, reason: 'position already open on contract' })
  }
  const working = await tv.workingOrders()
  if (working.some((o) => o.contractId === contract.id)) {
    return log({ action: 'enter-skip', night, reason: 'working order already on contract' })
  }

  // Two-step entry: market order, read the actual fill, then the stop at
  // fill − stopPts. A stop needs an absolute price and the only honest
  // reference is the fill itself. If the stop cannot be placed, the position
  // is closed immediately — the bot never holds unprotected.
  const order = await tv.placeMarket({ account, symbol: contract.name, qty: BOT_SPEC.qty }).catch((err) => {
    log({ action: 'enter-error', night, error: err.message })
    return null
  })
  if (!order?.orderId) return

  let fillPrice = null
  for (let i = 0; i < 20 && fillPrice === null; i++) {
    await new Promise((r) => setTimeout(r, 1500))
    const fills = await tv.fillsFor(order.orderId).catch(() => [])
    if (fills.length) fillPrice = fills.reduce((a, f) => a + f.price, 0) / fills.length
  }
  if (fillPrice === null) {
    log({ action: 'enter-error', night, error: 'no fill visible after 30s — liquidating defensively' })
    await tv.liquidate({ account, contractId: contract.id }).catch((err) => log({ action: 'CRITICAL', night, error: `defensive liquidate failed: ${err.message} — MANUAL INTERVENTION REQUIRED` }))
    return
  }

  const stopPrice = stopPriceFor(fillPrice)
  const stop = await tv.placeStop({ account, symbol: contract.name, qty: BOT_SPEC.qty, stopPrice }).catch((err) => {
    log({ action: 'stop-error', night, error: err.message })
    return null
  })
  if (!stop?.orderId) {
    log({ action: 'enter-abort', night, note: 'stop rejected — closing position rather than holding unprotected' })
    await tv.liquidate({ account, contractId: contract.id }).catch((err) => log({ action: 'CRITICAL', night, error: `liquidate failed: ${err.message} — MANUAL INTERVENTION REQUIRED` }))
    return
  }

  log({ action: 'entered', night, contract: contract.name, fillPrice, stopPrice, orderId: order.orderId, stopOrderId: stop.orderId })
  state.openEntry = { night, contract: contract.name, contractId: contract.id, fillPrice, stopPrice }
  save()
}

async function exit(night) {
  if (!execute) {
    if (state.openEntry) log({ action: 'exit', night, dryRun: true, note: `would flatten ${state.openEntry.contract}` })
    state.openEntry = null
    return save()
  }
  const tv = new Tradovate({ env })
  await tv.auth()
  const account = await tv.account()
  const contract = await tv.frontContract(BOT_SPEC.root)

  const positions = await tv.positions()
  const pos = positions.find((p) => p.contractId === contract.id && p.netPos !== 0)
  if (pos) {
    await tv.liquidate({ account, contractId: contract.id })
    log({ action: 'flattened', night, netPos: pos.netPos })
    if (state.openEntry?.fillPrice) {
      // Best-effort mark for the circuit breaker: the liquidation fill isn't
      // trivially attributable over REST, so mark at the position's last
      // known price if present, else leave the entry as the estimate anchor.
      const exitFill = pos.netPrice ?? state.openEntry.fillPrice
      const pnl = nightPnlUsd({ entryFill: state.openEntry.fillPrice, exitFill })
      state.realizedUsd += pnl
      log({ action: 'night-pnl', night, pnlUsd: pnl, estimated: pos.netPrice == null, realizedUsd: state.realizedUsd })
    }
  } else if (state.openEntry?.fillPrice) {
    // No position at 09:29 → the stop did its job overnight.
    const pnl = nightPnlUsd({ entryFill: state.openEntry.fillPrice, exitFill: state.openEntry.stopPrice - 1 })
    state.realizedUsd += pnl
    log({ action: 'night-pnl', night, pnlUsd: pnl, exit: 'stop', estimated: true, realizedUsd: state.realizedUsd })
  }
  for (const o of await tv.workingOrders()) {
    if (o.contractId === contract.id) {
      await tv.cancelOrder(o.id)
      log({ action: 'cancelled-order', night, orderId: o.id })
    }
  }
  state.openEntry = null
  save()
}

async function tick() {
  if (existsSync(KILL_PATH)) {
    log({ action: 'kill-file' })
    if (execute && state.openEntry) await exit('kill')
    unlinkSync(KILL_PATH)
    process.exit(0)
  }
  const decision = decide({ now: Date.now(), state, holidays })
  if (decision.action === 'halt') {
    state.halted = decision.reason
    save()
    return log({ action: 'halted', reason: decision.reason })
  }
  if (decision.action === 'enter') return enter(decision.night)
  if (decision.action === 'exit') return exit(decision.night)
}

log({ action: 'start', spec: BOT_SPEC, dryRun: !execute })
await tick()
setInterval(() => tick().catch((err) => log({ action: 'tick-error', error: err.message })), 60_000)
