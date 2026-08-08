/**
 * Candle resampling.
 *
 * A multi-timeframe strategy needs one instrument read at three resolutions,
 * and no feed hands you all three. What a feed gives you is the finest
 * intraday series it carries — 1-minute or 5-minute bars — plus a daily
 * history. Everything in between is built here.
 *
 * Intraday buckets are anchored to the **09:30 ET open**, not to the wall
 * clock. A wall-clock hour would end the first bar at 10:00, which is a
 * 30-minute bar wearing an hourly label, and every subsequent bar would be
 * offset from what a charting platform shows. The strategy has to read the
 * same bars the trader is looking at, so 09:30-10:30 is the first hourly bar.
 *
 * Everything here is pure: bars in, bars out, no clock and no network.
 */

/** Minutes past midnight ET at which the regular session opens. */
export const SESSION_OPEN_MINUTES = 9 * 60 + 30;

/** Named intervals, in minutes. `daily` is handled separately — see toDaily. */
export const INTERVAL_MINUTES = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240,
};

const ET_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * Memo for the Eastern-time conversion.
 *
 * `formatToParts` is the single most expensive thing in this file and it is
 * called once per bar per resample. That is unnoticeable when a scan resamples
 * one series, and it dominates everything when a backtest replays fifteen
 * thousand decision bars over the same timestamps — the same few thousand
 * instants get converted millions of times.
 *
 * The cap exists because the server is long-lived: without it a process
 * running for weeks accumulates an entry per minute per symbol. Clearing
 * wholesale rather than evicting cleverly is deliberate — the access pattern
 * is a moving window, so the entries about to be dropped are the old ones
 * anyway, and a plain Map is faster than anything that tracks recency.
 */
const ET_CACHE = new Map();
const ET_CACHE_LIMIT = 250_000;

/**
 * Date and clock parts in New York.
 *
 * The session boundary is an Eastern-time concept, so bucketing has to happen
 * in Eastern time or a bar recorded at 21:00 UTC lands in the wrong day for
 * half the year. Doing it through Intl means DST is the platform's problem
 * rather than a hand-rolled offset table that goes stale twice a year.
 */
export function easternParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return null;

  const cached = ET_CACHE.get(ms);
  if (cached) return cached;

  const parts = ET_FORMATTER.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '00';
  // Some ICU versions render midnight as hour "24"; normalize it to 00.
  const hour = get('hour') === '24' ? '00' : get('hour');

  const result = {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(hour) * 60 + Number(get('minute')),
  };

  if (ET_CACHE.size >= ET_CACHE_LIMIT) ET_CACHE.clear();
  ET_CACHE.set(ms, result);
  return result;
}

/** Signed minutes from the 09:30 ET bell — negative before the open. */
export function minutesFromOpen(value) {
  const et = easternParts(value);
  return et ? et.minutes - SESSION_OPEN_MINUTES : null;
}

function isUsableBar(bar) {
  return (
    bar &&
    Number.isFinite(bar.open) &&
    Number.isFinite(bar.high) &&
    Number.isFinite(bar.low) &&
    Number.isFinite(bar.close) &&
    bar.high >= bar.low &&
    bar.low > 0 &&
    !Number.isNaN(new Date(bar.time).getTime())
  );
}

/** Merge a run of source bars into the one bar they compose. */
function mergeBars(bars, { time, session, partial }) {
  const volumes = bars.map((b) => b.volume).filter((v) => Number.isFinite(v) && v >= 0);
  return {
    time,
    session,
    open: bars[0].open,
    high: Math.max(...bars.map((b) => b.high)),
    low: Math.min(...bars.map((b) => b.low)),
    close: bars.at(-1).close,
    // A feed that omits volume should yield null, not a confident zero — the
    // difference decides whether "volume dried up" is a reading or a guess.
    volume: volumes.length ? volumes.reduce((a, b) => a + b, 0) : null,
    sourceBars: bars.length,
    partial,
  };
}

