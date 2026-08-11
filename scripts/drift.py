"""Post-earnings announcement drift: trade WITH the gap, after the report is out.

The premise, and it is the best-documented of the three strategies here: a stock that
gaps on an earnings surprise tends to keep travelling in that direction for days to
weeks rather than instantly repricing. The effect is strongest in the first week, decays
over a couple of months, and is stronger when the gap came on heavy volume.

THE TRAP this dashboard exists to route around: implied volatility collapses the moment
the report lands. Buy a call after a beat and the crush routinely eats more than the
direction earns — you are right about the stock and still lose. So every structure here
is deliberately LOW VEGA: shares, deep in-the-money options that behave like shares, or
debit verticals. Long at-the-money options, the obvious instrument, are the wrong one now.

What breaks the thesis: the gap filling. If price trades back through the pre-report
close, the market has rejected the surprise and there is nothing left to drift.
"""
import math, time
from datetime import datetime, timezone
import numpy as np
import pandas as pd
import opt_lib as O
import portfolio as P
import feed

# Thresholds recalibrated against a 151-reaction backtest over 2 years. Read the
# caveats in BACKTEST below before trusting any of this: the direction signal is
# real, the absolute edge is not statistically distinguishable from zero.
LOOKBACK_DAYS = 12          # drift decays fast; past this the edge is mostly gone
MIN_GAP_PCT = 2.0           # smaller gaps are noise, not a surprise

# What the backtest actually found (151 detected reactions, 50 names, 2 years):
#   with the gap      avgR +0.072, 61.6% win   <- not significant on its own (t=1.18)
#   against the gap   avgR -0.189, 45.0% win
#   the difference    +0.261R per trade        <- IS significant (t=2.22)
# So direction is a genuine signal; the strategy as built is not a proven edge.
# Worse, 99% of the total came from 5 of the 151 trades — median trade was +0.07R.
# By bucket: gaps 8%+ avgR +0.189 (best), 4-8% -0.016, 2-4% +0.042 (non-monotonic,
# so likely noise); volume was monotonic — 3x+ volume avgR +0.120 vs +0.032 under 2x;
# DOWN gaps (+0.157) beat UP gaps (+0.007). No single filter reached significance.
BACKTEST = dict(n=151, with_gap_avg_r=0.072, against_gap_avg_r=-0.189,
                spread_r=0.261, spread_t=2.22, with_gap_t=1.18,
                win_rate=61.6, top5_share_of_profit=99, median_r=0.07)
# The largest single-session earnings reaction in this universe's history is well under
# this. Anything beyond it is a data fault, not a surprise — an unadjusted split or a
# mismatched series — so the row is dropped rather than traded.
MAX_PLAUSIBLE_GAP = 60.0    # percent

TARGET_DELTA = 0.80         # deep ITM: moves like stock, minimal vega left to lose
STRUCT_DTE = (25, 70)


