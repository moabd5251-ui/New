# -*- coding: utf-8 -*-
import json, html, io, os

L,S,N = 'L','S','N'
# per-instrument strategy rows: (label, new_signal, change_note or None)
STRAT = {
"DJIA":[("DJ 04.2 L",L,None),("DJ 05.3 L",L,None),("DJ 09.4 MS",L,None),("DJ 11.1 LM",N,None),
        ("DJ 12.1b L",L,None),("DJ 15.2 L",L,None),("DJ 19.2 L",L,None),("DJ 20.3 MS",L,None),
        ("DJ 23.3 MS",L,None),("DJ 24.2 MS",L,None)],
"S&P 500":[("ES 02.1 M",L,None),("ES 04.3 LM",L,None),("ES 06.1",L,None),("ES 07.4",L,None),
        ("ES 09.1",L,"BUY (enter long)"),("ES 13.2 L",L,None),("ES 16.1 L",L,None),("ES 20.3",L,None),
        ("ES 26.3",L,None),("ES 34.1 L",N,None)],
"Nikkei 225":[("NK 01.2 M",L,None),("NK 03.1 LM",L,None),("NK 06.1 L",L,None),("NK 13.2 L",L,None),
        ("NK 15.2 L",L,None),("NK1 05.2 L",L,None),("NK1 08.1 LM",L,None),("NK1 11.2 L",N,None),
        ("NK1 16.1 L",L,None),("NK1 17.2 MS",L,None)],
"FTSE 100":[("FTSE 02.1 S",L,None),("FTSE 04.3 L",L,None),("FTSE 06.2 L",L,None),("FTSE 07.1 L",L,None),
        ("FTSE 10.4 M",L,None),("FTSE 12.1 LM",L,"BUY (enter long)"),("FTSE 14.2 L",N,None),
        ("FTSE 16.3 LM",L,None),("FTSE 21.T LM",L,None),("FTSE 22.1 L",N,None)],
"DAX":[("DAX 01.3 LM",L,None),("DAX 08.2 L",L,"BUY (enter long)"),("DAX 13.1 L",L,"BUY (enter long)"),
        ("DAX 19.2 L",L,"BUY (enter long)"),("DAX 28.2 LM",N,None),("DAX 32.1 L",L,None),
        ("DAX 34.2 LM",L,"BUY (enter long)"),("DAX 44.3 L",L,"BUY (enter long)"),
        ("DAX 48.1 L",N,None),("DAX 49.1 L",N,None)],
"Russell 2000":[("RL 01.1 MS",L,None),("RL 02.3 S",L,None),("RL 02n.1",N,None),("RL 03.2",L,None),
        ("RL 05.3 M",N,None),("RL 10.2",L,None),("RL 14.1 LM",N,None),("RL 18.1",L,None),
        ("RL 19.2 L",N,None),("RL 20.T",L,None)],
"Nasdaq 100":[("NQ 01.1 M",S,None),("NQ 02.3 L",L,None),("NQ 03.2 M",L,None),("NQ 03A.2 L",L,None),
        ("NQ 04.4 M",S,None),("NQ 06.3 S",L,None),("NQ 07.3 M",L,None),("NQ 09.3 L",L,None),
        ("NQ 10.4 LM",S,None),("NQ 11.1 LM",L,None)],
"GBP/USD":[("GBP 01.T L",L,None),("GBP 03.T M",L,None),("GBP 04.T L",L,None),("GBP 05.T L",L,None),
        ("GBP 06.T MS",L,None),("GBP 07.T L",L,"BUY (exit short, enter long)"),("GBP 09.T L",S,None),
        ("GBP 11.T MS",L,None),("GBP 13.T LM",S,None),("GBP 14.T M",S,None)],
"Bitcoin":[("BTC 02.3 M",L,None),("BTC 03.1 MS",L,"BUY (enter long)"),("BTC 04.2B MS",S,"SELL (enter short)"),
        ("BTC 05.3 M",N,"BUY (exit short)"),("BTC 07.4B M",L,None),("BTC 09.4B S",L,None),
        ("BTC 10.3 MS",N,"BUY (exit short)"),("BTC 11.4 MS",L,None),("BTC 12.3 L",N,"BUY (exit short)"),
        ("BTC 13.1 L",S,"SELL (enter short)")],
"USD/JPY":[("YEN 08.T LM",L,None),("YEN 11.T L",L,None),("YEN 12.T L",S,None),
        ("(label not in PDF text layer)",S,None),("YEN 16.T L",S,None),("YEN 18.T LM",S,None),
        ("YEN 21.T M",L,None),("YEN 23.T M",L,None),("YEN 25.T LM",L,None),("YEN 26.T MS",L,None)],
"USD/CHF":[("CHF_1.2",S,"SELL (enter short)"),("CHF_1.3",S,"SELL (enter short)"),("CHF_11.2",N,None),
        ("CHF_11.4",N,None),("CHF_4.1",N,"BUY (exit short)"),("CHF_4.2",S,None),
        ("CHF_5.2",N,"BUY (exit short)"),("CHF_5.3",S,None),("CHF_9.1",N,"BUY (exit short)"),
        ("CHF_9.2",N,None)],
"Gold":[("GC 01.T M",S,None),("GC 05.1 LM",S,None),("GC 13.2 LM",S,None),("GC 16.3 L",S,None),
        ("GC 17.2 L",N,None)],
"JGB":[("JGB 02T S",S,None),("JGB 03T M",S,None),("JGB 05T S",S,None),("JGB 08T L",N,None),
        ("JGB 09T M",S,None)],
"Canada 10Y":[("CGB 01.1",S,None),("CGB 02.2bb",S,None),("CGB 05.2",S,None),("CGB 08.4",S,None),
        ("CGB 09.5B",S,None),("CGB 10.3",N,None),("CGB 11.1",S,None),("CGB 12.1",S,None),
        ("CGB 13.2",S,None),("CGB 14.3",S,None)],
"EUR/USD":[("EUR 02.T M",S,None),("EUR 04.T LM",S,None),("EUR 06.T LM",S,None),("EUR 09.T M",S,None),
        ("EUR 13.T M",S,None),("EUR 14.T L",S,None),("EUR 27.T L",S,None),("EUR 35.T L",S,None),
        ("EUR 39.T MS",S,None),("EUR 40.T MS",S,None)],
"US 10Y":[("TY 01.T MS",S,None),("TY 04.1 LM",S,None),("TY 07.T MS",S,None),("TY 17.T L",S,None),
        ("TY 19.T M",S,None)],
"US 30Y":[("US 01.S",S,None),("US 23.T",S,None),("US 30.1",S,None),("US 33.T",S,None),("US 36.T",S,None)],
"Bund":[("EBL 04.T S",S,None),("EBL 08.T L",S,None),("EBL 24.T S",S,None),("EBL 25.T M",S,None),
        ("EBL 27.T L",S,None)],
"Gilt":[("FLG 10.1 M",S,None),("FLG 11.1 L",S,None),("FLG 13.1 L",S,None),("FLG 17.3 MS",S,None),
        ("FLG 21.1 S",S,None)],
}

D = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'data.json')))
INS = D['instruments']

# ---- validate strategy tables against the report's own net totals -------------
for i in INS:
    rows = STRAT[i['short']]
    assert len(rows) == i['n'], (i['short'], len(rows), i['n'])
    net = sum(1 if r[1]==L else -1 if r[1]==S else 0 for r in rows)
    assert net == i['new'], ('net mismatch', i['short'], net, i['new'])
print("strategy tables cross-foot against report totals: OK")

def pct(i, v):  return round(100.0*v/i['n'])
def cnt(rows):
    return (sum(1 for r in rows if r[1]==L), sum(1 for r in rows if r[1]==S),
            sum(1 for r in rows if r[1]==N))

def action(i):
    if i['chg']==0: return ('NO CHANGE','non')
    new,cur = i['new'], i['cur']
    if cur<0<=new or (cur<0 and new>0): return ('REVERSE TO LONG','rev')
    if cur>0>new: return ('REVERSE TO SHORT','rev')
    if new>=0 and cur>=0: return ('ADD LONG EXPOSURE','add') if new>cur else ('REDUCE LONG EXPOSURE','red')
    return ('REDUCE SHORT EXPOSURE','red') if abs(new)<abs(cur) else ('ADD SHORT EXPOSURE','add')

def bar(i, key='new'):
    e = pct(i, i[key]); w = abs(e)/2.0
    if e >= 0:
        style = "left:50%%;width:%.1f%%;background:var(--long);border-radius:0 3px 3px 0" % w
    else:
        style = "left:%.1f%%;width:%.1f%%;background:var(--short);border-radius:3px 0 0 3px" % (50-w, w)
    lab = "%+d%% of maximum exposure" % e
    return ('<span class="bar" title="%s"><i style="%s"></i><span class="mid"></span></span>' % (lab, style))

