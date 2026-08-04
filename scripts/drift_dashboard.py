"""Render the post-earnings drift dashboard."""
import json, datetime

CSS = """
:root{
  --ground:#F6F8F7; --surface:#FFFFFF; --surface-2:#EAEEEC; --line:#D7DEDA;
  --ink:#1A211E; --ink-2:#465049; --ink-3:#75807A;
  --accent:#2C6E56; --accent-soft:#E2EDE8;
  --up:#1F7A5A; --down:#B4443E; --flat:#75807A; --warn:#A8761C;
  --sans:ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --serif:Georgia,"Iowan Old Style","Times New Roman",serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){
  :root{
    --ground:#101614; --surface:#18201D; --surface-2:#212A26; --line:#2C3733;
    --ink:#DFE7E3; --ink-2:#A3AFA9; --ink-3:#75807A;
    --accent:#6FB79A; --accent-soft:#1B2621;
    --up:#46B189; --down:#DE6A63; --flat:#75807A; --warn:#CFA052;
  }
}
:root[data-theme="dark"]{
  --ground:#101614; --surface:#18201D; --surface-2:#212A26; --line:#2C3733;
  --ink:#DFE7E3; --ink-2:#A3AFA9; --ink-3:#75807A;
  --accent:#6FB79A; --accent-soft:#1B2621;
  --up:#46B189; --down:#DE6A63; --flat:#75807A; --warn:#CFA052;
}
:root[data-theme="light"]{
  --ground:#F6F8F7; --surface:#FFFFFF; --surface-2:#EAEEEC; --line:#D7DEDA;
  --ink:#1A211E; --ink-2:#465049; --ink-3:#75807A;
  --accent:#2C6E56; --accent-soft:#E2EDE8;
  --up:#1F7A5A; --down:#B4443E; --flat:#75807A; --warn:#A8761C;
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
  font-size:13.5px;color:var(--ink-2);margin-bottom:16px;border-radius:0 2px 2px 0}
.thesis strong{color:var(--ink)}
.trap{background:color-mix(in srgb,var(--warn) 12%,transparent);border-left:3px solid var(--warn);
  padding:14px 17px;font-size:13.5px;color:var(--ink-2);margin-bottom:26px;border-radius:0 2px 2px 0}
.trap strong{color:var(--warn)}
.group{margin-top:32px}
.group:first-of-type{margin-top:0}
.gh{display:flex;align-items:baseline;gap:10px;margin-bottom:4px;flex-wrap:wrap}
.tag{font-family:var(--mono);font-size:10.5px;font-weight:700;letter-spacing:.07em;
  padding:3px 9px;border-radius:2px;color:#fff}
.tag.hi{background:var(--accent)} .tag.med{background:var(--warn)} .tag.no{background:var(--flat)}
.gnote{font-size:13px;color:var(--ink-3);margin:0 0 16px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(370px,1fr));gap:18px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:3px;
  display:flex;flex-direction:column;overflow:hidden}
.card.up{border-top:3px solid var(--up)} .card.down{border-top:3px solid var(--down)}
.top{padding:14px 17px 12px;border-bottom:1px solid var(--line)}
.tick{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}
.tick .sym{font-family:var(--serif);font-size:23px;font-weight:600}
.dirchip{font-family:var(--mono);font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:2px}
.dirchip.up{background:color-mix(in srgb,var(--up) 16%,transparent);color:var(--up)}
.dirchip.down{background:color-mix(in srgb,var(--down) 16%,transparent);color:var(--down)}
.tick .spot{margin-left:auto;font-family:var(--mono);font-size:14px;color:var(--ink-2)}
.meta{display:flex;gap:8px;margin-top:7px;font-family:var(--mono);font-size:11px;
  color:var(--ink-3);flex-wrap:wrap}
canvas.path{display:block;width:100%;height:104px;background:var(--surface)}
.state{padding:10px 17px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);
  font-size:12.5px;color:var(--ink-2)}
.state b{font-family:var(--mono);font-size:11px;letter-spacing:.05em;text-transform:uppercase}
.stats{display:grid;grid-template-columns:repeat(3,1fr)}
.stat{padding:10px 17px;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}
.stat:nth-child(3n){border-right:0}
.stat .k{font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3)}
.stat .v{font-family:var(--mono);font-size:14.5px;font-weight:600;margin-top:3px}
.v.up{color:var(--up)} .v.down{color:var(--down)}
.struct{padding:9px 17px;border-bottom:1px solid var(--line);display:flex;
  justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap}
.struct .st{font-family:var(--mono);font-size:11px;color:var(--ink-3);
  text-transform:uppercase;letter-spacing:.05em}
.struct .lg{font-family:var(--mono);font-size:13px}
.struct .px{font-family:var(--mono);font-size:13px;font-weight:600;margin-left:auto}
.struct .nt{flex-basis:100%;font-size:11.5px;color:var(--ink-3);margin-top:3px}
.warn{padding:8px 17px;background:color-mix(in srgb,var(--warn) 14%,transparent);
  color:var(--warn);font-size:11.5px;font-weight:600;border-bottom:1px solid var(--line)}
.foot{padding:9px 17px;margin-top:auto;border-top:1px solid var(--line);
  font-family:var(--mono);font-size:11px;color:var(--ink-3);
  display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
.slim{display:grid;grid-template-columns:repeat(auto-fill,minmax(215px,1fr));gap:10px}
.chip2{background:var(--surface);border:1px solid var(--line);border-radius:3px;padding:10px 13px;
  display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.chip2 .s{font-family:var(--serif);font-size:16px;font-weight:600}
.chip2 .d{font-family:var(--mono);font-size:11px;color:var(--ink-3);text-align:right}
.method{margin-top:36px;border-top:1px solid var(--line);padding-top:20px;
  font-size:13px;color:var(--ink-2);columns:2;column-gap:34px}
.method h3{font-family:var(--sans);font-size:11px;text-transform:uppercase;letter-spacing:.1em;
  color:var(--ink-3);margin:0 0 8px;column-span:all}
.method p{margin:0 0 10px;break-inside:avoid}
.method strong{color:var(--ink)}
.disclaim{margin-top:22px;padding:13px 16px;background:var(--surface-2);
  border-left:3px solid var(--down);font-size:12.5px;color:var(--ink-2);border-radius:0 2px 2px 0}
@media (max-width:720px){.method{columns:1}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
"""

