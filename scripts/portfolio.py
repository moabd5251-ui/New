"""Claude Portfolio — defined-risk options spreads on liquid mega-caps + index ETFs.
Stage 1 regime -> Stage 2 screen -> Stage 3 spread construction."""
import pandas as pd, numpy as np, time, json, math
from datetime import datetime, timezone
import opt_lib as O
import feed

UNIVERSE = ["SPY","QQQ","IWM","DIA","AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA",
            "AVGO","JPM","V","UNH","XOM","WMT","LLY","MA","COST","HD","NFLX","AMD","CRM","ORCL"]

def bars(sym, interval="1d", rng="1y"):
    """Completed bars only; the live quote rides along in df.attrs["live"].

    Only drops the final bar when it is genuinely still forming — i.e. when it is
    dated today. Dropping unconditionally discarded the most recent COMPLETE session
    whenever this ran outside regular hours, quietly making every indicator a day stale.
    """
    df = feed.bars(sym, interval, rng)
    out = df
    if len(df):
        last_day = df.index[-1].date()
        if last_day >= datetime.now(timezone.utc).date():
            out = df.iloc[:-1]   # today's bar is incomplete
    out.attrs["live"] = df.attrs.get("live")
    return out

def atr(df, p=14):
    tr = pd.concat([df['High']-df['Low'], (df['High']-df['Close'].shift()).abs(),
                    (df['Low']-df['Close'].shift()).abs()], axis=1).max(axis=1)
    return float(tr.rolling(p).mean().iloc[-1])

def swings(df, w=5, lb=250):
    s = df.iloc[-lb:]; h, l = s['High'].values, s['Low'].values
    H_, L_ = [], []
    for j in range(w, len(s)-w):
        if h[j] == max(h[j-w:j+w+1]): H_.append(float(h[j]))
        if l[j] == min(l[j-w:j+w+1]): L_.append(float(l[j]))
    return sorted(set(H_), reverse=True), sorted(set(L_), reverse=True)

def fibs(lo, hi):
    d = hi-lo
    return {'.236':hi-d*.236, '.382':hi-d*.382, '.5':hi-d*.5, '.618':hi-d*.618, '.786':hi-d*.786}

def cs(level, a, swh, swl, fb, ma):
    t, sc = a*0.4, 0
    if any(abs(level-x) < t for x in swh): sc += 2
    if any(abs(level-x) < t for x in swl): sc += 2
    if any(abs(level-x) < t for x in fb.values()): sc += 1
    if any(abs(level-v) < t for v in ma.values() if not np.isnan(v)): sc += 1
    return sc

def dedup(lv, a):
    out = []
    for l, c in sorted(lv, key=lambda x: -x[1]):
        if not any(abs(l-x[0]) < a*0.3 for x in out): out.append((l, c))
    return out

# ---------- STAGE 1: market regime ----------
def regime():
    spy = bars("SPY"); c = spy['Close']
    ema20 = float(c.ewm(span=20).mean().iloc[-1])
    sma50 = float(c.rolling(50).mean().iloc[-1])
    sma200 = float(c.rolling(200).mean().iloc[-1])
    px = float(c.iloc[-1])
    if px > ema20 > sma50 > sma200: trend, tscore = "STRONG UPTREND", 2
    elif px > sma50 > sma200:       trend, tscore = "UPTREND", 1
    elif px < ema20 < sma50 < sma200: trend, tscore = "STRONG DOWNTREND", -2
    elif px < sma50 < sma200:       trend, tscore = "DOWNTREND", -1
    else:                            trend, tscore = "MIXED / RANGE", 0

    rv = float(c.pct_change().tail(20).std()*math.sqrt(252)*100)   # realized vol %
    try:
        vix_df = bars("^VIX"); vix = float(vix_df['Close'].iloc[-1])
        vix_pct = float((vix_df['Close'].tail(252) < vix).mean()*100)
    except Exception:
        vix, vix_pct = float('nan'), float('nan')

    if not np.isnan(vix_pct):
        vol_regime = "HIGH IV" if vix_pct >= 70 else ("LOW IV" if vix_pct <= 30 else "NORMAL IV")
    else:
        vol_regime = "HIGH IV" if rv >= 25 else ("LOW IV" if rv <= 12 else "NORMAL IV")

    # Defined-risk spread selection from regime
    if vol_regime == "HIGH IV":
        stype = "CREDIT"
        why = "IV is rich — selling premium inside a defined-risk vertical is better priced than paying it."
    elif vol_regime == "LOW IV":
        stype = "DEBIT"
        why = "IV is cheap — paying premium for a directional debit vertical costs less than usual."
    else:
        stype = "DEBIT" if abs(tscore) >= 1 else "CREDIT"
        why = ("Normal IV with a clear trend — a directional debit vertical expresses the trend with capped risk."
               if abs(tscore) >= 1 else
               "Normal IV with no clear trend — credit verticals monetize time rather than direction.")

    return dict(trend=trend, tscore=tscore, spy=round(px,2), ema20=round(ema20,2),
                sma50=round(sma50,2), sma200=round(sma200,2), realized_vol=round(rv,1),
                vix=(round(vix,2) if not np.isnan(vix) else None),
                vix_pctile=(round(vix_pct) if not np.isnan(vix_pct) else None),
                vol_regime=vol_regime, spread_type=stype, rationale=why)

