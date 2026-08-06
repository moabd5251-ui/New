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

  TIMING. Entry is bought on the TURN — the panel flipping from negative to positive —
  rather than on confirmed strength, and the position is held until it turns negative
  again. Backtesting says this matters more than anything else in the design: the same
  panel, universe and exits went from 0.45 Sharpe to 0.76 on that change alone, because
  waiting for 70% agreement buys the tail end of a move and a levered structure cannot
  pay its costs from there. Counter-intuitively it also trades LESS — 8.6 round trips a
  year against 10.9 — since holding across the whole positive range keeps a working
  position on longer than a threshold exit does.

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
# Measured on 9.16 years of daily bars, 79 closed trades, strictly walk-forward.
# See scripts/backtest_rotation.py --compare-entry.
#
# Entry timing turned out to matter more than anything else tested:
#
#     buy the turn (flip to positive)  +13.73% CAGR  maxDD -28.9%  Sharpe 0.76
#     buy 70% confirmed strength        +8.29% CAGR  maxDD -28.4%  Sharpe 0.45
#     SPY buy & hold                   +13.03% CAGR  maxDD -34.1%  Sharpe 0.70
#     QQQ buy & hold                   +18.70% CAGR  maxDD -35.6%  Sharpe 0.80
#
# Buying the turn nearly doubled the Sharpe of the same panel, on the same universe,
# with the same exits — the only change was WHEN a market becomes buyable. It beats
# holding SPY on both return and drawdown, which the threshold version did not.
#
# The mechanism is visible in the trade statistics rather than the headline. Win rate
# FELL, from 46% to 41.8%, while the average winner grew from +12.1% to +18.1% and the
# average loser shrank from -5.0% to -3.6%. Entering at the flip catches whole moves
# instead of their tail ends, and the losers are cut early because a failed turn goes
# straight back through zero.
#
# It also trades LESS, not more, which is the opposite of the intuition that an earlier
# trigger means more churn: 8.6 round trips a year against 10.9, because holding until
# the panel turns negative keeps a working position on for 105 days rather than 87.
#
# Through LEAPs the same signal nets +21.79% after 10.8%/yr carry and 8.6%/yr spread,
# against +3.17% for the threshold version. But leverage scales risk with return — the
# levered drawdown is near 87%, so this earns more than QQQ while risking far more, and
# is not better risk-adjusted. The edge is in the SIGNAL; leverage only magnifies it.
#
# Caveat unchanged: the window is dominated by a historic equity bull market, the regime
# trend following is expected to lag. That the turn entry beats SPY anyway is the
# encouraging part of this result.
BACKTEST = dict(
    years=9.16, n_trades=79, entry_mode="cross",
    cagr=0.1373, max_dd=-0.2890, sharpe=0.76, vol=0.180, win_rate=41.8,
    avg_hold_days=105, trades_per_year=8.6, avg_win=0.181, avg_loss=-0.036,
    spy_cagr=0.1303, spy_dd=-0.3410, spy_sharpe=0.70,
    qqq_cagr=0.1870, qqq_dd=-0.3562, qqq_sharpe=0.80,
    leap_gross=0.4119, leap_carry=-0.1080, leap_spread=-0.0860,
    leap_net=0.2179, leap_dd=-0.8676,
    # what the previous configuration scored, kept so the change is auditable
    threshold_cagr=0.0829, threshold_sharpe=0.45, threshold_leap_net=0.0317,
    beats_spy=True, beats_qqq=False, leap_overlay_modelled=True,
    note="Buying the turn beats SPY on return and drawdown and nearly doubles the "
         "Sharpe of the threshold version. Through LEAPs it out-returns QQQ while "
         "carrying a ~87% levered drawdown, so the leverage is not free.")

MAX_POSITIONS = 3      # how many markets are held at once

# Buy the TURN, not confirmed strength. A market qualifies when the panel flips from
# negative to positive since the last look, and is held until it goes negative again.
#
# This was the largest single improvement measured anywhere in the repo. Waiting for
# 70% agreement buys late by construction — by the time seven of ten strategies have
# come onside, most of the move has happened — and a levered, cost-heavy structure
# cannot pay for itself on the tail end of a trend. Entering at the flip and giving the
# position the whole positive range to work in lengthened the average hold from 87 days
# to 105 and CUT round trips from 10.9 a year to 8.6, so it captures more per trade
# while paying the spread less often.
ENTRY_MODE = "cross"
ENTER_ABOVE = 0        # the level a flip must reach; 0 takes every turn positive
EXIT_BELOW = 0         # and it is held until the panel turns negative again

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

    # 2. fill free slots with markets that have just TURNED, strongest first
    #
    # A market qualifies on the flip from negative to positive, not on reaching a level,
    # so a name that has been strong for months is not a buy — that move is already
    # made. prev holds the previous run's readings; with none recorded nothing triggers,
    # because there is no prior side to have crossed from and assuming one would open
    # the whole book on the first run.
    prev = state.get("last_exposures") or {}
    free = max_positions - len(held)
    for r in ranked:
        if free <= 0:
            break
        sym = r["symbol"]
        if sym in held:
            continue
        if ENTRY_MODE == "cross":
            was = prev.get(sym)
            if was is None or was > 0 or r["exposure_pct"] <= ENTER_ABOVE:
                continue
            why = (f"turned positive: {was}% -> {r['exposure_pct']}% "
                   f"({r['longs']}/{r['n_strategies']} strategies long)")
        else:
            if r["exposure_pct"] < ENTER_ABOVE:
                continue
            why = (f"rank {r['rank']} at {r['exposure_pct']}% exposure "
                   f"({r['longs']}/{r['n_strategies']} strategies long)")
        actions.append(dict(action="OPEN", symbol=sym, market=r["market"],
                            exposure_pct=r["exposure_pct"], rank=r["rank"], reason=why))
        held[sym] = dict(opened=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
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
         # every market's reading, not just the held ones — the cross trigger needs a
         # prior side for markets that are NOT in the book, which is all of them
         "last_exposures": {r["symbol"]: r["exposure_pct"] for r in result["rows"]},
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
