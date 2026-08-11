// Extract and exercise the pure bias logic from the cockpit, since it is the
// piece that decides whether a trade happens at all.
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
const src = readFileSync('cockpit/PropCockpit.jsx', 'utf8')
const start = src.indexOf('const BIAS_QUESTIONS')
const end = src.indexOf('export default function')
const body = src.slice(start, end).replace(/^const STORE_KEY[\s\S]*?$/m, '')
const mod = await import('data:text/javascript,' + encodeURIComponent(body + '\nexport { evaluateBias, BIAS_QUESTIONS }'))
const { evaluateBias } = mod

// All three must hold, or B is off.
assert.equal(evaluateBias({}).state, 'incomplete')
assert.equal(evaluateBias({ dailyBos: 'UP', h4Bos: 'UP', emaSide: 'ABOVE' }).state, 'pass')
assert.equal(evaluateBias({ dailyBos: 'UP', h4Bos: 'UP', emaSide: 'ABOVE' }).dir, 'LONG')
assert.equal(evaluateBias({ dailyBos: 'DOWN', h4Bos: 'DOWN', emaSide: 'BELOW' }).dir, 'SHORT')
// Timeframes disagreeing kills B.
assert.equal(evaluateBias({ dailyBos: 'UP', h4Bos: 'DOWN', emaSide: 'ABOVE' }).state, 'fail')
// Right structure, wrong side of the EMA, kills B.
assert.equal(evaluateBias({ dailyBos: 'UP', h4Bos: 'UP', emaSide: 'BELOW' }).state, 'fail')
assert.equal(evaluateBias({ dailyBos: 'DOWN', h4Bos: 'DOWN', emaSide: 'ABOVE' }).state, 'fail')
// Unclear structure kills B and routes to A, never to a guess.
const unclear = evaluateBias({ dailyBos: 'UNCLEAR', h4Bos: 'UP', emaSide: 'ABOVE' })
assert.equal(unclear.state, 'fail')
assert.equal(unclear.playbook, 'A')
// A pass never returns a null direction — that would let a trade through undirected.
for (const [d, e] of [['UP', 'ABOVE'], ['DOWN', 'BELOW']]) {
  const r = evaluateBias({ dailyBos: d, h4Bos: d, emaSide: e })
  assert.ok(r.dir, 'a passing bias must name a direction')
}
console.log('bias filter: 10 assertions passed')
