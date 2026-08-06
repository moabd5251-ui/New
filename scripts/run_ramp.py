#!/usr/bin/env python3
"""Pre-earnings volatility ramp orchestrator.

Run from the repo root:  python3 scripts/run_ramp.py
Writes:  data/ramp.json, ramp.html
Prints:  a PUSH: line when a name enters the window worth taking, or when a held
         position reaches its exit date.
"""
import json, sys, traceback
from pathlib import Path
from datetime import datetime, timezone

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

import feed
import earnings as E
import vol_ramp as V
import lotto as LT
import ramp_dashboard as RD

STATE = ROOT / "data" / "ramp.json"
OUT_HTML = ROOT / "ramp.html"


def load_prev():
    if STATE.exists():
        try:
            d = json.loads(STATE.read_text() or "{}")
            return {r["symbol"]: r for r in d.get("rows", [])}
        except json.JSONDecodeError:
            return {}
    return {}


def main():
    prev = load_prev()
    ok, state, msg = feed.require_open("vol ramp scan")
    if not ok:
        print(f"[guard] {msg}")
        print("PUSH: (none)")
        return


    print("[scan] finding names reporting within 45 days")
    rows = E.scan(within_days=45)
    print(f"[scan] {len(rows)} priced")

    print("[ramp] assessing entry windows and structures")
    assessed, meta = V.assess(rows)
    print(f"[ramp] expansion estimate: +{meta.get('ramp')} pts "
          f"(flat {meta.get('base_spread')} -> peak {meta.get('peak_spread')})")

    print("[lotto] building tickets for names reporting within 2 days")
    assessed = LT.attach(assessed, max_days=2)
    n_lot = sum(1 for r in assessed if r.get("lotto"))
    print(f"[lotto] {n_lot} ticket(s) built")

    RD.build(assessed, meta, str(OUT_HTML))
    print(f"[dashboard] wrote {OUT_HTML}")

    events = []
    for r in assessed:
        sym, p = r["symbol"], prev.get(r["symbol"], {})
        fired = set(p.get("fired") or [])

        # a fresh, genuinely worthwhile entry
        if r.get("verdict") == "WORTH TAKING" and r.get("best"):
            key = "entry"
            if key not in fired:
                b = r["best"]
                fired.add(key)
                events.append(f"{sym} vol ramp open: {b['structure'].lower()} {b['legs']}, "
                              f"${b['cost']:.0f}, needs +{b['required_iv_rise']} IV vs +{meta['ramp']} typical. "
                              f"Exit {r['exit_date']}")

        # the exit deadline on something previously flagged
        if "entry" in fired and "exit" not in fired:
            xd = datetime.strptime(r["exit_date"], "%Y-%m-%d").replace(tzinfo=timezone.utc)
            if (xd - datetime.now(timezone.utc)).days <= 1:
                fired.add("exit")
                events.append(f"{sym} EXIT TODAY — close the vol position before "
                              f"{r['date']} earnings, do not hold the report")

        # the ramp got priced in while waiting
        if "entry" in fired and r["window"] == "RAMP STARTED" and "priced" not in fired:
            fired.add("priced")
            events.append(f"{sym} ramp now priced in (term spread {r['iv_term_spread']}) — "
                          f"expansion largely done, consider taking profit")

        # a lotto worth flagging: reports imminently and typically moves far enough
        lot = r.get("lotto")
        if lot and lot.get("verdict") == "LIVE" and not lot.get("too_pricey") and "lotto" not in fired:
            b = lot["best"]
            fired.add("lotto")
            events.append(f"{sym} lotto: {b['structure'].lower()} {b['legs']} ${b['cost']:.0f}, "
                          f"needs {b['required_move']}% vs {r['hist_move']}% typical, "
                          f"{b['payoff_typical']}x if it moves. Held through the report")

        r["fired"] = sorted(fired)

    STATE.write_text(json.dumps({"rows": assessed, "meta": meta}, indent=2, default=str))

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
