#!/usr/bin/env python3
"""Daily swing scan: manage open positions, then look for new ones.

Run from the repo root:  python3 scripts/run_swing.py [NQ ES ...]
State:  data/swing_alerts.json  — IN THE REPO, deliberately.

The previous incarnation of this kept its log at ~/.trading_alerts_log.json. Every run
gets a fresh container, so the home directory was empty each time: entries were written,
the container was reclaimed, and the next run found nothing to manage. No T1 alert and no
stop alert ever fired, and nothing about that was visible from the outside — the scan
looked like it was working because the entry side still printed. Committing the state to
git is what makes exits possible at all.

Exits are processed BEFORE entries so a stop and a fresh signal on the same asset in the
same run cannot be confused, and so `no unresolved pending alert` is evaluated against a
log that is already up to date.
"""
import json
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

import swing as S

LOG = ROOT / "data" / "swing_alerts.json"
ASSETS = ["NQ", "ES", "YM", "GC", "SI", "BTC", "ETH"]


def load():
    if LOG.exists():
        try:
            return json.loads(LOG.read_text() or "[]")
        except json.JSONDecodeError:
            pass
    return []


def save(rows):
    LOG.parent.mkdir(parents=True, exist_ok=True)
    LOG.write_text(json.dumps(rows, indent=2, default=str))


def reached(row, bar, key):
    """Has `bar` traded through the level in `key`, in the trade's favour?"""
    lvl = row.get(key)
    if lvl is None:
        return False
    return bar["High"] >= lvl if row["dir"] == "LONG" else bar["Low"] <= lvl


def stopped(row, bar, stop):
    return bar["Low"] <= stop if row["dir"] == "LONG" else bar["High"] >= stop


def manage(rows, pushes):
    """Walk each pending alert forward bar by bar and resolve it."""
    for row in rows:
        if row.get("status") != "pending":
            continue
        try:
            df = S.bars(row["symbol"], "1y")
        except Exception as e:
            print(f"[{row['symbol']}] manage failed: {str(e)[:60]}")
            continue

        since = df[df.index > row["logged_at"][:10]]
        if not len(since):
            continue

        stop_eff = row.get("stop_effective", row["stop"])
        for ts, b in since.iterrows():
            bar = dict(High=float(b["High"]), Low=float(b["Low"]))
            # Stop is checked FIRST within a bar. Daily data cannot say whether the high
            # or the low came first, and assuming the target led would quietly book a
            # breakeven every time a stop-out also tagged T1 intraday — flattering the
            # log with an ordering the data does not support.
            if stopped(row, bar, stop_eff):
                hit_t1 = row.get("t1_hit")
                row["status"] = "BE" if hit_t1 else "stop"
                row["r_mult"] = 0.0 if hit_t1 else -1.0
                row["closed_at"] = ts.strftime("%Y-%m-%d")
                row["exit"] = stop_eff
                pushes.append(
                    f"{row['symbol']} SWING {'STOPPED AT BREAKEVEN' if hit_t1 else 'STOP HIT'} "
                    f"@ {round(stop_eff, 2)} ({'0R' if hit_t1 else '-1R'})")
                break

            if reached(row, bar, "t2"):
                row["status"] = "T2"
                row["r_mult"] = row.get("rr2")
                row["closed_at"] = ts.strftime("%Y-%m-%d")
                row["exit"] = row["t2"]
                pushes.append(f"{row['symbol']} SWING T2 HIT @ {row['t2']} "
                              f"(+{row.get('rr2')}R)")
                break

            if reached(row, bar, "t1") and not row.get("t1_hit"):
                row["t1_hit"] = True
                row["t1_hit_at"] = ts.strftime("%Y-%m-%d")
                stop_eff = row["entry"]
                row["stop_effective"] = stop_eff
                pushes.append(f"{row['symbol']} SWING T1 HIT @ {row['t1']} "
                              f"(+{row.get('rr1')}R) — move stop to breakeven {row['entry']}")

        if row.get("status") == "pending" and len(since) > S.TIMEOUT_BARS:
            row["status"] = "timeout"          # no push: nothing happened, by definition
            row["closed_at"] = since.index[-1].strftime("%Y-%m-%d")
    return rows


def main():
    syms = [s.upper() for s in sys.argv[1:]] or ASSETS
    rows = load()
    if not LOG.exists():
        save(rows)

    pushes = []
    rows = manage(rows, pushes)
    save(rows)

    open_syms = {r["symbol"] for r in rows if r.get("status") == "pending"}
    fired = []

    for sym in syms:
        try:
            a = S.analyse(sym)
        except Exception as e:
            print(f"[{sym}] failed: {str(e)[:70]}")
            continue
        if a.get("error"):
            print(f"[{sym}] {a['error']}")
            continue

        print(f"[{sym}] {a['bar_date']} {a['price']:.2f} {a['bias']} | "
              f"CS {a['near_cs']} trig {a['trigger']} | "
              f"stop {a['stop']:.2f} T1 {a['t1']} T2 {a['t2']} | "
              f"RR {a['rr1']}/{a['rr2']}")

        if not a["qualifies"]:
            continue
        if sym in open_syms:
            print(f"   skipped: {sym} already has an open pending alert")
            continue

        e = dict(symbol=sym, dir=a["bias"], status="pending",
                 logged_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                 bar_date=a["bar_date"], entry=round(a["entry"], 2),
                 stop=round(a["stop"], 2), stop_effective=round(a["stop"], 2),
                 t1=round(a["t1"], 2) if a["t1"] else None,
                 t2=round(a["t2"], 2) if a["t2"] else None,
                 rr1=a["rr1"], rr2=a["rr2"], cs=a["near_cs"],
                 trigger=a["trigger"], atr=round(a["atr"], 2),
                 t1_hit=False, r_mult=None)
        rows.append(e)
        open_syms.add(sym)

        tag = " — BOS — weaker on daily" if a["trigger"] == "BOS" else ""
        warn = f" {a['warn']}" if a.get("warn") else ""
        fired.append(f"{sym} SWING {a['bias']} @ {e['entry']} stop {e['stop']} "
                     f"T1 {e['t1']} ({a['rr1']}R) CS {a['near_cs']}{tag}{warn}")

    save(rows)
    pushes.extend(fired)

    still = sum(1 for r in rows if r.get("status") == "pending")
    print(f"\n[log] {len(rows)} total, {still} pending")
    for p in pushes:
        print(f"PUSH: {p}")
    if not pushes:
        print("PUSH: (none)")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
