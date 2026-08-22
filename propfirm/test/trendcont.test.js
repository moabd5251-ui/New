import test from 'node:test'
import assert from 'node:assert/strict'

import { trailTo, TRENDCONT_SPEC } from '../src/research/trendcont.js'

/* ── a trail may never be parked through the market ─────────────────────────
 *
 * `stopNow` used to ratchet to the prior 15m bar's extreme with only a
 * "better than the current stop" check. On a coarse trail that extreme is
 * routinely on the WRONG side of the current price, so the simulator placed a
 * stop through the market and filled it there — a phantom profit.
 *
 * It produced a monotone fake edge (5m +0.142R, 15m +0.181R, 30m +0.327R,
 * 60m +0.414R at t=4.88) that survived randomising the trade direction and
 * got BETTER with added lag. Anyone widening the trail rediscovers it.
 * ------------------------------------------------------------------------- */

test('LONG: a trail above the market is refused', () => {
  // price 100, current stop 95, candidate 102 — better than the stop, but it is
  // ABOVE the market. Taking it means an instant fill at 102 on a long. Refuse.
  assert.equal(trailTo(1, 102, 95, 100), null)
})

test('LONG: a trail below the market and above the stop is taken', () => {
  assert.equal(trailTo(1, 98, 95, 100), 98)
})

test('LONG: a trail that would loosen the stop is refused', () => {
  assert.equal(trailTo(1, 93, 95, 100), null)
})

test('SHORT: a trail below the market is refused', () => {
  assert.equal(trailTo(-1, 98, 105, 100), null)
})

test('SHORT: a trail above the market and below the stop is taken', () => {
  assert.equal(trailTo(-1, 102, 105, 100), 102)
})

test('SHORT: a trail that would loosen the stop is refused', () => {
  assert.equal(trailTo(-1, 107, 105, 100), null)
})

test('a non-finite candidate is refused', () => {
  assert.equal(trailTo(1, NaN, 95, 100), null)
})

test('spec still declares the cost and target the study was measured with', () => {
  // The measured +0.101R depends on both. Changing either invalidates the
  // registered forward record, so a change here should break a test.
  assert.equal(TRENDCONT_SPEC.costPts, 0.9)
  assert.equal(TRENDCONT_SPEC.firstTargetR, 2)
})
