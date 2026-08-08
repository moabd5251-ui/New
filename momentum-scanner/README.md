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

A second, independent strategy runs over the same feeds:
[multi-timeframe trend continuation](#multi-timeframe-trend-continuation) — a
ladder of timeframes that have to agree, entering on a pullback that holds the
structure of the rung above it rather than on a fresh breakout. The rule is the
same at every scale, so the ladder runs from `1d → 1h → 5m` down to
`15m → 5m → 1m`.

## Quick start

No dependencies, no build step. Node 18+ is all you need.

```bash
cd momentum-scanner
npm start           # http://localhost:4173
npm test            # 179 tests, no network required
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
- **Six tabs** — *Qualified* (all five), *Near miss* (exactly four), *All
  scanned*, *Setups* (an entry pattern is live), *Trend stack* (the
  multi-timeframe read), *Journal*.
- **Detail drawer** — click any row for the full quote, a per-criterion checklist
  explaining precisely why the stock passed or failed each one, and the
  headlines driving it.
- **Alerts** — fires when a stock *starts* meeting all five, not on every scan
  while it continues to. Re-arms after 10 minutes so a name hovering on the
  threshold cannot spam the feed.
- **Trend stack** — the multi-timeframe read, described in
  [Multi-timeframe trend continuation](#multi-timeframe-trend-continuation)
  below. A different strategy on the same data, in its own tab.

## The trade strategy

Passing the five criteria is necessary, not sufficient. A qualified stock still
needs an entry with defined risk, a size that fits the account, and a rule that
says when to stop for the day.

### 1. Entry patterns

Only stocks that pass selection are scanned for setups — fully qualified ones,
and *partial* ones that cleared everything the feed could judge. Answering
"when" for a stock that failed "what" is wasted work. Each detector looks for the same thing: a
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

## Multi-timeframe trend continuation

A second strategy over the same feeds, in the **Trend stack** tab. Where the
five criteria hunt for one violent day, this one looks for a trend that is
already running and waits for it to pause.

It reads a **ladder** of timeframes and gives each rung exactly one job:

| Rung | Question | Job |
|---|---|---|
| slowest… | Which way is this going at all? | permission |
| second-from-last | Is the current leg still intact? | structure |
| **fastest** | Has it paused, and has the pause ended? | timing |

Every rung above the fastest has to agree before anything else is considered.
If they do not, there is no trade in either direction — that is not a weaker
signal, it is a different market at that scale.

### The ladder is a choice about holding period, not about method

The higher-high/higher-low relationship is **scale-invariant**. A 1-minute
pullback sits inside 5-minute structure exactly as a 5-minute pullback sits
inside hourly structure, and hourly inside daily. Nothing in the rule changes
between them — only how long you are in the trade.

So the timeframes are configurable, and `1d → 1h → 5m` is just the default:

| Ladder | Rungs | Holding period |
|---|---|---|
| `swing` | `1d → 1h → 5m` | hours to days |
| `intraday` | `1h → 15m → 5m` | one session |
| `scalp` | `15m → 5m → 1m` | minutes |
| `micro` | `5m → 1m` | minutes; structure and timing only, no permission layer |
| `wide` | `1d → 4h → 1h` | days to weeks |

Two rungs is the minimum and a real configuration. More than three is allowed
and simply means more has to agree before anything trades. Pick one in the UI,
pass `?ladder=scalp` to the API, or give an explicit list —
`?ladder=1h,15m,5m`.

**Bars can be combined, never split.** A 1-minute rung needs a feed serving
1-minute bars; building one from 5-minute bars would put four fabricated bars
between every real pair and hand the swing detector pivots that never traded.
`buildLadder` refuses, and the rung comes back saying why rather than
producing a confident wrong answer. `detectInterval` reads the bar width from
the timestamps rather than trusting a provider's label.

### Nested levels

Because the relationship repeats at every scale, so do the levels that break
it. The drawer lists all of them, nearest scale first:

```
5-minute higher low     $14.22    ← losing this ends the pause
Hourly higher low       $13.63    ← losing this ends the setup   (decisive)
Daily higher low        $11.70    ← losing this ends the thesis
```

The marked one is the structure rung's, and it is the one the setup is built
against: the price that decides whether the current dip is an entry or an exit.

### Correction or reversal — the level that decides

Every pullback looks like the start of a reversal while it is happening. The
strategy does not judge that by how deep or how frightening the dip is; it
judges it against **one specific price**.

In an uptrend the structure rung is a sequence of higher highs and higher lows.
The most recent *confirmed swing low* on it is the price that sequence rests
on. A sell-off on the timing rung that stays above it has taken nothing away
from the structure, however bad it looks on the fast chart. One that trades
through it has ended the sequence — what looked like a dip to buy is now a
lower low to stand aside from.

That level is `invalidation` throughout the code, and it is the whole strategy:
it decides whether a dip is an entry or an exit, it sets the structural stop,
and it is why the 5-minute chart is only ever allowed to answer *when*, never
*whether*.

### The states

Each symbol lands in exactly one, and every one of them explains itself in a
sentence:

| State | Meaning |
|---|---|
| `not_aligned` | Daily and hourly disagree. Nothing to do. |
| `extended` | Aligned and still driving — no pause to enter on yet |
| `pullback_forming` | Correcting, hourly structure intact, still making new extremes |
| `armed` | The correction has stalled; the trigger is live |
| `triggered` | Price has broken back in the trend's direction |
| `too_deep` | Structure holds, but the pause has gone too far or lasted too long |
| `invalidated` | The pullback broke the hourly structure — it was a reversal |
| `unreadable` | Not enough history on some timeframe to judge |

"Nothing to do" is the common answer, and the tab says so rather than
manufacturing a setup.

### The entry

A break of the pullback's extreme in the direction of the higher timeframes.
Two stops are reported, because which one to use is a real choice:

- **Trade stop** — just beyond the pullback, padded by a fraction of the
  5-minute ATR so ordinary noise does not take it out. This is what the
  position is sized against.
- **Structural stop** — beyond the hourly invalidation. Wider, but the price at
  which the *reason* for the trade is gone.

Targets come from the same risk engine as the momentum setups — 2R and 3R, with
the stop to breakeven after the first fills. Alongside them the setup reports a
**measured move**: the leg that just ran, projected again from where the
pullback ended, expressed in R.

That number is worth reading, because pullback depth costs twice. The entry
sits near the top of the leg and the stop sits below the pullback, so a deeper
pullback buys a *wider stop* and leaves *less of the projection above the
entry*. A 25% pullback projects to roughly 2R; a 60% one to well under 1R. When
the projection cannot reach the configured minimum the setup carries a caution
saying so, rather than being quietly presented as equivalent to a shallow one.

Setups more than 1% through their trigger are dropped rather than chased, for
the same reason as in the momentum patterns.

### Short setups

This strategy fires in both directions, which the momentum patterns do not.
`buildTradePlan` and the journal are direction-aware: a short is sized off the
same risk budget, its targets run down from the entry, and its P&L and R are
measured against the direction of the trade rather than the direction of the
chart. Setups without a `direction` are treated as long, so every trade logged
before this existed still reads correctly.

### Where the bars come from

One intraday fetch, at the ladder's **fastest** interval; every coarser rung is
resampled from it, so no two rungs can disagree about a bar they share. The
daily rung comes from the provider's daily history with today re-derived from
the intraday bars.

Buckets are anchored to the **09:30 ET bell**, not the wall clock — a
clock-anchored hour would end the first bar at 10:00, which is a 30-minute bar
wearing an hourly label, and every bar after it would be offset from what a
charting platform shows.

What each feed will serve bounds which ladders are reachable:

| Feed | 1-minute | 5-minute | Hourly |
|---|---|---|---|
| Tradier | ~5 days | ~20 days | from 5-minute bars |
| Yahoo | 7 days | 1 month | 2 years |
| Simulated | generated natively at any of 1m / 5m / 15m | | |

That makes `wide` (`1d → 4h → 1h`) reachable only on a feed with months of
intraday history — Yahoo's two-year hourly series does it; twenty days of
Tradier 5-minute bars does not, and the rung says so instead of guessing.

In simulated mode each symbol is assigned a regime — trending up, trending
down, or swinging without trending — so the strategy has something to find and,
just as importantly, something to correctly refuse. The choppy symbols are the
useful ones: a strategy that never says "stand aside" in simulation is not
being tested.

### Backtesting

```bash
npm run backtest                                    # simulated data, all symbols
npm run backtest -- --symbols VXTQ,TRAQ
npm run backtest -- --slippage 0.1 --commission 0.005
npm run backtest -- --provider yahoo --symbols AAPL,MSFT
npm run backtest -- --sweep retrace                 # vary one threshold
npm run backtest -- --repeats 6                     # how noisy is one number?
npm run backtest -- --ladder scalp                  # replay a different ladder
```

The replay walks one 5-minute bar at a time, hands the strategy **only** the
bars up to that one, rests a stop order on whatever setup comes back, and then
resolves fills, stops and targets on later bars.

**On the default provider these results are worthless as evidence.** The
simulated bars are generated by a process that builds higher highs, higher lows
and pullbacks into the series on purpose — the exact structure this strategy
detects — so the strategy is being scored on finding a pattern that was planted
for it. The command prints that warning before every run. What a simulated run
*does* establish is that the mechanics work, that there is no lookahead, and
how badly costs hurt a strategy whose stops are a fraction of a percent wide —
and that last one is a property of the rules, not the data.

Four modelling choices, each of which a backtest usually gets wrong in the
direction that flatters it:

| Situation | What this does | Why |
|---|---|---|
| A bar covers both the stop and a target | Takes the stop | OHLC cannot say which came first, and assuming the target turns every loser that briefly traded green into a winner |
| Price gaps through an order | Fills at the open | Filling at the trigger hands the run free money on exactly the bars a real account loses most on |
| A gapped entry then stops out | Costs more than 1R | Size was fixed by the *planned* entry-to-stop distance, so R is measured against that. Measuring against the actual fill would relabel every gap as a tidy -1R |
| A position is open when the data ends | Marked to the last close | Dropping it silently discards whichever trades were going worst when the data ran out |
| The session ends with a position open | Flattened at the bell | `maxHoldBars` cannot do this on its own — bars only accrue while the market is open, so 78 five-minute bars from a 15:00 entry expires at 15:00 *the next day*. On real bars the eleven trades carried overnight averaged -2.36R against -0.50R for those closed the same session: an overnight gap goes straight through a stop a few tenths of a percent wide. `--overnight` restores the old behaviour |

The one place the engine is *not* pessimistic is the bar a trade fills on: the
position did not exist when that bar opened, so an open below a long's stop is
not a gap through the stop. The bar's low is still honoured.

`--optimistic` flips the ambiguous-bar rule, which is a quick way to see how
much of any result is real and how much is that single assumption.

The replay sizes itself to its ladder. How much history it hands the strategy
each step is derived from the slowest rung measured in units of the fastest —
the scalp ladder's 15-minute rung wants the same number of *bars* as the swing
ladder's hourly rung, but built from 1-minute data that is three times as many
of them, so a fixed number would quietly starve the fast ladders. Warmup is
separate and much shorter: it is the point at which every rung becomes readable
at all, not the point at which its window is full, because waiting for a full
window would be stricter than the live scanner and would cost decisions for
nothing.

#### Proving there is no lookahead

`hasLookahead()` runs the replay's own view of one bar twice — the second time
with every later bar quadrupled and today's daily bar given the whole session's
range, which are the two ways a feed actually leaks the future into a replay.
If the verdict moves at all, the run aborts rather than printing numbers. The
test suite also asserts the poison *would* be detected, because a check that
cannot fail proves nothing.

#### How much noise is in one number

`--repeats N` replays the same rules over N independently phased samples of the
simulated data and prints the spread.

It exists because the first two runs of this backtest, ten minutes apart,
returned **-1.7R** and **+42.7R**. Same rules, same generator, ~200 trades
each; the only difference was the phase of the bars. Six samples give the
fuller picture:

```
  sample 1   231 trades  41.99% win   +34.16R
  sample 2   214 trades  36.45% win    -7.42R
  sample 3   227 trades  41.85% win   +20.80R
  sample 4   216 trades  35.19% win   -20.33R
  sample 5   218 trades  37.61% win    -9.43R
  sample 6   193 trades  36.27% win   -16.25R

  Range -20.33R to +34.16R, median -7.42R
```

Two hundred trades cannot distinguish a strategy that makes 0.15R a trade from
one that loses 0.09R a trade. That is the honest width of a result this size,
and it is why no single figure from this tool should be quoted on its own.

#### What it does on real bars

This is the part that matters, and it is not good.

```
npm run backtest -- --provider yahoo \
  --symbols AAPL,MSFT,NVDA,TSLA,AMD,META,GOOGL,AMZN,SPY,QQQ
```

One month of real 5-minute bars, ten large caps, 12,754 decisions:

| slippage/side | trades | win rate | total | per trade | profit factor |
|---|---|---|---|---|---|
| 0.00% | 73 | 19.2% | **-40.2R** | -0.550R | 0.36 |
| 0.05% | 73 | 19.2% | **-59.9R** | -0.820R | 0.24 |
| 0.20% | 71 | 12.7% | **-114.2R** | -1.609R | 0.11 |

**It loses badly, and it loses before costs.** A 2R/3R target scheme needs
roughly a 35% win rate to break even; this gets 19%. Six of 73 trades reached
the first target, 54 stopped out.

Two things the real data says that the simulated data did not:

- **The ladder almost never agrees.** 91% of decision bars came back
  `not_aligned` — on real large caps a strict higher-highs-*and*-higher-lows
  sequence on the daily and the hourly at once is rare. The strategy is
  trading the ~9% of the time it thinks it sees one, and being wrong.
- **The measured-move caution is backwards here.** On simulated bars the
  uncautioned trades looked like the one robust edge (+0.4 to +0.9R against
  roughly zero). On real bars they are the *worst* slice: -1.22R a trade at 12%
  win, against -0.61R for the cautioned ones. A finding that survived six
  resamples of synthetic data did not survive first contact with a real one.

Take that as the honest verdict on the strategy as configured, and as a
demonstration of why the simulated numbers below carry the warning they do.

#### Does the five-criteria screen help?

`--screen` gates entries on the selection criteria before any setup is taken.
Only **three of the five** can be applied to history: change-on-the-day,
relative volume and price all fall out of OHLCV, but news has no archive and
float is published as a current figure that has since changed — using today's
float to judge a stock three weeks ago is a quiet form of lookahead, so neither
is offered rather than approximated.

One month of real 5-minute bars, 0.05% slippage per side:

| Universe | Screen | Trades | Win | Total | Per trade |
|---|---|---|---|---|---|
| Small caps | none | 77 | 37.7% | -10.6R | -0.137R |
| Small caps | change ≥2%, rvol ≥1.2x | **12** | 66.7% | **+6.6R** | +0.547R |
| Small caps | change ≥5%, rvol ≥2x | 2 | 100% | +3.0R | +1.49R |
| Small caps | scanner strength (10%, 5x) | **1** | 100% | +2.0R | +2.01R |
| Large caps | none | 73 | 19.2% | -59.9R | -0.820R |
| Large caps | any of the above | **0** | — | — | — |

Three things fall out, in decreasing order of confidence.

**The universe matters more than the screen.** Same rules, same month: -0.137R
a trade on volatile small caps against -0.820R on large caps. That is the
largest single effect measured anywhere in this project, and it needs no
screen at all — a strategy entering on a pullback needs the instrument to
actually move, and a stop a few tenths of a percent wide needs the move to be
large relative to the spread.

**At real scanner strength there is nothing to trade.** One trade in a month
across fifteen symbols. The five criteria are built to surface a handful of
names a day for a strategy that trades them *immediately*; ANDing that with
"and the daily and hourly must agree, and the fast rung must be pulling back
without breaking structure" leaves an empty set. Two rare conditions
intersected are not a rarer condition, they are no condition.

**The loose screen looks good and the evidence is weak.** Against 20,000 random
12-trade subsets of the same 77, the screened twelve beat 96% of them
(p ≈ 0.038, median random subset -1.86R). That is nominally significant and it
is not enough: four screen settings were tried and the best reported, on twelve
trades in one month, with thresholds chosen by hand. Multiple comparisons alone
put the real false-positive rate near 15%. Treat it as a reason to run the
experiment properly on more history, not as a finding.

#### On sweeps

`--sweep` varies one threshold and prints the results side by side. Use it to
see whether a rule matters at all, never to choose its value: given the spread
above, the differences between settings are well inside the noise, and on
simulated data the "best" setting is just whichever one best matches the
generator.

### Configuration

Three thresholds are editable in the UI and persist to `data/trend.json`; the
rest are defaults in `lib/trend.js`.

| Setting | Default | Meaning |
|---|---|---|
| `maxRetracePct` | 61.8 | Deeper into the leg than this is a reversal, not a pause |
| `minRetracePct` | 15 | Shallower than this has not paused yet, it is still driving |
| `maxPullbackBars` | 12 | Longer than this and the move is stalling, not pausing |
| `minLegAtr` | 2 | How big the leg has to be, in bar ranges of the timing rung |
| `minMeasuredR` | 2 | Below this the setup carries a caution |
| `swingSpan` | 2 | Bars either side of a pivot before it counts as one |
| `ladder` | `swing` | Which run of timeframes to read |
| `windows` | per interval | How many bars of each rung to read — see `DEFAULT_WINDOWS` |
| `fastPeriod` / `slowPeriod` | 9 / 21 | Moving averages, used only to *confirm* structure |

**Thresholds have to be in the right units.** `minLegAtr` is measured in bar
ranges of the timing rung, not in percent of price, and that is not a detail.
It used to be `minLegPct: 0.4`, which on real bars admits 43% of 5-minute legs
and **0%** of 1-minute ones — the `scalp` and `micro` ladders could not have
taken a single trade on a real large cap. A percent floor silently turns a
faster ladder into a pickier strategy rather than the same one run faster. In
bar ranges the same floor admits 67% and 20%: still not equal, because a
`swingSpan` of 2 picks up noise-scale pivots on a 1-minute chart, but the fast
ladders at least function.

`maxChasePct` and `triggerBufferPct` are still percentages and have the same
shape of problem, unaddressed.

Structure decides direction; the moving averages only say whether the recent
path agrees. They can withdraw a direction — structure pointing up while price
sits under a falling average is reported as unclear — but they can never create
one, because a moving average is a lagging summary of the same prices the
swings are made of, and treating it as independent evidence double-counts them.

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
| `/api/trend` | GET | Multi-timeframe read; `?symbol=X` for one, `?ladder=scalp` (or `?ladder=1h,15m,5m`) to pick the rungs |
| `/api/trend/config` | GET / POST | Thresholds for the trend strategy |
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
lib/timeframes.js         resampling and ladder assembly from one intraday feed
lib/trend.js              timeframe ladders, trend alignment, continuation entries
lib/backtest.js           walk-forward replay, fill modelling, lookahead check
lib/trade-plan.js         risk-based sizing, stops and R targets (long and short)
lib/journal.js            trade log, daily rules, performance stats
lib/alerts.js             qualify-transition tracking
lib/watchlist.js          symbol list loading and validation
lib/session-volume.js     intraday volume curve behind relative volume
lib/providers/mock.js     simulated market (default)
lib/providers/tradier.js  Tradier quotes/timesales/clock + optional Finnhub
lib/providers/live.js     Yahoo fallback + optional Finnhub
public/                   single-page UI, no build step
server.js                 dependency-free HTTP server
scripts/backtest.mjs      backtest runner
test/                     node:test suite (179 tests)
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
form of this methodology, with the specific defaults listed above.

The multi-timeframe strategy is the conventional trend-continuation form:
swing-structure trend definition, higher-timeframe alignment, and entries on
the resumption of a pullback that held structure. Nothing about it is novel.
`npm run backtest` will replay it, but on simulated data that measures the
generator rather than the strategy — see [Backtesting](#backtesting). Every
threshold in both strategies is a configurable default, not a claim about what
is optimal.
