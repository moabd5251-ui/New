/**
 * Prop firm account rules.
 *
 * The strategy is half the job. The other half is not breaching an account, and
 * the rule that kills most funded accounts is the trailing drawdown — because
 * it follows the UNREALISED peak. Being up $1,800 and giving it back is not
 * "flat", it moves the floor up under you and then stops you out of the account
 * on a trade that would otherwise have been a scratch.
 *
 * ── Verify these numbers against your own firm ──────────────────────────────
 * The account presets below reflect commonly published evaluation parameters,
 * but every firm changes its rules and the details differ per program. Treat
 * them as a template: confirm drawdown amount, contract limits, consistency and
 * payout terms against your actual account agreement before trading, and edit
 * the preset to match. A rule engine configured from memory is worse than none.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Instrument specifications. `pointValue` is the dollar move per 1.00 of price
 * per unit held, so the same sizing maths covers futures contracts and shares.
 *
 * Equities are here because Tradier — a common data source for this — carries
 * no futures at all. QQQ tracks the same index as NQ and has excellent volume
 * data, but it is a different instrument: regular hours only, penny ticks, and
 * roughly 1/40th the notional per unit.
 */
export const INSTRUMENTS = {
  NQ: { symbol: 'NQ', name: 'E-mini Nasdaq-100', kind: 'future', tickSize: 0.25, tickValue: 5, pointValue: 20 },
  MNQ: { symbol: 'MNQ', name: 'Micro E-mini Nasdaq-100', kind: 'future', tickSize: 0.25, tickValue: 0.5, pointValue: 2 },
  ES: { symbol: 'ES', name: 'E-mini S&P 500', kind: 'future', tickSize: 0.25, tickValue: 12.5, pointValue: 50 },
  MES: { symbol: 'MES', name: 'Micro E-mini S&P 500', kind: 'future', tickSize: 0.25, tickValue: 1.25, pointValue: 5 },
  QQQ: { symbol: 'QQQ', name: 'Invesco QQQ Trust (NASDAQ-100 ETF)', kind: 'equity', tickSize: 0.01, tickValue: 0.01, pointValue: 1 },
  SPY: { symbol: 'SPY', name: 'SPDR S&P 500 ETF', kind: 'equity', tickSize: 0.01, tickValue: 0.01, pointValue: 1 },
}

/** Build a spec for any equity ticker not listed above. */
export function equityInstrument(symbol) {
  return { symbol: symbol.toUpperCase(), name: symbol.toUpperCase(), kind: 'equity', tickSize: 0.01, tickValue: 0.01, pointValue: 1 }
}

/**
 * Drawdown models.
 *
 *  trailing-unrealised — the floor trails the highest ACCOUNT VALUE reached,
 *                        including open profit. Harshest and most common.
 *  trailing-close      — the floor trails the highest CLOSED balance. Open
 *                        profit you give back before exiting costs you nothing,
 *                        which makes runners and scale-outs far cheaper to
 *                        attempt than under the unrealised model.
 *  trailing-eod        — the floor trails the end-of-day closing balance. More
 *                        forgiving still: a green morning and a red afternoon
 *                        only ratchet the floor by the net.
 *  static              — the floor never moves.
 *
 * Breach is always checked against live equity regardless of model. A floor
 * that only updates on closes is not a floor you can trade through intraday.
 *
 * `lockAtProfit`: many trailing programs stop trailing once the account is up
 * by (drawdown + buffer); after that the floor locks, usually at the starting
 * balance plus the buffer.
 */
export const DRAWDOWN_MODELS = ['trailing-unrealised', 'trailing-close', 'trailing-eod', 'static']

/** Template account presets. Confirm against your firm before use. */
export const ACCOUNT_PRESETS = {
  '25K': { startingBalance: 25000, drawdown: 1500, maxContracts: 4, maxMicros: 40, profitTarget: 1500 },
  '50K': { startingBalance: 50000, drawdown: 2500, maxContracts: 10, maxMicros: 100, profitTarget: 3000 },
  '75K': { startingBalance: 75000, drawdown: 2750, maxContracts: 12, maxMicros: 120, profitTarget: 4250 },
  '100K': { startingBalance: 100000, drawdown: 3000, maxContracts: 14, maxMicros: 140, profitTarget: 6000 },
  '150K': { startingBalance: 150000, drawdown: 5000, maxContracts: 17, maxMicros: 170, profitTarget: 9000 },
  '250K': { startingBalance: 250000, drawdown: 6500, maxContracts: 27, maxMicros: 270, profitTarget: 15000 },
  '300K': { startingBalance: 300000, drawdown: 7500, maxContracts: 35, maxMicros: 350, profitTarget: 20000 },
}

/**
 * Account parameters supplied by the account holder rather than taken from a
 * published table. Kept separate from ACCOUNT_PRESETS so it is obvious which
 * numbers came from where — and still worth re-checking against the agreement,
 * since these were entered by hand.
 */
