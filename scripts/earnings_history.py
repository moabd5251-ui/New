"""Historical earnings report dates for the backtests.

The live scanner only ever needs the NEXT report date, which calendarEvents gives.
A backtest needs the ones already past, and those come from earningsChart.quarterly,
which carries a reportedDate per quarter. Four quarters per name is the limit of what
is served, so sample size has to come from breadth of universe rather than depth of
history.

Dates are the report DATE, not the session the market reacted in. A company reporting
after the close on the 30th is traded on the 31st, and the vol ramp exits before the
announcement — so which side of the close the report lands on decides whether the last
holdable session is the 30th or the 29th. That distinction is resolved in the study,
not here; this module reports what the vendor says and nothing more.
"""
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import feed

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "earnings_dates.json"

# Liquid, optionable, and heavily traded around earnings — the universe the ramp
# strategy screens. Breadth matters here: four quarters per name means the event
# count is driven almost entirely by how many names are in this list.
UNIVERSE = [
    "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "AMD", "NFLX", "AVGO",
    "CRM", "ADBE", "ORCL", "INTC", "QCOM", "MU", "TXN", "AMAT", "LRCX", "KLAC",
    "JPM", "BAC", "GS", "MS", "WFC", "C", "V", "MA", "AXP", "PYPL",
    "WMT", "COST", "TGT", "HD", "LOW", "NKE", "SBUX", "MCD", "DIS", "CMCSA",
    "UNH", "JNJ", "PFE", "MRK", "ABBV", "LLY", "TMO", "ABT", "CVS", "AMGN",
    "XOM", "CVX", "COP", "SLB", "OXY", "BA", "CAT", "DE", "GE", "HON",
    "UBER", "ABNB", "SHOP", "SQ", "SNAP", "PINS", "ROKU", "COIN", "PLTR", "SMCI",
    "T", "VZ", "PG", "KO", "PEP", "MDLZ", "CL", "GIS", "F", "GM",
]


def _reported_dates(sym):
    """[(date, surprise_pct)] from earningsChart.quarterly, oldest first."""
    p = feed.provider()
    s, cr = p._session()
    r = s.get(f"https://query1.finance.yahoo.com/v10/finance/quoteSummary/{sym}",
              params={"modules": "earnings,calendarEvents", "crumb": cr}, timeout=25)
    r.raise_for_status()
    res = r.json()["quoteSummary"]["result"][0]
    out = []
    for q in (res.get("earnings", {}).get("earningsChart", {}).get("quarterly") or []):
        raw = (q.get("reportedDate") or {}).get("raw")
        if not raw:
            continue
        sp = q.get("surprisePct")
        try:
            sp = float(sp)
        except (TypeError, ValueError):
            sp = None
        out.append((datetime.fromtimestamp(raw, timezone.utc).strftime("%Y-%m-%d"), sp))
    return sorted(set(out))


def collect(universe=None, refresh=False, verbose=True):
    """{symbol: [{date, surprise_pct}]} for the universe, cached to disk."""
    if CACHE.exists() and not refresh:
        try:
            return json.loads(CACHE.read_text())
        except json.JSONDecodeError:
            pass
    universe = universe or UNIVERSE
    out, failed = {}, []
    for i, sym in enumerate(universe, 1):
        try:
            rows = _reported_dates(sym)
            if rows:
                out[sym] = [{"date": d, "surprise_pct": s} for d, s in rows]
        except Exception as e:
            failed.append((sym, str(e)[:40]))
        if verbose and i % 20 == 0:
            print(f"  [{i}/{len(universe)}] {sum(len(v) for v in out.values())} events")
        time.sleep(0.3)
    if verbose and failed:
        print(f"  failed: {failed}")
    CACHE.write_text(json.dumps(out, indent=2))
    return out


def events(start=None, end=None, universe=None, refresh=False):
    """Flat [(symbol, date, surprise_pct)] inside an optional date window."""
    data = collect(universe, refresh)
    rows = [(s, r["date"], r["surprise_pct"]) for s, v in data.items() for r in v]
    if start:
        rows = [r for r in rows if r[1] >= start]
    if end:
        rows = [r for r in rows if r[1] <= end]
    return sorted(rows, key=lambda r: (r[1], r[0]))


if __name__ == "__main__":
    ev = events(refresh=True)
    print(f"\n{len(ev)} events across {len({e[0] for e in ev})} names")
    print(f"range: {ev[0][1]} .. {ev[-1][1]}")
