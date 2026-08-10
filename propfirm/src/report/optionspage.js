/**
 * Static HTML page for the options paper journal — published as an artifact
 * so the scan is readable from a phone. Content-only markup (the publisher
 * wraps it in a document skeleton); tokens cover light, dark and un-stamped
 * system themes.
 */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const usd = (n) => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(0)}`

export function renderOptionsPage(records, { generatedAt = new Date().toISOString() } = {}) {
  const open = records.filter((r) => !r.outcome)
  const done = records.filter((r) => r.outcome)
  const wins = done.filter((r) => r.outcome.pnlUsd > 0)
  const totalPnl = done.reduce((a, r) => a + r.outcome.pnlUsd, 0)
  const meanR = done.length ? done.reduce((a, r) => a + r.outcome.r, 0) / done.length : null
  const today = generatedAt.slice(0, 10)
  const dteLeft = (exp) => Math.max(0, Math.round((Date.parse(`${exp}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000))

  const card = (r) => {
    const s = r.spread
    const up = r.direction === 'up'
    const riskPct = (s.debit / s.width) * 100
    return `
    <article class="pos">
      <div class="pos-head">
        <span class="sym">${esc(r.symbol)}</span>
        <span class="pill ${up ? 'pill-up' : 'pill-dn'}">${up ? 'CALL' : 'PUT'} spread</span>
        <span class="dte">${dteLeft(r.expiration)}d left</span>
      </div>
      <div class="strikes">${s.longStrike} / ${s.shortStrike} · exp ${esc(r.expiration)}</div>
      <div class="riskbar" role="img" aria-label="risk ${usd(r.riskUsd)} of width">
        <div class="riskbar-fill" style="width:${riskPct.toFixed(0)}%"></div>
      </div>
      <dl class="facts">
        <div><dt>Risk (debit)</dt><dd>${usd(r.riskUsd)} · ${r.contracts}×</dd></div>
        <div><dt>Max gain</dt><dd>${usd(s.maxGain * 100 * r.contracts)}</dd></div>
        <div><dt>Breakeven</dt><dd>${s.breakeven.toFixed(2)}</dd></div>
        <div><dt>Reward / risk</dt><dd>${s.rewardRisk.toFixed(2)}</dd></div>
      </dl>
      <p class="why">Reaction ${esc(r.reactionDay)}: gapped ${r.gapPct > 0 ? '+' : ''}${r.gapPct}% on volume, still unfilled — trading with the gap.</p>
    </article>`
  }

  const row = (r) => `
    <tr>
      <td class="mono">${esc(r.symbol)}</td>
      <td>${r.direction === 'up' ? 'Call' : 'Put'} ${r.spread.longStrike}/${r.spread.shortStrike}</td>
      <td class="num">${esc(r.expiration)}</td>
      <td class="num">${(r.spread.debit * 100).toFixed(0)} → ${(r.outcome.valuePerShare * 100).toFixed(0)}</td>
      <td class="num ${r.outcome.pnlUsd >= 0 ? 'pos-n' : 'neg-n'}">${usd(r.outcome.pnlUsd)}</td>
      <td class="num ${r.outcome.r >= 0 ? 'pos-n' : 'neg-n'}">${r.outcome.r >= 0 ? '+' : ''}${r.outcome.r.toFixed(2)}R</td>
    </tr>`

  return `<title>Options scan — paper journal</title>
<style>
  :root {
    --ground: #F4F5F7; --surface: #FFFFFF; --ink: #1D2530; --muted: #68717E;
    --line: #DDE1E6; --accent: #A8721E; --up: #2A7A4B; --dn: #B04238;
    --up-soft: #E3F0E8; --dn-soft: #F6E7E4;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ground: #15191F; --surface: #1D232B; --ink: #E7E9EC; --muted: #949CA8;
      --line: #313943; --accent: #D9A04A; --up: #5CB884; --dn: #E08578;
      --up-soft: #22352A; --dn-soft: #3A2724;
    }
  }
  :root[data-theme="dark"] {
    --ground: #15191F; --surface: #1D232B; --ink: #E7E9EC; --muted: #949CA8;
    --line: #313943; --accent: #D9A04A; --up: #5CB884; --dn: #E08578;
    --up-soft: #22352A; --dn-soft: #3A2724;
  }
  body { background: var(--ground); color: var(--ink); margin: 0;
    font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 28px 18px 60px; }
  header h1 { font-size: 1.35rem; margin: 0 0 2px; letter-spacing: -0.01em; text-wrap: balance; }
  .eyebrow { color: var(--accent); font-size: 0.72rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.09em; margin: 0 0 6px; }
  .sub { color: var(--muted); font-size: 0.85rem; margin: 0; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 10px; margin: 22px 0 26px; }
  .tile { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
  .tile dt { color: var(--muted); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.07em; margin: 0 0 3px; }
  .tile dd { margin: 0; font-size: 1.25rem; font-weight: 650; font-variant-numeric: tabular-nums; }
  h2 { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.09em;
    color: var(--muted); margin: 30px 0 12px; }
  .pos { background: var(--surface); border: 1px solid var(--line); border-radius: 10px;
    padding: 16px 18px; margin-bottom: 14px; }
  .pos-head { display: flex; align-items: baseline; gap: 10px; }
  .sym { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 1.15rem; font-weight: 700; }
  .pill { font-size: 0.7rem; font-weight: 650; padding: 2px 9px; border-radius: 99px; letter-spacing: 0.03em; }
  .pill-up { background: var(--up-soft); color: var(--up); }
  .pill-dn { background: var(--dn-soft); color: var(--dn); }
  .dte { margin-left: auto; color: var(--muted); font-size: 0.8rem; font-variant-numeric: tabular-nums; }
  .strikes { font-family: ui-monospace, "SF Mono", Menlo, monospace; color: var(--muted);
    font-size: 0.88rem; margin: 4px 0 10px; }
  .riskbar { height: 6px; border-radius: 3px; background: var(--up-soft); overflow: hidden; margin-bottom: 12px; }
  .riskbar-fill { height: 100%; background: var(--dn); opacity: 0.75; }
  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 8px 16px; margin: 0; }
  .facts dt { color: var(--muted); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; }
  .facts dd { margin: 1px 0 0; font-weight: 600; font-variant-numeric: tabular-nums; }
  .why { color: var(--muted); font-size: 0.83rem; margin: 12px 0 0; }
  .ledger-scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; background: var(--surface);
    border: 1px solid var(--line); border-radius: 8px; font-size: 0.87rem; }
  th { text-align: left; color: var(--muted); font-size: 0.68rem; text-transform: uppercase;
    letter-spacing: 0.07em; padding: 9px 12px; border-bottom: 1px solid var(--line); }
  td { padding: 9px 12px; border-bottom: 1px solid var(--line); }
  tr:last-child td { border-bottom: 0; }
  .num { font-variant-numeric: tabular-nums; text-align: right; }
  th.num-h { text-align: right; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-weight: 600; }
  .pos-n { color: var(--up); } .neg-n { color: var(--dn); }
  .empty { color: var(--muted); font-size: 0.88rem; background: var(--surface);
    border: 1px dashed var(--line); border-radius: 8px; padding: 16px 18px; }
  .prior { border-left: 3px solid var(--accent); padding: 10px 16px; margin: 34px 0 0;
    background: var(--surface); border-radius: 0 8px 8px 0; font-size: 0.85rem; color: var(--muted); }
  .prior strong { color: var(--ink); }
  footer { color: var(--muted); font-size: 0.75rem; margin-top: 28px; }
</style>
<div class="wrap">
  <header>
    <p class="eyebrow">Paper journal · no orders placed</p>
    <h1>Options scan — post-reaction debit spreads</h1>
    <p class="sub">Unfilled ≥3% gaps on volume, expressed as defined-risk verticals with the gap. Spec v1, registered 2026-08-10.</p>
  </header>

  <dl class="tiles">
    <div class="tile"><dt>Open</dt><dd>${open.length}</dd></div>
    <div class="tile"><dt>Resolved</dt><dd>${done.length}</dd></div>
    <div class="tile"><dt>Win rate</dt><dd>${done.length ? `${((wins.length / done.length) * 100).toFixed(0)}%` : '—'}</dd></div>
    <div class="tile"><dt>Total P&amp;L</dt><dd>${done.length ? usd(totalPnl) : '—'}</dd></div>
  </dl>

  <h2>Open positions</h2>
  ${open.length ? open.map(card).join('\n') : '<p class="empty">Nothing open. The scanner only journals an unfilled reaction gap with a liquid structure inside the risk budget — most days that is nothing, and that is correct.</p>'}

  <h2>Resolved at expiry</h2>
  ${done.length
    ? `<div class="ledger-scroll"><table>
      <thead><tr><th>Sym</th><th>Structure</th><th class="num-h">Expiry</th><th class="num-h">Debit → value</th><th class="num-h">P&amp;L</th><th class="num-h">R</th></tr></thead>
      <tbody>${done.map(row).join('\n')}</tbody></table></div>
      ${meanR !== null ? `<p class="sub" style="margin-top:8px">Mean ${meanR >= 0 ? '+' : ''}${meanR.toFixed(2)}R per spread, held to expiration.</p>` : ''}`
    : '<p class="empty">Nothing has reached expiration yet. Verticals resolve here automatically from the underlying’s close.</p>'}

  <div class="prior">
    <strong>The measured prior this rides on:</strong> gap direction continues (with-gap beat against-gap by +0.261R,
    t&nbsp;=&nbsp;2.22, 151 reactions) — but the strategy’s own return measured ≈&nbsp;0, with 99% of profit in 5 trades.
    Tilted odds, not a validated edge. Under ~30 resolved spreads this record is noise, and only this record can promote it.
  </div>

  <footer>Generated ${esc(generatedAt.slice(0, 16).replace('T', ' '))} UTC · data: Tradier delayed chains · journal committed to git each run</footer>
</div>`
}
