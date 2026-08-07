/**
 * Expected share of a day's volume by a given point in the session.
 *
 * Relative volume asks "is this stock trading more than it normally would by
 * now?" — which needs a model of what "by now" normally means. Pro-rating the
 * daily average linearly assumes volume arrives evenly, and it does not: US
 * equity volume is strongly U-shaped, heaviest in the first and last half hour.
 *
 * Linear pro-rating gets the opening badly wrong in both directions:
 *   - a naive elapsed fraction expects ~0.26% of the day's volume one minute in,
 *     when a typical stock has already done ~1.5%, so every stock looks like a
 *     6x runner at 09:31
 *   - clamping that fraction to a floor (the previous approach here) overshoots
 *     the other way and divides by a baseline ~8x too large, so a real 8x
 *     runner reads as 1x — and it reads that way for the first several minutes
 *     of the session, which is precisely when this strategy trades
 *
 * The curve below is the standard U-shape in 30-minute buckets, interpolated
 * within a bucket. It is an approximation of a typical liquid US equity, not a
 * per-symbol profile — good enough to make the opening readings meaningful,
 * and honest about being a model rather than measured data.
 */

export const SESSION_MINUTES = 390; // 09:30 to 16:00

/**
 * Share of the day's volume traded in each 30-minute bucket, opening bell
 * first. Sums to 1. Heaviest at the open and into the close, lightest at lunch.
 */
const BUCKET_SHARES = [
  0.155, // 09:30-10:00  the opening drive
  0.085, // 10:00-10:30
  0.065, // 10:30-11:00
  0.055, // 11:00-11:30
  0.048, // 11:30-12:00
  0.042, // 12:00-12:30  midday lull
  0.040, // 12:30-13:00
  0.040, // 13:00-13:30
  0.045, // 13:30-14:00
  0.052, // 14:00-14:30
  0.061, // 14:30-15:00
  0.082, // 15:00-15:30
  0.230, // 15:30-16:00  the closing auction dominates
];

/** Cumulative share at the end of each bucket. */
const CUMULATIVE = BUCKET_SHARES.reduce((acc, share) => {
  acc.push((acc.at(-1) ?? 0) + share);
  return acc;
}, []);

/**
 * Fraction of a typical day's volume expected to have traded `minutes` after
 * the opening bell. Clamped to (0, 1]; never returns zero, so it is always safe
 * as a divisor.
 */
export function expectedVolumeFraction(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return CUMULATIVE[0] / 30; // one minute in
  if (minutes >= SESSION_MINUTES) return 1;

  const bucket = Math.floor(minutes / 30);
  const into = (minutes % 30) / 30;
  const start = bucket === 0 ? 0 : CUMULATIVE[bucket - 1];
  const end = CUMULATIVE[Math.min(bucket, CUMULATIVE.length - 1)];

  // Linear within the bucket — the shape that matters is between buckets.
  return Math.min(Math.max(start + (end - start) * into, 1e-4), 1);
}

/** Minutes since the opening bell in New York; negative before the open. */
export function minutesIntoSession(now = new Date()) {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return et.getHours() * 60 + et.getMinutes() + et.getSeconds() / 60 - (9 * 60 + 30);
}

/**
 * The baseline to divide today's volume by.
 *
 * `live` is the market's own answer about whether the session is running — a
 * completed or not-yet-started session compares against a whole average day,
 * never against a partial one.
 */
export function expectedVolumeBy(avgDailyVolume, { live, now = new Date() } = {}) {
  if (!Number.isFinite(avgDailyVolume) || avgDailyVolume <= 0) return null;
  if (!live) return avgDailyVolume;

  const elapsed = minutesIntoSession(now);

  // The feed says the session is open but our clock disagrees — skew, a stub,
  // or an extended session. Rather than divide by a near-zero baseline and
  // report every stock as a thousand-x runner, fall back to the full day. That
  // under-reports, which is the safe direction for something that gates trades.
  if (elapsed < 0 || elapsed > SESSION_MINUTES) return avgDailyVolume;

  return avgDailyVolume * expectedVolumeFraction(elapsed);
}

/**
 * Relative volume: today's volume against what this stock would normally have
 * traded by this point. Returns null when either input is missing.
 */
export function relativeVolume(volume, avgDailyVolume, options) {
  const expected = expectedVolumeBy(avgDailyVolume, options);
  if (!expected || !Number.isFinite(volume)) return null;
  return volume / expected;
}
