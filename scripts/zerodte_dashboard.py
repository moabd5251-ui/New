"""Render the zero-DTE dealer positioning dashboard.

The gamma profile is the point of the page, so it leads: a diverging bar per strike,
calls right and puts left, with spot, the gamma flip and max pain marked on the same
axis. Numbers alone do not show where the hedging force is concentrated relative to
where price actually is, and that relationship is the entire read.
"""
import datetime
import html

from trend_dashboard import CSS as BASE_CSS

CSS = BASE_CSS + """
.hero{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
  background:var(--surface);border:1px solid var(--line);border-radius:3px;margin-bottom:22px}
.hero div{padding:13px 17px;border-right:1px solid var(--line)}
.hero div:last-child{border-right:0}
.hero .k{font-size:10px;text-transform:uppercase;letter-spacing:.09em;color:var(--ink-3)}
.hero .v{font-family:var(--mono);font-size:20px;font-weight:600;margin-top:3px;letter-spacing:-.02em}
.hero .n{font-size:11.5px;color:var(--ink-3);margin-top:2px}
.regime{padding:13px 17px;border-radius:0 2px 2px 0;margin-bottom:20px;font-size:14px;
  border-left:3px solid}
.regime.long{background:color-mix(in srgb,var(--up) 11%,transparent);border-color:var(--up)}
.regime.short{background:color-mix(in srgb,var(--down) 11%,transparent);border-color:var(--down)}
.regime b{display:block;font-size:15px;margin-bottom:3px;color:var(--ink)}
.gx{background:var(--surface);border:1px solid var(--line);border-radius:3px;
  padding:14px 8px;margin-bottom:24px;overflow-x:auto}
.gxrow{display:grid;grid-template-columns:62px 1fr 62px;align-items:center;
  gap:6px;height:19px;min-width:520px}
.gxrow.spot{background:color-mix(in srgb,var(--accent) 14%,transparent)}
.gxrow.pain{background:color-mix(in srgb,var(--warn) 13%,transparent)}
.gxk{font-family:var(--mono);font-size:11px;text-align:right;color:var(--ink-2);
  font-variant-numeric:tabular-nums}
.gxtag{font-family:var(--mono);font-size:9.5px;color:var(--ink-3);letter-spacing:.04em}
.gxbar{position:relative;height:13px;background:var(--surface-2);border-radius:2px}
.gxbar i{position:absolute;top:0;bottom:0;display:block;border-radius:1px}
.gxbar .mid{position:absolute;top:-3px;bottom:-3px;left:50%;width:1px;background:var(--line)}
.legend{display:flex;gap:16px;font-size:11.5px;color:var(--ink-3);margin:8px 0 0 68px;
  font-family:var(--mono)}
.legend b{display:inline-block;width:9px;height:9px;border-radius:1px;margin-right:4px}
ul.read{margin:0;padding-left:19px}
ul.read li{margin-bottom:7px;font-size:13.5px;color:var(--ink-2)}
"""


def _bars(rows, spot, max_pain):
    if not rows:
        return ""
    peak = max((abs(r["net_gex"]) for r in rows), default=1) or 1
    out = []
    for r in rows:
        g = r["net_gex"]
        w = abs(g) / peak * 50.0
        col = "var(--up)" if g > 0 else "var(--down)"
        style = (f"left:50%;width:{w:.1f}%;background:{col}" if g > 0
                 else f"left:{50-w:.1f}%;width:{w:.1f}%;background:{col}")
        near_spot = abs(r["strike"] - spot) < 0.5
        cls = "gxrow" + (" spot" if near_spot else
                         " pain" if max_pain is not None and r["strike"] == max_pain else "")
        tag = "SPOT" if near_spot else ("MAX PAIN" if r["strike"] == max_pain else "")
        oi = int(r["call_oi"] + r["put_oi"])
        out.append(
            f'<div class="{cls}"><span class="gxk">{r["strike"]:g}</span>'
            f'<span class="gxbar"><i style="{style}"></i><span class="mid"></span></span>'
            f'<span class="gxtag">{tag or (format(oi, ",") if oi else "")}</span></div>')
    return "".join(out)


