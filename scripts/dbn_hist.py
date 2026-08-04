"""Databento historical access for options research — costed, cached, and retried.

This is deliberately NOT a feed.py provider. The provider layer answers "what is the
market right now" and every provider there publishes a live chain and an earnings
calendar. Databento serves neither: it is a historical tape of quotes and trades with
no implied vol, no greeks, and no corporate calendar. Pretending it satisfies the same
interface would let live code silently fetch history. It gets its own module instead,
and the strategies keep using feed.py for anything live.

Two properties matter more than convenience here:

  COST. OPRA is billed by volume, and the difference between a careless query and a
  careful one is three orders of magnitude — a month of every AAPL contract is $6.70,
  while the twenty contracts a study actually reads is $0.024. Every uncached fetch is
  priced first and refused above a per-call ceiling unless the caller raises it
  explicitly. Spend is logged so a backtest can report what it cost.

  CACHING. A backtest gets re-run as it is debugged. Without a cache each re-run re-bills
  the identical query, so the second run of a $12 study costs another $12. Results are
  written to disk keyed by the query, and a cache hit costs nothing.
"""
import hashlib
import json
import os
import time
from datetime import date, datetime, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "cache" / "dbn"
SPEND = ROOT / "data" / "cache" / "dbn_spend.json"

OPRA = "OPRA.PILLAR"
EQUITY = "EQUS.SUMMARY"          # consolidated US equities, one bar per symbol per day

# A single query above this is refused unless the caller passes max_cost explicitly.
# Sized so an ordinary per-event pull sails through and a fat-fingered parent-symbol
# query — the $6.70/name/month mistake — stops before it bills.
DEFAULT_MAX_COST = 0.25

_client = None


def client():
    global _client
    if _client is None:
        import databento as db
        if not os.environ.get("DATABENTO_API_KEY"):
            raise RuntimeError("DATABENTO_API_KEY is not set")
        _client = db.Historical()
    return _client


# ---------------------------------------------------------------- symbology
def osi(root, expiry, kind, strike):
    """OPRA raw symbol: 6-char padded root, YYMMDD, C/P, strike x1000 in 8 digits.

        osi("AAPL", "2026-09-18", "call", 210) -> 'AAPL  260918C00210000'
    """
    if isinstance(expiry, (datetime, date)):
        expiry = expiry.strftime("%Y-%m-%d")
    ymd = expiry.replace("-", "")[2:]
    cp = "C" if str(kind).lower().startswith("c") else "P"
    return f"{root.upper():<6}{ymd}{cp}{int(round(float(strike) * 1000)):08d}"


def parse_osi(sym):
    """Inverse of osi(). Returns (root, expiry 'YYYY-MM-DD', 'call'|'put', strike)."""
    root = sym[:6].strip()
    ymd, cp, strike = sym[6:12], sym[12], sym[13:]
    return (root, f"20{ymd[:2]}-{ymd[2:4]}-{ymd[4:]}",
            "call" if cp == "C" else "put", int(strike) / 1000.0)


