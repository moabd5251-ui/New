#!/usr/bin/env python3
"""Earnings orchestrator: scan -> price the event -> build structures -> dashboard.

Run from the repo root:  python3 scripts/run_earnings.py
Writes:  data/earnings.json, earnings.html
Prints:  a PUSH: line per notable event for the calling routine to notify on.
"""
import json, sys, time, traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

import feed
import earnings as E
import event_structures as ES
import earnings_dashboard as ED

STATE = ROOT / "data" / "earnings.json"
OUT_HTML = ROOT / "earnings.html"
WITHIN_DAYS = 30
RICH = 1.25          # implied / historical at or above this = worth selling
CHEAP = 0.85         # at or below this = worth buying


def load_prev():
    if STATE.exists():
        try:
            return {r["symbol"]: r for r in json.loads(STATE.read_text() or "[]")}
        except json.JSONDecodeError:
            return {}
    return {}


def main():
    prev = load_prev()
    ok, state, msg = feed.require_open("earnings premium scan")
    if not ok:
        print(f"[guard] {msg}")
        print("PUSH: (none)")
        return


    print("[scan] finding names reporting within %d days" % WITHIN_DAYS)
    rows = E.scan(within_days=WITHIN_DAYS)
    print(f"[scan] {len(rows)} priced")

    edge = [r for r in rows if r["verdict"] in ("PREMIUM RICH", "PREMIUM CHEAP")]
    print(f"[structures] building for {len(edge)} names with an edge")
    built = {r["symbol"]: r for r in ES.attach_structures(edge, verbose=True)}
    rows = [built.get(r["symbol"], dict(r, has_structure=False)) for r in rows]

    STATE.write_text(json.dumps(rows, indent=2, default=str))
    ED.build(rows, str(OUT_HTML))
    print(f"[dashboard] wrote {OUT_HTML}")

    # ---- Notable events only: a name is new to the window, newly mispriced, or about to report
    events = []
    for r in rows:
        sym, p = r["symbol"], prev.get(r["symbol"])
        ratio = r.get("premium_ratio")

        # reports within 48h and the premium is actionable
        if r["days"] <= 2 and r["verdict"] in ("PREMIUM RICH", "PREMIUM CHEAP") and r.get("has_structure"):
            key = f"{sym}:imminent"
            if not p or key not in (p.get("fired") or []):
                when = "today" if r["days"] == 0 else ("tomorrow" if r["days"] == 1 else f"in {r['days']}d")
                events.append((key, sym,
                    f"{sym} reports {when} — {r['verdict'].split()[1].lower()} premium "
                    f"({r['implied_move']}% implied vs {r['hist_move']}% typical), {r['structure'].lower()} ready"))

        # crossed into rich/cheap since the last run
        if p and ratio is not None and p.get("premium_ratio") is not None:
            was, now = p["premium_ratio"], ratio
            if was < RICH <= now:
                events.append((f"{sym}:turned_rich", sym,
                    f"{sym} event premium turned rich ({now}x) — implied {r['implied_move']}% vs {r['hist_move']}% typical"))
            elif was > CHEAP >= now:
                events.append((f"{sym}:turned_cheap", sym,
                    f"{sym} event premium turned cheap ({now}x) — implied {r['implied_move']}% vs {r['hist_move']}% typical"))

    # carry the fired-keys forward so each event notifies once
    fired_by_sym = {}
    for key, sym, _ in events:
        fired_by_sym.setdefault(sym, []).append(key)
    for r in rows:
        old = (prev.get(r["symbol"], {}) or {}).get("fired") or []
        r["fired"] = sorted(set(old) | set(fired_by_sym.get(r["symbol"], [])))
    STATE.write_text(json.dumps(rows, indent=2, default=str))

    for _, _, msg in events:
        print(f"PUSH: {msg}")
    if not events:
        print("PUSH: (none)")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
