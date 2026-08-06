"""Cheap asymmetric plays on names reporting too soon for the volatility ramp.

When a name reports inside a day or two, the ramp trade is gone — the expansion is
already paid for and there is no time to hold and exit beforehand. What is left is a
different bet entirely: hold THROUGH the report and win only if the move is bigger
than the market has priced.

Be clear about what this is. Options priced at fair value have roughly zero expected
value before costs, and these are bought beyond the expected move, so most expire
worthless. The point is not edge, it is payoff shape: small fixed cost, occasional
large multiple. Size accordingly.

The number that matters is REQUIRED MOVE versus TYPICAL MOVE — how far the stock has
to travel to clear breakeven, against how far it usually travels on earnings day. Under
1.0 means the stock routinely moves far enough. Well above it means you need an outlier.

  STRANGLE   OTM call and OTM put around the expected-move boundary. Direction
             agnostic, pays on a large move either way, costs the most of the three.
  DIRECTIONAL A single OTM call or put in the trend direction. Half the cost, but
             a big move the wrong way pays nothing.
  SPREAD     OTM debit spread. Cheapest, and the only one with capped upside —
             included when the naked legs are too expensive to be a lotto.
"""
import math, time
from datetime import datetime, timezone
import opt_lib as O

# Strike placement as a multiple of the market's implied move. 1.0 sits right at the
# expected-move boundary — the market's own "probably won't get past here" line.
STRIKE_AT_IMPLIED = 1.0
# A lotto has to actually be cheap. Above this share of spot it is not a lottery ticket.
MAX_COST_PCT_OF_SPOT = 0.015
MIN_OI = 25


def _otm(legs, spot, target, kind):
    """Liquid contract closest to a target strike, on the correct side of spot."""
    cands = [o for o in legs
             if (o.get("bid") or 0) > 0 and (o.get("ask") or 0) > 0
             and (o.get("openInterest") or 0) >= MIN_OI
             and (o["strike"] > spot if kind == "call" else o["strike"] < spot)]
    if not cands:
        return None
    return min(cands, key=lambda o: abs(o["strike"] - target))


def _mid(o):
    return (o["bid"] + o["ask"]) / 2


def payoff_multiple(value_at_move, cost):
    """Gross multiple of outlay. 0 means total loss, 3 means the ticket triples."""
    if cost <= 0:
        return None
    return round(value_at_move / cost, 2)


# Below this, implied vol is not a real quote — outside market hours Yahoo
# recomputes it from stale last trades and returns single-digit nonsense.
MIN_USABLE_IV = 0.05


def _prob_beyond(spot, level, iv, T, above=True):
    """Rough lognormal chance of finishing past a level. Assumes no drift.

    Returns None when implied vol is unusable, so callers show "unknown" rather
    than a confident 0% that is really just a corrupted input.
    """
    if iv < MIN_USABLE_IV or T <= 0 or level <= 0 or spot <= 0:
        return None
    d2 = (math.log(spot / level) - 0.5 * iv * iv * T) / (iv * math.sqrt(T))
    return O._NC(d2) if above else O._NC(-d2)


def _spread_value_at(price, near_strike, width, is_call):
    """Value of an OTM debit spread at expiry, capped at the width."""
    intrinsic = (price - near_strike) if is_call else (near_strike - price)
    return min(max(intrinsic, 0.0), width)


