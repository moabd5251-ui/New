"""Render the options dashboard: open positions (live P&L) + screened candidates."""
import json, datetime

CSS = """
:root{
  --ground:#F6F7FA; --surface:#FFFFFF; --surface-2:#EEF1F6; --line:#DCE1EA;
  --ink:#1D2430; --ink-2:#4A5364; --ink-3:#79839A;
  --accent:#3E5C89; --accent-soft:#E4EAF4;
  --profit:#1F8A5F; --loss:#C4453C; --caution:#B37A1E;
  --grid:#E7EBF2;
  --sans:ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --serif:Georgia,"Iowan Old Style","Times New Roman",serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){
  :root{
    --ground:#11141B; --surface:#191D26; --surface-2:#212734; --line:#2C3341;
    --ink:#DFE5EF; --ink-2:#A5AFC1; --ink-3:#727D91;
    --accent:#7D9BCC; --accent-soft:#1E2735;
    --profit:#43B583; --loss:#E0685E; --caution:#D3A244;
    --grid:#242B37;
  }
}
:root[data-theme="dark"]{
  --ground:#11141B; --surface:#191D26; --surface-2:#212734; --line:#2C3341;
  --ink:#DFE5EF; --ink-2:#A5AFC1; --ink-3:#727D91;
  --accent:#7D9BCC; --accent-soft:#1E2735;
  --profit:#43B583; --loss:#E0685E; --caution:#D3A244;
  --grid:#242B37;
}
:root[data-theme="light"]{
  --ground:#F6F7FA; --surface:#FFFFFF; --surface-2:#EEF1F6; --line:#DCE1EA;
  --ink:#1D2430; --ink-2:#4A5364; --ink-3:#79839A;
  --accent:#3E5C89; --accent-soft:#E4EAF4;
  --profit:#1F8A5F; --loss:#C4453C; --caution:#B37A1E;
  --grid:#E7EBF2;
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);
  font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:1180px;margin:0 auto;padding:40px 24px 72px}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
header.masthead{border-bottom:2px solid var(--ink);padding-bottom:18px;margin-bottom:26px;
  display:flex;justify-content:space-between;align-items:flex-end;gap:20px;flex-wrap:wrap}
h1{font-family:var(--serif);font-weight:600;font-size:clamp(26px,4vw,38px);margin:0;
  letter-spacing:-.01em;text-wrap:balance}
.sub{color:var(--ink-3);font-size:13px;margin-top:5px}
.stamp{font-family:var(--mono);font-size:11.5px;color:var(--ink-3);text-align:right;
  text-transform:uppercase;letter-spacing:.07em;white-space:nowrap}
.regime{background:var(--surface);border:1px solid var(--line);border-radius:3px;
  margin-bottom:30px;overflow:hidden}
.regime-head{display:flex;align-items:center;gap:10px;padding:13px 18px;
  background:var(--surface-2);border-bottom:1px solid var(--line)}
.regime-head h2{font-family:var(--sans);font-size:11px;font-weight:700;margin:0;
  text-transform:uppercase;letter-spacing:.1em;color:var(--ink-2)}
.verdict{margin-left:auto;font-family:var(--mono);font-size:12px;font-weight:700;
  background:var(--accent);color:#FFFFFF;padding:3px 11px;border-radius:2px;letter-spacing:.04em}
@media (prefers-color-scheme:dark){.verdict{color:#11141B}}
:root[data-theme="dark"] .verdict{color:#11141B}
:root[data-theme="light"] .verdict{color:#FFFFFF}
.gauges{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:0}
.gauge{padding:15px 18px;border-right:1px solid var(--line)}
.gauge:last-child{border-right:0}
.gauge .k{font-size:10.5px;text-transform:uppercase;letter-spacing:.09em;color:var(--ink-3);margin-bottom:5px}
.gauge .v{font-family:var(--mono);font-size:19px;font-weight:600;letter-spacing:-.02em}
.gauge .n{font-size:11.5px;color:var(--ink-3);margin-top:2px}
.rationale{padding:13px 18px;border-top:1px solid var(--line);font-size:13.5px;color:var(--ink-2);
  background:var(--accent-soft)}
.section-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;
  color:var(--ink-3);margin:34px 0 4px}
.section-label:first-of-type{margin-top:0}
.section-note{font-size:13px;color:var(--ink-3);margin:0 0 18px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:18px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:3px;
  display:flex;flex-direction:column;overflow:hidden}
.card.held{border-color:var(--accent);border-width:1.5px}
.card-top{padding:15px 17px 13px;border-bottom:1px solid var(--line)}
.tick{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}
.tick .sym{font-family:var(--serif);font-size:24px;font-weight:600;letter-spacing:-.01em}
.dir{font-family:var(--mono);font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:2px;
  letter-spacing:.06em}
.dir.long{background:color-mix(in srgb,var(--profit) 15%,transparent);color:var(--profit)}
.dir.short{background:color-mix(in srgb,var(--loss) 15%,transparent);color:var(--loss)}
.tick .spot{margin-left:auto;font-family:var(--mono);font-size:15px;color:var(--ink-2)}
.struct{font-family:var(--mono);font-size:11.5px;color:var(--ink-3);margin-top:7px;letter-spacing:.02em}
.pnlbar{padding:11px 17px;border-bottom:1px solid var(--line);display:flex;
  align-items:baseline;gap:10px;flex-wrap:wrap}
.pnlbar .big{font-family:var(--mono);font-size:22px;font-weight:700;letter-spacing:-.02em}
.pnlbar .pct{font-family:var(--mono);font-size:13px;color:var(--ink-3)}
.track{flex:1 0 100%;height:5px;background:var(--surface-2);border-radius:3px;overflow:hidden;margin-top:7px}
.track i{display:block;height:100%;border-radius:3px}
canvas.payoff{display:block;width:100%;height:132px;background:var(--surface)}
.legs{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--line);
  border-bottom:1px solid var(--line)}
.leg{padding:10px 17px;font-size:12px}
.leg:first-child{border-right:1px solid var(--line)}
.leg .lk{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3)}
.leg .lv{font-family:var(--mono);font-size:14px;font-weight:600;margin-top:2px}
.leg .lm{font-family:var(--mono);font-size:11px;color:var(--ink-3);margin-top:1px}
.stats{display:grid;grid-template-columns:repeat(3,1fr)}
.stat{padding:11px 17px;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}
.stat:nth-child(3n){border-right:0}
.stat .k{font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3)}
.stat .v{font-family:var(--mono);font-size:15px;font-weight:600;margin-top:3px}
.v.pos{color:var(--profit)} .v.neg{color:var(--loss)}
.greeks{display:flex;border-bottom:1px solid var(--line)}
.gk{flex:1;padding:9px 17px;border-right:1px solid var(--line)}
.gk:last-child{border-right:0}
.gk .k{font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3)}
.gk .v{font-family:var(--mono);font-size:13px;margin-top:2px}
.foot{padding:10px 17px;margin-top:auto;font-size:11.5px;color:var(--ink-3);
  font-family:var(--mono);display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}
.warn{padding:9px 17px;background:color-mix(in srgb,var(--caution) 13%,transparent);
  color:var(--caution);font-size:12px;font-weight:600;border-bottom:1px solid var(--line)}
.empty{background:var(--surface);border:1px dashed var(--line);border-radius:3px;
  padding:22px;color:var(--ink-3);font-size:13.5px}
.method{margin-top:34px;border-top:1px solid var(--line);padding-top:20px;
  font-size:13px;color:var(--ink-2);columns:2;column-gap:34px}
.method h3{font-family:var(--sans);font-size:11px;text-transform:uppercase;letter-spacing:.1em;
  color:var(--ink-3);margin:0 0 8px;column-span:all}
.method p{margin:0 0 10px;break-inside:avoid}
.method strong{color:var(--ink)}
.disclaim{margin-top:22px;padding:13px 16px;background:var(--surface-2);border-left:3px solid var(--caution);
  font-size:12.5px;color:var(--ink-2);border-radius:0 2px 2px 0}
@media (max-width:720px){.method{columns:1}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
"""