def find_reaction(df, report_date, window=3):
    """Locate the reaction bar near the report and measure it.

    Returns the gap (open vs prior close), the full-day move (close vs prior close —
    they differ when the gap is bought or sold into), and volume against its average.
    """
    if report_date is None or len(df) < 30:
        return None
    rd = datetime.strptime(report_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    idx = df.index
    near = [i for i in range(len(df)) if abs((idx[i] - rd).days) <= window and i > 0]
    if not near:
        return None

    best, best_gap = None, 0.0
    for i in near:
        prev_close = float(df["Close"].iloc[i - 1])
        if prev_close <= 0:
            continue
        gap = (float(df["Open"].iloc[i]) - prev_close) / prev_close * 100
        # A gap is measured against the PREVIOUS close, so that bar has to be a real
        # session. When it is not — a half day, a placeholder, or bars belonging to a
        # different security — the reference price is meaningless and the "gap" is an
        # artefact. Two independent sanity checks, because either alone lets something
        # through: a reference bar that barely traded relative to the reaction, and a
        # move no earnings reaction actually produces.
        pv = df["Volume"].iloc[i - 1]
        rv = df["Volume"].iloc[i]
        if pd.notna(pv) and pd.notna(rv) and rv > 0 and float(pv) < float(rv) * 0.02:
            continue
        if abs(gap) > MAX_PLAUSIBLE_GAP:
            continue
        if abs(gap) > abs(best_gap):
            best, best_gap = i, gap
    if best is None:
        return None

    prev_close = float(df["Close"].iloc[best - 1])
    react_close = float(df["Close"].iloc[best])
    vol = df["Volume"].iloc[max(0, best - 21):best]
    avg_vol = float(vol.mean()) if len(vol) and vol.notna().any() else None
    react_vol = float(df["Volume"].iloc[best]) if df["Volume"].notna().iloc[best] else None

    return dict(
        idx=best, date=str(idx[best])[:10],
        pre_close=round(prev_close, 2),
        gap_pct=round(best_gap, 2),
        day_move_pct=round((react_close - prev_close) / prev_close * 100, 2),
        react_close=round(react_close, 2),
        vol_ratio=(round(react_vol / avg_vol, 2) if react_vol and avg_vol else None),
        bars_since=len(df) - 1 - best)


def drift_state(df, react):
    """Has the move continued, stalled, or been rejected outright?"""
    i = react["idx"]
    now = float(df["Close"].iloc[-1])
    since = (now - react["react_close"]) / react["react_close"] * 100
    up = react["gap_pct"] > 0

    # gap fill: price trading back through the pre-report close kills the thesis
    after = df.iloc[i:]
    filled = bool((after["Low"] <= react["pre_close"]).any()) if up else \
             bool((after["High"] >= react["pre_close"]).any())

    aligned = (since > 0) if up else (since < 0)
    if filled:
        state, note = "GAP FILLED", ("Price traded back through the pre-report close — "
                                     "the market rejected the surprise, nothing left to drift.")
    elif aligned and abs(since) >= 1.0:
        state, note = "DRIFTING", (f"Continued {abs(since):.1f}% further {'up' if up else 'down'} "
                                   "since the reaction — the drift is underway.")
    elif not aligned and abs(since) >= 1.5:
        state, note = "STALLING", (f"Given back {abs(since):.1f}% against the gap without filling it — "
                                   "momentum is fading but the level still holds.")
    else:
        state, note = "HOLDING", ("Holding the reaction level without extending — "
                                  "consolidating rather than drifting.")
    return dict(direction="UP" if up else "DOWN", drift_since=round(since, 2),
                gap_filled=filled, state=state, state_note=note, spot=round(now, 2))


def _pick(legs, spot, T, kind, target_delta, min_oi=50):
    best, bd = None, 9
    for o in legs:
        if (o.get("bid") or 0) <= 0 or (o.get("ask") or 0) <= 0:
            continue
        if (o.get("openInterest") or 0) < min_oi:
            continue
        if (o.get("impliedVolatility") or 0) <= 0:
            continue
        g = O.greeks_for(o, spot, T, kind)
        d = abs(abs(g["delta"]) - target_delta)
        if d < bd:
            best, bd = dict(o, _g=g, _mid=(o["bid"] + o["ask"]) / 2), d
    return best


def build_structures(sym, spot, direction, stop, target):
    """Shares, deep-ITM option, and a debit vertical — all low vega by design."""
    base = O.chain(sym)
    now = datetime.now(timezone.utc)
    pick_ts = None
    for ts in sorted(base["expirationDates"]):
        dte = (datetime.fromtimestamp(ts, timezone.utc) - now).days
        if STRUCT_DTE[0] <= dte <= STRUCT_DTE[1]:
            pick_ts = (ts, dte)
            break
    if not pick_ts:
        return None
    ts, dte = pick_ts
    time.sleep(0.3)
    ch = O.chain(sym, ts)
    kind = "call" if direction == "UP" else "put"
    legs = ch["options"][0]["calls" if kind == "call" else "puts"]
    T = max(dte, 1) / 365.0

    out = {}
    risk_per_share = abs(spot - stop)

    # shares: the zero-vega baseline, and the honest comparison for everything else
    out["shares"] = dict(
        structure="SHARES", legs=f"{'long' if direction == 'UP' else 'short'} 100 shares",
        cost=round(spot * 100, 2), vega=0.0, delta=1.0 if direction == "UP" else -1.0,
        risk=round(risk_per_share * 100, 2),
        note="No volatility exposure at all — the cleanest way to own a drift.")

    deep = _pick(legs, spot, T, kind, TARGET_DELTA)
    if deep:
        cost = deep["_mid"]
        out["deep_itm"] = dict(
            structure=f"DEEP ITM {kind.upper()}", legs=f"{deep['strike']}{kind[0].upper()}",
            strike=deep["strike"], expiry=datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d"),
            dte=dte, cost=round(cost * 100, 2), max_loss=round(cost * 100, 2),
            delta=round(deep["_g"]["delta"], 3), vega=round(deep["_g"]["vega"], 4),
            theta=round(deep["_g"]["theta"], 4),
            iv=round((deep.get("impliedVolatility") or 0) * 100, 1),
            capital_vs_shares=round(cost / spot * 100, 1),
            min_oi=deep.get("openInterest") or 0, stale=bool(deep.get("stale")),
            note=(f"Behaves like {abs(round(deep['_g']['delta'],2))*100:.0f} shares for "
                  f"{round(cost/spot*100)}% of the capital, with little vega left to lose."))

    near = _pick(legs, spot, T, kind, 0.55)
    far = _pick(legs, spot, T, kind, 0.28)
    if near and far and near["strike"] != far["strike"]:
        net = near["_mid"] - far["_mid"]
        width = abs(far["strike"] - near["strike"])
        if net > 0 and width > net:
            be = near["strike"] + net if kind == "call" else near["strike"] - net
            out["vertical"] = dict(
                structure=f"DEBIT {kind.upper()} SPREAD",
                legs=f"{near['strike']} / {far['strike']}",
                expiry=datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d"), dte=dte,
                cost=round(net * 100, 2), max_loss=round(net * 100, 2),
                max_profit=round((width - net) * 100, 2),
                rr=round((width - net) / net, 2), breakeven=round(be, 2),
                delta=round(near["_g"]["delta"] - far["_g"]["delta"], 3),
                vega=round(near["_g"]["vega"] - far["_g"]["vega"], 4),
                theta=round(near["_g"]["theta"] - far["_g"]["theta"], 4),
                min_oi=min(near.get("openInterest") or 0, far.get("openInterest") or 0),
                stale=bool(near.get("stale") or far.get("stale")),
                note="Cheapest of the three, and its short leg cancels most of the remaining vega.")
    return out or None


def levels(df, spot, direction):
    """Stop behind the reaction structure, target at the next confluence level."""
    a = P.atr(df)
    swh, swl = P.swings(df)
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
    return round(stop, 2), round(target, 2), round(a, 2)


def scan(universe=None, verbose=True):
    """Names that reported recently, with their drift state and low-vega structures."""
    from earnings import UNIVERSE
    universe = universe or UNIVERSE
    out = []
    for sym in universe:
        try:
            e = feed.earnings(sym)
            if not e or not e.get("days_since_report"):
                continue
            since = e["days_since_report"]
            if not (0 <= since <= LOOKBACK_DAYS):
                continue
            df = P.bars(sym)
            react = find_reaction(df, e["last_report"])
            if not react or abs(react["gap_pct"]) < MIN_GAP_PCT:
                continue
            st = drift_state(df, react)
            stop, target, atr = levels(df, st["spot"], st["direction"])
            row = dict(symbol=sym, report_date=e["last_report"], days_since=since,
                       beat_rate=e.get("beat_rate"), avg_surprise=e.get("avg_surprise"),
                       atr=atr, stop=stop, target=target, **react, **st)
            row["rr"] = (round(abs(target - st["spot"]) / abs(st["spot"] - stop), 2)
                         if abs(st["spot"] - stop) > 0 else None)
            # Built from the same frame, so no extra fetch. A gap that is still
            # travelling into a swing high is a different trade from one with clear
            # air above it, and the drift measure alone cannot tell them apart.
            try:
                import chart as _C
                row["chart"] = _C.payload(sym, df)
            except Exception as _e:
                row["chart"] = dict(symbol=sym, error=str(_e)[:60])
            out.append(row)
            if verbose:
                print(f"  [{sym}] {react['gap_pct']:+.1f}% gap {react['date']}, "
                      f"{st['state']}, {since}d ago")
        except Exception as ex:
            if verbose:
                print(f"  [{sym}] drift scan failed: {str(ex)[:60]}")
        time.sleep(0.3)

    # Tiers follow the backtest buckets: big gaps on heavy volume were the only
    # combination that performed, and even that fell short of significance.
    for r in out:
        fresh = r["days_since"] <= 7
        vr = r.get("vol_ratio") or 0
        gap = abs(r["gap_pct"])
        r["tradeable"] = (not r["gap_filled"]) and r["state"] in ("DRIFTING", "HOLDING") and fresh
        if r["tradeable"] and gap >= 8 and vr >= 3:
            r["conviction"] = "HIGH"          # backtested avgR +0.143, n=36
        elif r["tradeable"] and gap >= 4 and vr >= 1.5:
            r["conviction"] = "MEDIUM"
        elif r["tradeable"]:
            r["conviction"] = "LOW"
        else:
            r["conviction"] = "NONE"
        # observed, unvalidated: downside surprises drifted more reliably
        r["down_gap_bonus"] = r["direction"] == "DOWN"

    order = {"HIGH": 0, "MEDIUM": 1, "LOW": 2, "NONE": 3}
    out.sort(key=lambda x: (order.get(x["conviction"], 9), x["days_since"]))
    return out


def attach_structures(rows, limit=8, verbose=True):
    built = 0
    for r in rows:
        if not r.get("tradeable") or built >= limit:
            continue
        try:
            s = build_structures(r["symbol"], r["spot"], r["direction"], r["stop"], r["target"])
            if s:
                r["structures"] = s
                built += 1
        except Exception as e:
            if verbose:
                print(f"  [{r['symbol']}] structures failed: {str(e)[:60]}")
        time.sleep(0.4)
    return rows
