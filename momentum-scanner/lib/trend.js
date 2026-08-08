/**
 * Multi-timeframe trend continuation.
 *
 * The premise is that a trend is the same phenomenon at every resolution, and
 * that the reliable place to get in is not the start of a move — nobody
 * identifies that in time — but the *pause inside one that is already running*.
 * So the strategy reads three timeframes and asks three separate questions:
 *
 *   Daily   — which way is this thing going at all?          (permission)
 *   Hourly  — is the current leg still intact?               (structure)
 *   5-minute— has it paused, and has the pause ended?        (timing)
 *
 * The distinction that makes it work is between a **correction** and a
 * **reversal**, and it is not a matter of degree — it is a specific price
 * level. In an uptrend the hourly chart is a sequence of higher highs and
 * higher lows; the most recent confirmed hourly *swing low* is the price that
 * sequence depends on. A 5-minute sell-off that stays above it has taken
 * nothing away from the hourly trend, however unpleasant it looks on the
 * 5-minute chart. One that trades through it has ended the sequence, and what
 * looked like a pullback to buy is now a lower low to stand aside from.
 *
 * That level — `invalidation` throughout this file — is the whole strategy.
 * It decides whether a dip is an entry or an exit, it sets the structural
 * stop, and it is why the 5-minute chart is only ever allowed to answer *when*,
 * never *whether*.
 *
 * The entry itself is the resumption: a break of the pullback's extreme in the
 * direction of the higher timeframes, with the stop just beyond the pullback.
 * Setups come out in the same shape the detectors in patterns.js produce, so
 * trade-plan.js sizes them with the same risk rules and the journal records
 * them like any other trade.
 *
 * Everything here is pure. Bars in, analysis out — no clock, no network, no
 * state carried between calls.
 */

export const DEFAULT_TREND_CONFIG = {
  // --- structure ---
  swingSpan: 2, // bars either side of a pivot before it counts as one
  minBars: 20, // fewer than this and a timeframe is not read at all
  maxSwingsRead: 4, // how far back the higher-high/higher-low sequence is traced

  // --- how much of each series is read ---
  // A feed hands over weeks of 5-minute bars, but "the current 5-minute leg"
  // is a today-and-yesterday question. Reading the whole series would measure
  // the pullback against a high set nine sessions ago and call every dip a
  // 90% retracement. Each timeframe therefore gets a window sized to the
  // question it answers.
  fiveMinWindow: 120, // ~1.5 sessions
  hourlyWindow: 90, // ~2 weeks
  dailyWindow: 140, // ~7 months

  // --- momentum confirmation ---
  fastPeriod: 9, // fast EMA
  slowPeriod: 21, // slow EMA; also the bars needed before momentum is read
  slopeBars: 5, // bars over which the slow EMA's slope is measured
  strongSlopePct: 1.0, // slow-EMA slope, in %, that counts as fully trending

  // --- the correction on the 5-minute chart ---
  maxPullbackBars: 12, // longer than this and the move has stalled, not paused
  maxRetracePct: 61.8, // deeper than this into the leg is a reversal, not a pause
  minRetracePct: 15, // shallower than this has not paused yet, it is still driving
  minLegPct: 0.4, // the leg being continued has to have gone somewhere
  stopAtrMultiple: 0.25, // room beyond the pullback extreme, in 5-minute ATRs
  atrPeriod: 14,
  triggerBufferPct: 0.03, // trigger sits this far beyond the pullback extreme
  maxChasePct: 1.0, // past this much through the trigger, the entry is gone
  minMeasuredR: 2, // an equal-leg projection has to clear this to be worth it

  // Which run of timeframes to read. A name from LADDERS below, which is
  // declared after this object only because it reads better in that order.
  ladder: 'swing',
};

export const TIMEFRAME_LABELS = {
  '1m': '1-minute',
  '5m': '5-minute',
  '15m': '15-minute',
  '30m': '30-minute',
  '1h': 'Hourly',
  '4h': '4-hour',
  '1d': 'Daily',
  // The names the original three-timeframe entry points still use.
  daily: 'Daily',
  hourly: 'Hourly',
  fiveMin: '5-minute',
};

/**
 * Named ladders.
 *
 * The higher-high/higher-low relationship is scale-invariant: 1-minute pauses
 * inside 5-minute structure exactly as 5-minute pauses inside hourly, and
 * hourly inside daily. So the strategy is not really about the daily, the
 * hourly and the 5-minute — it is about *any* run of adjacent timeframes, and
 * which run you pick is a choice about holding period, not about the method.
 *
 * Slowest first. The last entry times the trade, the one before it supplies
 * the structure that decides correction from reversal, and everything above
 * grants permission.
 */
export const LADDERS = {
  swing: ['1d', '1h', '5m'], // the original: days of context, minutes of timing
  intraday: ['1h', '15m', '5m'],
  scalp: ['15m', '5m', '1m'],
  micro: ['5m', '1m'], // two rungs: structure and timing, no permission layer
  wide: ['1d', '4h', '1h'], // multi-day holds
};

export const DEFAULT_LADDER = 'swing';

