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
    };
  });

  return { quotes, session, provider: 'mock' };
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export const universeSize = UNIVERSE.length;
