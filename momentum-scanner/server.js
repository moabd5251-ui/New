#!/usr/bin/env node
/**
 * Momentum scanner HTTP server.
 *
 * No framework and no dependencies — Node's own http/fs is enough for a static
 * page plus a handful of JSON endpoints, and it means `node server.js` works on
 * a clean checkout.
 *
 *   GET  /api/scan        run the scanner, return ranked results + summary
 *   GET  /api/alerts      rolling feed of stocks that just started qualifying
 *   GET  /api/config      current thresholds
 *   POST /api/config      update thresholds (partial updates allowed)
 *   GET  /api/trend       multi-timeframe read, one symbol or the whole list
 *   GET  /api/trend/config  thresholds for the trend strategy
 *   POST /api/trend/config  update them
 *   GET  /api/watchlist   symbols used in live mode
 *   POST /api/watchlist   replace those symbols
 *   GET  /api/health      provider status
 */

import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scan, summarize, DEFAULT_CONFIG, normalizeConfig } from './lib/criteria.js';
import { AlertTracker } from './lib/alerts.js';
import { loadWatchlist, saveWatchlist } from './lib/watchlist.js';
import { bestPattern } from './lib/patterns.js';
import { buildLadder } from './lib/timeframes.js';
import {
  analyzeLadder,
  LADDERS,
  DEFAULT_LADDER,
  DEFAULT_TREND_CONFIG,
  normalizeTrendConfig,
} from './lib/trend.js';
import { planFor, buildTradePlan, DEFAULT_RISK_CONFIG, normalizeRiskConfig } from './lib/trade-plan.js';
import { Journal, DEFAULT_SESSION_RULES, normalizeSessionRules } from './lib/journal.js';
import * as mockProvider from './lib/providers/mock.js';
import * as liveProvider from './lib/providers/live.js';
import * as tradierProvider from './lib/providers/tradier.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const DATA_DIR = join(__dirname, 'data');
const CONFIG_PATH = join(DATA_DIR, 'config.json');
const WATCHLIST_PATH = join(DATA_DIR, 'watchlist.json');
const RISK_PATH = join(DATA_DIR, 'risk.json');
const TREND_PATH = join(DATA_DIR, 'trend.json');
const JOURNAL_PATH = join(DATA_DIR, 'trades.json');

const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '0.0.0.0';
// Live mode needs a working network; mock is the default so the app is useful
// immediately and never silently degrades to an empty table.
const REQUESTED_PROVIDER = (process.env.SCANNER_PROVIDER || 'mock').toLowerCase();

/**
 * `live` picks the best feed available: Tradier when a token is set (batched
 * quotes, real per-minute bars, an authoritative market clock), Yahoo otherwise.
 * `tradier` and `yahoo` force one explicitly.
 */
function resolveProvider(requested) {
  if (requested === 'tradier') return 'tradier';
  if (requested === 'yahoo') return 'yahoo';
  if (requested === 'live') return process.env.TRADIER_TOKEN ? 'tradier' : 'yahoo';
  return 'mock';
}

const PROVIDER = resolveProvider(REQUESTED_PROVIDER);
const IS_LIVE = PROVIDER !== 'mock';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const alerts = new AlertTracker();
const journal = new Journal(JOURNAL_PATH);
let config = { ...DEFAULT_CONFIG };
let risk = { ...DEFAULT_RISK_CONFIG, ...DEFAULT_SESSION_RULES };
let trendConfig = { ...DEFAULT_TREND_CONFIG };
let lastScan = null;