esc = html.escape
o = io.StringIO()
w = o.write

exps = [pct(i,i['new']) for i in INS]
nlong = sum(1 for e in exps if e>0); nshort = sum(1 for e in exps if e<0)
avg = sum(exps)/len(exps)
nchg = sum(1 for i in INS if i['chg']!=0)

CSS = """
:root{
  --ground:#F1F4F8; --surface:#FFFFFF; --surface-2:#E6EBF2; --line:#D2DAE4;
  --ink:#121926; --ink-2:#465468; --ink-3:#78849A;
  --accent:#2E5C9A; --accent-soft:#E2E9F4;
  --long:#0E7C61; --short:#B03A2E; --flat:#78849A;
  --display:"Zilla Slab",Georgia,"Times New Roman",serif;
  --body:"Source Sans 3",-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --ground:#0D131B; --surface:#151D28; --surface-2:#1D2734; --line:#2A3543;
    --ink:#DCE3EE; --ink-2:#9EAABA; --ink-3:#737F8E;
    --accent:#5B92D8; --accent-soft:#18242F;
    --long:#2E9C7B; --short:#D6685D; --flat:#737F8E;
  }
}
:root[data-theme="dark"]{
  --ground:#0D131B; --surface:#151D28; --surface-2:#1D2734; --line:#2A3543;
  --ink:#DCE3EE; --ink-2:#9EAABA; --ink-3:#737F8E;
  --accent:#5B92D8; --accent-soft:#18242F;
  --long:#2E9C7B; --short:#D6685D; --flat:#737F8E;
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--body);
  font-size:15.5px;line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:1160px;margin:0 auto;padding:40px 22px 68px;
  display:flex;flex-direction:column;gap:0}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
a{color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

/* masthead */
header.mast{display:flex;justify-content:space-between;align-items:flex-end;gap:22px;
  flex-wrap:wrap;border-bottom:2px solid var(--ink);padding-bottom:16px;margin-bottom:20px}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;
  color:var(--accent);margin-bottom:5px}
h1{font-family:var(--display);font-weight:600;font-size:clamp(28px,4.4vw,42px);margin:0;
  letter-spacing:-.015em;text-wrap:balance;line-height:1.08}
.sub{color:var(--ink-3);font-size:13.5px;margin-top:6px;max-width:58ch}
.stamp{font-family:var(--mono);font-size:11px;color:var(--ink-3);text-align:right;
  text-transform:uppercase;letter-spacing:.07em;line-height:1.75;white-space:nowrap}
.stamp b{color:var(--ink-2);font-weight:600}

/* posture tiles */
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:1px;
  background:var(--line);border:1px solid var(--line);border-radius:4px;overflow:hidden;
  margin-bottom:22px}
.tile{background:var(--surface);padding:13px 16px 14px;display:flex;flex-direction:column;gap:3px}
.tile .k{font-family:var(--mono);font-size:10px;letter-spacing:.11em;text-transform:uppercase;
  color:var(--ink-3)}
.tile .v{font-family:var(--display);font-size:27px;font-weight:600;line-height:1.1;
  font-variant-numeric:tabular-nums}
.tile .n{font-size:12.5px;color:var(--ink-2)}

.note{border-left:3px solid var(--accent);background:var(--accent-soft);
  padding:13px 16px;font-size:13.5px;color:var(--ink-2);border-radius:0 3px 3px 0;
  margin-bottom:14px}
.note strong{color:var(--ink)}
.note.plain{border-left-color:var(--line);background:var(--surface-2)}

h2{font-family:var(--display);font-size:21px;font-weight:600;margin:34px 0 4px;
  letter-spacing:-.01em}
h2 + .lede{color:var(--ink-3);font-size:13.5px;margin:0 0 12px;max-width:70ch}

/* tables */
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--line);
  border-radius:4px;font-size:13.5px;min-width:760px}
th{background:var(--surface-2);text-align:left;padding:9px 12px;font-family:var(--mono);
  font-size:10px;text-transform:uppercase;letter-spacing:.09em;color:var(--ink-2);
  font-weight:600;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:middle}
tbody tr:last-child td{border-bottom:none}
th.r,td.r{text-align:right}
.name{font-weight:600}
.mkt{color:var(--ink-3);font-size:11.5px;font-family:var(--mono)}
.long{color:var(--long)} .short{color:var(--short)} .flat{color:var(--flat)}
.exp{font-weight:700}

.bar{position:relative;display:block;height:15px;width:132px;min-width:132px;
  background:var(--surface-2);border-radius:3px;overflow:hidden}
.bar i{position:absolute;top:0;bottom:0;display:block}
.bar .mid{position:absolute;top:0;bottom:0;left:50%;width:1px;background:var(--line)}

.pill{display:inline-block;font-family:var(--mono);font-size:9.5px;font-weight:600;
  padding:3px 7px;border-radius:3px;letter-spacing:.06em;white-space:nowrap;
  border:1px solid transparent}
.p-add{background:var(--long);color:#fff}
.p-red{background:transparent;color:var(--short);border-color:var(--short)}
.p-rev{background:var(--short);color:#fff}
.p-non{background:transparent;color:var(--ink-3);border-color:var(--line)}
.p-ok{background:transparent;color:var(--ink-3);border-color:var(--line)}
.p-clash{background:var(--short);color:#fff}

/* strategy cards */
.cards{display:flex;flex-direction:column;gap:13px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:4px;overflow:hidden}
.card-h{display:flex;gap:11px;align-items:baseline;flex-wrap:wrap;padding:10px 15px;
  background:var(--surface-2);border-bottom:1px solid var(--line)}
.card-h .name{font-family:var(--display);font-size:16px;font-weight:600}
.card-h .exp{margin-left:auto;font-family:var(--mono);font-size:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(215px,1fr))}
.cell{padding:7px 14px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);
  display:flex;justify-content:space-between;align-items:baseline;gap:10px;font-size:12.5px}
.cell b{font-weight:400;color:var(--ink-2);font-family:var(--mono);font-size:11.5px}
.cell.moved{background:var(--accent-soft)}
.sig{font-family:var(--mono);font-size:10.5px;font-weight:600;letter-spacing:.04em;
  white-space:nowrap}
.chgnote{display:block;font-size:10px;color:var(--accent);font-family:var(--mono);
  letter-spacing:.02em;margin-top:1px}

footer{margin-top:38px;padding-top:15px;border-top:1px solid var(--line);
  color:var(--ink-3);font-size:12px;line-height:1.6}
footer p{margin:0 0 8px}
footer b{color:var(--ink-2)}
@media (max-width:640px){
  .stamp{text-align:left}
  header.mast{align-items:flex-start}
}
"""

