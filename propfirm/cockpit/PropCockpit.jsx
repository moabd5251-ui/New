import { useState, useEffect, useMemo } from "react";

/**
 * PROP·COCKPIT — planning, sizing and journalling for the two measured playbooks.
 *
 * Two changes from the original, both driven by what the 704,591-bar study found:
 *
 * 1. The Stats tab reports MEDIAN and CONCENTRATION beside the mean. Both
 *    playbooks have a median trade at or near a full stop-out, and the sweep
 *    reversal's best five trades were 139% of its entire in-sample profit — the
 *    other forty-one lost money together. Expectancy alone looks healthiest
 *    exactly when the distribution is warning you off.
 *
 * 2. The Plan tab derives the day's playbook from the MEASURED bias filter
 *    rather than free choice or a generated narrative. Playbook B's filter —
 *    daily and 4H last-BOS agreeing, price on the trend side of the daily
 *    20 EMA — is load-bearing: it returns +0.108R in-sample and +0.254R
 *    out-of-sample when applied, and −0.009R / +0.036R when the direction is
 *    randomised. You answer three observations off your own chart; the app
 *    applies the rule. No prediction is invented for you.
 */

// ─── Design tokens ───────────────────────────────────────────────
const T = {
  ink: "#0D1320",
  panel: "#151D2D",
  panelHi: "#1C2638",
  line: "#26314A",
  amber: "#FFB020",
  long: "#2DD4A7",
  short: "#F0544F",
  text: "#E8ECF4",
  mute: "#8A94A6",
  mono: "ui-monospace, 'SF Mono', 'Cascadia Mono', Consolas, monospace",
  sans: "-apple-system, 'Segoe UI', Roboto, sans-serif",
};

const INSTRUMENTS = {
  MES: { pv: 5, label: "MES · $5/pt" },
  MNQ: { pv: 2, label: "MNQ · $2/pt" },
  ES: { pv: 50, label: "ES · $50/pt" },
  NQ: { pv: 20, label: "NQ · $20/pt" },
};

/** What each playbook actually measured, so the app never flatters one. */
const MEASURED = {
  A: { isR: 0.84, oosR: 0.84, perMonth: 1.5, medianR: -1.02, top5: 1.39, n: 36 },
  B: { isR: 0.108, oosR: 0.254, perMonth: 21.7, medianR: -1.04, top5: 0.86, n: 521 },
};

const PLAYBOOKS = {
  A: {
    name: "A · Sweep Reversal",
    desc: "Range day — fade the liquidity grab",
    note: `Measured +${MEASURED.A.isR}R over ${MEASURED.A.n} trades, but only ${MEASURED.A.perMonth}/month and its best five trades were ${Math.round(MEASURED.A.top5 * 100)}% of all profit.`,
    checks: [
      "Overnight high/low marked",
      "Prior day high/low + equal H/L marked",
      "News calendar checked (CPI/FOMC/NFP?)",
      "Sweep of a marked level confirmed",
      "Displacement back through the level",
      "CHoCH/BOS on 1–5min",
      "Entry only in FVG/OB inside OTE",
    ],
  },
  B: {
    name: "B · Trend Continuation",
    desc: "Trend day — join the pullback",
    note: `Measured +${MEASURED.B.isR}R IS / +${MEASURED.B.oosR}R OOS over ${MEASURED.B.n} trades at ~${MEASURED.B.perMonth}/month — the faster-testing of the two.`,
    checks: [
      "Bias filter passed (see above)",
      "Pullback into FVG/OB/20 EMA on 5–15min",
      "1–5min BOS back in trend direction",
      "Entry on retrace into the trigger's FVG",
      "Stop beyond the pullback extreme",
    ],
  },
  NONE: { name: "No Trade", desc: "No clear read. Sitting out IS the edge.", note: "", checks: [] },
};

/** The three observations Playbook B's measured filter needs. */
const BIAS_QUESTIONS = [
  { key: "dailyBos", q: "Daily last BOS direction?", opts: ["UP", "DOWN", "UNCLEAR"] },
  { key: "h4Bos", q: "4H last BOS direction?", opts: ["UP", "DOWN", "UNCLEAR"] },
  { key: "emaSide", q: "Price vs daily 20 EMA?", opts: ["ABOVE", "BELOW"] },
];

const STORE_KEY = "prop-cockpit-v2";
const todayStr = () => new Date().toISOString().slice(0, 10);