# ---------- STAGE 2: screen names ----------
def screen(universe=UNIVERSE, regime_bias=0):
    rows = []
    for sym in universe:
        try:
            df = bars(sym)
            if len(df) < 210: continue
            last_close = float(df['Close'].iloc[-1])
            live = df.attrs.get("live")
            px = float(live) if live else last_close      # LIVE price drives bias
            a = atr(df)
            c = df['Close']
            ma = {'ema20': float(c.ewm(span=20).mean().iloc[-1]),
                  'sma50': float(c.rolling(50).mean().iloc[-1]),
                  'sma200': float(c.rolling(200).mean().iloc[-1])}
            swh, swl = swings(df)
            seg = df.iloc[-60:]
            lo, hi = float(seg['Low'].min()), float(seg['High'].max())
            if hi <= lo: continue
            fb = fibs(lo, hi)
            bias = ("LONG" if px > ma['ema20'] > ma['sma50']
                    else ("SHORT" if px < ma['ema20'] < ma['sma50'] else "NEUTRAL"))
            if bias == "NEUTRAL": continue
            cand = sorted(set(swh + swl + list(fb.values())), reverse=True)
            res = sorted(dedup([(l, cs(l,a,swh,swl,fb,ma)) for l in cand if l > px*1.002], a), key=lambda x: x[0])
            sup = sorted(dedup([(l, cs(l,a,swh,swl,fb,ma)) for l in cand if l < px*0.998], a), key=lambda x: -x[0])
            if not res or not sup: continue
            if bias == "LONG":
                stop = sup[0][0]-0.5*a; tgt, tcs = res[0]; near_cs = sup[0][1]
            else:
                stop = res[0][0]+0.5*a; tgt, tcs = sup[0]; near_cs = res[0][1]
            risk = abs(px-stop)
            if risk <= 0: continue
            rr = abs(tgt-px)/risk
            pdz = round((px-lo)/(hi-lo)*100, 1)
            mom = float(px/c.iloc[-21]-1)*100                # 1-month momentum, live-anchored
            rv = float(c.pct_change().tail(20).std()*math.sqrt(252)*100)
            # rank: confluence + R:R, boosted when aligned with market regime
            align = 1.15 if (regime_bias > 0 and bias == "LONG") or (regime_bias < 0 and bias == "SHORT") else 1.0
            score = round(near_cs * min(rr, 3.0) * align, 2)
            drift = (px-last_close)/a if a > 0 else 0     # how far live has run past the last close
            rows.append(dict(symbol=sym, price=round(px,2), last_close=round(last_close,2),
                             drift_atr=round(drift,2), bias=bias, cs=near_cs, rr=round(rr,2),
                             target=round(tgt,2), stop=round(stop,2), pd_zone=pdz,
                             mom_1m=round(mom,1), rvol=round(rv,1), score=score))
        except Exception as e:
            rows.append(dict(symbol=sym, error=str(e)[:60]))
        time.sleep(0.25)
    ok = [r for r in rows if 'error' not in r]
    ok.sort(key=lambda x: -x['score'])
    return ok, [r for r in rows if 'error' in r]
