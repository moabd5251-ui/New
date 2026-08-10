import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CandleStore } from '../src/data/store.js'
import { collect, runForwardPass, resolveForward, loadContext, CONTEXT_STREAMS } from '../src/data/collector.js'
import { generateSeries } from '../src/data/synthetic.js'
import { INSTRUMENTS } from '../src/risk/propfirm.js'
import { futuresDayKey } from '../src/core/sessions.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'pf-store-'))
const bar = (t, c = 100, v = 1000) => ({ t, o: c, h: c + 1, l: c - 1, c, v })

/* ── the store ──────────────────────────────────────────────────────────── */

test('bars are partitioned on the CME trading day, not the calendar day', () => {
  const store = new CandleStore(tmp(), 'NQ=F')
  // 17:00 ET belongs to one session day, 18:30 ET to the next.
  const before = Date.UTC(2026, 0, 15, 22, 0)
  const after = Date.UTC(2026, 0, 15, 23, 30)
  store.merge([bar(before), bar(after)])
  assert.deepEqual(store.days(), ['2026-01-15', '2026-01-16'])
  assert.equal(store.readDay(futuresDayKey(after)).length, 1)
})

test('merging is idempotent', () => {
  const store = new CandleStore(tmp(), 'NQ=F')
  const bars = Array.from({ length: 20 }, (_, i) => bar(Date.UTC(2026, 0, 15, 15, i)))
  const first = store.merge(bars)
  const second = store.merge(bars)
  assert.equal(first.added, 20)
  assert.equal(second.added, 0)
  assert.equal(second.unchanged, 20)
  assert.equal(store.coverage().bars, 20)
})

test('overlapping windows merge into one continuous series', () => {
  const store = new CandleStore(tmp(), 'NQ=F')
  const mk = (from, to) =>
    Array.from({ length: to - from }, (_, i) => bar(Date.UTC(2026, 0, 15, 15, from + i)))
  store.merge(mk(0, 30))
  store.merge(mk(20, 50)) // ten bars overlap
  const loaded = store.load()
  assert.equal(loaded.length, 50)
  for (let i = 1; i < loaded.length; i++) {
    assert.ok(loaded[i].t > loaded[i - 1].t, 'store must stay strictly ascending')
  }
})

test('a provider revision updates a bar without deleting history', () => {
  const store = new CandleStore(tmp(), 'NQ=F')
  const t = Date.UTC(2026, 0, 15, 15, 0)
  store.merge([bar(t, 100, 500), bar(t + 60_000, 101, 500)])
  const out = store.merge([{ ...bar(t, 100, 900) }]) // same minute, corrected volume
  assert.equal(out.updated, 1)
  assert.equal(out.added, 0)
  assert.equal(store.coverage().bars, 2, 'the other bar must survive the revision')
  assert.equal(store.readDay('2026-01-15')[0].v, 900)
})

test('a date range loads only the days requested', () => {
  const store = new CandleStore(tmp(), 'NQ=F')
  for (const d of [15, 16, 17]) store.merge([bar(Date.UTC(2026, 0, d, 15, 0))])
  assert.equal(store.load().length, 3)
  assert.equal(store.load({ from: '2026-01-16' }).length, 2)
  assert.equal(store.load({ from: '2026-01-16', to: '2026-01-16' }).length, 1)
})

test('an empty store reports empty coverage rather than throwing', () => {
  const store = new CandleStore(tmp(), 'NOTHING')
  assert.deepEqual(store.days(), [])
  assert.equal(store.load().length, 0)
  assert.equal(store.coverage().bars, 0)
  assert.equal(store.coverage().first, null)
})

test('stored files round-trip exactly', () => {
  const store = new CandleStore(tmp(), 'NQ=F')
  const original = [{ t: Date.UTC(2026, 0, 15, 15, 0), o: 21000.25, h: 21005.5, l: 20999.75, c: 21003, v: 1234 }]
  store.merge(original)
  assert.deepEqual(store.load(), original)
})

