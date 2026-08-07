/**
 * The 5 Criteria of Stock Selection.
 *
 * Four measure DEMAND (is the crowd chasing this right now?) and one measures
 * SUPPLY (how little stock is available to absorb that demand?). A stock that
 * satisfies all five is a high-demand / low-supply imbalance, which is the
 * setup this scanner exists to find.
 */

export const DEFAULT_CONFIG = {
  minChangeFromClosePct: 10, // 1) Demand: already up 10% on the day
  minRelativeVolume: 5, // 2) Demand: 5x above average volume today
  requireNews: true, // 3) Demand: a news event moving the stock
  newsLookbackHours: 24, // how fresh a headline has to be to count
  minPrice: 2, // 4) Demand: most day traders prefer $2 - $20
  maxPrice: 20,
  maxFloat: 20_000_000, // 5) Supply: less than 20 million shares to trade
  minGapPct: 2, // bonus: opening gap up from the prior day's close
};

/** Pillar ids in the order they are presented in the UI. */
export const PILLAR_IDS = ['change', 'relativeVolume', 'news', 'price', 'float'];

const LABELS = {
  change: 'Demand: Up on the day',
  relativeVolume: 'Demand: Relative volume',
  news: 'Demand: News catalyst',
  price: 'Demand: Price range',
  float: 'Supply: Low float',
};

function normalizeConfig(config = {}) {
  const merged = { ...DEFAULT_CONFIG, ...config };
  // Guard against a UI sending strings or nonsense; fall back per-field.
  for (const [key, fallback] of Object.entries(DEFAULT_CONFIG)) {
    if (typeof fallback === 'boolean') {
      merged[key] = Boolean(merged[key]);
      continue;
    }
    const value = Number(merged[key]);
    merged[key] = Number.isFinite(value) ? value : fallback;
  }
  if (merged.maxPrice < merged.minPrice) {
    [merged.minPrice, merged.maxPrice] = [merged.maxPrice, merged.minPrice];
  }
  return merged;
}

/**
 * Headlines count as a catalyst only while they are still fresh — a week-old
 * press release is not what is moving the stock this morning.
 */
export function freshNews(news = [], lookbackHours, now = Date.now()) {
  if (!Array.isArray(news)) return [];
  const cutoff = now - lookbackHours * 3600 * 1000;
  return news
    .filter((item) => item && Number.isFinite(new Date(item.datetime).getTime()))
    .filter((item) => new Date(item.datetime).getTime() >= cutoff)
    .sort((a, b) => new Date(b.datetime) - new Date(a.datetime));
}

/**
 * Coerce a feed value to a number, treating null/undefined/'' as missing.
 * `Number(null)` is 0, which would quietly turn "the provider had no data" into
 * "the stock scored zero" — a difference that matters for every pillar here.
 */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return NaN;
  return Number(value);
}

function pillar(id, passed, actual, target, detail, flags = {}) {
  return { id, label: LABELS[id], passed, actual, target, detail, ...flags };
}

/**
 * Score one quote against the five pillars.
 *
 * Returns the quote enriched with a `pillars` array, a `score` (0-5), a
 * `qualified` flag (all five passed) and a `rank` used for sorting. Nothing is
 * filtered out here — callers decide what to show.
 */
