/**
 * Forward-validation scoreboard for the registered futures specs.
 *
 * This page has an unusual job: for most of its life it reports that nothing
 * has happened yet. Four hypotheses were registered before the data that will
 * judge them existed, and the honest state of each is "waiting". So the design
 * leads with PROGRESS TOWARD A VERDICT rather than performance — a page that
 * showed only P&L would be blank, and a blank page invites the reader to
 * assume the absence of news is bad news.
 *
 * The second job is to refuse to flatter. Every one of these strategies has a
 * median trade at or near a full stop-out and profit concentrated in a handful
 * of trades, so the mean alone misrepresents them. Median and top-five share
 * sit next to expectancy everywhere, at the same weight.
 */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const sgn = (n, d = 2) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(d)}`
const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`

/**
 * @param {{specs: Array<{
 *   key:string, name:string, thesis:string, registered:string,
 *   threshold:number, thresholdUnit:string, etaNote:string,
 *   baseline:Array<[string,string]>, caution:string,
 *   current:null|{n:number, expR?:number, medianR?:number, topFiveShare?:number,
 *                 winRate?:number, tStat?:number, perMonth?:number, extra?:Array<[string,string]>},
 * }>}} data
 */
export function renderFuturesPage({ specs, generatedAt = new Date().toISOString() }) {
  const card = (s) => {
    const n = s.current?.n ?? 0
    const progress = Math.min(100, (n / s.threshold) * 100)
    const live = n > 0

    const metrics = live
      ? `<dl class="metrics">
          <div><dt>Expectancy</dt><dd class="${s.current.expR >= 0 ? 'up' : 'dn'}">${sgn(s.current.expR)}R</dd></div>
          <div><dt>Median trade</dt><dd class="${s.current.medianR >= 0 ? 'up' : 'dn'}">${sgn(s.current.medianR)}R</dd></div>
          <div><dt>Top 5 = of profit</dt><dd>${s.current.topFiveShare != null ? pct(s.current.topFiveShare) : '—'}</dd></div>
          <div><dt>Win rate</dt><dd>${s.current.winRate != null ? pct(s.current.winRate) : '—'}</dd></div>
        </dl>
        ${s.current.extra?.length ? `<dl class="metrics sub-metrics">${s.current.extra.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}`
      : `<p class="waiting">No qualifying setups recorded since registration. ${esc(s.etaNote)}</p>`

    return `
    <article class="spec">
      <header class="spec-head">
        <h3>${esc(s.name)}</h3>
        <span class="badge ${live ? 'badge-live' : ''}">${live ? `${n} / ${s.threshold}` : 'awaiting data'}</span>
      </header>
      <p class="thesis">${esc(s.thesis)}</p>

      <div class="rail" role="img" aria-label="${n} of ${s.threshold} ${esc(s.thresholdUnit)} toward a verdict">
        <div class="rail-fill" style="width:${progress.toFixed(1)}%"></div>
      </div>
      <p class="rail-label">${n} of ${s.threshold} ${esc(s.thresholdUnit)} · registered ${esc(s.registered)}</p>

      ${metrics}

      <details>
        <summary>What it has to reproduce</summary>
        <dl class="baseline">
          ${s.baseline.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}
        </dl>
        <p class="caution">${esc(s.caution)}</p>
      </details>
    </article>`
  }

  const totalRecords = specs.reduce((a, s) => a + (s.current?.n ?? 0), 0)

  return `<title>Futures forward validation</title>
<style>
  :root {
    --ground: #F2F4F3; --surface: #FFFFFF; --raised: #F7F9F8;
    --ink: #17211D; --muted: #64716B; --line: #D9E0DC;
    --accent: #1F6F5C; --up: #1F6F5C; --dn: #A8443B;
    --rail: #DCE5E1;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ground: #101614; --surface: #19211E; --raised: #1F2926;
      --ink: #E4EAE7; --muted: #8E9C96; --line: #2C3833;
      --accent: #4FBF9F; --up: #4FBF9F; --dn: #DE8177;
      --rail: #26312D;
    }
  }
  :root[data-theme="dark"] {
    --ground: #101614; --surface: #19211E; --raised: #1F2926;
    --ink: #E4EAE7; --muted: #8E9C96; --line: #2C3833;
    --accent: #4FBF9F; --up: #4FBF9F; --dn: #DE8177;
    --rail: #26312D;
  }
  body { background: var(--ground); color: var(--ink); margin: 0;
    font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 30px 18px 64px; }
  .eyebrow { color: var(--accent); font-size: 0.71rem; font-weight: 650;
    text-transform: uppercase; letter-spacing: 0.1em; margin: 0 0 6px; }
  h1 { font-size: 1.4rem; margin: 0 0 8px; letter-spacing: -0.015em; text-wrap: balance; }
  .lede { color: var(--muted); font-size: 0.9rem; margin: 0; max-width: 60ch; }
  h2 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.1em;
    color: var(--muted); margin: 34px 0 12px; }

  .spec { background: var(--surface); border: 1px solid var(--line);
    border-radius: 12px; padding: 18px 20px; margin-bottom: 14px; }
  .spec-head { display: flex; align-items: baseline; gap: 12px; }
  .spec-head h3 { font-size: 1.02rem; margin: 0; letter-spacing: -0.01em; }
  .badge { margin-left: auto; font-size: 0.68rem; font-weight: 650; letter-spacing: 0.05em;
    text-transform: uppercase; color: var(--muted); background: var(--raised);
    border: 1px solid var(--line); border-radius: 99px; padding: 3px 10px;
    font-variant-numeric: tabular-nums; white-space: nowrap; }
  .badge-live { color: var(--accent); border-color: var(--accent); }
  .thesis { color: var(--muted); font-size: 0.86rem; margin: 7px 0 14px; }

  .rail { height: 5px; background: var(--rail); border-radius: 3px; overflow: hidden; }
  .rail-fill { height: 100%; background: var(--accent); }
  .rail-label { color: var(--muted); font-size: 0.74rem; margin: 6px 0 0;
    font-variant-numeric: tabular-nums; }

  .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr));
    gap: 12px 18px; margin: 16px 0 0; padding-top: 14px; border-top: 1px solid var(--line); }
  .sub-metrics { border-top: 0; padding-top: 0; margin-top: 12px; }
  .metrics dt { color: var(--muted); font-size: 0.67rem; text-transform: uppercase;
    letter-spacing: 0.07em; }
  .metrics dd { margin: 2px 0 0; font-size: 1.08rem; font-weight: 650;
    font-variant-numeric: tabular-nums; }
  .metrics .up { color: var(--up); } .metrics .dn { color: var(--dn); }
  .waiting { color: var(--muted); font-size: 0.85rem; margin: 14px 0 0; padding-top: 14px;
    border-top: 1px solid var(--line); }

  details { margin-top: 14px; }
  summary { cursor: pointer; color: var(--muted); font-size: 0.78rem;
    text-transform: uppercase; letter-spacing: 0.07em; }
  summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 3px; }
  .baseline { margin: 12px 0 0; display: grid; gap: 6px; }
  .baseline div { display: flex; justify-content: space-between; gap: 16px;
    font-size: 0.82rem; border-bottom: 1px solid var(--line); padding-bottom: 5px; }
  .baseline dt { color: var(--muted); }
  .baseline dd { margin: 0; font-variant-numeric: tabular-nums; text-align: right; }
  .caution { color: var(--dn); font-size: 0.79rem; margin: 10px 0 0; }

  .why { background: var(--surface); border: 1px solid var(--line);
    border-left: 3px solid var(--accent); border-radius: 0 10px 10px 0;
    padding: 14px 18px; margin: 30px 0 0; font-size: 0.85rem; color: var(--muted); }
  .why strong { color: var(--ink); }
  footer { color: var(--muted); font-size: 0.74rem; margin-top: 26px; }