/** Every state the stack can be in, in the order they occur. */
export const STACK_STATES = [
  'unreadable', // not enough bars on some timeframe to judge anything
  'not_aligned', // daily and hourly do not agree — no permission to trade
  'extended', // aligned and driving, but no pullback to enter on
  'pullback_forming', // correcting, hourly structure intact, still making new extremes
  'armed', // correction has stalled — the trigger is live
  'triggered', // price has broken back in the trend's direction
  'no_entry', // the pause is valid but has no extreme to build a trade against
  'too_deep', // correction is intact but has gone too far into the leg to trust
  'invalidated', // the correction broke the hourly structure — it was a reversal
];

const SIGN = { up: 1, down: -1 };

function normalizeConfig(config = {}) {
  const merged = { ...DEFAULT_TREND_CONFIG, ...config };
  for (const [key, fallback] of Object.entries(DEFAULT_TREND_CONFIG)) {
    // Not every setting is a number. Coercing the ladder name through Number()
    // would turn 'scalp' into NaN and silently reset it to the default.
    if (typeof fallback === 'string') {
      merged[key] = typeof merged[key] === 'string' && merged[key] ? merged[key] : fallback;
      continue;
    }
    const value = Number(merged[key]);
    merged[key] = Number.isFinite(value) && value > 0 ? value : fallback;
  }
  merged.swingSpan = Math.max(1, Math.round(merged.swingSpan));
  merged.slowPeriod = Math.max(merged.slowPeriod, merged.fastPeriod + 1);
  // A stored ladder naming something that no longer exists falls back rather
  // than producing an empty run.
  if (!LADDERS[merged.ladder]) merged.ladder = DEFAULT_LADDER;
  return merged;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function usableBars(candles) {
  if (!Array.isArray(candles)) return [];
  return candles.filter(
    (c) =>
      c &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      c.high >= c.low &&
      c.low > 0,
  );
}

/* ------------------------------------------------------------------ */
/* structure                                                           */
/* ------------------------------------------------------------------ */

/**
 * Confirmed swing points.
 *
 * A pivot high is a bar whose high is not exceeded by the `span` bars on
 * either side of it. The bars on the right are the point: a high with nothing
 * yet to its right is not a swing high, it is the current bar. Waiting for
 * confirmation is what stops the structure read from rewriting itself every
 * time a new bar prints, and it is why the last `span` bars never produce
 * pivots here.
 */
export function swingPoints(candles, span = DEFAULT_TREND_CONFIG.swingSpan) {
  const bars = usableBars(candles);
  const width = Math.max(1, Math.round(span));
  const highs = [];
  const lows = [];

  for (let i = width; i < bars.length - width; i += 1) {
    const bar = bars[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - width; j <= i + width; j += 1) {
      if (j === i) continue;
      if (bars[j].high >= bar.high) isHigh = false;
      if (bars[j].low <= bar.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ index: i, price: bar.high, time: bar.time ?? null });
    if (isLow) lows.push({ index: i, price: bar.low, time: bar.time ?? null });
  }

  return { highs, lows };
}

/** Consecutive strictly-rising steps counting back from the end of a series. */
function risingSteps(values) {
  let steps = 0;
  for (let i = values.length - 1; i > 0; i -= 1) {
    if (values[i] > values[i - 1]) steps += 1;
    else break;
  }
  return steps;
}

/** Consecutive strictly-falling steps counting back from the end. */
function fallingSteps(values) {
  let steps = 0;
  for (let i = values.length - 1; i > 0; i -= 1) {
    if (values[i] < values[i - 1]) steps += 1;
    else break;
  }
  return steps;
}

/**
 * Read a higher-high/higher-low (or lower-low/lower-high) sequence.
 *
 * Both sides have to agree. Rising highs on their own are a market pushing
 * into supply and failing to hold; rising lows on their own are a market
 * grinding sideways into resistance. It is the pair that describes a trend,
 * and it is the pair whose break describes its end.
 */
function readStructure(candles, cfg) {
  const pivots = swingPoints(candles, cfg.swingSpan);
  const highs = pivots.highs.slice(-cfg.maxSwingsRead);
  const lows = pivots.lows.slice(-cfg.maxSwingsRead);

  const base = {
    swingHighs: highs,
    swingLows: lows,
    lastSwingHigh: highs.at(-1) ?? null,
    lastSwingLow: lows.at(-1) ?? null,
  };

  if (highs.length < 2 || lows.length < 2) {
    return {
      ...base,
      direction: 'none',
      steps: 0,
      invalidation: null,
      detail: 'Not enough confirmed swings yet to call a sequence',
    };
  }

  const highPrices = highs.map((p) => p.price);
  const lowPrices = lows.map((p) => p.price);
  const up = Math.min(risingSteps(highPrices), risingSteps(lowPrices));
  const down = Math.min(fallingSteps(highPrices), fallingSteps(lowPrices));

  if (up >= 1) {
    return {
      ...base,
      direction: 'up',
      steps: up,
      // The higher-low the sequence rests on. Lose it and the sequence is over.
      invalidation: base.lastSwingLow.price,
      detail: `${up + 1} rising swing high${up ? 's' : ''} and higher lows, last higher low at ${base.lastSwingLow.price.toFixed(2)}`,
    };
  }
  if (down >= 1) {
    return {
      ...base,
      direction: 'down',
      steps: down,
      invalidation: base.lastSwingHigh.price,
      detail: `${down + 1} falling swing lows and lower highs, last lower high at ${base.lastSwingHigh.price.toFixed(2)}`,
    };
  }

  return {
    ...base,
    direction: 'none',
    steps: 0,
    invalidation: null,
    detail: 'Swings are not making consistent higher highs and higher lows, or lower lows and lower highs',
  };
}

/* ------------------------------------------------------------------ */
/* momentum                                                            */
/* ------------------------------------------------------------------ */

/** Exponential moving average, seeded with the simple average of the first N. */
export function ema(values, period) {
  const series = values.filter(Number.isFinite);
  if (series.length < period || period < 1) return [];

  const k = 2 / (period + 1);
  let value = series.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = [value];
  for (let i = period; i < series.length; i += 1) {
    value = series[i] * k + value * (1 - k);
    out.push(value);
  }
  return out;
}

/** Average true range — the bar-to-bar noise the stop has to sit outside of. */
export function atr(candles, period = DEFAULT_TREND_CONFIG.atrPeriod) {
  const bars = usableBars(candles);
  if (bars.length < 2) return null;

  const ranges = [];
  for (let i = 1; i < bars.length; i += 1) {
    const prevClose = bars[i - 1].close;
    ranges.push(
      Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - prevClose),
        Math.abs(bars[i].low - prevClose),
      ),
    );
  }
  const window = ranges.slice(-Math.max(1, Math.round(period)));
  return window.reduce((a, b) => a + b, 0) / window.length;
}

