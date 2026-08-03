"""Render the earnings dashboard: what the options market prices vs what the stock does."""
import json, datetime

CSS = """
:root{
  --ground:#F6F7FA; --surface:#FFFFFF; --surface-2:#EEF1F6; --line:#DCE1EA;
  --ink:#1D2430; --ink-2:#4A5364; --ink-3:#79839A;
  --accent:#3E5C89; --accent-soft:#E4EAF4;
  --rich:#8E4B9C; --cheap:#1F7A8C; --fair:#79839A;
  --profit:#1F8A5F; --loss:#C4453C; --caution:#B37A1E;
  --sans:ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --serif:Georgia,"Iowan Old Style","Times New Roman",serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){
  :root{
    --ground:#11141B; --surface:#191D26; --surface-2:#212734; --line:#2C3341;
    --ink:#DFE5EF; --ink-2:#A5AFC1; --ink-3:#727D91;
    --accent:#7D9BCC; --accent-soft:#1E2735;
    --rich:#C083CE; --cheap:#4FB3C6; --fair:#727D91;
    --profit:#43B583; --loss:#E0685E; --caution:#D3A244;
  }
}
:root[data-theme="dark"]{
  --ground:#11141B; --surface:#191D26; --surface-2:#212734; --line:#2C3341;
  --ink:#DFE5EF; --ink-2:#A5AFC1; --ink-3:#727D91;
  --accent:#7D9BCC; --accent-soft:#1E2735;
  --rich:#C083CE; --cheap:#4FB3C6; --fair:#727D91;
  --profit:#43B583; --loss:#E0685E; --caution:#D3A244;
}
:root[data-theme="light"]{
  --ground:#F6F7FA; --surface:#FFFFFF; --surface-2:#EEF1F6; --line:#DCE1EA;
  --ink:#1D2430; --ink-2:#4A5364; --ink-3:#79839A;
  --accent:#3E5C89; --accent-soft:#E4EAF4;
  --rich:#8E4B9C; --cheap:#1F7A8C; --fair:#79839A;
  --profit:#1F8A5F; --loss:#C4453C; --caution:#B37A1E;
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);
  font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:1180px;margin:0 auto;padding:40px 24px 72px}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
header.masthead{border-bottom:2px solid var(--ink);padding-bottom:18px;margin-bottom:24px;
  display:flex;justify-content:space-between;align-items:flex-end;gap:20px;flex-wrap:wrap}
h1{font-family:var(--serif);font-weight:600;font-size:clamp(26px,4vw,38px);margin:0;
  letter-spacing:-.01em;text-wrap:balance}
.sub{color:var(--ink-3);font-size:13px;margin-top:5px}
.stamp{font-family:var(--mono);font-size:11.5px;color:var(--ink-3);text-align:right;
  text-transform:uppercase;letter-spacing:.07em;white-space:nowrap}
.thesis{background:var(--accent-soft);border-left:3px solid var(--accent);padding:14px 17px;
  font-size:13.5px;color:var(--ink-2);margin-bottom:26px;border-radius:0 2px 2px 0}
.thesis strong{color:var(--ink)}
.tally{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));
  border:1px solid var(--line);border-radius:3px;overflow:hidden;margin-bottom:30px;background:var(--surface)}
.t{padding:14px 17px;border-right:1px solid var(--line)}
.t:last-child{border-right:0}
.t .k{font-size:10.5px;text-transform:uppercase;letter-spacing:.09em;color:var(--ink-3)}
.t .v{font-family:var(--mono);font-size:22px;font-weight:700;margin-top:4px;letter-spacing:-.02em}
.group{margin-top:34px}
.group:first-of-type{margin-top:0}
.ghead{display:flex;align-items:baseline;gap:10px;margin-bottom:5px;flex-wrap:wrap}
.gtag{font-family:var(--mono);font-size:10.5px;font-weight:700;letter-spacing:.07em;
  padding:3px 9px;border-radius:2px;color:#fff}
.gtag.rich{background:var(--rich)} .gtag.cheap{background:var(--cheap)} .gtag.fair{background:var(--fair)}
.gnote{font-size:13px;color:var(--ink-3);margin:0 0 16px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(345px,1fr));gap:18px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:3px;
  display:flex;flex-direction:column;overflow:hidden}
.card.rich{border-top:3px solid var(--rich)}
.card.cheap{border-top:3px solid var(--cheap)}
.card.fair{border-top:3px solid var(--fair)}
.top{padding:14px 17px 12px;border-bottom:1px solid var(--line)}
.tick{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}
.tick .sym{font-family:var(--serif);font-size:23px;font-weight:600}
.tick .spot{margin-left:auto;font-family:var(--mono);font-size:14px;color:var(--ink-2)}
.when{display:flex;align-items:center;gap:7px;margin-top:8px;font-family:var(--mono);font-size:11.5px;
  color:var(--ink-3);flex-wrap:wrap}
.chip{background:var(--surface-2);padding:2px 8px;border-radius:2px;font-weight:600;color:var(--ink-2)}
.chip.soon{background:color-mix(in srgb,var(--caution) 22%,transparent);color:var(--caution)}
.est{color:var(--caution)}
.moves{padding:14px 17px;border-bottom:1px solid var(--line)}
.mrow{display:flex;align-items:center;gap:9px;margin-bottom:7px;font-size:12px}
.mrow:last-child{margin-bottom:0}
.mlab{width:76px;color:var(--ink-3);font-size:10.5px;text-transform:uppercase;letter-spacing:.07em}
.mbar{flex:1;height:15px;background:var(--surface-2);border-radius:2px;overflow:hidden;position:relative}
.mbar i{display:block;height:100%;border-radius:2px}
.mval{width:52px;text-align:right;font-family:var(--mono);font-weight:600;font-size:12.5px}
.ratio{margin-top:9px;font-size:12px;color:var(--ink-2);font-family:var(--mono)}
.struct{padding:12px 17px;border-bottom:1px solid var(--line);background:var(--surface-2)}
.sname{font-family:var(--mono);font-size:11px;font-weight:700;letter-spacing:.06em;
  text-transform:uppercase;color:var(--ink-2)}
.slegs{font-family:var(--mono);font-size:14px;margin-top:5px;letter-spacing:-.01em}
.stats{display:grid;grid-template-columns:repeat(3,1fr)}
.stat{padding:10px 17px;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}
.stat:nth-child(3n){border-right:0}
.stat .k{font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3)}
.stat .v{font-family:var(--mono);font-size:14.5px;font-weight:600;margin-top:3px}
.v.pos{color:var(--profit)} .v.neg{color:var(--loss)}
.greeks{display:flex;border-bottom:1px solid var(--line)}
.gk{flex:1;padding:8px 17px;border-right:1px solid var(--line)}
.gk:last-child{border-right:0}
.gk .k{font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3)}
.gk .v{font-family:var(--mono);font-size:12.5px;margin-top:2px}
.why{padding:11px 17px;font-size:12.5px;color:var(--ink-2);line-height:1.5}
.foot{padding:9px 17px;margin-top:auto;border-top:1px solid var(--line);
  font-family:var(--mono);font-size:11px;color:var(--ink-3);
  display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
.warn{padding:8px 17px;background:color-mix(in srgb,var(--caution) 13%,transparent);
  color:var(--caution);font-size:11.5px;font-weight:600;border-bottom:1px solid var(--line)}
.method{margin-top:36px;border-top:1px solid var(--line);padding-top:20px;
  font-size:13px;color:var(--ink-2);columns:2;column-gap:34px}
.method h3{font-family:var(--sans);font-size:11px;text-transform:uppercase;letter-spacing:.1em;
  color:var(--ink-3);margin:0 0 8px;column-span:all}
.method p{margin:0 0 10px;break-inside:avoid}
.method strong{color:var(--ink)}
.disclaim{margin-top:22px;padding:13px 16px;background:var(--surface-2);
  border-left:3px solid var(--caution);font-size:12.5px;color:var(--ink-2);border-radius:0 2px 2px 0}
@media (max-width:720px){.method{columns:1}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
"""

