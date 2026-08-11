"""Render the ETF trend-following dashboard.

Laid out after the TrendCompass reports: a summary table carrying current exposure,
today's change and new exposure for every market, then a per-market panel showing how
each strategy voted. The change column matters as much as the level — "add long
exposure, 30% -> 80%" is an instruction, while "80%" alone is only a state.
"""
import datetime

import chart as C
import html

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
.wrap{max-width:1180px;margin:0 auto;padding:40px 24px 72px}
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
h2{font-family:var(--serif);font-size:20px;margin:34px 0 12px;font-weight:600}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;background:var(--surface);
  border:1px solid var(--line);border-radius:3px;font-size:13.5px;min-width:720px}
th{background:var(--surface-2);text-align:left;padding:9px 12px;font-size:10.5px;
  text-transform:uppercase;letter-spacing:.08em;color:var(--ink-2);font-weight:700;
  border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:middle}
tr:last-child td{border-bottom:none}
.tick{font-weight:700;font-family:var(--mono)}
.mkt{color:var(--ink-3);font-size:12px}
.up{color:var(--up)} .down{color:var(--down)} .flat{color:var(--flat)}
.bar{position:relative;height:16px;background:var(--surface-2);border-radius:2px;
  min-width:120px;width:130px;overflow:hidden}
.bar i{position:absolute;top:0;bottom:0;left:50%;display:block}
.bar .mid{position:absolute;top:0;bottom:0;left:50%;width:1px;background:var(--line)}
.pill{display:inline-block;font-family:var(--mono);font-size:10.5px;font-weight:700;
  padding:2px 7px;border-radius:2px;letter-spacing:.04em;white-space:nowrap}
.p-add{background:var(--up);color:#fff}
.p-red{background:var(--warn);color:#fff}
.p-rev{background:var(--down);color:#fff}
.p-non{background:var(--surface-2);color:var(--ink-3)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:3px;
  margin-bottom:16px;overflow:hidden}
.card-h{padding:11px 16px;background:var(--surface-2);border-bottom:1px solid var(--line);
  display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}
.card-h .tick{font-size:15px}
.card-h .exp{margin-left:auto;font-family:var(--mono);font-weight:700;font-size:15px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(178px,1fr))}
.cell{padding:8px 14px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);
  display:flex;justify-content:space-between;gap:8px;font-size:12.5px}
.cell b{font-weight:500;color:var(--ink-2)}
.sig{font-family:var(--mono);font-size:11px;font-weight:700}
footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);
  color:var(--ink-3);font-size:12px}
"""


def _bar(pct):
    """A centre-anchored exposure bar: right of centre is long, left is short."""
    w = abs(pct) / 2.0                     # half-width, so 100% fills one side
    col = "var(--up)" if pct > 0 else "var(--down)" if pct < 0 else "var(--flat)"
    if pct >= 0:
        style = f"left:50%;width:{w}%;background:{col}"
    else:
        style = f"left:{50-w}%;width:{w}%;background:{col}"
    return f'<span class="bar"><i style="{style}"></i><span class="mid"></span></span>'


def _action_pill(action):
    cls = ("p-add" if action.startswith("ADD") or action == "NEW" else
           "p-rev" if action.startswith("REVERSE") or action.startswith("CLOSE") else
           "p-red" if action.startswith("REDUCE") else "p-non")
    return f'<span class="pill {cls}">{html.escape(action)}</span>'


def _cls(v):
    return "up" if v > 0 else "down" if v < 0 else "flat"


def build(rows, out_path, errors=None, n_strategies=10):
    gen = datetime.datetime.now(datetime.timezone.utc).strftime("%d %b %Y %H:%M UTC")
    asof = rows[0]["asof"] if rows else "—"

    net_long = sum(1 for r in rows if r["exposure_pct"] > 0)
    net_short = sum(1 for r in rows if r["exposure_pct"] < 0)
    avg = round(sum(r["exposure_pct"] for r in rows) / len(rows)) if rows else 0
    changed = [r for r in rows if r.get("change_pct")]

    head = []
    for r in rows:
        ch = r.get("change_pct")
        chtxt = "—" if not ch else f"{ch:+d}%"
        prev = "—" if r.get("prev_pct") is None else f"{r['prev_pct']}%"
        head.append(f"""<tr>
  <td><span class="tick">{html.escape(r['symbol'])}</span><div class="mkt">{html.escape(r['market'])}</div></td>
  <td class="num">{r['price']:,.2f}</td>
  <td class="num flat">{prev}</td>
  <td class="num {_cls(ch or 0)}">{chtxt}</td>
  <td class="num {_cls(r['exposure_pct'])}"><b>{r['exposure_pct']:+d}%</b></td>
  <td>{_bar(r['exposure_pct'])}</td>
  <td class="num flat">{r['longs']}/{r['shorts']}/{r['neutrals']}</td>
  <td>{_action_pill(r.get('action','NO CHANGE'))}</td>
