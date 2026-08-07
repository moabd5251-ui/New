"""Daily-timeframe swing engine: confluence levels, structure, and setup construction.

Holds run days to weeks, so everything here works off COMPLETED daily bars. The last bar
Yahoo returns is almost always still forming — futures settle at 21:00 UTC and crypto
rolls at 00:00 UTC, so a bar stamped today has not finished. Reading its close as a
settled price is the same class of error that made the zero-DTE log score half-days as
whole ones, and on a daily timeframe it is worse: the "close" that sets an entry, a stop
and two targets would be an intraday snapshot that the session then trades away from.

Confluence scoring follows the routine's weights rather than the skill's defaults:

    swing high/low  +2      order block  +2
    fib level       +1      liquidity    +2
    moving average  +1

Levels within 0.4xATR of each other are the same level and are merged — without that a
cluster of five near-identical prints reads as five separate levels and the strongest
zone on the chart gets scored as if it were the weakest.
"""
import numpy as np
import pandas as pd

# Yahoo symbols. Tradier is the configured provider for equities but carries neither
# futures nor crypto, so these route to Yahoo explicitly rather than through provider().
SYMBOLS = {"NQ": "NQ=F", "ES": "ES=F", "YM": "YM=F", "GC": "GC=F", "SI": "SI=F",
           "BTC": "BTC-USD", "ETH": "ETH-USD"}

# Backtested worst on this timeframe (avgR -0.3 to -0.47). Still scanned, but every
# alert it produces has to carry the warning.
WEAK_ON_SWING = {"BTC": "(BTC weak on swing timeframe)"}

CS_MIN_PRIMARY = 6      # confluence needed for a primary entry
BOS_LOOKBACK = 3        # bars a break of structure stays valid as a secondary trigger
MIN_RR = 1.5            # to T1 or T2
TIMEOUT_BARS = 25       # trading days a pending alert may stay open


def bars(symbol, rng="1y"):
    """Completed daily bars for a routine asset.

    Drops a last bar stamped with today's UTC date. Futures settle at 21:00 UTC and
    crypto at 00:00 UTC, so any bar carrying today's date is still being written no
    matter which of the two it is.
    """
    import feed
    df = feed.YahooProvider().bars(SYMBOLS.get(symbol, symbol), "1d", rng)
    df = df.dropna(subset=["Open", "High", "Low", "Close"])
    today = pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%d")
    if len(df) and df.index[-1].strftime("%Y-%m-%d") >= today:
        df = df.iloc[:-1]
    return df


def atr(df, period=14):
    tr = pd.concat([df["High"] - df["Low"],
                    (df["High"] - df["Close"].shift()).abs(),
                    (df["Low"] - df["Close"].shift()).abs()], axis=1).max(axis=1)
    return float(tr.rolling(period).mean().iloc[-1])


def mas(df):
    c = df["Close"]
    return {"ema20": float(c.ewm(span=20).mean().iloc[-1]),
            "sma50": float(c.rolling(50).mean().iloc[-1]),
            "sma200": float(c.rolling(200).mean().iloc[-1]) if len(c) >= 200 else np.nan}


def swing_levels(df, window=5):
    """Confirmed 5-bar swing highs and lows.

    The loop stops `window` bars from the end on purpose: a high needs `window` bars on
    BOTH sides to be confirmed. Including the last few bars would let a level appear
    today and vanish tomorrow when the next bar prints higher — a moving target dressed
    up as structure.
    """
    h, l = df["High"].values, df["Low"].values
    highs, lows = [], []
    for i in range(window, len(df) - window):
        if h[i] == max(h[i - window:i + window + 1]):
            highs.append(float(h[i]))
        if l[i] == min(l[i - window:i + window + 1]):
            lows.append(float(l[i]))
    return sorted(set(highs), reverse=True), sorted(set(lows), reverse=True)


def fib_levels(lo, hi):
    d = hi - lo
    return {f"fib {r}": hi - d * r for r in (0.236, 0.382, 0.5, 0.618, 0.786)}


