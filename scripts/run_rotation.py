#!/usr/bin/env python3
"""Rotation orchestrator: rank markets -> decide the book -> attach LEAPs -> dashboard.

Run from the repo root:  python3 scripts/run_rotation.py [--allocation 25000]
Writes:  data/rotation.json, rotation.html
Prints:  a PUSH: line per open or close for the calling routine to notify on.

The signal half runs on completed daily bars and needs no market-hours guard. Contract
selection does — a LEAP's bid/ask and greeks are meaningless against a closed book — so
the ranking and the decisions are always produced, and only the contracts are skipped
outside the session. A rotation call the user cannot act on until the open is still
worth knowing the night before.
"""
import argparse
import json
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

import feed
import rotation as R
import rotation_dashboard as RD

OUT_HTML = ROOT / "rotation.html"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--allocation", type=float, default=25000,
                    help="capital per held market, for contract sizing")
    a = ap.parse_args()

    print(f"[scan] {len(R.ROTATION_UNIVERSE)} markets, {len(R.PANEL_N)} strategies each"
          if hasattr(R, "PANEL_N") else f"[scan] {len(R.ROTATION_UNIVERSE)} markets")
    res = R.scan()
    if not res["rows"]:
        print("PUSH: (none)")
        return

    ranked = res["ranked"]
    print(f"[rank] {len(ranked)} in an uptrend, {len(res['rows']) - len(ranked)} excluded")
    for r in ranked[:5]:
        print(f"   {r['rank']}. {r['symbol']:5s} {r['exposure_pct']:>4d}%  {r['market']}")

    opens = [x for x in res["actions"] if x["action"] == "OPEN"]
    closes = [x for x in res["actions"] if x["action"] == "CLOSE"]
    holds = [x for x in res["actions"] if x["action"] == "HOLD"]
    print(f"[book] {len(opens)} open, {len(holds)} hold, {len(closes)} close")

    # ---- contracts: only meaningful against a live book ----------------
    ok, state, msg = feed.require_open("LEAP selection")
    if not ok:
        print(f"[contracts] {msg}")
    for act in res["actions"]:
        if act["action"] == "CLOSE" or not ok:
            continue
        try:
            leap = R.pick_leap(act["symbol"])
            if leap:
                act["leap"] = leap
                act["sizing"] = R.size_position(leap, a.allocation)
        except Exception as e:
            act["leap_error"] = str(e)[:70]
            print(f"   [{act['symbol']}] contract selection failed: {str(e)[:60]}")
        time.sleep(0.4)

    res["market_state"] = state
    res["allocation"] = a.allocation
    res["max_positions"] = R.MAX_POSITIONS
    R.save(res)
    RD.build(res, str(OUT_HTML))
    print(f"[dashboard] wrote {OUT_HTML}")

    events = []
    for act in closes:
        events.append(f"ROTATE OUT {act['symbol']} — {act['reason']}. Close the LEAP calls.")
    for act in opens:
        leap = act.get("leap")
        tail = ""
        if leap:
            sz = act.get("sizing") or {}
            tail = (f" — {leap['expiry']} {leap['strike']}C, delta {leap['delta']}, "
                    f"${leap['cost']:,.0f}/contract"
                    + (f", {sz['contracts']} contracts" if sz.get("contracts") else ""))
        events.append(f"ROTATE IN {act['symbol']} ({act.get('market','')}) at "
                      f"{act['exposure_pct']}% exposure{tail}")

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