JS = r"""
function money(n){return (n<0?"-$":"$")+Math.abs(n).toLocaleString(undefined,{maximumFractionDigits:0});}
function css(v){return getComputedStyle(document.documentElement).getPropertyValue(v).trim();}

function renderRegime(){
  const r=DATA.regime, bull=r.tscore>0;
  document.getElementById('regime').innerHTML=`
    <div class="regime-head"><h2>Market regime</h2>
      <span class="verdict">${r.spread_type} SPREADS</span></div>
    <div class="gauges">
      <div class="gauge"><div class="k">S&amp;P trend</div>
        <div class="v" style="color:${bull?css('--profit'):css('--loss')}">${r.trend}</div>
        <div class="n">SPY ${r.spy}</div></div>
      <div class="gauge"><div class="k">Implied vol</div><div class="v">${r.vol_regime}</div>
        <div class="n">VIX ${r.vix} &middot; ${r.vix_pctile}th pctile</div></div>
      <div class="gauge"><div class="k">Realised vol</div><div class="v">${r.realized_vol}%</div>
        <div class="n">20-day, annualised</div></div>
      <div class="gauge"><div class="k">20 / 50 / 200 DMA</div>
        <div class="v" style="font-size:14px">${r.ema20} / ${r.sma50} / ${r.sma200}</div>
        <div class="n">SPY moving averages</div></div>
    </div>
    <div class="rationale">${r.rationale}</div>`;
}

function payoffAt(s,S){
  const call=s.structure.includes('CALL'), lo=s.long_strike, sh=s.short_strike, net=s.net;
  const v = call ? Math.min(Math.max(S-lo,0), sh-lo)-net : Math.min(Math.max(lo-S,0), lo-sh)-net;
  return v*100;
}

function drawPayoff(cv,s){
  const dpr=window.devicePixelRatio||1, W=cv.clientWidth, H=cv.clientHeight;
  if(!W) return;
  cv.width=W*dpr; cv.height=H*dpr;
  const x=cv.getContext('2d'); x.setTransform(dpr,0,0,dpr,0,0); x.clearRect(0,0,W,H);
  const loK=Math.min(s.long_strike,s.short_strike), hiK=Math.max(s.long_strike,s.short_strike);
  const pad=(hiK-loK)*0.55, xMin=loK-pad, xMax=hiK+pad;
  const yMax=s.max_profit*100, yMin=-s.max_loss*100, yPad=(yMax-yMin)*0.18;
  const L=8,R=8,T=12,B=18, pw=W-L-R, ph=H-T-B;
  const px=S=>L+(S-xMin)/(xMax-xMin)*pw;
  const py=v=>T+ph-((v-(yMin-yPad))/((yMax+yPad)-(yMin-yPad)))*ph;
  const beX=px(s.breakeven);
  const capX=px(s.structure.includes('CALL')?hiK:loK);
  x.fillStyle=css('--profit')+'22';
  x.fillRect(Math.min(beX,capX),T,Math.abs(capX-beX),ph);
  x.strokeStyle=css('--grid'); x.lineWidth=1;
  x.beginPath(); x.moveTo(L,py(0)); x.lineTo(W-R,py(0)); x.stroke();
  x.beginPath();
  for(let i=0;i<=140;i++){
    const S=xMin+(xMax-xMin)*i/140;
    i?x.lineTo(px(S),py(payoffAt(s,S))):x.moveTo(px(S),py(payoffAt(s,S)));
  }
  x.strokeStyle=css('--accent'); x.lineWidth=2.2; x.lineJoin='round'; x.stroke();
  x.setLineDash([3,3]); x.strokeStyle=css('--ink-3'); x.lineWidth=1;
  x.beginPath(); x.moveTo(beX,T); x.lineTo(beX,T+ph); x.stroke(); x.setLineDash([]);
  const sx=px(s.spot);
  if(sx>L&&sx<W-R){
    x.strokeStyle=css('--ink'); x.lineWidth=1.5;
    x.beginPath(); x.moveTo(sx,T); x.lineTo(sx,T+ph); x.stroke();
    x.fillStyle=css('--ink'); x.beginPath(); x.arc(sx,py(payoffAt(s,s.spot)),3.2,0,7); x.fill();
  }
  x.font='10px '+css('--mono'); x.fillStyle=css('--ink-3');
  x.fillText('BE '+s.breakeven,Math.min(beX+4,W-62),H-6);
  x.fillText('spot',Math.max(4,Math.min(sx-11,W-30)),T+9);
}

function card(s,held,idx){
  const pnlClass = held ? (s.pnl>=0?'pos':'neg') : '';
  const pnlBlock = held ? `
    <div class="pnlbar">
      <span class="big ${pnlClass}" style="color:${s.pnl>=0?css('--profit'):css('--loss')}">${s.pnl>=0?'+':''}${money(s.pnl)}</span>
      <span class="pct">${s.pct_of_max>=0?'+':''}${s.pct_of_max}% of max profit &middot; ${s.dte}d left</span>
      <span class="track"><i style="width:${Math.min(Math.abs(s.pct_of_max),100)}%;background:${s.pnl>=0?css('--profit'):css('--loss')}"></i></span>
    </div>`:'';
  return `<article class="card ${held?'held':''}">
    <div class="card-top">
      <div class="tick"><span class="sym">${s.symbol}</span>
        <span class="dir ${s.bias.toLowerCase()}">${s.bias==='LONG'?'BULLISH':'BEARISH'}</span>
        <span class="spot num">${s.spot}</span></div>
      <div class="struct">${s.structure} &middot; ${s.expiry} &middot; ${s.dte}d</div>
    </div>
    ${(!held && Math.abs(s.drift_atr||0)>1) ? `<div class="warn">Chase risk — price ran ${(s.drift_atr).toFixed(1)} ATR past last close</div>`:''}
    ${s.mark_error ? `<div class="warn">Could not price: ${s.mark_error}</div>`:''}
    ${pnlBlock}
    <canvas class="payoff" data-k="${held?'h':'c'}${idx}"></canvas>
    <div class="legs">
      <div class="leg"><div class="lk">Buy</div><div class="lv num">${s.long_strike}</div>
        <div class="lm">IV ${s.long_iv}% &middot; OI ${(s.long_oi||0).toLocaleString()}</div></div>
      <div class="leg"><div class="lk">Sell</div><div class="lv num">${s.short_strike}</div>
        <div class="lm">IV ${s.short_iv}% &middot; OI ${(s.short_oi||0).toLocaleString()}</div></div>
    </div>
    <div class="stats">
      <div class="stat"><div class="k">${held?'Entry cost':'Cost'}</div><div class="v num">${money(s.cost_per_spread)}</div></div>
      <div class="stat"><div class="k">Max gain</div><div class="v num pos">${money(s.max_profit*100)}</div></div>
      <div class="stat"><div class="k">Max loss</div><div class="v num neg">${money(s.max_loss*100)}</div></div>
      <div class="stat"><div class="k">Reward : risk</div><div class="v num">${s.rr}:1</div></div>
      <div class="stat"><div class="k">Breakeven</div><div class="v num">${s.breakeven}</div></div>
      <div class="stat"><div class="k">${held?'Mark':'Prob. of profit'}</div><div class="v num">${held?s.mark:(s.pop+'%')}</div></div>
    </div>
    <div class="greeks">
      <div class="gk"><div class="k">Delta</div><div class="v num">${s.net_delta>0?'+':''}${s.net_delta}</div></div>
      <div class="gk"><div class="k">Theta / day</div><div class="v num">${s.net_theta}</div></div>
      <div class="gk"><div class="k">Vega</div><div class="v num">${s.net_vega>0?'+':''}${s.net_vega}</div></div>
    </div>
    <div class="foot"><span>${held?('held since '+(s.opened_at||'—').slice(0,10)):('confluence '+s.cs+' · rvol '+s.rvol+'%')}</span>
      <span>${held?('qty '+(s.qty||1)):('1m '+(s.mom_1m>0?'+':'')+s.mom_1m+'%')}</span></div>
  </article>`;
}

function render(){
  const open=(DATA.positions||[]).filter(p=>p.status==='open');
  const cand=DATA.spreads||[];
  document.getElementById('open').innerHTML = open.length
    ? open.map((s,i)=>card(s,true,i)).join('')
    : `<div class="empty">No open positions tracked. Tell Claude which spread you took and it will appear here with live P&amp;L, and start pushing milestone alerts.</div>`;
  document.getElementById('cands').innerHTML = cand.map((s,i)=>card(s,false,i)).join('');
  redraw();
}
function redraw(){
  const open=(DATA.positions||[]).filter(p=>p.status==='open'), cand=DATA.spreads||[];
  document.querySelectorAll('canvas.payoff').forEach(cv=>{
    const k=cv.dataset.k, i=+k.slice(1);
    const s = k[0]==='h' ? open[i] : cand[i];
    if(s) drawPayoff(cv,s);
  });
}
renderRegime(); render();
addEventListener('resize',redraw);
matchMedia('(prefers-color-scheme:dark)').addEventListener('change',()=>setTimeout(redraw,40));
new MutationObserver(()=>setTimeout(redraw,40))
  .observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
"""

