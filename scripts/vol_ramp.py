"""Pre-earnings volatility ramp: get long vol while it's cheap, exit BEFORE the report.

The trade: implied vol in the expiry containing earnings inflates as the announcement
approaches. You buy that vol 2-5 weeks out while the term structure is still flat, and
you close the position the day BEFORE the report. You never hold through the event, so
you take neither the IV crush nor the overnight gap.

What kills this trade is theta: you pay decay every day you wait. So the decision metric
is REQUIRED IV RISE — how many vol points implied has to climb just to cover the bleed
over the holding period — measured against how much it typically climbs.

Two structures, both defined-risk:
  CALENDAR  sell an expiry that lands before earnings, buy the one containing it.
            Long vega AND positive theta, because the near leg decays faster. The
            better trade when a suitable front expiry exists. Needs the stock to stay
            near the strike.
  STRADDLE  buy the ATM call and put in the earnings expiry. Pure long vega, direction
            agnostic, but pays full theta. Max loss is the debit.
"""
import math, time
from datetime import datetime, timezone, timedelta
import numpy as np
import opt_lib as O
import feed

# Entry window. Earlier than this and theta bleed dominates; later and the ramp is
# already priced into the front month.
ENTRY_MIN_DAYS = 12
ENTRY_MAX_DAYS = 40
# Above this term spread the ramp has already largely happened.
RAMP_STARTED_SPREAD = 6.0


