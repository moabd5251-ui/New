"""Capital rotation: hold LEAP calls in the strongest markets, stay out of the rest.

The graduated version of this system sizes every market at once — 30% here, 80% there.
That works in shares and does not work in options, because one SPY contract is roughly
$76k of notional, so a 10% increment needs a sleeve near $760k before it can be
expressed at all. Below that the increments round to "no contract" or "one contract"
and the graduated sizing is a label on a binary system.

Rotation sidesteps it. Concentrate the book in the few strongest markets and hold
nothing in the rest, and a single contract becomes a sensible position rather than an
unaffordable increment. The panel is then answering a different question — not "how
much of each" but "which one is strongest right now" — and its exposure reading is
already normalised across markets, so the markets are directly comparable.

Two frictions drive the design:

  LIQUIDITY. Deep ITM LEAPS trade well on SPY, QQQ, GLD, IBIT and the sector SPDRs,
  and badly on single-country and currency funds, where the spread on a round trip can
  exceed what the trend pays. The universe here is restricted to names whose LEAPS are
  actually tradable rather than to everything the panel can score.

  CHURN. LEAP spreads are wide and a trend hold lasts months, so rotating on every
  change in rank would pay the spread repeatedly for the same view. Entry and exit
  thresholds are deliberately far apart: a market must be strong to get in and only has
  to stop being weak to stay. Without that gap, a market oscillating around a single
  threshold generates a trade each time it crosses.

Long-only by construction, because LEAP CALLS are the instrument. A market in a strong
DOWNtrend is not an opportunity here, it is a reason to hold nothing — so in a broad
selloff this system sits in cash, which is the intended behaviour and not a bug.
"""
import json
from datetime import datetime, timezone
from pathlib import Path

import trend as T

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / "data" / "rotation.json"

# Markets whose LEAPS are liquid enough to round-trip without the spread eating the
# trade. Deliberately narrower than the panel's universe: EWU, FXE, FXY, DBC and UUP
# are all scoreable and none of them have a LEAP market worth trading.
ROTATION_UNIVERSE = [
    dict(symbol="QQQ",  market="Nasdaq 100",        group="Equity"),
    dict(symbol="SPY",  market="S&P 500",           group="Equity"),
    dict(symbol="IWM",  market="Russell 2000",      group="Equity"),
    dict(symbol="XLE",  market="Energy",            group="Sector"),
    dict(symbol="XLK",  market="Technology",        group="Sector"),
    dict(symbol="XLF",  market="Financials",        group="Sector"),
    dict(symbol="XLV",  market="Health Care",       group="Sector"),
    dict(symbol="XLI",  market="Industrials",       group="Sector"),
    dict(symbol="XLU",  market="Utilities",         group="Sector"),
    dict(symbol="XLP",  market="Staples",           group="Sector"),
    dict(symbol="GLD",  market="Gold",              group="Metals"),
    dict(symbol="SLV",  market="Silver",            group="Metals"),
    dict(symbol="GDX",  market="Gold Miners",       group="Metals"),
    dict(symbol="TLT",  market="US 30-Year Bond",   group="Rates"),
    dict(symbol="EEM",  market="Emerging Markets",  group="Equity"),
    dict(symbol="EFA",  market="Developed ex-US",   group="Equity"),
    dict(symbol="IBIT", market="Bitcoin",           group="Crypto"),
]

# ---------------------------------------------------------------------------
# Measured on 9.16 years of daily bars, 100 closed trades, 460 weekly rebalances,
# strictly walk-forward. See scripts/backtest_rotation.py.
#
# The signal LOSES to buying the index and holding it:
#
#     rotation      +8.29% CAGR   maxDD -28.4%   Sharpe 0.45
#     SPY hold     +13.03% CAGR   maxDD -34.1%   Sharpe 0.70
#     QQQ hold     +18.70% CAGR   maxDD -35.6%   Sharpe 0.80
#
# It does cut the drawdown, which is what trend following is for, but it gives up
# more return than it saves in risk — a worse Sharpe than simply holding.
#
# Through LEAPs it is far worse, because the costs are large against a thin edge.
# Three times leverage on +8.29% is +24.9% gross, and then 10.8%/yr of carry and
# roughly 10.9%/yr of spread at 10.9 round trips a year leave +3.2% — earned while
# carrying a levered drawdown near 85%. Holding QQQ paid six times that with a
# third of the pain.
#
# The hysteresis gap does not do the job it was designed for. Entering and exiting
# at the same 70% threshold beat the 70/30 gap on BOTH return and drawdown
# (+11.07% and -24.4% against +8.29% and -28.4%), so the churn control was costing
# more in late exits than it saved in avoided round trips.
#
# One fair caveat: the window is dominated by a historic equity bull market, which
# is the regime trend following is expected to lag. That argues the signal is not
# worthless, not that this is tradable — and it does nothing about the LEAP cost
# arithmetic, which is what actually kills it.
BACKTEST = dict(
    years=9.16, n_trades=100, rebalances=460,
    cagr=0.0829, max_dd=-0.2836, sharpe=0.45, win_rate=46.0,
    avg_hold_days=87, trades_per_year=10.9, avg_win=0.121, avg_loss=-0.050,
    spy_cagr=0.1303, spy_dd=-0.3410, spy_sharpe=0.70,
    qqq_cagr=0.1870, qqq_dd=-0.3562, qqq_sharpe=0.80,
    leap_gross=0.2487, leap_carry=-0.1080, leap_spread=-0.1090,
    leap_net=0.0317, leap_dd=-0.8508,
    beats_buy_hold=False, leap_overlay_modelled=True,
    note="Signal underperforms buy-and-hold; the LEAP overlay consumes 87% of the "
         "levered gross. Not tradable as configured.")