/**
 * Moving-average read, used to confirm — never to originate — a direction.
 *
 * Structure decides which way the market is going; the averages only say
 * whether the recent path agrees. Given a choice, structure wins, because a
 * moving average is a lagging summary of the same prices the swings are made
 * of, and treating it as independent evidence double-counts them.
 */
function readMomentum(candles, cfg) {
  const closes = usableBars(candles).map((c) => c.close);
  if (closes.length < cfg.slowPeriod) {
    return {
      available: false,
      detail: `Needs ${cfg.slowPeriod} bars for the ${cfg.slowPeriod}-period average, has ${closes.length}`,
    };
  }

  const fast = ema(closes, Math.round(cfg.fastPeriod));
  const slow = ema(closes, Math.round(cfg.slowPeriod));
  const fastNow = fast.at(-1);
  const slowNow = slow.at(-1);
  const close = closes.at(-1);

  const back = Math.min(Math.round(cfg.slopeBars), slow.length - 1);
  const slopePct = back > 0 ? ((slowNow - slow.at(-1 - back)) / slow.at(-1 - back)) * 100 : 0;

  let stacked = 'mixed';
  if (close > fastNow && fastNow > slowNow) stacked = 'up';
  else if (close < fastNow && fastNow < slowNow) stacked = 'down';

  return {
    available: true,
    fast: round(fastNow, 4),
    slow: round(slowNow, 4),
    slopePct: round(slopePct, 3),
    stacked,
    detail:
      stacked === 'mixed'
        ? 'Price and its averages are not stacked in either direction'
        : `Price ${stacked === 'up' ? 'above' : 'below'} both averages, slow average ${slopePct >= 0 ? 'rising' : 'falling'} ${Math.abs(slopePct).toFixed(2)}% over ${back} bars`,
  };
}

/* ------------------------------------------------------------------ */
/* one timeframe                                                       */
/* ------------------------------------------------------------------ */

/**
 * Classify a single timeframe.
 *
 * Returns a direction, a 0-1 strength, the structure behind it and the level
 * that would end it. A timeframe with too few bars comes back `usable: false`
 * rather than `direction: 'none'` — "the feed did not give me enough to look
 * at" and "I looked and there is no trend" are different answers, and only one
 * of them is a reason to stand aside.
 */
export function trendOf(candles, config = {}) {
  const cfg = normalizeConfig(config);
  const bars = usableBars(candles);

  if (bars.length < cfg.minBars) {
    return {
      usable: false,
      direction: 'none',
      strength: 0,
      bars: bars.length,
      structure: null,
      momentum: null,
      lastClose: bars.at(-1)?.close ?? null,
      invalidation: null,
      detail: `Only ${bars.length} bars — needs ${cfg.minBars} to read structure`,
    };
  }

  const structure = readStructure(bars, cfg);
  const momentum = readMomentum(bars, cfg);

  let direction = structure.direction;
  const notes = [];

  // Momentum cannot create a direction, but it can withdraw one. Structure
  // pointing up while price sits under a falling average is a sequence that
  // has not broken *yet* — which is not the same as a trend to trade with.
  if (
    direction !== 'none' &&
    momentum.available &&
    momentum.stacked === (direction === 'up' ? 'down' : 'up') &&
    Math.sign(momentum.slopePct) === -SIGN[direction]
  ) {
    notes.push(
      `Swing structure is ${direction} but price and its moving averages are stacked the other way — treating this timeframe as unclear`,
    );
    direction = 'none';
  }

  const strength = direction === 'none' ? 0 : scoreStrength(direction, structure, momentum, cfg);

  return {
    usable: true,
    direction,
    strength: round(strength, 3),
    bars: bars.length,
    structure,
    momentum,
    lastClose: bars.at(-1).close,
    // Only meaningful when there is a direction: it is the price that ends it.
    invalidation: direction === 'none' ? null : structure.invalidation,
    notes,
    detail:
      direction === 'none'
        ? (notes[0] ?? structure.detail)
        : `${direction === 'up' ? 'Uptrend' : 'Downtrend'}: ${structure.detail}. ${momentum.detail}`,
  };
}