w('<title>TrendCompass Key Markets</title>\n')
w('<link rel="preconnect" href="https://fonts.googleapis.com">\n')
w('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n')
w('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?'
  'family=Zilla+Slab:wght@400;600&family=Source+Sans+3:wght@400;600&'
  'family=IBM+Plex+Mono:wght@400;600&display=swap">\n')
w('<style>%s</style>\n' % CSS)
w('<div class="wrap">\n')

# ---------------- masthead ----------------
w('''<header class="mast">
  <div>
    <div class="eyebrow">I-System trend following &middot; CTA proxy</div>
    <h1>TrendCompass Key Markets</h1>
    <div class="sub">Nineteen global futures, FX and government-bond markets. Exposure is the
      net vote of the independent strategies running on each market.</div>
  </div>
  <div class="stamp">Signals as of close<br><b>19 Aug 2026</b><br>Report generated 20 Aug 2026</div>
</header>\n''')

# ---------------- posture tiles ----------------
def cls_of(v): return 'long' if v>0 else 'short' if v<0 else 'flat'
w('<div class="tiles">\n')
w('<div class="tile"><span class="k">Equity indices</span>'
  '<span class="v long">7 / 7</span><span class="n">long, every one of them</span></div>\n')
w('<div class="tile"><span class="k">Government bonds</span>'
  '<span class="v short">6 / 6</span><span class="n">short, every one of them</span></div>\n')
