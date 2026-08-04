#!/usr/bin/env python3
"""Backtest the LEAP rotation rules on daily bars.

Two things are being tested and they are not the same thing:

  THE SIGNAL. Does concentrating in the strongest-trending markets beat holding the
  index? Measured on ETF total return, because that isolates the ranking and the
  entry/exit rules from any assumption about option structure. If the signal does not
  work here, no choice of contract rescues it.

  THE STRUCTURE. Deep-ITM LEAPs multiply that result — roughly 3x leverage both
  directions — and charge carry for the privilege. Leverage applied to a losing signal
  loses faster, so this is reported as an overlay on the signal result rather than
  mixed into it. The overlay is modelled, not measured: real LEAP P&L would need
  historical options data per position, and the point here is the sign and rough
  magnitude of the drag, not a fill-accurate equity curve.

No lookahead anywhere. On each rebalance the panel sees only bars up to that date, and
positions are entered at the NEXT session's close — a signal computed from a close
cannot be traded at that same close.

    python3 scripts/backtest_rotation.py
    python3 scripts/backtest_rotation.py --sweep     # threshold sensitivity
"""
import argparse
import json
import statistics as st
import sys
import traceback
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

import portfolio as P
import rotation as R
import trend as T

OUT = ROOT / "data" / "backtest_rotation.json"

WARMUP = 210           # bars the panel needs before it can vote
REBALANCE_EVERY = 5    # trading days; weekly, to keep LEAP round trips survivable

# Round-trip cost of crossing a LEAP spread, as a fraction of the premium. Deep-ITM
# LEAPs on liquid ETFs quote a few percent wide; this is charged on the PREMIUM, which
# is roughly a third of the exposure, so it lands near 1% of notional per round trip.
LEAP_SPREAD_COST = 0.03
LEAP_LEVERAGE = 3.0            # ~0.80 delta bought for ~1/3 of notional
LEAP_CARRY_MONTHLY = 0.009     # measured on XLF: 0.89% of exposure per month


def load_bars(symbols, rng="5y"):
    out = {}
    for s in symbols:
        try:
            df = P.bars(s, "1d", rng)
            if df is not None and len(df) > WARMUP + 60:
                out[s] = df
        except Exception as e:
            print(f"  [{s}] {str(e)[:60]}")
    return out


def exposures_at(bars, upto_idx_date):
    """Panel exposure for every symbol using only bars up to and including that date."""
    out = {}
    for sym, df in bars.items():
        sl = df[df.index <= upto_idx_date]
        if len(sl) < WARMUP:
            continue
        net = 0
        for _, fn in T.PANEL:
            try:
                net += int(fn(sl))
            except Exception:
                pass
        out[sym] = int(round(net / len(T.PANEL) * 100))
    return out


