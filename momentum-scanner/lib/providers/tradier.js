/**
 * Tradier market data.
 *
 * Better source than the Yahoo fallback in four ways that matter here:
 *  - quotes are batched, so a 50-symbol watchlist is one request, not fifty
 *  - `average_volume` is served directly instead of being averaged off 50 bars
 *  - `timesales` returns true 1-minute OHLCV bars, which is what the pattern
 *    detectors actually read
 *  - `/markets/clock` is authoritative about the session, including half-days
 *    and holidays that timezone arithmetic gets wrong
 *
 * What Tradier does not carry: float and news. Those still come from Finnhub
 * when FINNHUB_API_KEY is set, with the same flags as the other providers —
 * float from shares outstanding is marked `estimated`, and a missing news feed
 * marks the pillar `unavailable` rather than passing it.
 *
 * Auth is a bearer token. Sandbox tokens are free but the data is delayed;
 * real-time requires a funded brokerage account.
 */

const PRODUCTION = 'https://api.tradier.com/v1';
const SANDBOX = 'https://sandbox.tradier.com/v1';
const FINNHUB = 'https://finnhub.io/api/v1';

// Tradier accepts a comma-separated symbol list; chunk so one bad batch cannot
// take down the whole scan and the URL stays a sane length.
const QUOTE_CHUNK = 50;

export function baseUrl({ sandbox = false } = {}) {
  return sandbox ? SANDBOX : PRODUCTION;
}