/* ── collection and the forward pass ────────────────────────────────────── */

const setup = () => {
  const root = tmp()
  const candles = generateSeries({ days: 12, seed: 4242 })
  return { root, candles }
}

test('collect merges bars and reports what grew', () => {
  const { root, candles } = setup()
  const first = collect({ root, symbol: 'TEST', candles, instrument: INSTRUMENTS.NQ, paper: false })
  assert.equal(first.added, candles.length)
  assert.ok(first.coverage.days >= 12)

  const again = collect({ root, symbol: 'TEST', candles, instrument: INSTRUMENTS.NQ, paper: false })
  assert.equal(again.added, 0)
  assert.equal(again.growth.bars, 0)
})

test('the watermark stops a bar being evaluated twice', () => {
  const { root, candles } = setup()
  const half = candles.slice(0, Math.floor(candles.length / 2))

  collect({ root, symbol: 'TEST', candles: half, instrument: INSTRUMENTS.NQ })
  const journal = join(root, 'TEST-forward.jsonl')
  const afterFirst = existsSync(journal) ? readFileSync(journal, 'utf8').split('\n').filter(Boolean).length : 0

  // Re-collecting the same bars must not re-evaluate them.
  const second = collect({ root, symbol: 'TEST', candles: half, instrument: INSTRUMENTS.NQ })
  assert.equal(second.added, 0)
  const afterSecond = existsSync(journal) ? readFileSync(journal, 'utf8').split('\n').filter(Boolean).length : 0
  assert.equal(afterSecond, afterFirst, 'no bar may be journalled twice')

  // New bars, on the other hand, do get evaluated.
  const third = collect({ root, symbol: 'TEST', candles, instrument: INSTRUMENTS.NQ })
  assert.ok(third.added > 0)
  assert.ok(third.paper.evaluated > 0)
})