/**
 * Roll a series of finer bars up to `minutes`-wide bars.
 *
 * Bars arriving out of order are sorted first; a feed that backfills is common
 * enough that trusting the order would silently corrupt every bucket after the
 * first gap. Bars that cannot be read at all are dropped rather than allowed
 * to poison a bucket's high or low with a NaN.
 *
 * The final bar is flagged `partial` when its bucket is still filling. Callers
 * that read structure care: a forming bar's high is not yet a high.
 */
export function resample(candles, minutes, { now = null } = {}) {
  const width = Number(minutes);
  if (!Array.isArray(candles) || !Number.isFinite(width) || width <= 0) return [];

  const usable = candles
    .filter(isUsableBar)
    .map((bar) => ({ ...bar, ms: new Date(bar.time).getTime() }))
    .sort((a, b) => a.ms - b.ms);
  if (!usable.length) return [];

  const buckets = new Map();
  for (const bar of usable) {
    const et = easternParts(bar.ms);
    if (!et) continue;
    const fromOpen = et.minutes - SESSION_OPEN_MINUTES;
    const index = Math.floor(fromOpen / width);
    const key = `${et.date}#${index}`;

    // The bucket's start in real time, derived from this bar rather than from
    // a timezone conversion: stepping back the minutes this bar sits into its
    // bucket lands exactly on the boundary, DST included.
    const startMs = bar.ms - (fromOpen - index * width) * 60_000 - secondsWithin(bar.ms);

    if (!buckets.has(key)) buckets.set(key, { startMs, session: et.date, bars: [] });
    buckets.get(key).bars.push(bar);
  }

  const ordered = [...buckets.values()].sort((a, b) => a.startMs - b.startMs);
  const nowMs = now === null ? null : new Date(now).getTime();

  return ordered.map((bucket, i) => {
    const isLast = i === ordered.length - 1;
    const endMs = bucket.startMs + width * 60_000;
    // Without a clock, "has this bucket closed?" is answered by whether a later
    // bucket exists — the only evidence the bars themselves carry.
    const partial = isLast && (Number.isFinite(nowMs) ? nowMs < endMs : true);
    return mergeBars(bucket.bars, {
      time: new Date(bucket.startMs).toISOString(),
      session: bucket.session,
      partial,
    });
  });
}

/** Milliseconds past the containing minute, so buckets start on the minute. */
function secondsWithin(ms) {
  return ((ms % 60_000) + 60_000) % 60_000;
}

/**
 * Collapse intraday bars into one bar per Eastern trading day.
 *
 * Used to extend a daily history with today's session in progress, so the
 * daily trend read includes the bar that is actually forming rather than
 * stopping at yesterday's close.
 */
export function toDaily(candles, { now = null } = {}) {
  if (!Array.isArray(candles) || !candles.length) return [];

  const usable = candles
    .filter(isUsableBar)
    .map((bar) => ({ ...bar, ms: new Date(bar.time).getTime() }))
    .sort((a, b) => a.ms - b.ms);
  if (!usable.length) return [];

  const days = new Map();
  for (const bar of usable) {
    const et = easternParts(bar.ms);
    if (!et) continue;
    if (!days.has(et.date)) days.set(et.date, { startMs: bar.ms, session: et.date, bars: [] });
    days.get(et.date).bars.push(bar);
  }

  const ordered = [...days.values()].sort((a, b) => a.startMs - b.startMs);
  const todayEt = now === null ? null : easternParts(now)?.date;

  return ordered.map((day, i) =>
    mergeBars(day.bars, {
      time: new Date(day.startMs).toISOString(),
      session: day.session,
      // Today's bar is still being written; yesterday's is finished.
      partial: todayEt ? day.session === todayEt : i === ordered.length - 1,
    }),
  );
}

/**
 * Splice a daily history together with today's intraday session.
 *
 * Providers serve daily history that either omits the current day or carries a
 * stale copy of it. Either way the fix is the same: drop any daily bar for
 * today and re-derive it from the intraday bars, which are current.
 */
