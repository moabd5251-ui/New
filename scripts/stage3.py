"""Stage 3 — build defined-risk vertical spreads for the screened names."""
import math, time, json
from datetime import datetime, timezone
import opt_lib as O

def _pick_expiry(base, lo=30, hi=60):
    now = datetime.now(timezone.utc); best = None
    for ts in base["expirationDates"]:
        dte = (datetime.fromtimestamp(ts, timezone.utc) - now).days
        if lo <= dte <= hi:
            if best is None or abs(dte-45) < abs(best[1]-45): best = (ts, dte)
    return best

def _liquid(o, min_oi, min_vol):
    b, a = o.get("bid") or 0, o.get("ask") or 0
    return b > 0 and a > 0 and (o.get("openInterest") or 0) >= min_oi and (o.get("volume") or 0) >= min_vol

def build_spread(symbol, bias, spread_type="DEBIT", dte_range=(30,60),
                 min_oi=100, min_vol=5, r=0.04):
    """Debit call spread for LONG, debit put spread for SHORT (credit inverts the legs)."""
    base = O.chain(symbol)
    S = base["quote"]["regularMarketPrice"]
    pick = _pick_expiry(base, *dte_range)
    if not pick: return None
    ts, dte = pick
    time.sleep(0.3)
    ch = O.chain(symbol, ts)
    kind = "call" if bias == "LONG" else "put"
    legs = ch["options"][0]["calls" if kind == "call" else "puts"]
    T = max(dte,1)/365.0

    enriched = []
    for o in legs:
        if not _liquid(o, min_oi, min_vol): continue
        iv = o.get("impliedVolatility") or 0
        if iv <= 0: continue
        g = O.greeks_for(o, S, T, kind, r=r)
        mid = ((o["bid"]+o["ask"])/2)
        enriched.append(dict(strike=o["strike"], mid=mid, bid=o["bid"], ask=o["ask"],
                             oi=o.get("openInterest") or 0, vol=o.get("volume") or 0,
                             iv=iv, delta=g["delta"], theta=g["theta"], vega=g["vega"],
                             contract=o["contractSymbol"]))
    if len(enriched) < 2: return None
    enriched.sort(key=lambda x: x["strike"])

    def nearest(target_abs_delta):
        return min(enriched, key=lambda x: abs(abs(x["delta"])-target_abs_delta))

    if spread_type == "DEBIT":
        long_leg, short_leg = nearest(0.55), nearest(0.30)
    else:                                     # CREDIT: sell nearer the money, buy further out
        short_leg, long_leg = nearest(0.30), nearest(0.15)
    if long_leg["strike"] == short_leg["strike"]: return None

    width = abs(short_leg["strike"] - long_leg["strike"])
    if spread_type == "DEBIT":
        net = long_leg["mid"] - short_leg["mid"]          # debit paid
        if net <= 0: return None
        max_loss, max_profit = net, width - net
        be = (long_leg["strike"] + net) if kind == "call" else (long_leg["strike"] - net)
    else:
        net = short_leg["mid"] - long_leg["mid"]          # credit received
        if net <= 0: return None
        max_profit, max_loss = net, width - net
        be = (short_leg["strike"] - net) if kind == "put" else (short_leg["strike"] + net)
    if max_profit <= 0 or max_loss <= 0: return None

    # Probability of finishing past breakeven (lognormal, using long-leg IV)
    iv = long_leg["iv"]
    d2 = (math.log(S/be) + (r - 0.5*iv*iv)*T)/(iv*math.sqrt(T)) if be > 0 and iv > 0 and T > 0 else 0
    pop = O._NC(d2) if kind == "call" else O._NC(-d2)

    net_delta = long_leg["delta"] - short_leg["delta"] if spread_type == "DEBIT" else long_leg["delta"] - short_leg["delta"]
    net_theta = long_leg["theta"] - short_leg["theta"] if spread_type == "DEBIT" else long_leg["theta"] - short_leg["theta"]
    net_vega  = long_leg["vega"]  - short_leg["vega"]  if spread_type == "DEBIT" else long_leg["vega"]  - short_leg["vega"]

    return dict(
        symbol=symbol, spot=round(S,2), bias=bias, structure=f"{spread_type} {kind.upper()} SPREAD",
        expiry=datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d"), dte=dte,
        long_strike=long_leg["strike"], short_strike=short_leg["strike"], width=round(width,2),
        long_contract=long_leg["contract"], short_contract=short_leg["contract"],
        net=round(net,2), max_profit=round(max_profit,2), max_loss=round(max_loss,2),
        rr=round(max_profit/max_loss,2), breakeven=round(be,2), pop=round(pop*100,1),
        net_delta=round(net_delta,3), net_theta=round(net_theta,3), net_vega=round(net_vega,3),
        long_iv=round(long_leg["iv"]*100,1), short_iv=round(short_leg["iv"]*100,1),
        long_oi=long_leg["oi"], short_oi=short_leg["oi"],
        cost_per_spread=round(net*100,2),
    )