def build_lotto(sym, spot, expiry_ts, dte, implied_move_pct, hist_move_pct,
                hist_max_pct, trend="UP"):
    """Strangle, directional single leg, and OTM spread — with what each needs to pay."""
    ch = O.chain(sym, expiry_ts)
    calls, puts = ch["options"][0]["calls"], ch["options"][0]["puts"]
    if not calls or not puts:
        return None
    T = max(dte, 1) / 365.0
    im = (implied_move_pct or 0) / 100.0
    if im <= 0:
        return None

    up_target = spot * (1 + im * STRIKE_AT_IMPLIED)
    dn_target = spot * (1 - im * STRIKE_AT_IMPLIED)
    c, p = _otm(calls, spot, up_target, "call"), _otm(puts, spot, dn_target, "put")
    if not c or not p:
        return None

    hist = (hist_move_pct or 0) / 100.0
    hmax = (hist_max_pct or 0) / 100.0
    up_typ, dn_typ = spot * (1 + hist), spot * (1 - hist)
    up_max, dn_max = spot * (1 + hmax), spot * (1 - hmax)

    out = {}

    # ---- strangle: both wings -------------------------------------------
    cost = _mid(c) + _mid(p)
    if cost > 0:
        be_hi, be_lo = c["strike"] + cost, p["strike"] - cost
        req = min(abs(be_hi - spot), abs(spot - be_lo)) / spot * 100
        val_typ = max(max(up_typ - c["strike"], 0) + max(p["strike"] - up_typ, 0),
                      max(dn_typ - c["strike"], 0) + max(p["strike"] - dn_typ, 0))
        val_max = max(max(up_max - c["strike"], 0) + max(p["strike"] - up_max, 0),
                      max(dn_max - c["strike"], 0) + max(p["strike"] - dn_max, 0))
        pu = _prob_beyond(spot, be_hi, c.get("impliedVolatility") or 0, T, True)
        pd_ = _prob_beyond(spot, be_lo, p.get("impliedVolatility") or 0, T, False)
        prob = round((pu + pd_) * 100, 1) if (pu is not None and pd_ is not None) else None
        out["strangle"] = dict(
            structure="OTM STRANGLE", legs=f"{p['strike']}P + {c['strike']}C",
            cost=round(cost * 100, 2), max_loss=round(cost * 100, 2),
            be_low=round(be_lo, 2), be_high=round(be_hi, 2),
            required_move=round(req, 2),
            payoff_typical=payoff_multiple(val_typ, cost),
            payoff_max=payoff_multiple(val_max, cost),
            prob=prob,
            min_oi=min(c.get("openInterest") or 0, p.get("openInterest") or 0),
            stale=bool(c.get("stale") or p.get("stale")),
            cost_pct=round(cost / spot * 100, 2))

    # ---- directional: one leg, trend side --------------------------------
    leg, kind = (c, "call") if trend == "UP" else (p, "put")
    dcost = _mid(leg)
    if dcost > 0:
        be = leg["strike"] + dcost if kind == "call" else leg["strike"] - dcost
        req = abs(be - spot) / spot * 100
        tgt_typ = up_typ if kind == "call" else dn_typ
        tgt_max = up_max if kind == "call" else dn_max
        v_typ = max(tgt_typ - leg["strike"], 0) if kind == "call" else max(leg["strike"] - tgt_typ, 0)
        v_max = max(tgt_max - leg["strike"], 0) if kind == "call" else max(leg["strike"] - tgt_max, 0)
        out["directional"] = dict(
            structure=f"OTM {kind.upper()}", legs=f"{leg['strike']}{kind[0].upper()}",
            cost=round(dcost * 100, 2), max_loss=round(dcost * 100, 2),
            breakeven=round(be, 2), required_move=round(req, 2),
            payoff_typical=payoff_multiple(v_typ, dcost),
            payoff_max=payoff_multiple(v_max, dcost),
            prob=(lambda x: round(x * 100, 1) if x is not None else None)(
                _prob_beyond(spot, be, leg.get("impliedVolatility") or 0, T, kind == "call")),
            min_oi=leg.get("openInterest") or 0,
            stale=bool(leg.get("stale")), direction=kind,
            cost_pct=round(dcost / spot * 100, 2))

    # ---- OTM debit spread: cheapest, capped ------------------------------
    side = calls if trend == "UP" else puts
    far_target = spot * (1 + im * 2) if trend == "UP" else spot * (1 - im * 2)
    far = _otm(side, spot, far_target, "call" if trend == "UP" else "put")
    if far and far["strike"] != leg["strike"]:
        net = _mid(leg) - _mid(far)
        width = abs(far["strike"] - leg["strike"])
        if net > 0 and width > net:
            be = leg["strike"] + net if trend == "UP" else leg["strike"] - net
            out["spread"] = dict(
                structure=f"OTM {'CALL' if trend == 'UP' else 'PUT'} SPREAD",
                legs=f"{leg['strike']} / {far['strike']}",
                cost=round(net * 100, 2), max_loss=round(net * 100, 2),
                max_profit=round((width - net) * 100, 2),
                breakeven=round(be, 2),
                required_move=round(abs(be - spot) / spot * 100, 2),
                payoff_typical=payoff_multiple(_spread_value_at(
                    up_typ if trend == "UP" else dn_typ,
                    leg["strike"], width, trend == "UP"), net),
                payoff_max=payoff_multiple(width, net),   # capped: max is the full width
                prob=(lambda x: round(x * 100, 1) if x is not None else None)(
                    _prob_beyond(spot, be, leg.get("impliedVolatility") or 0, T, trend == "UP")),
                min_oi=min(leg.get("openInterest") or 0, far.get("openInterest") or 0),
                stale=bool(leg.get("stale") or far.get("stale")),
                capped=True, cost_pct=round(net / spot * 100, 2))

    if not out:
        return None

    # Prefer the cheapest ticket that still clears breakeven on a typical move;
    # if none does, fall back to whichever is cheapest outright.
    live = [v for v in out.values() if (v.get("payoff_typical") or 0) > 1.0]
    best = min(live or out.values(), key=lambda v: v["cost"])
    out["best"] = best
    out["verdict"] = ("LIVE" if (best.get("payoff_typical") or 0) > 1.0 else "LONG SHOT")
    out["required_vs_typical"] = (round(best["required_move"] / hist_move_pct, 2)
                                  if hist_move_pct else None)
    return out


def attach(rows, max_days=2, verbose=True):
    """Attach lotto tickets to names reporting inside max_days."""
    out = []
    for r in rows:
        d = dict(r)
        if r.get("days") is not None and 0 <= r["days"] <= max_days and r.get("expiry_ts"):
            try:
                lot = build_lotto(r["symbol"], r["spot"], r["expiry_ts"], r.get("dte", 1),
                                  r.get("implied_move"), r.get("hist_move"),
                                  r.get("hist_max"), r.get("trend", "UP"))
                if lot and lot["best"]["cost_pct"] <= MAX_COST_PCT_OF_SPOT * 100:
                    d["lotto"] = lot
                elif lot:
                    d["lotto"] = lot
                    d["lotto"]["too_pricey"] = True
            except Exception as e:
                if verbose:
                    print(f"  [{r['symbol']}] lotto failed: {str(e)[:60]}")
            time.sleep(0.35)
        out.append(d)
    return out