async function readJsonFile(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(path, value) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function loadConfig() {
  config = normalizeConfig(await readJsonFile(CONFIG_PATH, {}));
  const stored = await readJsonFile(RISK_PATH, {});
  risk = { ...normalizeRiskConfig(stored), ...normalizeSessionRules(stored) };
  trendConfig = normalizeTrendConfig(await readJsonFile(TREND_PATH, {}));
  await journal.load();
}

async function runScan() {
  const now = Date.now();

  let payload;
  if (IS_LIVE) {
    const { symbols } = await loadWatchlist(WATCHLIST_PATH);
    const provider = PROVIDER === 'tradier' ? tradierProvider : liveProvider;
    payload = await provider.getQuotes({
      symbols,
      newsLookbackHours: config.newsLookbackHours,
      now,
    });
  } else {
    payload = mockProvider.getQuotes({ now });
  }

  const scored = scan(payload.quotes, config, now);
  const fired = alerts.ingest(scored, now);

  // Only qualified names get a trade plan. Planning an entry on a stock that
  // failed the selection criteria would be answering "when" for something that
  // already failed "what".
  const results = scored.map((result) => {
    // Plan entries for names that pass selection — including ones that pass
    // everything the feed could actually judge. Those carry
    // selectionComplete: false and the UI says which pillars went unchecked.
    if (!result.qualified && !result.provisionallyQualified) {
      // Candles are only useful where there is a chart to draw or a setup to
      // find; dropping them elsewhere keeps the payload small.
      const { candles, ...rest } = result;
      return { ...rest, setup: null, plan: null };
    }
    const setup = bestPattern(result.candles);
    return planFor(result, risk, setup);
  });

  const rules = journal.checkRules(risk.accountSize, risk, now);

  lastScan = {
    scannedAt: new Date(now).toISOString(),
    provider: payload.provider,
    session: payload.session,
    results,
    summary: {
      ...summarize(results),
      provisional: results.filter((r) => r.provisionallyQualified).length,
      withSetup: results.filter((r) => r.setup).length,
      tradable: results.filter((r) => r.plan?.tradable).length,
    },
    errors: payload.errors ?? [],
    newAlerts: fired,
    config,
    risk,
    rules,
  };
  return lastScan;
}

/* ------------------------------------------------------------------ */
/* multi-timeframe trend                                               */
/* ------------------------------------------------------------------ */

// Weeks of bars per symbol is a much heavier request than a quote, and the
// answer barely moves between them: the 5-minute series gains one bar every
// five minutes, and the daily series one per day. Caching for a minute means a
// user clicking through a watchlist pays for the data once.
const HISTORY_TTL_MS = 60_000;
const historyCache = new Map();

/**
 * The finest interval a ladder needs. Bars can be combined but never split, so
 * the fetch has to be at least as fine as the fastest rung — asking for
 * 5-minute bars and then building a 1-minute rung from them is not possible,
 * and buildLadder refuses rather than inventing them.
 */
function finestInterval(ladder) {
  const order = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
  const intraday = ladder.filter((key) => key !== '1d');
  if (!intraday.length) return '1h';
  return intraday.sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
}

async function fetchHistory(symbol, now, interval) {
  const key = `${String(symbol).toUpperCase()}@${interval}`;
  const hit = historyCache.get(key);
  if (hit && now - hit.at < HISTORY_TTL_MS) return hit.payload;

  const symbolUpper = String(symbol).toUpperCase();
  let payload;
  if (PROVIDER === 'tradier') payload = await tradierProvider.getHistory({ symbol: symbolUpper, interval, now });
  else if (PROVIDER === 'yahoo') payload = await liveProvider.getHistory({ symbol: symbolUpper, interval });
  else payload = mockProvider.getHistory({ symbol: symbolUpper, interval, now, sessions: interval === '1m' ? 6 : 12 });

  // Drop stale entries on write rather than on a timer: the map only ever
  // holds symbols someone has actually asked about, so it stays small.
  for (const [cached, entry] of historyCache) {
    if (now - entry.at >= HISTORY_TTL_MS) historyCache.delete(cached);
  }
  historyCache.set(key, { at: now, payload });
  return payload;
}

/** States worth a trader's attention first, most actionable last-in-first-out. */
const STATE_PRIORITY = {
  triggered: 6,
  no_entry: 2.5,
  armed: 5,
  pullback_forming: 4,
  extended: 3,
  too_deep: 2,
  invalidated: 1,
  not_aligned: 0,
  unreadable: -1,
};

async function analyzeSymbol(symbol, now, ladder) {
  const interval = finestInterval(ladder);
  const history = await fetchHistory(symbol, now, interval);
  const rungs = buildLadder({ ladder, intraday: history.intraday, daily: history.daily, now });
  const analysis = analyzeLadder(rungs, trendConfig);

  // The liquidity cap in trade-plan.js is expressed per *minute* of volume,
  // because it was written against 1-minute bars. The timing rung's bars are
  // usually wider than that, so dividing by its width keeps the cap meaning
  // the same thing rather than quietly permitting several times the size.
  const timing = rungs.at(-1);
  const timingMinutes = TIMING_MINUTES[timing.key] ?? 5;
  const recent = timing.bars.slice(-5).map((c) => c.volume).filter((v) => Number.isFinite(v) && v > 0);
  const perMinuteVolume = recent.length
    ? recent.reduce((a, b) => a + b, 0) / recent.length / timingMinutes
    : null;

  return {
    symbol: String(symbol).toUpperCase(),
    name: history.name ?? null,
    ...analysis,
    plan: analysis.setup
      ? buildTradePlan(analysis.setup, risk, { recentCandleVolume: perMinuteVolume })
      : null,
    bars: Object.fromEntries(rungs.map((rung) => [rung.key, rung.bars.length])),
    errors: history.errors ?? [],
    rank: (STATE_PRIORITY[analysis.state] ?? 0) * 100 + (analysis.setup?.quality ?? 0),
  };
}

const TIMING_MINUTES = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 390 };