JS = r"""
function css(v){return getComputedStyle(document.documentElement).getPropertyValue(v).trim();}
function money(n){return "$"+Math.abs(Math.round(n)).toLocaleString();}

function drawPath(cv,r){
  const dpr=window.devicePixelRatio||1, W=cv.clientWidth, H=cv.clientHeight;
  if(!W) return;
  cv.width=W*dpr; cv.height=H*dpr;
  const x=cv.getContext('2d'); x.setTransform(dpr,0,0,dpr,0,0); x.clearRect(0,0,W,H);
  const up=r.direction==='UP', col=up?css('--up'):css('--down');
  const pts=[r.pre_close, r.react_close, r.spot];
  const all=pts.concat([r.stop,r.target]);
  const lo=Math.min(...all), hi=Math.max(...all), pad=(hi-lo)*0.16||1;
  const L=44,R=44,T=14,B=20, pw=W-L-R, ph=H-T-B;
  const py=v=>T+ph-((v-(lo-pad))/((hi+pad)-(lo-pad)))*ph;
  const px=i=>L+(pw*i/2);

  // target / stop bands
  x.fillStyle=col+'18';
  x.fillRect(L,Math.min(py(r.target),py(r.spot)),pw,Math.abs(py(r.target)-py(r.spot)));
  x.setLineDash([3,3]); x.lineWidth=1;
  x.strokeStyle=css('--ink-3');
  [[r.stop,'stop'],[r.target,'target']].forEach(([v,lab])=>{
    x.beginPath(); x.moveTo(L,py(v)); x.lineTo(W-R,py(v)); x.stroke();
    x.font='9.5px '+css('--mono'); x.fillStyle=css('--ink-3');
    x.fillText(lab+' '+v, W-R+3, py(v)+3);
  });
  x.setLineDash([]);

  // the journey: pre-report close -> reaction close -> now
  x.beginPath();
  pts.forEach((v,i)=> i?x.lineTo(px(i),py(v)):x.moveTo(px(i),py(v)));
  x.strokeStyle=col; x.lineWidth=2.2; x.lineJoin='round'; x.stroke();
  pts.forEach((v,i)=>{
    x.beginPath(); x.arc(px(i),py(v),3.4,0,7);
    x.fillStyle=i===1?col:css('--surface'); x.strokeStyle=col; x.lineWidth=2;
    x.fill(); x.stroke();
  });
  x.font='9.5px '+css('--mono'); x.fillStyle=css('--ink-3'); x.textAlign='center';
  ['pre','gap','now'].forEach((lab,i)=>x.fillText(lab,px(i),H-6));
  x.textAlign='left';
  x.fillText(r.pre_close, 2, py(r.pre_close)+3);
}

function card(r){
  const up=r.direction==='UP', S=r.structures||{};
  const poor=(r.rr!=null&&r.rr<1);
  const st=(s)=>s?`<div class="struct"><span class="st">${s.structure}</span>
     <span class="lg">${s.legs}</span><span class="px">${money(s.cost)}</span>
     <span class="nt">${s.note}${s.vega!=null&&s.vega!==0?` · vega ${s.vega}`:''}${
       s.rr?` · R:R ${s.rr}:1`:''}</span></div>`:'';
  return `<article class="card ${up?'up':'down'}">
    <div class="top">
      <div class="tick"><span class="sym">${r.symbol}</span>
        <span class="dirchip ${up?'up':'down'}">${up?'DRIFT UP':'DRIFT DOWN'}</span>
        <span class="spot num">${r.spot}</span></div>
      <div class="meta"><span>gapped ${r.gap_pct>0?'+':''}${r.gap_pct}% on ${r.date}</span>
        <span>· ${r.vol_ratio}x volume</span><span>· ${r.days_since}d ago</span></div>
    </div>
    ${r.structures&&Object.values(r.structures).some(s=>s.stale)?
      `<div class="warn">Option prices off last trade — market closed</div>`:''}
    ${poor?`<div class="warn">Target only ${r.rr}:1 from here — little room before the next level</div>`:''}
    <canvas class="path" data-s="${r.symbol}"></canvas>
    <div class="state"><b style="color:${up?css('--up'):css('--down')}">${r.state}</b> — ${r.state_note}</div>
    <div class="stats">
      <div class="stat"><div class="k">Since gap</div>
        <div class="v ${r.drift_since>0?'up':'down'}">${r.drift_since>0?'+':''}${r.drift_since}%</div></div>
      <div class="stat"><div class="k">Stop</div><div class="v">${r.stop}</div></div>
      <div class="stat"><div class="k">Target</div><div class="v">${r.target}</div></div>
    </div>
    ${st(S.shares)}${st(S.deep_itm)}${st(S.vertical)}
    <div class="foot"><span>ATR ${r.atr}</span>
      <span>${r.beat_rate!=null?`beat ${r.beat_rate}% of last ${4}q`:''}</span></div>
  </article>`;
}

function render(){
  const rows=DATA.rows||[];
  const hi=rows.filter(r=>r.conviction==='HIGH');
  const med=rows.filter(r=>r.conviction==='MEDIUM');
  const dead=rows.filter(r=>r.conviction==='NONE');
  const sec=(list,tag,label,note)=>list.length?`<section class="group">
      <div class="gh"><span class="tag ${tag}">${label}</span>
        <span style="color:var(--ink-3);font-size:12.5px">${list.length}</span></div>
      <p class="gnote">${note}</p>
      <div class="cards">${list.map(card).join('')}</div></section>`:'';
  document.getElementById('groups').innerHTML =
    sec(hi,'hi','HIGH CONVICTION','Large gap, heavy volume confirming it, still inside the first week, and the level is holding. These are the cleanest drift setups on the board.')
  + sec(med,'med','WORTH WATCHING','The gap is intact and recent, but either the move was modest or volume did not confirm it. Smaller size, or wait for the level to prove itself.')
  + (dead.length?`<section class="group">
      <div class="gh"><span class="tag no">NO LONGER TRADEABLE</span>
        <span style="color:var(--ink-3);font-size:12.5px">${dead.length}</span></div>
      <p class="gnote">Gap filled, drift stalled, or past the window where the effect persists. Listed so you can see what was rejected and why.</p>
      <div class="slim">${dead.map(r=>`<div class="chip2"><span class="s">${r.symbol}</span>
        <span class="d">${r.gap_pct>0?'+':''}${r.gap_pct}% · ${r.days_since}d<br>${r.state}</span></div>`).join('')}</div>
      </section>`:'');
  redraw();
}
function redraw(){
  const byS={}; (DATA.rows||[]).forEach(r=>byS[r.symbol]=r);
  document.querySelectorAll('canvas.path').forEach(cv=>{
    const r=byS[cv.dataset.s]; if(r) drawPath(cv,r);
  });
}
render();
addEventListener('resize',redraw);
matchMedia('(prefers-color-scheme:dark)').addEventListener('change',()=>setTimeout(redraw,40));
new MutationObserver(()=>setTimeout(redraw,40))
  .observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
"""

