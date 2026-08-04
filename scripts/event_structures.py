"""Defined-risk structures for earnings events.

Rich premium -> iron condor (sell the event, profit if the move is smaller than priced).
Cheap premium -> debit vertical in the trend direction (buy the event with capped cost).
Both cap loss by construction; neither is ever naked.
"""
import math, time
from datetime import datetime, timezone
import opt_lib as O


def _mid(o):
    b, a = o.get("bid") or 0, o.get("ask") or 0
    return (b + a) / 2 if (b > 0 and a > 0) else 0


def _usable(o, min_oi, min_vol):
    return (o.get("bid") or 0) > 0 and (o.get("ask") or 0) > 0 and \
           ((o.get("openInterest") or 0) >= min_oi or (o.get("volume") or 0) >= min_vol)


def _enrich(legs, spot, T, kind, min_oi, min_vol):
    out = []
    for o in legs:
        if not _usable(o, min_oi, min_vol):
            continue
        iv = o.get("impliedVolatility") or 0
        if iv <= 0:
            continue
        g = O.greeks_for(o, spot, T, kind)
        out.append(dict(strike=o["strike"], mid=_mid(o), iv=iv, delta=g["delta"],
                        theta=g["theta"], vega=g["vega"],
                        oi=o.get("openInterest") or 0, vol=o.get("volume") or 0,
                        contract=o["contractSymbol"]))
    out.sort(key=lambda x: x["strike"])
    return out


def build_condor(sym, expiry_ts, spot, dte, min_oi=50, min_vol=5,
                 short_delta=0.20, long_delta=0.10):
    """Sell ~20-delta strangle, buy ~10-delta wings. Profits if the move stays inside."""
    ch = O.chain(sym, expiry_ts)
    T = max(dte, 1) / 365.0
    calls = _enrich(ch["options"][0]["calls"], spot, T, "call", min_oi, min_vol)
    puts = _enrich(ch["options"][0]["puts"], spot, T, "put", min_oi, min_vol)
    if len(calls) < 2 or len(puts) < 2:
        return None

    def pick(legs, target):
        return min(legs, key=lambda x: abs(abs(x["delta"]) - target))

    sc, lc = pick(calls, short_delta), pick(calls, long_delta)
    sp, lp = pick(puts, short_delta), pick(puts, long_delta)
    # wings must sit outside the shorts
    if not (lc["strike"] > sc["strike"] and lp["strike"] < sp["strike"]):
        return None
    if sp["strike"] >= sc["strike"]:
        return None

    credit = (sc["mid"] - lc["mid"]) + (sp["mid"] - lp["mid"])
    if credit <= 0:
        return None
    width = max(lc["strike"] - sc["strike"], sp["strike"] - lp["strike"])
    max_loss = width - credit
    if max_loss <= 0:
        return None
    be_lo, be_hi = sp["strike"] - credit, sc["strike"] + credit

    iv = (sc["iv"] + sp["iv"]) / 2
    sd = spot * iv * math.sqrt(T)
    pop = 0.0
    if sd > 0:
        z_hi = (math.log(be_hi / spot) + 0.5 * iv * iv * T) / (iv * math.sqrt(T))
        z_lo = (math.log(be_lo / spot) + 0.5 * iv * iv * T) / (iv * math.sqrt(T))
        pop = (O._NC(z_hi) - O._NC(z_lo))

    return dict(
        structure="IRON CONDOR", side="SELL EVENT",
        short_put=sp["strike"], long_put=lp["strike"],
        short_call=sc["strike"], long_call=lc["strike"],
        width=round(width, 2), net=round(credit, 2),
        max_profit=round(credit, 2), max_loss=round(max_loss, 2),
        rr=round(credit / max_loss, 2),
        be_low=round(be_lo, 2), be_high=round(be_hi, 2),
        pop=round(pop * 100, 1),
        net_delta=round((-sc["delta"] + lc["delta"] - sp["delta"] + lp["delta"]), 3),
        net_theta=round((-sc["theta"] + lc["theta"] - sp["theta"] + lp["theta"]), 3),
        net_vega=round((-sc["vega"] + lc["vega"] - sp["vega"] + lp["vega"]), 3),
        credit_per=round(credit * 100, 2), risk_per=round(max_loss * 100, 2),
        min_oi=min(sc["oi"], lc["oi"], sp["oi"], lp["oi"]),
    )


def build_debit_vertical(sym, expiry_ts, spot, dte, direction, min_oi=50, min_vol=5):
    """Buy ~55-delta, sell ~30-delta in the trend direction. Cost is the whole risk."""
    ch = O.chain(sym, expiry_ts)
    T = max(dte, 1) / 365.0
    kind = "call" if direction == "UP" else "put"
    legs = _enrich(ch["options"][0]["calls" if kind == "call" else "puts"],
                   spot, T, kind, min_oi, min_vol)
    if len(legs) < 2:
        return None

    def pick(t):
        return min(legs, key=lambda x: abs(abs(x["delta"]) - t))

    lo, sh = pick(0.55), pick(0.30)
    if lo["strike"] == sh["strike"]:
        return None
    debit = lo["mid"] - sh["mid"]
    if debit <= 0:
        return None
    width = abs(sh["strike"] - lo["strike"])
    max_profit = width - debit
    if max_profit <= 0:
        return None
    be = lo["strike"] + debit if kind == "call" else lo["strike"] - debit

    iv = lo["iv"]
    d2 = (math.log(spot / be) + (0.04 - 0.5 * iv * iv) * T) / (iv * math.sqrt(T)) if iv > 0 and T > 0 else 0
    pop = O._NC(d2) if kind == "call" else O._NC(-d2)

    return dict(
        structure=f"DEBIT {kind.upper()} SPREAD", side="BUY EVENT",
        long_strike=lo["strike"], short_strike=sh["strike"],
        width=round(width, 2), net=round(debit, 2),
        max_profit=round(max_profit, 2), max_loss=round(debit, 2),
        rr=round(max_profit / debit, 2), breakeven=round(be, 2),
        pop=round(pop * 100, 1),
        net_delta=round(lo["delta"] - sh["delta"], 3),
        net_theta=round(lo["theta"] - sh["theta"], 3),
        net_vega=round(lo["vega"] - sh["vega"], 3),
        cost_per=round(debit * 100, 2), risk_per=round(debit * 100, 2),
        min_oi=min(lo["oi"], sh["oi"]),
    )


def attach_structures(rows, verbose=True):
    """Give each scanned name the structure its pricing verdict calls for."""
    out = []
    for r in rows:
        s = None
        try:
            if r["verdict"] == "PREMIUM RICH":
                s = build_condor(r["symbol"], r["expiry_ts"], r["spot"], r["dte"])
            elif r["verdict"] == "PREMIUM CHEAP":
                s = build_debit_vertical(r["symbol"], r["expiry_ts"], r["spot"], r["dte"],
                                         r.get("trend", "UP"))
        except Exception as e:
            if verbose:
                print(f"  [{r['symbol']}] structure failed: {str(e)[:60]}")
        merged = dict(r)
        if s:
            merged.update(s)
            merged["has_structure"] = True
        else:
            merged["has_structure"] = False
        out.append(merged)
        time.sleep(0.4)
    return out
