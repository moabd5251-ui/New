/**
 * Trade management.
 *
 * The orderflow that got you in is also what gets you out. A position is held
 * while the reason for it is still true, and closed when it stops being true —
 * not when a fixed number of points has been reached.
 *
 * ── Why deterioration tightens instead of closing ───────────────────────────
 * The first version of this closed a position whenever the orderflow turned:
 * three bars of opposing delta, or the point of control flipping against it.
 * Measured over three months of real aggressor data, that was the single
 * biggest fault in the system. Winners averaged 0.85R against ~2R targets, and
 * of nineteen winners only eight reached a target — seven were closed by the
 * opposing-delta rule and four at breakeven, after an average of nine bars.
 * Losers, meanwhile, still ran the full distance to the stop at -1.26R. The
 * exits were asymmetric in exactly the wrong direction: quick to give up on
 * winners, patient with losers.
 *
 * Three bars of opposing delta on a 1-minute chart is noise, and the source
 * material's version of this judgement is a human watching a live tape decide
 * whether deterioration is real. A mechanical rule cannot make that call, so it
 * should not be allowed to end trades — only to demand more protection.
 *
 * So deterioration now moves the stop up behind price. If the move was real,
 * the trade survives and keeps running; if it was not, the tightened stop takes
 * it out at a better price than the original invalidation. Only price closes a
 * position.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The rules encoded here, in the order they are checked each bar:
 *
 *   1. Hard stop — invalidation hit.
 *   2. Adverse close — price closes back past 50% of the stop distance. Kept as
 *      a close, because it demonstrably helps: those exits average -0.88R
 *      against -1.26R for trades left to hit the stop.
 *   3. Targets — scale at T1, run the remainder.
 *   4. Deterioration — orderflow turning against the position TIGHTENS the stop.
 *   5. Breakeven / volatility trail — protect a runner without capping it.
 *   6. Session flatten — out before the close.
 */

import { etMinuteOfDay } from '../core/sessions.js'

export const DEFAULT_MANAGEMENT = {
  /** Close if a bar CLOSES this far back into the stop distance. */
  adverseCloseFraction: 0.5,
  /**
   * Move to breakeven once this many R of open profit is reached. Deliberately
   * beyond 1R: a stop parked at entry the moment a trade reaches 1R converts
   * ordinary retracement into a scratch, and did so for four of nineteen
   * winners in the measured sample.
   */
  breakevenAtR: 1.5,
  /**
   * What deterioration does. 'tighten' pulls the stop up behind price;
   * 'close' exits immediately, which is the old behaviour and is kept only so
   * the two can be compared.
   */
  orderflowAction: 'tighten',
  /** Open profit required before deterioration is acted on at all. */
  orderflowExitMinR: 0.3,
  /** Bars of opposing delta before deterioration counts as real. */
  opposingDeltaBars: 5,
  /** Where a tightened stop lands, as a fraction of the way from stop to price. */
  tightenFraction: 0.5,
  /** Trail the stop behind the session POC once in profit. */
  trailBehindPOC: true,
  /** Extra clearance when trailing behind a level, in points. */
  trailBufferPoints: 2,
  /**
   * Volatility trail: once past breakeven, the stop follows the best price
   * reached by this multiple of ATR. Wide enough to sit outside normal noise,
   * which is the whole point — it should only be hit when the move is over.
   */
  trailAtrMultiple: 2.5,
  /** Hard time stop: bars a scalp is allowed to stay open. */
  maxBarsInTrade: 120,
  /** Flatten at this ET minute regardless. */
  flattenByMinuteET: 15 * 60 + 55,
}

/**
 * @typedef {Object} ManagedPosition
 * @property {'long'|'short'} direction
 * @property {number} entry
 * @property {number} stop
 * @property {number} contracts
 * @property {object[]} targets
 */

