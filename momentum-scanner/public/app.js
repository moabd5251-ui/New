/**
 * Scanner front end.
 *
 * Plain modules, no build step. State is deliberately small: the last scan
 * payload, the active tab, the sort, and the selected symbol.
 */

const PILLAR_SHORT = {
  change: '%',
  relativeVolume: 'V',
  news: 'N',
  price: '$',
  float: 'F',
};

const state = {
  scan: null,
  config: null,
  defaults: null,
  filter: 'qualified',
  sort: { key: null, dir: -1 },
  selected: null,
  timer: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

/* ---------------- formatting ---------------- */

const fmtNum = (value, digits = 2) =>
  Number.isFinite(value) ? value.toFixed(digits) : '—';

function fmtShares(value) {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return String(Math.round(value));
}

function fmtBig(value) {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function fmtClock(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', { hour12: false });
}

function relativeTime(iso) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

/* ---------------- heat colouring ---------------- */

/** 0..1 intensity mapped onto a hue, used to shade numeric cells. */
function heatStyle(intensity, hue) {
  const clamped = Math.max(0, Math.min(intensity, 1));
  if (clamped <= 0.01) return '';
  const alpha = 0.1 + clamped * 0.75;
  const text = clamped > 0.55 ? '#04210f' : 'inherit';
  return `background:hsla(${hue}, 78%, ${38 + clamped * 14}%, ${alpha});color:${text};`;
}

// Percentage moves span 10% to 500%+, so a log scale keeps the mid-range
// readable instead of saturating everything above the first big runner.
const logScale = (value, min, max) => {
  if (!Number.isFinite(value) || value <= min) return 0;
  return Math.min(Math.log(value / min) / Math.log(max / min), 1);
};

function changeHeat(value) {
  if (!Number.isFinite(value)) return '';
  if (value < 0) return heatStyle(Math.min(Math.abs(value) / 20, 1), 0);
  return heatStyle(logScale(value, 2, 400), 142);
}

const relVolHeat = (value) => heatStyle(logScale(value, 1, 8000), 142);
const gapHeat = (value) =>
  !Number.isFinite(value) ? '' : value < 0 ? heatStyle(Math.min(-value / 15, 1), 0) : heatStyle(logScale(value, 1, 150), 142);
// Low float is the scarce, valuable side — small numbers get the strongest cyan.
const floatHeat = (value) =>
  !Number.isFinite(value) ? '' : heatStyle(1 - logScale(value, 500_000, 120_000_000), 187);

/* ---------------- rendering ---------------- */

function render() {
  renderStatus();
  renderStats();
  renderTable();
  renderCriteriaCounts();
  renderRuleState();
}

function showBanner(message, isError = false) {
  const banner = $('#banner');
  banner.textContent = message;
  banner.className = `banner ${isError ? 'banner--error' : ''}`;
  banner.hidden = false;
}

function renderStatus() {
  const scan = state.scan;
  const badge = $('#provider-badge');
  if (!scan) return;

  const isLive = scan.provider === 'live';
  badge.textContent = isLive ? 'Live data' : 'Simulated data';
  badge.className = `badge ${isLive ? 'badge--live' : 'badge--sim'}`;
  $('#session-label').textContent = scan.session?.label ?? '';
  $('#scan-time').textContent = `Scanned ${fmtClock(scan.scannedAt)}`;

  const banner = $('#banner');
  const problems = [];
  if (scan.errors?.length) {
    problems.push(
      `${scan.errors.length} symbol${scan.errors.length === 1 ? '' : 's'} failed to load: ` +
        scan.errors.map((e) => `${e.symbol} (${e.message})`).join(', '),
    );
  }
  if (!isLive) {
    problems.push(
      'Running on simulated data with fictional tickers. Set SCANNER_PROVIDER=live for real quotes.',
    );
  }
  if (problems.length) {
    banner.textContent = problems.join(' · ');
    banner.className = scan.errors?.length ? 'banner banner--error' : 'banner';
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

function renderStats() {
  const summary = state.scan?.summary;
  if (!summary) return;
  $('#stats').innerHTML = [
    { label: 'Scanned', value: summary.scanned },
    { label: 'Qualified', value: summary.qualified, good: true },
    { label: 'Gapping up', value: summary.gappingUp },
    { label: 'Alerts', value: state.alerts?.length ?? 0 },
  ]
    .map(
      (stat) => `
      <div class="stat ${stat.good ? 'stat--good' : ''}">
        <div class="stat__value">${stat.value}</div>
        <div class="stat__label">${stat.label}</div>
      </div>`,
    )
    .join('');
}

function renderCriteriaCounts() {
  const counts = state.scan?.summary?.pillarCounts;
  const scanned = state.scan?.summary?.scanned ?? 0;
  if (!counts) return;
  for (const [id, count] of Object.entries(counts)) {
    const node = document.querySelector(`[data-count="${id}"]`);
    if (node) node.textContent = `${count}/${scanned} pass`;
  }
  const gapNode = document.querySelector('[data-count="gap"]');
  if (gapNode) gapNode.textContent = `${state.scan.summary.gappingUp}/${scanned} pass`;
}

function visibleRows() {
  const results = state.scan?.results ?? [];
  let rows = results;
  if (state.filter === 'qualified') rows = results.filter((r) => r.qualified);
  if (state.filter === 'near') rows = results.filter((r) => !r.qualified && r.score === 4);
  if (state.filter === 'setups') rows = results.filter((r) => r.setup);

  const { key, dir } = state.sort;
  if (key) {
    rows = [...rows].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
      }
      const an = Number.isFinite(av) ? av : -Infinity;
      const bn = Number.isFinite(bv) ? bv : -Infinity;
      return (an - bn) * dir;
    });
  }
  return rows;
}

function renderTable() {
  const results = state.scan?.results ?? [];
  $('#count-all').textContent = results.length;
  $('#count-qualified').textContent = results.filter((r) => r.qualified).length;
  $('#count-near').textContent = results.filter((r) => !r.qualified && r.score === 4).length;
  $('#count-setups').textContent = results.filter((r) => r.setup).length;

  // The journal is a different table entirely; swap the whole view.
  const isJournal = state.filter === 'journal';
  $('#journal-view').hidden = !isJournal;
  $('.table-wrap').hidden = isJournal;
  if (isJournal) {
    renderJournal();
    return;
  }

  const rows = visibleRows();
  const body = $('#scanner-body');

  if (!rows.length) {
    const message =
      state.filter === 'qualified'
        ? 'Nothing meets all five criteria right now. That is the normal state — most days have only a handful.'
        : state.filter === 'setups'
          ? 'No entry patterns on the qualified names right now. Waiting is the position.'
          : 'No rows to show.';
    body.innerHTML = `<tr class="empty"><td colspan="10">${message}</td></tr>`;
    return;
  }

  body.innerHTML = rows.map(rowHtml).join('');

  for (const tr of $$('#scanner-body tr[data-symbol]')) {
    tr.addEventListener('click', () => selectSymbol(tr.dataset.symbol));
  }
}

function rowHtml(result) {
  const pips = result.pillars
    .map((p) => {
      const cls = p.unavailable ? 'pip--unknown' : p.passed ? 'pip--pass' : 'pip--fail';
      const est = p.estimated ? ' pip--est' : '';
      const title = `${p.label}: ${p.detail}`;
      return `<span class="pip ${cls}${est}" title="${escapeAttr(title)}">${PILLAR_SHORT[p.id]}</span>`;
    })
    .join('');

  const newsIcon = result.catalysts?.length
    ? `<span class="sym__news" title="${escapeAttr(result.catalysts[0].headline)}">🔥</span>`
    : '';

  const setupBadge = result.setup
    ? `<span class="sym__setup ${result.plan?.tradable ? 'is-tradable' : ''}" title="${escapeAttr(result.setup.rationale)}">${escapeHtml(result.setup.label)}</span>`
    : '';

  return `
    <tr data-symbol="${escapeAttr(result.symbol)}" class="${state.selected === result.symbol ? 'is-selected' : ''}">
      <td class="num heat" style="${changeHeat(result.changeFromClosePct)}">${fmtNum(result.changeFromClosePct)}</td>
      <td>
        <span class="sym">
          <span class="sym__ticker">${escapeHtml(result.symbol)}</span>
          ${newsIcon}
          <span class="sym__grade" data-grade="${result.grade}">${result.grade}</span>
          ${setupBadge}
        </span>
      </td>
      <td class="num">${fmtNum(result.price)}</td>
      <td class="num">${fmtBig(result.volume)}</td>
      <td class="num heat" style="${floatHeat(result.float)}">${fmtShares(result.float)}</td>
      <td class="num heat" style="${relVolHeat(result.relativeVolume)}">${fmtBig(result.relativeVolume)}</td>
      <td class="num">${fmtBig(result.relVol5min)}</td>
      <td class="num heat" style="${gapHeat(result.gapPct)}">${fmtNum(result.gapPct)}</td>
      <td class="num">${fmtBig(result.shortInterest)}</td>
      <td><span class="pillars">${pips}</span></td>
    </tr>`;
}

/* ---------------- detail drawer ---------------- */

function selectSymbol(symbol) {
  state.selected = symbol;
  renderTable();
  renderDetail();
}

function closeDetail() {
  state.selected = null;
  $('#detail').hidden = true;
}

function renderDetail() {
  const result = state.scan?.results?.find((r) => r.symbol === state.selected);
  const panel = $('#detail');
  if (!result) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  $('#detail-symbol').textContent = result.symbol;
  $('#detail-name').textContent = [result.name, result.sector].filter(Boolean).join(' · ') || '—';

  const quote = [
    ['Price', `$${fmtNum(result.price)}`],
    ['Change', `${fmtNum(result.changeFromClosePct)}%`],
    ['Prior close', `$${fmtNum(result.prevClose)}`],
    ['Open / gap', `$${fmtNum(result.open)} (${fmtNum(result.gapPct)}%)`],
    ['Volume', fmtBig(result.volume)],
    ['Rel. volume', `${fmtBig(result.relativeVolume)}x`],
    ['Float', fmtShares(result.float)],
    ['Short interest', fmtBig(result.shortInterest)],
  ]
    .map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join('');

  const checklist = result.pillars
    .map((p) => {
      const cls = p.unavailable ? '' : p.passed ? 'check--pass' : 'check--fail';
      const icon = p.unavailable ? '？' : p.passed ? '✓' : '✕';
      return `
        <li class="check ${cls}">
          <span class="check__icon">${icon}</span>
          <span>
            <div class="check__label">${escapeHtml(p.label)}</div>
            <div class="check__detail">${escapeHtml(p.detail)}</div>
          </span>
        </li>`;
    })
    .join('');

  const news = result.catalysts?.length
    ? result.catalysts
        .map(
          (item) => `
          <li class="news">
            <div class="news__headline">${
              item.url
                ? `<a href="${escapeAttr(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.headline)}</a>`
                : escapeHtml(item.headline)
            }</div>
            <div class="news__meta">${escapeHtml(item.source ?? 'Unknown')} · ${relativeTime(item.datetime)}</div>
          </li>`,
        )
        .join('')
    : '<li class="alert-list__empty">No fresh headlines in the lookback window.</li>';

  $('#detail-body').innerHTML = `
    ${sparkline(result.candles, result.setup)}
    <div class="detail-quote">${quote}</div>
    <h3 class="section-title">Criteria — ${result.score}/5 passed · grade ${result.grade}</h3>
    <ul class="checklist">${checklist}</ul>
    ${tradePlanHtml(result)}
    <h3 class="section-title">Catalyst</h3>
    <ul class="news-list">${news}</ul>`;

  const logButton = $('#log-trade');
  if (logButton) logButton.addEventListener('click', () => logTrade(result));
}

/**
 * The trade plan: what to buy, where the stop goes, how many shares that risk
 * allows, and where to take profit. Blocked plans show why — the reason is the
 * useful part.
 */
function tradePlanHtml(result) {
  const setup = result.setup;
  if (!setup) {
    return `
      <h3 class="section-title">Trade plan</h3>
      <div class="plan plan--none">
        No entry pattern right now. The stock passes the selection criteria, but
        there is no pause to buy the break of — waiting is the position.
      </div>`;
  }

  const plan = result.plan ?? {};
  const blocked = !plan.tradable;

  const targets = (plan.targets ?? [])
    .map(
      (t) => `
      <tr>
        <td>${t.ratio}:1</td>
        <td class="num">$${fmtNum(t.price)}</td>
        <td class="num">${t.sharesOut?.toLocaleString('en-US') ?? '—'} sh</td>
        <td class="num plan__win">+$${fmtNum(t.profit)}</td>
      </tr>`,
    )
    .join('');

  const notes = (plan.sizingNotes ?? []).length
    ? `<div class="plan__notes">${plan.sizingNotes.map(escapeHtml).join('<br>')}</div>`
    : '';

  const blockers = (plan.blockers ?? []).length
    ? `<div class="plan__blockers">${plan.blockers.map(escapeHtml).join('<br>')}</div>`
    : '';

  const rules = state.scan?.rules;
  const ruleBlock = rules && !rules.allowed
    ? `<div class="plan__blockers">${rules.blockers.map(escapeHtml).join('<br>')}</div>`
    : '';

  return `
    <h3 class="section-title">Trade plan</h3>
    <div class="plan ${blocked ? 'plan--blocked' : ''}">
      <div class="plan__head">
        <span class="plan__pattern">${escapeHtml(setup.label)}</span>
        <span class="plan__state">${
          setup.triggered
            ? '<span class="plan__live">triggered</span>'
            : `${fmtNum(setup.distanceToTriggerPct)}% below trigger`
        }</span>
      </div>
      <p class="plan__rationale">${escapeHtml(setup.rationale)}</p>

      <div class="plan__grid">
        <div><span class="k">Entry over</span><span class="v">$${fmtNum(plan.entry)}</span></div>
        <div><span class="k">Stop under</span><span class="v plan__loss">$${fmtNum(plan.stop)}</span></div>
        <div><span class="k">Risk / share</span><span class="v">$${fmtNum(plan.riskPerShare)} (${fmtNum(plan.riskPerSharePct)}%)</span></div>
        <div><span class="k">Shares</span><span class="v">${(plan.shares ?? 0).toLocaleString('en-US')}</span></div>
        <div><span class="k">Position</span><span class="v">$${fmtNum(plan.positionCost)}</span></div>
        <div><span class="k">Max loss</span><span class="v plan__loss">-$${fmtNum(plan.maxLoss)}</span></div>
      </div>

      ${targets ? `<table class="plan__targets"><tbody>${targets}</tbody></table>` : ''}
      ${
        plan.blendedRatio
          ? `<div class="plan__ratio">Blended payoff <strong>${fmtNum(plan.blendedRatio)}:1</strong> · stop to breakeven at $${fmtNum(plan.stopAfterFirstTarget)} once the first target fills</div>`
          : ''
      }
      ${notes}
      ${blockers}
      ${ruleBlock}
      <button type="button" id="log-trade" class="btn btn--primary plan__log" ${
        blocked || (rules && !rules.allowed) ? 'disabled' : ''
      }>Log this trade</button>
    </div>`;
}

/** Minimal inline candle chart, with the entry and stop drawn on it. */
function sparkline(candles, setup) {
  if (!Array.isArray(candles) || candles.length < 5) return '';

  const width = 380;
  const height = 96;
  const slice = candles.slice(-45);
  const highs = slice.map((c) => c.high);
  const lows = slice.map((c) => c.low);
  const top = Math.max(...highs, setup?.entry ?? -Infinity);
  const bottom = Math.min(...lows, setup?.stop ?? Infinity);
  const span = top - bottom || 1;

  const x = (i) => (i / (slice.length - 1)) * width;
  const y = (price) => height - ((price - bottom) / span) * height;
  const barWidth = Math.max(width / slice.length - 1.2, 1);

  const bars = slice
    .map((c, i) => {
      const up = c.close >= c.open;
      const bodyTop = y(Math.max(c.open, c.close));
      const bodyHeight = Math.max(Math.abs(y(c.open) - y(c.close)), 1);
      const colour = up ? '#22c55e' : '#ef4444';
      return `
        <line x1="${x(i)}" x2="${x(i)}" y1="${y(c.high)}" y2="${y(c.low)}" stroke="${colour}" stroke-width="0.8" opacity="0.75" />
        <rect x="${x(i) - barWidth / 2}" y="${bodyTop}" width="${barWidth}" height="${bodyHeight}" fill="${colour}" />`;
    })
    .join('');

  // Entry and stop sit close together by design, so anchor their labels to
  // opposite edges — otherwise the text overlaps on every tight setup.
  const level = (price, colour, label, side) =>
    Number.isFinite(price)
      ? `<line x1="0" x2="${width}" y1="${y(price)}" y2="${y(price)}" stroke="${colour}" stroke-width="1" stroke-dasharray="4 3" opacity="0.9" />
         <text x="${side === 'right' ? width - 2 : 2}" y="${Math.min(Math.max(y(price) - 3, 9), height - 2)}"
               text-anchor="${side === 'right' ? 'end' : 'start'}"
               fill="${colour}" font-size="9" font-family="monospace">${label} ${price.toFixed(2)}</text>`
      : '';

  return `
    <svg class="spark" viewBox="0 0 ${width} ${height}" role="img"
         aria-label="Recent one-minute candles with entry and stop levels">
      ${bars}
      ${level(setup?.entry, '#38bdf8', 'entry', 'left')}
      ${level(setup?.stop, '#ef4444', 'stop', 'right')}
    </svg>`;
}

async function logTrade(result) {
  const plan = result.plan;
  if (!plan?.tradable) return;

  const response = await fetch('/api/trades', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol: result.symbol,
      pattern: result.setup?.label ?? null,
      entry: plan.entry,
      stop: plan.stop,
      shares: plan.shares,
    }),
  });

  if (response.status === 409) {
    const payload = await response.json();
    showBanner(`Trade blocked: ${payload.blockers.join(' ')}`, true);
    return;
  }
  await fetchTrades();
  await fetchScan();
}

/* ---------------- alerts ---------------- */

function renderAlerts() {
  const list = $('#alert-list');
  const alerts = state.alerts ?? [];
  if (!alerts.length) {
    list.innerHTML = '<li class="alert-list__empty">No alerts yet.</li>';
    return;
  }
  list.innerHTML = alerts
    .map(
      (alert) => `
      <li class="alert" data-symbol="${escapeAttr(alert.symbol)}">
        <div class="alert__row">
          <span class="alert__symbol">${escapeHtml(alert.symbol)}</span>
          <span class="alert__time">${relativeTime(alert.firedAt)}</span>
        </div>
        <div class="alert__meta">$${fmtNum(alert.price)} · ${fmtNum(alert.changeFromClosePct)}% · ${fmtBig(alert.relativeVolume)}x RVOL · ${fmtShares(alert.float)} float</div>
        ${alert.headline ? `<div class="alert__headline">${escapeHtml(alert.headline)}</div>` : ''}
      </li>`,
    )
    .join('');

  for (const node of $$('#alert-list .alert')) {
    node.addEventListener('click', () => selectSymbol(node.dataset.symbol));
  }
}

/* ---------------- journal ---------------- */

function renderJournal() {
  const trades = state.trades ?? [];
  const stats = state.tradeStats ?? {};
  $('#count-trades').textContent = trades.length;

  $('#journal-stats').innerHTML = [
    { label: 'Net P&L', value: `${stats.netPnl >= 0 ? '' : '-'}$${fmtNum(Math.abs(stats.netPnl ?? 0))}`, good: (stats.netPnl ?? 0) > 0 },
    { label: 'Win rate', value: stats.winRatePct == null ? '—' : `${fmtNum(stats.winRatePct, 1)}%` },
    { label: 'Payoff', value: stats.profitLossRatio == null ? '—' : `${fmtNum(stats.profitLossRatio)}:1` },
    { label: 'Total R', value: stats.totalR == null ? '—' : fmtNum(stats.totalR) },
    { label: 'Expectancy', value: stats.expectancyR == null ? '—' : `${fmtNum(stats.expectancyR)}R` },
  ]
    .map(
      (stat) => `
      <div class="stat ${stat.good ? 'stat--good' : ''}">
        <div class="stat__value">${stat.value}</div>
        <div class="stat__label">${stat.label}</div>
      </div>`,
    )
    .join('');

  const body = $('#journal-body');
  if (!trades.length) {
    body.innerHTML = '<tr class="empty"><td colspan="10">No trades logged yet.</td></tr>';
    return;
  }

  body.innerHTML = trades
    .map((trade) => {
      const pnlClass = trade.pnl == null ? '' : trade.pnl >= 0 ? 'plan__win' : 'plan__loss';
      return `
      <tr>
        <td><span class="sym__ticker">${escapeHtml(trade.symbol)}</span></td>
        <td>${escapeHtml(trade.pattern ?? '—')}</td>
        <td class="num">$${fmtNum(trade.entry)}</td>
        <td class="num">$${fmtNum(trade.stop)}</td>
        <td class="num">${trade.shares.toLocaleString('en-US')}</td>
        <td class="num">${trade.exit == null ? '—' : `$${fmtNum(trade.exit)}`}</td>
        <td class="num ${pnlClass}">${trade.pnl == null ? '—' : `$${fmtNum(trade.pnl)}`}</td>
        <td class="num ${pnlClass}">${trade.rMultiple == null ? '—' : `${fmtNum(trade.rMultiple)}R`}</td>
        <td>${fmtClock(trade.openedAt)}</td>
        <td>${
          trade.status === 'open'
            ? `<span class="close-cell">
                 <input type="number" step="0.01" class="close-price" data-id="${escapeAttr(trade.id)}" placeholder="exit" />
                 <button type="button" class="btn btn--sm close-trade" data-id="${escapeAttr(trade.id)}">Close</button>
               </span>`
            : '<span class="badge badge--muted">closed</span>'
        }</td>
      </tr>`;
    })
    .join('');

  for (const button of $$('.close-trade')) {
    button.addEventListener('click', async () => {
      const id = button.dataset.id;
      const input = document.querySelector(`.close-price[data-id="${CSS.escape(id)}"]`);
      const exit = Number(input?.value);
      if (!Number.isFinite(exit) || exit <= 0) {
        showBanner('Enter the exit price before closing the trade.', true);
        return;
      }
      const response = await fetch('/api/trades/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, exit }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        showBanner(payload.error ?? 'Could not close that trade.', true);
        return;
      }
      await fetchTrades();
      await fetchScan();
    });
  }
}

/** The day's standing: how much room is left before the rules stop trading. */
function renderRuleState() {
  const rules = state.scan?.rules;
  const node = $('#rule-state');
  if (!rules) return;

  const { state: s } = rules;
  const messages = [...rules.blockers, ...rules.warnings];
  const tone = rules.blockers.length ? 'rule-state--stop' : messages.length ? 'rule-state--warn' : 'rule-state--ok';

  node.className = `rule-state ${tone}`;
  node.innerHTML = `
    <div class="rule-state__row">
      <span>${rules.allowed ? 'Clear to trade' : 'Trading stopped'}</span>
      <span class="rule-state__figs">${s.tradesToday}/${s.maxTradesPerDay} trades · ${
        s.netPnl >= 0 ? '' : '-'
      }$${fmtNum(Math.abs(s.netPnl))} of $${fmtNum(Math.abs(s.maxDailyLoss))}</span>
    </div>
    ${messages.length ? `<div class="rule-state__msg">${messages.map(escapeHtml).join('<br>')}</div>` : ''}`;
}

/* ---------------- data ---------------- */

async function fetchScan() {
  try {
    const response = await fetch('/api/scan');
    if (!response.ok) throw new Error(`Scan failed (${response.status})`);
    state.scan = await response.json();
    await fetchAlerts();
    render();
    renderDetail();
  } catch (error) {
    const banner = $('#banner');
    banner.textContent = `Could not reach the scanner: ${error.message}`;
    banner.className = 'banner banner--error';
    banner.hidden = false;
  }
}

async function fetchAlerts() {
  const response = await fetch('/api/alerts');
  if (!response.ok) return;
  const payload = await response.json();
  state.alerts = payload.alerts ?? [];
  renderAlerts();
}

async function fetchConfig() {
  const response = await fetch('/api/config');
  const payload = await response.json();
  state.config = payload.config;
  state.defaults = payload.defaults;
  fillForm(payload.config);
}

async function fetchRisk() {
  const response = await fetch('/api/risk');
  const payload = await response.json();
  state.risk = payload.risk;
  state.riskDefaults = payload.defaults;
  fillRiskForm(payload.risk);
}

async function saveRisk(patch) {
  const response = await fetch('/api/risk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const payload = await response.json();
  state.risk = payload.risk;
  fillRiskForm(payload.risk);
  await fetchScan();
}

async function fetchTrades() {
  const response = await fetch('/api/trades');
  if (!response.ok) return;
  const payload = await response.json();
  state.trades = payload.trades ?? [];
  state.tradeStats = payload.stats ?? {};
  if (state.filter === 'journal') renderJournal();
  $('#count-trades').textContent = state.trades.length;
}

function fillRiskForm(risk) {
  const form = $('#risk-form');
  form.accountSize.value = risk.accountSize;
  form.maxRiskPerTradePct.value = risk.maxRiskPerTradePct;
  form.maxDailyLossPct.value = risk.maxDailyLossPct;
  form.maxTradesPerDay.value = risk.maxTradesPerDay;
  form.minProfitLossRatio.value = risk.minProfitLossRatio;
  // Spell out what the percentage actually costs — percentages are easy to
  // set carelessly, dollars are not.
  $('#risk-dollars').textContent =
    `≈ $${fmtNum((risk.accountSize * risk.maxRiskPerTradePct) / 100)} per trade`;
}

function readRiskForm() {
  const form = $('#risk-form');
  return {
    accountSize: Number(form.accountSize.value),
    maxRiskPerTradePct: Number(form.maxRiskPerTradePct.value),
    maxDailyLossPct: Number(form.maxDailyLossPct.value),
    maxTradesPerDay: Number(form.maxTradesPerDay.value),
    minProfitLossRatio: Number(form.minProfitLossRatio.value),
  };
}

async function saveConfig(patch) {
  const response = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const payload = await response.json();
  state.config = payload.config;
  fillForm(payload.config);
  await fetchScan();
}

function fillForm(config) {
  const form = $('#criteria-form');
  form.minChangeFromClosePct.value = config.minChangeFromClosePct;
  form.minRelativeVolume.value = config.minRelativeVolume;
  form.requireNews.checked = config.requireNews;
  form.newsLookbackHours.value = config.newsLookbackHours;
  form.minPrice.value = config.minPrice;
  form.maxPrice.value = config.maxPrice;
  form.maxFloatMillions.value = config.maxFloat / 1e6;
  form.minGapPct.value = config.minGapPct;
}

function readForm() {
  const form = $('#criteria-form');
  return {
    minChangeFromClosePct: Number(form.minChangeFromClosePct.value),
    minRelativeVolume: Number(form.minRelativeVolume.value),
    requireNews: form.requireNews.checked,
    newsLookbackHours: Number(form.newsLookbackHours.value),
    minPrice: Number(form.minPrice.value),
    maxPrice: Number(form.maxPrice.value),
    maxFloat: Number(form.maxFloatMillions.value) * 1e6,
    minGapPct: Number(form.minGapPct.value),
  };
}

/* ---------------- wiring ---------------- */

function restartTimer() {
  clearInterval(state.timer);
  if (!$('#auto-refresh').checked) return;
  state.timer = setInterval(fetchScan, Number($('#refresh-interval').value));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function init() {
  $('#scan-now').addEventListener('click', fetchScan);
  $('#auto-refresh').addEventListener('change', restartTimer);
  $('#refresh-interval').addEventListener('change', restartTimer);

  let debounce;
  $('#criteria-form').addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => saveConfig(readForm()), 400);
  });

  $('#reset-criteria').addEventListener('click', () => saveConfig(state.defaults));

  let riskDebounce;
  $('#risk-form').addEventListener('input', () => {
    clearTimeout(riskDebounce);
    riskDebounce = setTimeout(() => saveRisk(readRiskForm()), 400);
  });
  $('#reset-risk').addEventListener('click', () => saveRisk(state.riskDefaults));

  $('#clear-alerts').addEventListener('click', async () => {
    await fetch('/api/alerts', { method: 'DELETE' });
    state.alerts = [];
    renderAlerts();
    renderStats();
  });

  for (const tab of $$('.tab')) {
    tab.addEventListener('click', () => {
      state.filter = tab.dataset.filter;
      // The drawer belongs to a row in the previous view; leaving it open would
      // cover the table the user just switched to.
      closeDetail();
      for (const other of $$('.tab')) {
        const active = other === tab;
        other.classList.toggle('is-active', active);
        other.setAttribute('aria-selected', String(active));
      }
      renderTable();
    });
  }

  for (const th of $$('.scanner thead th[data-sort]')) {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: -1 };
      for (const other of $$('.scanner thead th')) other.classList.remove('is-sorted');
      th.classList.add('is-sorted');
      renderTable();
    });
  }

  $('#detail-close').addEventListener('click', () => {
    closeDetail();
    renderTable();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.selected) {
      closeDetail();
      renderTable();
    }
  });

  Promise.all([fetchConfig(), fetchRisk(), fetchTrades()]).then(fetchScan).then(restartTimer);
}

init();