function scoreStrength(direction, structure, momentum, cfg) {
  // How many swings deep the sequence runs. Two steps is a trend; four is a
  // trend that has been proving itself.
  const structureScore = Math.min(structure.steps, 3) / 3;

  if (!momentum.available) {
    // With no momentum read, structure carries the whole score but is capped —
    // an unconfirmed trend should never grade as a maximal one.
    return structureScore * 0.7;
  }

  const momentumScore = momentum.stacked === direction ? 1 : momentum.stacked === 'mixed' ? 0.5 : 0;
  const slopeScore = Math.min(
    Math.max((momentum.slopePct * SIGN[direction]) / cfg.strongSlopePct, 0),
    1,
  );

  return structureScore * 0.45 + momentumScore * 0.3 + slopeScore * 0.25;
}

/* ------------------------------------------------------------------ */
/* the correction                                                      */
/* ------------------------------------------------------------------ */

/**
 * Measure the pause on the fast timeframe against the leg it is pausing in.
 *
 * "The leg" sounds obvious and is not. The naive reading — highest high in the
 * window, everything after it is the pullback — breaks the moment a market
 * makes a high, corrects for two hours, and then rallies again without
 * exceeding that old high. The naive reading still points at the old high and
 * reports a two-hour, 140%-of-the-leg pullback, when what is actually on the
 * screen is a fresh leg up off a higher low with a three-bar pause in it.
 *
 * So the leg is found structurally instead, by walking back through the
 * confirmed swings: the most recent swing low (in an uptrend) that price has
 * since risen far enough from to count as a drive. That anchor is the leg's
 * origin, the highest high since it is the leg's extreme, and the bars after
 * that high are the pause. Walking back — rather than taking the last swing
 * outright — is what handles a pullback that has itself made a small swing
 * inside it: that swing yields a leg too small to qualify, so the search
 * continues to the real one.
 */
function readCorrection(candles, direction, cfg) {
  const bars = usableBars(candles);
  const up = direction === 'up';
  if (bars.length < 5) {
    return { active: false, bars: 0, detail: 'Too few bars on the fast timeframe to measure a pullback' };
  }

  const pivots = swingPoints(bars, cfg.swingSpan);
  const anchors = (up ? pivots.lows : pivots.highs).slice();
  // Last resort when the window holds no confirmed swing yet: the window's own
  // extreme. It is a worse anchor, so it is only ever used when there is no
  // structural one at all.
  if (!anchors.length) {
    const fallback = up
      ? Math.min(...bars.map((b) => b.low))
      : Math.max(...bars.map((b) => b.high));
    anchors.push({ index: 0, price: fallback, time: bars[0].time ?? null });
  }

  const extremeOf = (slice) =>
    up ? Math.max(...slice.map((b) => b.high)) : Math.min(...slice.map((b) => b.low));

  let leg = null;
  for (let k = anchors.length - 1; k >= 0; k -= 1) {
    const anchor = anchors[k];
    const after = bars.slice(anchor.index + 1);
    if (after.length < 2) continue;

    const extreme = extremeOf(after);
    const legSize = Math.abs(extreme - anchor.price);
    const legPct = (legSize / anchor.price) * 100;
    if (legPct < cfg.minLegPct) continue; // a wiggle inside the pause, not the leg

    // The most recent bar to reach the extreme — a level revisited twice is
    // still the same leg, and the pullback starts from the later touch.
    let extremeIndex = anchor.index + 1;
    for (let i = bars.length - 1; i > anchor.index; i -= 1) {
      if (Math.abs((up ? bars[i].high : bars[i].low) - extreme) < 1e-9) {
        extremeIndex = i;
        break;
      }
    }

    leg = { origin: anchor.price, originTime: anchor.time, extreme, extremeIndex, legSize, legPct };
    break;
  }

  if (!leg) {
    return {
      active: false,
      bars: 0,
      detail: `No drive of at least ${cfg.minLegPct}% off a confirmed swing — there is no leg to continue`,
    };
  }

  const pullback = bars.slice(leg.extremeIndex + 1);

  if (!pullback.length) {
    return {
      active: false,
      bars: 0,
      extreme: round(leg.extreme, 4),
      origin: round(leg.origin, 4),
      legPct: round(leg.legPct),
      retracePct: 0,
      pullbackExtreme: round(leg.extreme, 4),
      lastClose: bars.at(-1).close,
      detail: 'Still making new extremes — no pause to enter on yet',
    };
  }

  // How far back into the leg the pause has come. Over 100% means it did not
  // pause at all: it went straight through where the leg began.
  const pullbackExtreme = up
    ? Math.min(...pullback.map((b) => b.low))
    : Math.max(...pullback.map((b) => b.high));
  const retracePct = leg.legSize > 0 ? (Math.abs(leg.extreme - pullbackExtreme) / leg.legSize) * 100 : 0;

  // The pause has stalled once the most recent bar stops extending it — the
  // first evidence that the sellers driving an uptrend's pullback are finished.
  // Deliberately a weak signal: it changes the label on the setup, not whether
  // the setup exists.
  const last = pullback.at(-1);
  const earlier = pullback.slice(0, -1);
  const extendedByLast =
    earlier.length > 0 &&
    (up
      ? last.low < Math.min(...earlier.map((b) => b.low))
      : last.high > Math.max(...earlier.map((b) => b.high)));
  // One bar cannot have stalled: there is nothing to compare it against. Not
  // knowing is reported as not knowing, rather than defaulting to the reading
  // that happens to look more actionable.
  const stalled = pullback.length >= 2 && !extendedByLast;

  return {
    active: true,
    bars: pullback.length,
    extreme: round(leg.extreme, 4),
    origin: round(leg.origin, 4),
    legSize: round(leg.legSize, 4),
    legPct: round(leg.legPct),
    pullbackExtreme: round(pullbackExtreme, 4),
    // The price a break of the pause would have to clear.
    trigger: up
      ? Math.max(...pullback.map((b) => b.high))
      : Math.min(...pullback.map((b) => b.low)),
    retracePct: round(retracePct),
    stalled,
    lastClose: last.close,
    detail:
      `${pullback.length} bar${pullback.length === 1 ? '' : 's'} of pullback, ` +
      `giving back ${retracePct.toFixed(0)}% of a ${leg.legPct.toFixed(1)}% leg`,
  };
}