export class PositionManager {
  /**
   * @param {ManagedPosition} position
   * @param {object} [config]
   */
  constructor(position, config = {}) {
    this.cfg = { ...DEFAULT_MANAGEMENT, ...config }
    this.position = { ...position }
    this.initialStop = position.stop
    this.initialRisk = Math.abs(position.entry - position.stop)
    this.remaining = position.contracts
    this.barsHeld = 0
    this.opposingDeltaStreak = 0
    this.movedToBreakeven = false
    this.filledTargets = []
    this.events = []
    this.closed = false
    this.exitReason = null
    // Best price reached since entry, for the volatility trail.
    this.extreme = position.entry
  }

  get long() {
    return this.position.direction === 'long'
  }

  /** Open R multiple at a given price. */
  rAt(price) {
    const move = this.long ? price - this.position.entry : this.position.entry - price
    return this.initialRisk > 0 ? move / this.initialRisk : 0
  }

  /**
   * Advance one bar.
   *
   * @param {import('../core/candles.js').Candle} bar
   * @param {object|null} flow orderflow snapshot for this bar (BarOrderflow.at)
   * @returns {{actions:object[], closed:boolean, exitPrice:number|null, exitReason:string|null}}
   */
  update(bar, flow = null) {
    const actions = []
    if (this.closed) return { actions, closed: true, exitPrice: null, exitReason: this.exitReason }
    this.barsHeld++

    // ── 1. Hard stop. Checked first and assumed to fill at the stop price.
    // Where a bar touches both the stop and a target, the stop is taken —
    // the pessimistic assumption is the only safe one without tick data.
    const stopHit = this.long ? bar.l <= this.position.stop : bar.h >= this.position.stop
    if (stopHit) return this.#close(this.position.stop, this.movedToBreakeven ? 'stopped at breakeven' : 'stop loss', actions)

    // ── 4. Targets (checked before discretionary exits so a clean target fill
    // is not pre-empted by a noisy delta reading on the same bar).
    for (const t of this.position.targets) {
      if (this.filledTargets.includes(t.label)) continue
      const hit = this.long ? bar.h >= t.price : bar.l <= t.price
      if (!hit) continue
      this.filledTargets.push(t.label)
      const size = Math.min(this.remaining, t.contracts ?? Math.round(this.position.contracts * (t.size ?? 1)))
      this.remaining -= size
      actions.push({ type: 'scale-out', price: t.price, contracts: size, label: t.label, r: t.r })
      this.events.push({ bar: this.barsHeld, ...actions.at(-1) })
      if (this.remaining <= 0) return this.#close(t.price, `target ${t.label}`, actions)
      // First scale banked — the rest rides risk-free.
      if (!this.movedToBreakeven) {
        this.movedToBreakeven = true
        if (this.#tighterThanCurrent(this.position.entry)) {
          this.position.stop = this.position.entry
          actions.push({ type: 'stop-moved', price: this.position.entry, reason: 'first target banked' })
        }
      }
    }

    // ── 2. Adverse close: a close back inside half the stop distance.
    const adverseLevel = this.long
      ? this.position.entry - this.initialRisk * this.cfg.adverseCloseFraction
      : this.position.entry + this.initialRisk * this.cfg.adverseCloseFraction
    const closedAdverse = this.long ? bar.c <= adverseLevel : bar.c >= adverseLevel
    if (closedAdverse && !this.movedToBreakeven) {
      return this.#close(bar.c, `closed back through ${(this.cfg.adverseCloseFraction * 100).toFixed(0)}% of the stop — cutting it short`, actions)
    }

    // Track the best price seen, which the volatility trail hangs off.
    this.extreme = this.long ? Math.max(this.extreme, bar.h) : Math.min(this.extreme, bar.l)

    // ── 4. Orderflow deterioration — tighten, do not close.
    if (flow) {
      const openR = this.rAt(bar.c)
      const deltaAgainst = this.long ? flow.delta < 0 : flow.delta > 0
      this.opposingDeltaStreak = deltaAgainst ? this.opposingDeltaStreak + 1 : 0

      const pocAgainst = flow.pocFlip && (this.long ? flow.pocFlip.direction === 'down' : flow.pocFlip.direction === 'up')
      const sustainedAgainst = this.opposingDeltaStreak >= this.cfg.opposingDeltaBars
      const deteriorating = (pocAgainst || sustainedAgainst) && openR >= this.cfg.orderflowExitMinR

      if (deteriorating) {
        const why = pocAgainst
          ? 'point of control flipped against the position'
          : `${this.opposingDeltaStreak} bars of opposing aggression`
        if (this.cfg.orderflowAction === 'close') {
          return this.#close(bar.c, `${why} — taking what is there`, actions)
        }
        // Pull the stop part of the way from where it is to current price. The
        // trade keeps its upside; it just has less room to give back.
        const candidate = this.position.stop + (bar.c - this.position.stop) * this.cfg.tightenFraction
        const better = this.long ? candidate > this.position.stop : candidate < this.position.stop
        if (better) {
          this.position.stop = candidate
          actions.push({ type: 'stop-moved', price: candidate, reason: `${why} — tightening` })
        }
      }

      // ── 5. Trail behind the point of control once it sits behind us.
      if (this.cfg.trailBehindPOC && Number.isFinite(flow.poc) && openR >= this.cfg.breakevenAtR) {
        const buffer = this.cfg.trailBufferPoints
        const candidate = this.long ? flow.poc - buffer : flow.poc + buffer
        const behindUs = this.long ? candidate < bar.c : candidate > bar.c
        const better = this.long ? candidate > this.position.stop : candidate < this.position.stop
        if (behindUs && better) {
          this.position.stop = candidate
          actions.push({ type: 'stop-moved', price: candidate, reason: 'trailing behind the point of control' })
        }
      }

      // ── 5b. Volatility trail on the runner.
      const atrNow = flow.atr
      if (Number.isFinite(atrNow) && atrNow > 0 && this.rAt(bar.c) >= this.cfg.breakevenAtR) {
        const gap = atrNow * this.cfg.trailAtrMultiple
        const candidate = this.long ? this.extreme - gap : this.extreme + gap
        const better = this.long ? candidate > this.position.stop : candidate < this.position.stop
        const behindUs = this.long ? candidate < bar.c : candidate > bar.c
        if (better && behindUs) {
          this.position.stop = candidate
          actions.push({ type: 'stop-moved', price: candidate, reason: `trailing ${this.cfg.trailAtrMultiple}x ATR behind the high` })
        }
      }
    }

    // ── 5c. Breakeven on R alone.
    if (!this.movedToBreakeven && this.rAt(bar.c) >= this.cfg.breakevenAtR) {
      this.movedToBreakeven = true
      // Only if it is an improvement. A trail that has already climbed past
      // entry must not be dragged back down to it — moving a stop backwards is
      // never protection, and doing exactly that was silently undoing the
      // volatility trail on every winner that reached breakeven.
      if (this.#tighterThanCurrent(this.position.entry)) {
        this.position.stop = this.position.entry
        actions.push({ type: 'stop-moved', price: this.position.entry, reason: `${this.cfg.breakevenAtR}R reached` })
      }
    }

    // ── 6. Time and session limits.
    if (this.barsHeld >= this.cfg.maxBarsInTrade) {
      return this.#close(bar.c, 'time stop — a scalp that has not worked is not working', actions)
    }
    const minute = etMinuteOfDay(bar.t)
    if (minute >= this.cfg.flattenByMinuteET && minute < 17 * 60) {
      return this.#close(bar.c, 'flattening before the close', actions)
    }

    return { actions, closed: false, exitPrice: null, exitReason: null }
  }

  /** Would this price be a tighter stop than the one currently set? */
  #tighterThanCurrent(price) {
    return this.long ? price > this.position.stop : price < this.position.stop
  }

  #close(price, reason, actions) {
    this.closed = true
    this.exitReason = reason
    const contracts = this.remaining
    this.remaining = 0
    actions.push({ type: 'exit', price, contracts, reason })
    this.events.push({ bar: this.barsHeld, ...actions.at(-1) })
    return { actions, closed: true, exitPrice: price, exitReason: reason }
  }
}
