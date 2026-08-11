import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SWEEP_SPEC, dayLevels, findSetups, recordSweeps, loadSweeps, sweepScorecard } from '../src/research/sweep.js'
import { CandleStore } from '../src/data/store.js'
import { etMinuteOfDay, futuresDayKey } from '../src/core/sessions.js'

/**
 * Build a session of 1-minute bars from an ET-minute → price function.
 * `startUtc` must be the 18:00 ET instant that opens the trading day.
 */
function session(startUtc, priceAt, { minutes = 1140 } = {}) {
  const bars = []
  for (let k = 0; k < minutes; k++) {
    const t = startUtc + k * 60_000
    const p = priceAt(etMinuteOfDay(t), k)
    const { o = p, h = p + 1, l = p - 1, c = p } = typeof p === 'object' ? p : {}
    bars.push(typeof p === 'object' ? { t, o, h, l, c, v: 500 } : { t, o: p, h: p + 1, l: p - 1, c: p, v: 500 })
  }
  return bars
}

// 2026-08-10 is EDT: 18:00 ET = 22:00 UTC.
const DAY1 = Date.UTC(2026, 7, 10, 22, 0)
const DAY2 = Date.UTC(2026, 7, 11, 22, 0)

test('overnight range and prior-day levels resolve without peeking ahead', () => {
  // Overnight (18:00-07:00) tops at 20050; RTH runs 20100-19900.
  const bars = session(DAY1, (et) => {
    if (et >= 1080 || et < 420) return 20000 + (et === 1200 ? 50 : 0)
    if (et >= 570 && et < 960) return et === 600 ? 20100 : et === 700 ? 19900 : 20000
    return 20000
  })
  const days = dayLevels(bars)
  const d = days.get(futuresDayKey(DAY1))
  assert.ok(d.onHigh >= 20050, `overnight high ${d.onHigh}`)
  // The first day has no prior day to inherit from — null, not a guess.
  assert.equal(d.pdHigh, null)
  assert.equal(d.pdLow, null)
})

test('a sweep with no displacement back through the level produces nothing', () => {
  // Price pokes above the overnight high in the killzone and keeps going.
  const bars = session(DAY1, (et) => {
    if (et >= 1080 || et < 420) return 20000
    if (et >= 420 && et < 600) return 20000 + (et - 420) * 2 // straight up through it
    return 20200
  })
  assert.equal(findSetups(bars).length, 0)
})

test('setups only fire inside the killzone', () => {
  // Same sweep-and-reverse shape, but placed at 13:00 ET — outside 07:00-10:00.
  const shape = (et) => {
    if (et >= 1080 || et < 420) return 20000
    if (et === 780) return { o: 20005, h: 20060, l: 20000, c: 20010 } // sweep
    if (et === 781) return { o: 20010, h: 20012, l: 19940, c: 19945 } // displacement
    if (et >= 782 && et < 800) return 19985 // retrace into OTE
    return 19950
  }
  const bars = session(DAY1, shape)
  const setups = findSetups(bars)
  assert.equal(setups.filter((s) => {
    const et = etMinuteOfDay(s.t)
    return et < SWEEP_SPEC.killzoneStart || et >= SWEEP_SPEC.killzoneEnd
  }).length, 0, 'no setup may be stamped outside the killzone')
})

test('the two variants are a subset relationship, never pooled', () => {
  const records = [
    { day: 'd1', t: 1, choch: true, r: 2, riskPts: 10 },
    { day: 'd2', t: 2, choch: false, r: -1, riskPts: 10 },
    { day: 'd3', t: 3, choch: true, r: -1, riskPts: 10 },
  ]
  const card = sweepScorecard(records)
  assert.equal(card.noChoch.n, 3, 'the loose variant holds every setup')
  assert.equal(card.withChoch.n, 2, 'the strict variant holds only the CHoCH ones')
  // Pooling would double-count: the strict set is inside the loose one.
  assert.ok(card.withChoch.n < card.noChoch.n)
})

test('the two-trades-a-day cap is applied per variant', () => {
  const day = 'd1'
  const records = [
    { day, t: 1, choch: false, r: -1, riskPts: 10 },
    { day, t: 2, choch: false, r: -1, riskPts: 10 },
    { day, t: 3, choch: true, r: 5, riskPts: 10 },
  ]
  const card = sweepScorecard(records)
  assert.equal(card.noChoch.n, 2, 'the cap bites on the loose variant')
  // The winning CHoCH setup must NOT be displaced by two earlier non-CHoCH
  // ones — each variant caps its own day independently.
  assert.equal(card.withChoch.n, 1)
  assert.equal(card.withChoch.totalR, 5)
})

