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
