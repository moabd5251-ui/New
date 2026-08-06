"""Zero-DTE dealer positioning: where hedging flow pulls price into the close.

The premise, which is mechanical rather than predictive. Market makers who sell options
hedge the resulting delta in the underlying, and how they hedge depends on the sign of
their gamma:

  DEALERS LONG GAMMA   they sell into rallies and buy into dips to stay flat. That
                       damps realised volatility and pins price toward the strikes
                       carrying the most open interest.
  DEALERS SHORT GAMMA  the same hedging runs the other way — buying strength and
                       selling weakness — which amplifies moves instead of damping
                       them. Trend days and air pockets live here.

On zero-DTE that effect is at its most violent, because gamma explodes as time to
expiry goes to zero: a contract a dollar from the money at 3pm has enormous gamma and
none at all by 4:01. So the same open interest exerts far more force on the last day
than it ever did before.

WHAT IS MEASURED AND WHAT IS ASSUMED — the distinction matters more here than anywhere
else in this repo.

  Measured: strikes, open interest, volume, exchange-published gamma, and spot. All of
  it comes off the tape.

  Assumed: that dealers are long the calls and short the puts. Nobody publishes dealer
  inventory; it is inferred from the customer flow it implies. This is the standard
  convention and it is a genuine assumption, not an observation. When customers have
  been net sellers of calls, the sign flips and every conclusion below inverts.

So treat the gamma profile as a map of where hedging pressure CAN build, not as a
forecast. Max pain in particular is descriptive: it says where option buyers lose the
most, not where price is going, and the evidence for actual pinning is strongest only
in the final hours and only at strikes with genuinely large open interest.
"""
from datetime import datetime, timezone

import feed
import opt_lib as O

CONTRACT = 100          # shares per option contract


def _num(x, d=0.0):
    try:
        v = float(x)
        return v if v == v else d          # NaN guard
    except (TypeError, ValueError):
        return d


def zero_dte_expiry(symbol, chain=None):
    """(timestamp, date, dte) for today's expiry, or the nearest one if none lists today."""
    base = chain or O.chain(symbol)
    today = datetime.now(timezone.utc).date()
    best = None
    for ts in sorted(base["expirationDates"]):
        d = datetime.fromtimestamp(ts, timezone.utc).date()
        if d < today:
            continue
        if best is None:
            best = (ts, d)
        if d == today:
            return ts, d.strftime("%Y-%m-%d"), 0
    if best is None:
        return None, None, None
    return best[0], best[1].strftime("%Y-%m-%d"), (best[1] - today).days