JS = r"""
function css(v){return getComputedStyle(document.documentElement).getPropertyValue(v).trim();}
function money(n){return (n<0?"-$":"$")+Math.abs(n).toLocaleString(undefined,{maximumFractionDigits:0});}
const KEY={'PREMIUM RICH':'rich','PREMIUM CHEAP':'cheap','FAIR':'fair','NO DATA':'fair'};

function card(r){
  const k=KEY[r.verdict]||'fair';
  const maxMove=Math.max(r.implied_move||0, r.hist_move||0, 1);
  const soon=r.days<=2;
  const thin=r.has_structure && r.min_oi<50;
  const structBlock = r.has_structure ? `
    <div class="struct">
      <div class="sname">${r.structure} &middot; ${r.side}</div>
      <div class="slegs">${r.structure==='IRON CONDOR'
        ? `${r.long_put} / ${r.short_put} &nbsp;—&nbsp; ${r.short_call} / ${r.long_call}`
        : `${r.long_strike} / ${r.short_strike}`}</div>
    </div>
    ${thin?`<div class="warn">Thin market — smallest leg has ${r.min_oi} open interest</div>`:''}
    <div class="stats">
      <div class="stat"><div class="k">${r.structure==='IRON CONDOR'?'Credit':'Cost'}</div>
        <div class="v num">${money(r.structure==='IRON CONDOR'?r.credit_per:r.cost_per)}</div></div>
      <div class="stat"><div class="k">Max gain</div><div class="v num pos">${money(r.max_profit*100)}</div></div>
      <div class="stat"><div class="k">Max loss</div><div class="v num neg">${money(r.max_loss*100)}</div></div>
      <div class="stat"><div class="k">Reward : risk</div><div class="v num">${r.rr}:1</div></div>
      <div class="stat"><div class="k">Breakeven</div><div class="v num" style="font-size:12px">${
        r.structure==='IRON CONDOR'?`${r.be_low}–${r.be_high}`:r.breakeven}</div></div>
      <div class="stat"><div class="k">Prob. of profit</div><div class="v num">${r.pop}%</div></div>
    </div>
    <div class="greeks">
      <div class="gk"><div class="k">Delta</div><div class="v num">${r.net_delta>0?'+':''}${r.net_delta}</div></div>
      <div class="gk"><div class="k">Theta / day</div><div class="v num">${r.net_theta>0?'+':''}${r.net_theta}</div></div>
      <div class="gk"><div class="k">Vega</div><div class="v num">${r.net_vega>0?'+':''}${r.net_vega}</div></div>
    </div>`
  : `<div class="why" style="color:var(--ink-3)">No structure built — pricing shows no clear edge on the event.</div>`;

  return `<article class="card ${k}">
    <div class="top">
      <div class="tick"><span class="sym">${r.symbol}</span><span class="spot num">${r.spot}</span></div>
      <div class="when">
        <span class="chip ${soon?'soon':''}">${r.days===0?'reports today':r.days===1?'reports tomorrow':'in '+r.days+' days'}</span>
        <span>${r.date}</span>
        ${r.estimated?'<span class="est">· date estimated</span>':'<span>· confirmed</span>'}
      </div>
    </div>
    <div class="moves">
      <div class="mrow"><span class="mlab">Implied</span>
        <span class="mbar"><i style="width:${(r.implied_move/maxMove*100).toFixed(1)}%;background:${css('--accent')}"></i></span>
        <span class="mval">${r.implied_move}%</span></div>
      <div class="mrow"><span class="mlab">Historical</span>
        <span class="mbar"><i style="width:${((r.hist_move||0)/maxMove*100).toFixed(1)}%;background:${css('--ink-3')}"></i></span>
        <span class="mval">${r.hist_move==null?'—':r.hist_move+'%'}</span></div>
      <div class="ratio">ratio ${r.premium_ratio==null?'—':r.premium_ratio}&times; &middot; straddle ${r.straddle} &middot; exp ${r.expiry}</div>
    </div>
    ${structBlock}
    <div class="why">${r.rationale}</div>
    <div class="foot">
      <span>IV ${r.front_iv}${r.back_iv?` → ${r.back_iv}`:''}${r.iv_term_spread!=null?` (${r.iv_term_spread>0?'+':''}${r.iv_term_spread})`:''}</span>
      <span>${r.beat_rate!=null?`beat ${r.beat_rate}% of ${r.n_quarters}q`:''}</span>
    </div>
  </article>`;
}

function render(){
  const rows=DATA.rows||[];
  const groups=[
    ['PREMIUM RICH','rich','Options price a bigger move than these names historically deliver. Selling the event inside a defined-risk condor is the better side — these profit if the move comes in smaller than priced.'],
    ['PREMIUM CHEAP','cheap','Options price a smaller move than these names historically deliver. Buying the event with a defined-risk vertical is the better side — cost is the whole risk.'],
    ['FAIR','fair','Implied and historical moves line up. No pricing edge on the event itself, so no structure is proposed.']
  ];
  const n=v=>rows.filter(r=>r.verdict===v).length;
  document.getElementById('tally').innerHTML=`
    <div class="t"><div class="k">Reporting ≤30d</div><div class="v">${rows.length}</div></div>
    <div class="t"><div class="k">Premium rich</div><div class="v" style="color:${css('--rich')}">${n('PREMIUM RICH')}</div></div>
    <div class="t"><div class="k">Premium cheap</div><div class="v" style="color:${css('--cheap')}">${n('PREMIUM CHEAP')}</div></div>
    <div class="t"><div class="k">Fairly priced</div><div class="v" style="color:${css('--fair')}">${n('FAIR')}</div></div>
    <div class="t"><div class="k">Reporting ≤48h</div><div class="v" style="color:${css('--caution')}">${rows.filter(r=>r.days<=2).length}</div></div>`;
  document.getElementById('groups').innerHTML=groups.map(([v,k,note])=>{
    const g=rows.filter(r=>r.verdict===v);
    if(!g.length) return '';
    return `<section class="group">
      <div class="ghead"><span class="gtag ${k}">${v}</span><span style="color:var(--ink-3);font-size:12.5px">${g.length} name${g.length>1?'s':''}</span></div>
      <p class="gnote">${note}</p>
      <div class="cards">${g.map(card).join('')}</div>
    </section>`;
  }).join('');
}
render();
"""

