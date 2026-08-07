/**
 * Entry pattern detection on 1-minute candles.
 *
 * Finding a stock with the right supply/demand imbalance (see criteria.js) says
 * *what* to trade. These patterns say *when*: each one is a moment where buyers
 * have paused without sellers taking control, so a break of the pause high is a
 * cheap place to get long with a defined, nearby stop.
 *
 * Every detector returns the same shape — a trigger price, a stop, a quality
 * score and its rationale — so trade-plan.js can size any of them identically.
 */

export const PATTERN_TYPES = ['micro_pullback', 'bull_flag', 'flat_top', 'opening_range'];

export const PATTERN_LABELS = {
  micro_pullback: 'Micro pullback',
  bull_flag: 'Bull flag',
  flat_top: 'Flat top breakout',
  opening_range: 'Opening range breakout',
};

// A trigger sits just above the pause high: we buy the actual break, not the
// high itself, which is where the resting sell orders sit.
const TICK = 0.01;

export const DEFAULT_PATTERN_CONFIG = {
  lookback: 20, // candles considered for structure
  minImpulsePct: 1.5, // a leg has to actually go somewhere to count
  maxPullbackCandles: 4, // more than this and the move has stalled, not paused
  maxRetracePct: 61.8, // deeper than this is a reversal, not a flag
  microRetracePct: 38.2, // shallower than this is a micro pullback
  flatTopTolerancePct: 0.6, // how tight "equal highs" has to be
  minFlatTopCandles: 3,
  openingRangeCandles: 5, // the 09:30-09:35 range
};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const highest = (candles) => Math.max(...candles.map((c) => c.high));
const lowest = (candles) => Math.min(...candles.map((c) => c.low));

