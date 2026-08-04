"""Render the pre-earnings volatility ramp dashboard."""
import json, datetime

CSS = """
:root{
  --ground:#F7F7F9; --surface:#FFFFFF; --surface-2:#EDEEF2; --line:#DBDDE4;
  --ink:#1C1F27; --ink-2:#484E5C; --ink-3:#767D8D;
  --accent:#5B4B8A; --accent-soft:#E9E6F2;
  --go:#1F7A5A; --wait:#B0761F; --stop:#B4443E;
  --vol:#7C5FB0;
  --sans:ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --serif:Georgia,"Iowan Old Style","Times New Roman",serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){
  :root{
    --ground:#121319; --surface:#1A1C24; --surface-2:#232631; --line:#2E323E;
    --ink:#E2E4EC; --ink-2:#A8AEBE; --ink-3:#767D8D;
    --accent:#A594D6; --accent-soft:#221F2E;
    --go:#46B189; --wait:#D2A052; --stop:#DE6A63;
    --vol:#A98FDB;
  }
}
:root[data-theme="dark"]{
  --ground:#121319; --surface:#1A1C24; --surface-2:#232631; --line:#2E323E;
  --ink:#E2E4EC; --ink-2:#A8AEBE; --ink-3:#767D8D;
  --accent:#A594D6; --accent-soft:#221F2E;
  --go:#46B189; --wait:#D2A052; --stop:#DE6A63;
  --vol:#A98FDB;
}
:root[data-theme="light"]{
  --ground:#F7F7F9; --surface:#FFFFFF; --surface-2:#EDEEF2; --line:#DBDDE4;
  --ink:#1C1F27; --ink-2:#484E5C; --ink-3:#767D8D;
  --accent:#5B4B8A; --accent-soft:#E9E6F2;
  --go:#1F7A5A; --wait:#B0761F; --stop:#B4443E;
  --vol:#7C5FB0;
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);
  font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:1150px;margin:0 auto;padding:40px 24px 72px}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
header.mast{border-bottom:2px solid var(--ink);padding-bottom:18px;margin-bottom:22px;
  display:flex;justify-content:space-between;align-items:flex-end;gap:20px;flex-wrap:wrap}
h1{font-family:var(--serif);font-weight:600;font-size:clamp(26px,4vw,38px);margin:0;
  letter-spacing:-.01em;text-wrap:balance}
.sub{color:var(--ink-3);font-size:13px;margin-top:5px}
.stamp{font-family:var(--mono);font-size:11.5px;color:var(--ink-3);text-align:right;
  text-transform:uppercase;letter-spacing:.07em;white-space:nowrap}
.thesis{background:var(--accent-soft);border-left:3px solid var(--accent);padding:14px 17px;
  font-size:13.5px;color:var(--ink-2);margin-bottom:24px;border-radius:0 2px 2px 0}
.thesis strong{color:var(--ink)}
.ramp{background:var(--surface);border:1px solid var(--line);border-radius:3px;
  margin-bottom:28px;overflow:hidden}
.ramp-h{padding:12px 18px;background:var(--surface-2);border-bottom:1px solid var(--line);
  font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--ink-2)}
.ramp-b{padding:16px 18px;display:flex;gap:26px;align-items:center;flex-wrap:wrap}
.rstat .k{font-size:10.5px;text-transform:uppercase;letter-spacing:.09em;color:var(--ink-3)}
.rstat .v{font-family:var(--mono);font-size:21px;font-weight:700;letter-spacing:-.02em;margin-top:3px}
.rbar{flex:1;min-width:220px}
.rtrack{height:22px;background:var(--surface-2);border-radius:3px;position:relative;overflow:hidden}
.rtrack i{position:absolute;top:0;bottom:0;left:0;background:var(--vol);opacity:.85}
.rlab{display:flex;justify-content:space-between;font-family:var(--mono);font-size:10.5px;
  color:var(--ink-3);margin-top:5px}
.group{margin-top:32px}
.group:first-of-type{margin-top:0}
.gh{display:flex;align-items:baseline;gap:10px;margin-bottom:4px;flex-wrap:wrap}
.tag{font-family:var(--mono);font-size:10.5px;font-weight:700;letter-spacing:.07em;
  padding:3px 9px;border-radius:2px;color:#fff}
.tag.go{background:var(--go)} .tag.wait{background:var(--wait)} .tag.stop{background:var(--stop)}
.tag.na{background:var(--ink-3)}
.gnote{font-size:13px;color:var(--ink-3);margin:0 0 16px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:18px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:3px;
  display:flex;flex-direction:column;overflow:hidden}
.card.go{border-top:3px solid var(--go)}
.card.wait{border-top:3px solid var(--wait)}
.card.stop{border-top:3px solid var(--stop)}
.top{padding:14px 17px 12px;border-bottom:1px solid var(--line)}
.tick{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}
.tick .sym{font-family:var(--serif);font-size:23px;font-weight:600}
.tick .spot{margin-left:auto;font-family:var(--mono);font-size:14px;color:var(--ink-2)}
.tl{padding:13px 17px;border-bottom:1px solid var(--line);background:var(--surface-2)}
.tl-track{position:relative;height:3px;background:var(--line);border-radius:2px;margin:16px 0 6px}
.tl-fill{position:absolute;top:0;bottom:0;left:0;background:var(--accent);border-radius:2px}
.tl-pt{position:absolute;top:50%;transform:translate(-50%,-50%);width:9px;height:9px;
  border-radius:50%;background:var(--accent);border:2px solid var(--surface-2)}
.tl-pt.end{background:var(--stop)}
.tl-lab{display:flex;justify-content:space-between;font-family:var(--mono);font-size:10.5px;color:var(--ink-3)}
.tl-lab b{display:block;color:var(--ink-2);font-weight:600;font-size:11.5px}
.body{padding:13px 17px;border-bottom:1px solid var(--line)}
.sname{font-family:var(--mono);font-size:10.5px;font-weight:700;letter-spacing:.06em;
  text-transform:uppercase;color:var(--ink-3)}
.slegs{font-family:var(--mono);font-size:13.5px;margin-top:4px;letter-spacing:-.01em;color:var(--ink)}
.need{margin-top:12px}
.need-row{display:flex;align-items:center;gap:9px;font-size:12px;margin-bottom:6px}
.need-lab{width:96px;color:var(--ink-3);font-size:10.5px;text-transform:uppercase;letter-spacing:.07em}
.need-bar{flex:1;height:14px;background:var(--surface-2);border-radius:2px;overflow:hidden}
.need-bar i{display:block;height:100%;border-radius:2px}
.need-val{width:56px;text-align:right;font-family:var(--mono);font-weight:600;font-size:12.5px}
.stats{display:grid;grid-template-columns:repeat(3,1fr)}
.stat{padding:10px 17px;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}
.stat:nth-child(3n){border-right:0}
.stat .k{font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3)}
.stat .v{font-family:var(--mono);font-size:14.5px;font-weight:600;margin-top:3px}
.v.good{color:var(--go)} .v.bad{color:var(--stop)}
.why{padding:11px 17px;font-size:12.5px;color:var(--ink-2);line-height:1.5}
.risk{padding:10px 17px;background:color-mix(in srgb,var(--wait) 11%,transparent);
  font-size:12px;color:var(--ink-2);border-top:1px solid var(--line)}
.risk b{color:var(--wait)}
.warn{padding:8px 17px;background:color-mix(in srgb,var(--stop) 12%,transparent);
  color:var(--stop);font-size:11.5px;font-weight:600;border-bottom:1px solid var(--line)}
.foot{padding:9px 17px;margin-top:auto;border-top:1px solid var(--line);
  font-family:var(--mono);font-size:11px;color:var(--ink-3);
  display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
.slim{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
.chip{background:var(--surface);border:1px solid var(--line);border-radius:3px;padding:10px 13px;
  display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.chip .s{font-family:var(--serif);font-size:16px;font-weight:600}
.chip .d{font-family:var(--mono);font-size:11px;color:var(--ink-3);text-align:right}
.lcard{background:var(--surface);border:1px solid var(--line);border-radius:3px;
  border-top:3px solid var(--vol);display:flex;flex-direction:column;overflow:hidden}
.lhead{padding:13px 17px 11px;border-bottom:1px solid var(--line)}
.lrow{display:flex;align-items:center;gap:8px;font-size:12px;padding:9px 17px;
  border-bottom:1px solid var(--line)}
.lrow .n{font-family:var(--mono);font-weight:600}
.lopt{padding:9px 17px;border-bottom:1px solid var(--line);display:flex;
  justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap}
.lopt.pick{background:color-mix(in srgb,var(--vol) 10%,transparent)}
.lopt .st{font-family:var(--mono);font-size:11px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.05em}
.lopt .lg{font-family:var(--mono);font-size:13px;color:var(--ink)}
.lopt .px{font-family:var(--mono);font-size:13px;font-weight:600;margin-left:auto}
.lmeta{font-family:var(--mono);font-size:11px;color:var(--ink-3);flex-basis:100%}
.mv{display:flex;align-items:center;gap:8px;padding:11px 17px;border-bottom:1px solid var(--line)}
.mv .lab{width:74px;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-3)}
.mv .bar{flex:1;height:13px;background:var(--surface-2);border-radius:2px;overflow:hidden}
.mv .bar i{display:block;height:100%;border-radius:2px}
.mv .v{width:52px;text-align:right;font-family:var(--mono);font-weight:600;font-size:12px}
.method{margin-top:36px;border-top:1px solid var(--line);padding-top:20px;
  font-size:13px;color:var(--ink-2);columns:2;column-gap:34px}
.method h3{font-family:var(--sans);font-size:11px;text-transform:uppercase;letter-spacing:.1em;
  color:var(--ink-3);margin:0 0 8px;column-span:all}
.method p{margin:0 0 10px;break-inside:avoid}
.method strong{color:var(--ink)}
.disclaim{margin-top:22px;padding:13px 16px;background:var(--surface-2);
  border-left:3px solid var(--stop);font-size:12.5px;color:var(--ink-2);border-radius:0 2px 2px 0}
@media (max-width:720px){.method{columns:1}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
"""