export function evaluate(quote, config = {}, now = Date.now()) {
  const cfg = normalizeConfig(config);
  const catalysts = freshNews(quote.news, cfg.newsLookbackHours, now);

  const change = toNumber(quote.changeFromClosePct);
  const relVol = toNumber(quote.relativeVolume);
  const price = toNumber(quote.price);
  const float = toNumber(quote.float);
  const gap = toNumber(quote.gapPct);

  // A feed that cannot supply a field is not the same as a stock that fails on
  // it. Unavailable pillars never pass — we do not guess a stock into a trade —
  // but they are labelled so the UI can say "unknown" instead of "rejected".
  const newsUnavailable = cfg.requireNews && quote.newsAvailable === false;

  const pillars = [
    pillar(
      'change',
      Number.isFinite(change) && change >= cfg.minChangeFromClosePct,
      change,
      cfg.minChangeFromClosePct,
      Number.isFinite(change)
        ? `Up ${fmtPct(change)} from the prior close (need ${cfg.minChangeFromClosePct}%)`
        : 'Price change unavailable from this feed',
      { unavailable: !Number.isFinite(change) },
    ),
    pillar(
      'relativeVolume',
      Number.isFinite(relVol) && relVol >= cfg.minRelativeVolume,
      relVol,
      cfg.minRelativeVolume,
      Number.isFinite(relVol)
        ? `${fmtNum(relVol)}x its normal volume for this time of day (need ${cfg.minRelativeVolume}x)`
        : 'Relative volume unavailable from this feed',
      { unavailable: !Number.isFinite(relVol) },
    ),
    pillar(
      'news',
      cfg.requireNews ? catalysts.length > 0 : true,
      catalysts.length,
      cfg.requireNews ? 1 : 0,
      newsUnavailable
        ? 'No news feed configured — set FINNHUB_API_KEY to judge this pillar'
        : catalysts.length
          ? `${catalysts.length} headline${catalysts.length === 1 ? '' : 's'} in the last ${cfg.newsLookbackHours}h`
          : `No headline in the last ${cfg.newsLookbackHours}h`,
      { unavailable: newsUnavailable },
    ),
    pillar(
      'price',
      Number.isFinite(price) && price >= cfg.minPrice && price <= cfg.maxPrice,
      price,
      [cfg.minPrice, cfg.maxPrice],
      Number.isFinite(price)
        ? `Trading at $${fmtNum(price)} (want $${cfg.minPrice} - $${cfg.maxPrice})`
        : 'Price unavailable from this feed',
      { unavailable: !Number.isFinite(price) },
    ),
    pillar(
      'float',
      Number.isFinite(float) && float > 0 && float < cfg.maxFloat,
      float,
      cfg.maxFloat,
      !Number.isFinite(float) || float <= 0
        ? 'Float unavailable from this feed'
        : `${fmtShares(float)} shares available to trade (want under ${fmtShares(cfg.maxFloat)})` +
          (quote.floatIsEstimated ? ' — estimated from shares outstanding' : ''),
      {
        unavailable: !Number.isFinite(float) || float <= 0,
        estimated: Boolean(quote.floatIsEstimated) && Number.isFinite(float) && float > 0,
      },
    ),
  ];

  const score = pillars.filter((p) => p.passed).length;
  const qualified = score === pillars.length;
  const gappingUp = Number.isFinite(gap) && gap >= cfg.minGapPct;

  // A pillar the feed cannot supply is unknown, not failed. Without a news or
  // float source nothing could ever qualify, which would make the whole
  // strategy layer unreachable on an otherwise good price feed. So track a
  // weaker standard too: passes everything that *could* be judged. It is
  // always reported alongside what went unchecked — never silently upgraded.
  const unverified = pillars.filter((p) => p.unavailable).map((p) => p.id);
  const judgeable = pillars.filter((p) => !p.unavailable);
  const provisionallyQualified =
    !qualified && judgeable.length > 0 && judgeable.every((p) => p.passed);

  return {
    ...quote,
    catalysts,
    pillars,
    score,
    qualified,
    provisionallyQualified,
    selectionComplete: unverified.length === 0,
    unverifiedPillars: unverified,
    gappingUp,
    grade: grade(score, gappingUp),
    // Fully qualified names first, then provisional ones, then by how hard the
    // demand side is firing.
    rank:
      (qualified ? 1e9 : 0) +
      (provisionallyQualified ? 5e8 : 0) +
      score * 1e6 +
      (gappingUp ? 5e5 : 0) +
      demandHeat(change, relVol),
  };
}

/**
 * A stock clearing all five with a gap up is the highest-conviction version of
 * the setup; below five pillars the grade degrades with the pillar count.
 */
function grade(score, gappingUp) {
  if (score === 5) return gappingUp ? 'A+' : 'A';
  if (score === 4) return 'B';
  if (score === 3) return 'C';
  return 'D';
}

/** Combines the two continuous demand pillars into one sortable heat number. */
function demandHeat(change, relVol) {
  const c = Number.isFinite(change) ? Math.max(change, 0) : 0;
  const r = Number.isFinite(relVol) ? Math.max(relVol, 0) : 0;
  return Math.min(c, 1000) * 100 + Math.min(r, 20_000);
}

/** Evaluate a whole universe and sort it best-setup-first. */
export function scan(quotes = [], config = {}, now = Date.now()) {
  return quotes.map((q) => evaluate(q, config, now)).sort((a, b) => b.rank - a.rank);
}

export function summarize(results = []) {
  const counts = Object.fromEntries(PILLAR_IDS.map((id) => [id, 0]));
  for (const result of results) {
    for (const p of result.pillars) {
      if (p.passed) counts[p.id] += 1;
    }
  }
  return {
    scanned: results.length,
    qualified: results.filter((r) => r.qualified).length,
    gappingUp: results.filter((r) => r.gappingUp).length,
    pillarCounts: counts,
  };
}

function fmtPct(value) {
  return Number.isFinite(value) ? `${value.toFixed(2)}%` : 'n/a';
}

function fmtNum(value) {
  return Number.isFinite(value) ? value.toFixed(2) : 'n/a';
}

export function fmtShares(value) {
  if (!Number.isFinite(value)) return 'n/a';
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return String(Math.round(value));
}

export { normalizeConfig };
