#!/usr/bin/env python3
"""Read TrendCompass PDFs into the two views that are worth reading.

Their report is 19 instruments x an exposure percentage, refreshed daily. Read
line by line it produces three to six changes a day, almost none of which mean
anything on their own: in the week of 11-18 Aug 2026 the Bund went -100% -> -20%
-> -100% on a price move of -0.94%, and USD/JPY dropped 80 points of exposure on
a price move of +0.08%. Those are the models disagreeing, not the market moving.

Two views survive that noise.

BREADTH — the mean exposure across all 19, as one number tracked over time. It
is the aggregate that individual whipsaws cancel out of. On 17->18 Aug the
long/short COUNT was unchanged at 10/9 while breadth fell from -4.2% to -15.8%;
the count said nothing happened and the count was wrong.

RANKING — who sits at +100% against who sits at +20%, read across instruments
rather than down the page. This matters because cross-sectional use is the only
use with backtested support in this repo: ranking markets and concentrating in
the strongest returned +13.73% CAGR at Sharpe 0.76, while the same signals used
as a per-asset long/short timing overlay were positive in only 7 of 18 markets
over ten years. Their levels are probably noise; their ordering may not be.

NOTHING HERE IS VALIDATED. No one has established that TrendCompass adds
anything to your own book. `journal` exists so that question can eventually be
answered with a forward record instead of an argument about one week of gold.

Usage:
    python3 scripts/trendcompass.py REPORT.pdf [REPORT2.pdf ...]
    python3 scripts/trendcompass.py --journal REPORT.pdf   # append to the record
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JOURNAL = ROOT / "data" / "trendcompass.json"

# Their instruments grouped by what actually drives them. Group breadth localises
# a move: on 18 Aug the whole shift was European equity and European rates, which
# a single all-19 number blurs.
GROUP = {
    "CASH DJIA": "Equity", "CME Nasdaq 100": "Equity", "CME S&P500": "Equity",
    "CME Russell 2000": "Equity", "CME Nikkei 225 (USD)": "Equity",
    "EUREX DAX": "Equity", "EURONEXT FTSE 100": "Equity",
    "CBT US 10-year T-Note": "Rates", "CBT US 30-yr T-Bond": "Rates",
    "EUREX German Bund": "Rates", "EURONEXT Gilt": "Rates",
    "ME Canada 10 Yr Govt Bond": "Rates", "OSE Japan Gov't Bond": "Rates",
    "CASH EUR/USD": "FX", "CASH GBP/USD": "FX", "CASH USD/JPY": "FX",
    "CME USD:CHF": "FX",
    "COMEX Gold": "Commodity", "CME Bitcoin": "Crypto",
}

# Where an instrument has a counterpart in this repo's trend book. FXY is LONG YEN
# while USD/JPY is long dollar against yen, so its sign must flip before the two
# are ever compared — the single easiest way to misread the two books together.
MINE = {
    "CASH DJIA": ("DIA", 1), "CME Nasdaq 100": ("QQQ", 1), "CME S&P500": ("SPY", 1),
    "CME Russell 2000": ("IWM", 1), "CME Nikkei 225 (USD)": ("EWJ", 1),
    "EUREX DAX": ("EWG", 1), "EURONEXT FTSE 100": ("EWU", 1),
    "CBT US 10-year T-Note": ("IEF", 1), "CBT US 30-yr T-Bond": ("TLT", 1),
    "COMEX Gold": ("GLD", 1), "CME Bitcoin": ("IBIT", 1),
    "CASH EUR/USD": ("FXE", 1),
    "CASH USD/JPY": ("FXY", -1),          # inverted: long USD/JPY == short yen
}

# Instruments whose book runs on 5 strategies rather than 10, so each member is
# worth 20 points instead of 10. Their changes are not more frequent — that was
# tested and is false — but each one is twice the size, so a 20-point move here
# is one model, not a consensus shifting.
SMALL_PANEL = {"CBT US 10-year T-Note", "CBT US 30-yr T-Bond",
               "EUREX German Bund", "COMEX Gold"}


def parse(path):
    """Instrument -> dict(date, price, exposure, change). Needs pypdf."""
    from pypdf import PdfReader
    r = PdfReader(str(path))
    txt = "\n".join((p.extract_text() or "") for p in r.pages[:3])
    L = [l.strip() for l in txt.split("\n") if l.strip()]
    out = {}
    for i, l in enumerate(L):
        if i + 1 < len(L) and re.match(r"^\d{1,2} \w+\. \d{4}$", L[i + 1]):
            f = L[i + 2:i + 10]
            if len(f) < 8:
                continue
            try:
                exp = int(f[7].replace("%", "").strip())
            except ValueError:
                continue
            out[l] = dict(date=L[i + 1], price=f[1], exposure=exp, change=f[5],
                          group=GROUP.get(l, "?"), small=l in SMALL_PANEL)
    return out


def breadth(rows):
    """The regime view: one number overall, plus one per group."""
    v = [r["exposure"] for r in rows.values()]
    g = {}
    for name, r in rows.items():
        g.setdefault(r["group"], []).append(r["exposure"])
    return dict(
        n=len(v), mean=sum(v) / len(v),
        longs=sum(1 for x in v if x > 0), shorts=sum(1 for x in v if x < 0),
        flats=sum(1 for x in v if x == 0),
        extreme=sum(1 for x in v if abs(x) >= 80),
        groups={k: sum(x) / len(x) for k, x in sorted(g.items())})


def show_breadth(rows, label, prev=None):
    b = breadth(rows)
    d = ""
    if prev:
        pb = breadth(prev)
        d = f"   ({b['mean'] - pb['mean']:+.1f} vs prior)"
    print(f"\nBREADTH — {label}{d}")
    print(f"  overall {b['mean']:+6.1f}%   {b['longs']}L / {b['shorts']}S / "
          f"{b['flats']}flat   {b['extreme']} of {b['n']} at |80%|+")
    for k, v in b["groups"].items():
        bar = "#" * int(abs(v) / 10)
        print(f"    {k:10} {v:+6.1f}%  {bar}")


def show_ranking(rows, label):
    """The cross-sectional view — ordering, not levels."""
    print(f"\nRANKING — {label}")
    order = sorted(rows.items(), key=lambda kv: -kv[1]["exposure"])
    n = len(order)
    for i, (name, r) in enumerate(order):
        q = "TOP" if i < n / 4 else ("BOT" if i >= 3 * n / 4 else "   ")
        tag = " (5-strat)" if r["small"] else ""
        mine = MINE.get(name)
        m = f"  ~ {mine[0]}{'  INVERTED' if mine[1] < 0 else ''}" if mine else ""
        print(f"  {q} {r['exposure']:+5}%  {name:26}{tag:11}{m}")
    print("  TOP/BOT mark the strongest and weakest quartile. Use the ORDER; the"
          "\n  levels are the part with no evidence behind them.")


def journal(rows, path):
    """Append this report to the forward record, keyed by its close date."""
    rec = json.loads(JOURNAL.read_text()) if JOURNAL.exists() else []
    date = next(iter(rows.values()))["date"]
    if any(r["close_date"] == date for r in rec):
        print(f"[journal] {date} already recorded — not duplicated")
        return rec
    b = breadth(rows)
    rec.append(dict(close_date=date, source=Path(path).name,
                    breadth=round(b["mean"], 2), longs=b["longs"],
                    shorts=b["shorts"], groups={k: round(v, 2)
                                                for k, v in b["groups"].items()},
                    exposures={k: r["exposure"] for k, r in rows.items()},
                    prices={k: r["price"] for k, r in rows.items()}))
    rec.sort(key=lambda r: r["close_date"])
    JOURNAL.parent.mkdir(parents=True, exist_ok=True)
    JOURNAL.write_text(json.dumps(rec, indent=2))
    print(f"[journal] recorded {date} — {len(rec)} reports on file")
    return rec


def main():
    args = sys.argv[1:]
    do_journal = "--journal" in args
    paths = [a for a in args if not a.startswith("--")]
    if not paths:
        print(__doc__)
        return
    prev = None
    for p in paths:
        rows = parse(p)
        if not rows:
            print(f"[{p}] no instruments parsed")
            continue
        label = f"{next(iter(rows.values()))['date']} close"
        show_breadth(rows, label, prev)
        if len(paths) == 1:
            show_ranking(rows, label)
        if do_journal:
            journal(rows, p)
        prev = rows


if __name__ == "__main__":
    main()