BODY = """
<div class="wrap">
  <header class="masthead">
    <div><h1>Earnings Watch</h1>
      <div class="sub">Optionable names reporting within 30 days &middot; defined-risk event structures</div></div>
    <div class="stamp">Updated __STAMP__</div>
  </header>
  <div class="thesis"><strong>The question this answers:</strong> is the options market pricing a bigger move
  than the stock actually tends to make on earnings day? When implied exceeds historical, the event premium is
  rich and worth selling. When it falls short, the event is cheap and worth buying. Everything below is sorted
  by that gap, and every structure caps its loss by construction.</div>
  <div class="tally" id="tally"></div>
  <div id="groups"></div>
  <div class="method">
    <h3>How this is measured</h3>
    <p><strong>Implied move</strong> is the at-the-money straddle in the first expiry after the report, as a percentage of spot &mdash; what the market charges to own the event.</p>
    <p><strong>Historical move</strong> is inferred from the four largest single-day moves of the past year. Exact announcement dates aren't in the free feed, but for large caps those days are overwhelmingly earnings reactions. It is an approximation, and a name with a big non-earnings shock in its history will read as cheaper than it is.</p>
    <p><strong>IV term structure</strong> compares implied vol in the expiry containing earnings against the one after it. A wide positive spread is the event premium priced into the front month, and it is what collapses once the report lands.</p>
    <p><strong>Iron condors</strong> sell roughly 20-delta strikes and buy 10-delta wings. They carry positive theta and negative vega &mdash; they profit from decay and from the volatility crush after the announcement.</p>
    <p><strong>Debit verticals</strong> buy roughly 55-delta and sell 30-delta in the trend direction. Negative theta, positive vega &mdash; the mirror image, and the right side only when the event is genuinely underpriced.</p>
    <p><strong>Estimated dates</strong> are flagged. An estimated date can be wrong by weeks, which would put the chosen expiry on the wrong side of the report &mdash; confirm before acting on those.</p>
  </div>
  <div class="disclaim"><strong>Analysis only.</strong> Nothing here is placed, ordered, or executed &mdash; and none of it is financial advice. Earnings positions carry gap risk that no model captures: a stock can move far beyond both breakevens overnight, and on a condor that means the full defined loss. Quotes are free-tier and delayed roughly 15 minutes. Verify the report date and live pricing before acting.</div>
</div>
"""


def build(rows, out_path):
    payload = json.dumps({"rows": rows}, separators=(",", ":"), default=str)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%d %b %Y, %H:%M UTC")
    html = ("<title>Earnings Watch — Event Premium vs History</title>\n"
            f"<style>{CSS}</style>\n"
            f"{BODY.replace('__STAMP__', stamp)}\n"
            f"<script>\nconst DATA = {payload};\n{JS}\n</script>\n")
    with open(out_path, "w") as f:
        f.write(html)
    return out_path
