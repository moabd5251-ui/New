/**
 * CSV ingestion.
 *
 * Accepts the export formats the common platforms produce, because column
 * naming is never consistent: `time`/`timestamp`/`date`/`datetime`, and either
 * epoch seconds, epoch millis or an ISO/`YYYY-MM-DD HH:MM:SS` string.
 *
 * A file that parses is not a file that is usable — `loadCandles` validates the
 * series and reports gaps rather than silently trading through a data hole.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { validateSeries } from '../core/candles.js'

const ALIASES = {
  t: ['t', 'time', 'timestamp', 'date', 'datetime', 'bar_time', 'open_time'],
  o: ['o', 'open'],
  h: ['h', 'high'],
  l: ['l', 'low'],
  c: ['c', 'close', 'last'],
  v: ['v', 'vol', 'volume', 'total_volume'],
}

function splitLine(line) {
  // Minimal CSV split honouring double-quoted fields.
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"'
        i++
      } else quoted = !quoted
    } else if ((ch === ',' || ch === ';' || ch === '\t') && !quoted) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

/** Parse a timestamp cell into epoch millis. */
export function parseTimestamp(raw) {
  const s = String(raw).trim()
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    // 10 digits = seconds, 13 = millis, 19 = nanos.
    if (s.length <= 10) return n * 1000
    if (s.length <= 13) return n
    return Math.floor(n / 1e6)
  }
  // "2026-01-14 09:30:00" without a zone is read as UTC by Date in some
  // runtimes and local in others; normalise to an explicit ISO form.
  const normalised = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? s.replace(' ', 'T') : s
  const ms = Date.parse(normalised)
  if (Number.isNaN(ms)) throw new Error(`Unparseable timestamp: ${raw}`)
  return ms
}

/**
 * @param {string} text
 * @returns {import('../core/candles.js').Candle[]}
 */
export function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length)
  if (!lines.length) return []

  const header = splitLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'))
  const idx = {}
  for (const [field, names] of Object.entries(ALIASES)) {
    idx[field] = header.findIndex((h) => names.includes(h))
  }
  const hasHeader = idx.o >= 0 && idx.h >= 0 && idx.l >= 0 && idx.c >= 0
  if (!hasHeader) {
    // Headerless: assume time,open,high,low,close,volume.
    idx.t = 0
    idx.o = 1
    idx.h = 2
    idx.l = 3
    idx.c = 4
    idx.v = 5
  }

  const out = []
  for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
    const cols = splitLine(lines[i])
    if (cols.length < 5) continue
    const candle = {
      t: parseTimestamp(cols[idx.t]),
      o: Number(cols[idx.o]),
      h: Number(cols[idx.h]),
      l: Number(cols[idx.l]),
      c: Number(cols[idx.c]),
      v: idx.v >= 0 && cols[idx.v] !== undefined && cols[idx.v] !== '' ? Number(cols[idx.v]) : 0,
    }
    if (Number.isFinite(candle.o) && Number.isFinite(candle.c)) out.push(candle)
  }
  out.sort((a, b) => a.t - b.t)
  return out
}

/**
 * Load and validate a candle file.
 *
 * @returns {{candles:Array, problems:string[], gaps:{from:number,to:number,bars:number}[]}}
 */
export function loadCandles(path, { expectedSeconds = null, maxProblems = 20 } = {}) {
  const candles = parseCSV(readFileSync(path, 'utf8'))
  const problems = validateSeries(candles).slice(0, maxProblems)

  const gaps = []
  if (candles.length > 2) {
    const step = expectedSeconds ?? modalStep(candles)
    for (let i = 1; i < candles.length; i++) {
      const delta = (candles[i].t - candles[i - 1].t) / 1000
      // Weekend and the daily maintenance halt are expected; anything else
      // bigger than a few bars is a hole worth knowing about.
      if (delta > step * 5 && delta < 3600 * 20) {
        gaps.push({ from: candles[i - 1].t, to: candles[i].t, bars: Math.round(delta / step) })
      }
    }
  }
  return { candles, problems, gaps }
}

function modalStep(candles) {
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

/** Write candles back out as CSV. */
export function writeCandles(path, candles) {
  const rows = ['time,open,high,low,close,volume']
  for (const c of candles) {
    rows.push(`${new Date(c.t).toISOString()},${c.o},${c.h},${c.l},${c.c},${c.v}`)
  }
  writeFileSync(path, rows.join('\n') + '\n')
  return path
}
