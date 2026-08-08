/**
 * Simulated market data.
 *
 * This is the default provider so the scanner is fully usable with no API key
 * and no network. Every symbol here is fictional on purpose — the numbers are
 * generated, and attaching them to real tickers would misrepresent real
 * companies. The shape of the data matches what the live providers return.
 *
 * Prices evolve smoothly with wall-clock time (value noise, not random jumps),
 * so hitting refresh looks like a moving tape rather than a reshuffle.
 */

const UNIVERSE = [
  // Low-float runners: the setups this scanner is built to surface.
  { symbol: 'VXTQ', name: 'Vertex Quantum Holdings', sector: 'Technology', prevClose: 3.12, float: 2.4e6, avgVolume: 310_000, moveTarget: 233, relVolTarget: 8100, gap: 84.6, shortInterest: 11_710, catalyst: 'Reports 6-K filing and regains Nasdaq minimum bid price compliance' },
  { symbol: 'HLNX', name: 'Helion Exploration', sector: 'Energy', prevClose: 5.42, float: 1.45e6, avgVolume: 190_000, moveTarget: 172, relVolTarget: 3570, gap: 29.3, shortInterest: 314_960, catalyst: 'Announces initial drilling results well above prior guidance' },
  { symbol: 'BIOK', name: 'Biokera Therapeutics', sector: 'Healthcare', prevClose: 3.18, float: 1.08e6, avgVolume: 240_000, moveTarget: 129, relVolTarget: 760, gap: 145.4, shortInterest: 53_220, catalyst: 'Phase 2 trial meets primary endpoint' },
  { symbol: 'ZYBT', name: 'Zybrant Materials', sector: 'Industrials', prevClose: 1.28, float: 5.62e6, avgVolume: 410_000, moveTarget: 90, relVolTarget: 129, gap: -1.6, shortInterest: 57_360, catalyst: 'Signs supply agreement with tier-one manufacturer' },
  { symbol: 'OESX', name: 'Orion Edge Systems', sector: 'Technology', prevClose: 10.4, float: 3.35e6, avgVolume: 220_000, moveTarget: 50, relVolTarget: 3596, gap: 31.4, shortInterest: 22_050, catalyst: 'Raises full-year revenue outlook' },
  { symbol: 'GTEL', name: 'Gateline Energy', sector: 'Energy', prevClose: 6.84, float: 26.88e6, avgVolume: 900_000, moveTarget: 44, relVolTarget: 200, gap: 51.2, shortInterest: 1_850_000, catalyst: 'Announces asset sale and debt paydown' },
  { symbol: 'BJDX', name: 'Bridgedex Labs', sector: 'Healthcare', prevClose: 0.94, float: 971_600, avgVolume: 620_000, moveTarget: 48, relVolTarget: 1175, gap: 48.0, shortInterest: 569_670, catalyst: 'FDA clears expanded label' },
  { symbol: 'KRNS', name: 'Karnos Robotics', sector: 'Industrials', prevClose: 4.05, float: 4.1e6, avgVolume: 155_000, moveTarget: 96, relVolTarget: 940, gap: 22.7, shortInterest: 88_400, catalyst: 'Wins multi-year automation contract' },
  { symbol: 'AVLR', name: 'Avalor Mining', sector: 'Basic Materials', prevClose: 2.61, float: 8.7e6, avgVolume: 280_000, moveTarget: 61, relVolTarget: 430, gap: 18.9, shortInterest: 142_000, catalyst: 'Assay results confirm high-grade zone' },
  { symbol: 'NUVE', name: 'Nuvera Bioscience', sector: 'Healthcare', prevClose: 7.9, float: 12.4e6, avgVolume: 340_000, moveTarget: 35, relVolTarget: 190, gap: 12.4, shortInterest: 410_000, catalyst: 'Licensing deal with global pharma partner' },

  // Near-misses: each fails exactly one pillar. These make the checklist useful.
  { symbol: 'TRAQ', name: 'Traqline Logistics', sector: 'Industrials', prevClose: 44.2, float: 6.2e6, avgVolume: 200_000, moveTarget: 41, relVolTarget: 620, gap: 24.0, shortInterest: 74_000, catalyst: 'Beats quarterly earnings estimates' }, // fails price
  { symbol: 'PLTH', name: 'Polaith Networks', sector: 'Technology', prevClose: 5.6, float: 88e6, avgVolume: 2_400_000, moveTarget: 38, relVolTarget: 540, gap: 15.5, shortInterest: 3_100_000, catalyst: 'Announces enterprise partnership' }, // fails float
  { symbol: 'CRLO', name: 'Corialo Foods', sector: 'Consumer', prevClose: 8.15, float: 3.9e6, avgVolume: 130_000, moveTarget: 26, relVolTarget: 3.1, gap: 6.2, shortInterest: 51_000, catalyst: 'Expands distribution to national grocer' }, // fails relative volume
  { symbol: 'SDNA', name: 'Sedona Analytics', sector: 'Technology', prevClose: 4.44, float: 5.1e6, avgVolume: 175_000, moveTarget: 33, relVolTarget: 480, gap: 9.8, shortInterest: 66_000, catalyst: null }, // fails news
  { symbol: 'MRTH', name: 'Meridian Therapeutics', sector: 'Healthcare', prevClose: 6.05, float: 4.4e6, avgVolume: 210_000, moveTarget: 6.5, relVolTarget: 310, gap: 3.1, shortInterest: 97_000, catalyst: 'Publishes preclinical data' }, // fails % change

  // Background tape: ordinary names that keep the scanner honest.
  { symbol: 'ANDR', name: 'Andor Capital Group', sector: 'Financial', prevClose: 12.8, float: 42e6, avgVolume: 1_100_000, moveTarget: 3.2, relVolTarget: 1.4, gap: 0.9, shortInterest: 820_000, catalyst: null },
  { symbol: 'LUMC', name: 'Lumicore Semiconductor', sector: 'Technology', prevClose: 18.6, float: 31e6, avgVolume: 1_800_000, moveTarget: 7.8, relVolTarget: 2.6, gap: 2.4, shortInterest: 2_400_000, catalyst: 'Analyst upgrade to buy' },
  { symbol: 'FRSK', name: 'Fairisk Insurance', sector: 'Financial', prevClose: 9.35, float: 55e6, avgVolume: 700_000, moveTarget: -2.1, relVolTarget: 0.8, gap: -0.6, shortInterest: 330_000, catalyst: null },
  { symbol: 'GRVT', name: 'Groveton Retail', sector: 'Consumer', prevClose: 3.72, float: 19e6, avgVolume: 480_000, moveTarget: 4.4, relVolTarget: 1.9, gap: 1.2, shortInterest: 210_000, catalyst: null },
  { symbol: 'HYDX', name: 'Hydrex Water Systems', sector: 'Utilities', prevClose: 15.1, float: 24e6, avgVolume: 260_000, moveTarget: 1.1, relVolTarget: 1.1, gap: 0.3, shortInterest: 140_000, catalyst: null },
  { symbol: 'QSTN', name: 'Questone Media', sector: 'Communication', prevClose: 2.05, float: 14e6, avgVolume: 350_000, moveTarget: 9.1, relVolTarget: 4.2, gap: 4.8, shortInterest: 260_000, catalyst: 'Q3 subscriber growth ahead of plan' },
  { symbol: 'VNTA', name: 'Ventara Aerospace', sector: 'Industrials', prevClose: 27.4, float: 9.8e6, avgVolume: 300_000, moveTarget: 14.2, relVolTarget: 22, gap: 8.1, shortInterest: 420_000, catalyst: 'Receives defense contract modification' },
  { symbol: 'ECLP', name: 'Eclipsa Solar', sector: 'Energy', prevClose: 1.42, float: 7.3e6, avgVolume: 900_000, moveTarget: 17.5, relVolTarget: 38, gap: 5.4, shortInterest: 640_000, catalyst: 'Announces utility-scale project award' },
  { symbol: 'RDBN', name: 'Redbend Software', sector: 'Technology', prevClose: 6.72, float: 21.5e6, avgVolume: 540_000, moveTarget: 12.8, relVolTarget: 9.4, gap: 3.7, shortInterest: 380_000, catalyst: 'Named in enterprise vendor report' },
  { symbol: 'STRV', name: 'Starvale Diagnostics', sector: 'Healthcare', prevClose: 2.88, float: 3.2e6, avgVolume: 200_000, moveTarget: 22.4, relVolTarget: 64, gap: 11.2, shortInterest: 118_000, catalyst: 'Receives CE mark for assay platform' },
];

