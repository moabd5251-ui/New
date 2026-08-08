/**
 * Trade plan: turning a detected setup into a sized, bounded order.
 *
 * The rule that governs everything here is that the stop comes first. You do
 * not decide how many shares to buy and then discover your risk — you decide
 * what you are willing to lose, and the distance to the stop tells you the
 * share count. A tighter setup therefore buys more size at the *same* risk,
 * which is why the entry patterns are chosen for tight stops.
 *
 * Targets are expressed in R — multiples of the per-share risk. A 2:1 target is
 * the floor: at 2:1 a strategy can be wrong more often than right and still
 * make money, which is what makes the losses survivable.
 *
 * Setups carry a `direction`. The momentum patterns are all long, so that is
 * the default and nothing about them changes; the multi-timeframe strategy in
 * trend.js also fires short, where the stop sits above the entry and the
 * targets run down. Only the sign differs — the risk arithmetic is identical.
 */

export const DEFAULT_RISK_CONFIG = {
  accountSize: 25_000,
  maxRiskPerTradePct: 1, // percent of account risked per trade
  minProfitLossRatio: 2, // never take a setup that cannot pay 2:1
  targetRatios: [2, 3], // where to scale out, in R
  scaleOutPct: 50, // share of the position sold at the first target
  maxPositionPctOfAccount: 100, // sanity cap; brokers allow more on margin
  maxRiskPerSharePct: 8, // a stop this wide is a different trade, not this one
  maxPctOfCandleVolume: 2, // do not plan more size than the tape can absorb
};

function normalize(config = {}) {
  const merged = { ...DEFAULT_RISK_CONFIG, ...config };
  for (const [key, fallback] of Object.entries(DEFAULT_RISK_CONFIG)) {
    if (Array.isArray(fallback)) {
      const list = Array.isArray(merged[key]) ? merged[key].map(Number).filter((n) => n > 0) : [];
      merged[key] = list.length ? list.sort((a, b) => a - b) : fallback;
      continue;
    }
    const value = Number(merged[key]);
    merged[key] = Number.isFinite(value) && value > 0 ? value : fallback;
  }
  return merged;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Build a plan for one setup.
 *
 * Always returns an object. When the setup cannot be traded within the risk
 * rules, `tradable` is false and `blockers` says why — a rejected plan is a
 * result, not an error, and seeing the reason is how the rules get learned.
 */
export function buildTradePlan(setup, riskConfig = {}, context = {}) {
  const cfg = normalize(riskConfig);
  const blockers = [];

  // Long unless the setup says otherwise: every pattern in patterns.js is a
  // break to the upside, and a missing field must not silently invert a plan.
  const direction = setup?.direction === 'short' ? 'short' : 'long';
  const sign = direction === 'short' ? -1 : 1;

  const entry = Number(setup?.entry);
  const stop = Number(setup?.stop);
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || sign * (entry - stop) <= 0) {
    return {
      tradable: false,
      direction,
      blockers: [`Setup has no valid entry ${direction === 'short' ? 'below' : 'above'} its stop`],
      setup: setup ?? null,
    };
  }

  const riskPerShare = Math.abs(entry - stop);
  const riskPerSharePct = (riskPerShare / entry) * 100;
  const maxRiskDollars = (cfg.accountSize * cfg.maxRiskPerTradePct) / 100;

  // Share count follows from the risk budget and the stop distance.
  let shares = Math.floor(maxRiskDollars / riskPerShare);
  const sizingNotes = [];

  // A stop that wide means the pattern is not tight enough to define risk.
  if (riskPerSharePct > cfg.maxRiskPerSharePct) {
    blockers.push(
      `Stop is ${riskPerSharePct.toFixed(1)}% away, wider than the ${cfg.maxRiskPerSharePct}% limit`,
    );
  }

  // Never plan more size than the recent tape can absorb — a position you
  // cannot exit at the stop has no real stop.
  if (Number.isFinite(context.recentCandleVolume) && context.recentCandleVolume > 0) {
    const liquidityCap = Math.floor((context.recentCandleVolume * cfg.maxPctOfCandleVolume) / 100);
    if (liquidityCap < shares) {
      sizingNotes.push(
        `Trimmed to ${liquidityCap.toLocaleString('en-US')} shares — ${cfg.maxPctOfCandleVolume}% of recent per-minute volume`,
      );
      shares = liquidityCap;
    }
  }

  // Cap the notional so one trade cannot become the whole account.
  const maxPosition = (cfg.accountSize * cfg.maxPositionPctOfAccount) / 100;
  if (shares * entry > maxPosition) {
    const capped = Math.floor(maxPosition / entry);
    sizingNotes.push(
      `Trimmed to ${capped.toLocaleString('en-US')} shares — ${cfg.maxPositionPctOfAccount}% of account cap`,
    );
    shares = capped;
  }

  if (shares < 1) {
    blockers.push('Risk budget is too small for even one share at this stop distance');
    shares = 0;
  }

  const targets = cfg.targetRatios.map((ratio) => ({
    ratio,
    price: round(entry + sign * riskPerShare * ratio),
    gainPerShare: round(riskPerShare * ratio),
    // The first target takes scaleOutPct off; the rest rides to the next one.
    sharesOut:
      cfg.targetRatios.length > 1 && ratio === cfg.targetRatios[0]
        ? Math.floor((shares * cfg.scaleOutPct) / 100)
        : shares - Math.floor((shares * cfg.scaleOutPct) / 100),
  })).map((target) => ({
    ...target,
    profit: round(target.gainPerShare * target.sharesOut),
  }));

  const maxLoss = round(riskPerShare * shares);
  const profitAtAllTargets = round(targets.reduce((sum, t) => sum + (t.profit ?? 0), 0));

  // The setup has to be able to pay the minimum ratio before it is worth taking.
  const bestRatio = cfg.targetRatios.at(-1) ?? cfg.minProfitLossRatio;
  if (bestRatio < cfg.minProfitLossRatio) {
    blockers.push(
      `Targets top out at ${bestRatio}:1, below the ${cfg.minProfitLossRatio}:1 minimum`,
    );
  }

  return {
    tradable: blockers.length === 0 && shares > 0,
    direction,
    blockers,
    sizingNotes,
    setup: setup ?? null,
    entry: round(entry),
    stop: round(stop),
    riskPerShare: round(riskPerShare),
    riskPerSharePct: round(riskPerSharePct),
    shares,
    positionCost: round(shares * entry),
    maxLoss,
    maxRiskBudget: round(maxRiskDollars),
    targets,
    profitAtAllTargets,
    // Blended payoff if the plan runs to completion, expressed against risk.
    blendedRatio: maxLoss > 0 ? round(profitAtAllTargets / maxLoss) : null,
    stopAfterFirstTarget: round(entry), // move to breakeven once the first target pays
  };
}

/**
 * Attach a plan to every scan result that currently has a setup. Results
 * without candles or without a pattern pass through untouched.
 */
export function planFor(result, riskConfig = {}, setup = null) {
  if (!setup) return { ...result, setup: null, plan: null };

  const recentCandleVolume = averageRecentVolume(result.candles);
  return {
    ...result,
    setup,
    plan: buildTradePlan(setup, riskConfig, { recentCandleVolume }),
  };
}

function averageRecentVolume(candles) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const recent = candles.slice(-5).map((c) => c.volume).filter((v) => Number.isFinite(v) && v > 0);
  if (!recent.length) return null;
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

export { normalize as normalizeRiskConfig };
