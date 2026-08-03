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

# Liquid, optionable, and broad enough that something is always reporting.
UNIVERSE = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AVGO","JPM","V","UNH","XOM",
            "WMT","LLY","MA","COST","HD","NFLX","AMD","CRM","ORCL","ADBE","INTC","CSCO",
            "QCOM","TXN","PEP","KO","MCD","NKE","DIS","BA","CAT","GE","PFE","MRK","ABBV",
            "T","VZ","PYPL","SBUX","MU","SHOP","UBER","ABNB","COIN","SNOW","PANW","MRVL","DELL"]


def earnings_info(sym):
    """Next earnings date, whether it's an estimate, and recent EPS surprise history."""
    s, cr = O.session()
    r = s.get(f"https://query1.finance.yahoo.com/v10/finance/quoteSummary/{sym}",
              params={"modules": "calendarEvents,earningsHistory", "crumb": cr}, timeout=20)
    r.raise_for_status()
    res = r.json()["quoteSummary"]["result"][0]
    cal = res.get("calendarEvents", {}).get("earnings", {})
    dates = cal.get("earningsDate") or []
    if not dates:
        return None
    ts = dates[0].get("raw")
    if not ts:
        return None
    when = datetime.fromtimestamp(ts, timezone.utc)
    days = (when - datetime.now(timezone.utc)).days
    hist = res.get("earningsHistory", {}).get("history", []) or []
    surprises = [h.get("surprisePercent", {}).get("raw") for h in hist]
    surprises = [x for x in surprises if x is not None]
    beats = sum(1 for x in surprises if x > 0)
    return dict(date=when.strftime("%Y-%m-%d"), days=days,
                estimated=bool(cal.get("isEarningsDateEstimate")),
                beat_rate=(round(beats/len(surprises)*100) if surprises else None),
                n_quarters=len(surprises),
                avg_surprise=(round(float(np.mean(surprises))*100, 1) if surprises else None))


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
