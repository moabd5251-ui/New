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


def build_frames(bars):
    """Precompute every strategy's full signal series per symbol, once.

    The panel is causal, so a signal computed over the whole history and read at a
    date equals one computed on the slice ending there. Doing it once turns an
    ablation — eleven full backtests — from hours into minutes.
    """
    return {sym: T.signal_frame(df) for sym, df in bars.items()}


def exposures_at(frames, bars, upto_idx_date, cols=None):
    """Panel exposure per symbol at a date, optionally from a SUBSET of strategies.

    cols is what makes the ablation possible: drop one strategy's column and the
    remaining votes are renormalised over the smaller panel, which is exactly the
    system you would have run had that strategy never been written.
    """
    out = {}
    for sym, f in frames.items():
        sl = f[f.index <= upto_idx_date]
        if len(sl) < WARMUP:
            continue
        row = sl.iloc[-1]
        use = cols if cols is not None else list(f.columns)
        out[sym] = int(round(sum(int(row[c]) for c in use) / len(use) * 100))
    return out


def run(bars, enter_above=R.ENTER_ABOVE, exit_below=R.EXIT_BELOW,
        max_positions=R.MAX_POSITIONS, verbose=True, entry_mode="threshold",
        frames=None, cols=None):
    """Walk the calendar, rotate, and return the equity curve and the trade log.

    entry_mode picks WHEN a market becomes buyable:

      "threshold"  exposure has reached enter_above. Buys confirmed strength, and by
                   construction buys late — by the time eight of ten strategies agree,
                   much of the move is behind you.
      "cross"      exposure has just turned from negative to positive, i.e. the panel
                   flipped sides since the previous rebalance. Buys the turn, so it
                   catches far more of the move and takes far more false starts. Here
                   enter_above is the level the cross must REACH to count, so 0 takes
                   every flip and 20 filters the weakest ones.

    The two differ only in the trigger; ranking, exit and sizing are shared, so the
    comparison isolates entry timing rather than confounding it with everything else.
    """
    # Calendar from the LONGEST-running symbols, not the intersection. Requiring every
    # symbol to have bars would let the newest listing truncate the whole test — IBIT
    # listed in 2024 and on its own cut a five-year run to under two. Symbols join the
    # universe once they individually clear the warmup, which is also how it would have
    # been traded: you cannot rotate into a fund that does not exist yet.
    frames = frames if frames is not None else build_frames(bars)
    cal = sorted(set().union(*[set(df.index) for df in bars.values()]))
    start_i = max(WARMUP, 1)
    if len(cal) <= start_i + 10:
        raise RuntimeError("not enough overlapping history")

    held = {}                 # sym -> entry close
    prev_exp = {}             # last rebalance's readings, for the cross trigger
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
        exp = exposures_at(frames, bars, d, cols)

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
            if entry_mode == "cross":
                # Turned from negative to positive since the previous rebalance, and
                # reached the qualifying level. prev_exp is empty on the first pass, so
                # nothing triggers until there is a genuine prior reading to cross from.
                cands = sorted([(v, s) for s, v in exp.items()
                                if s not in held and v > 0 and v >= enter_above
                                and prev_exp.get(s) is not None and prev_exp[s] <= 0],
                               reverse=True)
            else:
                cands = sorted([(v, s) for s, v in exp.items()
                                if v >= enter_above and s not in held], reverse=True)
            for v, sym in cands[:free]:
                df = bars[sym]
                sl = df[df.index <= nxt]
                if not len(sl):
                    continue
                held[sym] = dict(px=sl["Close"].iloc[-1], date=nxt, exposure=v)
        prev_exp = exp

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
    ap.add_argument("--ablate", action="store_true",
                    help="drop each strategy in turn and measure what it was contributing")
    ap.add_argument("--compare-entry", action="store_true",
                    help="buy confirmed strength vs buy the turn from negative to positive")
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

    if a.ablate:
        print("\n" + "=" * 92)
        print("ABLATION — what is each strategy actually contributing?")
        print("=" * 92)
        frames = build_frames(bars)
        names = [n for n, _ in T.PANEL]
        base_r = run(bars, R.ENTER_ABOVE, R.EXIT_BELOW, verbose=False,
                     entry_mode=R.ENTRY_MODE, frames=frames)
        base = stats(base_r["equity"], base_r["dates"], base_r["trades"], "full panel")
        print(f"  {'full panel (10)':<24s} CAGR {base['cagr']*100:+6.2f}%  Sharpe "
              f"{base['sharpe']:5.2f}  maxDD {base['max_drawdown']*100:6.1f}%"
              f"  {base['trades_per_year']:5.1f}/yr")
        print("  " + "-" * 84)
        abl = []
        for drop in names:
            cols = [n for n in names if n != drop]
            r2 = run(bars, R.ENTER_ABOVE, R.EXIT_BELOW, verbose=False,
                     entry_mode=R.ENTRY_MODE, frames=frames, cols=cols)
            s2 = stats(r2["equity"], r2["dates"], r2["trades"], f"without {drop}")
            # Positive delta means the panel got BETTER without it — the strategy was
            # costing the system, not helping it.
            d_cagr = s2["cagr"] - base["cagr"]
            d_sh = s2["sharpe"] - base["sharpe"]
            verdict = ("HURTS" if d_sh > 0.03 else "helps" if d_sh < -0.03 else "neutral")
            print(f"  drop {drop:<19s} CAGR {s2['cagr']*100:+6.2f}% ({d_cagr*100:+5.2f})"
                  f"  Sharpe {s2['sharpe']:5.2f} ({d_sh:+5.2f})"
                  f"  maxDD {s2['max_drawdown']*100:6.1f}%   {verdict}")
            abl.append(dict(dropped=drop, delta_cagr=round(d_cagr, 4),
                            delta_sharpe=round(d_sh, 3), verdict=verdict, **s2))
        out["ablation"] = dict(baseline=base, results=abl)
        hurt = [x["dropped"] for x in abl if x["verdict"] == "HURTS"]
        if hurt:
            cols = [n for n in names if n not in hurt]
            r3 = run(bars, R.ENTER_ABOVE, R.EXIT_BELOW, verbose=False,
                     entry_mode=R.ENTRY_MODE, frames=frames, cols=cols)
            s3 = stats(r3["equity"], r3["dates"], r3["trades"], "pruned panel")
            print(f"\n  dropping all {len(hurt)} together ({', '.join(hurt)}):")
            print(f"  {'pruned panel (%d)' % len(cols):<24s} CAGR {s3['cagr']*100:+6.2f}%"
                  f"  Sharpe {s3['sharpe']:5.2f}  maxDD {s3['max_drawdown']*100:6.1f}%"
                  f"  {s3['trades_per_year']:5.1f}/yr")
            print("  NOTE: dropping the worst performers in-sample is a fit to this "
                  "history, not a discovery. Treat as a hypothesis.")
            out["ablation"]["pruned"] = dict(kept=cols, **s3)
        else:
            print("\n  no strategy is clearly hurting — the panel earns its size")

    if a.compare_entry:
        print("\n" + "=" * 92)
        print("ENTRY TIMING — buy confirmed strength, or buy the turn?")
        print("=" * 92)
        trials = [
            ("threshold", 70, 30, "confirmed: reach 70%"),
            ("threshold", 90, 30, "confirmed: reach 90%"),
            ("cross",      0, 0,  "turn: any flip to positive, exit back under 0"),
            ("cross",      0, 30, "turn: any flip, exit under 30%"),
            ("cross",     20, 0,  "turn: flip reaching 20%, exit under 0"),
            ("cross",     20, -30, "turn: flip reaching 20%, exit under -30%"),
            ("cross",     40, 0,  "turn: flip reaching 40%, exit under 0"),
        ]
        comp = []
        for mode, ent, ext, label in trials:
            r2 = run(bars, ent, ext, verbose=False, entry_mode=mode)
            s2 = stats(r2["equity"], r2["dates"], r2["trades"], label)
            o2 = leap_overlay(s2)
            print(f"  {label:<44s} CAGR {s2['cagr']*100:+6.2f}%  maxDD {s2['max_drawdown']*100:6.1f}%"
                  f"  win {s2['win_rate']:4.1f}%  {s2['trades_per_year']:5.1f}/yr"
                  f"  hold {s2['avg_hold_days']:3.0f}d  LEAPnet {o2['net_cagr']*100:+6.2f}%")
            comp.append(dict(mode=mode, enter=ent, exit=ext, **s2, overlay=o2))
        out["entry_comparison"] = comp
        best = max(comp, key=lambda c: c["overlay"]["net_cagr"])
        print(f"\n  best on ETF return : {max(comp, key=lambda c: c['cagr'])['label']}"
              f" at {max(c['cagr'] for c in comp)*100:+.2f}%")
        print(f"  best through LEAPs : {best['label']} at "
              f"{best['overlay']['net_cagr']*100:+.2f}% net — QQQ buy & hold was +18.70%")

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
