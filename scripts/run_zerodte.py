#!/usr/bin/env python3
"""Zero-DTE orchestrator: score yesterday's calls, take today's, render the dashboard.

Run from the repo root:  python3 scripts/run_zerodte.py [SPY QQQ ...]
Writes:  data/zerodte.json, data/zerodte_log.json, zerodte.html

Scoring runs FIRST, before anything new is recorded, so a call is always graded against
a close that already existed when this started. Doing it the other way round would let a
same-session read influence how the previous one is judged.
"""
import json
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

import feed
import portfolio as P
import zerodte as Z
import zerodte_dashboard as ZD
import zerodte_log as L

OUT_HTML = ROOT / "zerodte.html"
STATE = ROOT / "data" / "zerodte.json"


def session_bar(symbol):
    """Today's open/high/low/close from daily bars, or None if today has not printed."""
    try:
        df = feed.bars(symbol, "1d", "5d")
        if df is None or not len(df):
            return None
        last = df.iloc[-1]
        return dict(date=df.index[-1].strftime("%Y-%m-%d"),
                    open=float(last["Open"]), high=float(last["High"]),
                    low=float(last["Low"]), close=float(last["Close"]))
    except Exception:
        return None


def main():
    syms = [s.upper() for s in sys.argv[1:]] or ["SPY", "QQQ"]

    # ---- 1. score anything still open, against bars that already exist -----
    scored = []
    for r in L.load():
        if r.get("scored"):
            continue
        bar = session_bar(r["symbol"])
        if not bar or bar["date"] < r["expiry"]:
            continue                       # that session has not closed yet
        s = L.score(r["symbol"], r["expiry"], bar["close"],
                    bar["open"], bar["high"], bar["low"])
        if s:
            scored.append(s)
    for s in scored:
        mp = "toward" if s.get("maxpain_moved_toward") else "away from"
        print(f"[scored] {s['symbol']} {s['expiry']}: closed {s['close']} — "
              f"{mp} max pain {s['max_pain']}, "
              f"move {s.get('realised_move_pct')}% vs {s.get('expected_move_pct')}% expected")

    # ---- 2. today's read ---------------------------------------------------
    ok, state, msg = feed.require_open("zero-DTE positioning")
    if not ok:
        print(f"[guard] {msg}")
    results = {}
    for sym in syms:
        try:
            a = Z.analyze(sym)
        except Exception as e:
            print(f"[{sym}] failed: {str(e)[:70]}")
            continue
        if a.get("error"):
            print(f"[{sym}] {a['error']}")
            continue
        results[sym] = a
        print(f"[{sym}] {a['expiry']} spot {a['spot']} | GEX ${a['total_gex']/1e9:+.2f}bn "
              f"({a['regime'].split(' —')[0]}) | max pain {a['max_pain']} | "
              f"flip {a['zero_gamma']} | flow {(a.get('flow') or {}).get('bias')}")
        # Only record a call while the session is live; a premarket chain carries
        # yesterday's open interest and no flow, so it is not the same claim.
        if ok:
            bar = session_bar(sym)
            e = L.record(a, session_open=(bar or {}).get("open"))
            if e:
                print(f"   recorded: max pain {e['max_pain']}, magnet {e['top_magnet']}, "
                      f"expected ±{e['expected_move_pct']}%")

    if not results:
        print("PUSH: (none)")
        return

    primary = results.get(syms[0]) or next(iter(results.values()))
    ZD.build(primary, Z.read(primary), str(OUT_HTML))
    STATE.write_text(json.dumps(
        {k: {kk: vv for kk, vv in v.items() if kk != "rows"} for k, v in results.items()},
        indent=2, default=str))
    print(f"[dashboard] wrote {OUT_HTML}")

    s = L.summary()
    if s.get("n"):
        print(f"\n[forward log] {s['n']} scored — max pain toward {s['maxpain_toward_pct']}% "
              f"(n={s['maxpain_n']}), magnet toward {s['magnet_toward_pct']}%, "
              f"inside expected {s['inside_expected_pct']}%")
        if s.get("long_gamma_range_pct") and s.get("short_gamma_range_pct"):
            print(f"[forward log] avg range: long gamma {s['long_gamma_range_pct']}% "
                  f"vs short gamma {s['short_gamma_range_pct']}%")

    print("PUSH: (none)")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
