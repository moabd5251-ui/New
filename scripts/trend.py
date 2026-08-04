"""Consensus trend following: a panel of independent strategies votes, exposure is the vote.

Modelled on the TrendCompass / I-System reports. Each instrument runs N independent
trend strategies. Every strategy returns +1 (long), -1 (short), or 0 (flat), and
exposure is simply their sum over N — so with ten strategies, position size moves in
10% steps from -100% to +100%.

The point is that exposure is never binary. You are 30% long when three models agree
and 80% long when eight do, so the position accelerates as a trend broadens and bleeds
off as strategies drop out, rather than flipping wholesale on one signal. That gradual
scaling IS the strategy; a panel that only ever reads +/-100% has thrown it away.

Which makes the neutral state load-bearing. A strategy that is always either long or
short cannot express "this trend has weakened", so several strategies here carry an
explicit dead band — usually a fraction of ATR — and return 0 inside it. Mixing those
with stateful breakout models, which do hold a side until reversed, is what produces
the graduated readings instead of a panel that swings between the extremes together.

Signals are computed on the last COMPLETE session, matching the source reports' use of
last business day's closing prices. Nothing here reads an intraday quote, so this is
the one pipeline in the repo that does not need a market-hours guard and is just as
valid run on a Sunday.
"""
import numpy as np
import pandas as pd

import portfolio as P


# --------------------------------------------------------------------------
# indicators
# --------------------------------------------------------------------------
def _atr(df, n=14):
    h, l, c = df["High"], df["Low"], df["Close"]
    pc = c.shift(1)
    tr = pd.concat([h - l, (h - pc).abs(), (l - pc).abs()], axis=1).max(axis=1)
    return tr.rolling(n).mean()


def _ema(s, n):
    return s.ewm(span=n, adjust=False).mean()


def _stateful(sig):
    """Carry the last non-zero signal forward — a breakout holds until it is reversed.

    Without this a breakout model reads long only on the single bar that pierces the
    channel and flat every day after, which is not how a breakout system trades.
    """
    out, cur = [], 0
    for v in sig:
        if v != 0:
            cur = v
        out.append(cur)
    return out


# --------------------------------------------------------------------------
# the strategy panel — each returns +1 / -1 / 0 on the last complete bar
# --------------------------------------------------------------------------
def s_ma_cross(df, fast=20, slow=50, buf=0.25):
    """Fast MA over slow, with an ATR dead band so a flat cross reads neutral."""
    f, s = df["Close"].rolling(fast).mean(), df["Close"].rolling(slow).mean()
    a = _atr(df)
    d = f - s
    return int(np.sign(d.iloc[-1])) if abs(d.iloc[-1]) > buf * a.iloc[-1] else 0


def s_ma_cross_long(df):
    return s_ma_cross(df, 50, 200, 0.25)


def s_donchian(df, n=20):
    """Channel breakout, held until the opposite channel breaks."""
    hi = df["High"].rolling(n).max().shift(1)
    lo = df["Low"].rolling(n).min().shift(1)
    raw = np.where(df["Close"] > hi, 1, np.where(df["Close"] < lo, -1, 0))
    return _stateful(raw)[-1]


def s_donchian_long(df):
    return s_donchian(df, 55)


def s_macd(df, fast=12, slow=26, sig=9, buf=0.05):
    """MACD histogram sign, with a dead band scaled to price."""
    m = _ema(df["Close"], fast) - _ema(df["Close"], slow)
    h = m - _ema(m, sig)
    thresh = buf * _atr(df).iloc[-1]
    return int(np.sign(h.iloc[-1])) if abs(h.iloc[-1]) > thresh else 0


def s_momentum(df, n=63, thresh=0.02):
    """Rate of change over n sessions; flat inside +/-thresh."""
    c = df["Close"]
    if len(c) <= n:
        return 0
    r = c.iloc[-1] / c.iloc[-1 - n] - 1
    return int(np.sign(r)) if abs(r) > thresh else 0


def s_momentum_long(df):
    return s_momentum(df, 126, 0.04)


def s_keltner(df, n=20, k=2.0):
    """Break of an ATR channel around the EMA, held until the far band breaks."""
    e, a = _ema(df["Close"], n), _atr(df, n)
    raw = np.where(df["Close"] > e + k * a, 1, np.where(df["Close"] < e - k * a, -1, 0))
    return _stateful(raw)[-1]


def s_slope(df, n=40):
    """Sign of a fitted trend line, neutral when the fit is too weak to call."""
    c = df["Close"].tail(n)
    if len(c) < n:
        return 0
    x = np.arange(n)
    slope, intercept = np.polyfit(x, c.values, 1)
    resid = c.values - (slope * x + intercept)
    se = resid.std(ddof=2) / (x.std() * np.sqrt(n)) if x.std() > 0 else 0
    if se == 0:
        return 0
    return int(np.sign(slope)) if abs(slope / se) > 1.0 else 0


def s_above_sma(df, n=100, buf=0.5):
    """Price versus a long average, with a wide ATR buffer."""
    m, a = df["Close"].rolling(n).mean(), _atr(df)
    d = df["Close"].iloc[-1] - m.iloc[-1]
    return int(np.sign(d)) if abs(d) > buf * a.iloc[-1] else 0