MAX_POSITIONS = 3      # how many markets are held at once
ENTER_ABOVE = 70       # exposure must reach this to open — a high bar
EXIT_BELOW = 30        # and only fall under this to close — a low one
# The gap between those two IS the churn control. Equal thresholds would trade every
# time a market oscillated across the line, paying a wide LEAP spread each round trip.

TARGET_DELTA = 0.80    # deep enough that extrinsic, and therefore theta, stays small
MIN_DTE = 270          # LEAPS: far enough out that decay is slow over a months-long hold
MAX_DTE = 450


def rank(rows):
    """Order markets by tradable strength. Long-only, so shorts are excluded outright.

    Exposure is coarse by design — ten strategies means ties at 90 and 100 are common —
    so momentum breaks them. Without a tiebreak the ordering would depend on whatever
    order the universe happened to be listed in.
    """
    live = [r for r in rows if r["exposure_pct"] > 0]
    for r in live:
        r["rank_score"] = r["exposure_pct"] + min(max(r.get("mom_63", 0) * 100, -9), 9) / 10.0
    live.sort(key=lambda r: -r["rank_score"])
    for i, r in enumerate(live, 1):
        r["rank"] = i
    return live


def load_state():
    if STATE.exists():
        try:
            return json.loads(STATE.read_text() or "{}")
        except json.JSONDecodeError:
            pass
    return {"held": {}, "history": []}


def decide(ranked, state, max_positions=MAX_POSITIONS):
    """Which markets to open, hold and close, given what is already on.

    Held markets are evaluated on the EXIT threshold, not on rank. A position that has
    slipped from first to fourth while its trend is intact is not a reason to pay a
    round-trip spread — the trend it was bought for is still there. Only genuine
    weakness, or a full book with something far stronger waiting, forces it out.
    """
    held = dict(state.get("held") or {})
    by_sym = {r["symbol"]: r for r in ranked}
    actions = []

    # 1. close anything that has weakened, or whose trend has turned outright
    for sym in list(held):
        r = by_sym.get(sym)
        pct = r["exposure_pct"] if r else None
        if r is None or pct < EXIT_BELOW:
            actions.append(dict(action="CLOSE", symbol=sym,
                                exposure_pct=pct,
                                reason=(f"exposure {pct}% fell under the {EXIT_BELOW}% exit floor"
                                        if pct is not None else
                                        "no longer reads a long trend at all")))
            held.pop(sym)

    # 2. fill free slots with the strongest qualifying markets not already held
    free = max_positions - len(held)
    for r in ranked:
        if free <= 0:
            break
        if r["symbol"] in held or r["exposure_pct"] < ENTER_ABOVE:
            continue
        actions.append(dict(action="OPEN", symbol=r["symbol"], market=r["market"],
                            exposure_pct=r["exposure_pct"], rank=r["rank"],
                            reason=(f"rank {r['rank']} at {r['exposure_pct']}% exposure "
                                    f"({r['longs']}/{r['n_strategies']} strategies long)")))
        held[r["symbol"]] = dict(opened=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                                 entry_exposure=r["exposure_pct"], market=r["market"])
        free -= 1

    # 3. hold the rest
    for sym, meta in held.items():
        if any(a["symbol"] == sym and a["action"] == "OPEN" for a in actions):
            continue
        r = by_sym.get(sym)
        actions.append(dict(action="HOLD", symbol=sym,
                            exposure_pct=r["exposure_pct"] if r else None,
                            rank=r.get("rank") if r else None,
                            opened=meta.get("opened"),
                            reason=(f"still {r['exposure_pct']}% long, above the "
                                    f"{EXIT_BELOW}% floor" if r else "held")))
    order = {"CLOSE": 0, "OPEN": 1, "HOLD": 2}
    actions.sort(key=lambda a: order[a["action"]])
    return actions, held


def scan(verbose=True):
    """Score the rotation universe and decide the book. Signal only — no contracts."""
    rows, errs = T.scan(ROTATION_UNIVERSE, verbose=verbose)
    ranked = rank(rows)
    state = load_state()
    actions, held = decide(ranked, state)
    return dict(rows=rows, ranked=ranked, actions=actions, held=held,
                errors=errs, asof=rows[0]["asof"] if rows else None)


