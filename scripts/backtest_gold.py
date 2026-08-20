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
              "unconditional\n  mean, not with zero — these drift up, so beating "
              "zero is not the test.")

    cond = forward(close, starts) if starts else {h: [] for h in HORIZONS}
    uncond = {h: list((close.shift(-h) / close - 1).dropna() * 100) for h in HORIZONS}
    # starts must be filtered with the SAME rule forward() used for the 5-day
    # horizon, or zipping the two in pooled() pairs a date with another date's
    # return. cond[5] keeps episodes where i+5 is in range; so does this.
    n = len(close)
    starts_5 = [d for d in starts if close.index.get_loc(d) + 5 < n]
    assert len(starts_5) == len(cond[5]), "starts/cond misaligned"
    return dict(symbol=symbol, full=fs, subsets=sub, episodes=len(starts),
                starts=starts_5, cond=cond, uncond=uncond)


def welch(a, b):
    """t for mean(a) - mean(b), unequal variances. Returns (diff, t)."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    if len(a) < 2 or len(b) < 2:
        return float("nan"), float("nan")
    se = np.sqrt(a.var(ddof=1) / len(a) + b.var(ddof=1) / len(b))
    d = a.mean() - b.mean()
    return d, (d / se if se > 0 else float("nan"))


def pooled(out):
    """Deep-short episodes pooled across every market — the whole point of running
    the universe. Gold alone gave 23 episodes, which cannot settle anything."""
    print(f"\n{'='*74}\nPOOLED DEEP SHORT (exposure <= {DEEP:+.0%}) across "
          f"{len(out)} markets\n{'='*74}")
    tot = sum(o["episodes"] for o in out)
    print(f"{tot} distinct episodes\n")
    print(f"{'':6}{'cond mean':>11}{'uncond':>9}{'diff':>9}{'t':>7}{'down%':>8}{'n':>6}")
    for h in HORIZONS:
        c = [x for o in out for x in o["cond"][h]]
        u = [x for o in out for x in o["uncond"][h]]
        if len(c) < 2:
            continue
        d, t = welch(c, u)
        ca = np.array(c)
        print(f"+{h:<5}{ca.mean():+10.2f}%{np.mean(u):+8.2f}%{d:+8.2f}pp"
              f"{t:+7.2f}{(ca < 0).mean()*100:7.1f}%{len(c):6}")
    # ---- the correction that matters ----------------------------------------
    # The block above treats every episode as an independent observation, and they
    # are nothing of the sort: SPY, QQQ, IWM, DIA, EFA, EEM, EWJ, EWG and EWU are
    # nine views of one equity factor and go deeply short in the same week. Counting
    # each separately inflates n roughly threefold and shrinks the standard error by
    # sqrt(3), which is exactly how a null result is made to look significant.
    #
    # Collapsing episodes that begin within five days of each other into one macro
    # event, then testing the CLUSTER means, removes that. On this universe it takes
    # the +5d result from t = -2.50 to t = +0.13 and flips its sign — the pooled
    # effect was an artifact of double counting, not a signal.
    allep = sorted((d, o["symbol"]) for o in out for d in o.get("starts", []))
    clusters, cur = [], []
    for d, s in allep:
        if cur and (d - cur[-1][0]).days > 5:
            clusters.append(cur)
            cur = []
        cur.append((d, s))
    if cur:
        clusters.append(cur)

    by_sym = {o["symbol"]: dict(zip(o.get("starts", []), o["cond"][5])) for o in out}
    means = []
    for cl in clusters:
        v = [by_sym[s][d] for d, s in cl if d in by_sym.get(s, {})]
        if v:
            means.append(float(np.mean(v)))
    if len(means) > 2:
        m = np.array(means)
        t = m.mean() / (m.std(ddof=1) / np.sqrt(len(m)))
        print(f"\nCLUSTER-CORRECTED +5d — episodes within 5 days collapsed to one event")
        print(f"  {len(clusters)} independent events (from {tot} raw episodes)")
        print(f"  mean {m.mean():+.3f}%   t vs 0 = {t:+.2f}")
        print("  The naive block above is the SAME data with correlated markets counted"
              "\n  as independent. Where the two disagree, this line is the honest one.")


def main():
    args = [s.upper() for s in sys.argv[1:]]
    if not args:
        syms = ["GLD"]
    elif args[0] in ("--UNIVERSE", "-U"):
        syms = [m["symbol"] for m in T.UNIVERSE]
    else:
        syms = args
    out = []
    for s in syms:
        try:
            out.append(run(s))
        except Exception as e:                     # one bad feed must not kill the study
            print(f"\n[{s}] skipped: {str(e)[:70]}")
    if len(out) > 1:
        pooled(out)
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