def build(a, read_lines, out_path):
    gen = datetime.datetime.now(datetime.timezone.utc).strftime("%d %b %Y %H:%M UTC")
    if a.get("error"):
        doc = (f"<title>Zero-DTE Positioning</title><style>{CSS}</style>"
               f'<div class="wrap"><h1>Zero-DTE Positioning</h1>'
               f'<div class="trap">{html.escape(a["error"])}</div></div>')
        open(out_path, "w").write(doc)
        return out_path

    lng = a["total_gex"] > 0
    flip = a.get("zero_gamma")

    mrows = "".join(
        f'<tr><td class="num"><b>{m["strike"]:g}</b></td>'
        f'<td class="{"down" if m["side"]=="put" else "up"}">{m["side"]}</td>'
        f'<td class="num flat">{m["distance_pct"]:.2f}% {"below" if m["below_spot"] else "above"}</td>'
        f'<td class="num">{m["oi"]:,}</td><td class="num">{m["vol"]:,}</td>'
        f'<td class="num flat">{(str(m["turnover"])+"x") if m["turnover"] else "—"}</td>'
        f'<td class="num">{m["excess"]:.1f}x</td>'
        f'<td class="num"><b>{m["score"]:.2f}</b></td></tr>'
        for m in (a.get("magnets") or []))
    fl = a.get("flow") or {}
    fb = fl.get("bias", "—")
    flow_cls = "short" if fb.startswith("PUTS") else "long" if fb.startswith("CALLS") else "long"
    fdetail = (f'Downside flow {fl.get("downside_vol",0):,} contracts against upside '
               f'{fl.get("upside_vol",0):,} — ratio {fl.get("ratio")}. Puts bought below spot force '
               f'dealers to SELL the underlying as it falls; calls bought above force them to BUY '
               f'as it rises. This is which way the hedging feedback currently runs.'
               ) if fl.get("ratio") else "No flow recorded yet."
    magnet_rows, flow_bias, flow_detail = mrows, fb, fdetail
    doc = f"""<title>Zero-DTE Positioning — {html.escape(a['symbol'])}</title>
<style>{CSS}</style>
<div class="wrap">
<header class="mast">
  <div><h1>Zero-DTE Positioning</h1>
    <div class="sub">{html.escape(a['symbol'])} · expiry {html.escape(str(a['expiry']))} ·
      dealer gamma, walls and pin levels</div></div>
  <div class="stamp">Spot {a['spot']}<br>Generated {gen}</div>
</header>

<div class="hero">
  <div><div class="k">Net gamma exposure</div>
    <div class="v" style="color:{'var(--up)' if lng else 'var(--down)'}">
      ${a['total_gex']/1e9:+.2f}bn</div><div class="n">dealer hedging per 1% move</div></div>
  <div><div class="k">Gamma flip</div><div class="v">{flip if flip is not None else '—'}</div>
    <div class="n">regime boundary</div></div>
  <div><div class="k">Max pain</div><div class="v">{a.get('max_pain','—')}</div>
    <div class="n">most premium expires worthless</div></div>
  <div><div class="k">Expected move</div>
    <div class="v">{a.get('expected_move_pct','—')}%</div>
    <div class="n">ATM straddle ±{a.get('straddle','—')}</div></div>
  <div><div class="k">Put / call OI</div><div class="v">{a.get('pc_oi','—')}</div>
    <div class="n">volume {a.get('pc_volume') if a.get('pc_volume') is not None else 'n/a'}</div></div>
</div>

<div class="regime {'long' if lng else 'short'}">
  <b>{html.escape(a['regime'])}</b>
  {'Dealers sell rallies and buy dips to stay flat, which suppresses realised volatility and draws price toward the heaviest open interest.' if lng else 'Dealers buy strength and sell weakness, which feeds moves instead of fading them. Ranges break rather than hold.'}
</div>

<h2>Gamma by strike</h2>
<div class="gx">{_bars(a['rows'], a['spot'], a.get('max_pain'))}</div>
<div class="legend"><span><b style="background:var(--up)"></b>call gamma (dealer long)</span>
  <span><b style="background:var(--down)"></b>put gamma (dealer short)</span>
  <span>right column = total OI at strike</span></div>

<h2>Magnets — where the pull is</h2>
<div class="scroll"><table>
<thead><tr><th>Strike</th><th>Side</th><th>Distance</th><th>Open int</th><th>Volume</th>
<th>Turnover</th><th>Excess</th><th>Pull</th></tr></thead>
<tbody>{magnet_rows}</tbody></table></div>
<p class="sub" style="margin-top:8px">Excess is interest relative to what this chain carries at
that distance — volume and gamma both peak at the money by construction, so raw size just
rediscovers spot. A strike scores here by punching above the decay curve, which is what makes it
somewhere price is <em>not yet</em>.</p>

<div class="regime {flow_cls}" style="margin-top:20px"><b>Flow bias: {flow_bias}</b>
{flow_detail}</div>

<h2>The read</h2>
<ul class="read">{''.join(f'<li>{html.escape(l)}</li>' for l in read_lines)}</ul>

<div class="trap"><strong>What is measured, and what is assumed.</strong> Strikes, open
interest, gamma and spot all come off the tape — greeks here are
{html.escape(a.get('greek_source','—'))}-sourced, and spot is solved from put-call parity across
{a.get('parity_strikes','—')} strikes rather than taken from a single quote. What is
<em>assumed</em> is that dealers are long the calls and short the puts. Nobody publishes dealer
inventory; it is inferred from the customer flow it implies. That is the standard convention and
a real assumption — when customers have been net sellers of calls, the sign flips and every
conclusion above inverts.
<br><br>
Read this as a map of where hedging pressure can build, not a forecast. Max pain says where
option buyers lose most, not where price is going, and pinning evidence is strongest only in the
final hours and only at strikes with genuinely heavy open interest. <strong>Unbacktested in this
repo</strong> — unlike the trend and rotation systems, no walk-forward test has been run on
whether these levels predict anything.</div>

<footer>Zero-DTE positioning for {html.escape(a['symbol'])}, expiry {html.escape(str(a['expiry']))}.
Educational tooling only — no orders are placed and nothing here is financial advice.</footer>
</div>"""
    with open(out_path, "w") as f:
        f.write(doc)
    return out_path


