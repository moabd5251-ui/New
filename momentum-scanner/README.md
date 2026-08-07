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

Selection answers *what* to trade. The strategy layer answers *when*, *how much*,
and *when to stop* — see [The trade strategy](#the-trade-strategy) below.

## Quick start

No dependencies, no build step. Node 18+ is all you need.

```bash
cd momentum-scanner
npm start           # http://localhost:4173
npm test            # 94 tests, no network required
```

`npm run verify:live` exercises the paths that only exist while the market is
open — the clock reporting `open`, relative volume pro-rated against the pace so
far rather than a whole day, real `timesales` bars feeding pattern detection, and
5-minute relative volume. It needs `TRADIER_TOKEN` and exits 3 if the market is
closed.

That runs on **simulated market data** so the scanner is usable immediately. The
tickers in simulation are fictional on purpose — the numbers are generated, and
attaching them to real companies would misrepresent them.

## Live market data

```bash
SCANNER_PROVIDER=live npm start
```

`live` picks the best feed available: **Tradier** when `TRADIER_TOKEN` is set,
Yahoo otherwise. Force one with `SCANNER_PROVIDER=tradier` or `=yahoo`.

### Tradier (recommended)

```bash
SCANNER_PROVIDER=live TRADIER_TOKEN=your_token npm start
```

Better than the Yahoo fallback in four ways that matter to a scanner:

| | Tradier | Yahoo fallback |
|---|---|---|
| Quotes | **Batched** — one request per 50 symbols | One request per symbol |
| Average volume | **Served directly** (`average_volume`) | Averaged from 50 daily bars |
| Intraday bars | **True 1-minute OHLCV** via `timesales`, with VWAP | 1-minute chart series |
| Session state | **`/markets/clock`** — knows half-days and holidays | Timezone arithmetic |
| 5-min relative volume | **Computed from real bars** | Unavailable |

Add `TRADIER_SANDBOX=true` to use the sandbox host. Sandbox tokens are free but
the data is delayed — the UI labels it so a delayed quote is never mistaken for
a live one.

Tradier does not carry **float**, **news** or **short interest**, so those still
come from Finnhub:

```bash
SCANNER_PROVIDER=live TRADIER_TOKEN=your_token FINNHUB_API_KEY=your_key npm start
```

### Partial selection

A pillar the feed cannot supply is *unknown*, not failed — so without a news or
float source nothing would ever qualify, and the whole strategy layer would be
unreachable on an otherwise excellent price feed. Stocks that pass everything
the feed **can** judge are therefore marked **partial**: they get setups and
trade plans, ranked below fully qualified names, and every one carries a banner
naming the criteria that went unchecked. A partial pass is never silently
upgraded to a real one.

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
- **Five tabs** — *Qualified* (all five), *Near miss* (exactly four), *All
  scanned*, *Setups* (an entry pattern is live), *Journal*.
- **Detail drawer** — click any row for the full quote, a per-criterion checklist
  explaining precisely why the stock passed or failed each one, and the
  headlines driving it.
- **Alerts** — fires when a stock *starts* meeting all five, not on every scan
  while it continues to. Re-arms after 10 minutes so a name hovering on the
  threshold cannot spam the feed.

## The trade strategy

Passing the five criteria is necessary, not sufficient. A qualified stock still
needs an entry with defined risk, a size that fits the account, and a rule that
says when to stop for the day.

### 1. Entry patterns

Only qualified stocks are scanned for setups — answering "when" for a stock that
already failed "what" is wasted work. Each detector looks for the same thing: a
pause in the buying where sellers have *not* taken control, so the break of the
pause high is a cheap entry with a nearby stop.

| Pattern | What it is | Entry / stop |
|---------|-----------|--------------|
| **Micro pullback** | 1–2 soft candles inside a strong drive, giving back < 38.2% of the leg | Break of the pullback high / below its low |
| **Bull flag** | A clear impulse leg, then a 2–4 candle orderly pullback, ideally on drying volume | Break of the pullback high / below its low |
| **Flat top breakout** | 3–8 candles capped at the same price after a run — a resting seller | Break of the ceiling / below the base low |
| **Opening range breakout** | Price coiled under the high of the 09:30–09:35 range | Break of the range high / below the range low |

Setups already more than 1.5% through their trigger are dropped rather than
chased — a defined-risk entry stops being one the moment you pay up for it.
"No setup" is the common answer, and the UI says so plainly.

### 2. Position sizing

The stop sets the size, never the other way round:

```
shares = (account × risk% ) ÷ (entry − stop)
```

A $25,000 account risking 1% has a $250 budget. A stop $0.50 away buys 500
shares; a stop $0.25 away buys 1,000 — **the same $250 of risk**. That is why the
patterns above are selected for tight stops. Size is then trimmed by:

- **Liquidity** — never more than 2% of recent per-minute volume. A position you
  cannot exit at your stop does not really have a stop.
- **Notional** — a cap on position cost as a share of the account.
- **Stop width** — a stop more than 8% away is rejected outright; that is a
  different trade, not this one.

A plan that cannot be sized is returned *blocked, with the reason*, not hidden.

### 3. Profit targets

Targets are set in **R** — multiples of the per-share risk. The default scales
50% out at 2R and the rest at 3R, moving the stop to breakeven once the first
target fills. 2:1 is the floor because it is what makes a losing majority
survivable: at 2:1, a 33% win rate breaks even, and anything above it profits.

### 4. Daily rules

Per-trade math bounds one loss; these bound the day.

| Rule | Default | Why |
|------|---------|-----|
| Max daily loss | 3% of account | Stops a bad morning becoming a bad month |
| Max trades / day | 6 | Blunts revenge trading |
| Max consecutive losses | 3 | Forces a reset when the read is off |
| Session window | 09:30–11:30 ET | Where the volume that makes these moves lives |

When a rule trips, the API **refuses to log the trade** — a rule the server works
around is not a rule. The panel shows the day's standing at all times.

### 5. Journal

Logged trades record the plan; closing one records the result and derives P&L
and R. Stats show win rate, realized payoff ratio, total R and expectancy per
trade. R is the unit that matters — it normalizes away size, so a 2R win on 200
shares and a 2R win on 2,000 compare directly. Exits more than 5× away from the
entry are refused as fat-finger typos, since one bad number poisons every
statistic downstream.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `4173` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `SCANNER_PROVIDER` | `mock` | `mock`, `live` (auto-picks), `tradier`, or `yahoo` |
| `SCANNER_SYMBOLS` | — | Comma/space separated watchlist for live mode |
| `TRADIER_TOKEN` | — | Bearer token; selects Tradier under `live` |
| `TRADIER_SANDBOX` | `false` | Use the delayed sandbox host |
| `FINNHUB_API_KEY` | — | Enables float and news in live mode |

Tokens are read from the environment only — nothing writes them to disk, and
`data/` is gitignored.

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/scan` | GET | Run a scan; ranked results, per-pillar verdicts, summary |
| `/api/alerts` | GET / DELETE | Rolling alert feed, or clear it |
| `/api/config` | GET / POST | Read or update thresholds (partial updates allowed) |
| `/api/watchlist` | GET / POST | Symbols used in live mode |
| `/api/risk` | GET / POST | Account size, risk per trade, daily rules |
| `/api/trades` | GET / POST | Journal; POST is refused when a daily rule has tripped |
| `/api/trades/close` | POST | Close a trade at an exit price |
| `/api/health` | GET | Provider status and last scan time |

## Layout

```
lib/criteria.js           the five pillars, scoring, ranking
lib/patterns.js           entry pattern detection on 1-minute candles
lib/trade-plan.js         risk-based sizing, stops and R targets
lib/journal.js            trade log, daily rules, performance stats
lib/alerts.js             qualify-transition tracking
lib/watchlist.js          symbol list loading and validation
lib/session-volume.js     intraday volume curve behind relative volume
lib/providers/mock.js     simulated market (default)
lib/providers/tradier.js  Tradier quotes/timesales/clock + optional Finnhub
lib/providers/live.js     Yahoo fallback + optional Finnhub
public/                   single-page UI, no build step
server.js                 dependency-free HTTP server
test/                     node:test suite (94 tests)
```

## Notes on the numbers

**Relative volume** compares today's volume against what this stock would
normally have traded *by this point in the session* — not against a whole
average day. Without that, the same stock reads as weak at 09:35 and strong at
15:55 purely from the clock.

Crucially, "by this point" is **not** a flat pro-rate of the clock. US equity
volume is strongly U-shaped: roughly 15% of a typical day trades in the first
half hour and 23% in the last, against ~4% per half hour at lunch. Pro-rating
linearly breaks the opening badly in both directions — a naive elapsed fraction
expects 0.26% of the day's volume one minute in, when a typical stock has
already done ~1.5%, so everything looks like a 6x runner; clamping that fraction
to a floor overshoots the other way and divides by a baseline ~8x too large, so
a real 8x runner reads as 1x. Either way the scanner is wrong during the exact
minutes this strategy trades. `lib/session-volume.js` models the curve instead.
It is an approximation of a typical liquid US equity, not a per-symbol profile.

Outside regular hours the reported volume is a completed session, so it is
compared against the full daily average instead. If a feed ever reports the
session open while the clock disagrees, the baseline falls back to a full day —
under-reporting, which is the safe direction for a signal that gates trades.

**Outside regular hours** the volume a feed reports is extended-hours activity,
but the only baseline available is a whole average day — so relative volume
reads near zero for everything, even a stock going wild premarket. Tradier does
not publish a premarket baseline, so rather than invent one the scanner flags
the reading as extended-hours and shows the figure traders actually use before
the open: what percentage of an average day has already traded.

**Float**, not shares outstanding, is the supply side of the setup: it is the
number of shares that can actually change hands. A stock that has traded several
times its float and is still holding its gains has absorbed everyone who wanted
out — that is the imbalance criterion 5 is looking for.

## Scope

This is a screening, planning and journaling tool. It reports what the data says
about a set of mechanical rules; it does not give investment advice, predict
prices, or place orders — no broker is connected, and "Log this trade" records a
plan in a local file, nothing more. Simulated mode produces invented numbers for
fictional tickers and should not be read as a market forecast. Backtested or
illustrative results are not a guide to what any strategy will do next.

### Provenance of the rules

The five selection criteria are transcribed directly from the source material.
The strategy layer — the four entry patterns, risk-based sizing, 2:1 minimum
targets, and the daily loss / trade-count limits — is the standard published
form of this methodology, with the specific defaults listed above. Every one of
those numbers is a configurable default, not a claim about what is optimal.