/* ------------------------------------------------------------------ */
/* the ladder                                                          */
/* ------------------------------------------------------------------ */

/**
 * How many bars of each interval are worth reading.
 *
 * "The current leg" means something different on each rung. On a 1-minute
 * chart it is a question about the last couple of hours; on a daily chart it
 * is a question about the last few months. Reading the whole series on the
 * fast rungs would measure today's pullback against a high set last week and
 * call every dip a 95% retracement.
 */
export const DEFAULT_WINDOWS = {
  '1m': 240, // ~4 hours
  '5m': 120, // ~1.5 sessions
  '15m': 90, // ~3 sessions
  '30m': 90,
  '1h': 90, // ~2 weeks
  '4h': 90,
  '1d': 140, // ~7 months
};

export function readWindow(key, config = {}) {
  return windowFor(key, normalizeConfig(config));
}

function windowFor(key, cfg) {
  if (cfg.windows && Number.isFinite(Number(cfg.windows[key]))) return Number(cfg.windows[key]);
  // The original single-purpose knobs still work, so a stored data/trend.json
  // written before ladders existed keeps meaning what it meant.
  if (key === '5m' || key === 'fiveMin') return cfg.fiveMinWindow;
  if (key === '1h' || key === 'hourly') return cfg.hourlyWindow;
  if (key === '1d' || key === 'daily') return cfg.dailyWindow;
  return DEFAULT_WINDOWS[key] ?? 120;
}

const labelFor = (key) => TIMEFRAME_LABELS[key] ?? key;

/** "Daily and Hourly", "Daily, Hourly and 15-minute". */
function joinLabels(list) {
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
}

/**
 * Run the strategy over a ladder of timeframes.
 *
 * `rungs` is `[{ key, bars }, ...]` ordered **slowest first**. The last rung
 * times the trade, the one above it supplies the structure that separates a
 * correction from a reversal, and every rung above that grants permission.
 *
 * Two rungs is the minimum and is a real configuration — structure and timing,
 * no permission layer. Three is the usual shape. More is allowed and simply
 * means more has to agree before anything is traded.
 *
 * The result always explains itself: a `state`, a sentence of `detail`, the
 * nested `invalidations` ladder, and — only when the state warrants one — a
 * `setup` that trade-plan.js can size.
 */
