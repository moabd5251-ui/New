import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { extractMondays, simulateMonday, recordMondays, mondayScorecard, MONDAY_RTH_SPEC } from '../src/research/mondayrth.js'
import { loadOvernight } from '../src/research/overnight.js'
import { CandleStore } from '../src/data/store.js'

/**
 * One RTH day of 1-minute bars, 09:30–15:59 ET. `startUtc` must be the
 * 09:30 ET instant of that day (13:30 UTC in EDT).
 */
function rthDay(startUtc, price, { dipPts = 0, exitPrice = null } = {}) {
  const bars = []
  for (let k = 0; k < 390; k++) {
    const t = startUtc + k * 60_000
    const mid = k === 200 && dipPts > 0 ? price - dipPts : price
    const isLast = k === 389
    bars.push({ t, o: mid, h: mid + 1, l: mid - (k === 200 ? dipPts : 0) - 1, c: isLast && exitPrice !== null ? exitPrice : mid, v: 100 })
  }
  return bars
}

// 2026-08-10 is a Monday (EDT): 09:30 ET = 13:30 UTC. 08-11 is Tuesday.
const MON = Date.UTC(2026, 7, 10, 13, 30)
const TUE = Date.UTC(2026, 7, 11, 13, 30)
const MON2 = Date.UTC(2026, 7, 17, 13, 30)

test('extractMondays keeps Mondays and ignores other weekdays', () => {
  const bars = [...rthDay(MON, 20000, { exitPrice: 20050 }), ...rthDay(TUE, 20050), ...rthDay(MON2, 20100)]
  const sessions = extractMondays(bars)
  assert.equal(sessions.length, 2)
  assert.equal(sessions[0].entry, 20000)
  assert.equal(sessions[0].exit, 20050)
  assert.equal(sessions[0].bars.length, 390)
})

test('simulateMonday: time exit and bounded stop exit', () => {
  const flat = extractMondays(rthDay(MON, 20000, { exitPrice: 20040 }))[0]
  assert.deepEqual(simulateMonday(flat, null), { pts: 40 - MONDAY_RTH_SPEC.costPts, exit: 'time' })

  const dipped = extractMondays(rthDay(MON, 20000, { dipPts: 150, exitPrice: 20040 }))[0]
  const stopped = simulateMonday(dipped, 100)
  assert.equal(stopped.exit, 'stop')
  assert.equal(stopped.pts, -100 - MONDAY_RTH_SPEC.stopSlipPts - MONDAY_RTH_SPEC.costPts)
})

test('recordMondays journals once and scores', () => {
  const root = mkdtempSync(join(tmpdir(), 'monday-'))
  new CandleStore(root, 'TEST').merge([...rthDay(MON, 20000, { exitPrice: 20030 }), ...rthDay(MON2, 20030, { exitPrice: 20010 })])

  const first = recordMondays({ root, symbol: 'TEST' })
  assert.equal(first.added, 2)
  assert.equal(recordMondays({ root, symbol: 'TEST' }).added, 0)

  const card = mondayScorecard(loadOvernight(first.path))
  assert.equal(card.mondays, 2)
  assert.ok(Math.abs(card.variants.none.totalPts - (30 - 1 - 20 - 1)) < 1e-9)
})