export const USER_ACCOUNTS = {
  'LUCID-FLEX-50K': {
    startingBalance: 50000,
    drawdown: 2000,
    // End-of-day trailing: the floor moves on the closing balance, so a green
    // morning handed back in the afternoon ratchets it only by the net. This is
    // the most forgiving of the trailing variants and it changes sizing
    // materially versus an intraday-unrealised floor.
    drawdownModel: 'trailing-eod',
    // 50% during the evaluation, and none at all once funded.
    consistencyPct: 0.5,
    consistencyAppliesAfterPass: false,
    // Confirmed by the account holder: $3k target, $150 fee, 90% split, and
    // only profit ABOVE $2,100 is withdrawable — the buffer stays in the
    // account. That last rule is the one that sets the size of a payout: at
    // the $3k target the first withdrawal is (3000 - 2100) * 0.9 = $810, not
    // $2,700. The buffer is not lost, it just is not cash yet.
    profitTarget: 3000,
    profitTargetAssumed: false,
    payoutSplit: 0.9,
    withdrawalThreshold: 2100,
    payoutMode: 'buffer',
    evaluationFee: 150,
    maxContracts: 10,
    maxMicros: 100,
  },
}

export const DEFAULT_RULES = {
  drawdownModel: 'trailing-unrealised',
  /** Trailing stops once balance ≥ starting + drawdown + lockBuffer. */
  lockAtProfit: true,
  lockBuffer: 100,
  /** Self-imposed daily loss limit as a fraction of the drawdown allowance. */
  dailyLossLimitPct: 0.3,
  /** Stop trading for the day after this many losses. */
  maxConsecutiveLosses: 2,
  maxTradesPerDay: 5,
  /** Risk per trade as a fraction of the drawdown allowance. */
  riskPerTradePct: 0.1,
  /** Payout consistency: no single day may exceed this share of total profit. */
  consistencyPct: 0.3,
  /** Flatten before the close — most firms require it. */
  flattenByMinuteET: 15 * 60 + 55,
}

/** Resolve a preset name from either the published table or user-supplied set. */
export function accountSpec(name) {
  return ACCOUNT_PRESETS[name] ?? USER_ACCOUNTS[name] ?? null
}

/**
 * A live account: balance, the drawdown floor, and the daily guardrails.
 *
 * Feed it `mark()` on every bar while a position is open (so the trailing floor
 * sees unrealised peaks) and `recordTrade()` when one closes.
 */
export class PropAccount {
  /**
   * @param {{preset?:string, startingBalance?:number, drawdown?:number,
   *          maxContracts?:number, profitTarget?:number, rules?:object,
   *          instrument?:object}} config
   */
  constructor(config = {}) {
    const preset = config.preset ? accountSpec(config.preset) : null
    if (config.preset && !preset) throw new Error(`Unknown account preset: ${config.preset}`)

    this.startingBalance = config.startingBalance ?? preset?.startingBalance ?? 50000
    this.drawdown = config.drawdown ?? preset?.drawdown ?? 2500
    this.maxContracts = config.maxContracts ?? preset?.maxContracts ?? 10
    this.maxMicros = config.maxMicros ?? preset?.maxMicros ?? this.maxContracts * 10
    this.profitTarget = config.profitTarget ?? preset?.profitTarget ?? 3000
    // A preset may carry rule overrides of its own (drawdown model, consistency
    // limit); explicit config.rules still wins over them.
    this.rules = {
      ...DEFAULT_RULES,
      ...(preset?.drawdownModel ? { drawdownModel: preset.drawdownModel } : {}),
      ...(preset?.consistencyPct !== undefined ? { consistencyPct: preset.consistencyPct } : {}),
      ...(preset?.consistencyAppliesAfterPass !== undefined
        ? { consistencyAppliesAfterPass: preset.consistencyAppliesAfterPass }
        : {}),
      ...(config.rules ?? {}),
    }
    this.profitTargetAssumed = preset?.profitTargetAssumed ?? false
    this.payoutSplit = config.payoutSplit ?? preset?.payoutSplit ?? 1
    this.instrument = config.instrument ?? INSTRUMENTS.NQ

    this.balance = this.startingBalance
    /** Highest account value ever seen, including open profit. */
    this.peak = this.startingBalance
    this.floor = this.startingBalance - this.drawdown
    this.floorLocked = false

    this.day = null
    this.dayStartBalance = this.startingBalance
    this.dayPnL = 0
    this.dayTrades = 0
    this.consecutiveLosses = 0
    this.dailyPnL = new Map()
    this.trades = []
    this.breached = false
    this.breachReason = null
    this.passed = false
  }

  /** Dollars of loss available before the account is dead. */
  get room() {
    return this.balance - this.floor
  }

  /** Dollars still allowed to be lost today under the self-imposed limit. */
  get dailyRoom() {
    const limit = this.drawdown * this.rules.dailyLossLimitPct
    return Math.max(0, limit + this.dayPnL)
  }

