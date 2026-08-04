#!/usr/bin/env python3
"""Backtest the pre-earnings volatility ramp against the real OPRA tape.

The live ramp strategy rests on one number that was never measured: an estimated
23 points of implied-vol expansion into a report, derived from a single day's
cross-section of names at different distances from their earnings. That is an
inference about how DIFFERENT names were priced on one afternoon, not an
observation of any single name actually ramping. This measures the real thing —
the same contract, tracked day by day into its own report.

Two questions, kept apart on purpose:

  1. Does implied vol on the earnings expiry actually rise into the report, and by
     how much? This is the premise. If it is false the strategy has no edge to
     harvest and nothing else matters.

  2. Does BUYING that vol make money? A separate question, and the one that pays.
     A long straddle is short theta, so vol can rise exactly as predicted while the
     position still bleeds out. Premise true and strategy unprofitable is a
     perfectly ordinary outcome, and the one most likely to be missed by a study
     that only measures question 1.

Every result is reported twice: mid-to-mid, and ask-to-bid. Mid-to-mid is what a
backtest flatters itself with; ask-to-bid is what a trader gets. On weekly options
that gap is routinely wider than the entire edge, so a mid-only result is not
evidence of anything.

    python3 scripts/backtest_ramp.py --dry-run     # price the study, fetch nothing
    python3 scripts/backtest_ramp.py --limit 25    # run a subset
    python3 scripts/backtest_ramp.py               # full run
"""
import argparse
import json
import statistics as st
import sys
import time
import traceback
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

import dbn_hist as H
import earnings_history as EH
import opt_lib as O

OUT = ROOT / "data" / "backtest_ramp.json"

WINDOW = 40          # calendar days before the report to begin tracking
N_STRIKES = 2        # strikes each side of the money; covers drift over the window
ENTRIES = (28, 21, 14, 10, 7, 5)       # candidate entry points, days before the report
MIN_IV, MAX_IV = 0.05, 3.0             # outside this the solved vol is not a market

# NBBO width on ATM contracts as a fraction of mid, used to model the round-trip cost
# that daily bars cannot show. Placeholder until --measure-spread replaces it with the
# figure taken off the tape; the run prints which one it used.
SPREAD_PCT = 0.06
SPREAD_FILE = ROOT / "data" / "atm_spread.json"
if SPREAD_FILE.exists():
    try:
        SPREAD_PCT = json.loads(SPREAD_FILE.read_text())["median_spread_pct"]
    except Exception:
        pass


def sessions(eq, sym):
    """{date: close} for one symbol."""
    d = eq[eq["symbol"] == sym]
    return dict(zip(d["date"], d["close"].astype(float)))


def exit_session(closes, report_date):
    """Last session STRICTLY before the report date.

    Yahoo gives the announcement date but not whether it lands before the open or
    after the close. Exiting the prior session is the only rule that never holds the
    event under either timing. It costs the final day of ramp for after-close
    reporters, which understates the strategy rather than flattering it — the right
    direction for an assumption to err.
    """
    prior = [d for d in closes if d < report_date]
    return max(prior) if prior else None


def pick_expiry(defs, report_date):
    """First listed expiry strictly after the report — the one that prices the event."""
    later = sorted({e for e in defs["expiry"] if e > report_date})
    return later[0] if later else None


def atm_band(defs, expiry, spot, n=N_STRIKES):
    """The 2n+1 listed strikes closest to spot on that expiry, calls and puts."""
    ks = sorted({float(k) for k in defs[defs["expiry"] == expiry]["strike"]})
    if not ks:
        return [], []
    ks.sort(key=lambda k: abs(k - spot))
    keep = sorted(ks[: 2 * n + 1])
    return keep, [H.osi(defs.attrs["symbol"], expiry, kind, k)
                  for k in keep for kind in ("call", "put")]


def iv_of(row, spot, K, kind, T, price_key="mid"):
    px = row.get(price_key)
    if px is None or px <= 0:
        return None
    iv = O.implied_vol(px, spot, K, T, kind)
    if iv is None or not (MIN_IV <= iv <= MAX_IV):
        return None
    return iv


