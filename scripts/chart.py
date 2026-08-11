"""One technical read, shared by every dashboard.

Each strategy here answers its own question — is vol cheap into the report, is the gap
still travelling, where are dealers hedged, is the trend strengthening — and none of them
looks at where price actually sits in its own structure. That gap shows up as advice that
is locally sensible and structurally blind: a calendar struck at 205 while price runs to
223, a drift target 0.08R away because the next resistance was already overhead, a LEAP
entry taken with a swing high half an ATR above it.

This module answers the missing question once, the same way, for every symbol: what is
the trend, how far is price from the levels that matter, and how much room is there
before the next one. The confluence machinery is swing.py's — reused rather than
reimplemented, so a fix to the scoring lands everywhere at once.

Bars come through portfolio.bars(), which validates the series and falls back to Yahoo.
That matters here more than anywhere: a chart drawn from the wrong instrument is the most
convincing wrong answer this codebase can produce.
"""
import html as _html
import json as _json

import numpy as np

import portfolio as P
import swing as S

SERIES_POINTS = 90      # trading days drawn in the sparkline — about four months
NEAR_LEVELS = 3         # levels shown each side of price


def _trend(price, m):
    """Trend by moving-average stack, with the neutral case kept explicit."""
    e, s50, s200 = m["ema20"], m["sma50"], m["sma200"]
    if np.isnan(s200):
        s200 = None
    if price > e > s50:
        base = "UPTREND"
    elif price < e < s50:
        base = "DOWNTREND"
    else:
        return "MIXED", ("Price, the 20-day and the 50-day are not stacked — no trend "
                         "to trade with or against on this timeframe.")
    if s200 is not None:
        agrees = (price > s200) if base == "UPTREND" else (price < s200)
        if not agrees:
            return base, (f"{base.title()} on the 20/50 stack, but price is on the other "
                          f"side of the 200-day — a counter-trend move inside a larger one.")
    return base, (f"Price above the 20-day above the 50-day." if base == "UPTREND"
                  else "Price below the 20-day below the 50-day.")


def read(symbol, df=None):
    """Where `symbol` sits in its own structure. None when there is too little history."""
    try:
        df = P.bars(symbol) if df is None else df
    except Exception as e:
        return dict(symbol=symbol, error=str(e)[:80])
    if df is None or len(df) < 60:
        return dict(symbol=symbol, error="insufficient history")

    levels, atr, m = S.confluence(df)
    price = float(df["Close"].iloc[-1])
    if not atr or atr <= 0 or np.isnan(atr):
        return dict(symbol=symbol, error="no ATR")

    trend, trend_note = _trend(price, m)
    brk = S.last_structure_break(df)

    def pack(L):
        return dict(price=round(L["price"], 2), cs=L["cs"],
                    labels=L["labels"][:3],
                    dist_pct=round((L["price"] - price) / price * 100, 2),
                    dist_atr=round(abs(L["price"] - price) / atr, 2))

    # A level within a tenth of an ATR is not above or below price in any tradeable
    # sense — it IS price, and listing it as support invites leaning on a line the
    # market is already sitting on.
    eps = atr * 0.1
    above = sorted([L for L in levels if L["price"] > price + eps], key=lambda x: x["price"])
    below = sorted([L for L in levels if L["price"] < price - eps], key=lambda x: -x["price"])

    tail = df["Close"].tail(SERIES_POINTS)
    win = df.tail(252)
    lo52, hi52 = float(win["Low"].min()), float(win["High"].max())

    return dict(
        symbol=symbol, asof=df.index[-1].strftime("%Y-%m-%d"), price=round(price, 2),
        atr=round(atr, 2), atr_pct=round(atr / price * 100, 2),
        trend=trend, trend_note=trend_note,
        ema20=round(m["ema20"], 2), sma50=round(m["sma50"], 2),
        sma200=(None if np.isnan(m["sma200"]) else round(m["sma200"], 2)),
        resistance=[pack(L) for L in above[:NEAR_LEVELS]],
        support=[pack(L) for L in below[:NEAR_LEVELS]],
        # Room is the honest headline: a setup with a wall half an ATR away is a
        # different proposition from the same setup with three ATRs of clear air.
        room_up=(round((above[0]["price"] - price) / atr, 2) if above else None),
        room_down=(round((price - below[0]["price"]) / atr, 2) if below else None),
        structure=(dict(bars_ago=brk[0], dir=brk[1], level=round(brk[2], 2)) if brk else None),
        pos_52w=(round((price - lo52) / (hi52 - lo52) * 100, 1) if hi52 > lo52 else None),
        lo52=round(lo52, 2), hi52=round(hi52, 2),
        series=[round(float(x), 4) for x in tail.tolist()])


