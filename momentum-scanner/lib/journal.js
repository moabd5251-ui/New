/**
 * Trade journal and the daily rules that sit on top of it.
 *
 * The per-trade math in trade-plan.js bounds one loss. These rules bound the
 * *day*: a max daily loss that stops trading before a bad morning becomes a bad
 * month, a trade cap that blunts revenge trading, and a session window because
 * this strategy's edge is concentrated in the first couple of hours, when the
 * volume that makes these moves possible is actually there.
 *
 * Trades are recorded as plans taken and results closed; stats are derived, so
 * the file on disk is only ever raw trades.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DEFAULT_SESSION_RULES = {
  maxDailyLossPct: 3, // percent of account, stop trading for the day
  dailyGoalPct: 6, // stop or size down once this is banked
  maxTradesPerDay: 6,
  maxConsecutiveLosses: 3, // step away and reset
  sessionStartMinutes: 9 * 60 + 30, // 09:30 ET
  sessionEndMinutes: 11 * 60 + 30, // 11:30 ET
  enforceSessionWindow: true,
};

function normalize(rules = {}) {
  const merged = { ...DEFAULT_SESSION_RULES, ...rules };
  for (const [key, fallback] of Object.entries(DEFAULT_SESSION_RULES)) {
    if (typeof fallback === 'boolean') {
      merged[key] = Boolean(merged[key]);
      continue;
    }
    const value = Number(merged[key]);
    merged[key] = Number.isFinite(value) && value >= 0 ? value : fallback;
  }
  return merged;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Minutes past midnight in New York, for the session window check. */