# ---------------------------------------------------------------------------
# interactive build — many symbols in one page, chosen by a search box
# ---------------------------------------------------------------------------
INTERACTIVE_CSS = """
.search{position:relative;margin-bottom:18px}
.search input{width:100%;padding:13px 15px;font-family:var(--mono);font-size:16px;
  background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:3px;
  text-transform:uppercase;letter-spacing:.05em}
.search input:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:var(--accent)}
.search input::placeholder{color:var(--ink-3);text-transform:none;letter-spacing:normal}
.hits{position:absolute;top:100%;left:0;right:0;z-index:30;background:var(--surface);
  border:1px solid var(--line);border-top:0;border-radius:0 0 3px 3px;max-height:290px;
  overflow-y:auto;display:none}
.hits.open{display:block}
.hit{padding:9px 15px;display:flex;gap:12px;align-items:baseline;cursor:pointer;
  border-bottom:1px solid var(--line)}
.hit:last-child{border-bottom:0}
.hit:hover,.hit.sel{background:var(--accent-soft)}
.hit .s{font-family:var(--mono);font-weight:700;min-width:58px}
.hit .m{color:var(--ink-3);font-size:12px;flex:1}
.hit .g{font-family:var(--mono);font-size:12px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:24px}
.chip{font-family:var(--mono);font-size:11.5px;padding:4px 10px;border-radius:2px;cursor:pointer;
  background:var(--surface-2);color:var(--ink-2);border:1px solid var(--line)}
.chip:hover{border-color:var(--accent);color:var(--ink)}
.chip.on{background:var(--accent);color:var(--ground);border-color:var(--accent)}
.chip.dte0{border-color:var(--accent)}
.empty{padding:26px;text-align:center;color:var(--ink-3);background:var(--surface);
  border:1px dashed var(--line);border-radius:3px}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
"""