def summarise(r):
    """Two or three plain sentences a reader can act on without reading the table."""
    if not r or r.get("error"):
        return []
    out = [f"{r['trend']} — {r['trend_note']}"]
    if r.get("room_up") is not None and r.get("resistance"):
        t = r["resistance"][0]
        out.append(f"Nearest resistance {t['price']} is {r['room_up']} ATR above "
                   f"({t['dist_pct']:+.2f}%), confluence {t['cs']} — {', '.join(t['labels'])}.")
    else:
        out.append("No confirmed level above price — it is at the top of its range, so "
                   "there is nothing overhead to stall it and nothing to target either.")
    if r.get("room_down") is not None and r.get("support"):
        s = r["support"][0]
        out.append(f"Nearest support {s['price']} is {r['room_down']} ATR below "
                   f"({s['dist_pct']:+.2f}%), confluence {s['cs']}.")
    if r.get("structure") and r["structure"]["bars_ago"] <= 5:
        b = r["structure"]
        out.append(f"Structure broke {b['dir']} through {b['level']} "
                   f"{b['bars_ago']} session{'s' if b['bars_ago'] != 1 else ''} ago.")
    return out


# ---------------------------------------------------------------- rendering ----
# Shared by every dashboard so one fix to the drawing lands in all five. SVG rather
# than canvas: it scales without a redraw, survives a theme flip without a repaint
# hook, and prints.
CSS = """
.chart{background:var(--surface);border:1px solid var(--line);border-radius:3px;
  margin:10px 0 14px;overflow:hidden}
.chart-h{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;padding:9px 14px;
  background:var(--surface-2);border-bottom:1px solid var(--line);
  font-family:var(--mono);font-size:11px;color:var(--ink-2)}
.chart-h .tr{font-weight:700;letter-spacing:.05em}
.chart-h .tr.up{color:var(--up,#1F7A5A)} .chart-h .tr.down{color:var(--down,#B4443E)}
.chart-h .tr.mixed{color:var(--ink-3)}
.chart-h .sp{margin-left:auto}
.chart svg{display:block;width:100%;height:auto}
.chart-read{margin:0;padding:10px 14px 12px;list-style:none;
  border-top:1px solid var(--line)}
.chart-read li{font-size:12.5px;color:var(--ink-2);margin-bottom:5px;padding-left:12px;
  position:relative;line-height:1.45}
.chart-read li:last-child{margin-bottom:0}
.chart-read li:before{content:'';position:absolute;left:0;top:7px;width:4px;height:4px;
  border-radius:50%;background:var(--ink-3)}
.chart-none{padding:11px 14px;font-size:12px;color:var(--ink-3);font-family:var(--mono)}
"""

