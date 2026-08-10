import test from 'node:test'
import assert from 'node:assert/strict'
import { BOT_SPEC, decide, stopPriceFor, roundToTick, hasEveningSession, nightPnlUsd } from '../bot/overnight.js'

// 2026-08-10 is a Monday in EDT: 18:00 ET = 22:00 UTC.
const MON_1800 = Date.UTC(2026, 7, 10, 22, 0)
const FRI_1800 = Date.UTC(2026, 7, 14, 22, 0)
const SUN_1800 = Date.UTC(2026, 7, 16, 22, 0)
const TUE_0929 = Date.UTC(2026, 7, 11, 13, 29)
const TUE_NOON = Date.UTC(2026, 7, 11, 16, 0)

const fresh = () => ({ lastEntryNight: null, halted: null, realizedUsd: 0, openEntry: null })

test('evening session exists Sun–Thu and not Fri/Sat', () => {
  assert.equal(hasEveningSession(MON_1800), true)
  assert.equal(hasEveningSession(SUN_1800), true)
  assert.equal(hasEveningSession(FRI_1800), false)
  assert.equal(hasEveningSession(Date.UTC(2026, 7, 15, 22, 0)), false) // Saturday
})

test('decide: enters in the entry window, once per night', () => {
  const state = fresh()
  const first = decide({ now: MON_1800, state })
  assert.equal(first.action, 'enter')

  state.lastEntryNight = first.night
  assert.equal(decide({ now: MON_1800 + 60_000, state }).action, 'none')
})

test('decide: exits in the exit window, does nothing at noon', () => {
  assert.equal(decide({ now: TUE_0929, state: fresh() }).action, 'exit')
  assert.equal(decide({ now: TUE_NOON, state: fresh() }).action, 'none')
})

test('decide: refuses Friday evenings and holidays', () => {
  assert.equal(decide({ now: FRI_1800, state: fresh() }).action, 'none')
  const night = decide({ now: MON_1800, state: fresh() }).night
  const holidays = new Set([night])
  assert.equal(decide({ now: MON_1800, state: fresh(), holidays }).action, 'none')
})

test('decide: circuit breaker halts instead of entering, and halted stays halted', () => {
  const state = { ...fresh(), realizedUsd: -BOT_SPEC.haltLossUsd }
  const out = decide({ now: MON_1800, state })
  assert.equal(out.action, 'halt')

  const halted = { ...fresh(), halted: 'circuit breaker' }
  assert.equal(decide({ now: MON_1800, state: halted }).action, 'none')
  assert.equal(decide({ now: TUE_0929, state: halted }).action, 'none')
})

test('stop price sits stopPts below the fill, on the tick grid', () => {
  assert.equal(stopPriceFor(23456.78), roundToTick(23456.78 - BOT_SPEC.stopPts))
  assert.equal(stopPriceFor(23456.78) % BOT_SPEC.tick, 0)
})

test('night P&L arithmetic matches 1 MNQ at $2/pt', () => {
  assert.equal(nightPnlUsd({ entryFill: 20000, exitFill: 20020, commissionUsd: 1.5 }), 20 * 2 - 1.5)
  assert.equal(nightPnlUsd({ entryFill: 20000, exitFill: 19899, commissionUsd: 1.5 }), -101 * 2 - 1.5)
})