def build_event(sym, report_date, max_cost, verbose=False):
    """Track the ATM straddle on the earnings expiry across the approach window."""
    start = (datetime.strptime(report_date, "%Y-%m-%d") - timedelta(days=WINDOW)).strftime("%Y-%m-%d")
    end = (datetime.strptime(report_date, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")

    eq = H.equity_daily([sym], start, end, max_cost=max_cost)
    if eq.empty:
        return None, "no equity bars"
    closes = sessions(eq, sym)
    xd = exit_session(closes, report_date)
    if not xd:
        return None, "no session before the report"

    # Contract universe as it was listed at the start of the window, not as it looks now.
    open_day = min(d for d in closes if d >= start)
    defs = H.definitions(sym, open_day, max_cost=max_cost)
    if defs.empty:
        return None, "no definitions"
    defs.attrs["symbol"] = sym
    expiry = pick_expiry(defs, report_date)
    if not expiry:
        return None, "no expiry after the report"

    strikes, syms = atm_band(defs, expiry, closes[open_day])
    if not syms:
        return None, "no strikes"

    q = H.option_daily(syms, start, end, max_cost=max_cost)
    if q.empty:
        return None, "no quotes"

    # index by (date, strike, kind)
    book = {}
    for _, r in q.iterrows():
        _, _, kind, K = H.parse_osi(r["raw_symbol"])
        book[(r["date"], K, kind)] = r

    exp_dt = datetime.strptime(expiry, "%Y-%m-%d")
    path = []
    for d in sorted(dd for dd in closes if start <= dd <= xd):
        spot = closes[d]
        T = max((exp_dt - datetime.strptime(d, "%Y-%m-%d")).days, 1) / 365.0
        K = min(strikes, key=lambda k: abs(k - spot))
        c, p = book.get((d, K, "call")), book.get((d, K, "put"))
        if c is None or p is None:
            continue
        ivc = iv_of(c, spot, K, "call", T, "close")
        ivp = iv_of(p, spot, K, "put", T, "close")
        ivs = [x for x in (ivc, ivp) if x is not None]
        if not ivs:
            continue
        path.append(dict(
            date=d, dte_report=(datetime.strptime(report_date, "%Y-%m-%d")
                                - datetime.strptime(d, "%Y-%m-%d")).days,
            spot=round(spot, 2), strike=K, iv=round(sum(ivs) / len(ivs), 4),
            mid=round(float(c["close"]) + float(p["close"]), 4),
            volume=int(float(c["volume"]) + float(p["volume"]))))
    if len(path) < 5:
        return None, f"only {len(path)} usable sessions"
    return dict(symbol=sym, report_date=report_date, expiry=expiry,
                exit_date=xd, path=path), None


def simulate(ev, spread_pct=None):
    """Entries at each candidate horizon, all exiting the session before the report.

    Daily bars carry no bid/ask, so the realistic fill is modelled: pay half the spread
    entering, pay it again leaving. spread_pct is the measured NBBO width as a fraction
    of mid, from spread_sample() on the same kind of contract. Reporting only the
    mid-to-mid number would be the single most flattering choice available here, since
    a round trip through an earnings straddle crosses the spread twice.
    """
    s = SPREAD_PCT if spread_pct is None else spread_pct
    path = {r["dte_report"]: r for r in ev["path"]}
    last = ev["path"][-1]
    out = []
    for n in ENTRIES:
        # nearest tracked session at or before the target horizon
        cands = [d for d in path if d >= n]
        if not cands:
            continue
        e = path[min(cands)]
        if e["date"] >= last["date"] or e["strike"] != last["strike"]:
            continue          # one trade means the same contract on both legs
        if e["mid"] <= 0:
            continue
        pay = e["mid"] * (1 + s / 2)
        got = last["mid"] * (1 - s / 2)
        out.append(dict(
            target_n=n, held_from=e["date"], entry_dte=e["dte_report"],
            entry_iv=e["iv"], exit_iv=last["iv"], iv_change=round(last["iv"] - e["iv"], 4),
            entry_mid=e["mid"], exit_mid=last["mid"],
            ret_mid=round((last["mid"] - e["mid"]) / e["mid"], 4),
            ret_real=round((got - pay) / pay, 4),
            spot_move=round((last["spot"] - e["spot"]) / e["spot"], 4)))
    return out


def measure_spread(evs, n, max_cost):
    """Sample the real NBBO width on ATM contracts at a typical entry horizon.

    Daily bars give no quotes, so without this the round-trip cost would be a guess.
    Sampled rather than measured per trade because the multi-week quote pull that would
    price every leg is the one query shape the gateway refuses to serve.
    """
    import random
    random.seed(7)
    picks = random.sample(evs, min(n, len(evs)))
    spreads, done = [], 0
    for sym, d, _ in picks:
        try:
            target = (datetime.strptime(d, "%Y-%m-%d") - timedelta(days=21)).strftime("%Y-%m-%d")
            eq = H.equity_daily([sym], target, d, max_cost=max_cost)
            if eq.empty:
                continue
            closes = sessions(eq, sym)
            day = min(dd for dd in closes if dd >= target)
            defs = H.definitions(sym, day, max_cost=max_cost)
            if defs.empty:
                continue
            defs.attrs["symbol"] = sym
            expiry = pick_expiry(defs, d)
            if not expiry:
                continue
            ks = sorted({float(k) for k in defs[defs["expiry"] == expiry]["strike"]},
                        key=lambda k: abs(k - closes[day]))[:1]
            syms = [H.osi(sym, expiry, kind, ks[0]) for kind in ("call", "put")]
            bbo = H.spread_sample(syms, day, max_cost=max_cost)
            for _, r in bbo.iterrows():
                spreads.append(float(r["spread_pct"]))
            done += 1
            print(f"  {sym} {day}: " +
                  ", ".join(f"{float(r['spread_pct']):.2%}" for _, r in bbo.iterrows()))
        except Exception as e:
            print(f"  {sym} {d}: {type(e).__name__} {str(e)[:60]}")
    if not spreads:
        print("no spreads measured")
        return
    med = st.median(spreads)
    SPREAD_FILE.write_text(json.dumps(
        dict(median_spread_pct=round(med, 4), mean_spread_pct=round(st.mean(spreads), 4),
             n_contracts=len(spreads), n_events=done,
             note="ATM NBBO width as a fraction of mid, ~21 days before the report"),
        indent=2))
    print(f"\n{len(spreads)} ATM contracts across {done} events")
    print(f"median spread {med:.2%} of mid, mean {st.mean(spreads):.2%}  -> wrote {SPREAD_FILE}")


def describe(vals, label, pct=True):
    vals = [v for v in vals if v is not None]
    if not vals:
        return f"  {label:26s}      no data"
    m = st.mean(vals)
    sd = st.pstdev(vals) if len(vals) > 1 else 0.0
    t = (m / (sd / len(vals) ** 0.5)) if sd > 0 and len(vals) > 1 else 0.0
    win = sum(1 for v in vals if v > 0) / len(vals)
    u = 100 if pct else 1
    return (f"  {label:26s} n={len(vals):4d}  mean {m*u:+7.2f}  median {st.median(vals)*u:+7.2f}"
            f"  win {win:5.1%}  t={t:+5.2f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="price the study, fetch nothing")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--max-cost", type=float, default=0.25, help="ceiling per query")
    ap.add_argument("--budget", type=float, default=25.0, help="stop once spend passes this")
    ap.add_argument("--measure-spread", type=int, default=0, metavar="N",
                    help="sample N events for the real ATM bid/ask width, then stop")
    a = ap.parse_args()

    evs = EH.events()
    # The report must be far enough in the past that the tape covers the session before
    # it. An event dated today has no exit session recorded yet and would look like a
    # data failure rather than what it is — a trade that has not finished.
    cutoff = (datetime.strptime(H.available_end(H.OPRA), "%Y-%m-%d")
              - timedelta(days=1)).strftime("%Y-%m-%d")
    evs = [e for e in evs if e[1] <= cutoff]
    if a.limit:
        evs = evs[-a.limit:]
    print(f"{len(evs)} earnings events, {evs[0][1]} .. {evs[-1][1]}")

    if a.dry_run:
        # Price against a real event's real contracts. Synthetic strikes on a guessed
        # expiry do not resolve, and an estimate built on symbols that never listed is
        # not an estimate of anything.
        sym, d, _ = evs[-1]
        start = (datetime.strptime(d, "%Y-%m-%d") - timedelta(days=WINDOW)).strftime("%Y-%m-%d")
        end = (datetime.strptime(d, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
        eq = H.equity_daily([sym], start, end, max_cost=a.max_cost)
        closes = sessions(eq, sym)
        open_day = min(d2 for d2 in closes if d2 >= start)
        defs = H.definitions(sym, open_day, max_cost=a.max_cost)
        defs.attrs["symbol"] = sym
        expiry = pick_expiry(defs, d)
        _, syms = atm_band(defs, expiry, closes[open_day])

        c_def = H.estimate(dataset=H.OPRA, schema="definition", symbols=[f"{sym}.OPT"],
                           stype_in="parent", start=f"{open_day}T00:00", end=f"{open_day}T13:00")
        c_q = H.estimate(dataset=H.OPRA, schema="tcbbo", symbols=syms,
                         stype_in="raw_symbol", start=start, end=end)
        c_eq = H.estimate(dataset=H.EQUITY, schema="ohlcv-1d", symbols=[sym],
                          stype_in="raw_symbol", start=start, end=end)
        per = c_def + c_q + c_eq
        print(f"\nsample: {sym} reporting {d}, expiry {expiry}, {len(syms)} contracts")
        print(f"per event: definitions ${c_def:.4f} + quotes ${c_q:.4f} + equity ${c_eq:.4f}"
              f" = ${per:.4f}")
        print(f"{len(evs)} events -> ${per * len(evs):.2f}   (already spent ${H.spend_total():.2f})")
        return

    if a.measure_spread:
        measure_spread(evs, a.measure_spread, a.max_cost)
        return

    rows, skipped = [], {}
    print(f"modelled round-trip spread: {SPREAD_PCT:.1%} of mid"
          f"{'' if SPREAD_FILE.exists() else '  (PLACEHOLDER — run --measure-spread)'}")
    for i, (sym, d, sur) in enumerate(evs, 1):
        if H.spend_total() > a.budget:
            print(f"\n[budget] stopping at ${H.spend_total():.2f}")
            break
        try:
            ev, why = build_event(sym, d, a.max_cost)
        except Exception as e:
            ev, why = None, f"{type(e).__name__}: {str(e)[:50]}"
        if ev is None:
            skipped[why] = skipped.get(why, 0) + 1
        else:
            ev["surprise_pct"] = sur
            ev["trades"] = simulate(ev)
            rows.append(ev)
        if i % 10 == 0:
            print(f"  [{i}/{len(evs)}] {len(rows)} tracked, ${H.spend_total():.2f} spent")
        time.sleep(0.1)

    OUT.write_text(json.dumps(rows, indent=2, default=str))
    print(f"\n{len(rows)} events tracked, {sum(skipped.values())} skipped {skipped}")
    print(f"spend: ${H.spend_total():.2f}   wrote {OUT}")
    report(rows)


def report(rows):
    trades = [t for ev in rows for t in ev["trades"]]
    if not trades:
        print("no trades")
        return

    print("\n" + "=" * 78)
    print("Q1  DOES IMPLIED VOL ACTUALLY RISE INTO THE REPORT?")
    print("=" * 78)
    for n in ENTRIES:
        g = [t for t in trades if t["target_n"] == n]
        if g:
            print(describe([t["iv_change"] for t in g], f"entry {n:>2}d out, IV pts"))
    allch = [t["iv_change"] for t in trades]
    print("\n" + describe(allch, "ALL entries, IV pts"))

    print("\n" + "=" * 78)
    print("Q2  DOES BUYING IT MAKE MONEY?   (straddle, exit before the report)")
    print("=" * 78)
    for n in ENTRIES:
        g = [t for t in trades if t["target_n"] == n]
        if not g:
            continue
        print(f"  --- entry {n}d out " + "-" * 40)
        print(describe([t["ret_mid"] for t in g], "mid-to-mid return"))
        print(describe([t["ret_real"] for t in g], "ask-to-bid return"))

    print("\n" + "=" * 78)
    print("POOLED")
    print("=" * 78)
    print(describe([t["ret_mid"] for t in trades], "mid-to-mid return"))
    print(describe([t["ret_real"] for t in trades], "ask-to-bid return"))
    sp = [abs(t["spot_move"]) for t in trades]
    if sp:
        print(f"\n  median |spot move| over the hold: {st.median(sp)*100:.2f}%")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
