// SMT divergence (ES vs NQ) as a CONFIRMATION FILTER on the sweep setup.
//
// The claim: when NQ sweeps its overnight low but ES holds above its own, the
// disagreement is institutional footprint confirming the reversal — it should
// upgrade marginal trades and filter out fake sweeps.
//
// That is testable. Take every sweep setup the registered spec produces, tag
// each with whether the OTHER index confirmed (swept its matching level too)
// or diverged (did not), and compare the two groups. If the claim holds,
// divergent sweeps should outperform confirmed ones.
import { CandleStore } from '/home/user/New/propfirm/src/data/store.js'
import { findSetups, dayLevels, SWEEP_SPEC } from '/home/user/New/propfirm/src/research/sweep.js'
import { findTrendSetups } from '/home/user/New/propfirm/src/research/trendcont.js'
import { futuresDayKey, etMinuteOfDay } from '/home/user/New/propfirm/src/core/sessions.js'

const nq = new CandleStore('/home/user/New/propfirm/data', 'NQ.v.0').load()
const es = new CandleStore('/home/user/New/propfirm/data', 'ES.v.0').load()
console.log(`NQ ${nq.length}  ES ${es.length}`)
const SPLIT = Date.UTC(2026, 0, 1)

const esLevels = dayLevels(es)
// Fast lookup of ES bars by timestamp for the sweep-window comparison.
const esByT = new Map(es.map((c, i) => [c.t, i]))

/**
 * Did ES sweep its OWN matching level in the same window NQ swept its one?
 * Confirmation = both swept. Divergence = NQ swept, ES did not.
 */
function esConfirmed(setup, windowMin = 15) {
  const key = setup.day
  const lv = esLevels.get(key)
  if (!lv) return null
  const buyside = setup.direction === 'short' // a buyside sweep sets up a short
  const level = setup.level.includes('overnight')
    ? (buyside ? lv.onHigh : lv.onLow)
    : (buyside ? lv.pdHigh : lv.pdLow)
  if (!Number.isFinite(level)) return null

  // Scan ES over the same minutes around the NQ sweep.
  let i = esByT.get(setup.t)
  if (i === undefined) {
    // Nearest bar within a minute either way; ES and NQ share the CME clock
    // but a thin minute can be missing from one and not the other.
    for (let d = 1; d <= 2 && i === undefined; d++) {
      i = esByT.get(setup.t + d * 60_000) ?? esByT.get(setup.t - d * 60_000)
    }
  }
  if (i === undefined) return null
  for (let j = Math.max(0, i - windowMin); j <= Math.min(es.length - 1, i + windowMin); j++) {
    if (futuresDayKey(es[j].t) !== key) continue
    if (buyside ? es[j].h > level : es[j].l < level) return true
  }
  return false
}

const stat = (ts) => {
  const n = ts.length
  if (!n) return 'n 0'
  const rs = ts.map((x) => x.r)
  const total = rs.reduce((a, b) => a + b, 0)
  const mean = total / n
  const sd = n > 1 ? Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0
  const sorted = [...rs].sort((a, b) => a - b)
  return `n ${String(n).padStart(4)}  exp ${(mean >= 0 ? '+' : '') + mean.toFixed(3)}R  ` +
    `win ${(rs.filter((x) => x > 0).length / n * 100).toFixed(0)}%  median ${sorted[Math.floor(n / 2)].toFixed(2)}R  ` +
    `t ${(sd > 0 ? mean / (sd / Math.sqrt(n)) : 0).toFixed(1)}`
}

console.log('\n=== SMT ON THE SWEEP SETUP (Playbook A) ===')
const sweeps = findSetups(nq)
const tagged = sweeps.map((s) => ({ ...s, esConfirmed: esConfirmed(s) })).filter((s) => s.esConfirmed !== null)
console.log(`sweeps ${sweeps.length}, comparable against ES ${tagged.length}`)
for (const [label, set] of [['ALL', tagged], ['IS', tagged.filter((x) => x.t < SPLIT)], ['OOS', tagged.filter((x) => x.t >= SPLIT)]]) {
  const div = set.filter((x) => !x.esConfirmed)
  const con = set.filter((x) => x.esConfirmed)
  console.log(`  ${label}`)
  console.log(`    SMT divergence (ES did NOT sweep): ${stat(div)}`)
  console.log(`    both swept (no divergence):        ${stat(con)}`)
}

console.log('\n=== SAME TEST, CHoCH SUBSET ONLY ===')
const strict = tagged.filter((s) => s.choch)
console.log(`    SMT divergence: ${stat(strict.filter((x) => !x.esConfirmed))}`)
console.log(`    both swept:     ${stat(strict.filter((x) => x.esConfirmed))}`)

// ── Does ES/NQ agreement help Playbook B? Different question: there the
// relevant divergence is whether the two indices share the same daily bias.
console.log('\n=== ES/NQ BIAS AGREEMENT ON PLAYBOOK B ===')
const nqTrend = findTrendSetups(nq)
const esTrend = findTrendSetups(es)
const esDays = new Map()
for (const s of esTrend) esDays.set(s.day, s.direction)
const agree = nqTrend.filter((s) => esDays.get(s.day) === s.direction)
const disagreeOrAbsent = nqTrend.filter((s) => esDays.get(s.day) !== s.direction)
console.log(`  ES agrees on the day's direction: ${stat(agree)}`)
console.log(`  ES silent or opposite:            ${stat(disagreeOrAbsent)}`)
