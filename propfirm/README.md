# Prop Firm Trading System

A three-step ICT + orderflow scalping engine for NQ futures, built as a
mechanical implementation of a discretionary system: higher-timeframe context,
structural confirmation, then an entry model gated by orderflow — with prop firm
account rules enforced throughout.

Zero dependencies. Node 20+. `node --test` for the suite.

```bash
cd propfirm
npm test                                   # 151 tests
node src/cli.js demo                       # end-to-end run on generated data
node src/cli.js analyze  --csv nq_1m.csv   # read the current setup, step by step
node src/cli.js levels   --csv nq_1m.csv   # liquidity map + orderflow for the session
node src/cli.js backtest --csv nq_1m.csv --account 50K --report out.html
node src/cli.js stats    --journal journal.jsonl

# live data
node src/cli.js analyze  --source yahoo --symbol NQ --interval 1m --range 7d
node src/cli.js backtest --source yahoo --symbol NQ --interval 5m --range 60d
node src/cli.js fetch    --source tradier --symbol QQQ --days 15 --out qqq_1m.csv

# forward collection — run daily, commit the result
node src/cli.js collect  --source yahoo --symbol NQ
node src/cli.js forward  --symbol NQ
```

---

## Read this before you trade it

**1. The orderflow is estimated, not real.** The edge in the source system comes
from depth-of-market data — a heat map of resting passive liquidity and the
aggressive orders hitting it. That cannot be reconstructed from OHLCV candles.
The default `BarOrderflow` provider computes volume profile, POC and VWAP
*accurately* from bars, but infers delta from where each bar closed in its
range. That is a proxy. `FootprintOrderflow` implements the same interface and
takes real bid/ask volume — wire your feed into it and nothing else changes.
Every signal carries `orderflowIsProxy` so you always know which produced it.