BODY = """
<div class="wrap">
  <header class="masthead">
    <div><h1>Options Portfolio</h1>
      <div class="sub">Defined-risk vertical spreads &middot; liquid mega-caps &amp; index ETFs</div></div>
    <div class="stamp">Updated __STAMP__</div>
  </header>
  <div class="regime" id="regime"></div>
  <p class="section-label">Open positions</p>
  <p class="section-note">Marked against live chains each run. Alerts fire at half of max profit, at breakeven crossings, at half of max risk, and inside seven days to expiry.</p>
  <div class="cards" id="open"></div>
  <p class="section-label">Candidate spreads</p>
  <p class="section-note">Fresh from today's screen. Shaded band is the profit zone; the payoff is bounded on both ends by construction.</p>
  <div class="cards" id="cands"></div>
  <div class="method">
    <h3>How these were built</h3>
    <p><strong>Regime</strong> classifies SPY trend against its 20/50/200 averages and reads implied vol from VIX against its own 1-year distribution. Cheap vol favours paying premium (debit); rich vol favours selling it (credit).</p>
    <p><strong>Screening</strong> scores confluence where swing highs/lows, Fibonacci retracements and moving averages cluster. Indicators use completed daily bars; direction is judged against the live price so an intraday move can't leave a stale signal standing.</p>
    <p><strong>Contracts</strong> are drawn from live chains, then filtered on open interest, traded volume and bid/ask width. Both legs must clear those tests independently.</p>
    <p><strong>Greeks</strong> are computed with Black&ndash;Scholes from each contract's implied volatility &mdash; exchanges publish the vol, not the sensitivities. Treat them as close approximations around dividends and early exercise.</p>
    <p><strong>Probability of profit</strong> is the lognormal chance of finishing past breakeven at expiry. It assumes no drift and constant vol, so read it as a rough ranking tool, not a forecast.</p>
    <p><strong>Chase risk</strong> flags a name whose live price has already run more than one ATR past the last close &mdash; the setup formed before the move, so the entry may be gone.</p>
  </div>
  <div class="disclaim"><strong>Analysis only.</strong> Nothing here is placed, ordered, or executed &mdash; and none of it is financial advice. Quotes are free-tier and delayed roughly 15 minutes; bid/ask goes stale outside market hours, so verify live pricing before acting. Max loss on a debit spread is the premium paid, but only if held to expiry as constructed.</div>
</div>
"""


def build(regime, spreads, positions, out_path):
    payload = json.dumps({"regime": regime, "spreads": spreads, "positions": positions},
                         separators=(",", ":"), default=str)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%d %b %Y, %H:%M UTC")
    html = ("<title>Options Portfolio — Defined-Risk Spreads</title>\n"
            f"<style>{CSS}</style>\n"
            f"{BODY.replace('__STAMP__', stamp)}\n"
            f"<script>\nconst DATA = {payload};\n{JS}\n</script>\n")
    with open(out_path, "w") as f:
        f.write(html)
    return out_path
