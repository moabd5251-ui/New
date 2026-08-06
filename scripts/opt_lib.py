"""Options primitives: chain access (via the provider layer) and Black-Scholes greeks.

Chain fetching is delegated to feed.py so the data vendor is swappable. Greeks are
computed here ONLY when the provider does not publish them — use greeks_for(), which
prefers exchange-published values and falls back to Black-Scholes.
"""
import math
import feed

UA = feed.UA


def session():
    """Back-compat shim: some callers still expect a (session, crumb) pair."""
    p = feed.provider()
    if hasattr(p, "_session"):
        return p._session()
    raise RuntimeError(f"provider {p.name!r} exposes no raw HTTP session")


def chain(symbol, expiry_ts=None):
    return feed.chain(symbol, expiry_ts)


# ---- Black-Scholes (fallback when the feed publishes no greeks) ----
def _nd(x):
    return math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)


def _NC(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def greeks(S, K, T, iv, kind="call", r=0.04, q=0.0):
    """T in years. delta, gamma, theta (per day), vega (per 1 vol point)."""
    if T <= 0 or iv <= 0 or S <= 0 or K <= 0:
        return dict(delta=0.0, gamma=0.0, theta=0.0, vega=0.0)
    sq = iv * math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + 0.5 * iv * iv) * T) / sq
    d2 = d1 - sq
    dq, dr = math.exp(-q * T), math.exp(-r * T)
    if kind == "call":
        delta = dq * _NC(d1)
        theta = (-S * dq * _nd(d1) * iv / (2 * math.sqrt(T))
                 - r * K * dr * _NC(d2) + q * S * dq * _NC(d1))
    else:
        delta = -dq * _NC(-d1)
        theta = (-S * dq * _nd(d1) * iv / (2 * math.sqrt(T))
                 + r * K * dr * _NC(-d2) - q * S * dq * _NC(-d1))
    return dict(delta=delta, gamma=dq * _nd(d1) / (S * sq), theta=theta / 365.0,
                vega=S * dq * _nd(d1) * math.sqrt(T) / 100.0)


def bs_price(S, K, T, iv, kind="call", r=0.04, q=0.0):
    """Black-Scholes value. At or past expiry this is intrinsic."""
    if T <= 0 or iv <= 0:
        return max(S - K, 0.0) if kind == "call" else max(K - S, 0.0)
    sq = iv * math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + 0.5 * iv * iv) * T) / sq
    d2 = d1 - sq
    dq, dr = math.exp(-q * T), math.exp(-r * T)
    if kind == "call":
        return S * dq * _NC(d1) - K * dr * _NC(d2)
    return K * dr * _NC(-d2) - S * dq * _NC(-d1)


def implied_vol(price, S, K, T, kind="call", r=0.04, q=0.0,
                lo=0.005, hi=6.0, tol=1e-5, max_iter=80):
    """Solve Black-Scholes for volatility. Returns None when no solution exists.

    Feeds that publish IV (Yahoo, Tradier) make this unnecessary. Raw market data
    feeds — Databento and any other exchange tape — carry prices only, so every
    volatility number in a historical study has to come from inverting the model
    on the recorded price.

    Returning None rather than a number is the point of the arbitrage-bound checks
    below: a price at or under intrinsic, or above the underlying, has no implied
    vol at all. Those quotes are common in thin option series and clamping them to
    a boundary value would seed a study with vols that were never traded.
    """
    if price is None or price <= 0 or S <= 0 or K <= 0 or T <= 0:
        return None
    dq, dr = math.exp(-q * T), math.exp(-r * T)
    intrinsic = max(S * dq - K * dr, 0.0) if kind == "call" else max(K * dr - S * dq, 0.0)
    ceiling = S * dq if kind == "call" else K * dr
    if price <= intrinsic + 1e-9 or price >= ceiling:
        return None
    # Bisection rather than Newton: vega vanishes on deep wings, where Newton diverges.
    f_lo = bs_price(S, K, T, lo, kind, r, q) - price
    f_hi = bs_price(S, K, T, hi, kind, r, q) - price
    if f_lo > 0 or f_hi < 0:
        return None
    for _ in range(max_iter):
        mid = 0.5 * (lo + hi)
        f = bs_price(S, K, T, mid, kind, r, q) - price
        if abs(f) < tol or (hi - lo) < tol:
            return mid
        if f < 0:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def greeks_for(contract, S, T, kind="call", r=0.04, q=0.0):
    """Exchange-published greeks when the feed supplies them, Black-Scholes otherwise.

    Returns the greeks dict with a 'source' key so downstream can tell which it got.
    """
    have = all(contract.get(k) is not None for k in ("delta", "gamma", "theta", "vega"))
    if have:
        return dict(delta=contract["delta"], gamma=contract["gamma"],
                    theta=contract["theta"], vega=contract["vega"], source="feed")
    g = greeks(S, contract["strike"], T, contract.get("impliedVolatility") or 0, kind, r, q)
    g["source"] = "black-scholes"
    return g


def screen_contracts(symbol, target_dte=(20, 60), kind="call",
                     min_oi=200, min_vol=10, max_spread_pct=0.15, delta_band=None):
    """Liquid contracts inside the DTE window, with greeks attached."""
    import time
    from datetime import datetime, timezone
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
        T = max(dte, 1) / 365.0
        for o in legs:
            bid, ask = o.get("bid") or 0, o.get("ask") or 0
            oi, vol = o.get("openInterest") or 0, o.get("volume") or 0
            if bid <= 0 or ask <= 0 or oi < min_oi or vol < min_vol:
                continue
            mid = (bid + ask) / 2
            spread_pct = (ask - bid) / mid if mid > 0 else 1
            if spread_pct > max_spread_pct:
                continue
            g = greeks_for(o, S, T, kind)
            if delta_band and not (delta_band[0] <= abs(g["delta"]) <= delta_band[1]):
                continue
            out.append(dict(symbol=symbol, contract=o["contractSymbol"], kind=kind,
                            strike=o["strike"], dte=dte, bid=bid, ask=ask, mid=round(mid, 2),
                            spread_pct=round(spread_pct * 100, 1), oi=oi, vol=vol,
                            iv=round((o.get("impliedVolatility") or 0) * 100, 1),
                            spot=round(S, 2), greek_source=g.pop("source"),
                            **{k: round(v, 4) for k, v in g.items()}))
        time.sleep(0.3)
    return out