BODY = """
<div class="wrap">
  <header class="mast">
    <div><h1>Earnings Drift</h1>
      <div class="sub">Trade with the gap, after the report &middot; low-vega structures only</div></div>
    <div class="stamp">Updated __STAMP__</div>
  </header>
  <div class="thesis"><strong>The premise:</strong> a stock that gaps on an earnings surprise tends to keep
  travelling that way for days to weeks rather than repricing instantly. The effect is strongest in the first
  week, fades over a couple of months, and is far more reliable when heavy volume confirmed the gap. What
  kills it is the gap filling &mdash; price back through the pre-report close means the market rejected the
  surprise and there is nothing left to ride.</div>
  <div class="trap"><strong>The trap this avoids:</strong> implied volatility collapses the instant the report
  lands. Buy a call after a beat and the crush routinely eats more than the direction earns &mdash; you are
  right about the stock and still lose money. Every structure below is deliberately low-vega: shares, deep
  in-the-money options that behave like shares, or debit spreads whose short leg cancels most of what is left.
  Long at-the-money options are the obvious instrument here and the wrong one.</div>
  <div id="groups"></div>
  <div class="method">
    <h3>How this is measured</h3>
    <p><strong>The reaction bar</strong> is found by scanning for the largest opening gap within three days of the reported date, then measured two ways: the gap itself (open against the prior close) and the full-day move (close against prior close). They diverge when the gap gets bought or sold into, which is itself informative.</p>
    <p><strong>Volume confirmation</strong> compares reaction-day volume to its trailing 21-day average. Drift on heavy volume reflects real repositioning; on light volume it is closer to noise, and those names are demoted regardless of gap size.</p>
    <p><strong>Gap fill</strong> is the disqualifier. If any bar since the reaction has traded back through the pre-report close, the surprise has been rejected and the setup is dropped no matter how large the original move.</p>
    <p><strong>Stops and targets</strong> come from the same confluence engine as the other dashboards &mdash; stop behind the nearest swing beyond the reaction, target at the next level in the drift direction. Where that target sits close, the card says so rather than presenting a thin trade as a clean one.</p>
    <p><strong>Deep in-the-money</strong> strikes are chosen around 80 delta: they track the stock closely, cost a fraction of the shares, and carry little remaining volatility exposure to lose. The capital figure on each card is what the option costs relative to buying the stock outright.</p>
    <p><strong>The window</strong> is twelve days. Drift is measurable for far longer in the literature, but it is strongest immediately, and anything past the first week here is demoted rather than recommended.</p>
  </div>
  <div class="disclaim"><strong>Analysis only.</strong> Nothing here is placed, ordered, or executed &mdash; and
  none of it is financial advice. This strategy is <em>not backtested</em> here: post-earnings drift is well
  documented in academic work but has weakened as it became widely known, and no measurement of it on this
  universe has been run. Gap and volume figures come from completed daily bars and are solid; option prices are
  delayed and go stale outside market hours, which the cards flag. Verify against a live book before acting.</div>
</div>
"""


def build(rows, out_path):
    payload = json.dumps({"rows": rows}, separators=(",", ":"), default=str)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%d %b %Y, %H:%M UTC")
    html = ("<title>Earnings Drift — Trade With the Gap</title>\n"
            f"<style>{CSS}</style>\n"
            f"{BODY.replace('__STAMP__', stamp)}\n"
            f"<script>\nconst DATA = {payload};\n{JS}\n</script>\n")
    with open(out_path, "w") as f:
        f.write(html)
    return out_path