JS = r"""
function css(v){return getComputedStyle(document.documentElement).getPropertyValue(v).trim();}
function money(n){return (n<0?"-$":"$")+Math.abs(Math.round(n)).toLocaleString();}
const VMAP={'WORTH TAKING':'go','MARGINAL':'wait','NOT WORTH IT':'stop','NO PRICING':'na'};

function timeline(r){
  const total=r.days||1, held=Math.max(r.hold_days,0);
  const pct=Math.max(4,Math.min(96,held/total*100));
  return `<div class="tl">
    <div class="tl-lab"><span><b>today</b>enter</span>
      <span style="text-align:right"><b>${r.exit_date}</b>close position</span></div>
    <div class="tl-track"><div class="tl-fill" style="width:${pct}%"></div>
      <div class="tl-pt" style="left:0"></div>
      <div class="tl-pt end" style="left:${pct}%"></div></div>
    <div class="tl-lab"><span>hold ${held} days</span>
      <span>report ${r.date} · ${r.days}d</span></div>
  </div>`;
}

function card(r){
  const k=VMAP[r.verdict]||'na', b=r.best;
  if(!b) return '';
  const ramp=r.ramp_estimate||0, need=b.required_iv_rise||0;
  const needPct=ramp?Math.min(need/ramp*100,100):0;
  const thin=b.min_oi<50;
  const stale=b.stale;
  return `<article class="card ${k}">
    <div class="top">
      <div class="tick"><span class="sym">${r.symbol}</span>
        <span class="spot num">${b.spot||r.spot}</span></div>
    </div>
    ${r.estimated?`<div class="warn">Report date is an estimate — confirm before entering</div>`:''}
    ${thin?`<div class="warn">Thin market — smallest leg has ${b.min_oi} open interest</div>`:''}
    ${stale?`<div class="warn">Priced off last trade — market closed, true spread unknown</div>`:''}
    ${timeline(r)}
    <div class="body">
      <div class="sname">${b.structure}</div>
      <div class="slegs">${b.legs}</div>
      <div class="need">
        <div class="need-row"><span class="need-lab">Needs</span>
          <span class="need-bar"><i style="width:${needPct}%;background:${need<=ramp*0.5?css('--go'):need<=ramp?css('--wait'):css('--stop')}"></i></span>
          <span class="need-val">+${need}</span></div>
        <div class="need-row"><span class="need-lab">Typical ramp</span>
          <span class="need-bar"><i style="width:100%;background:${css('--vol')}"></i></span>
          <span class="need-val">+${ramp}</span></div>
      </div>
    </div>
    <div class="stats">
      <div class="stat"><div class="k">Cost</div><div class="v num">${money(b.cost)}</div></div>
      <div class="stat"><div class="k">Max loss</div><div class="v num bad">${money(b.max_loss)}</div></div>
      <div class="stat"><div class="k">Vega</div><div class="v num good">+${b.vega}</div></div>
      <div class="stat"><div class="k">Theta / day</div>
        <div class="v num ${b.theta>=0?'good':'bad'}">${b.theta>=0?'+':''}${b.theta}</div></div>
      <div class="stat"><div class="k">Total bleed</div><div class="v num">${money(b.bleed)}</div></div>
      <div class="stat"><div class="k">Current IV</div><div class="v num">${b.iv}%</div></div>
    </div>
    <div class="why">${r.window_note}</div>
    <div class="risk"><b>Risk:</b> ${b.move_risk}</div>
    <div class="foot"><span>term spread ${r.iv_term_spread}</span>
      <span>${r.estimated?'estimated date':'confirmed date'}</span></div>
  </article>`;
}

function lottoCard(r){
  const L=r.lotto; if(!L) return '';
  const b=L.best, live=L.verdict==='LIVE';
  const maxMv=Math.max(b.required_move, r.hist_move||0, 1);
  const opt=(s,key)=>s?`<div class="lopt ${s===b?'pick':''}">
      <span class="st">${s.structure}</span><span class="lg">${s.legs}</span>
      <span class="px">$${s.cost.toFixed(0)}</span>
      <span class="lmeta">needs ${s.required_move}% · pays ${s.payoff_typical}x on a typical move,
        ${s.payoff_max}x on its biggest${s.capped?' (capped)':''}${s.prob!=null?` · ~${s.prob}% odds`:' · odds n/a'}</span>
    </div>`:'';
  return `<article class="lcard">
    <div class="lhead"><div class="tick"><span class="sym">${r.symbol}</span>
      <span class="spot num">${r.spot}</span></div>
      <div class="when" style="margin-top:6px"><span class="chip ${r.days<=1?'soon':''}">${
        r.days===0?'reports today':r.days===1?'reports tomorrow':'in '+r.days+' days'}</span>
        <span style="font-family:var(--mono);font-size:11px;color:var(--ink-3)">${r.date}</span></div>
    </div>
    ${b.stale?`<div class="warn">Priced off last trade — market closed</div>`:''}
    ${L.too_pricey?`<div class="warn">Not really cheap — cheapest ticket is ${b.cost_pct}% of spot</div>`:''}
    <div class="mv"><span class="lab">Needs</span>
      <span class="bar"><i style="width:${b.required_move/maxMv*100}%;background:${live?css('--go'):css('--stop')}"></i></span>
      <span class="v">${b.required_move}%</span></div>
    <div class="mv"><span class="lab">Typical</span>
      <span class="bar"><i style="width:${(r.hist_move||0)/maxMv*100}%;background:${css('--vol')}"></i></span>
      <span class="v">${r.hist_move}%</span></div>
    ${opt(L.spread)}${opt(L.directional)}${opt(L.strangle)}
    <div class="why">${live
      ? `This name typically moves further than the ticket needs (${L.required_vs_typical}x). Still a coin flip on any single report — most of these expire worthless.`
      : `Needs a bigger move than this name usually makes (${L.required_vs_typical}x). A true long shot.`}</div>
  </article>`;
}

function render(){
  const rows=DATA.rows||[], m=DATA.meta||{};
  const inWin=rows.filter(r=>r.window==='ENTRY WINDOW'&&r.best);
  const go=inWin.filter(r=>r.verdict==='WORTH TAKING');
  const marg=inWin.filter(r=>r.verdict==='MARGINAL');
  const no=inWin.filter(r=>r.verdict==='NOT WORTH IT');
  const started=rows.filter(r=>r.window==='RAMP STARTED');
  const late=rows.filter(r=>r.window==='TOO LATE');
  const early=rows.filter(r=>r.window==='TOO EARLY');

  const w=(m.ramp&&m.peak_spread)?Math.min(100,(m.ramp/m.peak_spread)*100):0;
  document.getElementById('ramp').innerHTML=`
    <div class="ramp-h">The ramp, measured across today's scan</div>
    <div class="ramp-b">
      <div class="rstat"><div class="k">Typical expansion</div>
        <div class="v" style="color:${css('--vol')}">+${m.ramp??'—'} pts</div></div>
      <div class="rbar">
        <div class="rtrack"><i style="width:${w}%"></i></div>
        <div class="rlab"><span>flat at +${m.base_spread??'—'} (2+ weeks out)</span>
          <span>peaks at +${m.peak_spread??'—'} (reporting now)</span></div>
      </div>
    </div>`;

  const sec=(list,tag,label,note)=>list.length?`<section class="group">
      <div class="gh"><span class="tag ${tag}">${label}</span>
        <span style="color:var(--ink-3);font-size:12.5px">${list.length} name${list.length>1?'s':''}</span></div>
      <p class="gnote">${note}</p>
      <div class="cards">${list.map(card).join('')}</div></section>`:'';

  const chips=(list,tag,label,note)=>list.length?`<section class="group">
      <div class="gh"><span class="tag ${tag}">${label}</span>
        <span style="color:var(--ink-3);font-size:12.5px">${list.length}</span></div>
      <p class="gnote">${note}</p>
      <div class="slim">${list.map(r=>`<div class="chip"><span class="s">${r.symbol}</span>
        <span class="d">${r.days}d · ${r.date}<br>spread ${r.iv_term_spread??'—'}</span></div>`).join('')}</div>
      </section>`:'';

  document.getElementById('groups').innerHTML =
    sec(go,'go','ENTER NOW','The vol expansion needed to break even is well under what these names typically deliver. Buy the volatility, close on the exit date shown, never hold into the report.')
  + sec(marg,'wait','MARGINAL','Break-even needs most of the typical expansion. Workable, but there is little room for the ramp to disappoint.')
  + sec(no,'stop','NOT WORTH IT','Decay over the holding period costs more than the ramp is likely to deliver. Skip these.')
  + chips(started,'wait','RAMP ALREADY STARTED','Front-month premium is already elevated — the expansion has largely been paid for. If you are in these, this is the window to be taking profit.')
  + (late.filter(r=>r.lotto).length?`<section class="group">
      <div class="gh"><span class="tag" style="background:var(--vol)">LOTTO</span>
        <span style="color:var(--ink-3);font-size:12.5px">${late.filter(r=>r.lotto).length} reporting imminently</span></div>
      <p class="gnote">Too close for the ramp — the expansion is already paid for and there is no time to
        hold and exit. These are the opposite bet: small fixed cost held <em>through</em> the report,
        paying only if the move beats what is priced. Cheapest workable ticket is highlighted.
        Most expire worthless; that is the shape of the trade, not a flaw in it.</p>
      <div class="cards">${late.filter(r=>r.lotto).map(lottoCard).join('')}</div></section>`:'')
  + chips(late.filter(r=>!r.lotto),'stop','TOO CLOSE, NO TICKET','Reporting imminently with no cheap structure available at usable liquidity.')
  + chips(early,'na','TOO EARLY','Further out than the ramp reliably begins. Watch, do not buy.');
}
render();
"""