JS = r"""
function chartBlock(r){
  if(!r) return '';
  if(r.error) return '<div class="chart"><div class="chart-none">chart unavailable — '
    + r.error + '</div></div>';
  var S=r.series||[]; if(S.length<5) return '';
  var W=560,H=150,L=6,R=62,T=10,B=8, pw=W-L-R, ph=H-T-B;

  // Scale to the price path AND every level drawn, so a level never lands off-canvas
  // and silently disappears — the reader would read "no resistance" from its absence.
  var vals=S.slice(), lv=[];
  (r.resistance||[]).forEach(function(x){lv.push(x);});
  (r.support||[]).forEach(function(x){lv.push(x);});
  lv.forEach(function(x){vals.push(x.price);});
  vals.push(r.price);
  var lo=Math.min.apply(null,vals), hi=Math.max.apply(null,vals);
  var pad=(hi-lo)*0.08||1; lo-=pad; hi+=pad;
  var y=function(v){return T+ph-((v-lo)/(hi-lo))*ph;};
  var x=function(i){return L+(pw*i/(S.length-1));};

  var up=r.trend==='UPTREND', dn=r.trend==='DOWNTREND';
  var col=up?'var(--up,#1F7A5A)':dn?'var(--down,#B4443E)':'var(--ink-3,#75807A)';

  var parts=[];
  // Level bands first so the price line draws over them.
  lv.forEach(function(k){
    var isRes=k.price>r.price, yy=y(k.price);
    var c=isRes?'var(--down,#B4443E)':'var(--up,#1F7A5A)';
    var w=k.cs>=6?1.6:k.cs>=4?1.1:0.7;           // heavier line = stronger confluence
    parts.push('<line x1="'+L+'" y1="'+yy+'" x2="'+(L+pw)+'" y2="'+yy+'" stroke="'+c+
      '" stroke-width="'+w+'" stroke-dasharray="'+(k.cs>=6?'':'4 3')+'" opacity="0.8"/>');
    parts.push('<text x="'+(L+pw+5)+'" y="'+(yy+3.5)+'" font-size="9.5" fill="'+c+
      '" font-family="var(--mono)">'+k.price+' <tspan opacity="0.7">CS'+k.cs+'</tspan></text>');
  });
  var d=S.map(function(v,i){return (i?'L':'M')+x(i).toFixed(1)+' '+y(v).toFixed(1);}).join(' ');
  parts.push('<path d="'+d+'" fill="none" stroke="'+col+'" stroke-width="1.7" '+
    'stroke-linejoin="round" stroke-linecap="round"/>');
  var lastY=y(S[S.length-1]);
  parts.push('<circle cx="'+x(S.length-1)+'" cy="'+lastY+'" r="3" fill="'+col+'"/>');

  var reads=(r.read||[]).map(function(t){return '<li>'+t+'</li>';}).join('');
  return '<div class="chart">'
    + '<div class="chart-h"><span class="tr '+(up?'up':dn?'down':'mixed')+'">'+r.trend+'</span>'
    + '<span>ATR '+r.atr+' ('+r.atr_pct+'%)</span>'
    + (r.pos_52w!=null?'<span>'+r.pos_52w+'% of 52w range</span>':'')
    + '<span class="sp">'+S.length+' sessions to '+r.asof+'</span></div>'
    + '<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" role="img" '
    + 'aria-label="price with confluence levels">'+parts.join('')+'</svg>'
    + (reads?'<ul class="chart-read">'+reads+'</ul>':'')
    + '</div>';
}
"""


def payload(symbol, df=None):
    """A read trimmed to what the renderer needs, with the prose attached."""
    r = read(symbol, df)
    if r.get("error"):
        return dict(symbol=symbol, error=r["error"])
    r["read"] = summarise(r)
    return r


def slot(symbol):
    """A placeholder the shared JS renderer fills.

    Two of these dashboards build their HTML in Python and three build it in the
    browser. Rendering the chart twice — once per language — would guarantee the two
    drift apart. A slot lets both kinds emit a marker and lets one renderer fill it.
    """
    return f'<div class="chart-slot" data-sym="{_html.escape(str(symbol))}"></div>'


def mount(payloads):
    """The <script> body: chart data, the renderer, and the slot filler."""
    return (f"window.CHARTS={_json.dumps(payloads, separators=(',', ':'), default=str)};\n"
            f"{JS}\n{MOUNT_JS}")


MOUNT_JS = r"""
function mountCharts(root){
  (root||document).querySelectorAll('.chart-slot').forEach(function(el){
    if(el.dataset.done) return;
    var r=(window.CHARTS||{})[el.dataset.sym];
    var h=chartBlock(r);
    if(h){ el.innerHTML=h; el.dataset.done='1'; }
  });
}
document.addEventListener('DOMContentLoaded', function(){ mountCharts(); });
mountCharts();
"""
