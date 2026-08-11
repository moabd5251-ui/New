"""Earnings-event scanner: optionable names reporting within N days.

Core question this answers: is the options market pricing MORE or LESS movement
than this stock historically delivers on earnings day? That gap is the edge —
rich premium favours selling it (credit structures), cheap premium favours
buying it (debit structures). Both stay defined-risk.
"""
import math, time
import numpy as np
import pandas as pd
from datetime import datetime, timezone
import opt_lib as O
import portfolio as P
import feed

# Liquid, optionable, and broad enough that something is always reporting.
#
# The mega-cap block below reports in one tight cluster in the fortnight after each
# quarter ends. That left the pre-earnings scans nearly empty for weeks at a stretch —
# on 10 Aug only 13 of 50 names had a report inside 45 days, because the rest had just
# reported and their next one was two months out. The problem was the shape of the
# universe, not the market.
#
# The OFF-CYCLE block fixes that. Retailers report on a fiscal quarter ending in
# January, so they land in late August; enterprise software and several semis sit on
# the same shifted calendar. They fill precisely the weeks the mega-caps leave empty,
# every quarter, not just this one. Checked against the feed before adding: 49 of these
# had a confirmed report inside 45 days on the day they went in.
#
# Both the volatility-ramp and earnings-drift scans read this list, so it lengthens
# each run — the cost of a universe that is never empty.
MEGA_CAP = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AVGO","JPM","V","UNH","XOM",
            "WMT","LLY","MA","COST","HD","NFLX","AMD","CRM","ORCL","ADBE","INTC","CSCO",
            "QCOM","TXN","PEP","KO","MCD","NKE","DIS","BA","CAT","GE","PFE","MRK","ABBV",
            "T","VZ","PYPL","SBUX","MU","SHOP","UBER","ABNB","COIN","SNOW","PANW","MRVL","DELL"]

OFF_CYCLE = [
    # Retail and consumer — fiscal year ends in January, so reports land late August
    "TGT","LOW","TJX","ROST","BBY","DG","DLTR","ULTA","BURL","DKS","M","KSS","ANF",
    "WSM","LULU","CHWY","RH","KR","GIS",
    # Enterprise software and hardware on the same shifted calendar
    "CRWD","ZS","OKTA","WDAY","INTU","ADSK","DOCU","MDB","NTAP","HPQ","HPE","VEEV",
    "SMCI","TEAM",
    # Semis and equipment reporting August/September rather than July
    "AMAT","ADI","MCHP","ON",
    # China ADRs — heavily traded options, and a reporting calendar of their own
    "BABA","PDD","JD","NIO","LI",
    # Industrials and services with off-quarter fiscal years
    "DE","FDX","ACN","MDT",
]

# High-beta, heavily-optioned names that gap hard on reports. Their absence was found
# the expensive way: PLTR gapped +15.5% on 4.85x volume on 4 Aug and drifted a further
# +7.7%, which is the single best-performing profile in the drift backtest — gaps of 8%+
# on 3x+ volume — and the scan never looked at it, because the universe was built from
# index heavyweights and off-cycle reporters and PLTR is neither. A screen can only find
# what it is pointed at.
HIGH_BETA = ["PLTR", "ARM", "NOW", "ANET", "APP", "HOOD", "RBLX", "NET", "DDOG",
             "TTD", "SOFI", "MSTR", "VST", "ZM"]

UNIVERSE = MEGA_CAP + OFF_CYCLE + HIGH_BETA


def earnings_info(sym):
    """Next report date, whether it is an estimate, and recent EPS surprise history."""
    return feed.earnings(sym)


def historical_earnings_move(df, n=4):
    """Typical earnings-day move, INFERRED from the largest 1-day moves of the past year.

    Exact announcement dates aren't in the free feed, but for large caps the biggest
    single-day moves are overwhelmingly earnings reactions. Approximate, and labelled
    as such wherever it is shown.
    """
    c = df["Close"].tail(252)
    if len(c) < 60:
        return None, None
    moves = (c.pct_change().abs().dropna() * 100).sort_values(ascending=False)
    top = moves.head(n)
    return round(float(top.mean()), 2), round(float(top.max()), 2)


def _atm(legs, spot):
    live = [o for o in legs if (o.get("bid") or 0) > 0 and (o.get("ask") or 0) > 0]
    if not live:
        return None
    return min(live, key=lambda o: abs(o["strike"] - spot))