def order_blocks(df, disp_pct=0.003, lookback=60):
    """Last opposing candle before a displacement move."""
    o, h, l, c = (df[k].values for k in ("Open", "High", "Low", "Close"))
    out, seen = [], set()
    start = max(1, len(df) - lookback)
    for i in range(start, len(df)):
        rng = h[i] - l[i]
        if rng <= 0 or abs(c[i] - o[i]) / rng < 0.6:
            continue
        if abs(c[i] - c[i - 1]) / c[i - 1] < disp_pct:
            continue
        bull = c[i] > o[i]
        for j in range(i - 1, max(0, i - 6), -1):
            if (bull and c[j] < o[j]) or (not bull and c[j] > o[j]):
                if j in seen:
                    break
                seen.add(j)
                out.append(dict(kind="bull OB" if bull else "bear OB",
                                price=float((h[j] + l[j]) / 2),
                                high=float(h[j]), low=float(l[j])))
                break
    return out


def fvgs(df, lookback=60, min_gap_pct=0.001):
    """Unfilled three-bar imbalances."""
    h, l = df["High"].values, df["Low"].values
    out = []
    start = max(1, len(df) - lookback)
    for i in range(start, len(df) - 1):
        if l[i + 1] > h[i - 1] and (l[i + 1] - h[i - 1]) / h[i - 1] >= min_gap_pct:
            top, bot, kind = float(l[i + 1]), float(h[i - 1]), "bull FVG"
        elif h[i + 1] < l[i - 1] and (l[i - 1] - h[i + 1]) / l[i - 1] >= min_gap_pct:
            top, bot, kind = float(l[i - 1]), float(h[i + 1]), "bear FVG"
        else:
            continue
        later_l, later_h = l[i + 1:], h[i + 1:]
        filled = (any(x < bot for x in later_l) if kind == "bull FVG"
                  else any(x > top for x in later_h))
        if not filled:
            out.append(dict(kind=kind, price=(top + bot) / 2, top=top, bottom=bot))
    return out


def liquidity(df, window=3, tol_pct=0.002, lookback=90):
    """Equal highs and lows — resting stops."""
    d = df.tail(lookback)
    h, l = d["High"].values, d["Low"].values
    sh, sl = [], []
    for i in range(window, len(d) - window):
        if h[i] == max(h[i - window:i + window + 1]):
            sh.append(float(h[i]))
        if l[i] == min(l[i - window:i + window + 1]):
            sl.append(float(l[i]))
    out = []
    for pts, kind in ((sh, "BSL"), (sl, "SSL")):
        for i in range(len(pts)):
            for j in range(i + 1, len(pts)):
                if abs(pts[i] - pts[j]) / pts[i] <= tol_pct:
                    out.append(dict(kind=kind, price=(pts[i] + pts[j]) / 2))
    return out


def last_structure_break(df, window=5):
    """Most recent break of a confirmed swing, as (bars_ago, direction, level).

    A close beyond the last confirmed swing in the opposite direction is a CHoCH; beyond
    one in the same direction, a BOS. Both are treated as the same trigger here — on a
    daily chart the distinction needs a trend label that is itself an assumption, and
    the routine already discounts this path as the weaker one.
    """
    sh, sl = [], []
    h, l, c = df["High"].values, df["Low"].values, df["Close"].values
    for i in range(window, len(df) - window):
        if h[i] == max(h[i - window:i + window + 1]):
            sh.append((i, float(h[i])))
        if l[i] == min(l[i - window:i + window + 1]):
            sl.append((i, float(l[i])))
    best = None
    for i in range(len(df) - 1, max(0, len(df) - 40), -1):
        up = [p for idx, p in sh if idx < i - window]
        dn = [p for idx, p in sl if idx < i - window]
        if up and c[i] > max(up[-3:] or up):
            best = (len(df) - 1 - i, "up", max(up[-3:] or up))
            break
        if dn and c[i] < min(dn[-3:] or dn):
            best = (len(df) - 1 - i, "down", min(dn[-3:] or dn))
            break
    return best