BODY = """
<div class="wrap">
  <header class="mast">
    <div><h1>Volatility Ramp</h1>
      <div class="sub">Buy vol into earnings &middot; close before the report &middot; never hold the event</div></div>
    <div class="stamp">Updated __STAMP__</div>
  </header>
  <div class="thesis"><strong>The trade:</strong> implied volatility in the expiry containing earnings
  inflates as the announcement approaches. You buy that volatility while the term structure is still
  flat and you close the position the day <em>before</em> the report &mdash; so you collect the expansion
  and take neither the volatility crush nor the overnight gap. The enemy is time decay, so every card
  below shows how far implied has to climb just to cover the bleed, against how far it typically climbs.</div>
  <div class="ramp" id="ramp"></div>
  <div id="groups"></div>
  <div class="method">
    <h3>How this is measured</h3>
    <p><strong>The ramp</strong> is estimated from this scan's own cross-section: names two or more weeks out show the flat term structure, names reporting immediately show the inflated one, and the gap between them is the expansion. Per-name historical implied vol is not in the free feed, so this is a market-wide figure, not a name-specific one.</p>
    <p><strong>Required rise</strong> is the decay over the holding period divided by vega &mdash; how many volatility points implied must gain before the position is merely flat. Compare it to the ramp bar beneath: comfortably shorter is a real edge, longer is a losing wait.</p>
    <p><strong>Calendars</strong> sell an expiry landing before the report and buy the one containing it. The near leg decays faster, so the position is long volatility while time works <em>for</em> you rather than against. That is why they usually need almost no expansion to break even.</p>
    <p><strong>The catch with calendars</strong> is that their risk is directional, not decay: the position wants the stock near the strike. A quiet name drifting sideways is ideal; a big move either way erodes it no matter what volatility does. Each card states its tolerance.</p>
    <p><strong>Straddles</strong> buy the at-the-money call and put outright. Direction agnostic and simple, but they pay full decay, which is why their break-even requirement is usually several times a calendar's.</p>
    <p><strong>Lotto tickets</strong> are a separate trade for names reporting within two days, where the ramp is over. Strikes sit at the market's own expected-move boundary, so they pay only if the stock beats what is priced. Required move is compared against what the name typically does on earnings day &mdash; under 1.0 means it routinely travels far enough, though that is a base rate, not a prediction for any single report.</p>
    <p><strong>The exit date</strong> is one trading day before the report, stepped back over a weekend. Holding past it converts a volatility trade into an earnings bet &mdash; which is the opposite of the intent.</p>
  </div>
  <div class="disclaim"><strong>Analysis only.</strong> Lotto tickets are held through the announcement
  and are expected to lose most of the time &mdash; options priced fairly carry no edge, and these sit beyond
  the expected move deliberately. Their appeal is a capped cost against an occasional large multiple, which
  only works if each one is small enough that a string of total losses does not matter. Nothing here is placed, ordered, or executed &mdash; and none of it is financial advice. This strategy has <em>not</em> been backtested: historical implied volatility is not available on the free feed, so the ramp figure is inferred from a single day's cross-section and could be wrong. Report dates marked estimated can move by weeks, which would put your expiry on the wrong side of the event. Quotes are delayed roughly 15 minutes, and when the market is closed the book is empty
  &mdash; contracts then get priced off their last trade, which can sit far from the real mid. Cards
  priced that way say so. Verify pricing and dates against a live book before acting.</div>
</div>
"""


def build(rows, meta, out_path):
    payload = json.dumps({"rows": rows, "meta": meta}, separators=(",", ":"), default=str)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%d %b %Y, %H:%M UTC")
    html = ("<title>Volatility Ramp — Pre-Earnings Vol Expansion</title>\n"
            f"<style>{CSS}</style>\n"
            f"{BODY.replace('__STAMP__', stamp)}\n"
            f"<script>\nconst DATA = {payload};\n{JS}\n</script>\n")
    with open(out_path, "w") as f:
        f.write(html)
    return out_path
