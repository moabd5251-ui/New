"""Render the LEAP rotation dashboard.

Leads with the book — what to open, hold and close — because that is the only part
that requires an action today. The full ranking sits underneath as the evidence, and
the excluded markets are shown rather than hidden: knowing that gold and bitcoin are
in downtrends is the reason there is no position in them.
"""
import datetime
import html

from trend_dashboard import CSS as BASE_CSS

CSS = BASE_CSS + """
.book{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px;margin-bottom:8px}
.pos{background:var(--surface);border:1px solid var(--line);border-radius:3px;overflow:hidden}
.pos.open{border-color:var(--up);border-width:1.5px}
.pos.close{border-color:var(--down);border-width:1.5px}
.pos-h{padding:12px 16px;background:var(--surface-2);border-bottom:1px solid var(--line);
  display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.pos-h .sym{font-family:var(--serif);font-size:22px;font-weight:600}
.pos-h .exp{margin-left:auto;font-family:var(--mono);font-weight:700}
.why{padding:10px 16px;font-size:12.5px;color:var(--ink-2);border-bottom:1px solid var(--line)}
.kv{display:grid;grid-template-columns:repeat(3,1fr)}
.kv div{padding:9px 16px;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}
.kv div:nth-child(3n){border-right:0}
.kv .k{font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3)}
.kv .v{font-family:var(--mono);font-size:14px;font-weight:600;margin-top:2px}
.split{display:flex;height:9px;border-radius:2px;overflow:hidden;margin-top:6px;background:var(--surface-2)}
.split i{display:block;height:100%}
.nocon{padding:11px 16px;font-size:12.5px;color:var(--warn);
  background:color-mix(in srgb,var(--warn) 10%,transparent)}
.excl{display:flex;flex-wrap:wrap;gap:7px;margin:10px 0 4px}
.excl span{font-family:var(--mono);font-size:11.5px;padding:3px 9px;border-radius:2px;
  background:var(--surface-2);color:var(--ink-3);border:1px solid var(--line)}
"""


def _pill(action):
    cls = {"OPEN": "p-add", "CLOSE": "p-rev", "HOLD": "p-non"}[action]
    txt = {"OPEN": "ROTATE IN", "CLOSE": "ROTATE OUT", "HOLD": "HOLD"}[action]
    return f'<span class="pill {cls}">{txt}</span>'