const NEWS_SOURCES = ['GlobeNewswire', 'Business Wire', 'PR Newswire', 'Benzinga', 'Reuters'];

/** Small deterministic hash so every symbol gets a stable, distinct phase. */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

/**
 * Smooth value noise in [-1, 1]. Summing a few sines with symbol-specific
 * phases gives continuous drift, so consecutive scans differ by a believable
 * amount instead of jumping around.
 */
function noise(seed, tSeconds, periodSeconds = 90) {
  const phase = seed * Math.PI * 2;
  const t = (tSeconds / periodSeconds) * Math.PI * 2;
  return (
    (Math.sin(t + phase) * 0.6 +
      Math.sin(t * 2.7 + phase * 3.1) * 0.3 +
      Math.sin(t * 0.41 + phase * 1.7) * 0.1)
  );
}

/**
 * Fraction of the 9:30-16:00 ET session elapsed, clamped away from zero so
 * relative volume never divides by ~0. Outside regular hours we hold the clock
 * at an early-session value — that is when this strategy actually runs, and it
 * keeps the demo meaningful at any hour.
 */
export function sessionProgress(now = new Date()) {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const minutes = et.getHours() * 60 + et.getMinutes();
  const open = 9 * 60 + 30;
  const close = 16 * 60;
  const isWeekend = et.getDay() === 0 || et.getDay() === 6;
  if (isWeekend || minutes < open || minutes > close) {
    return { fraction: 0.12, live: false, label: 'Simulated 09:30-10:17 ET session' };
  }
  const fraction = Math.min(Math.max((minutes - open) / (close - open), 0.02), 1);
  return { fraction, live: true, label: `Session ${(fraction * 100).toFixed(0)}% elapsed` };
}