w('<div class="tile"><span class="k">Net long / net short</span>'
  '<span class="v">%d / %d</span><span class="n">of 19 markets</span></div>\n' % (nlong, nshort))
w('<div class="tile"><span class="k">Average exposure</span>'
  '<span class="v %s">%+d%%</span><span class="n">book tilts net short</span></div>\n'
  % (cls_of(avg), round(avg)))
w('<div class="tile"><span class="k">Changed today</span>'
  '<span class="v">%d</span><span class="n">five added long, one trimmed a short</span></div>\n'
  % nchg)
w('</div>\n')

w('''<div class="note"><strong>Exposure is a count, not a call.</strong> Each market runs 5 or 10
independent trend strategies. Every strategy votes long, short or neutral, and exposure is their
net vote as a share of the maximum &mdash; nine of ten long reads +90%. Exposure builds as more
strategies confirm and bleeds off as they drop out, so a position is never all-in on one
signal.</div>\n''')

# ---------------- the read ----------------
w('<h2>What the book says</h2>\n')
w('''<p class="lede">One posture explains almost the whole report.</p>
<div class="note plain">Every equity index is net long and every government-bond market is net
short &mdash; US 10s and 30s, Bunds and Gilts all sit at the maximum <b>&minus;100%</b>, Canada at
&minus;90%, JGBs at &minus;80%. That is a clean higher-yields, risk-on configuration, and it is
unanimous: no bond market has a single long strategy anywhere in the report. The dollar is the
one place the models disagree with themselves &mdash; long USD against the euro and the yen,
short USD against the pound and the franc &mdash; so read the currency lines as four separate
crosses, not one dollar view. Gold is short at &minus;80% while equities rally, the report's
sharpest internal tension.</div>\n''')

# ---------------- exposure book ----------------
w('<h2>Exposure book</h2>\n')
w('<p class="lede">Sorted from most long to most short. The bar is centred on flat: '
  'right of the line is long exposure, left is short.</p>\n')
w('<div class="scroll"><table>\n<thead><tr><th>Market</th><th class="r">Price</th>'
  '<th class="r">Prev</th><th class="r">Today</th><th class="r">Exposure</th><th></th>'
  '<th class="r">L / S / N</th><th>Action</th></tr></thead>\n<tbody>\n')
for i in INS:
    e, p = pct(i,i['new']), pct(i,i['cur'])
    d = e - p
    lc, sc, nc = cnt(STRAT[i['short']])
    act, ak = action(i)
    w('<tr>')
    w('<td><span class="name">%s</span><div class="mkt">%s &middot; %d strat</div></td>'
      % (esc(i['short']), esc(i['cls']), i['n']))
    w('<td class="r num">%s&thinsp;%s</td>' % (esc(i['ccy']), esc(i['price'])))
    w('<td class="r num flat">%+d%%</td>' % p)
    w('<td class="r num %s">%s</td>' % (cls_of(d), ('%+d%%' % d) if d else '&mdash;'))
    w('<td class="r num exp %s">%+d%%</td>' % (cls_of(e), e))
    w('<td>%s</td>' % bar(i))
    w('<td class="r num flat">%d / %d / %d</td>' % (lc, sc, nc))
    w('<td><span class="pill p-%s">%s</span></td>' % (ak, act))
    w('</tr>\n')
