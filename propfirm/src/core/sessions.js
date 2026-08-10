/**
 * Session / killzone clock.
 *
 * Everything in this system is anchored to New York time, because the
 * instrument we care about (NQ) is a CME product and every level that matters
 * (session highs/lows, the RTH open, the macro windows) is defined in ET.
 *
 * No dependencies: `Intl` gives us correct ET conversion including DST.
 */

const ET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
})

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/**
 * @param {number} ms epoch millis
 * @returns {{year:number,month:number,day:number,hour:number,minute:number,second:number,weekday:number}}
 */
export function etParts(ms) {
  const parts = {}
  for (const p of ET_FMT.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = p.value
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Intl with hour12:false emits "24" for midnight in some ICU versions.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_INDEX[parts.weekday],
  }
}

/** Minutes elapsed since ET midnight. */
export function etMinuteOfDay(ms) {
  const p = etParts(ms)
  return p.hour * 60 + p.minute
}

/** Calendar date in ET as `YYYY-MM-DD`. */
export function etDateKey(ms) {
  const p = etParts(ms)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/**
 * Futures trading day key. The CME day opens at 18:00 ET, so anything from
 * 18:00 onward belongs to the *next* calendar day's session. This is the
 * boundary that daily candles, daily drawdown and daily loss limits use.
 */
export function futuresDayKey(ms) {
  const p = etParts(ms)
  if (p.hour < 18) return etDateKey(ms)
  return etDateKey(ms + 24 * 60 * 60 * 1000)
}

/** True when the timestamp falls in the CME maintenance halt (17:00-18:00 ET). */
export function isMaintenanceBreak(ms) {
  const m = etMinuteOfDay(ms)
  return m >= 17 * 60 && m < 18 * 60
}

const M = (h, m = 0) => h * 60 + m

/**
 * Session windows in ET minutes-of-day. `start > end` means the window wraps
 * across midnight (Asia does).
 *
 * The killzone is the sub-window where the system is allowed to trigger; the
 * full session window is used for session high/low liquidity levels.
 */
export const SESSIONS = [
  { name: 'asia', start: M(18), end: M(2), killzone: [M(20), M(0)] },
  { name: 'london', start: M(2), end: M(8, 30), killzone: [M(2), M(5)] },
  { name: 'nyAM', start: M(8, 30), end: M(12), killzone: [M(8, 30), M(11)] },
  { name: 'nyLunch', start: M(12), end: M(13, 30), killzone: null },
  { name: 'nyPM', start: M(13, 30), end: M(16), killzone: [M(13, 30), M(15, 15)] },
  { name: 'postClose', start: M(16), end: M(18), killzone: null },
]

/**
 * "Macro" windows — the fixed intervals where algorithmic repricing kicks in.
 * The 10:00 window is the one called out in the source material as the moment
 * a fresh algorithm enters and manipulation becomes likely.
 */
export const MACRO_WINDOWS = [
  { name: 'macro-0950', start: M(9, 50), end: M(10, 10) },
  { name: 'macro-1050', start: M(10, 50), end: M(11, 10) },
  { name: 'macro-1350', start: M(13, 50), end: M(14, 10) },
  { name: 'macro-1515', start: M(15, 15), end: M(15, 45) },
]

function inWindow(minute, start, end) {
  if (start <= end) return minute >= start && minute < end
  return minute >= start || minute < end // wraps midnight
}

/** @returns {string} session name for a timestamp. */
export function sessionOf(ms) {
  const minute = etMinuteOfDay(ms)
  for (const s of SESSIONS) {
    if (inWindow(minute, s.start, s.end)) return s.name
  }
  return 'unknown'
}

/** True when the timestamp sits inside its session's killzone. */
export function inKillzone(ms) {
  const minute = etMinuteOfDay(ms)
  for (const s of SESSIONS) {
    if (!s.killzone) continue
    if (inWindow(minute, s.killzone[0], s.killzone[1])) return true
  }
  return false
}

/** @returns {string|null} name of the macro window containing the timestamp. */
export function macroWindowOf(ms) {
  const minute = etMinuteOfDay(ms)
  for (const w of MACRO_WINDOWS) {
    if (inWindow(minute, w.start, w.end)) return w.name
  }
  return null
}

/** Minutes until the RTH open (09:30 ET). Negative once the open has passed. */
export function minutesToRthOpen(ms) {
  return M(9, 30) - etMinuteOfDay(ms)
}

/**
 * Group candles into session buckets, one entry per (futures day, session).
 * Used to derive session highs/lows — the liquidity pools the system hunts.
 *
 * @param {import('./candles.js').Candle[]} candles
 * @returns {{key:string, day:string, session:string, high:number, low:number,
 *            open:number, close:number, volume:number, from:number, to:number,
 *            startIndex:number, endIndex:number}[]}
 */
export function sessionBuckets(candles) {
  const out = []
  const byKey = new Map()
  candles.forEach((c, i) => {
    const day = futuresDayKey(c.t)
    const session = sessionOf(c.t)
    const key = `${day}:${session}`
    let b = byKey.get(key)
    if (!b) {
      b = {
        key,
        day,
        session,
        high: c.h,
        low: c.l,
        open: c.o,
        close: c.c,
        volume: 0,
        from: c.t,
        to: c.t,
        startIndex: i,
        endIndex: i,
      }
      byKey.set(key, b)
      out.push(b)
    }
    b.high = Math.max(b.high, c.h)
    b.low = Math.min(b.low, c.l)
    b.close = c.c
    b.volume += c.v
    b.to = c.t
    b.endIndex = i
  })
  return out
}