function sessionStatus() {
  try {
    const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const h = et.getHours() + et.getMinutes() / 60;
    const day = et.getDay();
    if (day === 0 || day === 6) return { label: "WEEKEND", color: T.mute };
    if (h >= 7 && h < 10) return { label: "NY KILLZONE — LIVE", color: T.long };
    if (h >= 10 && h < 11.5) return { label: "MANAGE ONLY", color: T.amber };
    if (h >= 11.5 && h < 13.5) return { label: "LUNCH CHOP — STAND DOWN", color: T.short };
    if (h >= 13.5 && h < 16) return { label: "PM SESSION — CAUTION", color: T.amber };
    return { label: "MARKET PREP", color: T.mute };
  } catch {
    return { label: "SESSION", color: T.mute };
  }
}

/**
 * Apply Playbook B's measured bias filter. Deterministic: same answers, same
 * verdict, every time. All three conditions must hold or B is off — which is
 * the whole point, since randomising the direction took the edge to zero.
 */
function evaluateBias(b) {
  const answered = BIAS_QUESTIONS.every((q) => b[q.key]);
  if (!answered) return { state: "incomplete", playbook: null, reason: "Answer all three." };
  if (b.dailyBos === "UNCLEAR" || b.h4Bos === "UNCLEAR")
    return { state: "fail", playbook: "A", dir: null, reason: "Structure unclear on a higher timeframe — B is off. A range day may still offer a sweep." };
  if (b.dailyBos !== b.h4Bos)
    return { state: "fail", playbook: "A", dir: null, reason: "Daily and 4H disagree — B is off. Conflicting timeframes are the range-day signature." };
  const wantAbove = b.dailyBos === "UP";
  if ((wantAbove && b.emaSide !== "ABOVE") || (!wantAbove && b.emaSide !== "BELOW"))
    return { state: "fail", playbook: "A", dir: null, reason: `Structure is ${b.dailyBos} but price is ${b.emaSide} the 20 EMA — not on the trend side. B is off.` };
  return {
    state: "pass",
    playbook: "B",
    dir: b.dailyBos === "UP" ? "LONG" : "SHORT",
    reason: `Daily and 4H both ${b.dailyBos}, price on the trend side. Playbook B is live — ${b.dailyBos === "UP" ? "longs" : "shorts"} only.`,
  };
}

