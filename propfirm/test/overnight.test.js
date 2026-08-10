import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { extractNights, simulateNight, recordOvernight, loadOvernight, overnightScorecard, OVERNIGHT_SPEC } from '../src/research/overnight.js'
import { writeCandles } from '../src/data/csv.js'
import { CandleStore } from '../src/data/store.js'
import { etMinuteOfDay } from '../src/core/sessions.js'

/**
 * Build one night of 1-minute bars: 18:00 ET through 9:30 ET the next
 * morning, flat at `price` except for an optional dip to `lowAt` points below
 * entry partway through. Timestamps are real ET-derived UTC instants.
 */
function night(startUtc, price, { dipPts = 0, exitPrice = null } = {}) {
  const bars = []
  // 18:00 ET on 2026-08-10 EDT = 22:00 UTC. Walk minute by minute until the
  // bar whose ET stamp is 09:30 — about 930 minutes, skipping 17:00–18:00
  // never happens inside one night.
  let t = startUtc
  for (let k = 0; k < 1200; k++) {
    const et = etMinuteOfDay(t)
    const isEntry = et === OVERNIGHT_SPEC.entryEtMinute
    const isExit = et === OVERNIGHT_SPEC.exitEtMinute
    const mid = k === 400 && dipPts > 0 ? price - dipPts : price
    const close = isExit && exitPrice !== null ? exitPrice : mid
    bars.push({ t, o: isExit && exitPrice !== null ? exitPrice : mid, h: mid + 1, l: mid - (k === 400 ? dipPts : 0) - 1, c: close, v: 100 })
    if (isExit) break
    t += 60_000
  }
  return bars
}

// 2026-08-10 is EDT: 18:00 ET = 22:00 UTC.
const NIGHT1 = Date.UTC(2026, 7, 10, 22, 0)
const NIGHT2 = Date.UTC(2026, 7, 11, 22, 0)

test('extractNights finds completed nights and drops unfinished ones', () => {
  const bars = [...night(NIGHT1, 20000), ...night(NIGHT2, 20100)]
  const nights = extractNights(bars)
  assert.equal(nights.length, 2)
  assert.equal(nights[0].entry, 20000)
  assert.equal(etMinuteOfDay(nights[0].exitT), OVERNIGHT_SPEC.exitEtMinute)

  // A night with no 9:30 bar (holiday) must not appear.
  const truncated = bars.slice(0, 200)
  assert.equal(extractNights(truncated).length, 0)
})

test('simulateNight: time exit collects the drift, stop exit is bounded', () => {
  const flat = extractNights(night(NIGHT1, 20000, { exitPrice: 20030 }))[0]
  const timeExit = simulateNight(flat, 100)
  assert.equal(timeExit.exit, 'time')
  assert.equal(timeExit.pts, 30 - OVERNIGHT_SPEC.costPts)

  const dipped = extractNights(night(NIGHT1, 20000, { dipPts: 150, exitPrice: 20050 }))[0]
  const noStop = simulateNight(dipped, null)
  assert.equal(noStop.exit, 'time')
  const stopped = simulateNight(dipped, 100)
  assert.equal(stopped.exit, 'stop')
  assert.equal(stopped.pts, -100 - OVERNIGHT_SPEC.stopSlipPts - OVERNIGHT_SPEC.costPts)
})

test('recordOvernight journals each night exactly once', () => {
  const root = mkdtempSync(join(tmpdir(), 'overnight-'))
  const store = new CandleStore(root, 'TEST')
  store.merge([...night(NIGHT1, 20000, { exitPrice: 20040 }), ...night(NIGHT2, 20040, { exitPrice: 20010 })])

  const first = recordOvernight({ root, symbol: 'TEST' })
  assert.equal(first.added, 2)
  // Re-running adds nothing: the watermark holds.
  const second = recordOvernight({ root, symbol: 'TEST' })
  assert.equal(second.added, 0)
  assert.equal(loadOvernight(first.path).length, 2)

  const card = overnightScorecard(loadOvernight(first.path))
  assert.equal(card.nights, 2)
  // Night 1 +40, night 2 −30, minus 1pt cost each.
  assert.ok(Math.abs(card.variants.none.totalPts - (40 - 1 - 30 - 1)) < 1e-9)
  assert.equal(card.variants.s100.stops, 0)
  assert.equal(card.variants.none.breached, null)
})

test('nights before the registration date are never journaled', () => {
  const root = mkdtempSync(join(tmpdir(), 'overnight-'))
  const store = new CandleStore(root, 'TEST')
  // 2026-08-07 (EDT) — before the 2026-08-10 registration.
  store.merge(night(Date.UTC(2026, 7, 6, 22, 0), 19000, { exitPrice: 19500 }))
  const out = recordOvernight({ root, symbol: 'TEST' })
  assert.equal(out.added, 0)
})

test('scorecard tracks the simulated Lucid account through breach', () => {
  // 25 synthetic nights each losing 100pt net = -$200/night on 1 MNQ.
  const records = Array.from({ length: 25 }, (_, i) => ({
    night: `2026-09-${String(i + 1).padStart(2, '0')}`,
    t: Date.UTC(2026, 8, i + 1),
    variants: { none: { pts: -100, exit: 'time' }, s50: { pts: -51 - 2, exit: 'stop' }, s100: { pts: -100, exit: 'time' } },
  }))
  const card = overnightScorecard(records)
  // $2k drawdown / $200 per night → breach on the 10th night.
  assert.equal(card.variants.none.breached, '2026-09-10')
  assert.equal(card.variants.none.passed, null)
})