</tr>""")

    cards = []
    for r in rows:
        cells = []
        for d in r["strategies"]:
            cells.append(f'<div class="cell"><b>{html.escape(d["strategy"])}</b>'
                         f'<span class="sig {_cls(d["signal"])}">{d["label"]}</span></div>')
        cards.append(f"""<div class="card">
  <div class="card-h">
    <span class="tick">{html.escape(r['symbol'])}</span>
    <span class="mkt">{html.escape(r['market'])} · {html.escape(r['group'])}</span>
    <span class="mkt num">{r['price']:,.2f}</span>
    <span class="exp {_cls(r['exposure_pct'])}">{r['exposure_pct']:+d}% {r['direction']}</span>
  </div>
  <div class="grid">{''.join(cells)}</div>
  {C.slot(r['symbol'])}
</div>""")

    err_html = ""
    if errors:
        err_html = ('<div class="trap"><strong>Not priced:</strong> '
                    + ", ".join(html.escape(e["symbol"]) for e in errors) + "</div>")

    charts = {r["symbol"]: r["chart"] for r in rows if r.get("chart")}
    doc = f"""<title>ETF Trend Compass — Consensus Exposure</title>
<style>{CSS}{C.CSS}</style>
<div class="wrap">
<header class="mast">
  <div>
    <h1>ETF Trend Compass</h1>
    <div class="sub">Consensus trend following · exposure scales with agreement across
      {n_strategies} independent strategies</div>
  </div>
  <div class="stamp">Signals as of close {html.escape(asof)}<br>Generated {gen}</div>
</header>

<div class="thesis"><strong>How to read this.</strong> Exposure is not a call, it is a count.
Each market runs {n_strategies} independent trend strategies; every one votes long, short or
neutral, and exposure is their net vote in {100//n_strategies}% steps. Eight of ten long reads
+80%. You <strong>add</strong> as more strategies confirm and <strong>reduce</strong> as they
drop out, so the position accelerates into a strengthening trend and bleeds off as it weakens —
never all-in, never all-out on a single signal.</div>

<div class="trap"><strong>What this is not.</strong> These are my own trend strategies in the
same consensus architecture as the TrendCompass reports — not I-System's models, which are not
public. Readings will differ from that report, sometimes widely, and neither is the "correct"
one. Signals come from the last completed session's close, so nothing here reacts intraday.
This is decision support, not advice, and it places no orders.</div>

{err_html}

<h2>Exposure book</h2>
<div class="scroll"><table>
<thead><tr><th>ETF / market</th><th>Close</th><th>Prev</th><th>Change</th><th>Exposure</th>
<th></th><th>L/S/N</th><th>Action</th></tr></thead>
<tbody>{''.join(head)}</tbody></table></div>

<h2>Strategy detail</h2>
{''.join(cards)}

<footer>{len(rows)} markets · {net_long} net long, {net_short} net short ·
average exposure {avg:+d}% · {len(changed)} changed since the previous run.
Educational tooling only — no orders are placed and nothing here is financial advice.</footer>
</div>
<script>{C.mount(charts)}</script>"""
    with open(out_path, "w") as f:
        f.write(doc)
    return out_path
