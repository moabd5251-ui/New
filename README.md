# Options Portfolio

Defined-risk vertical spread pipeline for liquid mega-caps and index ETFs.
Runs daily via a Claude routine; publishes a dashboard and pushes milestone alerts.

## Pipeline

1. **Regime** — SPY trend vs 20/50/200 DMA, IV regime from VIX percentile.
   Cheap vol favours debit spreads, rich vol favours credit spreads.
2. **Screen** — confluence scoring (swings, fibs, moving averages) across the
   universe. Indicators use completed daily bars; direction is judged against
   the live price so an intraday move can't leave a stale signal standing.
3. **Contracts** — live chains filtered on open interest, volume and bid/ask
   width; greeks computed via Black-Scholes from each contract's implied vol.
4. **Dashboard** — open positions marked to live chains, plus fresh candidates.

## Market data provider

All data access goes through `scripts/feed.py`. Nothing upstream talks to a vendor
directly, so switching feeds is a config change rather than a rewrite. Select with an
environment variable:

    MARKET_DATA_PROVIDER=yahoo     # default: free, ~15 min delayed, no published greeks
    MARKET_DATA_PROVIDER=tradier   # needs TRADIER_TOKEN: real-time, exchange greeks

Providers return identical normalised shapes, and every option contract carries
`delta`/`gamma`/`theta`/`vega` which are `None` when the vendor does not publish them.
`opt_lib.greeks_for()` uses exchange values when present and falls back to
Black-Scholes otherwise, tagging which it used — so upgrading the feed automatically
upgrades greek accuracy with no code change.

The Tradier provider is written against its documented API but has **not been run**
here (no token was available). Verify field names against a live response before
relying on it. Tradier does not serve an earnings calendar, so that call falls back
to Yahoo.

Set the API key as an environment variable in the environment settings — never commit it.

## Usage

    python3 scripts/run_portfolio.py    # regime, screen, spreads, position marks
    python3 scripts/run_earnings.py     # earnings-event premium scan

`run_portfolio.py` writes `dashboard.html`, updates `data/positions.json` marks, and
prints a `PUSH:` line per milestone event (half of max profit, breakeven crossing,
half of max risk, seven days to expiry).

`run_earnings.py` writes `earnings.html` and `data/earnings.json`, and prints a
`PUSH:` line for names reporting within 48 hours with actionable premium, or names
that crossed into rich/cheap since the previous run. Each alert fires once.

## Tracking a position

Add an entry to `data/positions.json` with `"status": "open"`, copying the
spread's fields from `data/latest.json` and adding `opened_at` and `qty`.
Milestone alerts fire at half of max profit, breakeven crossings, half of max
risk, and inside seven days to expiry.

## Caveats

Analysis only — nothing is executed, and none of it is financial advice.
Quotes are free-tier and delayed ~15 minutes; bid/ask goes stale outside market
hours. Greeks are approximations around dividends and early exercise.
