#!/usr/bin/env python3
"""Orchestrator: regime -> screen -> spreads -> mark open positions -> dashboard + events.

Run from the repo root:  python3 scripts/run_portfolio.py
Writes:  data/positions.json (updated marks), data/latest.json, dashboard.html
Prints:  a PUSH: line per milestone event for the calling routine to notify on.
"""
import json, os, sys, time, traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

import portfolio as P
import stage3 as S3
import mark as M
import dashboard as D

POSITIONS = ROOT / "data" / "positions.json"
LATEST    = ROOT / "data" / "latest.json"
OUT_HTML  = ROOT / "dashboard.html"
MAX_CANDIDATES = 6


def load_positions():
    if POSITIONS.exists():
        try:
            return json.loads(POSITIONS.read_text() or "[]")
        except json.JSONDecodeError:
            return []
    return []


def main():
    events = []

    # ---- Stage 1: regime -------------------------------------------------
    reg = P.regime()
    print(f"[regime] {reg['trend']} | {reg['vol_regime']} "
          f"(VIX {reg['vix']}, {reg['vix_pctile']}th) -> {reg['spread_type']}")

    # ---- Mark open positions FIRST (money already at risk) ---------------
    positions = load_positions()
    for pos in positions:
        if pos.get("status") != "open":
            continue
        pos_updated, evs = M.evaluate(pos)
        pos.update(pos_updated)
        for e in evs:
            events.append(e)
        time.sleep(0.4)
    print(f"[positions] {sum(1 for p in positions if p.get('status')=='open')} open, "
          f"{len(events)} milestone event(s)")

    # ---- Stage 2: screen -------------------------------------------------
    rows, errs = P.screen(regime_bias=reg["tscore"])
    print(f"[screen] {len(rows)} directional setups"
          + (f"; errors: {[e['symbol'] for e in errs]}" if errs else ""))

    # ---- Stage 3: build candidate spreads --------------------------------
    held = {p["symbol"] for p in positions if p.get("status") == "open"}
    picks = [r for r in rows if r["cs"] >= 3 and r["symbol"] not in held][:MAX_CANDIDATES]
    spreads = []
    for p in picks:
        try:
            s = S3.build_spread(p["symbol"], p["bias"], spread_type=reg["spread_type"])
            if s:
                s.update(screen_score=p["score"], cs=p["cs"], drift_atr=p["drift_atr"],
                         rvol=p["rvol"], mom_1m=p["mom_1m"])
                spreads.append(s)
        except Exception as e:
            print(f"[spread] {p['symbol']} failed: {str(e)[:70]}")
        time.sleep(0.5)
    spreads.sort(key=lambda x: -x["rr"])
    print(f"[spreads] {len(spreads)} candidates built")

    # ---- Persist + render ------------------------------------------------
    POSITIONS.write_text(json.dumps(positions, indent=2, default=str))
    LATEST.write_text(json.dumps({"regime": reg, "spreads": spreads,
                                  "generated": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())},
                                 indent=2, default=str))
    D.build(reg, spreads, positions, str(OUT_HTML))
    print(f"[dashboard] wrote {OUT_HTML}")

    # ---- Emit events for the routine to push -----------------------------
    for e in events:
        print(f"PUSH: {e}")
    if not events:
        print("PUSH: (none)")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