# ---------------------------------------------------------------- spend log
def _log_spend(cost, label):
    try:
        rec = json.loads(SPEND.read_text()) if SPEND.exists() else {"total": 0.0, "calls": []}
    except json.JSONDecodeError:
        rec = {"total": 0.0, "calls": []}
    rec["total"] = round(rec["total"] + cost, 6)
    rec["calls"].append({"at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                         "cost": round(cost, 6), "query": label})
    rec["calls"] = rec["calls"][-500:]
    SPEND.parent.mkdir(parents=True, exist_ok=True)
    SPEND.write_text(json.dumps(rec, indent=2))
    return rec["total"]


def spend_total():
    try:
        return json.loads(SPEND.read_text())["total"]
    except Exception:
        return 0.0


# ---------------------------------------------------------------- transport
def _retry(fn, tries=5, base=2.0):
    """Databento's gateway returns an intermittent 504 on the first call of a query;
    the identical request succeeds on retry. Not retrying makes queries look broken
    when they are merely slow to warm."""
    last = None
    for i in range(tries):
        try:
            return fn()
        except Exception as e:
            last = e
            if "504" not in str(e) and "timed out" not in str(e).lower():
                raise
            time.sleep(base ** i)
    raise last


def estimate(**kw):
    """Dollar cost of a query, without running it."""
    return float(_retry(lambda: client().metadata.get_cost(**kw)))


def _key(kw):
    return hashlib.sha1(json.dumps(kw, sort_keys=True, default=str).encode()).hexdigest()[:20]


def fetch(dataset, schema, symbols, start, end, stype_in="raw_symbol",
          max_cost=DEFAULT_MAX_COST, label=None, use_cache=True):
    """Costed, cached timeseries pull. Returns a DataFrame (empty if no records).

    Raises RuntimeError when the query prices above max_cost, naming the figure, so a
    runaway request fails loudly instead of quietly billing.
    """
    kw = dict(dataset=dataset, schema=schema, symbols=sorted(symbols),
              stype_in=stype_in, start=str(start), end=str(end))
    path = CACHE / f"{schema}_{_key(kw)}.parquet"
    if use_cache and path.exists():
        return pd.read_parquet(path)

    label = label or f"{dataset}/{schema} {len(symbols)}sym {start}..{end}"
    cost = estimate(**kw)
    if cost > max_cost:
        raise RuntimeError(
            f"query would cost ${cost:.4f}, above the ${max_cost:.4f} ceiling — {label}. "
            f"Narrow the symbols or date range, or pass max_cost to override.")

    data = _retry(lambda: client().timeseries.get_range(**kw))
    df = data.to_df()
    _log_spend(cost, label)
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(path)
    return df


# ---------------------------------------------------------------- accessors
def definitions(symbol, on, max_cost=DEFAULT_MAX_COST):
    """Every listed contract for one underlying on one date: strike, expiry, type.

    Cheap (~$0.006) and the only way to know which contracts existed at a past date.
    Guessing strikes instead produces symbols that never listed, which come back empty
    and look like missing data.
    """
    df = fetch(OPRA, "definition", [f"{symbol}.OPT"], f"{on}T00:00", f"{on}T13:00",
               stype_in="parent", max_cost=max_cost, label=f"definitions {symbol} {on}")
    if df.empty:
        return df
    out = pd.DataFrame({
        "raw_symbol": df["raw_symbol"].astype(str).str.strip().values,
        "strike": df["strike_price"].astype(float).values,
        "expiry": pd.to_datetime(df["expiration"]).dt.strftime("%Y-%m-%d").values,
        "kind": df["instrument_class"].map({"C": "call", "P": "put"}).values,
    }).drop_duplicates("raw_symbol")
    # definition rows carry the padded OSI symbol; keep it padded for requerying
    out["osi"] = [osi(symbol, e, k, s) for e, k, s in
                  zip(out["expiry"], out["kind"], out["strike"])]
    return out.reset_index(drop=True)


def option_quotes(raw_symbols, start, end, max_cost=DEFAULT_MAX_COST):
    """Daily closing quote per contract, from trades stamped with the NBBO.

    Uses tcbbo rather than ohlcv-1d on purpose. A daily bar's close is the last PRINT,
    which on a thin strike can be hours old and off the market by a wide margin. tcbbo
    carries the consolidated bid/ask standing at the moment of each trade, so the mid
    is a quote that existed rather than a price someone once paid.

    Returns columns: date, raw_symbol, bid, ask, mid, last, volume, n_trades.
    """
    if not len(raw_symbols):
        return pd.DataFrame()
    df = fetch(OPRA, "tcbbo", list(raw_symbols), start, end, max_cost=max_cost,
               label=f"quotes {len(raw_symbols)}sym {start}..{end}")
    if df.empty:
        return pd.DataFrame()
    d = df.reset_index()
    ts = "ts_recv" if "ts_recv" in d.columns else "ts_event"
    d["date"] = pd.to_datetime(d[ts]).dt.tz_convert("America/New_York").dt.strftime("%Y-%m-%d")
    d["raw_symbol"] = d["symbol"].astype(str).str.strip()
    d = d.sort_values(ts)

    g = d.groupby(["date", "raw_symbol"], sort=False)
    out = g.agg(bid=("bid_px_00", "last"), ask=("ask_px_00", "last"),
                last=("price", "last"), volume=("size", "sum"),
                n_trades=("price", "size")).reset_index()
    # A crossed or one-sided NBBO is not a usable mid; fall back to the print.
    ok = (out["bid"] > 0) & (out["ask"] > 0) & (out["ask"] >= out["bid"])
    out["mid"] = (out["bid"] + out["ask"]) / 2.0
    out.loc[~ok, "mid"] = out.loc[~ok, "last"]
    out["quoted"] = ok
    return out


def equity_daily(symbols, start, end, max_cost=DEFAULT_MAX_COST):
    """Consolidated daily OHLCV for the underlyings. Columns: date, symbol, open..close, volume."""
    df = fetch(EQUITY, "ohlcv-1d", list(symbols), start, end, max_cost=max_cost,
               label=f"equity {len(symbols)}sym {start}..{end}")
    if df.empty:
        return pd.DataFrame()
    d = df.reset_index()
    ts = "ts_event" if "ts_event" in d.columns else "ts_recv"
    # Daily bars are stamped midnight UTC ON the session date, so the UTC date is already
    # the trading day. Converting to New York rolls every bar back to the prior calendar
    # day — which silently turns Monday sessions into Sundays and misaligns option quotes
    # (genuinely intraday, and correctly converted) against their own underlying.
    d["date"] = pd.to_datetime(d[ts]).dt.strftime("%Y-%m-%d")
    return d[["date", "symbol", "open", "high", "low", "close", "volume"]]
