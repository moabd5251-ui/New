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
RETRYABLE = ("502", "503", "504", "timed out", "timeout", "bad gateway",
             "connection", "temporarily")


def _retryable(e):
    s = str(e).lower()
    return (not s.strip()) or any(t in s for t in RETRYABLE)


def _retry(fn, tries=8, base=1.7, cap=20.0):
    """Databento's gateway sheds load on heavy queries, returning 502s and 504s that
    clear when the identical request is repeated. A single attempt makes a working
    query look broken, so anything in the 5xx family is retried — including errors
    that arrive with an empty message, which is how a dropped gateway response
    surfaces through the client."""
    last = None
    for i in range(tries):
        try:
            return fn()
        except Exception as e:
            last = e
            if not _retryable(e):
                raise
            time.sleep(min(base ** i, cap))
    raise last


_ranges = {}


def available_end(dataset):
    """Last date the dataset carries, as YYYY-MM-DD.

    Databento rejects the whole query with a 422 when `end` runs past the tape rather
    than returning what it has. A study whose window reaches toward today hits this on
    its most recent events, so ranges are clamped rather than left to fail.
    """
    if dataset not in _ranges:
        r = _retry(lambda: client().metadata.get_dataset_range(dataset=dataset))
        _ranges[dataset] = str(r["end"])[:10]
    return _ranges[dataset]


def clamp_end(dataset, end):
    ae = available_end(dataset)
    return ae if str(end)[:10] > ae else end


def estimate(**kw):
    """Dollar cost of a query, without running it."""
    if "dataset" in kw and "end" in kw:
        kw = dict(kw, end=clamp_end(kw["dataset"], kw["end"]))
    return float(_retry(lambda: client().metadata.get_cost(**kw)))


def _key(kw):
    return hashlib.sha1(json.dumps(kw, sort_keys=True, default=str).encode()).hexdigest()[:20]


# Calibrated against measured queries, and deliberately rounded UP. The guard exists to
# stop a runaway request, so over-estimating costs nothing but a refused query the caller
# can override, while under-estimating bills real money.
#   ohlcv-1d   4,503 recs / $0.1409 over 14 contracts x 35 sessions
#   definition 3,538 recs / $0.0059 for one name-day
RATE_PER_REC = {"ohlcv-1d": 3.2e-5, "definition": 2.0e-6, "cbbo-1m": 3.2e-5,
                "tcbbo": 2.0e-5, "trades": 1.5e-5}
RECS_PER_CONTRACT_SESSION = {"ohlcv-1d": 10, "cbbo-1m": 400, "tcbbo": 900,
                             "trades": 900, "definition": 1}
# A parent query is not one symbol — it is every contract listed on the name. Sizing it
# as a single symbol is exactly how the $6.70 mistake slips past a guard.
PARENT_CONTRACTS = 3500


def predict_cost(dataset, schema, symbols, start, end, stype_in="raw_symbol"):
    """Modelled cost, without an API round trip.

    get_cost is authoritative but slow — often a minute per call, sometimes several
    after gateway retries — which makes it unusable as a per-query guard in a study
    that issues hundreds of them. This approximates it from record counts and is used
    for the cheap majority, with the live estimate reserved for queries big enough
    that being wrong would matter.
    """
    d0 = datetime.strptime(str(start)[:10], "%Y-%m-%d")
    d1 = datetime.strptime(str(end)[:10], "%Y-%m-%d")
    sessions = max(len(pd.bdate_range(d0, d1)), 1)
    n = PARENT_CONTRACTS if stype_in == "parent" and schema != "definition" else len(symbols)
    if schema == "definition":
        n = PARENT_CONTRACTS if stype_in == "parent" else len(symbols)
        recs = n * max(sessions, 1)
    else:
        recs = n * sessions * RECS_PER_CONTRACT_SESSION.get(schema, 50)
    return recs * RATE_PER_REC.get(schema, 3.2e-5)


def fetch(dataset, schema, symbols, start, end, stype_in="raw_symbol",
          max_cost=DEFAULT_MAX_COST, label=None, use_cache=True, verify_above=0.15):
    """Costed, cached timeseries pull. Returns a DataFrame (empty if no records).

    Raises RuntimeError when the query prices above max_cost, naming the figure, so a
    runaway request fails loudly instead of quietly billing.
    """
    kw = dict(dataset=dataset, schema=schema, symbols=sorted(symbols),
              stype_in=stype_in, start=str(start), end=clamp_end(dataset, end))
    path = CACHE / f"{schema}_{_key(kw)}.parquet"
    if use_cache and path.exists():
        return pd.read_parquet(path)

    label = label or f"{dataset}/{schema} {len(symbols)}sym {start}..{end}"
    cost = predict_cost(dataset, schema, kw["symbols"], kw["start"], kw["end"], stype_in)
    how = "model"
    # Only pay the latency of the authoritative estimate when the modelled figure is
    # large enough that being wrong about it matters.
    if cost > verify_above:
        cost, how = estimate(**kw), "api"
    if cost > max_cost:
        raise RuntimeError(
            f"query would cost ${cost:.4f} ({how}), above the ${max_cost:.4f} ceiling — "
            f"{label}. Narrow the symbols or date range, or pass max_cost to override.")

    data = _retry(lambda: client().timeseries.get_range(**kw))
    df = data.to_df()
    _log_spend(cost, f"{label} [{how}]")
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