w('</tbody></table></div>\n')

# ---------------- today's changes ----------------
w('<h2>What moved today</h2>\n')
w('<p class="lede">Six markets changed. Five added long exposure in the direction they were '
  'already leaning; the sixth, USD/CHF, trimmed a short. Nothing reversed.</p>\n')
w('<div class="scroll"><table>\n<thead><tr><th>Market</th><th class="r">From</th>'
  '<th class="r">To</th><th class="r">Delta</th><th>Strategies that turned</th></tr></thead>\n<tbody>\n')
for i in sorted([x for x in INS if x['chg']!=0], key=lambda x:-abs(pct(x,x['chg']))):
    moves = [(lab, note) for lab, sig, note in STRAT[i['short']] if note]
    txt = '; '.join('<b>%s</b> %s' % (esc(l), esc(n.lower())) for l, n in moves)
    w('<tr><td><span class="name">%s</span><div class="mkt">%s</div></td>'
      '<td class="r num flat">%+d%%</td><td class="r num exp %s">%+d%%</td>'
      '<td class="r num long">%+d%%</td><td style="font-size:12.5px;color:var(--ink-2)">%s</td></tr>\n'
      % (esc(i['short']), esc(i['cls']), pct(i,i['cur']), cls_of(pct(i,i['new'])),
         pct(i,i['new']), pct(i,i['chg']), txt))
w('</tbody></table></div>\n')
w('''<div class="note plain">The DAX is the day's real event: five strategies entered long at
once, taking it from a token +20% to +70%. USD/CHF is the odd one &mdash; two strategies sold and
three covered on the same day, so the net short shrank to &minus;40% while six of ten strategies
now sit flat. That is a market the models have largely stepped out of, not one they have a view
on.</div>\n''')

# ---------------- cross-check vs the user's own ETF model ----------------
# (label, what the bet is, trendcompass %, etf ticker, etf %, )
CMP = [
 ("Dow Jones",      "Long US large-cap",        90,  "DIA",  80),
 ("S&P 500",        "Long US broad",            90,  "SPY",  90),
 ("Nasdaq 100",     "Long US tech",             40,  "QQQ",  30),
 ("Russell 2000",   "Long US small-cap",        60,  "IWM", 100),
 ("Nikkei 225",     "Long Japan equity",        90,  "EWJ",  90),
 ("DAX",            "Long German equity",       70,  "EWG",  80),
 ("FTSE 100",       "Long UK equity",           80,  "EWU",  70),
 ("US 10-year",     "Long the note",          -100,  "IEF", -60),
 ("US 30-year",     "Long the bond",          -100,  "TLT", -70),
 ("Bitcoin",        "Long bitcoin",             30,  "IBIT", 20),
 ("Gold",           "Long gold",               -80,  "GLD",  30),
 ("Euro",           "Long EUR vs USD",        -100,  "FXE",  60),
 ("Japanese yen",   "Long JPY vs USD",         -20,  "FXY",  50),
]
agree = [c for c in CMP if (c[2]>0) == (c[4]>0)]
clash = [c for c in CMP if (c[2]>0) != (c[4]>0)]

w('<h2>Cross-check against your ETF Trend Compass</h2>\n')
w('<p class="lede">Both books run off the same 19 Aug close, so they are directly comparable. '
  'FX is restated so both sides express the same bet &mdash; a short EUR/USD reads as negative '
  'long-euro exposure.</p>\n')
w('<div class="scroll"><table>\n<thead><tr><th>Bet</th><th>Expressed as</th>'
  '<th class="r">TrendCompass</th><th class="r">ETF model</th><th class="r">Gap</th>'
  '<th>Verdict</th></tr></thead>\n<tbody>\n')