function buildNews(entry, now) {
  if (!entry.catalyst) return [];
  const seed = hash(entry.symbol);
  const minutesAgo = 20 + Math.floor(seed * 200);
  const headlines = [
    {
      headline: `${entry.name} ${entry.catalyst}`,
      source: NEWS_SOURCES[Math.floor(seed * NEWS_SOURCES.length)],
      datetime: new Date(now - minutesAgo * 60_000).toISOString(),
      url: null,
    },
  ];
  // Bigger movers usually have a follow-up story once traders pile in.
  if (entry.moveTarget > 40) {
    headlines.push({
      headline: `${entry.symbol} halted for volatility, resumes higher on heavy volume`,
      source: 'Benzinga',
      datetime: new Date(now - Math.max(minutesAgo - 15, 4) * 60_000).toISOString(),
      url: null,
    });
  }
  return headlines;
}

/**
 * Build 1-minute candles ending at `now`.
 *
 * Momentum does not travel in a straight line: it moves in impulse legs
 * separated by shallow pullbacks, which is exactly what the flag patterns look
 * for. The path here is an impulse/pullback sawtooth riding the symbol's ramp,
 * so the detectors have real structure to find rather than smooth drift.
 */
function buildCandles(entry, now, session) {
  const seed = hash(entry.symbol);
  const candles = [];

  // Run from the opening bell to now, so candle[0] really is the 09:30 bar and
  // the opening-range detector has a genuine opening range to measure.
  const SESSION_MINUTES = 390;
  const count = Math.min(Math.max(Math.round(session.fraction * SESSION_MINUTES), 20), 180);

  // Each symbol runs its own leg length and starting phase, so the universe is
  // not all pulling back on the same minute.
  const cycle = 6 + Math.round(seed * 5); // minutes per impulse + pullback leg
  const impulseShare = 0.62; // fraction of each leg spent driving up
  const phaseOffset = seed * cycle;
  // Legs have to be a real fraction of the day's move, or the "pullback" is
  // just a slower advance and no flag ever forms.
  const amplitude = 0.13 + seed * 0.07;

  const startMinute = Math.floor(now / 60_000) - count;

  // Raw 0..1-ish progress: a steady trend with an impulse/pullback sawtooth.
  const rawPath = (i) => {
    const trend = i / count;
    const phase = (((i + phaseOffset) % cycle) + cycle) % cycle / cycle;
    const leg =
      phase < impulseShare
        ? phase / impulseShare // driving up
        : 1 - ((phase - impulseShare) / (1 - impulseShare)) * 0.45; // shallow pullback
    return trend + (leg - 0.5) * amplitude + noise(seed, (startMinute + i) * 60, 900) * 0.004;
  };

  // Normalize so the first open and last close land exactly on the session's
  // open and the quote's current price — the chart and the quote must agree.
  const raw = Array.from({ length: count + 1 }, (_, i) => rawPath(i));
  const rawStart = raw[0];
  const rawEnd = raw[count];
  const rawSpan = rawEnd - rawStart || 1;
  const pathAt = (i) => (raw[i] - rawStart) / rawSpan;

  const ramp = 0.35 + 0.65 * Math.sqrt(session.fraction);
  const totalChange = entry.moveTarget * ramp;
  const openPrice = entry.prevClose * (1 + entry.gap / 100);
  const closePrice = entry.prevClose * (1 + totalChange / 100);
  const span = closePrice - openPrice;

  const perMinuteVolume = (entry.avgVolume * session.fraction * entry.relVolTarget) / count;

  for (let i = 0; i < count; i += 1) {
    const open = openPrice + span * pathAt(i);
    const close = openPrice + span * pathAt(i + 1);
    // Wick size scales with the bar's own range so quiet bars stay quiet.
    const body = Math.abs(close - open);
    const wick = Math.max(body * 0.45, Math.abs(open) * 0.0012);
    const jitter = Math.abs(noise(seed + i * 0.017, (startMinute + i) * 60, 300));

    candles.push({
      time: new Date((startMinute + i) * 60_000).toISOString(),
      open: round(Math.max(open, 0.01), 4),
      high: round(Math.max(open, close) + wick * jitter, 4),
      low: round(Math.max(Math.min(open, close) - wick * jitter, 0.005), 4),
      close: round(Math.max(close, 0.01), 4),
      // Volume surges on impulse bars, dries up in the pullback — the volume
      // signature that separates a flag from a reversal.
      volume: Math.max(
        Math.round(perMinuteVolume * (close > open ? 1.45 : 0.55) * (0.7 + jitter * 0.6)),
        1,
      ),
    });
  }

  return candles;
}

