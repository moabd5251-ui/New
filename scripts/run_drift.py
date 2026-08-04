#!/usr/bin/env python3
"""Post-earnings drift orchestrator.

Run from the repo root:  python3 scripts/run_drift.py
Writes:  data/drift.json, drift.html
Prints:  a PUSH: line per new high-conviction setup, and when a held one invalidates.
"""
import json, sys, traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

import feed
import drift as D
import drift_dashboard as DD

STATE = ROOT / "data" / "drift.json"
OUT_HTML = ROOT / "drift.html"


def load_prev():
    if STATE.exists():
        try:
            return {r["symbol"]: r for r in json.loads(STATE.read_text() or "[]")}
        except json.JSONDecodeError:
            return {}
    return {}


def main():
    prev = load_prev()
    ok, state, msg = feed.require_open("post-earnings drift scan")
    if not ok:
        print(f"[guard] {msg}")
        print("PUSH: (none)")
        return

    print("[scan] finding recent earnings reactions")
    rows = D.scan()
    print(f"[scan] {len(rows)} qualifying reactions, "
          f"{sum(1 for r in rows if r['conviction'] == 'HIGH')} high conviction")

    rows = D.attach_structures(rows)
    DD.build(rows, str(OUT_HTML))
    print(f"[dashboard] wrote {OUT_HTML}")

    events = []
    for r in rows:
        sym = r["symbol"]
        fired = set((prev.get(sym) or {}).get("fired") or [])

        if r["conviction"] == "HIGH" and r.get("structures") and "entry" not in fired:
            fired.add("entry")
            s = r["structures"].get("deep_itm") or r["structures"].get("shares")
            events.append(
                f"{sym} drift {r['direction'].lower()}: gapped {r['gap_pct']:+.1f}% on "
                f"{r['vol_ratio']}x vol, {r['state'].lower()}. {s['structure']} {s['legs']}, "
                f"stop {r['stop']} target {r['target']}")

        # a setup we flagged has since been invalidated — say so
        if "entry" in fired and "dead" not in fired and (
                r["gap_filled"] or r["state"] == "STALLING"):
            fired.add("dead")
            why = "gap filled" if r["gap_filled"] else "drift stalled"
            events.append(f"{sym} drift INVALIDATED — {why}, close the position")

        r["fired"] = sorted(fired)

    STATE.write_text(json.dumps(rows, indent=2, default=str))
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
