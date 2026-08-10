/**
 * Data quality audit.
 *
 * This system is volume-dependent from top to bottom — displacement, the
 * relative-volume tests, the volume profile, the POC, CVD and the whole step-3
 * gate. Feeding it a series with missing or flat volume does not fail loudly;
 * it produces confident-looking signals built on nothing. So the data gets
 * checked before it gets traded.
 *
 * It also reports which sessions the data actually covers, because an equity
 * feed has no Asia or London session and the killzone filters would silently
 * discard almost everything.
 */

import { validateSeries, maxOf } from '../core/candles.js'
import { sessionOf, futuresDayKey, etMinuteOfDay } from '../core/sessions.js'

/**
 * @param {import('../core/candles.js').Candle[]} candles
 * @param {{expectedSeconds?:number, minBars?:number}} [opts]
 */
export function auditSeries(candles, opts = {}) {
  const problems = []
  const warnings = []
  const notes = []

  if (!candles?.length) {
    return verdict({ problems: ['series is empty'], warnings, notes, stats: null })
  }

  const stats = {
    bars: candles.length,
    from: candles[0].t,
    to: candles.at(-1).t,
    intervalSeconds: opts.expectedSeconds ?? inferInterval(candles),
  }

  /* ── structural integrity ─────────────────────────────────────────────── */
  const structural = validateSeries(candles)
  if (structural.length) {
    problems.push(`${structural.length} malformed bar(s), e.g. ${structural[0]}`)
  }

  let duplicates = 0
  for (let i = 1; i < candles.length; i++) if (candles[i].t === candles[i - 1].t) duplicates++
  if (duplicates) problems.push(`${duplicates} duplicate timestamp(s)`)

  /* ── volume, which everything downstream depends on ───────────────────── */
  const volumes = candles.map((c) => c.v)
  const zeroVolume = volumes.filter((v) => !v).length
  const zeroShare = zeroVolume / candles.length
  const distinct = new Set(volumes).size
  const total = volumes.reduce((a, b) => a + b, 0)

  stats.volume = {
    total,
    mean: total / candles.length,
    median: median(volumes),
    max: maxOf(volumes, 0),
    zeroBars: zeroVolume,
    zeroShare,
    distinctValues: distinct,
  }

  if (total === 0) {
    problems.push('every bar has zero volume — this system cannot run on price alone')
  } else if (distinct <= 2) {
    problems.push('volume is effectively constant — displacement and relative-volume tests will be meaningless')
  } else if (zeroShare > 0.5) {
    problems.push(`${pct(zeroShare)} of bars have no volume — too sparse for the orderflow layer`)
  } else if (zeroShare > 0.1) {
    warnings.push(
      `${pct(zeroShare)} of bars have zero volume. On an overnight futures series these are usually genuine — minutes where nothing printed — but they do drag the volume baseline down.`,
    )
  }

  /* ── session coverage ─────────────────────────────────────────────────── */
  const bySession = {}
  for (const c of candles) {
    const s = sessionOf(c.t)
    bySession[s] = (bySession[s] ?? 0) + 1
  }
  stats.bySession = bySession

  const overnight = (bySession.asia ?? 0) + (bySession.london ?? 0)
  const overnightShare = overnight / candles.length
  stats.overnightShare = overnightShare

  if (overnightShare < 0.02) {
    warnings.push(
      'Almost no Asia or London bars: this looks like a regular-hours instrument, not a 23-hour futures contract. ' +
        'The overnight killzones will never trigger — restrict allowedSessions to nyAM/nyPM.',
    )
    notes.push('suggested config: { allowedSessions: ["nyAM", "nyPM"] }')
  }

  /* ── coverage and gaps ────────────────────────────────────────────────── */
  const days = new Set(candles.map((c) => futuresDayKey(c.t)))
  stats.tradingDays = days.size

  const step = stats.intervalSeconds
  const gaps = []
  for (let i = 1; i < candles.length; i++) {
    const delta = (candles[i].t - candles[i - 1].t) / 1000
    if (delta <= step * 3) continue
    // The 17:00–18:00 ET maintenance halt and the weekend are expected.
    const prevMinute = etMinuteOfDay(candles[i - 1].t)
    const expectedHalt = prevMinute >= 16 * 60 && prevMinute <= 18 * 60
    if (expectedHalt || delta > 20 * 3600) continue
    gaps.push({ from: candles[i - 1].t, to: candles[i].t, missingBars: Math.round(delta / step) - 1 })
  }
  stats.gaps = gaps.length
  stats.largestGapBars = maxOf(gaps.map((g) => g.missingBars), 0)
  if (gaps.length > candles.length * 0.02) {
    warnings.push(`${gaps.length} intraday gaps — the series is patchy, which distorts swings and volume baselines`)
  }

  /* ── is there enough of it? ───────────────────────────────────────────── */
  const minBars = opts.minBars ?? 400
  if (candles.length < minBars) {
    problems.push(`only ${candles.length} bars — at least ${minBars} are needed to seed ATR and volume baselines before the first trade`)
  }
  // The 4h and daily views need several bars to produce any structure at all.
  const spanHours = (stats.to - stats.from) / 3_600_000
  if (spanHours < 96) {
    warnings.push(`the series spans ${spanHours.toFixed(0)}h — the 4h and daily context timeframes will have too few bars to give a reliable read`)
  }
  stats.spanHours = spanHours

  /* ── in-progress final bar ────────────────────────────────────────────── */
  const lastAligned = candles.at(-1).t % (step * 1000) === 0
  if (!lastAligned) {
    warnings.push('the final bar is not aligned to the interval — it is probably still forming and should be dropped')
  }

  return verdict({ problems, warnings, notes, stats })
}