export function easternMinutes(now = new Date()) {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return { minutes: et.getHours() * 60 + et.getMinutes(), day: et.getDay(), date: dayKey(et) };
}

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export class Journal {
  constructor(path) {
    this.path = path;
    this.trades = [];
  }

  async load() {
    try {
      const contents = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(contents);
      this.trades = Array.isArray(parsed.trades) ? parsed.trades : [];
    } catch {
      this.trades = [];
    }
    return this.trades;
  }

  async persist() {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify({ trades: this.trades }, null, 2)}\n`, 'utf8');
  }

  /** Record a planned entry. Returns the stored trade. */
  async record(entry, now = Date.now()) {
    const et = easternMinutes(new Date(now));
    const trade = {
      id: `${entry.symbol}-${now}`,
      symbol: String(entry.symbol ?? '').toUpperCase(),
      pattern: entry.pattern ?? null,
      entry: Number(entry.entry),
      stop: Number(entry.stop),
      shares: Math.max(Math.floor(Number(entry.shares) || 0), 0),
      riskPerShare: round(Number(entry.entry) - Number(entry.stop)),
      plannedRisk: round((Number(entry.entry) - Number(entry.stop)) * (Number(entry.shares) || 0)),
      openedAt: new Date(now).toISOString(),
      tradingDay: et.date,
      status: 'open',
      exit: null,
      closedAt: null,
      pnl: null,
      rMultiple: null,
      notes: entry.notes ?? null,
    };
    this.trades.unshift(trade);
    await this.persist();
    return trade;
  }

  /** Close an open trade at a price and derive its P&L in dollars and R. */
  async close(id, exitPrice, now = Date.now()) {
    const trade = this.trades.find((t) => t.id === id);
    if (!trade) return null;
    if (trade.status === 'closed') return trade;

    const exit = Number(exitPrice);
    if (!Number.isFinite(exit) || exit <= 0) return null;

    // A fat-fingered exit silently poisons every statistic downstream — a
    // single 600R entry makes expectancy meaningless. Day trades do not move
    // by a factor of five, so treat that as a typo and refuse it.
    if (exit > trade.entry * 5 || exit < trade.entry / 5) {
      throw new RangeError(
        `Exit of ${exit} is implausible against an entry of ${trade.entry} — check the price`,
      );
    }

    trade.exit = round(exit);
    trade.closedAt = new Date(now).toISOString();
    trade.status = 'closed';
    trade.pnl = round((exit - trade.entry) * trade.shares);
    // R is the only cross-trade comparable unit: it normalizes away size.
    trade.rMultiple = trade.riskPerShare > 0 ? round((exit - trade.entry) / trade.riskPerShare) : null;

    await this.persist();
    return trade;
  }

  forDay(date) {
    return this.trades.filter((t) => t.tradingDay === date);
  }

  /** Aggregate stats. Open trades are excluded — they have no result yet. */
  stats(trades = this.trades) {
    const closed = trades.filter((t) => t.status === 'closed' && Number.isFinite(t.pnl));
    const wins = closed.filter((t) => t.pnl > 0);
    const losses = closed.filter((t) => t.pnl < 0);

    const sum = (list, key) => list.reduce((total, t) => total + (t[key] ?? 0), 0);
    const grossWin = sum(wins, 'pnl');
    const grossLoss = Math.abs(sum(losses, 'pnl'));

    return {
      total: trades.length,
      open: trades.filter((t) => t.status === 'open').length,
      closed: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRatePct: closed.length ? round((wins.length / closed.length) * 100) : null,
      netPnl: round(sum(closed, 'pnl')),
      avgWin: wins.length ? round(grossWin / wins.length) : null,
      avgLoss: losses.length ? round(grossLoss / losses.length) : null,
      // Average win divided by average loss — the realized payoff ratio, which
      // is the number the 2:1 target is trying to protect.
      profitLossRatio: wins.length && losses.length && grossLoss > 0
        ? round((grossWin / wins.length) / (grossLoss / losses.length))
        : null,
      totalR: round(sum(closed, 'rMultiple')),
      expectancyR: closed.length ? round(sum(closed, 'rMultiple') / closed.length) : null,
    };
  }

  /**
   * Decide whether a new trade is allowed right now.
   *
   * Returns `{ allowed, blockers, warnings, state }`. Blockers are hard stops
   * from the day's own results; warnings are advisory.
   */
  checkRules(accountSize, rules = {}, now = Date.now()) {
    const cfg = normalize(rules);
    const et = easternMinutes(new Date(now));
    const today = this.forDay(et.date);
    const stats = this.stats(today);

    const blockers = [];
    const warnings = [];

    const maxDailyLoss = (accountSize * cfg.maxDailyLossPct) / 100;
    const dailyGoal = (accountSize * cfg.dailyGoalPct) / 100;
    const netPnl = stats.netPnl ?? 0;

    if (netPnl <= -maxDailyLoss) {
      blockers.push(
        `Daily loss limit hit: ${fmtMoney(netPnl)} against a ${fmtMoney(-maxDailyLoss)} limit. Done for the day.`,
      );
    } else if (netPnl <= -maxDailyLoss * 0.6) {
      warnings.push(
        `${fmtMoney(netPnl)} on the day — within reach of the ${fmtMoney(-maxDailyLoss)} limit.`,
      );
    }

    if (today.length >= cfg.maxTradesPerDay) {
      blockers.push(`Trade cap reached: ${today.length} of ${cfg.maxTradesPerDay} today.`);
    }

    const streak = consecutiveLosses(today);
    if (streak >= cfg.maxConsecutiveLosses) {
      blockers.push(`${streak} losses in a row — step away and reset before the next one.`);
    }

    if (cfg.enforceSessionWindow) {
      const isWeekend = et.day === 0 || et.day === 6;
      if (isWeekend) {
        warnings.push('Weekend — the market is closed.');
      } else if (et.minutes < cfg.sessionStartMinutes || et.minutes > cfg.sessionEndMinutes) {
        warnings.push(
          `Outside the ${fmtClock(cfg.sessionStartMinutes)}-${fmtClock(cfg.sessionEndMinutes)} ET window where this strategy's volume lives.`,
        );
      }
    }

    if (netPnl >= dailyGoal) {
      warnings.push(`Daily goal of ${fmtMoney(dailyGoal)} is banked — consider sizing down.`);
    }

    return {
      allowed: blockers.length === 0,
      blockers,
      warnings,
      state: {
        tradingDay: et.date,
        tradesToday: today.length,
        maxTradesPerDay: cfg.maxTradesPerDay,
        netPnl: round(netPnl),
        maxDailyLoss: round(-maxDailyLoss),
        dailyGoal: round(dailyGoal),
        consecutiveLosses: streak,
        stats,
      },
    };
  }
}

/** Losses in a row counting back from the most recent closed trade. */
function consecutiveLosses(trades) {
  const closed = trades
    .filter((t) => t.status === 'closed' && Number.isFinite(t.pnl))
    .sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt));
  let streak = 0;
  for (const trade of closed) {
    if (trade.pnl < 0) streak += 1;
    else break;
  }
  return streak;
}

function fmtMoney(value) {
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function fmtClock(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export { normalize as normalizeSessionRules };