for label, bet, tc, tick, ev in CMP:
    same = (tc>0) == (ev>0)
    w('<tr><td><span class="name">%s</span></td>'
      '<td class="mkt" style="font-family:var(--body);font-size:12.5px;color:var(--ink-2)">%s</td>'
      '<td class="r num exp %s">%+d%%</td>'
      '<td class="r num exp %s">%+d%% <span class="mkt">%s</span></td>'
      '<td class="r num flat">%d pt</td>'
      '<td><span class="pill p-%s">%s</span></td></tr>\n'
      % (esc(label), esc(bet), cls_of(tc), tc, cls_of(ev), ev, esc(tick),
         abs(tc-ev), 'ok' if same else 'clash',
         'SAME SIDE' if same else 'OPPOSITE'))
w('</tbody></table></div>\n')
w('''<div class="note"><strong>They agree on everything that matters except three things.</strong>
Across all seven equity indices and both US bond maturities the two books take the same side, and
mostly within 20 points &mdash; independent model families landing on the same trend is the
strongest confirmation either one offers. The disagreements cluster perfectly: <b>gold</b> and
<b>both dollar crosses</b>. TrendCompass is short gold at &minus;80% while your ETF model just
reversed GLD to +30%; TrendCompass is maximum short the euro while your model is +60% long it.
Neither is the correct one, and gold is exactly the market where a futures book and a
spot-ETF book can legitimately part company. Treat these three as unresolved rather than as a
signal from either side.</div>\n''')

# ---------------- strategy detail ----------------
SIGLAB = {L:('LONG','long'), S:('SHORT','short'), N:('NEUTRAL','flat')}
w('<h2>Strategy detail</h2>\n')
w('<p class="lede">Every strategy in the report, with its standing signal after today. '
  'Shaded cells are the ones that turned.</p>\n')
w('<div class="cards">\n')
for i in INS:
    e = pct(i,i['new']); lc, sc, nc = cnt(STRAT[i['short']])
    w('<div class="card"><div class="card-h">')
    w('<span class="name">%s</span>' % esc(i['short']))
    w('<span class="mkt">%s &middot; %s</span>' % (esc(i['name']), esc(i['cls'])))
    w('<span class="mkt num">%s&thinsp;%s</span>' % (esc(i['ccy']), esc(i['price'])))
    w('<span class="exp %s">%+d%% &middot; %d L / %d S / %d N</span>'
      % (cls_of(e), e, lc, sc, nc))
    w('</div><div class="grid">')
    for lab, sig, note in STRAT[i['short']]:
        t, c = SIGLAB[sig]
        w('<div class="cell%s"><b>%s</b><span class="sig %s">%s%s</span></div>'
          % (' moved' if note else '', esc(lab), c, t,
             '<span class="chgnote">%s</span>' % esc(note) if note else ''))
    w('</div></div>\n')
w('</div>\n')

# ---------------- footer ----------------
w('''<footer>
<p><b>Source.</b> TrendCompass report for Key Markets, generated 20 Aug 2026 on prices at the
close of 19 Aug 2026. Every figure on this page is transcribed from that report; each market's
strategy table was cross-footed against the net total the report itself prints, and all 19
reconcile. One row is incomplete: USD/JPY strategy 34 is short, but its label did not survive
extraction from the PDF's text layer.</p>
<p><b>What this is.</b> TrendCompass approximates the likely activity of CTA trend-following
funds using I-System strategies. It is supplemental decision support, not advice and not an
inducement to trade. Trading these markets carries substantial risk of loss. The underlying data
comes from exchange clearinghouses and is occasionally revised after publication, which can
retroactively change a signal.</p>
</footer>\n''')
w('</div>\n')

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'trendcompass.html')
open(out,'w').write(o.getvalue())
print("wrote %s  (%d bytes)" % (out, len(o.getvalue())))
print("summary: %d long / %d short, avg %+.1f%%, %d changed" % (nlong, nshort, avg, nchg))
print("cross-check: %d same side, %d opposite" % (len(agree), len(clash)))