export function getQuotes({ now = Date.now() } = {}) {
  const session = sessionProgress(new Date(now));
  const tSeconds = now / 1000;

  const quotes = UNIVERSE.map((entry) => {
    const seed = hash(entry.symbol);
    const wobble = noise(seed, tSeconds); // -1 .. 1

    // Big movers ramp into their target through the session and chop around it.
    const ramp = 0.35 + 0.65 * Math.sqrt(session.fraction);
    const changeFromClosePct = entry.moveTarget * ramp * (1 + wobble * 0.08);
    const price = Math.max(entry.prevClose * (1 + changeFromClosePct / 100), 0.01);

    // Volume accrues with the session; relative volume is measured against the
    // average pace to this point in the day, which is what "daily rate" means.
    const expectedByNow = entry.avgVolume * session.fraction;
    const relativeVolume = Math.max(entry.relVolTarget * (1 + wobble * 0.06), 0.05);
    const volume = Math.round(expectedByNow * relativeVolume);

    // The 5-minute reading spikes far harder than the daily rate during a run.
    const relVol5min = Math.max(relativeVolume * (18 + wobble * 4), 0.1);

    const open = entry.prevClose * (1 + entry.gap / 100);

    return {
      symbol: entry.symbol,
      name: entry.name,
      sector: entry.sector,
      price: round(price, 2),
      prevClose: entry.prevClose,
      open: round(open, 2),
      changeFromClosePct: round(changeFromClosePct, 2),
      gapPct: round(entry.gap, 2),
      volume,
      avgVolume: entry.avgVolume,
      relativeVolume: round(relativeVolume, 2),
      relVol5min: round(relVol5min, 2),
      float: entry.float,
      shortInterest: entry.shortInterest,
      news: buildNews(entry, now),
      candles: buildCandles(entry, now, session),
    };
  });

  return { quotes, session, provider: 'mock' };
}

/* ------------------------------------------------------------------ */
/* multi-day history for the trend strategy                            */
/* ------------------------------------------------------------------ */