def run(bars, enter_above=R.ENTER_ABOVE, exit_below=R.EXIT_BELOW,
        max_positions=R.MAX_POSITIONS, verbose=True):
    """Walk the calendar, rotate, and return the equity curve and the trade log."""
    # Calendar from the LONGEST-running symbols, not the intersection. Requiring every
    # symbol to have bars would let the newest listing truncate the whole test — IBIT
    # listed in 2024 and on its own cut a five-year run to under two. Symbols join the
    # universe once they individually clear the warmup, which is also how it would have
    # been traded: you cannot rotate into a fund that does not exist yet.
    cal = sorted(set().union(*[set(df.index) for df in bars.values()]))
    start_i = max(WARMUP, 1)
    if len(cal) <= start_i + 10:
        raise RuntimeError("not enough overlapping history")

    held = {}                 # sym -> entry close
    equity = [1.0]
    dates = [cal[start_i]]
    trades = []
    n_rebal = 0

    for i in range(start_i, len(cal) - 1):
        d, nxt = cal[i], cal[i + 1]

        # --- daily mark: equal weight across whatever is held, cash earns nothing ---
        rets = []
        for sym in held:
            df = bars[sym]
            a, b = df[df.index <= d], df[df.index <= nxt]
            if len(a) and len(b) and a["Close"].iloc[-1] > 0:
                rets.append(b["Close"].iloc[-1] / a["Close"].iloc[-1] - 1)
        day_ret = (sum(rets) / max_positions) if rets else 0.0
        equity.append(equity[-1] * (1 + day_ret))
        dates.append(nxt)

        # --- rebalance on schedule, acting at the NEXT close ---
        if (i - start_i) % REBALANCE_EVERY:
            continue
        n_rebal += 1
        exp = exposures_at(bars, d)

        for sym in list(held):
            if exp.get(sym, -100) < exit_below:
                df = bars[sym]
                px = df[df.index <= nxt]["Close"].iloc[-1]
                e = held.pop(sym)
                trades.append(dict(symbol=sym, entry=round(e["px"], 4), exit=round(px, 4),
                                   entered=str(e["date"])[:10], exited=str(nxt)[:10],
                                   days=(nxt - e["date"]).days,
                                   ret=round(px / e["px"] - 1, 4),
                                   exit_exposure=exp.get(sym)))

        free = max_positions - len(held)
        if free > 0:
            cands = sorted([(v, s) for s, v in exp.items()
                            if v >= enter_above and s not in held], reverse=True)
            for v, sym in cands[:free]:
                df = bars[sym]
                sl = df[df.index <= nxt]
                if not len(sl):
                    continue
                held[sym] = dict(px=sl["Close"].iloc[-1], date=nxt, exposure=v)

    # close whatever is still open at the end, so the log is complete
    last = cal[-1]
    for sym, e in held.items():
        px = bars[sym][bars[sym].index <= last]["Close"].iloc[-1]
        trades.append(dict(symbol=sym, entry=round(e["px"], 4), exit=round(px, 4),
                           entered=str(e["date"])[:10], exited=str(last)[:10],
                           days=(last - e["date"]).days,
                           ret=round(px / e["px"] - 1, 4), open_at_end=True))

    return dict(dates=[str(x)[:10] for x in dates], equity=equity,
                trades=trades, rebalances=n_rebal)


def stats(equity, dates, trades, label=""):
    eq = np.array(equity)
    total = eq[-1] - 1
    yrs = max((pd.Timestamp(dates[-1]) - pd.Timestamp(dates[0])).days / 365.25, 0.01)
    cagr = (eq[-1] ** (1 / yrs)) - 1
    peak = np.maximum.accumulate(eq)
    dd = (eq - peak) / peak
    maxdd = dd.min()
    rets = np.diff(eq) / eq[:-1]
    vol = rets.std() * np.sqrt(252) if len(rets) > 2 else 0
    sharpe = (cagr / vol) if vol > 0 else 0
    closed = [t for t in trades if not t.get("open_at_end")]
    wins = [t for t in closed if t["ret"] > 0]
    return dict(label=label, years=round(yrs, 2), total_return=round(total, 4),
                cagr=round(cagr, 4), max_drawdown=round(maxdd, 4),
                vol=round(vol, 4), sharpe=round(sharpe, 2),
                n_trades=len(closed),
                win_rate=round(len(wins) / len(closed) * 100, 1) if closed else 0,
                avg_hold_days=round(st.mean([t["days"] for t in closed]), 1) if closed else 0,
                avg_win=round(st.mean([t["ret"] for t in wins]), 4) if wins else 0,
                avg_loss=round(st.mean([t["ret"] for t in closed if t["ret"] <= 0]), 4)
                if len(closed) > len(wins) else 0,
                trades_per_year=round(len(closed) / yrs, 1) if closed else 0)


def leap_overlay(s):
    """What the same signal would have done through deep-ITM LEAPs.

    Leverage multiplies the signal's return in both directions and carry is charged
    whether or not the trend works, so this can only improve a result that was already
    positive. Applied to the CAGR rather than compounded bar by bar — a rough overlay,
    not a simulated position.
    """
    gross = s["cagr"] * LEAP_LEVERAGE
    carry = LEAP_CARRY_MONTHLY * 12
    spread = s["trades_per_year"] * LEAP_SPREAD_COST / LEAP_LEVERAGE
    return dict(gross_cagr=round(gross, 4), carry_drag=round(carry, 4),
                spread_drag=round(spread, 4),
                net_cagr=round(gross - carry - spread, 4),
                levered_max_dd=round(s["max_drawdown"] * LEAP_LEVERAGE, 4))