def confluence(df):
    """Every candidate level with its Confluence Score, merged within 0.4xATR."""
    a = atr(df)
    tol = a * 0.4
    sh, sl = swing_levels(df)
    m = mas(df)
    lo60, hi60 = float(df["Low"].tail(60).min()), float(df["High"].tail(60).max())
    fibs = fib_levels(lo60, hi60)
    obs, liq = order_blocks(df), liquidity(df)

    # (price, points, label) — one row per piece of evidence, merged below.
    ev = ([(p, 2, "swing high") for p in sh] + [(p, 2, "swing low") for p in sl] +
          [(v, 1, k) for k, v in fibs.items()] +
          [(v, 1, k.upper()) for k, v in m.items() if not np.isnan(v)] +
          [(o["price"], 2, o["kind"]) for o in obs] +
          [(x["price"], 2, x["kind"]) for x in liq])
    ev.sort(key=lambda x: -x[1])            # strongest evidence anchors each cluster

    levels = []
    for price, pts, label in ev:
        for L in levels:
            if abs(price - L["price"]) < tol:
                # One category scores once per level. Three fibs stacking inside a
                # 0.4xATR window is one fib confluence, not three.
                if label not in L["labels"]:
                    L["cs"] += pts
                    L["labels"].append(label)
                break
        else:
            levels.append(dict(price=float(price), cs=pts, labels=[label]))
    return sorted(levels, key=lambda x: -x["price"]), a, m


def analyse(symbol, df=None):
    """Full read for one asset: bias, levels, and the setup that follows from them."""
    df = bars(symbol) if df is None else df
    if df is None or len(df) < 60:
        return dict(symbol=symbol, error="insufficient history")

    levels, a, m = confluence(df)
    price = float(df["Close"].iloc[-1])          # last COMPLETED close
    bar_date = df.index[-1].strftime("%Y-%m-%d")

    if price > m["ema20"] > m["sma50"]:
        bias = "LONG"
    elif price < m["ema20"] < m["sma50"]:
        bias = "SHORT"
    else:
        return dict(symbol=symbol, error="no trend alignment", bias=None,
                    price=price, atr=a, bar_date=bar_date)

    above = [L for L in levels if L["price"] > price + a * 0.15]
    below = [L for L in levels if L["price"] < price - a * 0.15]
    above.sort(key=lambda x: x["price"])         # nearest first
    below.sort(key=lambda x: -x["price"])

    if bias == "LONG":
        against, toward = below, above
        stop = (against[0]["price"] - a * 0.5) if against else price - a * 1.5
    else:
        against, toward = above, below
        stop = (against[0]["price"] + a * 0.5) if against else price + a * 1.5

    t1 = toward[0]["price"] if toward else None
    t2 = toward[1]["price"] if len(toward) > 1 else None
    risk = abs(price - stop)
    rr = lambda t: (abs(t - price) / risk if (t is not None and risk > 0) else 0.0)
    rr1, rr2 = rr(t1), rr(t2)

    near = [L for L in levels if abs(L["price"] - price) <= a * 0.5]
    primary = max((L["cs"] for L in near), default=0) >= CS_MIN_PRIMARY
    brk = last_structure_break(df)
    want = "up" if bias == "LONG" else "down"
    secondary = bool(brk and brk[0] <= BOS_LOOKBACK and brk[1] == want)

    return dict(
        symbol=symbol, bar_date=bar_date, price=price, atr=a, bias=bias,
        ema20=m["ema20"], sma50=m["sma50"], sma200=m["sma200"],
        entry=price, stop=stop, t1=t1, t2=t2,
        rr1=round(rr1, 2), rr2=round(rr2, 2),
        near_cs=max((L["cs"] for L in near), default=0),
        trigger=("primary" if primary else "BOS" if secondary else None),
        bos_bars_ago=(brk[0] if brk else None),
        levels=[dict(price=round(L["price"], 4), cs=L["cs"], labels=L["labels"])
                for L in levels[:14]],
        qualifies=bool((primary or secondary) and max(rr1, rr2) >= MIN_RR),
        warn=WEAK_ON_SWING.get(symbol))