/**
 * The trend regime each symbol is simulated in.
 *
 * The five-criteria scanner only ever needs today, so the intraday generator
 * above starts at the opening bell. A multi-timeframe read needs weeks, and it
 * needs them to contain something worth reading — a universe of random walks
 * would produce `not_aligned` for every symbol and prove nothing.
 *
 * So each symbol is assigned a regime from its name hash, and the assignment
 * is deliberately spread: roughly half trend up, a fifth trend down, and the
 * rest chop. The choppy ones matter as much as the trending ones — a strategy
 * that never says "stand aside" in simulation is not being tested.
 */
export function regimeFor(symbol) {
  const seed = hash(symbol);
  if (seed < 0.48) return 'up';
  if (seed < 0.68) return 'down';
  return 'chop';
}

const SESSION_MINUTES_RTH = 390; // 09:30-16:00
const SESSION_OPEN_MINUTES = 9 * 60 + 30;

/** Intraday resolutions the simulator can generate natively. */
const BAR_MINUTES = { '1m': 1, '5m': 5, '15m': 15 };

/** Minutes past ET midnight, and the ET weekday, for a timestamp. */
function easternClock(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '00';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return { minutes: Number(hour) * 60 + Number(get('minute')), weekday: get('weekday') };
}

/**
 * Timestamps of the 09:30 ET bell for the last `count` weekdays, oldest first.
 *
 * Each day's midnight is recomputed from that day's own clock rather than by
 * subtracting 24h repeatedly — an hour of drift creeps in across a DST change
 * otherwise, and every bar after it lands in the wrong bucket.
 */
export function sessionOpens(now, count) {
  const opens = [];
  let cursor = now;
  // Guard the walk so a pathological count cannot spin: 5 calendar days per
  // trading day is far more slack than weekends need.
  for (let step = 0; opens.length < count && step < count * 5 + 10; step += 1) {
    const clock = easternClock(cursor);
    const midnight = cursor - clock.minutes * 60_000 - (((cursor % 60_000) + 60_000) % 60_000);
    if (clock.weekday !== 'Sat' && clock.weekday !== 'Sun') {
      opens.push(midnight + SESSION_OPEN_MINUTES * 60_000);
    }
    cursor = midnight - 60_000; // 23:59 the previous day
  }
  return opens.reverse();
}

/**
 * A trend as the strategy defines one: drives that each give part of
 * themselves back, and whose net progress accumulates.
 *
 * The obvious construction — a straight ramp plus an oscillation — does not
 * work here, and the reason is the whole point of the strategy. An
 * oscillation returns to where it started, so whether each swing low comes in
 * above the last depends entirely on whether the ramp out-runs the
 * oscillation's amplitude; get that balance slightly wrong and the simulated
 * "uptrend" has no higher lows in it at all, which is exactly the structure
 * the strategy refuses to trade.
 *
 * So progress is accumulated per cycle instead. Each cycle rises by
 * `amplitude` and gives back `giveBack` of it, carrying the remainder forward.
 * Higher highs and higher lows are then guaranteed by construction for any
 * giveBack below 1 — and `giveBack: 1` gives a market that swings without
 * trending, which is what the choppy symbols need.
 */
function cumulativeSaw(position, { cycle, amplitude, impulseShare = 0.6, giveBack = 0.5 }) {
  const cycles = Math.floor(position / cycle);
  const phase = (((position % cycle) + cycle) % cycle) / cycle;
  const within =
    phase < impulseShare
      ? phase / impulseShare // driving: 0 -> 1
      : 1 - ((phase - impulseShare) / (1 - impulseShare)) * giveBack; // pausing: 1 -> 1-giveBack
  return (cycles * (1 - giveBack) + within) * amplitude;
}

/**
 * The amplitude that makes `bars` worth of cycles cover `totalPct` of drift.
 * Solving for it here is what keeps a symbol's simulated move roughly the size
 * its universe entry advertises, whatever cycle length it was given.
 */
function amplitudeFor(totalPct, bars, cycle, giveBack) {
  const cycles = Math.max(bars / cycle, 1);
  return totalPct / 100 / (cycles * (1 - giveBack));
}

/**
 * Simulated 5-minute bars and daily bars for one symbol.
 *
 * The two series are consistent by construction: the recent daily bars are
 * aggregated from the same 5-minute path the strategy reads, and the older
 * daily bars are generated backwards from where that path begins. A daily
 * chart that disagreed with the intraday chart it was built from would make
 * every alignment verdict meaningless.
 */