def buy_hold(bars, sym, dates):
    df = bars.get(sym)
    if df is None:
        return None
    sl = df[(df.index >= pd.Timestamp(dates[0], tz="UTC")) &
            (df.index <= pd.Timestamp(dates[-1], tz="UTC"))]
    if len(sl) < 2:
        return None
    eq = (sl["Close"] / sl["Close"].iloc[0]).tolist()
    return stats(eq, [str(x)[:10] for x in sl.index], [], f"buy & hold {sym}")


def show(s):
    print(f"  {s['label']:26s} CAGR {s['cagr']*100:+7.2f}%   total {s['total_return']*100:+8.2f}%"
          f"   maxDD {s['max_drawdown']*100:7.2f}%   Sharpe {s['sharpe']:5.2f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sweep", action="store_true", help="threshold sensitivity")
    ap.add_argument("--range", default="5y")
    a = ap.parse_args()

    syms = [x["symbol"] for x in R.ROTATION_UNIVERSE]
    print(f"[data] loading {len(syms)} ETFs, {a.range}")
    bars = load_bars(syms, a.range)
    print(f"[data] {len(bars)} usable: {', '.join(sorted(bars))}")

    print(f"[run] enter>={R.ENTER_ABOVE}%, exit<{R.EXIT_BELOW}%, "
          f"max {R.MAX_POSITIONS}, rebalance every {REBALANCE_EVERY}d")
    res = run(bars)
    s = stats(res["equity"], res["dates"], res["trades"], "ROTATION (ETF)")
    print(f"[run] {s['years']}y, {res['rebalances']} rebalances, {s['n_trades']} closed trades")

    print("\n" + "=" * 92)
    print("SIGNAL — does concentrating in the strongest trends beat holding the index?")
    print("=" * 92)
    show(s)
    for b in ("SPY", "QQQ"):
        bh = buy_hold(bars, b, res["dates"])
        if bh:
            show(bh)

    print(f"\n  win rate {s['win_rate']}%   avg hold {s['avg_hold_days']:.0f}d   "
          f"{s['trades_per_year']}/yr   avg win {s['avg_win']*100:+.1f}%  "
          f"avg loss {s['avg_loss']*100:+.1f}%")

    ov = leap_overlay(s)
    print("\n" + "=" * 92)
    print("STRUCTURE — the same signal through deep-ITM LEAPs (modelled overlay)")
    print("=" * 92)
    print(f"  gross at {LEAP_LEVERAGE}x leverage      {ov['gross_cagr']*100:+7.2f}%")
    print(f"  carry drag                    {-ov['carry_drag']*100:7.2f}%")
    print(f"  spread drag ({s['trades_per_year']}/yr)        {-ov['spread_drag']*100:7.2f}%")
    print(f"  NET                           {ov['net_cagr']*100:+7.2f}%")
    print(f"  drawdown, levered             {ov['levered_max_dd']*100:7.2f}%")

    best = sorted([t for t in res["trades"] if not t.get("open_at_end")],
                  key=lambda t: -t["ret"])
    print("\n  best:  " + ", ".join(f"{t['symbol']} {t['ret']*100:+.0f}%" for t in best[:5]))
    print("  worst: " + ", ".join(f"{t['symbol']} {t['ret']*100:+.0f}%" for t in best[-5:]))

    out = dict(stats=s, overlay=ov, trades=res["trades"],
               params=dict(enter=R.ENTER_ABOVE, exit=R.EXIT_BELOW,
                           max_positions=R.MAX_POSITIONS, rebalance=REBALANCE_EVERY))

    if a.sweep:
        print("\n" + "=" * 92)
        print("SENSITIVITY — is the hysteresis gap doing real work?")
        print("=" * 92)
        sweep = []
        for ent, ext in [(70, 30), (70, 50), (70, 70), (90, 30), (50, 30), (50, 50), (90, 90)]:
            r2 = run(bars, ent, ext, verbose=False)
            s2 = stats(r2["equity"], r2["dates"], r2["trades"], f"enter {ent} / exit {ext}")
            gap = ent - ext
            print(f"  {s2['label']:26s} CAGR {s2['cagr']*100:+7.2f}%  maxDD "
                  f"{s2['max_drawdown']*100:7.2f}%  {s2['trades_per_year']:5.1f} trades/yr"
                  f"  (gap {gap})")
            sweep.append(s2)
        out["sweep"] = sweep

    OUT.write_text(json.dumps(out, indent=2, default=str))
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