def build(res, out_path):
    gen = datetime.datetime.now(datetime.timezone.utc).strftime("%d %b %Y %H:%M UTC")
    asof = res.get("asof") or "—"
    ranked = res["ranked"]
    actions = res["actions"]
    excluded = sorted([r for r in res["rows"] if r["exposure_pct"] <= 0],
                      key=lambda r: r["exposure_pct"])
    alloc = res.get("allocation", 0)

    cards = []
    for a in actions:
        leap, sz = a.get("leap"), a.get("sizing")
        pct = a.get("exposure_pct")
        body = ""
        if leap:
            ex, intr = leap["extrinsic"], leap["intrinsic"]
            tot = max(ex + intr, 0.0001)
            body = f"""
  <div class="kv">
    <div><div class="k">Contract</div><div class="v">{leap['strike']:g}C</div></div>
    <div><div class="k">Expiry</div><div class="v">{html.escape(leap['expiry'])}</div></div>
    <div><div class="k">Delta</div><div class="v">{leap['delta']}</div></div>
    <div><div class="k">Cost / contract</div><div class="v">${leap['cost']:,.0f}</div></div>
    <div><div class="k">Exposure bought</div><div class="v">${leap['notional']:,.0f}</div></div>
    <div><div class="k">Carry / month</div><div class="v">{leap['carry_pct_per_month']}%</div></div>
  </div>
  <div class="why"><b>{leap['extrinsic_pct']}% of the premium is time value</b> — the only part
    that decays. Intrinsic ${intr:,.2f} vs extrinsic ${ex:,.2f}.
    <div class="split">
      <i style="width:{intr/tot*100:.1f}%;background:var(--up)"></i>
      <i style="width:{ex/tot*100:.1f}%;background:var(--warn)"></i>
    </div>
  </div>"""
            if sz and sz.get("affordable"):
                body += f"""
  <div class="kv">
    <div><div class="k">Contracts</div><div class="v">{sz['contracts']}</div></div>
    <div><div class="k">At risk</div><div class="v">${sz['premium_at_risk']:,.0f}</div></div>
    <div><div class="k">Leverage</div><div class="v">{sz['leverage']}x</div></div>
  </div>"""
            elif sz:
                body += f'<div class="nocon">{html.escape(sz["note"])}</div>'
        elif a["action"] != "CLOSE":
            body = ('<div class="nocon">No contract selected — the options book is closed, '
                    'so LEAP pricing and greeks cannot be trusted. Signal stands.</div>')

        cards.append(f"""<div class="pos {a['action'].lower()}">
  <div class="pos-h"><span class="sym">{html.escape(a['symbol'])}</span>
    {_pill(a['action'])}
    <span class="exp {'up' if (pct or 0) > 0 else 'down'}">{'—' if pct is None else f'{pct:+d}%'}</span></div>
  <div class="why">{html.escape(a['reason'])}</div>{body}
</div>""")

    rank_rows = "".join(f"""<tr>
  <td class="num flat">{r['rank']}</td>
  <td><span class="tick">{html.escape(r['symbol'])}</span></td>
  <td class="mkt">{html.escape(r['market'])}</td>
  <td class="num up"><b>{r['exposure_pct']}%</b></td>
  <td class="num">{r['mom_63']*100:+.1f}%</td>
  <td class="num flat">{r['longs']}/{r['shorts']}/{r['neutrals']}</td>
  <td class="num">{r['price']:,.2f}</td>
</tr>""" for r in ranked)

    excl_html = "".join(
        f'<span>{html.escape(r["symbol"])} {r["exposure_pct"]}%</span>' for r in excluded)

    ms = res.get("market_state")
    warn = ""
    if ms and ms != "REGULAR":
        warn = (f'<div class="trap"><strong>Market is {html.escape(str(ms))}.</strong> '
                'Rankings and rotation calls are computed from completed daily bars and stand. '
                'Contract selection is skipped — a LEAP\'s bid/ask and greeks are meaningless '
                'against a closed book.</div>')

    doc = f"""<title>LEAP Rotation — Concentrate in the Strongest Trends</title>
<style>{CSS}</style>
<div class="wrap">
<header class="mast">
  <div><h1>LEAP Rotation</h1>
    <div class="sub">Hold deep-ITM calls in the strongest {len(ranked) and ''}markets ·
      max {len([a for a in actions if a['action'] != 'CLOSE'])} of
      {len(res['rows'])} · everything else in cash</div></div>
  <div class="stamp">Signals as of close {html.escape(str(asof))}<br>Generated {gen}</div>
</header>

<div class="thesis"><strong>Why deep in the money.</strong> Only the time value in a premium
decays, so an 0.80-delta LEAP puts most of your money in intrinsic value that does not bleed —
you get stock-like exposure with leverage and a floor. Cheap out-of-the-money calls are almost
entirely time value, which is the same trap the volatility-ramp backtest measured: implied vol
rose 96% of the time there and long premium still lost, because decay took the gain. A trend
hold lasts far longer than that trade did.</div>

<div class="trap"><strong>Entry is hard, exit is easy — on purpose.</strong> A market must reach
{70}% exposure to be bought and only has to fall under {30}% to be sold. That gap is the churn
control: LEAP spreads are wide, and equal thresholds would make you pay a round trip every time
a market wobbled across one line. A position that slips in rank while its trend holds is left
alone. Long-only, so a strong downtrend means cash, not a short.</div>

{warn}

<h2>The book</h2>
<div class="book">{''.join(cards) if cards else '<div class="pos"><div class="why">Nothing qualifies. No market reached the entry threshold.</div></div>'}</div>

<h2>Ranking · markets in an uptrend</h2>
<div class="scroll"><table>
<thead><tr><th>#</th><th>ETF</th><th>Market</th><th>Exposure</th><th>63d momentum</th>
<th>L/S/N</th><th>Close</th></tr></thead>
<tbody>{rank_rows}</tbody></table></div>

<h2>Excluded · no long trend, so no position</h2>
<div class="excl">{excl_html}</div>

<footer>{len(ranked)} of {len(res['rows'])} markets in an uptrend ·
sizing shown against ${alloc:,.0f} per position ·
signals from completed daily bars.
Educational tooling only — no orders are placed and nothing here is financial advice.</footer>
</div>"""
    with open(out_path, "w") as f:
        f.write(doc)
    return out_path