def _slim(a):
    """Only what the page renders — full chains would bloat the payload for nothing."""
    return dict(
        symbol=a["symbol"], expiry=a["expiry"], dte=a["dte"], spot=a["spot"],
        total_gex=round(a["total_gex"] / 1e9, 4), regime=a["regime"],
        zero_gamma=a.get("zero_gamma"), max_pain=a.get("max_pain"),
        straddle=a.get("straddle"), em=a.get("expected_move_pct"),
        pc_oi=a.get("pc_oi"), pc_vol=a.get("pc_volume"),
        greeks=a.get("greek_source"), parity=a.get("parity_strikes"),
        flow=a.get("flow") or {}, magnets=a.get("magnets") or [],
        rows=[dict(k=r["strike"], g=round(r["net_gex"] / 1e6, 2),
                   co=int(r["call_oi"]), po=int(r["put_oi"]),
                   cv=int(r["call_vol"]), pv=int(r["put_vol"])) for r in a["rows"]])


def build_interactive(results, out_path, reads=None):
    import json as _json
    gen = datetime.datetime.now(datetime.timezone.utc).strftime("%d %b %Y %H:%M UTC")
    data = {s: _slim(a) for s, a in results.items()}
    for s in data:
        data[s]["read"] = (reads or {}).get(s, [])
    payload = _json.dumps(data, separators=(",", ":"))
    n0 = sum(1 for v in data.values() if v["dte"] == 0)

    doc = f"""<title>Zero-DTE Positioning — search any ticker</title>
<style>{CSS}{INTERACTIVE_CSS}</style>
<div class="wrap">
<header class="mast">
  <div><h1>Zero-DTE Positioning</h1>
    <div class="sub">{len(data)} tickers · {n0} with a true zero-DTE expiry ·
      dealer gamma, magnets and pin levels</div></div>
  <div class="stamp">Captured {gen}</div>
</header>

<div class="search">
  <input id="q" type="text" placeholder="Type a ticker — SPY, QQQ, NVDA, TSLA…"
         autocomplete="off" spellcheck="false" aria-label="Search ticker">
  <div class="hits" id="hits" role="listbox"></div>
</div>
<div class="chips" id="chips"></div>

<div id="panel"></div>

<div class="trap"><strong>Snapshot, not live.</strong> A published page cannot reach a market data
feed — the sandbox blocks outbound requests — so these {len(data)} tickers were priced when the
page was generated and the numbers do not move on their own. Ask Claude to regenerate for a fresh
capture. Anything not in the list was not captured; the search covers this set only.
<br><br>
<strong>What is measured, and what is assumed.</strong> Strikes, open interest, volume, gamma and
spot come off the tape, with greeks exchange-published and spot solved from put-call parity across
every liquid strike rather than taken from one quote. What is <em>assumed</em> is that dealers are
long the calls and short the puts — nobody publishes dealer inventory, it is inferred from the
customer flow it implies. Standard convention, real assumption: if customers have been net sellers
of calls the sign flips and every conclusion inverts. <strong>Unbacktested</strong> — a forward log
is running, but no historical test has scored these levels yet.</div>

<footer>Educational tooling only — no orders are placed and nothing here is financial advice.</footer>
</div>

<script>
const D = {payload};
const SYMS = Object.keys(D).sort();
const q = document.getElementById('q'), hits = document.getElementById('hits'),
      panel = document.getElementById('panel'), chips = document.getElementById('chips');
let sel = -1, shown = [];

const esc = s => String(s).replace(/[&<>"]/g, c => ({{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}}[c]));
const num = (v, d=2) => (v===null||v===undefined) ? '—' : Number(v).toFixed(d);

function bars(rows, spot, mp)  {{
  if (!rows.length) return '';
  const peak = Math.max(...rows.map(r => Math.abs(r.g))) || 1;
  return rows.map(r => {{
    const w = Math.abs(r.g) / peak * 50, up = r.g > 0;
    const col = up ? 'var(--up)' : 'var(--down)';
    const st = up ? `left:50%;width:${{w.toFixed(1)}}%;background:${{col}}`
                  : `left:${{(50-w).toFixed(1)}}%;width:${{w.toFixed(1)}}%;background:${{col}}`;
    const isSpot = Math.abs(r.k - spot) < (spot > 400 ? 0.75 : 0.4);
    const cls = isSpot ? 'gxrow spot' : (r.k === mp ? 'gxrow pain' : 'gxrow');
    const tag = isSpot ? 'SPOT' : (r.k === mp ? 'MAX PAIN' : (r.co+r.po).toLocaleString());
    return `<div class="${{cls}}"><span class="gxk">${{r.k}}</span>`
         + `<span class="gxbar"><i style="${{st}}"></i><span class="mid"></span></span>`
         + `<span class="gxtag">${{tag}}</span></div>`;
  }}).join('');
}}

function render(sym) {{
  const a = D[sym];
  if (!a) {{ panel.innerHTML = '<div class="empty">Not in this capture.</div>'; return; }}
  const lng = a.total_gex > 0;
  const mag = a.magnets.map(m =>
    `<tr><td class="num"><b>${{m.strike}}</b></td>`
  + `<td class="${{m.side === 'put' ? 'down' : 'up'}}">${{m.side}}</td>`
  + `<td class="num flat">${{num(m.distance_pct)}}% ${{m.below_spot ? 'below' : 'above'}}</td>`
  + `<td class="num">${{m.oi.toLocaleString()}}</td><td class="num">${{m.vol.toLocaleString()}}</td>`
  + `<td class="num">${{num(m.excess,1)}}x</td><td class="num"><b>${{num(m.score)}}</b></td></tr>`).join('');
  const fl = a.flow || {{}};
  panel.innerHTML = `
  <div class="hero">
    <div><div class="k">Net gamma exposure</div>
      <div class="v" style="color:${{lng ? 'var(--up)' : 'var(--down)'}}">${{a.total_gex>0?'+':''}}${{num(a.total_gex)}}bn</div>
      <div class="n">dealer hedging per 1% move</div></div>
    <div><div class="k">Spot</div><div class="v">${{num(a.spot)}}</div>
      <div class="n">parity, ${{a.parity}} strikes</div></div>
    <div><div class="k">Gamma flip</div><div class="v">${{a.zero_gamma ?? '—'}}</div>
      <div class="n">regime boundary</div></div>
    <div><div class="k">Max pain</div><div class="v">${{a.max_pain ?? '—'}}</div>
      <div class="n">most premium expires worthless</div></div>
    <div><div class="k">Expected move</div><div class="v">${{a.em ?? '—'}}%</div>
      <div class="n">straddle ±${{a.straddle ?? '—'}}</div></div>
  </div>
  <div class="regime ${{lng ? 'long' : 'short'}}"><b>${{esc(a.regime)}}</b>
    ${{lng ? 'Dealers sell rallies and buy dips to stay flat, suppressing realised volatility and drawing price toward the heaviest open interest.'
           : 'Dealers buy strength and sell weakness, feeding moves instead of fading them. Ranges break rather than hold.'}}</div>
  <h2>Gamma by strike · ${{esc(a.symbol)}} ${{esc(a.expiry)}} (DTE ${{a.dte}})</h2>
  <div class="gx">${{bars(a.rows, a.spot, a.max_pain)}}</div>
  <div class="legend"><span><b style="background:var(--up)"></b>call gamma</span>
    <span><b style="background:var(--down)"></b>put gamma</span>
    <span>right column = OI at strike</span></div>
  <h2>Magnets — where the pull is</h2>
  <div class="scroll"><table><thead><tr><th>Strike</th><th>Side</th><th>Distance</th>
    <th>Open int</th><th>Volume</th><th>Excess</th><th>Pull</th></tr></thead>
    <tbody>${{mag || '<tr><td colspan="7">none</td></tr>'}}</tbody></table></div>
  <p class="sub" style="margin-top:8px">Excess is interest relative to what this chain carries at
  that distance. Volume and gamma peak at the money by construction, so raw size just rediscovers
  spot — a strike scores by punching above the decay curve, which makes it somewhere price is
  <em>not yet</em>.</p>
  ${{fl.ratio ? `<div class="regime ${{String(fl.bias).startsWith('PUTS') ? 'short' : 'long'}}" style="margin-top:18px">
    <b>Flow bias: ${{esc(fl.bias)}}</b>Downside ${{(fl.downside_vol||0).toLocaleString()}} contracts
    against upside ${{(fl.upside_vol||0).toLocaleString()}} — ratio ${{fl.ratio}}. Puts bought below
    spot force dealers to SELL as price falls; calls bought above force them to BUY as it rises.</div>` : ''}}
  <h2>The read</h2>
  <ul class="read">${{a.read.map(l => `<li>${{esc(l)}}</li>`).join('')}}</ul>`;
  chips.querySelectorAll('.chip').forEach(c =>
    c.classList.toggle('on', c.dataset.s === sym));
  panel.scrollIntoView({{behavior:'smooth', block:'nearest'}});
}}

function search(t) {{
  t = t.trim().toUpperCase();
  shown = t ? SYMS.filter(s => s.startsWith(t)).concat(
                SYMS.filter(s => !s.startsWith(t) && s.includes(t))) : [];
  sel = shown.length ? 0 : -1;
  hits.innerHTML = shown.map((s, i) => {{
    const a = D[s];
    return `<div class="hit${{i===0?' sel':''}}" data-s="${{s}}" role="option">`
         + `<span class="s">${{s}}</span><span class="m">${{a.expiry}} · DTE ${{a.dte}}</span>`
         + `<span class="g" style="color:${{a.total_gex>0?'var(--up)':'var(--down)'}}">`
         + `${{a.total_gex>0?'+':''}}${{num(a.total_gex)}}bn</span></div>`;
  }}).join('');
  hits.classList.toggle('open', shown.length > 0);
}}

q.addEventListener('input', e => search(e.target.value));
q.addEventListener('keydown', e => {{
  if (!shown.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {{
    e.preventDefault();
    sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
    [...hits.children].forEach((c, i) => c.classList.toggle('sel', i === sel));
    hits.children[sel]?.scrollIntoView({{block:'nearest'}});
  }} else if (e.key === 'Enter' && sel >= 0) {{
    pick(shown[sel]);
  }} else if (e.key === 'Escape') {{
    hits.classList.remove('open');
  }}
}});
hits.addEventListener('click', e => {{
  const h = e.target.closest('.hit');
  if (h) pick(h.dataset.s);
}});
function pick(s) {{ q.value = s; hits.classList.remove('open'); render(s); }}
document.addEventListener('click', e => {{
  if (!e.target.closest('.search')) hits.classList.remove('open');
}});

chips.innerHTML = SYMS.map(s =>
  `<span class="chip${{D[s].dte===0?' dte0':''}}" data-s="${{s}}">${{s}}${{D[s].dte===0?' ·0DTE':''}}</span>`).join('');
chips.addEventListener('click', e => {{
  const c = e.target.closest('.chip');
  if (c) pick(c.dataset.s);
}});

render(SYMS.includes('SPY') ? 'SPY' : SYMS[0]);
</script>"""
    with open(out_path, "w") as f:
        f.write(doc)
    return out_path