def expiries_around(sym, earn_date):
    """(last expiry before earnings, first expiry on/after earnings) as (ts, dte) pairs."""
    base = O.chain(sym)
    spot = base["quote"]["regularMarketPrice"]
    ed = datetime.strptime(earn_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    before, after = None, None
    for ts in sorted(base["expirationDates"]):
        d = datetime.fromtimestamp(ts, timezone.utc)
        if d < ed:
            if d > now:
                before = (ts, (d - now).days)
        elif after is None:
            after = (ts, (d - now).days)
    return spot, before, after


def _atm_pair(ch, spot, T):
    """ATM call and put with greeks, from a normalised chain."""
    calls, puts = ch["options"][0]["calls"], ch["options"][0]["puts"]
    live = lambda legs: [o for o in legs
                         if (o.get("bid") or 0) > 0 and (o.get("ask") or 0) > 0
                         and (o.get("impliedVolatility") or 0) > 0]
    lc, lp = live(calls), live(puts)
    if not lc or not lp:
        return None, None
    strike = min(lc, key=lambda o: abs(o["strike"] - spot))["strike"]
    c = min(lc, key=lambda o: (abs(o["strike"] - strike), abs(o["strike"] - spot)))
    p = min(lp, key=lambda o: (abs(o["strike"] - c["strike"]), abs(o["strike"] - spot)))
    for o, kind in ((c, "call"), (p, "put")):
        g = O.greeks_for(o, spot, T, kind)
        o["_g"] = g
        o["_mid"] = (o["bid"] + o["ask"]) / 2
    return c, p


def build_straddle(sym, spot, after, hold_days):
    """Long ATM call + put in the earnings expiry. Pure long vega."""
    ts, dte = after
    ch = O.chain(sym, ts)
    T = max(dte, 1) / 365.0
    c, p = _atm_pair(ch, spot, T)
    if not c or not p:
        return None
    debit = c["_mid"] + p["_mid"]
    if debit <= 0:
        return None
    vega = c["_g"]["vega"] + p["_g"]["vega"]          # per 1 vol point, per share
    theta = c["_g"]["theta"] + p["_g"]["theta"]       # per day, per share (negative)
    if vega <= 0:
        return None
    bleed = abs(theta) * hold_days
    return dict(structure="LONG STRADDLE", strike=c["strike"],
                expiry=datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d"),
                dte=dte, debit=round(debit, 2), cost=round(debit * 100, 2),
                max_loss=round(debit * 100, 2),
                vega=round(vega, 4), theta=round(theta, 4),
                bleed=round(bleed * 100, 2),
                required_iv_rise=round(bleed / vega, 2),
                iv=round(((c.get("impliedVolatility") or 0) + (p.get("impliedVolatility") or 0)) / 2 * 100, 1),
                min_oi=min(c.get("openInterest") or 0, p.get("openInterest") or 0),
                stale=bool(c.get("stale") or p.get("stale")),
                legs=f"{c['strike']}C + {c['strike']}P")


def build_calendar(sym, spot, before, after, hold_days):
    """Sell the pre-earnings expiry, buy the earnings expiry, same strike.

    Long vega on the back leg, positive theta because the front decays faster.
    """
    if not before:
        return None
    fts, fdte = before
    bts, bdte = after
    if fdte <= 0:
        return None
    fch, bch = O.chain(sym, fts), O.chain(sym, bts)
    fc, fp = _atm_pair(fch, spot, max(fdte, 1) / 365.0)
    bc, bp = _atm_pair(bch, spot, max(bdte, 1) / 365.0)
    if not fc or not bc:
        return None
    # match strikes across expiries; fall back if the near chain lacks it
    strike = bc["strike"]
    fcands = [o for o in fch["options"][0]["calls"]
              if (o.get("bid") or 0) > 0 and (o.get("ask") or 0) > 0
              and (o.get("impliedVolatility") or 0) > 0]
    if not fcands:
        return None
    f = min(fcands, key=lambda o: abs(o["strike"] - strike))
    if abs(f["strike"] - strike) > spot * 0.02:
        return None
    fg = O.greeks_for(f, spot, max(fdte, 1) / 365.0, "call")
    fmid = (f["bid"] + f["ask"]) / 2

    debit = bc["_mid"] - fmid
    if debit <= 0:
        return None
    vega = bc["_g"]["vega"] - fg["vega"]              # net long vega
    theta = bc["_g"]["theta"] - fg["theta"]           # net theta, usually positive
    if vega <= 0:
        return None
    bleed = max(-theta, 0.0) * hold_days              # zero when theta works for you
    return dict(structure="CALENDAR", strike=strike,
                expiry=datetime.fromtimestamp(bts, timezone.utc).strftime("%Y-%m-%d"),
                front_expiry=datetime.fromtimestamp(fts, timezone.utc).strftime("%Y-%m-%d"),
                dte=bdte, front_dte=fdte,
                debit=round(debit, 2), cost=round(debit * 100, 2),
                max_loss=round(debit * 100, 2),
                vega=round(vega, 4), theta=round(theta, 4),
                bleed=round(bleed * 100, 2),
                required_iv_rise=round(bleed / vega, 2) if vega > 0 else None,
                iv=round((bc.get("impliedVolatility") or 0) * 100, 1),
                min_oi=min(bc.get("openInterest") or 0, f.get("openInterest") or 0),
                stale=bool(bc.get("stale") or f.get("stale")),
                legs=f"sell {f['strike']} {datetime.fromtimestamp(fts, timezone.utc):%d%b} / "
                     f"buy {strike} {datetime.fromtimestamp(bts, timezone.utc):%d%b}")


def estimate_ramp(rows):
    """How many vol points the front month typically gains, from this scan's own cross-section.

    Names far from earnings show the unramped term spread; names on the doorstep show the
    ramped one. The difference is the ramp. This substitutes for per-name historical IV,
    which the free feed does not carry — it is a market-wide estimate, not name-specific.
    """
    far = [r["iv_term_spread"] for r in rows
           if r.get("iv_term_spread") is not None and r["days"] >= 14]
    near = [r["iv_term_spread"] for r in rows
            if r.get("iv_term_spread") is not None and r["days"] <= 2]
    if len(far) < 2 or len(near) < 2:
        return None, None, None
    lo, hi = float(np.median(far)), float(np.median(near))
    return round(hi - lo, 1), round(lo, 1), round(hi, 1)


def exit_date(earn_date):
    """Close the day before the report; skip back over a weekend if that lands on one."""
    d = datetime.strptime(earn_date, "%Y-%m-%d").replace(tzinfo=timezone.utc) - timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def assess(rows, verbose=True):
    """Attach the ramp trade to every name, and judge whether it is worth taking."""
    ramp, base_spread, peak_spread = estimate_ramp(rows)
    out = []
    for r in rows:
        d = dict(r)
        d["ramp_estimate"] = ramp
        spread = r.get("iv_term_spread")
        days = r["days"]
        xd = exit_date(r["date"])
        hold = max((xd - datetime.now(timezone.utc)).days, 0)
        d["exit_date"] = xd.strftime("%Y-%m-%d")
        d["hold_days"] = hold

        if days < ENTRY_MIN_DAYS:
            d["window"] = "TOO LATE"
            d["window_note"] = ("Report is too close — the ramp is already in the price and "
                                "there is no room left to hold." if (spread or 0) > RAMP_STARTED_SPREAD
                                else "Report is too close to enter and still exit in time.")
        elif days > ENTRY_MAX_DAYS:
            d["window"] = "TOO EARLY"
            d["window_note"] = "Further out than the ramp reliably starts — theta would bleed for weeks first."
        elif spread is not None and spread > RAMP_STARTED_SPREAD:
            d["window"] = "RAMP STARTED"
            d["window_note"] = (f"Front month already carries a {spread} point premium — "
                                "much of the expansion is priced.")
        else:
            d["window"] = "ENTRY WINDOW"
            d["window_note"] = (f"Term structure still flat at {spread} points, {days} days out — "
                                "the expansion has not been priced yet.")

        if d["window"] == "ENTRY WINDOW" and hold > 0:
            try:
                spot, before, after = expiries_around(r["symbol"], r["date"])
                if after:
                    cal = build_calendar(r["symbol"], spot, before, after, hold)
                    time.sleep(0.3)
                    strad = build_straddle(r["symbol"], spot, after, hold)
                    # A calendar's risk is directional, not decay: it loses when the
                    # stock leaves the strike. Quantify that so a 0-vol-rise
                    # requirement is not mistaken for a free trade.
                    for st in (cal, strad):
                        if not st:
                            continue
                        iv = (st.get("iv") or 0) / 100.0
                        sd = spot * iv * math.sqrt(max(hold, 1) / 365.0)
                        st["expected_move"] = round(sd, 2)
                        st["expected_move_pct"] = round(sd / spot * 100, 1) if spot else None
                        st["spot"] = round(spot, 2)
                        if st["structure"] == "CALENDAR":
                            st["move_risk"] = (
                                f"Profits near {st['strike']}; a move beyond roughly "
                                f"±{round(sd,2)} ({round(sd/spot*100,1)}%) by {d['exit_date']} "
                                f"erodes it regardless of what vol does.")
                        else:
                            st["move_risk"] = "Direction agnostic — only vol and time matter."
                    d["calendar"], d["straddle"] = cal, strad
                    # prefer whichever needs the smaller vol rise to break even
                    best = min([s for s in (cal, strad) if s and s.get("required_iv_rise") is not None],
                               key=lambda s: s["required_iv_rise"], default=None)
                    d["best"] = best
                    if best and ramp:
                        need = best["required_iv_rise"]
                        d["margin"] = round(ramp - need, 1)
                        d["verdict"] = ("WORTH TAKING" if need <= ramp * 0.5
                                        else "MARGINAL" if need <= ramp else "NOT WORTH IT")
                    else:
                        d["verdict"] = "NO PRICING"
            except Exception as e:
                if verbose:
                    print(f"  [{r['symbol']}] ramp structures failed: {str(e)[:60]}")
                d["verdict"] = "NO PRICING"
        else:
            d["verdict"] = None
        out.append(d)
        time.sleep(0.3)

    rank = {"WORTH TAKING": 0, "MARGINAL": 1, "NOT WORTH IT": 2, "NO PRICING": 3, None: 4}
    out.sort(key=lambda x: (rank.get(x.get("verdict"), 9), x["days"]))
    return out, dict(ramp=ramp, base_spread=base_spread, peak_spread=peak_spread)