export function analyzeLadder(rungs = [], config = {}) {
  const cfg = normalizeConfig(config);

  const given = (Array.isArray(rungs) ? rungs : []).filter((rung) => rung && rung.key);

  const base = {
    ladder: given.map((rung) => rung.key),
    rungs: [],
    timeframes: {},
    direction: null,
    contextAligned: false,
    stacked: false,
    agreement: 0,
    invalidation: null,
    invalidations: [],
    correction: null,
    setup: null,
    notes: [],
  };

  if (given.length < 2) {
    return {
      ...base,
      state: 'unreadable',
      detail:
        'A ladder needs at least two timeframes: one to say whether the trend is intact and a ' +
        'faster one to time the entry. One timeframe on its own cannot tell a pause from a reversal.',
    };
  }

  const reads = given.map((rung, i) => {
    const bars = Array.isArray(rung.bars)
      ? rung.bars.slice(-Math.max(1, Math.round(windowFor(rung.key, cfg))))
      : [];
    return {
      key: rung.key,
      label: labelFor(rung.key),
      role: i === given.length - 1 ? 'timing' : i === given.length - 2 ? 'structure' : 'permission',
      // Why this rung could not be built at all, if it could not — set by
      // buildLadder when a feed's bars are too coarse for the interval asked
      // for. A rung that could not be built is a different failure from one
      // that simply has too few bars, and the two should not read alike.
      problem: rung.problem ?? null,
      bars,
      trend: trendOf(bars, cfg),
    };
  });

  const timing = reads.at(-1);
  const structure = reads.at(-2);
  const higher = reads.slice(0, -1); // everything the timing rung must respect

  // Keyed by interval, plus the three original names when those intervals are
  // on the ladder, so callers written against the old shape keep working.
  const timeframes = {};
  for (const read of reads) {
    timeframes[read.key] = read.trend;
    if (read.key === '1d') timeframes.daily = read.trend;
    if (read.key === '1h') timeframes.hourly = read.trend;
    if (read.key === '5m') timeframes.fiveMin = read.trend;
  }

  const described = reads.map((read) => ({
    key: read.key,
    label: read.label,
    role: read.role,
    problem: read.problem,
    direction: read.trend.direction,
    strength: read.trend.strength,
    usable: read.trend.usable,
    bars: read.trend.bars,
    invalidation: read.trend.invalidation,
    detail: read.trend.detail,
  }));

  const withStructure = { ...base, rungs: described, timeframes };

  const unreadable = reads.filter((read) => !read.trend.usable);
  if (unreadable.length) {
    const blocked = unreadable.filter((read) => read.problem);
    return {
      ...withStructure,
      state: 'unreadable',
      detail: blocked.length
        ? blocked.map((read) => `${read.label}: ${read.problem}`).join('; ')
        : `Not enough history to judge the ${joinLabels(unreadable.map((r) => r.label))} ` +
          `timeframe${unreadable.length > 1 ? 's' : ''}`,
    };
  }

  // Every rung above the timing one has to agree. Disagreement anywhere in the
  // ladder is not a weaker signal, it is a different market at that scale —
  // and a 5-minute entry justified by an hourly trend the daily is fighting is
  // exactly the trade this whole structure exists to refuse.
  const direction = structure.trend.direction;
  const contextAligned = direction !== 'none' && higher.every((r) => r.trend.direction === direction);

  if (!contextAligned) {
    return {
      ...withStructure,
      state: 'not_aligned',
      detail:
        `${higher.map((r) => `${r.label} is ${describe(r.trend.direction)}`).join(', ')} — ` +
        'the ladder does not agree, so there is no trend to continue',
    };
  }

  const agreement = higher.length + (timing.trend.direction === direction ? 1 : 0);
  const invalidation = structure.trend.invalidation;
  const correction = readCorrection(timing.bars, direction, cfg);
  const sign = SIGN[direction];
  const swingWord = direction === 'up' ? 'higher low' : 'lower high';

  // The nested ladder of levels. Losing the fastest one is a pause ending;
  // losing the slowest is the whole thesis ending. Reporting all of them is
  // the point of thinking about this fractally in the first place.
  const invalidations = described
    .filter((rung) => Number.isFinite(rung.invalidation))
    .map((rung) => ({ key: rung.key, label: rung.label, level: round(rung.invalidation, 4), role: rung.role }));

  const context = {
    ...withStructure,
    direction,
    contextAligned: true,
    stacked: timing.trend.direction === direction,
    agreement,
    invalidation: round(invalidation, 4),
    invalidations,
    correction,
    notes: reads.flatMap((r) => r.trend.notes ?? []),
  };

  const higherLabels = joinLabels(higher.map((r) => r.label));
  // A two-rung ladder has exactly one rung above the timing one, and "5-minute
  // agree" is not a sentence. The phrasing follows the ladder's shape rather
  // than assuming the three-timeframe default.
  const higherPhrase =
    higher.length > 1 ? `${higherLabels} agree` : `${higherLabels} is ${describe(direction)}`;

  // The core rule, checked before anything else about the pullback: a
  // correction that has traded through the structure rung's last swing is not
  // a correction. The sequence the whole ladder rests on is over, and the
  // setup died with it.
  //
  // Strictly through, not down to. That swing low is itself made of these same
  // fast bars, so a pullback ending exactly on it has usually *defined* the
  // low rather than broken it — and a test that holds is the best version of
  // this setup, not a disqualifying one.
  if (
    correction?.active &&
    Number.isFinite(invalidation) &&
    (direction === 'up'
      ? correction.pullbackExtreme < invalidation - 1e-9
      : correction.pullbackExtreme > invalidation + 1e-9)
  ) {
    return {
      ...context,
      state: 'invalidated',
      detail:
        `The ${timing.label} pullback traded to ${fmt(correction.pullbackExtreme)}, through the ` +
        `${structure.label} ${swingWord} at ${fmt(invalidation)}. That is a break of ` +
        `${structure.label} structure, not a pause in it — stand aside.`,
    };
  }

  if (!correction.active) {
    return {
      ...context,
      state: 'extended',
      detail: Number.isFinite(correction.legPct)
        ? `${higherPhrase} and the ${timing.label} is still making new ` +
          `${direction === 'up' ? 'highs' : 'lows'}. Nothing to do but wait for the pause — ` +
          'entering an extended leg puts the stop too far away to be worth it.'
        : correction.detail,
    };
  }

  if (correction.legPct < cfg.minLegPct) {
    return {
      ...context,
      state: 'extended',
      detail:
        `The ${timing.label} leg is only ${correction.legPct.toFixed(1)}% — too small to be a leg ` +
        `worth continuing (needs ${cfg.minLegPct}%).`,
    };
  }

  // A few ticks off the high is not a correction, it is the same drive taking
  // a breath. Triggering on it means a stop inside the bar-to-bar noise, which
  // is a stop that gets hit for reasons that have nothing to do with the trade
  // being wrong.
  if (correction.retracePct < cfg.minRetracePct) {
    return {
      ...context,
      state: 'extended',
      detail:
        `Only ${correction.retracePct.toFixed(0)}% of the leg has been given back, under the ` +
        `${cfg.minRetracePct}% a pause has to reach to be one. ${higherPhrase}, so this is ` +
        'worth watching — but there is no correction to buy the end of yet.',
    };
  }

  // Duration before depth: a pullback that has run past its bar limit is
  // already the answer, and reporting it as a 200% retracement instead would
  // be arithmetically true and completely useless.
  if (correction.bars > cfg.maxPullbackBars) {
    return {
      ...context,
      state: 'too_deep',
      detail:
        `${correction.bars} ${timing.label} bars of pullback, past the ${cfg.maxPullbackBars}-bar ` +
        `limit. ${structure.label} structure is still intact at ${fmt(invalidation)}, but the move ` +
        'has stopped pausing and started stalling — wait for a new leg rather than treating this ' +
        'as a pause in the old one.',
    };
  }

  if (correction.retracePct > cfg.maxRetracePct) {
    return {
      ...context,
      state: 'too_deep',
      detail:
        (correction.retracePct > 100
          ? `The pullback has given back the whole ${correction.legPct.toFixed(1)}% leg and traded ` +
            'through where it started. '
          : `The pullback has given back ${correction.retracePct.toFixed(0)}% of the leg, past the ` +
            `${cfg.maxRetracePct}% limit. `) +
        `${structure.label} structure is still intact at ${fmt(invalidation)}, but a retracement ` +
        'that deep is closer to a reversal than a pause.',
    };
  }

  const setup = buildContinuationSetup({
    timingBars: timing.bars,
    direction,
    correction,
    invalidation,
    higher,
    timing,
    structure,
    higherPhrase:
      higher.length > 1
        ? `${higherLabels} all ${describe(direction)}`
        : `${higherLabels} ${describe(direction)}`,
    cfg,
  });

  if (!setup) {
    // Calling this "armed" would be the convenient lie: the pullback is valid,
    // but there is no trade to arm. It happens when the pause is so tight that
    // the trigger and the stop collapse onto each other.
    return {
      ...context,
      state: 'no_entry',
      detail:
        `The pullback holds ${structure.label} structure, but no entry with a usable stop can be ` +
        'built from it — the trigger and the stop are the same price.',
    };
  }

  const chasePct = ((sign * (correction.lastClose - setup.entry)) / setup.entry) * 100;

  if (chasePct > cfg.maxChasePct) {
    return {
      ...context,
      setup: null,
      state: 'triggered',
      detail:
        `The continuation already fired: price is ${chasePct.toFixed(1)}% through the ` +
        `${fmt(setup.entry)} trigger, past the ${cfg.maxChasePct}% limit. Taking it here means paying ` +
        'up for the same stop, which is how a defined-risk entry stops being one.',
    };
  }

  const state = setup.triggered ? 'triggered' : correction.stalled ? 'armed' : 'pullback_forming';

  return {
    ...context,
    setup,
    state,
    detail: stateSentence(state, direction, setup, correction, invalidation, timing, structure),
  };
}