def save(result):
    state = load_state()
    hist = state.get("history") or []
    for a in result["actions"]:
        if a["action"] in ("OPEN", "CLOSE"):
            hist.append(dict(a, at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                             asof=result["asof"]))
    STATE.write_text(json.dumps(
        {"held": result["held"], "asof": result["asof"],
         "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
         "history": hist[-300:]}, indent=2, default=str))


# ---------------------------------------------------------------------------
# contract selection — the only part that needs a live chain
# ---------------------------------------------------------------------------
def pick_leap(symbol, spot=None, target_delta=TARGET_DELTA,
              min_dte=MIN_DTE, max_dte=MAX_DTE, min_oi=50):
    """Choose the LEAP call that carries the exposure with the least decay.

    Deep in the money on purpose. Only the EXTRINSIC part of a premium decays, and at
    0.80 delta on a nine-month contract that is a thin slice of what you pay, so theta
    per unit of exposure is small. The instinctive alternative — cheap out-of-the-money
    calls — is all extrinsic, which is the same mistake the vol-ramp backtest already
    priced: implied vol rose 96% of the time there and long premium still lost, because
    decay took the gain. A trend hold lasts far longer than that trade did.

    Returns None when nothing in the window is liquid enough to round-trip, which for
    the thinner names is the honest answer rather than a contract that cannot be filled.
    """
    import math
    from datetime import datetime as _dt, timezone as _tz
    import opt_lib as O
    import feed

    base = O.chain(symbol)
    S = spot or base["quote"]["regularMarketPrice"]
    now = _dt.now(_tz.utc)
    best = None
    for ts in sorted(base["expirationDates"]):
        exp = _dt.fromtimestamp(ts, _tz.utc)
        dte = (exp - now).days
        if not (min_dte <= dte <= max_dte):
            continue
        try:
            ch = O.chain(symbol, ts)
        except Exception:
            continue
        T_yrs = max(dte, 1) / 365.0
        for o in ch["options"][0]["calls"]:
            bid, ask = o.get("bid") or 0, o.get("ask") or 0
            if bid <= 0 or ask <= 0 or (o.get("openInterest") or 0) < min_oi:
                continue
            mid = (bid + ask) / 2
            if mid <= 0:
                continue
            spread_pct = (ask - bid) / mid
            g = O.greeks_for(o, S, T_yrs, "call")
            d = g.get("delta") or 0
            if d <= 0:
                continue
            intrinsic = max(S - o["strike"], 0.0)
            extrinsic = max(mid - intrinsic, 0.0)
            cand = dict(
                symbol=symbol, contract=o.get("contractSymbol"), strike=o["strike"],
                expiry=exp.strftime("%Y-%m-%d"), dte=dte, spot=round(S, 2),
                bid=bid, ask=ask, mid=round(mid, 2), spread_pct=round(spread_pct * 100, 1),
                delta=round(d, 3), theta=round(g.get("theta") or 0, 4),
                vega=round(g.get("vega") or 0, 4), greek_source=g.get("source"),
                oi=o.get("openInterest") or 0, iv=round((o.get("impliedVolatility") or 0) * 100, 1),
                intrinsic=round(intrinsic, 2), extrinsic=round(extrinsic, 2),
                extrinsic_pct=round(extrinsic / mid * 100, 1),
                cost=round(mid * 100, 2),
                notional=round(d * S * 100, 2),
                stale=bool(o.get("stale")),
                # what the position costs to carry, as a share of the exposure it buys
                carry_pct_per_month=round(abs(g.get("theta") or 0) * 30 / (d * S) * 100, 3)
                if d * S else None,
                delta_gap=abs(d - target_delta))
            if best is None or cand["delta_gap"] < best["delta_gap"]:
                best = cand
    if best:
        best.pop("delta_gap", None)
    return best


def size_position(leap, allocation):
    """How many contracts an allocation buys, and the exposure that actually results.

    Reported in delta-notional rather than contract count because that is the number
    comparable to holding the ETF outright — one 0.80-delta contract on a $90 fund is
    roughly $7,200 of exposure bought for whatever the premium was, and the premium is
    what is at risk.
    """
    if not leap or not leap.get("cost"):
        return None
    n = int(allocation // leap["cost"])
    if n < 1:
        return dict(contracts=0, affordable=False,
                    note=(f"one contract costs ${leap['cost']:,.0f}, above the "
                          f"${allocation:,.0f} allocated — this market is not "
                          f"expressible at this size"))
    return dict(contracts=n, affordable=True,
                premium_at_risk=round(n * leap["cost"], 2),
                delta_notional=round(n * leap["notional"], 2),
                leverage=round(n * leap["notional"] / (n * leap["cost"]), 2),
                monthly_carry=round(abs(leap["theta"]) * 30 * n * 100, 2))