PANEL = [
    ("MA 20/50", s_ma_cross),
    ("MA 50/200", s_ma_cross_long),
    ("Donchian 20", s_donchian),
    ("Donchian 55", s_donchian_long),
    ("MACD 12/26/9", s_macd),
    ("Momentum 63d", s_momentum),
    ("Momentum 126d", s_momentum_long),
    ("Keltner 20", s_keltner),
    ("Slope 40d", s_slope),
    ("Close vs SMA100", s_above_sma),
]


# --------------------------------------------------------------------------
# ETF universe — the tradable stand-in for each market in the source reports
# --------------------------------------------------------------------------
UNIVERSE = [
    dict(symbol="SPY",  market="S&P 500",            group="Equity"),
    dict(symbol="QQQ",  market="Nasdaq 100",         group="Equity"),
    dict(symbol="DIA",  market="Dow Jones",          group="Equity"),
    dict(symbol="IWM",  market="Russell 2000",       group="Equity"),
    dict(symbol="EFA",  market="Developed ex-US",    group="Equity"),
    dict(symbol="EEM",  market="Emerging Markets",   group="Equity"),
    dict(symbol="EWJ",  market="Japan / Nikkei",     group="Equity"),
    dict(symbol="EWG",  market="Germany / DAX",      group="Equity"),
    dict(symbol="EWU",  market="UK / FTSE 100",      group="Equity"),
    dict(symbol="IEF",  market="US 10-Year Note",    group="Rates"),
    dict(symbol="TLT",  market="US 30-Year Bond",    group="Rates"),
    dict(symbol="GLD",  market="Gold",               group="Commodity"),
    dict(symbol="SLV",  market="Silver",             group="Commodity"),
    dict(symbol="DBC",  market="Broad Commodities",  group="Commodity"),
    dict(symbol="UUP",  market="US Dollar Index",    group="FX"),
    dict(symbol="FXE",  market="Euro",               group="FX"),
    dict(symbol="FXY",  market="Japanese Yen",       group="FX"),
    dict(symbol="IBIT", market="Bitcoin",            group="Crypto"),
]

STEP = 10          # exposure granularity, percent — one strategy per step at N=10


def evaluate(symbol, df=None):
    """Run the panel on one symbol. Returns votes, net exposure, and per-strategy detail."""
    if df is None:
        df = P.bars(symbol, "1d", "2y")
    if df is None or len(df) < 210:
        raise RuntimeError(f"{symbol}: only {0 if df is None else len(df)} bars, need 210")
    detail, net = [], 0
    for name, fn in PANEL:
        try:
            v = int(fn(df))
        except Exception:
            v = 0
        net += v
        detail.append(dict(strategy=name, signal=v,
                           label={1: "LONG", -1: "SHORT", 0: "NEUTRAL"}[v]))
    n = len(PANEL)
    close = float(df["Close"].iloc[-1])
    return dict(symbol=symbol, price=round(close, 2),
                asof=df.index[-1].strftime("%Y-%m-%d"),
                n_strategies=n, net=net, exposure_pct=int(round(net / n * 100)),
                longs=sum(1 for d in detail if d["signal"] > 0),
                shorts=sum(1 for d in detail if d["signal"] < 0),
                neutrals=sum(1 for d in detail if d["signal"] == 0),
                strategies=detail)


def direction(pct):
    return "LONG" if pct > 0 else "SHORT" if pct < 0 else "FLAT"


def strength(pct):
    """How committed the panel is, independent of side."""
    a = abs(pct)
    if a >= 80:
        return "STRONG"
    if a >= 50:
        return "MODERATE"
    if a >= 20:
        return "WEAK"
    return "NONE"


def scan(universe=None, verbose=True):
    """Evaluate the whole universe. Returns (rows, errors)."""
    rows, errs = [], []
    for spec in (universe or UNIVERSE):
        try:
            r = evaluate(spec["symbol"])
            r.update(market=spec["market"], group=spec["group"])
            r["direction"] = direction(r["exposure_pct"])
            r["strength"] = strength(r["exposure_pct"])
            rows.append(r)
        except Exception as e:
            errs.append(dict(symbol=spec["symbol"], error=str(e)[:80]))
            if verbose:
                print(f"  [{spec['symbol']}] {str(e)[:70]}")
    rows.sort(key=lambda r: -abs(r["exposure_pct"]))
    return rows, errs


def diff(new_rows, prev_by_sym):
    """Attach the change versus the previous run, the way the source report does.

    The report's value is as much in the DELTA as the level — "add long exposure,
    30% -> 80%" is the instruction; 80% on its own is just a state. Anything that
    reports only the new level makes the user diff it by eye against memory.
    """
    for r in new_rows:
        p = prev_by_sym.get(r["symbol"])
        if not p:
            r["prev_pct"] = None
            r["change_pct"] = None
            r["action"] = "NEW"
            continue
        prev = p.get("exposure_pct")
        r["prev_pct"] = prev
        r["change_pct"] = None if prev is None else r["exposure_pct"] - prev
        ch = r["change_pct"]
        if ch is None or ch == 0:
            r["action"] = "NO CHANGE"
        elif r["exposure_pct"] == 0:
            r["action"] = "CLOSE — GO FLAT"
        elif prev is not None and prev != 0 and (prev > 0) != (r["exposure_pct"] > 0):
            r["action"] = f"REVERSE TO {r['direction']}"
        elif abs(r["exposure_pct"]) > abs(prev or 0):
            r["action"] = f"ADD {r['direction']} EXPOSURE"
        else:
            r["action"] = f"REDUCE {r['direction']} EXPOSURE"
    return new_rows