def spot_from_parity(calls, puts, fallback=None):
    """Solve spot from call minus put across strikes, using the most liquid rows.

    A quote is one number that can be stale or crossed; parity is an arbitrage identity
    that has to hold across every strike simultaneously, so the median of many strikes
    is both a better estimate and a check that the chain is internally coherent. On the
    screenshot that motivated this, five strikes agreed to within a cent.
    """
    cs = {c["strike"]: c for c in calls if _num(c.get("bid")) > 0 and _num(c.get("ask")) > 0}
    ps = {p["strike"]: p for p in puts if _num(p.get("bid")) > 0 and _num(p.get("ask")) > 0}
    est = []
    for k in set(cs) & set(ps):
        c, p = cs[k], ps[k]
        cm = (_num(c["bid"]) + _num(c["ask"])) / 2
        pm = (_num(p["bid"]) + _num(p["ask"])) / 2
        liq = _num(c.get("openInterest")) + _num(p.get("openInterest"))
        est.append((liq, k + cm - pm))
    if not est:
        return fallback, 0
    est.sort(reverse=True)
    top = [v for _, v in est[:15]]
    top.sort()
    return top[len(top) // 2], len(est)


def max_pain(calls, puts):
    """The strike where option HOLDERS lose the most — total intrinsic value minimised.

    Descriptive, not a forecast. It marks where the most premium expires worthless,
    which is where writers would prefer settlement; whether price is actually drawn
    there is the contested part, and it is weakest when open interest is spread thin.
    """
    strikes = sorted({c["strike"] for c in calls} | {p["strike"] for p in puts})
    if not strikes:
        return None, []
    coi = {c["strike"]: _num(c.get("openInterest")) for c in calls}
    poi = {p["strike"]: _num(p.get("openInterest")) for p in puts}
    curve = []
    for settle in strikes:
        pain = sum(oi * max(settle - k, 0) for k, oi in coi.items())
        pain += sum(oi * max(k - settle, 0) for k, oi in poi.items())
        curve.append((settle, pain * CONTRACT))
    return min(curve, key=lambda x: x[1])[0], curve


def gex_profile(calls, puts, spot):
    """Gamma exposure per strike, in dollars of dealer hedging per 1% move.

    GEX = gamma x open interest x contract size x spot^2 x 0.01, calls positive and
    puts negative under the long-call/short-put dealer convention documented above.
    The units are what a 1% move in the underlying forces dealers to trade, so the
    number is directly comparable to real volume.
    """
    by_strike = {}
    for legs, sign in ((calls, +1), (puts, -1)):
        for o in legs:
            g = _num(o.get("gamma"))
            oi = _num(o.get("openInterest"))
            if g <= 0 or oi <= 0:
                continue
            k = o["strike"]
            gex = sign * g * oi * CONTRACT * spot * spot * 0.01
            d = by_strike.setdefault(k, dict(strike=k, call_gex=0.0, put_gex=0.0,
                                             call_oi=0.0, put_oi=0.0,
                                             call_vol=0.0, put_vol=0.0))
            if sign > 0:
                d["call_gex"] += gex
                d["call_oi"] += oi
                d["call_vol"] += _num(o.get("volume"))
            else:
                d["put_gex"] += gex
                d["put_oi"] += oi
                d["put_vol"] += _num(o.get("volume"))
    rows = sorted(by_strike.values(), key=lambda r: r["strike"])
    for r in rows:
        r["net_gex"] = r["call_gex"] + r["put_gex"]
    return rows


def zero_gamma(rows, spot):
    """The strike where cumulative gamma flips sign — the regime boundary.

    Above it dealer hedging damps moves, below it hedging amplifies them, so it is the
    single most useful level on the profile: the same news moves price differently on
    either side of it.
    """
    if not rows:
        return None
    total = sum(r["net_gex"] for r in rows)
    run = 0.0
    prev_k, prev_run = None, None
    for r in rows:
        run += r["net_gex"]
        if prev_run is not None and (prev_run < 0) != (run < 0):
            # linear interpolation between the two strikes that straddle the flip
            span = run - prev_run
            frac = -prev_run / span if span else 0.5
            return round(prev_k + frac * (r["strike"] - prev_k), 2)
        prev_k, prev_run = r["strike"], run
    return None if total == 0 else (rows[0]["strike"] if total < 0 else rows[-1]["strike"])


def walls(rows, spot, n=3, key="oi"):
    """Largest strikes above and below spot — the hedging anchors.

    key="oi" reads EXISTING positioning, carried in from prior sessions. key="vol"
    reads TODAY's flow, and the two answer different questions. Open interest says
    where dealers are already hedged; volume says where they are being forced to hedge
    right now. A strike heavy in both is where the pull is strongest, which is why the
    magnets() ranking below wants both rather than either.
    """
    ck, pk = ("call_" + key), ("put_" + key)
    above = sorted([r for r in rows if r["strike"] > spot], key=lambda r: -r[ck])[:n]
    below = sorted([r for r in rows if r["strike"] < spot], key=lambda r: -r[pk])[:n]
    return above, below


def magnets(rows, spot, n=5):
    """Strikes pulling price AWAY from where it already is, ranked.

    The naive version of this ranks by size and proximity, and it does not work: volume
    and gamma both peak at the money by construction, so the score simply rediscovers
    spot and calls it a target. Tested against a real chain it returned the at-the-money
    strike while the analyst reading the same board called a level seven points lower.

    What actually marks a magnet is interest that is LARGE FOR ITS DISTANCE. Activity
    decays away from the money, so this fits that decay from the chain itself and scores
    each strike on how far it punches above the decay curve. A strike with ordinary ATM
    volume scores nothing; one with heavy interest well out of the money scores highly,
    which is the thing worth knowing because it is somewhere price is not yet.

    Freshness still counts — volume far above resting open interest means positions
    opened today, which dealers are hedging now rather than inventory long since
    neutralised.
    """
    if not rows:
        return []
    pts = []
    for r in rows:
        oi = r["call_oi"] + r["put_oi"]
        vol = r["call_vol"] + r["put_vol"]
        if oi <= 0 and vol <= 0:
            continue
        pts.append((abs(r["strike"] - spot) / spot, oi, vol, r))
    if not pts:
        return []

    # Expected size at a given distance, from the chain's own decay. A coarse two-band
    # average is enough and avoids fitting a curve to twenty noisy points.
    near = [p for p in pts if p[0] <= 0.004]
    far = [p for p in pts if p[0] > 0.004]

    def avg(g, i):
        return (sum(x[i] for x in g) / len(g)) if g else 0.0

    exp_near_oi, exp_near_vol = avg(near, 1) or 1, avg(near, 2) or 1
    exp_far_oi, exp_far_vol = avg(far, 1) or 1, avg(far, 2) or 1

    out = []
    for dist, oi, vol, r in pts:
        e_oi = exp_near_oi if dist <= 0.004 else exp_far_oi
        e_vol = exp_near_vol if dist <= 0.004 else exp_far_vol
        excess = 0.45 * (oi / e_oi) + 0.55 * (vol / e_vol)
        # gamma is negligible far out, so a distant strike needs real size to matter
        score = excess * (1.0 / (1.0 + dist * 60))
        side = "put" if r["put_vol"] + r["put_oi"] > r["call_vol"] + r["call_oi"] else "call"
        out.append(dict(strike=r["strike"], score=round(score, 3),
                        oi=int(oi), vol=int(vol),
                        turnover=round(vol / oi, 2) if oi else None,
                        excess=round(excess, 2), side=side,
                        below_spot=r["strike"] < spot, net_gex=r["net_gex"],
                        distance_pct=round(dist * 100, 2)))
    out.sort(key=lambda x: -x["score"])
    return out[:n]


def flow_bias(rows, spot):
    """Which side today's flow is leaning on, and therefore which way hedging pushes.

    Puts bought below spot and calls bought above are both customer bets, but they
    force opposite dealer hedges: short puts make dealers sell the underlying as it
    falls, short calls make them buy as it rises. Comparing the two says which
    direction the hedging feedback currently runs.
    """
    put_below = sum(r["put_vol"] for r in rows if r["strike"] < spot)
    call_above = sum(r["call_vol"] for r in rows if r["strike"] > spot)
    put_above = sum(r["put_vol"] for r in rows if r["strike"] > spot)
    call_below = sum(r["call_vol"] for r in rows if r["strike"] < spot)
    downside = put_below + call_below
    upside = call_above + put_above
    total = downside + upside
    if not total:
        return dict(bias="NONE", ratio=None)
    ratio = downside / upside if upside else None
    bias = ("PUTS — downside flow dominates" if ratio and ratio > 1.15 else
            "CALLS — upside flow dominates" if ratio and ratio < 0.87 else
            "BALANCED")
    return dict(bias=bias, ratio=round(ratio, 2) if ratio else None,
                put_below=int(put_below), call_above=int(call_above),
                downside_vol=int(downside), upside_vol=int(upside))


def analyze(symbol="SPY", width_pct=0.03):
    """Full zero-DTE positioning read for one underlying."""
    base = O.chain(symbol)
    quote_spot = base["quote"]["regularMarketPrice"]
    ts, expiry, dte = zero_dte_expiry(symbol, base)
    if ts is None:
        return dict(symbol=symbol, error="no expiry available")

    ch = O.chain(symbol, ts)
    calls, puts = ch["options"][0]["calls"], ch["options"][0]["puts"]
    if not calls or not puts:
        return dict(symbol=symbol, expiry=expiry, error="empty chain")

    spot, n_parity = spot_from_parity(calls, puts, quote_spot)
    spot = spot or quote_spot

    # keep the band that actually carries gamma; far wings add noise and no hedging force
    lo, hi = spot * (1 - width_pct), spot * (1 + width_pct)
    calls = [c for c in calls if lo <= c["strike"] <= hi]
    puts = [p for p in puts if lo <= p["strike"] <= hi]

    rows = gex_profile(calls, puts, spot)
    total_gex = sum(r["net_gex"] for r in rows)
    flip = zero_gamma(rows, spot)
    mp, _curve = max_pain(calls, puts)
    up, down = walls(rows, spot, key="oi")
    vup, vdown = walls(rows, spot, key="vol")
    mag = magnets(rows, spot)
    flow = flow_bias(rows, spot)

    cv = sum(_num(c.get("volume")) for c in calls)
    pv = sum(_num(p.get("volume")) for p in puts)
    co = sum(_num(c.get("openInterest")) for c in calls)
    po = sum(_num(p.get("openInterest")) for p in puts)

    # ATM straddle is the market's own estimate of the remaining move to the close
    atm = min((c["strike"] for c in calls), key=lambda k: abs(k - spot), default=None)
    ac = next((c for c in calls if c["strike"] == atm), None)
    ap = next((p for p in puts if p["strike"] == atm), None)
    straddle = None
    if ac and ap:
        straddle = ((_num(ac["bid"]) + _num(ac["ask"])) / 2
                    + (_num(ap["bid"]) + _num(ap["ask"])) / 2)

    regime = "LONG GAMMA — hedging damps moves, price pins" if total_gex > 0 else \
             "SHORT GAMMA — hedging amplifies moves, trends extend"

    return dict(
        symbol=symbol, expiry=expiry, dte=dte, spot=round(spot, 2),
        quote_spot=round(_num(quote_spot), 2), parity_strikes=n_parity,
        total_gex=total_gex, regime=regime, zero_gamma=flip, max_pain=mp,
        call_volume=int(cv), put_volume=int(pv),
        call_oi=int(co), put_oi=int(po),
        pc_volume=round(pv / cv, 2) if cv else None,
        pc_oi=round(po / co, 2) if co else None,
        atm_strike=atm, straddle=round(straddle, 2) if straddle else None,
        expected_move_pct=round(straddle / spot * 100, 2) if straddle and spot else None,
        call_walls=[dict(strike=r["strike"], oi=int(r["call_oi"]),
                         vol=int(r["call_vol"]), gex=r["call_gex"]) for r in up],
        put_walls=[dict(strike=r["strike"], oi=int(r["put_oi"]),
                        vol=int(r["put_vol"]), gex=r["put_gex"]) for r in down],
        call_vol_walls=[dict(strike=r["strike"], vol=int(r["call_vol"]),
                             oi=int(r["call_oi"])) for r in vup],
        put_vol_walls=[dict(strike=r["strike"], vol=int(r["put_vol"]),
                            oi=int(r["put_oi"])) for r in vdown],
        magnets=mag, flow=flow,
        rows=rows,
        greek_source=("feed" if any(c.get("gamma") is not None for c in calls)
                      else "black-scholes"),
        generated=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))


