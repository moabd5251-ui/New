#!/usr/bin/env python3
"""Does panel SIZE change how a consensus trend book reads gold?

WHAT THIS CANNOT DO. It is not a backtest of TrendCompass. Five of their reports
exist here, all inside one eight-day window, and their strategies are opaque
labels (GC 05.1 LM, EBL 04.T). Reconstructing something and calling it theirs
would be inventing an opponent and then beating it. Their gold book is not
modelled anywhere below.

WHAT IT DOES TEST is the mechanism claimed when their -80% gold short was
compared with this repo's -10%: that a FIVE-strategy panel is structurally
jumpier than a TEN-strategy one, because each member is worth 20 points of
exposure instead of 10. That claim is about panel size, it is testable on this
engine's own strategies, and it is what the comparison actually rested on.

Choosing which five would be a cherry-pick, so every one of the C(10,5) = 252
subsets is run and the distribution reported.

The second question is the one the last week actually raised: when a book is
deeply short gold, what happens next? Measured as forward returns conditional
on the state, over distinct EPISODES rather than days, because a position held
for thirty days is one observation of the entry rule and not thirty.

Run:  python3 scripts/backtest_gold.py [SYMBOL ...]
"""
import sys
from itertools import combinations
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import feed
import trend as T

YEARS = "10y"
DEEP = -0.6          # "deeply short" — matches TrendCompass's -80%/-60% gold readings
HORIZONS = (5, 10, 20)


def book(sig, names):
    """Net exposure in [-1, 1] from a subset of the panel, one step per member."""
    return sig[list(names)].mean(axis=1)


def stats(exposure, ret):
    """Performance of holding `exposure` decided at t, earning ret at t+1."""
    r = (exposure.shift(1) * ret).dropna()
    if not len(r):
        return None
    n = len(r)
    growth = float((1 + r).prod())
    yrs = n / 252
    cagr = growth ** (1 / yrs) - 1 if growth > 0 else -1.0
    sd = float(r.std())
    sharpe = float(r.mean() / sd * np.sqrt(252)) if sd > 0 else 0.0
    curve = (1 + r).cumprod()
    dd = float((curve / curve.cummax() - 1).min())
    # jumpiness: how often the book changes exposure at all, and by how much
    d = exposure.diff().abs().dropna()
    return dict(cagr=cagr, sharpe=sharpe, maxdd=dd, years=yrs,
                changes_per_yr=float((d > 1e-9).sum() / yrs),
                turnover_per_yr=float(d.sum() / yrs))


def episodes(exposure, thresh=DEEP):
    """Start dates of each distinct entry into the deep-short state."""
    inside = exposure <= thresh
    return list(exposure.index[inside & ~inside.shift(1, fill_value=False)])


def forward(close, starts, horizons=HORIZONS):
    """Forward returns of the UNDERLYING from each episode start."""
    out = {}
    idx = close.index
    for h in horizons:
        vals = []
        for d in starts:
            i = idx.get_loc(d)
            if i + h < len(close):
                vals.append(float(close.iloc[i + h] / close.iloc[i] - 1) * 100)
        out[h] = vals
    return out


def run(symbol):
    df = feed.YahooProvider().bars(symbol, "1d", YEARS)
    df = df.dropna(subset=["Close"])
    sig = T.signal_frame(df)
    names = list(sig.columns)
    close = df["Close"]
    ret = close.pct_change()

    print(f"\n{'='*74}\n{symbol}   {df.index[0].date()} -> {df.index[-1].date()}   "
          f"{len(df)} bars, {len(names)} strategies\n{'='*74}")

    full = book(sig, names)
    fs = stats(full, ret)
    print(f"\nFULL PANEL ({len(names)} strategies, 10-point steps)")
    print(f"  CAGR {fs['cagr']*100:+6.2f}%   Sharpe {fs['sharpe']:5.2f}   "
          f"maxDD {fs['maxdd']*100:6.1f}%")
    print(f"  exposure changes {fs['changes_per_yr']:5.1f}/yr   "
          f"turnover {fs['turnover_per_yr']:5.2f}/yr")

    # ---- every 5-strategy subset, so nothing is chosen with hindsight --------
    rows = []
    for combo in combinations(names, 5):
        s = stats(book(sig, combo), ret)
        if s:
            rows.append(s)
    sub = pd.DataFrame(rows)
    print(f"\nALL {len(sub)} FIVE-STRATEGY SUBSETS (20-point steps)")
    for col, lab, mul in (("cagr", "CAGR %", 100), ("sharpe", "Sharpe", 1),
                          ("maxdd", "maxDD %", 100),
                          ("changes_per_yr", "changes/yr", 1),
                          ("turnover_per_yr", "turnover/yr", 1)):
        q = sub[col] * mul
        print(f"  {lab:12} median {q.median():7.2f}   "
              f"p10 {q.quantile(.10):7.2f}   p90 {q.quantile(.90):7.2f}"
              + (f"   full panel {fs[col]*mul:7.2f}" if col in fs else ""))

    beat = (sub["sharpe"] > fs["sharpe"]).mean() * 100
    jump = (sub["changes_per_yr"] > fs["changes_per_yr"]).mean() * 100
    print(f"\n  subsets beating the full panel on Sharpe:  {beat:5.1f}%")
    print(f"  subsets changing exposure MORE often:      {jump:5.1f}%")

    # ---- what follows a deep short ------------------------------------------
    starts = episodes(full)
    print(f"\nDEEP SHORT (exposure <= {DEEP:+.0%}), full panel: "
          f"{len(starts)} distinct episodes in {fs['years']:.1f} years")
    if starts:
        fwd = forward(close, starts)
        base = {h: float((close.shift(-h) / close - 1).dropna().mean() * 100)
                for h in HORIZONS}
        for h in HORIZONS:
            v = fwd[h]
            if not v:
                continue
            v = np.array(v)
            print(f"  +{h:2}d  mean {v.mean():+6.2f}%   median {np.median(v):+6.2f}%   "
                  f"down {(v < 0).mean()*100:4.1f}%   n={len(v)}   "
                  f"(unconditional mean {base[h]:+.2f}%)")
        print("  A short profits when these are NEGATIVE. Compare each with the "
              "unconditional\n  mean, not with zero — gold drifts up, so beating "
              "zero is not the test.")
    return dict(symbol=symbol, full=fs, subsets=sub, episodes=len(starts))


def main():
    syms = [s.upper() for s in sys.argv[1:]] or ["GLD"]
    out = [run(s) for s in syms]
    if len(out) > 1:
        print(f"\n{'='*74}\nSUMMARY — full panel vs median 5-subset\n{'='*74}")
        print(f"{'SYM':6}{'CAGR10':>9}{'CAGR5':>9}{'SH10':>7}{'SH5':>7}"
              f"{'CHG10':>8}{'CHG5':>8}")
        for o in out:
            f, s = o["full"], o["subsets"]
            print(f"{o['symbol']:6}{f['cagr']*100:+8.2f}%{s['cagr'].median()*100:+8.2f}%"
                  f"{f['sharpe']:7.2f}{s['sharpe'].median():7.2f}"
                  f"{f['changes_per_yr']:8.1f}{s['changes_per_yr'].median():8.1f}")


if __name__ == "__main__":
    main()