/**
 * The original three-timeframe entry point: daily, hourly, 5-minute.
 *
 * Kept because it is the ladder most callers want and because everything
 * written before ladders existed calls it. It is now one preset among several
 * — see LADDERS.
 */
export function analyzeStack(stack = {}, config = {}) {
  return analyzeLadder(
    [
      { key: '1d', bars: stack.daily },
      { key: '1h', bars: stack.hourly },
      { key: '5m', bars: stack.fiveMin },
    ],
    config,
  );
}

/**
 * Turn a validated correction into an entry, a stop and a target.
 *
 * Two stops come out of this. The **trade stop** sits just beyond the
 * pullback's extreme, padded by a fraction of the timing timeframe's ATR so
 * ordinary noise does not take it out; that is the one the position is sized
 * against. The **structural stop** sits beyond the invalidation level — wider,
 * but the price at which the reason for the trade is actually gone. Both are
 * reported, because which one a trader uses is a real choice and not one this
 * code should make silently.
 */
function buildContinuationSetup({
  timingBars,
  direction,
  correction,
  invalidation,
  higher,
  timing,
  structure,
  higherPhrase,
  cfg,
}) {
  const sign = SIGN[direction];
  const buffer = Math.max((correction.trigger * cfg.triggerBufferPct) / 100, 0.01);
  const entry = round(correction.trigger + sign * buffer);

  const noise = atr(timingBars, cfg.atrPeriod) ?? 0;
  const stopPad = Math.max(noise * cfg.stopAtrMultiple, buffer);
  const stop = round(correction.pullbackExtreme - sign * stopPad);

  if (!Number.isFinite(entry) || !Number.isFinite(stop)) return null;
  if (sign * (entry - stop) <= 0) return null;

  const structuralStop = Number.isFinite(invalidation) ? round(invalidation - sign * stopPad) : null;

  // Measured move: the leg that just ran, projected again from where the
  // pullback ended. A projection, not a prediction — its only job is to say
  // whether there is room above the entry for the R targets to work in.
  const measuredTarget = round(correction.pullbackExtreme + sign * correction.legSize);
  const riskPerShare = Math.abs(entry - stop);
  const measuredR = riskPerShare > 0 ? (sign * (measuredTarget - entry)) / riskPerShare : null;

  const lastClose = correction.lastClose;

  // The depth of the pullback is not a matter of taste, it is the arithmetic
  // of the trade. Entry sits near the top of the leg and the stop sits below
  // the pullback, so a deeper pullback buys a wider stop *and* leaves less of
  // the projected move above the entry — it costs twice. A 30% pullback
  // projects to roughly 2R, a 60% one to well under 1R, and that is the real
  // reason shallow pullbacks are the ones worth taking.
  const cautions = [];
  if (Number.isFinite(measuredR) && measuredR < cfg.minMeasuredR) {
    cautions.push(
      `An equal-leg projection only reaches ${measuredR.toFixed(1)}R from this entry — the pullback ` +
        `gave back ${correction.retracePct.toFixed(0)}% of the leg, which leaves little room above ` +
        `the trigger. The ${cfg.minMeasuredR}R targets need more than the last leg repeating.`,
    );
  }

  // Grade the setup by the things that make it work: how strongly the higher
  // rungs agree, how little of the leg the pause gave back, and whether there
  // is room for the trade to pay.
  const higherStrength = higher.reduce((total, r) => total + (r.trend.strength ?? 0), 0) / higher.length;
  const quality =
    1 +
    higherStrength * 2 +
    (1 - correction.retracePct / 100) +
    (timing.trend.direction === direction ? 0.3 : 0) -
    (cautions.length ? 0.75 : 0);

  return {
    type: 'trend_continuation',
    label: 'Trend continuation',
    direction: direction === 'up' ? 'long' : 'short',
    trendDirection: direction,
    timingTimeframe: timing.key,
    structureTimeframe: structure.key,
    entry,
    stop,
    structuralStop,
    measuredTarget,
    measuredR: round(measuredR),
    cautions,
    // Kept under the original name as well: callers and stored journal entries
    // refer to it, and on the default ladder it is exactly what it says.
    hourlyInvalidation: round(invalidation, 4),
    invalidation: round(invalidation, 4),
    quality: round(quality, 3),
    candlesInPattern: correction.bars,
    impulsePct: correction.legPct,
    retracePct: correction.retracePct,
    lastClose: round(lastClose),
    triggered: sign * (lastClose - entry) >= 0,
    distanceToTriggerPct: round((sign * (entry - lastClose) * 100) / lastClose),
    riskPerShare: round(riskPerShare),
    riskPct: round((riskPerShare / entry) * 100),
    rationale:
      `${higherPhrase}. The ${timing.label} gave back ` +
      `${correction.retracePct.toFixed(0)}% of a ${correction.legPct.toFixed(1)}% leg over ` +
      `${correction.bars} bar${correction.bars === 1 ? '' : 's'} and held the ${structure.label} ` +
      `${direction === 'up' ? 'higher low' : 'lower high'} at ${fmt(invalidation)}. ` +
      `${direction === 'up' ? 'Long over' : 'Short under'} ${fmt(entry)}, out ` +
      `${direction === 'up' ? 'below' : 'above'} ${fmt(stop)}` +
      (structuralStop === null ? '.' : ` (structural stop ${fmt(structuralStop)}).`),
  };
}