def implied_event_move(sym, earn_date):
    """ATM straddle in the first expiry AFTER earnings -> implied move %, plus IV term structure."""
    base = O.chain(sym)
    spot = base["quote"]["regularMarketPrice"]
    ed = datetime.strptime(earn_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)

    after, later = None, None
    for ts in base["expirationDates"]:
        d = datetime.fromtimestamp(ts, timezone.utc)
        if d >= ed and after is None:
            after = (ts, (d - datetime.now(timezone.utc)).days)
        elif after and d > datetime.fromtimestamp(after[0], timezone.utc) and later is None:
            later = (ts, (d - datetime.now(timezone.utc)).days)
    if not after:
        return None

    time.sleep(0.3)
    ch = O.chain(sym, after[0])
    calls, puts = ch["options"][0]["calls"], ch["options"][0]["puts"]
    c, p = _atm(calls, spot), _atm(puts, spot)
    if not c or not p:
        return None
    straddle = ((c["bid"] + c["ask"]) / 2) + ((p["bid"] + p["ask"]) / 2)
    implied_pct = straddle / spot * 100
    front_iv = ((c.get("impliedVolatility") or 0) + (p.get("impliedVolatility") or 0)) / 2 * 100

    back_iv = None
    if later:
        try:
            time.sleep(0.3)
            ch2 = O.chain(sym, later[0])
            c2, p2 = _atm(ch2["options"][0]["calls"], spot), _atm(ch2["options"][0]["puts"], spot)
            if c2 and p2:
                back_iv = ((c2.get("impliedVolatility") or 0) + (p2.get("impliedVolatility") or 0)) / 2 * 100
        except Exception:
            pass

    return dict(spot=round(spot, 2), expiry=datetime.fromtimestamp(after[0], timezone.utc).strftime("%Y-%m-%d"),
                expiry_ts=after[0], dte=after[1], straddle=round(straddle, 2),
                implied_move=round(implied_pct, 2), atm_strike=c["strike"],
                front_iv=round(front_iv, 1),
                back_iv=(round(back_iv, 1) if back_iv else None),
                iv_term_spread=(round(front_iv - back_iv, 1) if back_iv else None))


def verdict(implied, historical):
    """Is the event premium rich or cheap versus what this name actually does?"""
    if not implied or not historical:
        return "NO DATA", None, "Not enough history to compare."
    ratio = implied / historical
    if ratio >= 1.25:
        return ("PREMIUM RICH", round(ratio, 2),
                "Options price a bigger move than this name typically delivers — "
                "selling the event inside a defined-risk credit structure is the better side.")
    if ratio <= 0.85:
        return ("PREMIUM CHEAP", round(ratio, 2),
                "Options price a smaller move than this name typically delivers — "
                "buying the event with a defined-risk debit structure is the better side.")
    return ("FAIR", round(ratio, 2),
            "Implied and historical moves are close — no clear pricing edge on the event itself.")


def scan(universe=UNIVERSE, within_days=30, verbose=True):
    """Names reporting inside the window, with the pricing comparison for each."""
    hits = []
    for sym in universe:
        try:
            e = earnings_info(sym)
            if not e or e["days"] is None or not (0 <= e["days"] <= within_days):
                continue
            hits.append(dict(symbol=sym, **e))
            if verbose:
                print(f"  [{sym}] earnings {e['date']} in {e['days']}d"
                      + (" (estimated)" if e["estimated"] else " (confirmed)"))
        except Exception as ex:
            if verbose:
                print(f"  [{sym}] earnings lookup failed: {str(ex)[:50]}")
        time.sleep(0.25)

    out = []
    for h in hits:
        sym = h["symbol"]
        try:
            df = P.bars(sym)
            hist_move, hist_max = historical_earnings_move(df)
            im = implied_event_move(sym, h["date"])
            if not im:
                continue
            v, ratio, why = verdict(im["implied_move"], hist_move)
            c = df["Close"]
            trend = ("UP" if float(c.iloc[-1]) > float(c.rolling(50).mean().iloc[-1]) else "DOWN")
            out.append(dict(**h, **im, hist_move=hist_move, hist_max=hist_max,
                            verdict=v, premium_ratio=ratio, rationale=why, trend=trend,
                            rvol=round(float(c.pct_change().tail(20).std()*math.sqrt(252)*100), 1)))
        except Exception as ex:
            if verbose:
                print(f"  [{sym}] pricing failed: {str(ex)[:60]}")
        time.sleep(0.4)

    order = {"PREMIUM RICH": 0, "PREMIUM CHEAP": 1, "FAIR": 2, "NO DATA": 3}
    out.sort(key=lambda x: (order.get(x["verdict"], 9), x["days"]))
    return out