async function fetchJson(url, token, { timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Finnhub calls reuse this helper and pass no token; sending
        // `Bearer null` would be a malformed header on every one of them.
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        Accept: 'application/json',
      },
    });
    if (response.status === 401) {
      throw new Error('Tradier rejected the token (401) — check TRADIER_TOKEN');
    }
    if (response.status === 429) {
      throw new Error('Tradier rate limit hit (429) — slow the refresh interval');
    }
    if (!response.ok) {
      throw new Error(`Tradier returned HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tradier collapses single-element collections into a bare object rather than a
 * one-element array. Every list in the API needs this, and forgetting it turns
 * a one-symbol watchlist into zero results.
 */
export function toArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/* ------------------------------------------------------------------ */
/* pure parsing — unit tested without touching the network             */
/* ------------------------------------------------------------------ */

/** Pull the quote list out of a `/markets/quotes` payload. */
export function parseQuotes(payload) {
  const quotes = toArray(payload?.quotes?.quote);
  const unmatched = toArray(payload?.quotes?.unmatched_symbols?.symbol);
  return { quotes, unmatched };
}

/** Pull 1-minute bars out of a `/markets/timesales` payload. */
export function parseTimesales(payload) {
  return toArray(payload?.series?.data)
    .map((bar) => ({
      time: bar.time ?? null,
      open: num(bar.open),
      high: num(bar.high),
      low: num(bar.low),
      close: num(bar.close),
      volume: num(bar.volume),
      vwap: num(bar.vwap),
    }))
    // A bar missing any OHLC value cannot be reasoned about; drop it rather
    // than let a null propagate into pattern detection.
    .filter((bar) => [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite));
}

/**
 * Session state from `/markets/clock`. Tradier's `state` is the authority on
 * whether the market is open; the fraction is still needed to pro-rate volume.
 */
export function parseClock(payload, now = new Date()) {
  const state = payload?.clock?.state ?? null; // premarket | open | postmarket | closed
  const description = payload?.clock?.description ?? null;

  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const minutes = et.getHours() * 60 + et.getMinutes();
  const open = 9 * 60 + 30;
  const close = 16 * 60;

  const live = state === 'open';
  const fraction = live
    ? Math.min(Math.max((minutes - open) / (close - open), 0.02), 1)
    : 1; // outside the session, reported volume is a completed day

  return {
    fraction,
    live,
    state,
    label: description ?? (live ? `Session ${(fraction * 100).toFixed(0)}% elapsed` : 'Market closed'),
  };
}

/**
 * Normalize one Tradier quote into the scanner's shape.
 *
 * `change_percentage` is used when present rather than recomputed — Tradier
 * accounts for splits and dividends there, which a naive (last-prevclose)/prevclose
 * does not.
 */
export function normalizeQuote(quote, session) {
  const last = num(quote.last) ?? num(quote.close);
  const prevClose = num(quote.prevclose);
  const volume = num(quote.volume);
  const avgVolume = num(quote.average_volume);
  const open = num(quote.open);

  const changeFromClosePct =
    num(quote.change_percentage) ??
    (Number.isFinite(last) && Number.isFinite(prevClose) && prevClose > 0
      ? ((last - prevClose) / prevClose) * 100
      : null);

  const gapPct =
    Number.isFinite(open) && Number.isFinite(prevClose) && prevClose > 0
      ? ((open - prevClose) / prevClose) * 100
      : null;

  // Only pro-rate the baseline while the session is actually running; outside
  // it, today's volume is a completed day and belongs against the full average.
  const expectedByNow = Number.isFinite(avgVolume) ? avgVolume * session.fraction : null;
  const relativeVolume =
    expectedByNow && expectedByNow > 0 && Number.isFinite(volume) ? volume / expectedByNow : null;

  // Outside regular hours `volume` is extended-hours activity measured against a
  // whole average day, so it reads near zero even for a stock going wild
  // premarket. Tradier does not publish a premarket baseline, so rather than
  // invent one, flag the reading and also give the figure traders actually use
  // premarket: how much of an average day has already traded.
  const extendedHours = !session.live && session.state !== null;
  const volumePctOfAvgDay =
    Number.isFinite(volume) && Number.isFinite(avgVolume) && avgVolume > 0
      ? round((volume / avgVolume) * 100)
      : null;

  return {
    symbol: quote.symbol,
    name: quote.description ?? quote.symbol,
    sector: null,
    price: last,
    prevClose,
    open,
    volume,
    avgVolume,
    changeFromClosePct: round(changeFromClosePct),
    gapPct: round(gapPct),
    // Keep more precision than the display needs: premarket ratios live in the
    // third decimal, and rounding to 2 turns a real reading into a flat zero.
    relativeVolume: round(relativeVolume, 4),
    extendedHours,
    volumePctOfAvgDay,
    marketState: session.state,
    bid: num(quote.bid),
    ask: num(quote.ask),
    exchange: quote.exch ?? null,
  };
}

/**
 * Relative volume over the last N minutes, from the intraday bars. Tradier's
 * per-minute data makes this measurable; the Yahoo path could only ever report
 * the daily rate.
 */
export function relativeVolume5Min(candles, avgVolume, minutes = 5) {
  if (!Array.isArray(candles) || !candles.length) return null;
  if (!Number.isFinite(avgVolume) || avgVolume <= 0) return null;

  const recent = candles.slice(-minutes);
  const traded = recent.reduce((sum, c) => sum + (Number.isFinite(c.volume) ? c.volume : 0), 0);
  if (!traded) return null;

  // Baseline: what this stock normally trades in the same number of minutes,
  // spread across a 390-minute session.
  const normalPerMinute = avgVolume / 390;
  const expected = normalPerMinute * recent.length;
  if (expected <= 0) return null;

  return round((traded / expected) * 100); // percent, as the scanner column expects
}

/* ------------------------------------------------------------------ */
/* time formatting for the timesales window                            */
/* ------------------------------------------------------------------ */

/** Date/time parts in New York, which is the only timezone Tradier accepts. */
export function easternParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value ?? '00';
  // Intl renders midnight as "24" in some ICU versions; normalize it.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return { year: get('year'), month: get('month'), day: get('day'), hour, minute: get('minute') };
}

/** `YYYY-MM-DD HH:MM` in ET, the format the timesales endpoint expects. */
export function tradierTimestamp(date, { hour, minute } = {}) {
  const p = easternParts(date);
  return `${p.year}-${p.month}-${p.day} ${hour ?? p.hour}:${minute ?? p.minute}`;
}

/* ------------------------------------------------------------------ */
/* network calls                                                       */
/* ------------------------------------------------------------------ */

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
        results[index] = { __error: error, item: items[index] };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function fetchClock(base, token, now) {
  try {
    return parseClock(await fetchJson(`${base}/markets/clock`, token), new Date(now));
  } catch {
    // A clock outage should not stop a scan — fall back to plain ET arithmetic.
    return parseClock({}, new Date(now));
  }
}

async function fetchIntraday(base, token, symbol, now) {
  const start = tradierTimestamp(new Date(now), { hour: '09', minute: '30' });
  const end = tradierTimestamp(new Date(now));
  const url =
    `${base}/markets/timesales?symbol=${encodeURIComponent(symbol)}` +
    `&interval=1min&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}` +
    `&session_filter=open`;
  return parseTimesales(await fetchJson(url, token));
}

async function fetchFinnhubProfile(symbol, apiKey) {
  const profile = await fetchJson(
    `${FINNHUB}/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`,
    null,
  ).catch(() => null);
  const outstanding = Number(profile?.shareOutstanding); // reported in millions
  return {
    sector: profile?.finnhubIndustry || null,
    float: Number.isFinite(outstanding) && outstanding > 0 ? outstanding * 1e6 : null,
    floatIsEstimated: true,
  };
}

async function fetchFinnhubNews(symbol, apiKey, lookbackHours) {
  const to = new Date();
  const from = new Date(to.getTime() - Math.max(lookbackHours, 24) * 3600 * 1000);
  const iso = (d) => d.toISOString().slice(0, 10);
  const items = await fetchJson(
    `${FINNHUB}/company-news?symbol=${encodeURIComponent(symbol)}&from=${iso(from)}&to=${iso(to)}&token=${apiKey}`,
    null,
  ).catch(() => []);
  if (!Array.isArray(items)) return [];
  return items.slice(0, 12).map((item) => ({
    headline: item.headline,
    source: item.source,
    datetime: new Date((item.datetime ?? 0) * 1000).toISOString(),
    url: item.url ?? null,
  }));
}

// Finnhub is keyed per symbol and its free tier is tight; profile and float do
// not change intraday, so cache them for the life of the process.
const profileCache = new Map();

/**
 * Fetch and normalize a watchlist. Symbols that fail are reported in `errors`
 * rather than dropped, so a broken feed never looks like a quiet market.
 */
export async function getQuotes({
  symbols = [],
  token = process.env.TRADIER_TOKEN || '',
  sandbox = String(process.env.TRADIER_SANDBOX || '').toLowerCase() === 'true',
  apiKey = process.env.FINNHUB_API_KEY || '',
  newsLookbackHours = 24,
  now = Date.now(),
} = {}) {
  if (!token) {
    throw new Error('TRADIER_TOKEN is not set — the Tradier provider needs a bearer token');
  }

  const base = baseUrl({ sandbox });
  const errors = [];
  const session = await fetchClock(base, token, now);

  // 1. Batched quotes.
  const batches = await mapLimit(chunk(symbols, QUOTE_CHUNK), 3, async (group) => {
    const url = `${base}/markets/quotes?symbols=${encodeURIComponent(group.join(','))}&greeks=false`;
    return parseQuotes(await fetchJson(url, token));
  });

  const rawQuotes = [];
  for (const batch of batches) {
    if (batch?.__error) {
      errors.push({ symbol: batch.item.join(','), message: batch.__error.message });
      continue;
    }
    rawQuotes.push(...batch.quotes);
    for (const symbol of batch.unmatched) {
      errors.push({ symbol, message: 'Unknown symbol at Tradier' });
    }
  }

  // 2. Per-symbol intraday bars and Finnhub enrichment.
  const enriched = await mapLimit(rawQuotes, 5, async (raw) => {
    const quote = normalizeQuote(raw, session);
    const candles = await fetchIntraday(base, token, quote.symbol, now).catch(() => []);

    let profile = { float: null, floatIsEstimated: false, sector: null };
    let news = [];
    if (apiKey) {
      if (!profileCache.has(quote.symbol)) {
        profileCache.set(quote.symbol, await fetchFinnhubProfile(quote.symbol, apiKey));
      }
      profile = profileCache.get(quote.symbol);
      news = await fetchFinnhubNews(quote.symbol, apiKey, newsLookbackHours);
    }

    return {
      ...quote,
      sector: profile.sector ?? quote.sector,
      float: profile.float,
      floatIsEstimated: profile.floatIsEstimated,
      shortInterest: null, // Tradier does not carry short interest
      relVol5min: relativeVolume5Min(candles, quote.avgVolume),
      news,
      newsAvailable: Boolean(apiKey),
      candles,
    };
  });

  const quotes = [];
  for (const item of enriched) {
    if (item?.__error) {
      errors.push({ symbol: item.item?.symbol ?? 'unknown', message: item.__error.message });
    } else if (item) {
      quotes.push(item);
    }
  }

  return {
    quotes,
    session,
    provider: 'tradier',
    errors,
    newsAvailable: Boolean(apiKey),
    sandbox,
  };
}