**2. Neither Yahoo nor Tradier can properly validate this strategy.** See
[Data sources](#data-sources) — the short version is that Yahoo caps 1-minute
futures history at 7 days, and Tradier has no futures at all. On the data
reachable from them, the system as written loses money. Those results are
below, and they are not encouraging.

**3. Synthetic backtest numbers are meaningless as performance.** The generator
exists so the engine can be tested without a data subscription. It produces the
*structures* the system looks for, which makes it useful for verifying code and
useless for verifying edge. Run it on real NQ data with real volume before you
believe any number.

**4. The account presets are templates.** Firms change their rules. Confirm the
drawdown amount, drawdown model, contract limits, consistency requirement and
payout terms against your own account agreement, and edit
`ACCOUNT_PRESETS` in `src/risk/propfirm.js` to match.

**5. Nothing here is financial advice**, and a mechanical implementation of a
discretionary system is not the same system. The original relies on a human
reading a live tape. This encodes the parts that can be encoded.

---

## Data sources

| | Yahoo (`--source yahoo`) | Tradier (`--source tradier`) |
|---|---|---|
| Instrument | Real futures — `NQ=F`, `ES=F` | Equities and ETFs only. **No futures** — `NQ`, `/NQ`, `NQZ25` all return unmatched |
| Session | Full 23 hours, so Asia and London killzones exist | 04:00–20:00 ET with `session_filter=all` |
| Volume | Credible — daily totals match real NQ turnover, and 1m bars sum to the daily bar | Excellent: real consolidated tape, plus an exchange VWAP per bar |
| 1-minute history | **7 days** | **~20 days** |
| Longer history | 5m → 60 days, 1h → 730 days | 5min/15min only |
| Bid/ask split | No | No |
| Auth | None | `TRADIER_TOKEN` |

`auditSeries()` runs automatically before anything else and refuses to proceed
on data that cannot support the engine — no volume, constant volume, duplicate
timestamps, or too few bars. It also detects a regular-hours instrument and
tells you to restrict `allowedSessions`, because otherwise the overnight
killzones silently discard nearly everything.

Only read-only `/v1/markets/*` endpoints are used. Nothing here touches an
account, a balance or an order.

### What the real data actually says

Run on live Yahoo NQ data, the system loses:

| Data | Trades | Win rate | Expectancy | Net |
|---|---|---|---|---|
| NQ 5m, 60 days | 21 | 29% | **−0.45R** | −$1,736 |
| NQ 1m, 7 days | 0–4 | — | — | — |

Losses are dominated by full stop-outs after roughly four bars. Three things
are worth separating before concluding the strategy does not work:

1. **The sample is far too small.** 21 trades proves nothing in either
   direction. Tuning against it would be curve-fitting, so nothing here has
   been tuned to improve that number.
2. **5-minute is the wrong timeframe for this system.** The original takes
   30-second and 1-minute entries with structural stops a few points wide. On
   5m bars the average stop is ~41 points and the entry precision is gone. It
   is a different strategy wearing the same name. But 1m from Yahoo gives 7
   days, which yields almost no trades — so the correct timeframe cannot be
   tested with this data at all.
3. **The orderflow gate — the system's core filter — is running on estimated
   delta.** The source material is explicit that the IFVG model in particular
   "tends to fail a lot" without real orderflow confirmation.

The honest conclusion is not "the strategy is bad", it is **"this data cannot
answer the question."** Answering it needs real 1-minute-or-finer CME futures
data with genuine per-trade aggressor side, over months rather than days.

---

## Forward collection

Yahoo's 7-day 1-minute window is too short to test anything — but the window
*moves*. `collect` pulls it and merges into a day-partitioned store, so a
1-minute history accumulates that no single request could return.

```bash
node src/cli.js collect --source yahoo --symbol NQ   # daily
node src/cli.js forward --symbol NQ                  # score what has resolved
```

Each run does two things:

1. **Merges bars.** One CSV per CME trading day, keyed on timestamp, idempotent.
   Running twice adds nothing; a provider revision updates a bar in place and
   never deletes one. Closed days are never rewritten, so git diffs stay small.

2. **Evaluates the newly closed bars exactly once** and journals whatever the
   system says to `data/<symbol>-forward.jsonl`, stamped with `engineVersion`.
   A watermark enforces the once-only rule. These are paper signals — no fill,
   no slippage, no P&L. The question is narrower and more useful than "did it
   make money": *when this system fires on data it has never seen, is it right?*

`forward` resolves records whose outcome is now knowable, using the same
pessimistic rule as the backtester — a bar that spans both stop and target
counts as the stop.

**The store must be committed.** The container is ephemeral; git is the only
place the history survives. `data/` is deliberately not ignored.

**Run it at least weekly.** Yahoo serves 7 days, so a longer gap between runs
loses bars permanently.

### Higher-timeframe context is collected separately

This is the part that makes forward collection work at all. Step 1 reads daily
and 4-hour structure, and a 7-day window of 1-minute bars aggregates to *six
daily candles with no swings* — the bias can never form, and the system sits
mute no matter how many 1-minute bars accumulate. Measured: 0 signals over
6,673 bars.

So `collect` also pulls hourly (60 days) and daily (2 years) streams into their
own stores, and `Market` accepts them directly via `opts.series` instead of
aggregating everything from the base. With real daily/4h structure injected, the
same six days of 1-minute data produced 4 signals.

```js
const market = new Market(oneMinuteBars, {
  instrument: INSTRUMENTS.NQ,
  series: { context: dailyBars, macro: fourHourBars, trend: hourlyBars },
})
```

### The discipline this depends on

A forward record is only evidence if the engine that produced it is not
afterwards tuned against the result. The watermark enforces evaluate-once;
nothing can enforce don't-tune. If you change the engine, bump `ENGINE_VERSION`
in `src/data/collector.js` — records from before the change belong to the old
engine and must not be pooled with new ones.

Expect roughly 2–3 months before the sample means anything. Around 30 resolved
signals is where the numbers stop being noise, and `forward` says so until you
get there.

### Overnight-capture forward validation (the paper bot)

The one hypothesis the sweep left standing — long from the 18:00 ET Globex
open to the next 09:30 ET RTH open, disaster stop, no target — gets the same
treatment as the signal engine, in `src/research/overnight.js`:

```bash
node src/cli.js overnight --symbol NQ   # after collect; journals completed nights
```

Each completed night is evaluated **exactly once** against the frozen spec
(registered 2026-08-10, before any of the judging data existed): no-stop,
50-pt-stop and 100-pt-stop variants at 1 MNQ with 1 pt round-trip cost,
appended to `data/NQ_F-overnight.jsonl`. The scorecard tracks each variant's
running mean against the backtest reference (+19.3 pt/night, sd 183) and walks
a simulated Lucid Flex 50K (trailing-EOD $2,000, $3,000 target) night by
night. Under ~30 nights the command says the sample is noise, because it is.

This is a **paper** bot: nothing in this repository places, routes or sizes a
real order. If the forward mean holds up after 30+ nights, that is the moment
an evaluation fee stops being a donation; if it collapses, the journal killed
the hypothesis for the cost of nothing.

### The execution bot (`bot/`)

For when — and only when — the paper gate passes. A Tradovate execution bot
implementing the identical spec: market buy 1 MNQ in the ten minutes after
18:00 ET, stop placed at fill − 100 the moment the fill is known, no target,
flatten at 09:29. It runs on your machine or a VPS, not in a cloud session:

```bash
export TRADOVATE_USER=… TRADOVATE_PASS=… TRADOVATE_CID=… TRADOVATE_SEC=… TRADOVATE_DEVICE_ID=…
node bot/run.js                    # demo environment, DRY RUN — logs, no orders
node bot/run.js --execute          # demo environment, real demo orders
node bot/run.js --live --armed --execute   # real account; all three flags required
```

Safety rails, all tested: one entry per night (crash-safe — state is written
before the order); never enters over an existing position or working order; if
the stop cannot be attached the position is closed immediately rather than
held unprotected; Friday/Saturday evenings and the dates in
`bot/holidays.json` are refused; a circuit breaker halts entries once realised
losses reach $1,000; touching `bot/KILL` flattens and stops the bot. Every
action appends to `bot/log.jsonl`.

Prerequisites that are questions for the firm, not for this code: written
confirmation that overnight holds and automated entry are allowed, and API
Access credentials (cid/sec) — retail Tradovate sells this as an add-on and
prop white-labels may not offer it. Run `--execute` against **demo** for the
whole paper-validation period first; going live is three explicit flags and
should stay that way.

---

## The system

### Step 1 — Context (`src/engine/context.js`)

Daily and 4h. What is the market doing, and what is it reaching for?

Price moves in trends and cycles: it runs the external liquidity resting beyond
a high or low, then retraces to internal liquidity — an imbalance, or the 50%
equilibrium of the range where supply and demand are at fair value — then
continues, until structure changes.

The step produces a **bias** and a **draw on liquidity** (the specific pool price
is travelling toward). If external liquidity was just swept *and reclaimed*, a
rotation is expected and the bias flips against the stale trend — a sweep that
holds instead of reversing is continuation, and the code distinguishes the two.
No read means no trade, and steps 2 and 3 never run.

### Step 2 — Confirmation (`src/engine/confirmation.js`)

15m and 1h — the secondary structure that forms inside the higher-timeframe
impulses and pullbacks.

A high being taken is not a reason to sell. The reason is the market then
showing weakness: a break of that secondary structure **with volume and
closure**. Volume confirms intent; a close beyond the level proves it was not a
wick. A change of character scores higher than plain continuation, and a break
that is already stale is penalised.

### Step 3 — Trigger + gate (`src/engine/trigger.js`, `src/engine/gate.js`)

1m / 30s. Three entry models, and nothing else:

| Model | What it is | Invalidation |
|---|---|---|
| **IFVG** | A fair value gap that price *closes* back through on volume, after liquidity was taken. The gap then acts as the opposite. | Far side of the zone |
| **CISD** | Change in state of delivery: trend → reaction at a level → manipulation → close back through the origin of the opposing candles. | Extreme of the manipulation leg |
| **Break & retest** | Continuation only. A displacement leg leaves a gap through a level, price returns, and closes back away from it. | Beyond the retest wick |

Each is a *trigger*, not a reason — the confirmation lives in steps 1 and 2. The
orderflow gate then decides whether the aggressive volume is actually on your
side right now: POC flip, POC migration, delta and CVD alignment, absorption of
the other side, and participation on the trigger bar. The gate is strict and
says no most of the time.

A structural stop that lands inside the noise floor is widened to 0.5× micro
ATR and flagged — the trade then risks more than the pattern implies, which is
information sizing and the journal both need.

### Grading (`src/engine/confluence.js`)

The four step scores plus stacked confluences produce **A+ / A / B / C**, which
scales position size — never whether the criteria were met. `withMeasuredExpectancy`
reweights a model using the expectancy actually recorded in your journal, and
ignores samples under 20 trades because below that the numbers are noise.

### Targets (`buildTargets` in `src/engine/system.js`)

Take profit *before* the obstacle, not at it. If a liquidity pool, the point of
control or an opposing level sits in front of the default 2R target, the target
moves in front of it. If that leaves less than the minimum reward:risk, there is
no trade — you don't sell into the point of control. If the draw on liquidity is
further out than 2R, the runner extends to it.

---

## Risk and prop firm rules (`src/risk/`)

The rule that kills funded accounts is the **trailing drawdown**, because it
follows unrealised equity. Being up $1,800 on an open position and giving it
back is not "flat" — it moved the floor up under you.

`PropAccount` models `trailing-unrealised`, `trailing-eod` and `static`
drawdown, floor locking at profit, daily loss limits, consecutive-loss and
trade-count caps, the flatten window before the cash close (which deliberately
does *not* swallow the 18:00 ET evening session), and the payout consistency
rule.

`sizePosition` takes the tightest of three ceilings — risk-per-trade rule,
remaining daily room, remaining drawdown room — and falls back to micros rather
than oversizing when a stop is too wide for a single mini.

`PositionManager` runs the exits in order: hard stop → targets → adverse close
(a close back through 50% of the stop distance cuts it) → orderflow
deterioration (POC flips against you, or sustained opposing delta) → breakeven
and trailing behind the POC → session flatten.

---

## Backtesting honestly (`src/backtest/backtest.js`)

- Signals generate on a bar's **close** and fill at that close plus slippage.
- Where a bar touches both the stop and a target, the **stop** is taken.
- Commission and slippage are charged on every side of every fill.
- Position size is computed from the **actual fill**, not the intended entry.
- Prop firm rules are enforced live: a breach ends the run, as it would an
  account.

**The no-lookahead guarantee is tested, not asserted.** `test/engine.test.js`
builds the market twice — once on the full series, once truncated at the bar
under test — and requires an identical decision. Higher-timeframe bars are
unreadable until they close, swing pivots until their confirmation bars print,
liquidity pools are unswept until they are swept, and level touch counts are
counted as-of the bar rather than over the level's lifetime.

---

## Layout

```
src/
  core/
    sessions.js     ET clock, sessions, killzones, macro windows, CME day boundary
    candles.js      model, multi-timeframe aggregation, ATR, volume baselines
    structure.js    swings, Dow labelling, BOS/CHoCH, apex (flipped) levels
    liquidity.js    pools, equal highs/lows, sweeps vs. reclaims, ERL/IRL cycle, premium/discount
    patterns.js     FVG, IFVG, BPR, displacement, CISD, break & retest
    orderflow.js    volume profile/POC, rolling POC + flips, VWAP, CVD, absorption, providers
  data/
    market.js       multi-timeframe model with as-of accessors
    csv.js          tolerant CSV ingestion + validation
    quality.js      data audit — refuses data that cannot support the engine
    store.js        day-partitioned candle store, idempotent merge
    collector.js    forward collection + evaluate-once paper journal
    synthetic.js    deterministic generator (testing only)
    providers/
      yahoo.js      futures OHLCV, no key required
      tradier.js    equities OHLCV + exchange VWAP, read-only endpoints
  engine/
    context.js confirmation.js trigger.js gate.js confluence.js system.js
  risk/
    propfirm.js sizing.js management.js
  journal/
    journal.js      append-only JSONL with the full setup snapshot
    stats.js        expectancy, profit factor, breakdowns, recommendations
  backtest/backtest.js
  report/html.js    single-file HTML report, no external assets
  cli.js
```

## Using it as a library

```js
import { Market, TradingSystem, PropAccount, sizePosition, INSTRUMENTS } from './propfirm/src/index.js'

const market  = new Market(oneMinuteCandles, { instrument: INSTRUMENTS.NQ })
const system  = new TradingSystem()
const account = new PropAccount({ preset: '50K' })

const { signal, rejected, steps } = system.evaluate(market, market.base.length - 1)
if (signal) {
  const sizing = sizePosition({ account, signal })
  console.log(signal.direction, signal.model, signal.grade, sizing.contracts, sizing.symbol)
} else {
  console.log('no trade:', rejected)
}
```

### Wiring a real orderflow feed

```js
import { FootprintOrderflow } from './propfirm/src/index.js'

// One entry per candle, with true aggressive volume from your feed.
const footprint = bars.map((b) => ({ buyVolume: b.askVolume, sellVolume: b.bidVolume }))
const market = new Market(candles, {
  instrument: INSTRUMENTS.NQ,
  orderflow: new FootprintOrderflow(candles, footprint),
})
```

Everything downstream is written against the provider interface, so the gate,
the grading and the reports pick up real delta with no other change.

## Journal-driven improvement

The grading is only meaningful if its weights come from measured results. Run
backtests and live trades into the same JSONL journal, then:

```bash
node src/cli.js stats --journal journal.jsonl
```

which reports expectancy by model, session and grade, and says plainly which to
keep, review and drop. Feed the stats object back into `new TradingSystem({ stats })`
to let measured expectancy reweight the grading.

---

## Measured: do the entry components predict anything?

The full system produces ~50 trades in two years — far too few to judge an
entry rule, and tuning against a sample that size is curve-fitting. So the
components were measured directly instead. Each fires thousands of times over
704,591 bars of real NQ, and each makes a falsifiable claim.

Forward move in ATR / hit rate / t-statistic at a 15-bar horizon, on
non-overlapping events, split in-sample (before 2026-01-01) / out-of-sample.
**Positive means the signal was right.**

| Component | in-sample | out-of-sample |
|---|---|---|
| *random baseline (long)* | *+0.052 / 52% / +1.7* | *−0.052 / 49% / −1.1* |
| CISD up | +0.052 / 50% / +1.2 | +0.014 / 51% / +0.2 |
| CISD down | −0.040 / 47% / −0.9 | −0.108 / 47% / −1.7 |
| IFVG bullish | +0.015 / 50% / +0.5 | +0.011 / 51% / +0.2 |
| IFVG bearish | −0.041 / 47% / −1.3 | −0.045 / 47% / −0.9 |

> **Correction.** An earlier revision of this table reported the IFVG model as
> spectacularly anti-predictive — up to t = −24. That number was a measurement
> bug, not a market fact: inverted-FVG events are emitted ordered by *gap
> formation*, not by inversion time, and the overlap-thinning in
> `measureForwardEdge` assumed sorted input. Unsorted events defeated the
> thinning, so clustered inversions inside one large move were counted dozens
> of times each. With events sorted (now done inside the function, with a
> regression test), the corrected picture is the table above: IFVG is mildly
> inverted at roughly cost scale, and nothing here clears |t| = 3.

Two things follow.

**Nothing predicts.** Every component sits within noise of the baseline in
both halves of the data. The mild IFVG inversion — fading a bearish IFVG earns
about +0.04 to +0.14 ATR — is the size of a round-trip cost and does not reach
significance.

**The killzone filter removes what little signal exists** rather than
concentrating it: CISD's t-statistic falls to roughly zero once restricted to
killzone hours.

### What that means for the entries

Removing components improves results monotonically and never rescues them
(24 months, real NQ, nothing tuned):

| Entry set | Trades | Win rate | Expectancy |
|---|---|---|---|
| All three models | 44 | 15.9% | −0.581R |
| IFVG removed | 60 | 31.7% | −0.433R |
| Break & retest only | 71 | 28.2% | −0.349R |
| CISD only | 63 | 38.1% | −0.323R |
| No killzone filter | 50 | 26.0% | −0.527R |

Every subtraction helps and none reaches profitability, which is the signature
of components carrying no edge: fewer bad signals simply means losing more
slowly. The entries cannot be fixed by recombining parts that do not predict.

---

## Measured: is there any edge to be had?

After the system itself tested negative, the question inverted: forget the
transcript — does *anything* measurable on this data clear costs? Six families
of hypotheses were swept under one discipline: selection on the in-sample half
only (before 2026-01-01), the out-of-sample half read once; every mean judged
against NQ's round-trip cost (~0.9 pt ≈ 0.12 ATR); |t| below 3 in-sample
treated as nothing, and a survivor required the same sign out-of-sample.

| Family | Variants | Result |
|---|---|---|
| Momentum / reversal (15–60 bar, ±1.5 ATR) | 6 | Weak reversal tilt, under cost, fails OOS |
| VWAP stretch reversion (±2, ±4 ATR) | 4 | Noise both halves |
| Opening-range break, gap fade, time-of-day | 10 + 46 buckets | ORB-up t = +2.8 IS flips negative OOS; nothing else |
| IFVG continuation *and* fade, by session/volume | 12 | Fade of bearish IFVG sign-consistent but cost-sized, t < 3 |
| Liquidity sweeps: continuation, ≥3-touch, failed-break fade | 14 | See below |
| Real orderflow (delta extremes, delta/price and CVD divergence, absorption) | 10 | Noise on 3 months of tape; CVD divergence flips sign between halves |
| 5m structure continuation (higher-low longs / lower-high shorts, stop at the last swing) | 9 | Entry has no edge (t ≤ 0.8); stops AT the swing level get hunted — 65–73% stop-outs vs 49% one swing wider — and no variant beats costs |
| Daily open with the trend (9:30 entry; 20d SMA / yesterday / 5d momentum filters) | 8 | Every filter underperforms always-long in-sample; "yesterday direction" flips sign between halves; always-long-at-open is drift (+4–5 pt/day, t ≈ 0) with ±200 pt daily swings |
| Daily classics (overnight premium, day-of-week, turn-of-month, RSI(2), SMA/Donchian, NR7 / inside day, last-hour momentum) | 21 | Only long-overnight expressions are sign-consistent: overnight hold +18.5 pt both halves (t 1.9/0.9), RSI(2)<10 next-day long, Monday long. All shorts lose everywhere. |
| Prop-tradable (intraday) legs of the above | 6 | The returns live overnight: RSI(2)'s intraday leg is +74 pt IS but **−89 pt OOS**; down-day reversion intraday flips sign too. Only Monday-intraday stays positive both halves (+33/+57 pt, t 1.5/1.3) — below threshold, one cell of dozens tested. |
| Globex-open overnight capture (enter 18:00 ET, exit next 9:30) | 4 legs + MC | The one candidate left standing. The 16:00→17:00 leg a flat-by-close rule blocks averages *negative*; the 18:00→9:30 leg holds the whole premium: +16.3 pt IS (t +2.0), +26.2 pt OOS (t +1.3). Monte Carlo through Lucid Flex 50K at 1 MNQ: 61% pass, then 61% to a first $900 payout — nominally +EV against the $150 fee, but t ≈ 2, long-only beta from a bull sample, iid bootstrap understates clustered-loss breach risk, and one sample night was −$1,890/micro. A hypothesis to forward-validate, not a proven edge. |
| Overnight capture: stop and target variants (bar-by-bar over 512 nights) | 18 | Targets always destroy the premium (+15.4 → +4.9 pt with a 100 pt cap — the right tail is the trade). A disaster stop barely touches the mean at any distance (50–300 pt) while amputating the −946 pt tail: at 50–100 pt the eval pass rate rises to 84%/70% and the worst night is bounded near one stop. Spec: enter 18:00, stop 50–100 pt, no target, exit next 9:30 open. |

The sweep family deserves its own paragraph because it produced the campaign's
best-looking number and then took it away. Sweeps of equal-highs pools showed
*continuation* — buying the sweep — at t = +3.8 in-sample **and** +3.2
out-of-sample. But the library's pools are clustered over the full series
before sweeps are marked, so which crossings become events is decided with
future knowledge. Re-deriving the events strictly causally — clusters built
only from swings already confirmed, swept pools retired in real time — the
edge collapses to noise, and a cost-aware simulation of every variant is flat
to negative in both halves. The classic "liquidity grab reversal" (sweep, then
reclaim within 3 bars, fade it) also fails: slightly *inverted* in-sample
(t = −2.4) and negative after costs everywhere.

Three artifacts were caught and killed in the process — the unsorted-event
thinning bug (t = −24 that was really t = −1.3), the future-informed pool
clustering, and an earlier lookahead in level ranking. That is the recurring
shape of this project: every number that looked like an edge has so far been a
bug in the measurement, and the honest result of a disciplined sweep over
~60 hypothesis variants on two years of real data is **none survived**.
