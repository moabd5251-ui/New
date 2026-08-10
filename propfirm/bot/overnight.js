/**
 * Overnight-capture execution logic — the decisions, kept pure so they are
 * testable without a broker. The runner (run.js) supplies the clock and the
 * Tradovate client; everything here answers one question: given the time and
 * the bot's state, what should happen right now?
 *
 * The spec matches the registered paper spec exactly:
 *   • Buy 1 MNQ at the 18:00 ET Globex open (Sun–Thu; there is no Friday
 *     18:00 session).
 *   • Attach a stop `stopPts` below the fill immediately — the bracket goes
 *     in the same order call, never as a follow-up.
 *   • No target. Flatten at 09:29 ET, one minute before the paper exit, so a
 *     slow fill can never straddle the measurement boundary.
 *
 * Safety rails, all enforced before any order:
 *   • one entry per night, tracked in the state file
 *   • never enter with an existing position or working order on the contract
 *   • circuit breaker: if realised losses since arming reach `haltLossUsd`,
 *     the bot refuses to enter until a human clears state.halted
 *   • kill file: touch bot/KILL and the next tick exits every position and
 *     stops the bot
 *   • holiday list: CME closures the user maintains in bot/holidays.json
 */

import { etMinuteOfDay, futuresDayKey } from '../src/core/sessions.js'

export const BOT_SPEC = {
  root: 'MNQ',
  qty: 1,
  stopPts: 100,
  tick: 0.25,
  entryEtMinute: 18 * 60,
  /** Entry attempts stop after this window — a late start must not chase. */
  entryWindowMinutes: 10,
  exitEtMinute: 9 * 60 + 29,
  exitWindowMinutes: 30,
  haltLossUsd: 1000,
  dollarsPerPoint: 2,
}

export const roundToTick = (price, tick = BOT_SPEC.tick) => Math.round(price / tick) * tick

export const stopPriceFor = (fillPrice, stopPts = BOT_SPEC.stopPts) => roundToTick(fillPrice - stopPts)

/**
 * Sun–Thu evenings have an 18:00 session; Friday and Saturday do not. An
 * 18:00 entry belongs to the NEXT trading day (that is what futuresDayKey
 * returns after 18:00), so the test is whether that trading day is a weekday
 * — Sunday evening maps to Monday and passes, Friday evening maps to
 * Saturday and is refused.
 */
export function hasEveningSession(t) {
  const key = futuresDayKey(t)
  const tradingDay = new Date(`${key}T12:00:00Z`).getUTCDay()
  return tradingDay >= 1 && tradingDay <= 5
}

/**
 * The decision function. `state` carries {lastEntryNight, halted,
 * realizedUsd}; `holidays` is a set of YYYY-MM-DD trading-day keys to skip.
 */
export function decide({ now, state, holidays = new Set() }) {
  const et = etMinuteOfDay(now)
  const night = futuresDayKey(now)

  if (state.halted) return { action: 'none', reason: `halted: ${state.halted}` }

  const inEntry = et >= BOT_SPEC.entryEtMinute && et < BOT_SPEC.entryEtMinute + BOT_SPEC.entryWindowMinutes
  if (inEntry) {
    if (!hasEveningSession(now)) return { action: 'none', reason: 'no evening session tonight' }
    if (holidays.has(night)) return { action: 'none', reason: `holiday ${night}` }
    if (state.lastEntryNight === night) return { action: 'none', reason: 'already entered tonight' }
    if (state.realizedUsd <= -BOT_SPEC.haltLossUsd) {
      return { action: 'halt', reason: `circuit breaker: realised $${state.realizedUsd.toFixed(0)} ≤ -$${BOT_SPEC.haltLossUsd}` }
    }
    return { action: 'enter', night }
  }

  const inExit = et >= BOT_SPEC.exitEtMinute && et < BOT_SPEC.exitEtMinute + BOT_SPEC.exitWindowMinutes
  if (inExit) return { action: 'exit', night }

  return { action: 'none', reason: 'outside action windows' }
}

/**
 * Reconciliation arithmetic for the circuit breaker: realised P&L of a closed
 * night in dollars, from fill prices.
 */
export function nightPnlUsd({ entryFill, exitFill, qty = BOT_SPEC.qty, commissionUsd = 1.5 }) {
  return (exitFill - entryFill) * BOT_SPEC.dollarsPerPoint * qty - commissionUsd
}
