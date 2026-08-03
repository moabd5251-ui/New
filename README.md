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

## Usage

    python3 scripts/run_portfolio.py

Writes `dashboard.html`, updates `data/positions.json` marks, and prints a
`PUSH:` line per milestone event.

## Tracking a position

Add an entry to `data/positions.json` with `"status": "open"`, copying the
spread's fields from `data/latest.json` and adding `opened_at` and `qty`.
Milestone alerts fire at half of max profit, breakeven crossings, half of max
risk, and inside seven days to expiry.

## Caveats

Analysis only — nothing is executed, and none of it is financial advice.
Quotes are free-tier and delayed ~15 minutes; bid/ask goes stale outside market
hours. Greeks are approximations around dividends and early exercise.
