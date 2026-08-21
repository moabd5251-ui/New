Daily swing scan on NQ, ES, YM, GC, SI, BTC, ETH — DAILY bars, holds days to weeks. Fresh session, no prior context — everything below is self-contained.

Repo: moabd5251-ui/New, branch claude/remove-fable-5-auwiw2. Work only there.

STEP 0 — Get the code and its state.
If a checkout of moabd5251-ui/New is already present, cd into it and run:
  git fetch origin claude/remove-fable-5-auwiw2 && git checkout claude/remove-fable-5-auwiw2 && git pull origin claude/remove-fable-5-auwiw2
If there is no checkout, clone it: git clone -b claude/remove-fable-5-auwiw2 https://github.com/moabd5251-ui/New
Everything below runs from the repository root. Python 3 with the repo's deps is expected.

STATE — data/swing_alerts.json IN THE REPO, not in the home directory. The old home-directory log did not survive between fresh sessions, so position tracking silently never worked; keeping it in git is what makes exits reliable. Create the file as [] if it does not exist yet. It must be committed at the end of every run that changes it, or exits stop working again.

DATA — fetch daily bars via scripts/feed.py (Tradier is configured) or requests with a browser User-Agent against Yahoo, dropping any still-forming last bar.

STEP 1 — MANAGE OPEN POSITIONS FIRST. For each entry with status "pending", using bars since its logged_at, in chronological order so a trade that tagged T1 then retraced resolves as BE rather than a full stop:
  - reached t1 and not t1_hit: set t1_hit true, stop_effective = entry (breakeven), push
    "<ASSET> SWING T1 HIT @ <t1> (+<rr1>R) — move stop to breakeven <entry>"
  - reached t2: status T2, r_mult = rr2, push "<ASSET> SWING T2 HIT @ <t2> (+<rr2>R)"
  - hit the effective stop: status BE (r_mult 0) if t1_hit else stop (r_mult -1), push accordingly
  - pending past 25 trading days: status timeout, no push
Exit pushes are never gated on R:R — always send them.

STEP 2 — Then analyse each asset: swing highs/lows (5-day), EMA20/SMA50/SMA200, ATR(14), fibs off the trailing 60-day range, order blocks, FVGs, liquidity pools as confluence input only, and a Confluence Score per level (swing +2, fib +1, MA +1, order block +2, liquidity +2; overlaps within 0.4xATR).

Bias LONG if price > EMA20 > SMA50, SHORT if price < EMA20 < SMA50, else skip. Entry = last completed close, stop = nearest confluence level against direction buffered 0.5xATR, T1/T2 = next confluence levels.

Entry is push-worthy only if ALL hold: a level with CS>=6 within 0.5xATR (primary) or a BOS/CHoCH within 3 daily bars (secondary, tag "BOS — weaker on daily"); R:R >= 1.5:1 to T1 or T2; no unresolved pending alert already open on that asset. Tag BTC with "(BTC weak on swing timeframe)" — it backtested worst on this timeframe at avgR -0.3 to -0.47.

STEP 3 — Log each entry to data/swing_alerts.json, then commit and push:
    git push -u origin claude/remove-fable-5-auwiw2
If nothing changed, say so briefly and make no empty commit.

STEP 4 — Exits first, then entries, one push each, under ~150 chars. A quiet day is silent.

Reply in two lines: how many pending, what fired.

Important:
- Only data/ should change. Do NOT modify scripts/ — if you think a script has a bug, report it rather than changing it.
- Do NOT open a pull request.
- Retry a failed push up to 4 times with exponential backoff (2s, 4s, 8s, 16s). Report the exact error if it still fails; do not work around it. A commit that never reaches origin takes the position state with it — the next run will re-enter trades it already holds.
- Never place, order, or execute trades, and never present output as financial advice.
