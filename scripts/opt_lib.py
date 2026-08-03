"""Options pipeline: chain fetch (Yahoo, crumb-authed) + Black-Scholes greeks + liquidity screen."""
import requests, math, time
from datetime import datetime, timezone

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

_session = None
_crumb = None

def session():
    """Yahoo requires a cookie + crumb for the options endpoint (401 otherwise)."""
    global _session, _crumb
    if _session is None:
        s = requests.Session(); s.headers.update({"User-Agent": UA})
        s.get("https://fc.yahoo.com", timeout=15)
        _crumb = s.get("https://query1.finance.yahoo.com/v1/test/getcrumb", timeout=15).text
        _session = s
    return _session, _crumb

def chain(symbol, expiry_ts=None):
    s, cr = session()
    p = {"crumb": cr}
    if expiry_ts: p["date"] = expiry_ts
    r = s.get(f"https://query1.finance.yahoo.com/v7/finance/options/{symbol}", params=p, timeout=25)
    r.raise_for_status()
    return r.json()["optionChain"]["result"][0]

# ---- Black-Scholes greeks (Yahoo gives IV but no greeks) ----
def _nd(x):  # standard normal pdf
    return math.exp(-0.5*x*x)/math.sqrt(2*math.pi)
def _NC(x):  # standard normal cdf
    return 0.5*(1.0+math.erf(x/math.sqrt(2.0)))

def greeks(S, K, T, iv, kind="call", r=0.04, q=0.0):
    """T in years. Returns delta/gamma/theta(per day)/vega(per 1 vol pt)."""
    if T <= 0 or iv <= 0 or S <= 0 or K <= 0:
        return dict(delta=0.0, gamma=0.0, theta=0.0, vega=0.0)
    sq = iv*math.sqrt(T)
    d1 = (math.log(S/K) + (r - q + 0.5*iv*iv)*T)/sq
    d2 = d1 - sq
    disc_q, disc_r = math.exp(-q*T), math.exp(-r*T)
    if kind == "call":
        delta = disc_q*_NC(d1)
        theta = (-S*disc_q*_nd(d1)*iv/(2*math.sqrt(T)) - r*K*disc_r*_NC(d2) + q*S*disc_q*_NC(d1))
    else:
        delta = -disc_q*_NC(-d1)
        theta = (-S*disc_q*_nd(d1)*iv/(2*math.sqrt(T)) + r*K*disc_r*_NC(-d2) - q*S*disc_q*_NC(-d1))
    gamma = disc_q*_nd(d1)/(S*sq)
    vega  = S*disc_q*_nd(d1)*math.sqrt(T)
    return dict(delta=delta, gamma=gamma, theta=theta/365.0, vega=vega/100.0)

def screen_contracts(symbol, target_dte=(20, 60), kind="call",
                     min_oi=200, min_vol=10, max_spread_pct=0.15, delta_band=None):
    """Return liquid contracts in the DTE window, with computed greeks."""
    base = chain(symbol)
    S = base["quote"]["regularMarketPrice"]
    now = datetime.now(timezone.utc)
    out = []
    for ts in base["expirationDates"]:
        dte = (datetime.fromtimestamp(ts, timezone.utc) - now).days
        if not (target_dte[0] <= dte <= target_dte[1]):
            continue
        try:
            c = chain(symbol, ts)
        except Exception:
            continue
        legs = c["options"][0]["calls" if kind == "call" else "puts"]
        T = max(dte, 1)/365.0
        for o in legs:
            bid, ask = o.get("bid") or 0, o.get("ask") or 0
            oi, vol = o.get("openInterest") or 0, o.get("volume") or 0
            iv = o.get("impliedVolatility") or 0
            if bid <= 0 or ask <= 0 or oi < min_oi or vol < min_vol:
                continue
            mid = (bid+ask)/2
            spread_pct = (ask-bid)/mid if mid > 0 else 1
            if spread_pct > max_spread_pct:
                continue
            g = greeks(S, o["strike"], T, iv, kind)
            if delta_band and not (delta_band[0] <= abs(g["delta"]) <= delta_band[1]):
                continue
            out.append(dict(symbol=symbol, contract=o["contractSymbol"], kind=kind,
                            strike=o["strike"], dte=dte, bid=bid, ask=ask, mid=round(mid,2),
                            spread_pct=round(spread_pct*100,1), oi=oi, vol=vol,
                            iv=round(iv*100,1), spot=round(S,2), **{k: round(v,4) for k,v in g.items()}))
        time.sleep(0.3)
    return out
