#!/usr/bin/env python3
"""ETF trend orchestrator: scan the panel -> diff against the last run -> dashboard + events.

Run from the repo root:  python3 scripts/run_trend.py
Writes:  data/trend.json, trend.html
Prints:  a PUSH: line per exposure change for the calling routine to notify on.

No market-hours guard. Every signal comes from the last completed daily session, so this
is valid on a Sunday and unaffected by an empty options book — unlike the earnings and
spread pipelines, which read live chains and have to refuse to run outside the session.
"""
import json
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

import trend as T
import trend_dashboard as TD

STATE = ROOT / "data" / "trend.json"
OUT_HTML = ROOT / "trend.html"

# Only notify on a move of at least this many points. Every scan re-votes ten strategies,
# so a single model flickering in and out of its dead band would otherwise push a message
# a day about a 10% change that carries no information.
NOTIFY_MIN_CHANGE = 20


def load_prev():
    if STATE.exists():
        try:
            d = json.loads(STATE.read_text() or "{}")
            return {r["symbol"]: r for r in d.get("rows", [])}, d.get("asof")
        except json.JSONDecodeError:
            pass
    return {}, None


def main():
    prev, prev_asof = load_prev()

    print(f"[scan] {len(T.UNIVERSE)} ETFs, {len(T.PANEL)} strategies each")
    rows, errs = T.scan()
    print(f"[scan] {len(rows)} priced" + (f", {len(errs)} failed" if errs else ""))
    if not rows:
        print("PUSH: (none)")
        return

    rows = T.diff(rows, prev)
    asof = rows[0]["asof"]

    long_n = sum(1 for r in rows if r["exposure_pct"] > 0)
    short_n = sum(1 for r in rows if r["exposure_pct"] < 0)
    print(f"[book] {long_n} long, {short_n} short, "
          f"avg {round(sum(r['exposure_pct'] for r in rows)/len(rows)):+d}%")

    TD.build(rows, str(OUT_HTML), errors=errs, n_strategies=len(T.PANEL))
    print(f"[dashboard] wrote {OUT_HTML}")

    STATE.write_text(json.dumps(
        {"asof": asof, "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
         "rows": rows, "errors": errs}, indent=2, default=str))

    # Nothing closed since the last run means nothing can have changed; re-notifying the
    # same signals would train the user to ignore the alerts.
    if prev_asof and prev_asof == asof:
        print(f"[events] no new session since {asof} — nothing to notify")
        print("PUSH: (none)")
        return

    events = []
    for r in sorted(rows, key=lambda x: -abs(x.get("change_pct") or 0)):
        ch = r.get("change_pct")
        if ch is None or abs(ch) < NOTIFY_MIN_CHANGE:
            continue
        events.append(
            f"{r['symbol']} ({r['market']}) {r['action'].lower()}: "
            f"{r['prev_pct']:+d}% -> {r['exposure_pct']:+d}% "
            f"({r['longs']}L/{r['shorts']}S/{r['neutrals']}N at {r['price']:,.2f})")

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