</style>
<div class="wrap">
  <header>
    <p class="eyebrow">Paper only · no orders placed</p>
    <h1>Futures forward validation</h1>
    <p class="lede">Four hypotheses, each frozen and registered <em>before</em> the data that will judge
    them existed. Every completed day is scored once and never re-scored. This page tracks how close
    each one is to having enough evidence to be worth an opinion.</p>
  </header>

  <h2>Registered specs</h2>
  ${specs.map(card).join('\n')}

  <div class="why">
    <strong>Why the median sits next to the mean everywhere.</strong> All four of these have a median
    trade at or near a full stop-out, with profit concentrated in a few outliers — the sweep reversal's
    best five trades were 139% of its entire in-sample profit, meaning the other forty-one lost money
    together. A dashboard reporting expectancy alone would look healthy at exactly the moment the
    distribution was telling you not to trust it. ${totalRecords === 0
      ? 'Nothing has recorded yet, so every figure here is still the pre-registration baseline.'
      : `${totalRecords} record${totalRecords === 1 ? '' : 's'} so far — far below any threshold that would justify acting.`}
  </div>

  <footer>Generated ${esc(generatedAt.slice(0, 16).replace('T', ' '))} UTC · journals committed to git each weekday ·
  nothing in this repository places, routes or sizes an order.</footer>
</div>`
}
