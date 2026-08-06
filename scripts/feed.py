"""Market data provider layer.

Everything upstream (screener, spread builder, earnings scanner, position marking)
talks to this module and never to a vendor directly, so switching feeds is a config
change rather than a rewrite. Select with the MARKET_DATA_PROVIDER env var:

    MARKET_DATA_PROVIDER=yahoo     (default; free, ~15min delayed, no greeks)
    MARKET_DATA_PROVIDER=tradier   (needs TRADIER_TOKEN; real-time, exchange greeks)

Every provider returns the same normalised shapes:

  bars(sym, interval, rng)      -> DataFrame[Open,High,Low,Close,Volume] + .attrs["live"]
  chain(sym, expiry_ts=None)    -> {"quote": {"regularMarketPrice": float},
                                    "expirationDates": [unix_ts, ...],
                                    "options": [{"calls": [...], "puts": [...]}]}
  earnings(sym)                 -> {"date","days","estimated","beat_rate",...} | None

A normalised option contract always carries:
  contractSymbol, strike, bid, ask, lastPrice, volume, openInterest,
  impliedVolatility (decimal, not percent), and delta/gamma/theta/vega which are
  None when the provider does not publish them (callers fall back to Black-Scholes).
"""
import os, time
from datetime import datetime, timezone
import requests
import pandas as pd

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

GREEK_KEYS = ("delta", "gamma", "theta", "vega")


def _blank_greeks():
    return {k: None for k in GREEK_KEYS}


# --------------------------------------------------------------------------
# Yahoo — the default. Free, roughly 15 minutes delayed, publishes IV but not
# greeks, and its options endpoint needs a cookie + crumb handshake.
# --------------------------------------------------------------------------
class YahooProvider:
    name = "yahoo"
    realtime = False
    publishes_greeks = False

    def __init__(self):
        self._s = None
        self._crumb = None

    def _session(self):
        if self._s is None:
            s = requests.Session()
            s.headers.update({"User-Agent": UA})
            s.get("https://fc.yahoo.com", timeout=15)
            self._crumb = s.get("https://query1.finance.yahoo.com/v1/test/getcrumb",
                                timeout=15).text
            self._s = s
        return self._s, self._crumb

    def bars(self, sym, interval="1d", rng="1y"):
        r = requests.get(f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}",
                         headers={"User-Agent": UA, "Accept": "application/json"},
                         params={"interval": interval, "range": rng}, timeout=25)
        r.raise_for_status()
        res = r.json()["chart"]["result"][0]
        q = res["indicators"]["quote"][0]
        df = pd.DataFrame({"Open": q["open"], "High": q["high"], "Low": q["low"],
                           "Close": q["close"], "Volume": q.get("volume")},
                          index=pd.to_datetime(res["timestamp"], unit="s", utc=True))
        df = df.dropna(subset=["Open", "High", "Low", "Close"])
        df.attrs["live"] = res.get("meta", {}).get("regularMarketPrice")
        return df

    def _norm(self, o):
        """Normalise a contract, falling back to the last trade when the book is closed.

        Yahoo zeroes bid/ask outside market hours. Without a fallback every liquidity
        filter rejects every contract and scans come back silently empty. When that
        happens we price off lastPrice and set stale=True so callers can say so —
        a last trade is not a live quote and the real spread is unknown.
        """
        bid, ask = o.get("bid") or 0, o.get("ask") or 0
        last = o.get("lastPrice") or 0
        stale = False
        if (bid <= 0 or ask <= 0) and last > 0:
            bid = ask = last
            stale = True
        return dict(contractSymbol=o.get("contractSymbol"), strike=o.get("strike"),
                    bid=bid, ask=ask, lastPrice=last, stale=stale,
                    volume=o.get("volume") or 0, openInterest=o.get("openInterest") or 0,
                    impliedVolatility=o.get("impliedVolatility") or 0, **_blank_greeks())

    def chain(self, sym, expiry_ts=None):
        s, cr = self._session()
        p = {"crumb": cr}
        if expiry_ts:
            p["date"] = expiry_ts
        r = s.get(f"https://query1.finance.yahoo.com/v7/finance/options/{sym}",
                  params=p, timeout=25)
        r.raise_for_status()
        d = r.json()["optionChain"]["result"][0]
        opts = d.get("options") or [{"calls": [], "puts": []}]
        market_state = d.get("quote", {}).get("marketState")
        return {"quote": {"regularMarketPrice": d["quote"]["regularMarketPrice"],
                          "marketState": market_state},
                "expirationDates": d.get("expirationDates", []),
                "options": [{"calls": [self._norm(o) for o in opts[0].get("calls", [])],
                             "puts": [self._norm(o) for o in opts[0].get("puts", [])]}]}

    def earnings(self, sym):
        s, cr = self._session()
        r = s.get(f"https://query1.finance.yahoo.com/v10/finance/quoteSummary/{sym}",
                  params={"modules": "calendarEvents,earningsHistory", "crumb": cr}, timeout=20)
        r.raise_for_status()
        res = r.json()["quoteSummary"]["result"][0]
        cal = res.get("calendarEvents", {}).get("earnings", {})
        dates = cal.get("earningsDate") or []
        if not dates or not dates[0].get("raw"):
            return None
        when = datetime.fromtimestamp(dates[0]["raw"], timezone.utc)
        # The most recent report already happened — calendarEvents carries it separately
        # from the next scheduled date, and it is what post-earnings drift keys off.
        call = cal.get("earningsCallDate") or []
        last_report = None
        if call and call[0].get("raw"):
            last_report = datetime.fromtimestamp(call[0]["raw"], timezone.utc)
        hist = res.get("earningsHistory", {}).get("history", []) or []
        sur = [h.get("surprisePercent", {}).get("raw") for h in hist]
        sur = [x for x in sur if x is not None]
        return dict(date=when.strftime("%Y-%m-%d"),
                    days=(when - datetime.now(timezone.utc)).days,
                    last_report=(last_report.strftime("%Y-%m-%d") if last_report else None),
                    days_since_report=((datetime.now(timezone.utc) - last_report).days
                                       if last_report else None),
                    estimated=bool(cal.get("isEarningsDateEstimate")),
                    beat_rate=(round(sum(1 for x in sur if x > 0) / len(sur) * 100) if sur else None),
                    n_quarters=len(sur),
                    avg_surprise=(round(sum(sur) / len(sur) * 100, 1) if sur else None))