/** Resolve a ladder name or an explicit comma-separated list of intervals. */
function resolveLadder(requested) {
  if (!requested) return { name: trendConfig.ladder ?? DEFAULT_LADDER, ladder: LADDERS[trendConfig.ladder ?? DEFAULT_LADDER] };
  const name = String(requested).trim();
  if (LADDERS[name]) return { name, ladder: LADDERS[name] };
  const custom = name.split(/[\s,]+/).filter(Boolean);
  if (custom.length >= 2) return { name: 'custom', ladder: custom };
  return { name: DEFAULT_LADDER, ladder: LADDERS[DEFAULT_LADDER] };
}

/** Run with a small concurrency cap so a watchlist cannot flood the feed. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        try {
          results[index] = await worker(items[index]);
        } catch (error) {
          results[index] = { symbol: items[index], error: error.message };
        }
      }
    }),
  );
  return results;
}

async function trendUniverse() {
  if (!IS_LIVE) return mockProvider.symbols;
  const { symbols } = await loadWatchlist(WATCHLIST_PATH);
  return symbols;
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  response.end(text);
}

async function readBody(request, limitBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serveStatic(pathname, response) {
  // Resolve inside PUBLIC_DIR only; a normalized path that escapes the root is
  // a traversal attempt, not a missing file.
  const relative = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const file = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'Content-Length': file.length,
    });
    response.end(file);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);

  try {
    if (url.pathname === '/api/scan' && request.method === 'GET') {
      sendJson(response, 200, await runScan());
      return;
    }

    if (url.pathname === '/api/alerts' && request.method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 100);
      sendJson(response, 200, { alerts: alerts.list(limit) });
      return;
    }

    if (url.pathname === '/api/alerts' && request.method === 'DELETE') {
      alerts.clear();
      sendJson(response, 200, { alerts: [] });
      return;
    }

    if (url.pathname === '/api/config' && request.method === 'GET') {
      sendJson(response, 200, { config, defaults: DEFAULT_CONFIG });
      return;
    }

    if (url.pathname === '/api/config' && request.method === 'POST') {
      const body = await readBody(request);
      config = normalizeConfig({ ...config, ...body });
      await writeJsonFile(CONFIG_PATH, config);
      sendJson(response, 200, { config, defaults: DEFAULT_CONFIG });
      return;
    }

    if (url.pathname === '/api/trend/config' && request.method === 'GET') {
      sendJson(response, 200, { config: trendConfig, defaults: DEFAULT_TREND_CONFIG });
      return;
    }

    if (url.pathname === '/api/trend/config' && request.method === 'POST') {
      const body = await readBody(request);
      trendConfig = normalizeTrendConfig({ ...trendConfig, ...body });
      await writeJsonFile(TREND_PATH, trendConfig);
      sendJson(response, 200, { config: trendConfig, defaults: DEFAULT_TREND_CONFIG });
      return;
    }

    if (url.pathname === '/api/trend' && request.method === 'GET') {
      const now = Date.now();
      const requested = url.searchParams.get('symbol');
      const { name: ladderName, ladder } = resolveLadder(url.searchParams.get('ladder'));
      const symbols = requested
        ? [requested.trim().toUpperCase()]
        : (await trendUniverse()).slice(0, 40);

      const results = (await mapLimit(symbols, 4, (symbol) => analyzeSymbol(symbol, now, ladder)))
        .filter(Boolean)
        .sort((a, b) => (b.rank ?? -1) - (a.rank ?? -1));

      sendJson(response, 200, {
        scannedAt: new Date(now).toISOString(),
        provider: PROVIDER,
        ladder,
        ladderName,
        ladders: LADDERS,
        results,
        summary: {
          scanned: results.length,
          aligned: results.filter((r) => r.contextAligned).length,
          actionable: results.filter((r) => r.setup).length,
          tradable: results.filter((r) => r.plan?.tradable).length,
        },
        config: trendConfig,
        risk,
      });
      return;
    }

    if (url.pathname === '/api/risk' && request.method === 'GET') {
      sendJson(response, 200, {
        risk,
        defaults: { ...DEFAULT_RISK_CONFIG, ...DEFAULT_SESSION_RULES },
      });
      return;
    }

    if (url.pathname === '/api/risk' && request.method === 'POST') {
      const body = await readBody(request);
      const merged = { ...risk, ...body };
      risk = { ...normalizeRiskConfig(merged), ...normalizeSessionRules(merged) };
      await writeJsonFile(RISK_PATH, risk);
      sendJson(response, 200, {
        risk,
        defaults: { ...DEFAULT_RISK_CONFIG, ...DEFAULT_SESSION_RULES },
      });
      return;
    }

    if (url.pathname === '/api/trades' && request.method === 'GET') {
      sendJson(response, 200, {
        trades: journal.trades.slice(0, 100),
        stats: journal.stats(),
        rules: journal.checkRules(risk.accountSize, risk),
      });
      return;
    }

    if (url.pathname === '/api/trades' && request.method === 'POST') {
      const body = await readBody(request);
      const check = journal.checkRules(risk.accountSize, risk);
      // The daily rules are the point — a server that logs a trade after the
      // loss limit is hit is a rule that does not exist.
      if (!check.allowed && !body.override) {
        sendJson(response, 409, { error: 'Blocked by session rules', blockers: check.blockers });
        return;
      }
      const trade = await journal.record(body);
      sendJson(response, 201, { trade, stats: journal.stats() });
      return;
    }

    if (url.pathname === '/api/trades/close' && request.method === 'POST') {
      const body = await readBody(request);
      let trade;
      try {
        trade = await journal.close(body.id, body.exit);
      } catch (error) {
        // An implausible price is the caller's mistake, not a server fault.
        sendJson(response, 400, { error: error.message });
        return;
      }
      if (!trade) {
        sendJson(response, 404, { error: 'No open trade with that id, or invalid exit price' });
        return;
      }
      sendJson(response, 200, { trade, stats: journal.stats() });
      return;
    }

    if (url.pathname === '/api/watchlist' && request.method === 'GET') {
      sendJson(response, 200, await loadWatchlist(WATCHLIST_PATH));
      return;
    }

    if (url.pathname === '/api/watchlist' && request.method === 'POST') {
      const body = await readBody(request);
      const symbols = await saveWatchlist(WATCHLIST_PATH, body.symbols ?? []);
      sendJson(response, 200, { symbols, source: WATCHLIST_PATH });
      return;
    }

    if (url.pathname === '/api/health' && request.method === 'GET') {
      sendJson(response, 200, {
        status: 'ok',
        provider: PROVIDER,
        requestedProvider: REQUESTED_PROVIDER,
        newsFeedConfigured: Boolean(process.env.FINNHUB_API_KEY),
        tradierTokenConfigured: Boolean(process.env.TRADIER_TOKEN),
        tradierSandbox: String(process.env.TRADIER_SANDBOX || '').toLowerCase() === 'true',
        lastScannedAt: lastScan?.scannedAt ?? null,
        universeSize: IS_LIVE ? null : mockProvider.universeSize,
      });
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      sendJson(response, 404, { error: 'Unknown endpoint' });
      return;
    }

    await serveStatic(url.pathname, response);
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
});

await loadConfig();

const PROVIDER_LABELS = {
  mock: 'simulated market data',
  yahoo: 'LIVE market data via Yahoo',
  tradier: 'LIVE market data via Tradier',
};

server.listen(PORT, HOST, () => {
  console.log(
    `Momentum scanner running at http://localhost:${PORT}  (${PROVIDER_LABELS[PROVIDER]})`,
  );
  if (REQUESTED_PROVIDER === 'live' && PROVIDER === 'yahoo') {
    console.log('No TRADIER_TOKEN set — falling back to Yahoo. Tradier gives batched quotes,');
    console.log('real per-minute bars and an authoritative market clock.');
  }
  if (PROVIDER === 'tradier' && String(process.env.TRADIER_SANDBOX).toLowerCase() === 'true') {
    console.log('Using the Tradier sandbox — quotes are delayed, not real time.');
  }
  if (IS_LIVE && !process.env.FINNHUB_API_KEY) {
    console.log('No FINNHUB_API_KEY set — float and news pillars will report as unavailable.');
  }
});

export { server, runScan };
