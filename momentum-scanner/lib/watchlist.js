/**
 * Watchlist used by the live provider.
 *
 * Real scanners stream the whole market; free feeds do not, so live mode walks
 * an explicit symbol list. Order of precedence: SCANNER_SYMBOLS env var, then
 * data/watchlist.json, then a small default of liquid small caps.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_SYMBOLS = [
  'SNDL', 'MARA', 'RIOT', 'PLUG', 'FCEL', 'BBAI', 'SOUN', 'IONQ',
  'RGTI', 'NKLA', 'LCID', 'CHPT', 'AMC', 'GME', 'CLSK', 'HIVE',
];

export function parseSymbols(input) {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : String(input).split(/[\s,]+/);
  const seen = new Set();
  const symbols = [];
  for (const item of raw) {
    const symbol = String(item).trim().toUpperCase();
    // Tickers only: letters, digits, dot and dash. Keeps a stray shell glob or
    // a pasted URL from becoming part of a request path.
    if (!/^[A-Z0-9.\-]{1,10}$/.test(symbol) || seen.has(symbol)) continue;
    seen.add(symbol);
    symbols.push(symbol);
  }
  return symbols;
}

export async function loadWatchlist(path) {
  const fromEnv = parseSymbols(process.env.SCANNER_SYMBOLS);
  if (fromEnv.length) return { symbols: fromEnv, source: 'SCANNER_SYMBOLS' };

  try {
    const contents = await readFile(path, 'utf8');
    const parsed = JSON.parse(contents);
    const symbols = parseSymbols(parsed.symbols ?? parsed);
    if (symbols.length) return { symbols, source: path };
  } catch {
    // No watchlist file yet — fall through to the defaults.
  }

  return { symbols: DEFAULT_SYMBOLS, source: 'defaults' };
}

export async function saveWatchlist(path, symbols) {
  const clean = parseSymbols(symbols);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ symbols: clean }, null, 2)}\n`, 'utf8');
  return clean;
}

export { DEFAULT_SYMBOLS };