# --------------------------------------------------------------------------
# Tradier — real-time chains with exchange-published greeks over plain REST.
# Free market data with a funded brokerage account.
#
# UNTESTED: written against Tradier's documented API but never run here, since
# no token was available. Verify field names against a live response before
# trusting output. Earnings are not served by this endpoint set, so it falls
# back to Yahoo for the calendar.
# --------------------------------------------------------------------------
class TradierProvider:
    name = "tradier"
    realtime = True
    publishes_greeks = True
    BASE = "https://api.tradier.com/v1"

    def __init__(self, token=None):
        self.token = token or os.environ.get("TRADIER_TOKEN")
        if not self.token:
            raise RuntimeError("TRADIER_TOKEN is not set — cannot use the tradier provider")
        self.h = {"Authorization": f"Bearer {self.token}", "Accept": "application/json"}
        self._fallback = YahooProvider()      # earnings calendar only

    def _get(self, path, **params):
        """GET with retry on gateway errors — Tradier sheds load with intermittent
        502s that clear on the identical request, and a scan of seventeen symbols
        drops names silently if one bad gateway is treated as a hard failure."""
        last = None
        for i in range(4):
            try:
                r = requests.get(f"{self.BASE}{path}", headers=self.h,
                                 params=params, timeout=25)
                if r.status_code in (502, 503, 504):
                    last = requests.HTTPError(f"{r.status_code} from {path}")
                    time.sleep(1.5 ** i)
                    continue
                r.raise_for_status()
                return r.json()
            except requests.RequestException as e:
                last = e
                time.sleep(1.5 ** i)
        raise last

    def bars(self, sym, interval="1d", rng="1y"):
        days = {"1y": 400, "2y": 760, "60d": 90, "5d": 10}.get(rng, 400)
        start = (datetime.now(timezone.utc) - pd.Timedelta(days=days)).strftime("%Y-%m-%d")
        d = self._get("/markets/history", symbol=sym, interval="daily", start=start)
        days_ = ((d.get("history") or {}).get("day")) or []
        if isinstance(days_, dict):
            days_ = [days_]
        df = pd.DataFrame([{"Open": x["open"], "High": x["high"], "Low": x["low"],
                            "Close": x["close"], "Volume": x.get("volume"),
                            "ts": pd.Timestamp(x["date"], tz="UTC")} for x in days_])
        if df.empty:
            raise RuntimeError(f"tradier returned no history for {sym}")
        df = df.set_index("ts")
        q = self._get("/markets/quotes", symbols=sym)
        quote = (q.get("quotes") or {}).get("quote") or {}
        df.attrs["live"] = quote.get("last")
        return df

    def _norm(self, o):
        """Normalise a Tradier contract.

        Greeks are passed through UNSCALED. Verified against live responses: on a
        5-day ATM SPY call Tradier published theta -0.4138 and vega 0.3777, while
        Black-Scholes on the same inputs gives -0.469 and 0.351 — the same units.
        Tradier already quotes theta per DAY and vega per VOL POINT, which is the
        convention greeks() uses.

        This code previously divided theta by 365 and vega by 100 on the assumption
        they arrived annualised. Both were wrong, and neither could be caught until a
        token existed: a theta 365x too small makes the holding cost of every options
        position round to nothing, so required_iv_rise collapses toward zero and every
        trade reads as free.
        """
        g = o.get("greeks") or {}
        return dict(contractSymbol=o.get("symbol"), strike=o.get("strike"),
                    bid=o.get("bid") or 0, ask=o.get("ask") or 0,
                    lastPrice=o.get("last") or 0, stale=False,
                    volume=o.get("volume") or 0, openInterest=o.get("open_interest") or 0,
                    impliedVolatility=g.get("mid_iv") or g.get("smv_vol") or 0,
                    delta=g.get("delta"), gamma=g.get("gamma"),
                    theta=g.get("theta"), vega=g.get("vega"))

    # Tradier's own vocabulary from /markets/clock, mapped to the provider-neutral
    # states the rest of the code gates on.
    _CLOCK = {"open": "REGULAR", "premarket": "PRE",
              "postmarket": "POST", "closed": "CLOSED"}

    def market_state(self):
        """REGULAR / PRE / POST / CLOSED, from the exchange clock.

        Yahoo ships this inside every quote, so nothing needed to ask for it
        separately. Tradier does not, and a chain that simply omits marketState reads
        as None — which makes require_open() refuse forever and silently disables every
        options pipeline rather than failing loudly.
        """
        try:
            d = self._get("/markets/clock")
            return self._CLOCK.get(((d.get("clock") or {}).get("state") or "").lower())
        except Exception:
            return None

    def _expirations(self, sym):
        d = self._get("/markets/options/expirations", symbol=sym, includeAllRoots="true")
        exps = ((d.get("expirations") or {}).get("date")) or []
        if isinstance(exps, str):
            exps = [exps]
        return exps

    def chain(self, sym, expiry_ts=None):
        q = self._get("/markets/quotes", symbols=sym)
        spot = ((q.get("quotes") or {}).get("quote") or {}).get("last")
        exps = self._expirations(sym)
        ts_list = [int(datetime.strptime(e, "%Y-%m-%d")
                       .replace(tzinfo=timezone.utc).timestamp()) for e in exps]
        calls, puts = [], []
        if expiry_ts:
            want = datetime.fromtimestamp(expiry_ts, timezone.utc).strftime("%Y-%m-%d")
            d = self._get("/markets/options/chains", symbol=sym, expiration=want, greeks="true")
            legs = ((d.get("options") or {}).get("option")) or []
            if isinstance(legs, dict):
                legs = [legs]
            for o in legs:
                (calls if o.get("option_type") == "call" else puts).append(self._norm(o))
        return {"quote": {"regularMarketPrice": spot},
                "expirationDates": ts_list,
                "options": [{"calls": calls, "puts": puts}]}

    def earnings(self, sym):
        return self._fallback.earnings(sym)


