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
import { planFor, DEFAULT_RISK_CONFIG, normalizeRiskConfig } from './lib/trade-plan.js';
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