export function mergeDaily(dailyBars, intradayBars, { now = null } = {}) {
  const daily = (Array.isArray(dailyBars) ? dailyBars : [])
    .filter(isUsableBar)
    .map((bar) => ({ ...bar, session: easternParts(bar.time)?.date ?? null }))
    .sort((a, b) => new Date(a.time) - new Date(b.time));

  const fromIntraday = toDaily(intradayBars, { now });
  if (!fromIntraday.length) return daily;

  const derived = new Map(fromIntraday.map((bar) => [bar.session, bar]));
  const merged = daily.filter((bar) => !derived.has(bar.session));
  merged.push(...fromIntraday);
  return merged.sort((a, b) => new Date(a.time) - new Date(b.time));
}

/**
 * Build the three series the strategy reads from whatever the provider had.
 *
 * `intraday` is the finest series available (1-minute or 5-minute bars over
 * several sessions); `daily` is the daily history. Hourly is always derived
 * from the intraday series rather than requested separately — one fetch fewer,
 * and the two timeframes are then guaranteed to agree with each other.
 */
export function buildStack({ intraday = [], daily = [], now = null } = {}) {
  return {
    fiveMin: resample(intraday, INTERVAL_MINUTES['5m'], { now }),
    hourly: resample(intraday, INTERVAL_MINUTES['1h'], { now }),
    daily: mergeDaily(daily, intraday, { now }),
  };
}

/**
 * The interval a series is actually made of, in minutes.
 *
 * Read from the data rather than trusted from a label: providers relabel,
 * cache and backfill, and building a 1-minute ladder rung out of 5-minute bars
 * because a field said `interval: '1m'` would produce a chart that looks
 * plausible and is fiction. The median gap is used rather than the mean so a
 * lunch-hour lull or an overnight break cannot drag the answer.
 */
export function detectInterval(bars) {
  const times = (Array.isArray(bars) ? bars : [])
    .map((bar) => new Date(bar?.time).getTime())
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b);
  if (times.length < 3) return null;

  const gaps = [];
  for (let i = 1; i < times.length; i += 1) {
    const minutes = (times[i] - times[i - 1]) / 60_000;
    // Session breaks are not the bar interval; anything over four hours is one.
    if (minutes > 0 && minutes <= 240) gaps.push(minutes);
  }
  if (!gaps.length) return null;

  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/**
 * Assemble the rungs of a ladder from whatever the provider supplied.
 *
 * `ladder` is a list of interval keys, slowest first — `['1h', '15m', '5m']`.
 * Each rung is built by resampling the intraday series, except `1d`, which
 * comes from the daily history spliced with today's intraday bars.
 *
 * The one thing this refuses to do is invent resolution. Bars can be combined,
 * never split: a 1-minute rung cannot be built from 5-minute bars, and
 * pretending otherwise would put four fabricated bars between every real pair
 * and hand the swing detector pivots that never traded. A rung that cannot be
 * built comes back with `bars: []` and a `problem` saying why, which surfaces
 * as `unreadable` rather than as a confident wrong answer.
 */
export function buildLadder({ ladder = [], intraday = [], daily = [], now = null } = {}) {
  const sourceMinutes = detectInterval(intraday);

  return ladder.map((key) => {
    if (key === '1d') {
      const bars = mergeDaily(daily, intraday, { now });
      return {
        key,
        bars,
        problem: bars.length ? null : 'No daily history from this feed',
      };
    }

    const minutes = INTERVAL_MINUTES[key];
    if (!minutes) return { key, bars: [], problem: `Unknown interval "${key}"` };

    if (sourceMinutes === null) {
      return { key, bars: [], problem: 'No intraday history from this feed' };
    }
    if (minutes < sourceMinutes - 1e-9) {
      return {
        key,
        bars: [],
        problem:
          `This feed serves ${sourceMinutes}-minute bars, so a ${key} rung cannot be built — ` +
          'bars can be combined but never split',
      };
    }

    return { key, bars: resample(intraday, minutes, { now }), problem: null };
  });
}