test('the scorecard surfaces concentration, not just the mean', () => {
  // Nine full losses and one huge winner: a flattering mean over a broken
  // distribution, which is exactly the shape this strategy showed.
  const records = Array.from({ length: 10 }, (_, i) => ({
    day: `d${i}`, t: i, choch: true, riskPts: 10,
    r: i === 9 ? 20 : -1,
  }))
  const v = sweepScorecard(records).withChoch
  assert.ok(v.expR > 0, 'the mean looks fine')
  assert.equal(v.medianR, -1, 'the median tells the truth')
  assert.ok(v.topFiveShare > 1, 'the best five are more than all the profit')
  assert.equal(v.worstStreak, 9)
})

test('journalling is once-per-day and refuses pre-registration days', () => {
  const root = mkdtempSync(join(tmpdir(), 'sweep-'))
  const store = new CandleStore(root, 'TEST')
  // A day well before the registration date must never be journaled.
  const old = session(Date.UTC(2026, 6, 6, 22, 0), (et) => {
    if (et === 430) return { o: 20005, h: 20060, l: 20000, c: 20010 }
    if (et === 431) return { o: 20010, h: 20012, l: 19940, c: 19945 }
    if (et >= 432 && et < 460) return 19985
    return 20000
  })
  store.merge(old)
  const out = recordSweeps({ root, symbol: 'TEST' })
  assert.equal(out.added, 0, 'nothing before the registration date is evidence')

  // Re-running never duplicates, whatever the data holds.
  assert.equal(recordSweeps({ root, symbol: 'TEST' }).added, 0)
  assert.equal(loadSweeps(out.path).length, 0)
})

test('an incomplete day is not journaled until it is past the time stop', () => {
  const root = mkdtempSync(join(tmpdir(), 'sweep-'))
  const store = new CandleStore(root, 'TEST')
  // Bars stop at 09:00 ET — before the 11:30 time stop, so the day is live.
  const partial = session(DAY2, (et) => 20000, { minutes: 900 })
  store.merge(partial.filter((b) => etMinuteOfDay(b.t) < 540))
  const out = recordSweeps({ root, symbol: 'TEST' })
  assert.equal(out.added, 0, 'a day still in progress cannot be scored')
})

test('SMT tagging is best-effort and never drops a setup', async () => {
  const { makeSmtTagger } = await import('../src/research/sweep.js')
  // No companion data at all: every setup tags null rather than vanishing.
  const none = makeSmtTagger([])
  assert.equal(none({ day: 'd', t: 0, direction: 'short', level: 'overnight high' }), null)
})

test('SMT divergence is detected from the companion index', async () => {
  const { makeSmtTagger } = await import('../src/research/sweep.js')
  // Companion overnight high is 100; the window either exceeds it or not.
  const build = (killzoneHigh) => {
    const bars = []
    for (let k = 0; k < 1000; k++) {
      const t = DAY1 + k * 60_000
      const et = etMinuteOfDay(t)
      const overnight = et >= 1080 || et < 420
      const p = overnight ? 100 : killzoneHigh
      bars.push({ t, o: p, h: p, l: p - 1, c: p, v: 100 })
    }
    return bars
  }
  // 18:00 ET + 800 minutes = 07:20 ET, inside the killzone. (At +460 the stamp
  // is 01:40 ET — still overnight, where the companion is at its own high and
  // every case reads as divergence.)
  const at = DAY1 + 800 * 60_000
  const day = futuresDayKey(at)
  const setup = { day, t: at, direction: 'short', level: 'overnight high' }

  // Companion also pushed above its overnight high → both swept, no divergence.
  const confirmed = makeSmtTagger(build(105))(setup)
  assert.equal(confirmed?.divergence, false)
  assert.equal(confirmed?.companionSwept, true)

  // Companion stayed below → divergence, the claimed footprint.
  const diverged = makeSmtTagger(build(95))(setup)
  assert.equal(diverged?.divergence, true)
})

test('the scorecard splits by SMT without pooling it into the headline', () => {
  const records = [
    { day: 'a', t: 1, choch: false, r: 3, riskPts: 10, smt: { divergence: true } },
    { day: 'b', t: 2, choch: false, r: -1, riskPts: 10, smt: { divergence: false } },
    { day: 'c', t: 3, choch: false, r: -1, riskPts: 10, smt: null },
  ]
  const card = sweepScorecard(records)
  assert.equal(card.noChoch.n, 3, 'the headline still counts every setup')
  assert.equal(card.smt.tagged, 2, 'only tagged setups enter the SMT split')
  assert.equal(card.smt.divergent.meanR, 3)
  assert.equal(card.smt.confirmed.meanR, -1)
})
