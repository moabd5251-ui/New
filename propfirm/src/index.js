/**
 * Public API.
 *
 * Typical use:
 *
 *   import { Market, TradingSystem, PropAccount, sizePosition } from './src/index.js'
 *
 *   const market = new Market(oneMinuteCandles, { instrument: INSTRUMENTS.NQ })
 *   const system = new TradingSystem()
 *   const { signal, rejected } = system.evaluate(market, market.base.length - 1)
 *   if (signal) console.log(sizePosition({ account, signal }))
 */

export { TF, aggregate, atr, volumeBaseline, parseTimeframe } from './core/candles.js'
export { SESSIONS, MACRO_WINDOWS, sessionOf, inKillzone, macroWindowOf, futuresDayKey, etParts } from './core/sessions.js'
export { analyzeStructure, findSwings, detectBreaks, apexLevels } from './core/structure.js'
export { mapLiquidity, drawOnLiquidity, premiumDiscount, liquidityCycle } from './core/liquidity.js'
export { findFVGs, resolveFVGs, invertedFVGs, detectCISD, detectBreakAndRetest, displacement } from './core/patterns.js'
export { BarOrderflow, FootprintOrderflow, volumeProfile, rollingPOC, vwap, cvd, detectAbsorption } from './core/orderflow.js'

export { Market } from './data/market.js'
export { loadCandles, parseCSV, writeCandles } from './data/csv.js'
export { generateSeries, generateFootprint } from './data/synthetic.js'
export { fetchYahoo, parseYahooChart, YAHOO_SYMBOLS, YAHOO_LIMITS } from './data/providers/yahoo.js'
export { fetchTradier, tradierQuote, TRADIER_INTERVALS } from './data/providers/tradier.js'
export { auditSeries, formatAudit } from './data/quality.js'

export { readContext } from './engine/context.js'
export { readConfirmation } from './engine/confirmation.js'
export { readTrigger } from './engine/trigger.js'
export { orderflowGate } from './engine/gate.js'
export { scoreSetup, withMeasuredExpectancy, GRADE_THRESHOLDS } from './engine/confluence.js'
export { TradingSystem, DEFAULT_CONFIG, buildTargets } from './engine/system.js'

export { PropAccount, INSTRUMENTS, ACCOUNT_PRESETS, DEFAULT_RULES, equityInstrument } from './risk/propfirm.js'
export { sizePosition, roundToTick, toTicks, dollarsFor } from './risk/sizing.js'
export { PositionManager, DEFAULT_MANAGEMENT } from './risk/management.js'
export { simulateEvaluation, monteCarlo, riskCurve, requiredEdge } from './risk/survival.js'

export { Journal } from './journal/journal.js'
export { buildStats, recommendations } from './journal/stats.js'
export { backtest } from './backtest/backtest.js'
export { renderReport } from './report/html.js'
