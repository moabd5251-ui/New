/**
 * Live market data.
 *
 * Price, volume and the 50-day average volume come from Yahoo's public chart
 * endpoint, which needs no key. Float and news headlines come from Finnhub when
 * FINNHUB_API_KEY is set.
 *
 * Two honesty notes that the UI surfaces rather than hides:
 *  - Without a Finnhub key there are no headlines, so the news pillar cannot be
 *    judged. The scanner marks it `unavailable` instead of silently passing it.
 *  - Finnhub reports shares outstanding, not true float. When that is all we
 *    have, the float pillar is flagged `estimated` — outstanding is always >=
 *    float, so the pillar errs toward rejecting, never toward a false positive.
 */

import { relativeVolume as relativeVolumeFor, expectedVolumeFraction } from '../session-volume.js';

const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';
const FINNHUB = 'https://finnhub.io/api/v1';
const USER_AGENT = 'momentum-scanner/1.0 (+https://github.com)';

async function fetchJson(url, { timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Run tasks with a small concurrency cap so we do not hammer the endpoints. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { error, symbol: items[index] };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

function averageOf(values) {
  const usable = values.filter((v) => Number.isFinite(v) && v > 0);
  if (!usable.length) return null;
  return usable.reduce((sum, v) => sum + v, 0) / usable.length;
}

/**
 * Fraction of the regular session elapsed. Relative volume compares today's
 * volume against the average pace *to this point in the day*; without this the
 * number would look tiny at 09:35 and huge at 15:55.
 */
export function sessionProgress(now = new Date()) {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const minutes = et.getHours() * 60 + et.getMinutes();
  const open = 9 * 60 + 30;
  const close = 16 * 60;
  const isWeekend = et.getDay() === 0 || et.getDay() === 6;
  if (isWeekend) return { fraction: 1, live: false, now, label: 'Market closed (weekend)' };
  if (minutes < open) return { fraction: 1, live: false, now, label: 'Pre-market' };
  if (minutes > close) return { fraction: 1, live: false, now, label: 'After hours' };
  return {
    // Share of a typical day's VOLUME expected by now, not clock elapsed.
    fraction: expectedVolumeFraction(minutes - open),
    elapsedMinutes: minutes - open,
    live: true,
    now,
    label: `${minutes - open} min into the session`,
  };
}

async function fetchChart(symbol) {
  const url = `${YAHOO_CHART}/${encodeURIComponent(symbol)}?range=3mo&interval=1d`;
  const payload = await fetchJson(url);
  const result = payload?.chart?.result?.[0];
  if (!result) throw new Error(`No chart data for ${symbol}`);

  const meta = result.meta ?? {};
  const bars = result.indicators?.quote?.[0] ?? {};
  const closes = bars.close ?? [];
  const opens = bars.open ?? [];
  const volumes = bars.volume ?? [];

  // The final daily bar is the session `regularMarketPrice` belongs to — the
  // one in progress during market hours, the last completed one otherwise. So
  // the prior close is always the bar before it. `meta.chartPreviousClose` is
  // NOT that: it is the close preceding the whole 3-month range.
  const prevClose = closes.at(-2) ?? meta.previousClose ?? null;
  const open = opens.at(-1) ?? null;

  // Exclude the current bar from the average so a quiet morning cannot drag the
  // baseline down and inflate relative volume.
  const history = volumes.slice(0, -1).filter((v) => Number.isFinite(v) && v > 0);
  const avgVolume = averageOf(history.slice(-50));

  const price = meta.regularMarketPrice;

  return {
    symbol: meta.symbol ?? symbol,
    name: meta.longName ?? meta.shortName ?? symbol,
    sector: null,
    price: Number.isFinite(price) ? price : null,
    prevClose: Number.isFinite(prevClose) ? prevClose : null,
    open: Number.isFinite(open) ? open : null,
    volume: Number.isFinite(meta.regularMarketVolume) ? meta.regularMarketVolume : null,
    avgVolume,
    currency: meta.currency ?? 'USD',
  };
}

/**
 * 1-minute intraday bars for pattern detection. Best-effort: a symbol with no
 * intraday history simply gets no setup, which is the honest outcome.
 */
async function fetchIntraday(symbol) {
  const url = `${YAHOO_CHART}/${encodeURIComponent(symbol)}?range=1d&interval=1m`;
  const payload = await fetchJson(url);
  const result = payload?.chart?.result?.[0];
  const stamps = result?.timestamp ?? [];
  const bars = result?.indicators?.quote?.[0] ?? {};
  if (!stamps.length) return [];

  const candles = [];
  for (let i = 0; i < stamps.length; i += 1) {
    const open = bars.open?.[i];
    const high = bars.high?.[i];
    const low = bars.low?.[i];
    const close = bars.close?.[i];
    // Yahoo pads the series with nulls for minutes that had no trades.
    if (![open, high, low, close].every(Number.isFinite)) continue;
    candles.push({
      time: new Date(stamps[i] * 1000).toISOString(),
      open,
      high,
      low,
      close,
      volume: Number.isFinite(bars.volume?.[i]) ? bars.volume[i] : null,
    });
  }
  return candles.slice(-120);
}

async function fetchFinnhubProfile(symbol, apiKey) {
  const url = `${FINNHUB}/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`;
  const profile = await fetchJson(url);
  // shareOutstanding is reported in millions.
  const outstanding = Number(profile?.shareOutstanding);
  return {
    name: profile?.name || null,
    sector: profile?.finnhubIndustry || null,
    float: Number.isFinite(outstanding) && outstanding > 0 ? outstanding * 1e6 : null,
    floatIsEstimated: true,
  };
}

async function fetchFinnhubNews(symbol, apiKey, lookbackHours) {
  const to = new Date();
  const from = new Date(to.getTime() - Math.max(lookbackHours, 24) * 3600 * 1000);
  const iso = (d) => d.toISOString().slice(0, 10);
  const url =
    `${FINNHUB}/company-news?symbol=${encodeURIComponent(symbol)}` +
    `&from=${iso(from)}&to=${iso(to)}&token=${apiKey}`;
  const items = await fetchJson(url);
  if (!Array.isArray(items)) return [];
  return items.slice(0, 12).map((item) => ({
    headline: item.headline,
    source: item.source,
    datetime: new Date((item.datetime ?? 0) * 1000).toISOString(),
    url: item.url ?? null,
  }));
}

/**
 * Fetch and normalize a watchlist into the same quote shape the mock provider
 * produces. Symbols that fail are reported in `errors` rather than dropped
 * silently, so a broken feed never looks like an empty market.
 */
/**
 * Turn raw chart fields into the scanner's metrics. Pure, so the arithmetic is
 * testable without hitting the network.
 */
export function deriveMetrics(base, session) {
  const { price, prevClose, open, volume, avgVolume } = base;

  const changeFromClosePct =
    Number.isFinite(price) && Number.isFinite(prevClose) && prevClose > 0
      ? ((price - prevClose) / prevClose) * 100
      : null;

  const gapPct =
    Number.isFinite(open) && Number.isFinite(prevClose) && prevClose > 0
      ? ((open - prevClose) / prevClose) * 100
      : null;

  // Baseline follows the U-shaped intraday volume curve rather than a flat
  // pro-rate; outside regular hours the reported volume is a *completed*
  // session, so it belongs against a whole average day. See session-volume.js.
  const relVol = relativeVolumeFor(volume, avgVolume, {
    live: session.live,
    now: session.now ?? new Date(),
  });

  return {
    changeFromClosePct: round(changeFromClosePct, 2),
    gapPct: round(gapPct, 2),
    relativeVolume: round(relVol, 4),
  };
}

export async function getQuotes({
  symbols = [],
  apiKey = process.env.FINNHUB_API_KEY || '',
  newsLookbackHours = 24,
  now = Date.now(),
} = {}) {
  const session = sessionProgress(new Date(now));
  const errors = [];

  const settled = await mapLimit(symbols, 5, async (symbol) => {
    const base = await fetchChart(symbol);

    // Intraday is supplementary — a failure here costs the setup, not the quote.
    const intraday = await fetchIntraday(symbol).catch(() => []);

    let profile = { float: null, floatIsEstimated: false, name: null, sector: null };
    let news = [];
    if (apiKey) {
      const [profileResult, newsResult] = await Promise.allSettled([
        fetchFinnhubProfile(symbol, apiKey),
        fetchFinnhubNews(symbol, apiKey, newsLookbackHours),
      ]);
      if (profileResult.status === 'fulfilled') profile = profileResult.value;
      if (newsResult.status === 'fulfilled') news = newsResult.value;
    }

    return {
      ...base,
      name: profile.name ?? base.name,
      sector: profile.sector ?? base.sector,
      ...deriveMetrics(base, session),
      relVol5min: null, // no free intraday feed; the UI shows this as unavailable
      float: profile.float,
      floatIsEstimated: profile.floatIsEstimated,
      shortInterest: null,
      news,
      newsAvailable: Boolean(apiKey),
      candles: intraday,
    };
  });

  const quotes = [];
  for (const item of settled) {
    if (item && item.error) {
      errors.push({ symbol: item.symbol, message: item.error.message });
    } else if (item) {
      quotes.push(item);
    }
  }

  return { quotes, session, provider: 'live', errors, newsAvailable: Boolean(apiKey) };
}

function round(value, digits) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