def option_daily(raw_symbols, start, end, max_cost=DEFAULT_MAX_COST):
    """Daily OHLCV per contract, consolidated across OPRA publishers.

    Used instead of tcbbo for anything spanning weeks. tcbbo carries every print with
    its NBBO, which is the better price but is unbounded in volume: an ATM contract on
    a mega-cap prints thousands of times a day, and a 50-day pull of fourteen such
    contracts prices at $1.15 and times the gateway out entirely. ohlcv-1d is bounded
    at one record per contract per session per publisher, so it is both affordable and
    actually retrievable. The cost is that a daily close is the last PRINT rather than
    a quote — acceptable here because the study deliberately trades ATM contracts on
    the most liquid names, and quantified separately by spread_sample().

    OPRA reports per exchange, so each contract-session arrives once per publisher that
    traded it. Those are consolidated by volume weight rather than picking one, which
    would take whichever exchange happened to sort last.
    """
    if not len(raw_symbols):
        return pd.DataFrame()
    df = fetch(OPRA, "ohlcv-1d", list(raw_symbols), start, end, max_cost=max_cost,
               label=f"opt-daily {len(raw_symbols)}sym {start}..{end}")
    if df.empty:
        return pd.DataFrame()
    d = df.reset_index()
    ts = "ts_event" if "ts_event" in d.columns else "ts_recv"
    d["date"] = pd.to_datetime(d[ts]).dt.strftime("%Y-%m-%d")   # daily bars: UTC date IS the session
    d["raw_symbol"] = d["symbol"].astype(str).str.strip()
    d["volume"] = d["volume"].astype(float)
    d["close"] = d["close"].astype(float)
    d["wt"] = d["volume"].clip(lower=0)

    def consolidate(g):
        w = g["wt"].sum()
        close = (g["close"] * g["wt"]).sum() / w if w > 0 else g["close"].iloc[-1]
        return pd.Series({"close": close, "volume": g["volume"].sum(),
                          "high": g["high"].astype(float).max(),
                          "low": g["low"].astype(float).min(),
                          "n_pub": len(g)})

    out = (d.groupby(["date", "raw_symbol"], sort=False)
             .apply(consolidate, include_groups=False).reset_index())
    return out


def spread_sample(raw_symbols, on, max_cost=DEFAULT_MAX_COST):
    """Closing consolidated NBBO for a single session — bid, ask, mid per contract.

    One day at a time on purpose. The same query across a multi-week range is what
    times the gateway out, and the study only needs enough of these to characterise
    what an ATM earnings straddle costs to cross, not a quote for every session.
    """
    nxt = (datetime.strptime(str(on)[:10], "%Y-%m-%d").date() + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    df = fetch(OPRA, "cbbo-1m", list(raw_symbols), on, nxt, max_cost=max_cost,
               label=f"bbo {len(raw_symbols)}sym {on}")
    if df.empty:
        return pd.DataFrame()
    d = df.reset_index()
    ts = "ts_recv" if "ts_recv" in d.columns else "ts_event"
    d["t"] = pd.to_datetime(d[ts]).dt.tz_convert("America/New_York")
    d["date"] = d["t"].dt.strftime("%Y-%m-%d")
    d["raw_symbol"] = d["symbol"].astype(str).str.strip()
    # keep the regular session only; the closing print is what a trader would cross at
    d = d[(d["t"].dt.hour * 60 + d["t"].dt.minute).between(9 * 60 + 30, 16 * 60)]
    d = d[(d["bid_px_00"] > 0) & (d["ask_px_00"] > 0) & (d["ask_px_00"] >= d["bid_px_00"])]
    if d.empty:
        return pd.DataFrame()
    d = d.sort_values("t")
    out = d.groupby(["date", "raw_symbol"], sort=False).agg(
        bid=("bid_px_00", "last"), ask=("ask_px_00", "last")).reset_index()
    out["mid"] = (out["bid"] + out["ask"]) / 2.0
    out["spread_pct"] = (out["ask"] - out["bid"]) / out["mid"]
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
