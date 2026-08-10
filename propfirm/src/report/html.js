/**
 * Single-file HTML report.
 *
 * No dependencies, no CDN — everything is inlined so the file opens from disk
 * and can be archived alongside the journal it describes. Charts are plain SVG.
 *
 * The report leads with the honest caveats (proxy orderflow, sample size,
 * synthetic data) rather than burying them, because a performance page that
 * hides its assumptions is how people end up trading a curve that never
 * existed.
 */

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '—')
const money = (n) => (Number.isFinite(n) ? `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(0)}` : '—')
const pct = (n) => (Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—')

/**
 * @param {object} result output of `backtest()`
 * @param {{title?:string}} [opts]
 * @returns {string} complete HTML document
 */
export function renderReport(result, opts = {}) {
  const { stats, account, trades, equityCurve, meta, consistency, breachedAt } = result
  const title = opts.title ?? 'Prop Firm System — Backtest Report'

  const warnings = []
  if (meta?.orderflowIsProxy) {
    warnings.push(
      'Orderflow is <strong>estimated from bar geometry</strong>, not a real depth-of-market feed. Delta, absorption and aggression readings are approximations. Results will differ from a live feed.',
    )
  }
  if (stats.sampleWarning) warnings.push(esc(stats.sampleWarning))
  if (breachedAt) {
    warnings.push(`Account <strong>breached</strong> on ${new Date(breachedAt.t).toISOString().slice(0, 10)}: ${esc(breachedAt.reason)}. The run stopped there, as a real account would.`)
  }
  if (!consistency?.ok) warnings.push(esc(consistency?.note ?? 'consistency rule not met'))

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--fg:#e6edf3;--dim:#8b949e;
        --up:#3fb950;--down:#f85149;--accent:#58a6ff;--warn:#d29922}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:14px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
  .wrap{max-width:1100px;margin:0 auto;padding:32px 20px 64px}
  h1{font-size:24px;margin:0 0 4px} h2{font-size:16px;margin:32px 0 12px;
     text-transform:uppercase;letter-spacing:.08em;color:var(--dim)}
  .sub{color:var(--dim);margin-bottom:24px}
  .warn{background:rgba(210,153,34,.1);border:1px solid rgba(210,153,34,.4);
        border-left-width:3px;border-radius:6px;padding:12px 14px;margin-bottom:10px;color:#f0d58c}
  .grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px}
  .k{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
  .v{font-size:22px;font-weight:600;margin-top:4px;font-variant-numeric:tabular-nums}
  .up{color:var(--up)} .down{color:var(--down)} .dim{color:var(--dim)}
  table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
  th,td{text-align:right;padding:7px 9px;border-bottom:1px solid var(--line);white-space:nowrap}
  th:first-child,td:first-child{text-align:left}
  th{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  tbody tr:hover{background:rgba(88,166,255,.06)}
  .scroll{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
  .reasons{color:var(--dim);font-size:12px;max-width:420px;white-space:normal}
  svg{display:block;width:100%;height:auto;background:var(--panel);
      border:1px solid var(--line);border-radius:8px}
  .tag{display:inline-block;padding:1px 7px;border-radius:99px;font-size:11px;
       border:1px solid var(--line);color:var(--dim)}
</style></head><body><div class="wrap">
<h1>${esc(title)}</h1>
<div class="sub">
  ${meta ? `${esc(meta.instrument)} · ${meta.bars.toLocaleString()} bars · ${new Date(meta.from).toISOString().slice(0, 10)} → ${new Date(meta.to).toISOString().slice(0, 10)}` : ''}
</div>

${warnings.map((w) => `<div class="warn">${w}</div>`).join('')}

<h2>Result</h2>
<div class="grid">
  ${card('Net P&L', money(stats.totalDollars), stats.totalDollars >= 0 ? 'up' : 'down')}
  ${card('Total R', fmt(stats.totalR), stats.totalR >= 0 ? 'up' : 'down')}
  ${card('Expectancy', `${fmt(stats.expectancyR)}R`, stats.expectancyR >= 0 ? 'up' : 'down')}
  ${card('Trades', stats.count)}
  ${card('Win rate', pct(stats.winRate))}
  ${card('Profit factor', fmt(stats.profitFactor))}
  ${card('Payoff ratio', fmt(stats.payoffRatio))}
  ${card('Max drawdown', `${fmt(stats.maxDrawdownR)}R`, 'down')}
</div>

<h2>Account</h2>
<div class="grid">
  ${card('Balance', money(account.balance))}
  ${card('Peak equity', money(account.peak))}
  ${card('Drawdown floor', money(account.floor), account.floorLocked ? 'up' : '')}
  ${card('Room to floor', money(account.room), account.room > 0 ? '' : 'down')}
  ${card('Target progress', pct(account.snapshot().progress))}
  ${card('Status', account.breached ? 'BREACHED' : account.passed ? 'PASSED' : 'ACTIVE', account.breached ? 'down' : account.passed ? 'up' : '')}
</div>

<h2>Equity</h2>
${equitySvg(equityCurve)}

<h2>By entry model</h2>
${breakdownTable(stats.byModel)}

<h2>By session</h2>
${breakdownTable(stats.bySession)}

<h2>By grade</h2>
${breakdownTable(stats.byGrade)}

<h2>How trades ended</h2>
${exitTable(stats.byExitReason)}

<h2>Trades</h2>
${tradeTable(trades)}

<p class="dim" style="margin-top:32px;font-size:12px">
Generated ${new Date().toISOString()} · R is measured against the initial invalidation, after commission and slippage.
</p>
</div></body></html>`
}

function card(k, v, cls = '') {
  return `<div class="card"><div class="k">${esc(k)}</div><div class="v ${cls}">${esc(v)}</div></div>`
}

function breakdownTable(groups) {
  const rows = Object.entries(groups ?? {}).sort((a, b) => b[1].expectancyR - a[1].expectancyR)
  if (!rows.length) return '<p class="dim">No data.</p>'
  return `<div class="scroll"><table>
    <thead><tr><th>Bucket</th><th>Trades</th><th>Win rate</th><th>Expectancy</th><th>Total R</th><th>Profit factor</th><th>Net</th></tr></thead>
    <tbody>${rows
      .map(
        ([name, s]) => `<tr>
      <td>${esc(name)}${s.count < 20 ? ' <span class="tag">small sample</span>' : ''}</td>
      <td>${s.count}</td><td>${pct(s.winRate)}</td>
      <td class="${s.expectancyR >= 0 ? 'up' : 'down'}">${fmt(s.expectancyR)}R</td>
      <td class="${s.totalR >= 0 ? 'up' : 'down'}">${fmt(s.totalR)}</td>
      <td>${fmt(s.profitFactor)}</td>
      <td class="${s.totalDollars >= 0 ? 'up' : 'down'}">${money(s.totalDollars)}</td></tr>`,
      )
      .join('')}</tbody></table></div>`
}

function exitTable(groups) {
  const rows = Object.entries(groups ?? {}).sort((a, b) => b[1].count - a[1].count)
  if (!rows.length) return '<p class="dim">No data.</p>'
  return `<div class="scroll"><table>
    <thead><tr><th>Exit reason</th><th>Count</th><th>Avg R</th><th>Total R</th></tr></thead>
    <tbody>${rows
      .map(
        ([name, s]) => `<tr><td>${esc(name)}</td><td>${s.count}</td>
      <td class="${s.expectancyR >= 0 ? 'up' : 'down'}">${fmt(s.expectancyR)}</td>
      <td class="${s.totalR >= 0 ? 'up' : 'down'}">${fmt(s.totalR)}</td></tr>`,
      )
      .join('')}</tbody></table></div>`
}

function tradeTable(trades) {
  if (!trades?.length) return '<p class="dim">No trades.</p>'
  return `<div class="scroll"><table>
  <thead><tr><th>Date</th><th>Session</th><th>Model</th><th>Grade</th><th>Dir</th>
  <th>Size</th><th>Entry</th><th>Stop</th><th>Exit</th><th>R</th><th>P&L</th><th>Exit reason</th></tr></thead>
  <tbody>${trades
    .map(
      (t) => `<tr>
    <td>${esc(new Date(t.entryTime).toISOString().slice(0, 16).replace('T', ' '))}</td>
    <td>${esc(t.session ?? '')}</td><td>${esc(t.model ?? '')}</td><td>${esc(t.grade ?? '')}</td>
    <td class="${t.direction === 'long' ? 'up' : 'down'}">${esc(t.direction ?? '')}</td>
    <td>${t.contracts ?? ''} ${esc(t.symbol ?? '')}</td>
    <td>${fmt(t.entry)}</td><td>${fmt(t.stop)}</td><td>${fmt(t.exit)}</td>
    <td class="${t.rMultiple >= 0 ? 'up' : 'down'}">${fmt(t.rMultiple)}</td>
    <td class="${t.pnl >= 0 ? 'up' : 'down'}">${money(t.pnl)}</td>
    <td class="reasons">${esc(t.exitReason ?? '')}</td></tr>`,
    )
    .join('')}</tbody></table></div>`
}

/** Equity vs. the drawdown floor — the only chart that matters on a prop account. */
function equitySvg(curve) {
  if (!curve?.length) return '<p class="dim">No equity data.</p>'
  const W = 1040
  const H = 260
  const pad = { l: 58, r: 12, t: 12, b: 24 }
  // Downsample: one point per pixel column is plenty.
  const step = Math.max(1, Math.floor(curve.length / (W - pad.l - pad.r)))
  const pts = curve.filter((_, i) => i % step === 0)

  const values = pts.flatMap((p) => [p.equity, p.floor])
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const span = max - min || 1
  const x = (i) => pad.l + (i / Math.max(1, pts.length - 1)) * (W - pad.l - pad.r)
  const y = (v) => pad.t + (1 - (v - min) / span) * (H - pad.t - pad.b)

  const path = (key, colour) =>
    `<path fill="none" stroke="${colour}" stroke-width="1.6" d="${pts
      .map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`)
      .join('')}"/>`

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = min + span * f
    return `<g><line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"
      stroke="#30363d" stroke-dasharray="2 4"/>
      <text x="${pad.l - 8}" y="${(y(v) + 4).toFixed(1)}" fill="#8b949e" font-size="11" text-anchor="end">${money(v)}</text></g>`
  })

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Equity curve against the drawdown floor">
    ${ticks.join('')}
    ${path('floor', '#f85149')}
    ${path('equity', '#58a6ff')}
    <text x="${W - pad.r}" y="${pad.t + 12}" fill="#58a6ff" font-size="11" text-anchor="end">equity</text>
    <text x="${W - pad.r}" y="${pad.t + 26}" fill="#f85149" font-size="11" text-anchor="end">drawdown floor</text>
  </svg>`
}