export default function PropCockpit() {
  const [tab, setTab] = useState("plan");
  const [trades, setTrades] = useState([]);
  const [settings, setSettings] = useState({
    ddRemaining: 3000, riskPct: 0.5, instrument: "MNQ", evalTarget: 8000, evalMode: true,
  });
  const [dayPlan, setDayPlan] = useState({ date: todayStr(), playbook: null, checks: {}, bias: {} });
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get(STORE_KEY);
        if (r?.value) {
          const d = JSON.parse(r.value);
          setTrades(d.trades || []);
          setSettings((s) => ({ ...s, ...(d.settings || {}) }));
          if (d.dayPlan?.date === todayStr()) setDayPlan({ bias: {}, checks: {}, ...d.dayPlan });
        }
      } catch { /* first run */ }
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    (async () => {
      try {
        await window.storage.set(STORE_KEY, JSON.stringify({ trades, settings, dayPlan }));
        setSaveState("saved");
      } catch {
        setSaveState("save failed — data is in memory only");
      }
    })();
  }, [trades, settings, dayPlan, loaded]);

  const todayTrades = trades.filter((t) => t.date === todayStr());
  const todayLoss = todayTrades.some((t) => t.r < 0);
  const locked = settings.evalMode && (todayTrades.length >= 2 || todayLoss);

  /** Distribution matters more than the mean here — both are reported. */
  const stats = useMemo(() => {
    const closed = trades.filter((t) => typeof t.r === "number");
    const rs = closed.map((t) => t.r);
    const n = rs.length;
    if (!n) return { n: 0, byPb: { A: { n: 0, wr: 0, r: 0 }, B: { n: 0, wr: 0, r: 0 } } };
    const wins = rs.filter((r) => r > 0);
    const losses = rs.filter((r) => r < 0);
    const totalR = rs.reduce((a, r) => a + r, 0);
    const sorted = [...rs].sort((a, b) => a - b);
    const grossWin = wins.reduce((a, r) => a + r, 0);
    const grossLoss = -losses.reduce((a, r) => a + r, 0);
    const top5 = [...rs].sort((a, b) => b - a).slice(0, 5).reduce((a, r) => a + r, 0);
    let worstStreak = 0, run = 0;
    for (const r of rs) { run = r < 0 ? run + 1 : 0; worstStreak = Math.max(worstStreak, run); }
    const byPb = {};
    for (const pb of ["A", "B"]) {
      const g = closed.filter((t) => t.playbook === pb);
      const gr = g.map((t) => t.r);
      const gs = [...gr].sort((a, b) => a - b);
      byPb[pb] = {
        n: g.length,
        wr: g.length ? (gr.filter((r) => r > 0).length / g.length) * 100 : 0,
        r: gr.reduce((a, r) => a + r, 0),
        median: g.length ? gs[Math.floor(g.length / 2)] : 0,
      };
    }
    return {
      n, wins: wins.length, losses: losses.length, totalR,
      wr: (wins.length / n) * 100,
      avgW: wins.length ? grossWin / wins.length : 0,
      avgL: losses.length ? -grossLoss / losses.length : 0,
      exp: totalR / n,
      median: sorted[Math.floor(n / 2)],
      top5Share: totalR !== 0 ? top5 / totalR : 0,
      pf: grossLoss > 0 ? grossWin / grossLoss : Infinity,
      worstStreak,
      byPb,
    };
  }, [trades]);

  const riskDollars = Math.round((settings.ddRemaining * settings.riskPct) / 100);
  const bias = evaluateBias(dayPlan.bias || {});

  const S = {
    app: { minHeight: "100vh", background: T.ink, color: T.text, fontFamily: T.sans, maxWidth: 480, margin: "0 auto", padding: "0 0 40px" },
    mono: { fontFamily: T.mono },
    panel: { background: T.panel, border: `1px solid ${T.line}`, borderRadius: 10, padding: 16, margin: "12px 14px" },
    label: { fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: T.mute, fontFamily: T.mono },
    input: { width: "100%", background: T.ink, border: `1px solid ${T.line}`, borderRadius: 8, color: T.text, padding: "10px 12px", fontSize: 16, fontFamily: T.mono, boxSizing: "border-box", outline: "none" },
    btn: (active, color = T.amber) => ({
      flex: 1, padding: "10px 6px", borderRadius: 8,
      border: `1px solid ${active ? color : T.line}`,
      background: active ? `${color}22` : "transparent",
      color: active ? color : T.mute,
      fontFamily: T.mono, fontSize: 13, cursor: "pointer", transition: "all .15s",
    }),
  };

  const sess = sessionStatus();
  const [form, setForm] = useState({ instrument: "MNQ", dir: "LONG", playbook: "A", r: "", note: "" });

  const logTrade = () => {
    const r = parseFloat(form.r);
    if (isNaN(r)) return;
    setTrades((ts) => [{ id: Date.now(), date: todayStr(), ...form, r }, ...ts]);
    setForm((f) => ({ ...f, r: "", note: "" }));
  };

  const rColor = (r) => (r > 0 ? T.long : r < 0 ? T.short : T.mute);
  const dollarsPerR = riskDollars;
  const progressPct = Math.max(0, Math.min(100, ((stats.totalR * dollarsPerR) / settings.evalTarget) * 100));

  const gate = {
    n: stats.n >= 30,
    wr: stats.wr >= 40,
    avgW: stats.avgW >= 1.8,
  };
  const gatePassed = stats.n > 0 && gate.n && gate.wr && gate.avgW;

  return (
    <div style={S.app}>
      <div style={{ padding: "18px 14px 10px", borderBottom: `1px solid ${T.line}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div style={{ fontFamily: T.mono, fontWeight: 700, fontSize: 18, letterSpacing: "0.05em" }}>
            PROP<span style={{ color: T.amber }}>·</span>COCKPIT
          </div>
          <div style={{ ...S.label, color: sess.color }}>{sess.label}</div>
        </div>
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={S.label}>eval progress</span>
            <span style={{ ...S.mono, fontSize: 12, color: T.amber }}>
              {stats.totalR >= 0 ? "+" : ""}{(stats.totalR || 0).toFixed(1)}R ≈ ${Math.round((stats.totalR || 0) * dollarsPerR).toLocaleString()} / ${settings.evalTarget.toLocaleString()}
            </span>
          </div>
          <div style={{ height: 6, background: T.panelHi, borderRadius: 3, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${progressPct}%`, background: `linear-gradient(90deg, ${T.amber}88, ${T.amber})`, transition: "width .4s" }} />
          </div>
        </div>
      </div>

      {locked && (
        <div style={{ margin: "12px 14px 0", padding: "12px 14px", borderRadius: 10, border: `1px solid ${T.amber}`, background: `${T.amber}14`, color: T.amber, fontFamily: T.mono, fontSize: 13, lineHeight: 1.5 }}>
          ▮ SESSION LOCKED — {todayLoss ? "loss taken today" : "2 trades logged"}. Eval rules say you're done. Close the platform.
        </div>
      )}

      <div style={{ display: "flex", gap: 6, padding: "12px 14px 0" }}>
        {[["plan", "Plan"], ["size", "Size"], ["journal", "Journal"], ["stats", "Stats"]].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={S.btn(tab === k)}>{l}</button>
        ))}
      </div>

      {/* ─── PLAN ─── */}
      {tab === "plan" && (
        <>
          <div style={S.panel}>
            <div style={S.label}>bias filter — read your chart, the app applies the rule</div>
            <div style={{ color: T.mute, fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
              These are the three conditions that measured load-bearing. Randomise the direction and
              the edge goes to zero, so this is the filter, not a formality.
            </div>
            {BIAS_QUESTIONS.map((q) => (
              <div key={q.key} style={{ marginTop: 12 }}>
                <div style={{ ...S.label, textTransform: "none", letterSpacing: 0, fontSize: 12 }}>{q.q}</div>
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  {q.opts.map((o) => (
                    <button
                      key={o}
                      onClick={() => setDayPlan((d) => ({ ...d, date: todayStr(), bias: { ...(d.bias || {}), [q.key]: o } }))}
                      style={S.btn((dayPlan.bias || {})[q.key] === o, o === "UNCLEAR" ? T.mute : T.amber)}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div
              style={{
                marginTop: 14, padding: "12px 14px", borderRadius: 8,
                border: `1px solid ${bias.state === "pass" ? T.long : bias.state === "fail" ? T.amber : T.line}`,
                background: bias.state === "pass" ? `${T.long}12` : bias.state === "fail" ? `${T.amber}0D` : "transparent",
              }}
            >
              <div style={{ ...S.mono, fontSize: 13, color: bias.state === "pass" ? T.long : bias.state === "fail" ? T.amber : T.mute, lineHeight: 1.5 }}>
                {bias.state === "pass" ? `▶ PLAYBOOK B — ${bias.dir} ONLY` : bias.state === "fail" ? "▶ PLAYBOOK B IS OFF" : "▶ AWAITING INPUT"}
              </div>
              <div style={{ color: T.mute, fontSize: 12, marginTop: 4, lineHeight: 1.5 }}>{bias.reason}</div>
            </div>
          </div>

          <div style={S.panel}>
            <div style={S.label}>today's playbook</div>
            <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
              {["A", "B", "NONE"].map((pb) => {
                const blocked = pb === "B" && bias.state !== "pass";
                return (
                  <button
                    key={pb}
                    onClick={() => !blocked && setDayPlan((d) => ({ ...d, date: todayStr(), playbook: pb, checks: {} }))}
                    style={{
                      ...S.btn(dayPlan.playbook === pb, pb === "NONE" ? T.short : T.long),
                      opacity: blocked ? 0.35 : 1,
                      cursor: blocked ? "not-allowed" : "pointer",
                    }}
                    title={blocked ? "The bias filter has not passed — B is off today" : ""}
                  >
                    {pb === "NONE" ? "SIT OUT" : pb}
                  </button>
                );
              })}
            </div>
            {dayPlan.playbook && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontWeight: 600, fontSize: 15 }}>{PLAYBOOKS[dayPlan.playbook].name}</div>
                <div style={{ color: T.mute, fontSize: 13, marginTop: 2 }}>{PLAYBOOKS[dayPlan.playbook].desc}</div>
                {PLAYBOOKS[dayPlan.playbook].note && (
                  <div style={{ color: T.mute, fontSize: 12, marginTop: 8, lineHeight: 1.5, borderTop: `1px solid ${T.line}`, paddingTop: 8 }}>
                    {PLAYBOOKS[dayPlan.playbook].note}
                  </div>
                )}
              </div>
            )}
          </div>

          {dayPlan.playbook && dayPlan.playbook !== "NONE" && (
            <div style={S.panel}>
              <div style={S.label}>entry checklist — all boxes or no trade</div>
              <div style={{ marginTop: 8 }}>
                {PLAYBOOKS[dayPlan.playbook].checks.map((c, i) => {
                  const on = !!dayPlan.checks[i];
                  return (
                    <div
                      key={i}
                      onClick={() => setDayPlan((d) => ({ ...d, checks: { ...d.checks, [i]: !d.checks[i] } }))}
                      style={{ display: "flex", gap: 10, alignItems: "center", padding: "9px 0", borderBottom: `1px solid ${T.line}`, cursor: "pointer" }}
                    >
                      <div style={{ width: 18, height: 18, borderRadius: 5, flexShrink: 0, border: `1.5px solid ${on ? T.long : T.mute}`, background: on ? `${T.long}33` : "transparent", color: T.long, fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {on ? "✓" : ""}
                      </div>
                      <span style={{ fontSize: 14, color: on ? T.text : T.mute }}>{c}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {/* ─── SIZE ─── */}
      {tab === "size" && (
        <>
          <div style={S.panel}>
            <div style={S.label}>drawdown remaining ($)</div>
            <input style={{ ...S.input, marginTop: 6 }} type="number" value={settings.ddRemaining}
              onChange={(e) => setSettings((s) => ({ ...s, ddRemaining: +e.target.value || 0 }))} />
            <div style={{ ...S.label, marginTop: 14 }}>risk per trade (% of drawdown)</div>
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              {[0.25, 0.5, 0.75, 1].map((p) => (
                <button key={p} onClick={() => setSettings((s) => ({ ...s, riskPct: p }))} style={S.btn(settings.riskPct === p)}>{p}%</button>
              ))}
            </div>
            <div style={{ ...S.label, marginTop: 14 }}>instrument</div>
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              {Object.keys(INSTRUMENTS).map((k) => (
                <button key={k} onClick={() => setSettings((s) => ({ ...s, instrument: k }))} style={S.btn(settings.instrument === k)}>{k}</button>
              ))}
            </div>
          </div>
          <SizeResult settings={settings} riskDollars={riskDollars} S={S} />
          <div style={S.panel}>
            <div style={S.label}>eval settings</div>
            <div style={{ ...S.label, marginTop: 10, textTransform: "none", letterSpacing: 0 }}>Profit target ($)</div>
            <input style={{ ...S.input, marginTop: 6 }} type="number" value={settings.evalTarget}
              onChange={(e) => setSettings((s) => ({ ...s, evalTarget: +e.target.value || 0 }))} />
            <div onClick={() => setSettings((s) => ({ ...s, evalMode: !s.evalMode }))}
              style={{ marginTop: 12, display: "flex", justifyContent: "space-between", cursor: "pointer", alignItems: "center" }}>
              <span style={{ fontSize: 14 }}>Eval discipline lock (2 trades / 1 loss)</span>
              <span style={{ ...S.mono, fontSize: 12, color: settings.evalMode ? T.long : T.mute }}>{settings.evalMode ? "ON" : "OFF"}</span>
            </div>
          </div>
        </>
      )}

      {/* ─── JOURNAL ─── */}
      {tab === "journal" && (
        <>
          <div style={S.panel}>
            <div style={S.label}>log trade</div>
            <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
              {Object.keys(INSTRUMENTS).map((k) => (
                <button key={k} onClick={() => setForm((f) => ({ ...f, instrument: k }))} style={S.btn(form.instrument === k)}>{k}</button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button onClick={() => setForm((f) => ({ ...f, dir: "LONG" }))} style={S.btn(form.dir === "LONG", T.long)}>LONG</button>
              <button onClick={() => setForm((f) => ({ ...f, dir: "SHORT" }))} style={S.btn(form.dir === "SHORT", T.short)}>SHORT</button>
              <button onClick={() => setForm((f) => ({ ...f, playbook: "A" }))} style={S.btn(form.playbook === "A")}>PB·A</button>
              <button onClick={() => setForm((f) => ({ ...f, playbook: "B" }))} style={S.btn(form.playbook === "B")}>PB·B</button>
            </div>
            <div style={{ ...S.label, marginTop: 12 }}>result in R (e.g. 2 or -1)</div>
            <input style={{ ...S.input, marginTop: 6 }} type="number" step="0.1" value={form.r}
              onChange={(e) => setForm((f) => ({ ...f, r: e.target.value }))} placeholder="-1, 0, 2, 3.5 …" />
            <div style={{ ...S.label, marginTop: 12 }}>note</div>
            <input style={{ ...S.input, marginTop: 6, fontFamily: T.sans }} value={form.note}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="Sweep of ON low, clean displacement…" />
            <button onClick={logTrade} style={{ ...S.btn(true), width: "100%", marginTop: 14, padding: "12px", fontSize: 14, fontWeight: 700 }}>
              LOG TRADE
            </button>
          </div>

          <div style={S.panel}>
            <div style={S.label}>history · {trades.length} trades {saveState && `· ${saveState}`}</div>
            {trades.length === 0 && (
              <div style={{ color: T.mute, fontSize: 14, marginTop: 10 }}>No trades yet. Your forward-test starts with the first log.</div>
            )}
            {trades.slice(0, 30).map((t) => (
              <div key={t.id} style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: `1px solid ${T.line}`, gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ ...S.mono, fontSize: 13 }}>
                    <span style={{ color: t.dir === "LONG" ? T.long : T.short }}>{t.dir === "LONG" ? "▲" : "▼"}</span>{" "}
                    {t.instrument} · PB{t.playbook} · {t.date.slice(5)}
                  </div>
                  {t.note && (
                    <div style={{ color: T.mute, fontSize: 12, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.note}</div>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ ...S.mono, fontWeight: 700, color: rColor(t.r) }}>{t.r > 0 ? "+" : ""}{t.r}R</span>
                  <button onClick={() => setTrades((ts) => ts.filter((x) => x.id !== t.id))}
                    style={{ background: "none", border: "none", color: T.mute, cursor: "pointer", fontSize: 14 }} aria-label="Delete trade">✕</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ─── STATS ─── */}
      {tab === "stats" && (
        <>
          <div style={S.panel}>
            <div style={S.label}>performance · {stats.n} closed trades</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 12 }}>
              <Stat label="Total P&L" value={`${stats.totalR >= 0 ? "+" : ""}${(stats.totalR || 0).toFixed(1)}R`} color={rColor(stats.totalR)} S={S} />
              <Stat label="Expectancy" value={`${(stats.exp || 0) >= 0 ? "+" : ""}${(stats.exp || 0).toFixed(2)}R`} color={rColor(stats.exp)} S={S} />
              <Stat label="Win rate" value={`${(stats.wr || 0).toFixed(0)}%`} color={T.text} S={S} />
              <Stat label="Profit factor" value={stats.n ? (stats.pf === Infinity ? "∞" : stats.pf.toFixed(2)) : "—"} color={T.text} S={S} />
              <Stat label="Avg win" value={`+${(stats.avgW || 0).toFixed(2)}R`} color={T.long} S={S} />
              <Stat label="Avg loss" value={`${(stats.avgL || 0).toFixed(2)}R`} color={T.short} S={S} />
            </div>
          </div>

          {/* The half the original hid. */}
          <div style={S.panel}>
            <div style={S.label}>distribution — where the risk actually is</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 12 }}>
              <Stat label="Median trade" value={stats.n ? `${stats.median >= 0 ? "+" : ""}${stats.median.toFixed(2)}R` : "—"} color={rColor(stats.median)} S={S} />
              <Stat label="Top 5 = of profit" value={stats.n ? `${Math.round(stats.top5Share * 100)}%` : "—"} color={stats.top5Share > 1 ? T.short : T.text} S={S} />
              <Stat label="Worst losing streak" value={stats.n ? `${stats.worstStreak}` : "—"} color={T.text} S={S} />
              <Stat label="W / L" value={stats.n ? `${stats.wins} / ${stats.losses}` : "—"} color={T.text} S={S} />
            </div>
            <div style={{ color: T.mute, fontSize: 12, marginTop: 14, lineHeight: 1.6, borderTop: `1px solid ${T.line}`, paddingTop: 12 }}>
              Both playbooks measured a median trade near <span style={{ color: T.short }}>−1R</span> — a full stop-out is the
              typical outcome, and the mean is carried by a few outliers. Playbook A's best five trades were{" "}
              <span style={{ color: T.short }}>{Math.round(MEASURED.A.top5 * 100)}%</span> of all its profit, meaning every other
              trade lost money collectively. If your top-5 share is above 100%, your expectancy is one cold streak from
              disappearing — that is a sizing problem, not a strategy problem.
            </div>
          </div>

          <div style={S.panel}>
            <div style={S.label}>by playbook</div>
            {["A", "B"].map((pb) => (
              <div key={pb} style={{ padding: "10px 0", borderBottom: `1px solid ${T.line}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", ...S.mono, fontSize: 13 }}>
                  <span>{PLAYBOOKS[pb].name}</span>
                  <span style={{ color: T.mute }}>
                    {stats.byPb[pb].n} · {stats.byPb[pb].wr.toFixed(0)}% ·{" "}
                    <span style={{ color: rColor(stats.byPb[pb].r) }}>
                      {stats.byPb[pb].r >= 0 ? "+" : ""}{stats.byPb[pb].r.toFixed(1)}R
                    </span>
                  </span>
                </div>
                <div style={{ color: T.mute, fontSize: 11, marginTop: 3, ...S.mono }}>
                  yours: median {stats.byPb[pb].n ? `${stats.byPb[pb].median.toFixed(2)}R` : "—"}
                  {"  ·  "}measured: {MEASURED[pb].oosR >= 0 ? "+" : ""}{MEASURED[pb].oosR}R OOS at ~{MEASURED[pb].perMonth}/mo
                </div>
              </div>
            ))}
          </div>

          <div style={S.panel}>
            <div style={S.label}>go-live gate</div>
            {[
              ["≥ 30 trades", gate.n, `${stats.n}`],
              ["win rate ≥ 40%", gate.wr, `${(stats.wr || 0).toFixed(0)}%`],
              ["avg winner ≥ 1.8R", gate.avgW, `${(stats.avgW || 0).toFixed(2)}R`],
            ].map(([label, ok, val]) => (
              <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${T.line}`, fontSize: 13 }}>
                <span style={{ color: T.mute }}>{label}</span>
                <span style={{ ...S.mono, color: stats.n === 0 ? T.mute : ok ? T.long : T.short }}>
                  {val} {stats.n === 0 ? "" : ok ? "✓" : "✗"}
                </span>
              </div>
            ))}
            <div style={{ color: gatePassed ? T.amber : T.mute, fontSize: 12, marginTop: 12, lineHeight: 1.6 }}>
              {gatePassed
                ? "Gate met — but check the median and top-5 share above before funding anything. A gate passed on five outliers is not a gate passed."
                : "Until every line is green this is a forward test, not an evaluation. If the stats aren't there, tighten the filter — never add size."}
            </div>
          </div>
        </>
      )}

      <div style={{ margin: "18px 14px 0", color: T.mute, fontSize: 11, lineHeight: 1.5, textAlign: "center" }}>
        Educational planning tool. Not financial advice. Data saves to your Claude artifact storage.
      </div>
    </div>
  );
}

function Stat({ label, value, color, S }) {
  return (
    <div>
      <div style={S.label}>{label}</div>
      <div style={{ ...S.mono, fontSize: 22, fontWeight: 700, color, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function SizeResult({ settings, riskDollars, S }) {
  const [stopPts, setStopPts] = useState(20);
  const pv = INSTRUMENTS[settings.instrument].pv;
  const perContract = stopPts * pv;
  const contracts = perContract > 0 ? Math.floor(riskDollars / perContract) : 0;
  return (
    <div style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 10, padding: 16, margin: "12px 14px" }}>
      <div style={S.label}>stop size (points)</div>
      <input style={{ ...S.input, marginTop: 6 }} type="number" value={stopPts} onChange={(e) => setStopPts(+e.target.value || 0)} />
      <div style={{ marginTop: 14, padding: "14px", borderRadius: 8, border: `1px solid ${T.amber}44`, background: `${T.amber}0D` }}>
        <div style={S.label}>position</div>
        <div style={{ ...S.mono, fontSize: 26, fontWeight: 700, color: T.amber, marginTop: 4 }}>
          {contracts} × {settings.instrument}
        </div>
        <div style={{ ...S.mono, fontSize: 12, color: T.mute, marginTop: 6, lineHeight: 1.6 }}>
          Risk budget ${riskDollars} · ${perContract}/contract at {stopPts}pt stop
          {contracts === 0 && (
            <div style={{ color: T.short, marginTop: 4 }}>Stop too wide for your risk budget — skip or find a tighter entry.</div>
          )}
        </div>
      </div>
    </div>
  );
}
