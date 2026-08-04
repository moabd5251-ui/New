"""Walk-forward backtest of the post-earnings drift strategy.

Historical announcement dates are not in the free feed, so earnings reactions are
DETECTED from price action: an outsized opening gap on elevated volume, deduplicated
to roughly quarterly spacing. That inference is the main source of error here — a
non-earnings shock on heavy volume will be counted as a reaction.

Every level is computed from bars up to and including the reaction day only. No
lookahead: the stop, target and swing structure a trade uses are exactly what would
have been visible at the moment of entry.
"""
import sys, json, time, math
import numpy as np
import pandas as pd

sys.path.insert(0, "/home/user/New/scripts")
import feed

UNIVERSE = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AVGO","JPM","V","UNH","XOM",
            "WMT","LLY","MA","COST","HD","NFLX","AMD","CRM","ORCL","ADBE","INTC","CSCO",
            "QCOM","TXN","PEP","KO","MCD","NKE","DIS","BA","CAT","GE","PFE","MRK","ABBV",
            "T","VZ","PYPL","SBUX","MU","SHOP","UBER","ABNB","COIN","SNOW","PANW","MRVL","DELL"]

MIN_GAP = 2.0          # matches the live screen
MIN_VOL_RATIO = 1.5    # reaction-day volume vs its trailing average
MIN_SPACING = 40       # trading days; earnings are ~63 apart, this prevents double-counting
MAX_HOLD = 15          # trading days
WARMUP = 260


def atr(df, i, p=14):
    s = df.iloc[max(0, i - p - 1):i + 1]
    tr = pd.concat([s["High"] - s["Low"],
                    (s["High"] - s["Close"].shift()).abs(),
                    (s["Low"] - s["Close"].shift()).abs()], axis=1).max(axis=1)
    v = tr.rolling(p).mean().iloc[-1]
    return float(v) if not np.isnan(v) else None


def swings(df, i, w=5, lb=250):
    """Confirmed swings using ONLY bars up to i — a swing needs w bars after it."""
    lo = max(0, i - lb)
    s = df.iloc[lo:i + 1]
    h, l = s["High"].values, s["Low"].values
    H, L = [], []
    for j in range(w, len(s) - w):
        if h[j] == max(h[j - w:j + w + 1]):
            H.append(float(h[j]))
        if l[j] == min(l[j - w:j + w + 1]):
            L.append(float(l[j]))
    return sorted(set(H), reverse=True), sorted(set(L), reverse=True)


def levels(df, i, spot, direction):
    a = atr(df, i)
    if not a:
        return None
    swh, swl = swings(df, i)
    if direction == "UP":
        below = [x for x in swl if x < spot]
        stop = (max(below) - 0.5 * a) if below else spot - 2 * a
        above = [x for x in swh if x > spot]
        target = min(above) if above else spot + 3 * a
    else:
        above = [x for x in swh if x > spot]
        stop = (min(above) + 0.5 * a) if above else spot + 2 * a
        below = [x for x in swl if x < spot]
        target = max(below) if below else spot - 3 * a
    return stop, target, a


def detect_reactions(df):
    """Outsized gaps on heavy volume, thinned to quarterly spacing."""
    o, c, v = df["Open"].values, df["Close"].values, df["Volume"].values
    events = []
    for i in range(WARMUP, len(df) - 1):
        pc = c[i - 1]
        if pc <= 0:
            continue
        gap = (o[i] - pc) / pc * 100
        if abs(gap) < MIN_GAP:
            continue
        win = v[max(0, i - 21):i]
        if not len(win) or np.isnan(win).all():
            continue
        avg = np.nanmean(win)
        if not avg or np.isnan(v[i]):
            continue
        vr = v[i] / avg
        if vr < MIN_VOL_RATIO:
            continue
        events.append(dict(idx=i, gap=gap, vol_ratio=vr, pre_close=float(pc)))

    # keep the largest gap in each cluster so one report is not counted twice
    events.sort(key=lambda e: -abs(e["gap"]))
    kept = []
    for e in events:
        if all(abs(e["idx"] - k["idx"]) >= MIN_SPACING for k in kept):
            kept.append(e)
    return sorted(kept, key=lambda e: e["idx"])


def simulate(df, ev, direction, max_hold=MAX_HOLD, apply_gap_fill=True):
    """Enter at the reaction close, exit on stop, target, gap fill, or timeout.

    apply_gap_fill belongs to the WITH-gap thesis only: price returning through the
    pre-report close means the surprise was rejected. For a counter-direction control
    that level sits on the other side of entry and is already breached at bar one, so
    applying it there measures nothing but the entry itself.
    """
    i = ev["idx"]
    entry = float(df["Close"].iloc[i])
    lv = levels(df, i, entry, direction)
    if not lv:
        return None
    stop, target, a = lv
    risk = abs(entry - stop)
    if risk <= 0:
        return None

    H, L, C = df["High"].values, df["Low"].values, df["Close"].values
    pre = ev["pre_close"]
    for k in range(i + 1, min(i + 1 + max_hold, len(df))):
        hi, lo = H[k], L[k]
        if direction == "UP":
            if lo <= stop:
                return dict(r=-1.0, bars=k - i, exit="stop")
            if hi >= target:
                return dict(r=round((target - entry) / risk, 3), bars=k - i, exit="target")
            if apply_gap_fill and lo <= pre:   # gap filled: thesis broken, exit at that level
                return dict(r=round((pre - entry) / risk, 3), bars=k - i, exit="gap_fill")
        else:
            if hi >= stop:
                return dict(r=-1.0, bars=k - i, exit="stop")
            if lo <= target:
                return dict(r=round((entry - target) / risk, 3), bars=k - i, exit="target")
            if apply_gap_fill and hi >= pre:
                return dict(r=round((entry - pre) / risk, 3), bars=k - i, exit="gap_fill")
    j = min(i + max_hold, len(df) - 1)
    px = float(C[j])
    r = (px - entry) / risk if direction == "UP" else (entry - px) / risk
    return dict(r=round(r, 3), bars=j - i, exit="timeout")


def run():
    trades = []
    for sym in UNIVERSE:
        try:
            df = feed.bars(sym, "1d", "2y")
            if len(df) < WARMUP + 40 or "Volume" not in df:
                continue
            evs = detect_reactions(df)
            for ev in evs:
                d = "UP" if ev["gap"] > 0 else "DOWN"
                with_gap = simulate(df, ev, d)
                against = simulate(df, ev, "DOWN" if d == "UP" else "UP",
                                   apply_gap_fill=False)
                if not with_gap:
                    continue
                trades.append(dict(symbol=sym, idx=ev["idx"],
                                   date=str(df.index[ev["idx"]])[:10],
                                   gap=round(ev["gap"], 2),
                                   vol_ratio=round(ev["vol_ratio"], 2),
                                   direction=d, **{f"w_{k}": v for k, v in with_gap.items()},
                                   **({f"a_{k}": v for k, v in against.items()} if against else {})))
            print(f"  {sym}: {len(evs)} reactions")
        except Exception as e:
            print(f"  {sym}: failed {str(e)[:50]}")
        time.sleep(0.25)
    return trades


if __name__ == "__main__":
    t = run()
    json.dump(t, open("/tmp/drift_bt.json", "w"), indent=2, default=str)
    print(f"\ntotal reactions simulated: {len(t)}")