function isUsable(candles) {
  return (
    Array.isArray(candles) &&
    candles.length >= 6 &&
    candles.every(
      (c) =>
        c &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close) &&
        c.high >= c.low &&
        c.low > 0,
    )
  );
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Mean volume of a slice, or null when the feed omits volume. */
function avgVolume(candles) {
  const values = candles.map((c) => c.volume).filter((v) => Number.isFinite(v) && v > 0);
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Split recent action into the impulse leg and the pullback that follows it.
 * The pullback is the run of candles at the end that stopped making new highs.
 * Returns null when the tail is not a pullback (still driving, or no leg).
 */
function splitImpulseAndPullback(candles, config) {
  const window = candles.slice(-config.lookback);
  if (window.length < 5) return null;

  const peak = highest(window);
  let pullbackStart = window.length;
  for (let i = window.length - 1; i >= 0; i -= 1) {
    if (window[i].high >= peak - TICK / 2) break;
    pullbackStart = i;
  }

  const pullback = window.slice(pullbackStart);
  const impulse = window.slice(0, pullbackStart);
  if (!pullback.length || impulse.length < 2) return null;

  const impulseLow = lowest(impulse);
  const impulseHigh = highest(impulse);
  const impulseGain = ((impulseHigh - impulseLow) / impulseLow) * 100;
  const pullbackLow = lowest(pullback);
  const retracePct = ((impulseHigh - pullbackLow) / (impulseHigh - impulseLow)) * 100;

  return { window, impulse, pullback, impulseLow, impulseHigh, impulseGain, pullbackLow, retracePct };
}

/**
 * Shared score: a bigger impulse is better, a shallower pullback is better.
 * Callers add their own bonuses on top.
 */
function baseQuality(impulseGain, retracePct, config) {
  return Math.min(impulseGain / config.minImpulsePct, 3) - retracePct / 100;
}

/* ------------------------------------------------------------------ */
/* detectors                                                           */
/* ------------------------------------------------------------------ */

/**
 * Micro pullback: one or two soft candles inside a strong move. The tightest
 * entry — the stop is close, so the same dollar risk buys more shares.
 */
function detectMicroPullback(candles, config) {
  const split = splitImpulseAndPullback(candles, config);
  if (!split) return null;

  const { impulse, pullback, impulseGain, pullbackLow, retracePct } = split;
  if (pullback.length > 2) return null;
  if (impulseGain < config.minImpulsePct) return null;
  if (retracePct > config.microRetracePct) return null; // deeper is a flag

  const entry = round(highest(pullback) + TICK);
  const stop = round(pullbackLow);
  if (entry <= stop) return null;

  return {
    type: 'micro_pullback',
    entry,
    stop,
    quality: baseQuality(impulseGain, retracePct, config) + 0.4, // tight stop bonus
    candlesInPattern: pullback.length,
    impulsePct: round(impulseGain),
    retracePct: round(retracePct),
    volumeDrying: dryingUp(impulse, pullback),
    rationale:
      `${pullback.length} soft candle${pullback.length === 1 ? '' : 's'} after a ` +
      `${impulseGain.toFixed(1)}% push, giving back only ${retracePct.toFixed(0)}% of the leg. ` +
      `Trigger over ${entry.toFixed(2)}, out below ${stop.toFixed(2)}.`,
  };
}

/**
 * Bull flag: a clear impulse leg, then a short orderly pullback, ideally on
 * lighter volume. The classic continuation setup.
 */
function detectBullFlag(candles, config) {
  const split = splitImpulseAndPullback(candles, config);
  if (!split) return null;

  const { impulse, pullback, impulseLow, impulseGain, pullbackLow, retracePct } = split;
  if (pullback.length < 2 || pullback.length > config.maxPullbackCandles) return null;
  if (impulseGain < config.minImpulsePct) return null;
  if (pullbackLow <= impulseLow) return null; // gave the whole leg back
  if (retracePct > config.maxRetracePct) return null;

  const entry = round(highest(pullback) + TICK);
  const stop = round(pullbackLow);
  if (entry <= stop) return null;

  // A flag should rest on lighter volume than the leg that built it; heavy
  // volume into a pullback means it is being sold, not consolidating.
  const volumeDrying = dryingUp(impulse, pullback);

  return {
    type: 'bull_flag',
    entry,
    stop,
    quality: baseQuality(impulseGain, retracePct, config) + (volumeDrying ? 0.5 : 0),
    candlesInPattern: pullback.length,
    impulsePct: round(impulseGain),
    retracePct: round(retracePct),
    volumeDrying,
    rationale:
      `${impulseGain.toFixed(1)}% impulse, then a ${pullback.length}-candle pullback holding ` +
      `${(100 - retracePct).toFixed(0)}% of it` +
      `${volumeDrying === true ? ' on drying volume' : volumeDrying === false ? ', though volume is not drying up' : ''}. ` +
      `Trigger over ${entry.toFixed(2)}, out below ${stop.toFixed(2)}.`,
  };
}

function dryingUp(impulse, pullback) {
  const impulseVolume = avgVolume(impulse);
  const pullbackVolume = avgVolume(pullback);
  if (!impulseVolume || !pullbackVolume) return null;
  return pullbackVolume < impulseVolume;
}

/**
 * Flat top: several candles capped at the same price. That ceiling is a resting
 * seller; when it clears, the stock tends to move fast.
 */
function detectFlatTop(candles, config) {
  const window = candles.slice(-config.lookback);

  // Prefer the longest base that still qualifies — a longer ceiling means more
  // supply absorbed before the break.
  for (let size = Math.min(8, window.length - 2); size >= config.minFlatTopCandles; size -= 1) {
    const slice = window.slice(-size);
    const before = window.slice(0, -size);
    if (before.length < 2) continue;

    const top = highest(slice);
    const lowestHigh = Math.min(...slice.map((c) => c.high));
    const spreadPct = ((top - lowestHigh) / top) * 100;
    if (spreadPct > config.flatTopTolerancePct) continue;

    // There has to be a move into the ceiling; otherwise it is a dead range.
    const runUpLow = lowest(before);
    const runUpPct = ((top - runUpLow) / runUpLow) * 100;
    if (runUpPct < config.minImpulsePct) continue;

    const entry = round(top + TICK);
    const stop = round(lowest(slice));
    if (entry <= stop) continue;

    return {
      type: 'flat_top',
      entry,
      stop,
      // Tighter ceilings and longer bases score better.
      quality:
        Math.min(runUpPct / config.minImpulsePct, 3) +
        size * 0.1 +
        (config.flatTopTolerancePct - spreadPct),
      candlesInPattern: size,
      impulsePct: round(runUpPct),
      rationale:
        `${size} candles capped within ${spreadPct.toFixed(2)}% of ${top.toFixed(2)} after a ` +
        `${runUpPct.toFixed(1)}% run. Trigger over ${entry.toFixed(2)}, out below ${stop.toFixed(2)}.`,
    };
  }
  return null;
}

/**
 * Opening range breakout: the high of the first few minutes is the level the
 * whole morning trades against. Only meaningful while price is still near it.
 */
function detectOpeningRange(candles, config) {
  if (candles.length < config.openingRangeCandles + 3) return null;

  const range = candles.slice(0, config.openingRangeCandles);
  const rangeHigh = highest(range);
  const rangeLow = lowest(range);
  if (!(rangeHigh > rangeLow)) return null;

  const since = candles.slice(config.openingRangeCandles);
  const last = candles.at(-1);

  // Already well through the range — that break is old news, not a setup.
  if (highest(since) > rangeHigh * 1.02) return null;
  // Broke the low: the range failed downward.
  if (lowest(since) < rangeLow) return null;
  // Price has to be coiled near the ceiling to be worth a trigger.
  if (last.close < rangeHigh * 0.97) return null;

  const entry = round(rangeHigh + TICK);
  const stop = round(Math.max(rangeLow, lowest(since.slice(-3))));
  if (entry <= stop) return null;

  const rangePct = ((rangeHigh - rangeLow) / rangeLow) * 100;

  return {
    type: 'opening_range',
    entry,
    stop,
    // A tight opening range breaking out is stronger than a sloppy wide one.
    quality: 1.2 + Math.max(0, 2 - rangePct / 2),
    candlesInPattern: config.openingRangeCandles,
    impulsePct: round(rangePct),
    rationale:
      `Opening ${config.openingRangeCandles}-minute range ${rangeLow.toFixed(2)}-${rangeHigh.toFixed(2)} ` +
      `(${rangePct.toFixed(1)}% wide), price coiled under the high. ` +
      `Trigger over ${entry.toFixed(2)}, out below ${stop.toFixed(2)}.`,
  };
}

/* ------------------------------------------------------------------ */
/* public API                                                          */
/* ------------------------------------------------------------------ */

const DETECTORS = [detectMicroPullback, detectBullFlag, detectFlatTop, detectOpeningRange];

/**
 * Run every detector over a candle series. Results are sorted best-first; an
 * empty array means "no setup right now", which is the common and correct
 * answer for most stocks at most moments.
 */
export function detectPatterns(candles, config = {}) {
  const cfg = { ...DEFAULT_PATTERN_CONFIG, ...config };
  if (!isUsable(candles)) return [];

  const last = candles.at(-1);
  const found = [];

  for (const detect of DETECTORS) {
    const setup = detect(candles, cfg);
    if (!setup) continue;

    // A trigger already far below price means the break happened without us;
    // chasing it is how a defined-risk entry turns into an undefined one.
    if (last.close > setup.entry * 1.015) continue;

    found.push({
      ...setup,
      label: PATTERN_LABELS[setup.type],
      lastClose: last.close,
      triggered: last.close >= setup.entry,
      distanceToTriggerPct: round(((setup.entry - last.close) / last.close) * 100, 2),
      riskPerShare: round(setup.entry - setup.stop),
      riskPct: round(((setup.entry - setup.stop) / setup.entry) * 100),
    });
  }

  return found.sort((a, b) => b.quality - a.quality);
}

/** The single setup to act on, or null. */
export function bestPattern(candles, config = {}) {
  return detectPatterns(candles, config)[0] ?? null;
}