function verdict({ problems, warnings, notes, stats }) {
  return {
    ok: problems.length === 0,
    tradeable: problems.length === 0,
    problems,
    warnings,
    notes,
    stats,
    summary: problems.length
      ? `unusable: ${problems[0]}`
      : warnings.length
        ? `usable with caveats (${warnings.length})`
        : 'clean',
  }
}

/** Human-readable audit, for the CLI. */
export function formatAudit(audit) {
  const lines = []
  const s = audit.stats
  if (s) {
    lines.push(`  bars        ${s.bars.toLocaleString()} @ ${s.intervalSeconds}s over ${s.tradingDays} trading day(s)`)
    lines.push(`  range       ${new Date(s.from).toISOString()} → ${new Date(s.to).toISOString()}`)
    if (s.volume) {
      lines.push(`  volume      median ${Math.round(s.volume.median).toLocaleString()}, max ${Math.round(s.volume.max).toLocaleString()}, ${s.volume.zeroBars} empty bars (${pct(s.volume.zeroShare)})`)
    }
    const sessions = Object.entries(s.bySession ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')
    lines.push(`  sessions    ${sessions}`)
    if (s.gaps) lines.push(`  gaps        ${s.gaps} (largest ${s.largestGapBars} bars)`)
  }
  for (const p of audit.problems) lines.push(`  PROBLEM     ${p}`)
  for (const w of audit.warnings) lines.push(`  warning     ${w}`)
  for (const n of audit.notes) lines.push(`  note        ${n}`)
  return lines.join('\n')
}

function inferInterval(candles) {
  const counts = new Map()
  for (let i = 1; i < Math.min(candles.length, 500); i++) {
    const d = (candles[i].t - candles[i - 1].t) / 1000
    counts.set(d, (counts.get(d) ?? 0) + 1)
  }
  let best = 60
  let bestN = 0
  for (const [d, n] of counts) if (n > bestN) [best, bestN] = [d, n]
  return best
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}
const pct = (x) => `${(x * 100).toFixed(1)}%`