test('forward records carry the engine version and the full reasoning', () => {
  const { root, candles } = setup()
  const out = collect({ root, symbol: 'TEST', candles, instrument: INSTRUMENTS.NQ })
  if (!out.paper?.signals) return // a quiet sample is a valid outcome
  const records = readFileSync(join(root, 'TEST-forward.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l))
  for (const r of records) {
    assert.equal(r.forward, true)
    assert.ok(r.engineVersion, 'a record without an engine version cannot be interpreted later')
    assert.ok(r.reasons.length > 0)
    assert.ok(r.stop !== r.entry)
    assert.equal(r.outcome, null, 'outcomes are resolved later, never guessed at record time')
  }
})

test('a store too small to evaluate says so instead of failing', () => {
  const root = tmp()
  const out = collect({ root, symbol: 'TINY', candles: generateSeries({ days: 1, seed: 1 }).slice(0, 100), instrument: INSTRUMENTS.NQ })
  assert.equal(out.paper.signals, 0)
  assert.match(out.paper.note, /need \d+ before evaluating/)
})

test('resolveForward takes the stop when a bar spans both stop and target', () => {
  const root = tmp()
  const store = new CandleStore(root, 'SPAN')
  const t0 = Date.UTC(2026, 0, 15, 15, 0)
  // Signal bar, then a bar that reaches both levels.
  store.merge([
    { t: t0, o: 100, h: 100, l: 100, c: 100, v: 10 },
    { t: t0 + 60_000, o: 100, h: 120, l: 80, c: 100, v: 10 },
  ])
  const journal = join(root, 'SPAN-forward.jsonl')
  writeFileSync(
    journal,
    JSON.stringify({
      barTime: new Date(t0).toISOString(),
      direction: 'long',
      entry: 100,
      stop: 90,
      targets: [{ price: 110, r: 1 }],
      model: 'CISD',
    }) + '\n',
  )
  const out = resolveForward({ root, symbol: 'SPAN' })
  assert.equal(out.resolved, 1)
  assert.equal(out.records[0].outcome.result, 'stop')
  assert.equal(out.records[0].outcome.r, -1)
})

test('a signal with no bars after it stays pending, not counted as a loss', () => {
  const root = tmp()
  const store = new CandleStore(root, 'PEND')
  const t0 = Date.UTC(2026, 0, 15, 15, 0)
  store.merge([{ t: t0, o: 100, h: 100, l: 100, c: 100, v: 10 }])
  writeFileSync(
    join(root, 'PEND-forward.jsonl'),
    JSON.stringify({
      barTime: new Date(t0).toISOString(),
      direction: 'long', entry: 100, stop: 90,
      targets: [{ price: 110, r: 1 }], model: 'CISD',
    }) + '\n',
  )
  const out = resolveForward({ root, symbol: 'PEND' })
  assert.equal(out.resolved, 0)
  assert.equal(out.pending, 1)
})

test('resolveForward on an empty journal returns zeroes', () => {
  const out = resolveForward({ root: tmp(), symbol: 'NONE' })
  assert.equal(out.resolved, 0)
  assert.equal(out.expectancyR, 0)
})

/* ── injected higher-timeframe context ──────────────────────────────────── */

test('context streams are stored separately and rebuilt on load', () => {
  const root = tmp()
  const candles = generateSeries({ days: 12, seed: 7 })
  const hourly = []
  for (let i = 0; i < 300; i++) {
    hourly.push({ t: Date.UTC(2026, 0, 1, 0, 0) + i * 3_600_000, o: 100, h: 101, l: 99, c: 100, v: 500 })
  }
  const daily = []
  for (let i = 0; i < 60; i++) {
    daily.push({ t: Date.UTC(2026, 0, 1) + i * 86_400_000, o: 100, h: 105, l: 95, c: 100, v: 5000 })
  }

  collect({ root, symbol: 'CTX', candles, instrument: INSTRUMENTS.NQ, paper: false, contextSeries: { trend: hourly, context: daily } })

  assert.ok(new CandleStore(root, 'CTX' + CONTEXT_STREAMS.trend.suffix).coverage().bars > 0)
  assert.ok(new CandleStore(root, 'CTX' + CONTEXT_STREAMS.context.suffix).coverage().bars > 0)

  const ctx = loadContext(root, 'CTX')
  assert.ok(ctx.trend.length > 0, 'hourly stream reloaded')
  assert.ok(ctx.context.length > 0, 'daily stream reloaded')
  assert.ok(ctx.macro.length > 0, '4h view is aggregated from stored hourly bars')
  assert.ok(ctx.macro.length < ctx.trend.length, '4h must be coarser than 1h')
})

test('injected higher timeframes give a daily view a short window cannot', async () => {
  const { Market } = await import('../src/data/market.js')
  // Six days of 1m data: a daily view aggregated from it has ~6 bars and no
  // swings, so step 1 can never form a bias.
  const base = generateSeries({ days: 6, seed: 11 })
  const starved = new Market(base, { instrument: INSTRUMENTS.NQ })
  assert.ok(starved.view('context').candles.length <= 8)
  assert.equal(starved.view('context').structure.swings.length, 0)

  // A monotonic series has no fractal pivots by definition, so the fixture has
  // to actually swing for structure to exist.
  const daily = []
  for (let i = 0; i < 200; i++) {
    const wave = Math.sin(i / 4) * 40 + i * 0.5
    daily.push({ t: Date.UTC(2025, 6, 1) + i * 86_400_000, o: 100 + wave, h: 108 + wave, l: 92 + wave, c: 100 + wave, v: 5000 })
  }
  const fed = new Market(base, { instrument: INSTRUMENTS.NQ, series: { context: daily } })
  assert.deepEqual(fed.injected, ['context'])
  assert.equal(fed.view('context').candles.length, 200)
  assert.ok(fed.view('context').structure.swings.length > 0, 'an injected daily series produces real structure')
  // The base series is untouched by injection.
  assert.equal(fed.view('micro').candles.length, base.length)
})