export function getHistory({
  symbol,
  now = Date.now(),
  sessions = 12,
  dailyBars = 120,
  interval = '5m',
} = {}) {
  const entry = UNIVERSE.find((u) => u.symbol === String(symbol).toUpperCase());
  if (!entry) {
    return { symbol, intraday: [], daily: [], provider: 'mock', regime: null, interval };
  }

  // The simulator generates whichever resolution is asked for rather than
  // handing back 5-minute bars with a 1-minute label. Everything coarser is
  // then resampled from it, which is the only direction that direction works.
  const barMinutes = BAR_MINUTES[interval];
  if (!barMinutes) {
    return {
      symbol: entry.symbol,
      intraday: [],
      daily: [],
      provider: 'mock',
      regime: null,
      interval,
      errors: [{ series: 'intraday', message: `The simulator does not generate ${interval} bars` }],
    };
  }
  const sessionBars = Math.round(SESSION_MINUTES_RTH / barMinutes);

  const seed = hash(entry.symbol);
  const regime = regimeFor(entry.symbol);
  const sign = regime === 'down' ? -1 : 1;

  const opens = sessionOpens(now, sessions);
  const session = sessionProgress(new Date(now));
  const lastSessionBars = Math.max(Math.round(session.fraction * sessionBars), Math.round(120 / barMinutes));
  const totalBars = (opens.length - 1) * sessionBars + lastSessionBars;

  // Two scales, because the strategy reads at least two. The swing layer is
  // what the hourly chart sees — legs of roughly ten hourly bars, so
  // `swingSpan` pivots can actually form on them. The leg layer is the pause
  // inside each of those, and it is deliberately small enough never to
  // threaten a swing low: on this data a fast-timeframe correction is supposed
  // to be a pause, and the strategy is supposed to say so.
  //
  // Both are defined in *minutes* and converted, so the generated market has
  // the same shape whatever resolution it is sampled at. Defining them in bars
  // would make a 1-minute chart's swings five times shorter in wall-clock
  // terms than the same symbol's 5-minute chart, which is not a finer view of
  // one market but a different one.
  const swingCycleMinutes = (110 + Math.round(seed * 50)) * 5; // ~9-13 hours
  const legCycleMinutes = (14 + Math.round(seed * 8)) * 5; // ~1-2 hours
  const swingCycle = swingCycleMinutes / barMinutes;
  const legCycle = legCycleMinutes / barMinutes;
  const totalDriftPct = regime === 'chop' ? 0 : sign * (16 + seed * 14);

  const swingGiveBack = regime === 'chop' ? 1 : 0.5;
  const swingAmplitude =
    regime === 'chop'
      ? 0.05 // swings of a fixed size that go nowhere
      : amplitudeFor(Math.abs(totalDriftPct), totalBars, swingCycle, swingGiveBack);

  // A phase offset keyed to the wall clock, so repeated calls walk through the
  // strategy's states rather than freezing on one. Without it a symbol scanned
  // on a closed market would show the same pullback at the same depth forever.
  const legPhase = ((now / 600_000) * (5 / barMinutes)) % legCycle;

  const startPrice = entry.prevClose * (1 - totalDriftPct / 200);

  const pathAt = (i) => {
    const swing =
      sign *
      cumulativeSaw(i + seed * swingCycle, {
        cycle: swingCycle,
        amplitude: swingAmplitude,
        giveBack: swingGiveBack,
      });
    // The 5-minute layer oscillates rather than accumulating: it is the pause
    // inside the drive, not a second trend.
    const leg =
      sign *
      (cumulativeSaw(i + legPhase, { cycle: legCycle, amplitude: swingAmplitude * 0.22, giveBack: 1 }) -
        swingAmplitude * 0.11);
    // Two noise scales. The slow one wanders the path off its ideal shape; the
    // fast one keeps consecutive bars from marching monotonically, which is
    // what a purely analytic path does and what real bars never do. Without
    // the fast term the last bar is almost always the extreme of its leg, and
    // the strategy reports "no pause yet" for nearly every symbol — an
    // artefact of the generator, not a market condition.
    return (
      swing +
      leg +
      noise(seed, i * barMinutes * 60, 4000 * barMinutes) * 0.002 +
      noise(seed * 1.7 + 0.31, i * barMinutes * 60, 700 * barMinutes) * 0.0016
    );
  };

  const intraday = [];
  let barIndex = 0;
  for (let s = 0; s < opens.length; s += 1) {
    const isLast = s === opens.length - 1;
    const bars = isLast ? lastSessionBars : sessionBars;
    for (let b = 0; b < bars; b += 1) {
      const open = startPrice * (1 + pathAt(barIndex));
      const close = startPrice * (1 + pathAt(barIndex + 1));
      const body = Math.abs(close - open);
      const wick = Math.max(body * 0.5, open * 0.0008);
      const jitter = Math.abs(noise(seed + barIndex * 0.013, barIndex * barMinutes * 60, 1700 * barMinutes));

      intraday.push({
        time: new Date(opens[s] + b * barMinutes * 60_000).toISOString(),
        open: round(Math.max(open, 0.01), 4),
        high: round(Math.max(open, close) + wick * jitter, 4),
        low: round(Math.max(Math.min(open, close) - wick * jitter, 0.005), 4),
        close: round(Math.max(close, 0.01), 4),
        // Volume expands into the drive and dries up in the pullback, which is
        // the signature that separates a pause from distribution.
        volume: Math.max(
          Math.round(
            ((entry.avgVolume / sessionBars) *
              (sign * (close - open) > 0 ? 1.5 : 0.6) *
              (0.7 + jitter * 0.6)),
          ),
          1,
        ),
      });
      barIndex += 1;
    }
  }

  // Older daily bars, generated backwards from where the intraday path starts,
  // continuing the same regime at daily scale.
  const olderCount = Math.max(dailyBars - opens.length, 0);
  const olderOpens = sessionOpens(opens[0] - 24 * 3600_000, olderCount);
  const dailyDriftPct = regime === 'chop' ? 0 : sign * (45 + seed * 35);
  const dailySwingCycle = 8 + Math.round(seed * 6);
  const dailyGiveBack = regime === 'chop' ? 1 : 0.45;
  const dailyAmplitude =
    regime === 'chop'
      ? 0.07
      : amplitudeFor(Math.abs(dailyDriftPct), olderCount, dailySwingCycle, dailyGiveBack);

  const older = olderOpens.map((openMs, i) => {
    // Runs from -olderCount to 0 so the series ends where the intraday path
    // begins: one continuous history, not two that happen to sit next to each
    // other with a gap between them.
    const dayPath = (k) =>
      sign *
      cumulativeSaw(k - olderCount + seed * dailySwingCycle, {
        cycle: dailySwingCycle,
        amplitude: dailyAmplitude,
        giveBack: dailyGiveBack,
      });

    const open = startPrice * (1 + dayPath(i));
    const close = startPrice * (1 + dayPath(i + 1));
    const body = Math.abs(close - open);
    const wick = Math.max(body * 0.6, open * 0.004);
    const jitter = Math.abs(noise(seed + i * 0.031, i * 86_400, 900_000));

    return {
      time: new Date(openMs).toISOString(),
      open: round(Math.max(open, 0.01), 4),
      high: round(Math.max(open, close) + wick * jitter, 4),
      low: round(Math.max(Math.min(open, close) - wick * jitter, 0.005), 4),
      close: round(Math.max(close, 0.01), 4),
      volume: Math.round(entry.avgVolume * (0.8 + jitter * 0.5)),
    };
  });

  // The recent days come from the intraday path itself rather than being
  // generated again — two generators would drift apart, and the daily trend
  // would then contradict the 5-minute bars it is supposed to govern.
  const recent = [];
  for (let s = 0; s < opens.length; s += 1) {
    const from = s * sessionBars;
    const slice = intraday.slice(from, from + (s === opens.length - 1 ? lastSessionBars : sessionBars));
    if (!slice.length) continue;
    recent.push({
      time: new Date(opens[s]).toISOString(),
      open: slice[0].open,
      high: Math.max(...slice.map((c) => c.high)),
      low: Math.min(...slice.map((c) => c.low)),
      close: slice.at(-1).close,
      volume: slice.reduce((sum, c) => sum + c.volume, 0),
    });
  }

  return {
    symbol: entry.symbol,
    name: entry.name,
    intraday,
    daily: [...older, ...recent],
    provider: 'mock',
    regime,
    interval,
  };
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export const universeSize = UNIVERSE.length;
export const symbols = UNIVERSE.map((entry) => entry.symbol);