_PROVIDERS = {"yahoo": YahooProvider, "tradier": TradierProvider}
_active = None


def provider():
    """The configured provider, built once per process."""
    global _active
    if _active is None:
        name = os.environ.get("MARKET_DATA_PROVIDER", "yahoo").strip().lower()
        cls = _PROVIDERS.get(name)
        if cls is None:
            raise RuntimeError(f"unknown MARKET_DATA_PROVIDER {name!r}; "
                               f"choose from {sorted(_PROVIDERS)}")
        _active = cls()
    return _active


def bars(sym, interval="1d", rng="1y"):
    return provider().bars(sym, interval, rng)


def chain(sym, expiry_ts=None):
    return provider().chain(sym, expiry_ts)


def earnings(sym):
    return provider().earnings(sym)


def market_state(sym="SPY"):
    """REGULAR / PRE / POST / CLOSED. Options data is only trustworthy in REGULAR.

    Outside the session Yahoo empties the book AND recomputes implied vol off stale
    last trades, which produces figures that look plausible but are not — an NVDA
    call showing 6% IV, term structures collapsing to zero. Callers must gate on this
    rather than quietly analysing nonsense.
    """
    p = provider()
    # A provider with a dedicated clock endpoint answers directly; asking it for a whole
    # option chain just to read a session flag is an expensive way to learn the time.
    if hasattr(p, "market_state"):
        return p.market_state()
    try:
        return p.chain(sym)["quote"].get("marketState")
    except Exception:
        return None


def require_open(context=""):
    """(ok, state, message) — whether options analysis can be trusted right now."""
    st = market_state()
    if st == "REGULAR":
        return True, st, ""
    return False, st, (
        f"Market is {st or 'unavailable'}, not REGULAR{(' — ' + context) if context else ''}. "
        "Outside the session the options book is empty and implied vols are recomputed from "
        "stale last trades, so term structure and greeks cannot be trusted. Skipping.")


def describe():
    p = provider()
    return dict(name=p.name, realtime=p.realtime, publishes_greeks=p.publishes_greeks)
