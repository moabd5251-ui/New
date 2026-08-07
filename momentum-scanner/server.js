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
import * as mockProvider from './lib/providers/mock.js';
import * as liveProvider from './lib/providers/live.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const DATA_DIR = join(__dirname, 'data');
const CONFIG_PATH = join(DATA_DIR, 'config.json');
const WATCHLIST_PATH = join(DATA_DIR, 'watchlist.json');

const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '0.0.0.0';
// Live mode needs a working network; mock is the default so the app is useful
// immediately and never silently degrades to an empty table.
const PROVIDER = (process.env.SCANNER_PROVIDER || 'mock').toLowerCase();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const alerts = new AlertTracker();
let config = { ...DEFAULT_CONFIG };
let lastScan = null;

async function loadConfig() {
  try {
    const contents = await readFile(CONFIG_PATH, 'utf8');
    config = normalizeConfig(JSON.parse(contents));
  } catch {
    config = { ...DEFAULT_CONFIG };
  }
}

async function persistConfig() {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function runScan() {
  const now = Date.now();

  let payload;
  if (PROVIDER === 'live') {
    const { symbols } = await loadWatchlist(WATCHLIST_PATH);
    payload = await liveProvider.getQuotes({
      symbols,
      newsLookbackHours: config.newsLookbackHours,
      now,
    });
  } else {
    payload = mockProvider.getQuotes({ now });
  }

  const results = scan(payload.quotes, config, now);
  const fired = alerts.ingest(results, now);

  lastScan = {
    scannedAt: new Date(now).toISOString(),
    provider: payload.provider,
    session: payload.session,
    results,
    summary: summarize(results),
    errors: payload.errors ?? [],
    newAlerts: fired,
    config,
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
      await persistConfig();
      sendJson(response, 200, { config, defaults: DEFAULT_CONFIG });
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
        newsFeedConfigured: Boolean(process.env.FINNHUB_API_KEY),
        lastScannedAt: lastScan?.scannedAt ?? null,
        universeSize: PROVIDER === 'live' ? null : mockProvider.universeSize,
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

server.listen(PORT, HOST, () => {
  const mode = PROVIDER === 'live' ? 'LIVE market data' : 'simulated market data';
  console.log(`Momentum scanner running at http://localhost:${PORT}  (${mode})`);
  if (PROVIDER === 'live' && !process.env.FINNHUB_API_KEY) {
    console.log('No FINNHUB_API_KEY set — float and news pillars will report as unavailable.');
  }
});

export { server, runScan };