function stateSentence(state, direction, setup, correction, invalidation, timing, structure) {
  const swingWord = direction === 'up' ? 'higher low' : 'lower high';
  if (state === 'triggered') {
    return (
      `The ${timing.label} has broken back ${direction === 'up' ? 'up' : 'down'} through ` +
      `${fmt(setup.entry)} and the continuation is live. Stop ${fmt(setup.stop)}; ` +
      `${structure.label} structure fails at ${fmt(invalidation)}.`
    );
  }
  if (state === 'armed') {
    return (
      `The pullback has stalled ${correction.retracePct.toFixed(0)}% into the leg, above the ` +
      `${structure.label} ${swingWord} at ${fmt(invalidation)}. ` +
      `${direction === 'up' ? 'Long' : 'Short'} triggers at ${fmt(setup.entry)}, stop ${fmt(setup.stop)}.`
    );
  }
  return (
    `The ${timing.label} is still correcting — ${correction.bars} bars in, ` +
    `${correction.retracePct.toFixed(0)}% of the leg given back, ${structure.label} structure intact ` +
    `at ${fmt(invalidation)}. The trade is a break of ${fmt(setup.entry)}, not this dip.`
  );
}

function describe(direction) {
  if (direction === 'up') return 'trending up';
  if (direction === 'down') return 'trending down';
  return 'unclear';
}

function fmt(value) {
  return Number.isFinite(value) ? value.toFixed(2) : 'n/a';
}

export { normalizeConfig as normalizeTrendConfig };
