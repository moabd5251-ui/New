# Momentum Scanner

A day-trading stock scanner built around the **5 criteria of stock selection** — a
screen for stocks with unusually **high demand** and unusually **low supply**.

Four criteria measure demand, one measures supply, and a stock has to clear all five:

| # | Type | Criterion | Default |
|---|------|-----------|---------|
| 1 | Demand | Already up on the day | **≥ 10%** from the prior close |
| 2 | Demand | Relative volume | **≥ 5x** the normal pace for this time of day |
| 3 | Demand | A news event moving the stock | **≥ 1** headline in the last 24h |
| 4 | Demand | Price range day traders prefer | **$2 – $20** |
| 5 | Supply | Float available to trade | **< 20 million** shares |

A sixth, bonus check — an **opening gap up of ≥ 2%** — separates an `A` setup from
an `A+`. Every threshold is editable in the UI and persists to `data/config.json`.

## Quick start

No dependencies, no build step. Node 18+ is all you need.

```bash
cd momentum-scanner
npm start           # http://localhost:4173
npm test            # 24 tests, no network required
```

That runs on **simulated market data** so the scanner is usable immediately. The
tickers in simulation are fictional on purpose — the numbers are generated, and
attaching them to real companies would misrepresent them.

## Live market data

```bash
SCANNER_PROVIDER=live npm start
```

Price, volume and the 50-day average volume come from Yahoo's public chart
endpoint, which needs no key. Float and headlines need Finnhub:

```bash
SCANNER_PROVIDER=live FINNHUB_API_KEY=your_key npm start
```

Two limits the app reports rather than papers over:

- **Without a Finnhub key there is no news feed.** The news pillar is shown as
  *unavailable* (`?`), never as a silent pass — the scanner will not talk you
  into a trade on data it does not have.
- **Finnhub reports shares outstanding, not true float.** When that is the only
  figure available the float pillar is flagged *estimated*. Outstanding is always
  ≥ float, so the check errs toward rejecting a stock, never toward a false
  positive.

Live mode walks an explicit watchlist (free feeds do not stream the whole
market). Set it however you like:

```bash
SCANNER_SYMBOLS="SNDL,PLUG,BBAI,RGTI" SCANNER_PROVIDER=live npm start
```

or edit `data/watchlist.json`, or POST to `/api/watchlist`.

## What the interface shows

- **Scanner table** — the columns a momentum trader reads at a glance: change
  from close, price, volume, float, relative volume (daily rate and 5-minute),
  gap, short interest. Numeric cells are heat-mapped, so the outliers surface
  without reading a single number. Sort by any column.
- **Criteria panel** — all five thresholds, live-editable, each showing how many
  of the scanned names currently pass it.
- **Three tabs** — *Qualified* (all five), *Near miss* (exactly four, the ones
  worth watching), *All scanned*.
- **Detail drawer** — click any row for the full quote, a per-criterion checklist
  explaining precisely why the stock passed or failed each one, and the
  headlines driving it.
- **Alerts** — fires when a stock *starts* meeting all five, not on every scan
  while it continues to. Re-arms after 10 minutes so a name hovering on the
  threshold cannot spam the feed.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `4173` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `SCANNER_PROVIDER` | `mock` | `mock` or `live` |
| `SCANNER_SYMBOLS` | — | Comma/space separated watchlist for live mode |
| `FINNHUB_API_KEY` | — | Enables float and news in live mode |

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/scan` | GET | Run a scan; ranked results, per-pillar verdicts, summary |
| `/api/alerts` | GET / DELETE | Rolling alert feed, or clear it |
| `/api/config` | GET / POST | Read or update thresholds (partial updates allowed) |
| `/api/watchlist` | GET / POST | Symbols used in live mode |
| `/api/health` | GET | Provider status and last scan time |

## Layout

```
lib/criteria.js         the five pillars, scoring, ranking
lib/alerts.js           qualify-transition tracking
lib/watchlist.js        symbol list loading and validation
lib/providers/mock.js   simulated market (default)
lib/providers/live.js   Yahoo chart + optional Finnhub
public/                 single-page UI, no build step
server.js               dependency-free HTTP server
test/                   node:test suite
```

## Notes on the numbers

**Relative volume** compares today's volume against the average pace *to this
point in the session* — not against a whole average day. Without that, the same
stock reads as weak at 09:35 and strong at 15:55 purely from the clock. Outside
regular hours the reported volume is a completed session, so it is compared
against the full daily average instead.

**Float**, not shares outstanding, is the supply side of the setup: it is the
number of shares that can actually change hands. A stock that has traded several
times its float and is still holding its gains has absorbed everyone who wanted
out — that is the imbalance criterion 5 is looking for.

## Scope

This is a screening and research tool. It reports what the data says about five
mechanical criteria; it does not give investment advice, predict prices, or
place trades. Simulated mode produces invented numbers for fictional tickers and
should not be read as a market forecast.