  /**
   * Record a realised close against the drawdown floor.
   * Only the closed-balance model moves on this event.
   */
  #onRealisedClose() {
    if (this.rules.drawdownModel === 'trailing-close') this.#raiseFloor(this.balance)
  }

  /** Roll the daily counters when the futures trading day changes. */
  startDay(dayKey) {
    if (this.day === dayKey) return
    if (this.day !== null) {
      this.dailyPnL.set(this.day, this.dayPnL)
      // End-of-day trailing programs move the floor on the closing balance.
      if (this.rules.drawdownModel === 'trailing-eod') this.#raiseFloor(this.balance)
    }
    this.day = dayKey
    this.dayStartBalance = this.balance
    this.dayPnL = 0
    this.dayTrades = 0
    this.consecutiveLosses = 0
  }

  /**
   * Mark the account to market. `openPnL` is the unrealised P&L of any live
   * position — this is what makes a trailing-unrealised floor move.
   */
  mark(openPnL = 0) {
    const equity = this.balance + openPnL
    this.peak = Math.max(this.peak, equity)
    if (this.rules.drawdownModel === 'trailing-unrealised') this.#raiseFloor(equity)
    if (equity <= this.floor && !this.breached) {
      this.breached = true
      this.breachReason = `equity ${equity.toFixed(2)} hit the drawdown floor ${this.floor.toFixed(2)}`
    }
    return equity
  }

  #raiseFloor(equity) {
    if (this.floorLocked) return
    const lockLevel = this.startingBalance + this.drawdown + this.rules.lockBuffer
    const candidate = equity - this.drawdown
    if (candidate > this.floor) this.floor = candidate
    if (this.rules.lockAtProfit && this.floor >= this.startingBalance + this.rules.lockBuffer) {
      this.floor = this.startingBalance + this.rules.lockBuffer
      this.floorLocked = true
    }
    if (this.rules.lockAtProfit && equity >= lockLevel) {
      this.floor = this.startingBalance + this.rules.lockBuffer
      this.floorLocked = true
    }
  }

  /**
   * Can a new trade be opened right now?
   * @returns {{allowed:boolean, reason:string|null}}
   */
  canTrade(nowMs, etMinute = null) {
    if (this.breached) return no(`account breached: ${this.breachReason}`)
    if (this.dayTrades >= this.rules.maxTradesPerDay) return no(`daily trade cap (${this.rules.maxTradesPerDay}) reached`)
    if (this.consecutiveLosses >= this.rules.maxConsecutiveLosses) {
      return no(`${this.consecutiveLosses} consecutive losses — done for the day`)
    }
    if (this.dailyRoom <= 0) return no('daily loss limit reached')
    if (this.room <= 0) return no('no drawdown room left')
    // The flatten window is the run-up to the 16:00 ET cash close. It must not
    // swallow the evening — the Asia session opens at 18:00 ET and is one of
    // the better windows for this strategy on NQ.
    if (etMinute !== null && etMinute >= this.rules.flattenByMinuteET && etMinute < 17 * 60) {
      return no('too close to the close')
    }
    return { allowed: true, reason: null }
  }

  /**
   * Record a closed trade.
   * @param {{pnl:number, rMultiple?:number, model?:string, session?:string, t?:number}} trade
   */
  recordTrade(trade) {
    this.balance += trade.pnl
    this.dayPnL += trade.pnl
    this.dayTrades++
    this.consecutiveLosses = trade.pnl < 0 ? this.consecutiveLosses + 1 : 0
    this.trades.push({ ...trade, balanceAfter: this.balance, day: this.day })
    this.#onRealisedClose()
    this.mark(0)
    if (!this.passed && this.balance - this.startingBalance >= this.profitTarget) this.passed = true
    return this
  }

  /**
   * Payout consistency check: is any single day too large a share of total
   * profit? Firms use this to deny payouts even on a green account.
   */
  consistency() {
    const days = [...this.dailyPnL.entries()]
    if (this.day !== null) days.push([this.day, this.dayPnL])
    const totalProfit = days.reduce((a, [, p]) => a + Math.max(0, p), 0)
    if (totalProfit <= 0) return { ok: true, bestDayShare: 0, totalProfit: 0, limit: this.rules.consistencyPct }
    let best = -Infinity
    for (const [, p] of days) if (p > best) best = p
    const share = best / totalProfit
    return {
      ok: share <= this.rules.consistencyPct,
      bestDayShare: share,
      bestDay: days.find(([, p]) => p === best)?.[0] ?? null,
      totalProfit,
      limit: this.rules.consistencyPct,
      note: share > this.rules.consistencyPct
        ? `best day is ${(share * 100).toFixed(1)}% of total profit, above the ${(this.rules.consistencyPct * 100).toFixed(0)}% limit — keep trading to dilute it before requesting a payout`
        : 'within consistency limits',
    }
  }

  snapshot() {
    return {
      balance: this.balance,
      peak: this.peak,
      floor: this.floor,
      floorLocked: this.floorLocked,
      room: this.room,
      dailyRoom: this.dailyRoom,
      dayPnL: this.dayPnL,
      dayTrades: this.dayTrades,
      breached: this.breached,
      breachReason: this.breachReason,
      passed: this.passed,
      profitTarget: this.profitTarget,
      progress: (this.balance - this.startingBalance) / this.profitTarget,
    }
  }
}

const no = (reason) => ({ allowed: false, reason })