def read(a):
    """Plain-language reading of the positioning, with the pull direction spelled out."""
    if a.get("error"):
        return [a["error"]]
    out = [a["regime"]]
    s, mp, fl = a["spot"], a.get("max_pain"), a.get("zero_gamma")
    if mp is not None:
        d = mp - s
        out.append(f"Max pain {mp} sits {abs(d):.2f} {'above' if d > 0 else 'below'} spot "
                   f"{s} — the strike where the most premium expires worthless.")
    if fl is not None:
        if s > fl:
            out.append(f"Spot is ABOVE the {fl} gamma flip, so dealers are damping moves. "
                       f"A break back under {fl} switches that to amplification.")
        else:
            out.append(f"Spot is BELOW the {fl} gamma flip — hedging is amplifying, and "
                       f"moves extend rather than fade until price reclaims {fl}.")
    pv = a.get("pc_volume")
    if pv:
        side = ("puts" if pv > 1.15 else "calls" if pv < 0.85 else "neither side")
        out.append(f"Put/call volume {pv} — {side} carrying today's flow.")
    if a.get("expected_move_pct"):
        out.append(f"The ATM straddle prices a {a['expected_move_pct']}% move still to "
                   f"come (±{a['straddle']:.2f}) by the close.")
    if a["call_walls"]:
        w = a["call_walls"][0]
        out.append(f"Heaviest call wall {w['strike']} ({w['oi']:,} OI) — resistance while "
                   f"dealers are long gamma there.")
    if a["put_walls"]:
        w = a["put_walls"][0]
        out.append(f"Heaviest put wall {w['strike']} ({w['oi']:,} OI) — support on the same logic.")
    return out


if __name__ == "__main__":
    import sys
    sym = sys.argv[1] if len(sys.argv) > 1 else "SPY"
    ok, state, msg = feed.require_open(f"{sym} zero-DTE positioning")
    if not ok:
        print(f"[guard] {msg}")
        sys.exit(0)
    a = analyze(sym)
    print(f"\n{a['symbol']} {a.get('expiry')} (DTE {a.get('dte')})  spot {a.get('spot')} "
          f"[parity across {a.get('parity_strikes')} strikes, quote {a.get('quote_spot')}]")
    print(f"greeks: {a.get('greek_source')}   net GEX ${a.get('total_gex', 0)/1e9:+.2f}bn per 1%\n")
    for line in read(a):
        print("  " + line)
