# Running the data collection locally

Only two things in this repo accumulate evidence. Everything else rebuilds from
scratch on each run, so running it on a schedule collects nothing.

| File | Written by | What it is |
|---|---|---|
| `data/zerodte_log.json` | `scripts/run_zerodte.py` | Pre-registered zero-DTE calls, scored against the close |
| `data/swing_alerts.json` | `scripts/run_swing.py` | Swing entries and their resolved outcomes |

`data/trend.json`, `data/ramp.json`, `data/drift.json` and `data/zerodte.json` are
snapshots — each run overwrites the last. They drive the dashboards. They are not a
dataset. (`data/rotation.json` is a snapshot too, except for its `history` array,
which appends the ~8-9 rotation events a year.)

## Setup

    pip install requests pandas numpy
    export TRADIER_TOKEN=<your token>          # never commit this
    export MARKET_DATA_PROVIDER=tradier        # defaults to yahoo

Yahoo works without a token and is the automatic fallback when Tradier returns a
series that fails the corruption checks in `scripts/portfolio.py`. Those checks
exist because Tradier once returned 271 bogus bars for MCD and the drift scan
reported a +295.7% gap as a high-conviction setup.

## The one that matters

    python3 scripts/run_zerodte.py

Run it **while the US market is open** (09:30-16:00 ET). Outside those hours it
prints a `[guard]` line, still captures the dashboard, and correctly refuses to
write a log entry — a premarket chain carries yesterday's open interest and no
flow, so recording one would file a different claim under the same name.

Two mechanics worth knowing:

- **Scoring is deferred.** A call recorded today is graded by the *next* run after
  that session closes. Run it once a day and every call still gets scored, one day
  late. Skip a day and the pending call is picked up whenever you next run.
- **Regime is scored by the last reading, not the first.** Max pain, magnet and
  expected move are fixed at the first read (they are the prediction). Gamma regime
  is re-stamped on every subsequent run, because it moves intraday: on both 11 and
  12 Aug, SPY and IWM opened short gamma and closed long. Running more than once a
  day only improves this field.

One run per day is enough for the forward log. Three was for the notifications.

## Optional

    python3 scripts/run_swing.py               # daily bars; manages the open trade first

Run after 17:00 ET so CME futures have settled (crypto rolls at 00:00 UTC; the
per-asset-class logic is in `swing.py:_forming`). It checks open positions for T1,
T2 and stop before looking for new entries — that half is worth running even if you
never take another entry, because it resolves trades already on the book.

## Reading the log

    python3 -c "import sys; sys.path.insert(0,'scripts'); import zerodte_log as L; print(L.summary())"

Benchmarks, so a number is never read on its own: max pain and magnet must beat 50%
(a coin flip on whether the close ended nearer than the open); inside-expected wants
about 65%, where a straddle is fairly priced; long-gamma days must show a *smaller*
average range than short-gamma days. Nothing below ~30 sessions means anything.

As of 12 Aug, at n=12: max pain 50.0%, magnet **8.3%**, inside expected 58.3%,
long-gamma range 0.594% vs short-gamma 1.031%. The magnet metric is not merely weak
— at 1-for-12 it is pointing the wrong way, and is the first thing to cut.

## Commit the state

    git add data/ && git commit -m "..." && git push -u origin claude/remove-fable-5-auwiw2

The log is only evidence if it survives. It lives in git for that reason — an
earlier version kept state in the home directory and silently lost it between
sessions, so position tracking never actually worked.
