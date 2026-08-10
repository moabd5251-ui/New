/**
 * Trade management.
 *
 * The orderflow that got you in is also what gets you out. A position is held
 * while the reason for it is still true, and closed when it stops being true —
 * not when a fixed number of points has been reached.
 *
 * The rules encoded here, in the order they are checked each bar:
 *
 *   1. Hard stop — invalidation hit.
 *   2. Adverse close — price closes back past 50% of the stop distance. The
 *      trade is wrong early; cut it rather than donating the rest.
 *   3. Orderflow flip — the point of control flips against the position, or
 *      sustained delta turns against it. This is the "I don't like the volume
 *      right now" exit, and it is the difference between a breakeven and a
 *      full stop-out.
 *   4. Targets — scale at T1, run the remainder.
 *   5. Breakeven / trail — once T1 is banked or the POC has moved behind the
 *      position, protect it.
 *   6. Session flatten — out before the close.
 */

import { etMinuteOfDay } from '../core/sessions.js'

export const DEFAULT_MANAGEMENT = {
  /** Close if a bar CLOSES this far back into the stop distance. */
  adverseCloseFraction: 0.5,
  /** Move to breakeven once this many R of open profit is reached. */
  breakevenAtR: 1,
  /** Exit on sustained opposing delta once open profit exceeds this R. */
  orderflowExitMinR: 0.3,
  /** Bars of opposing delta required before the orderflow exit fires. */
  opposingDeltaBars: 3,
  /** Trail the stop behind the session POC once in profit. */
  trailBehindPOC: true,
  /** Extra clearance when trailing behind a level, in points. */
  trailBufferPoints: 2,
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
        this.position.stop = this.position.entry
        this.movedToBreakeven = true
        actions.push({ type: 'stop-moved', price: this.position.entry, reason: 'first target banked' })
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

    // ── 3. Orderflow deterioration.
    if (flow) {
      const openR = this.rAt(bar.c)
      const deltaAgainst = this.long ? flow.delta < 0 : flow.delta > 0
      this.opposingDeltaStreak = deltaAgainst ? this.opposingDeltaStreak + 1 : 0

      const pocAgainst = flow.pocFlip && (this.long ? flow.pocFlip.direction === 'down' : flow.pocFlip.direction === 'up')
      if (pocAgainst && openR > 0) {
        return this.#close(bar.c, 'point of control flipped against the position', actions)
      }
      if (this.opposingDeltaStreak >= this.cfg.opposingDeltaBars && openR >= this.cfg.orderflowExitMinR) {
        return this.#close(bar.c, `${this.opposingDeltaStreak} bars of opposing aggression — taking what is there`, actions)
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
    }

    // ── 5b. Breakeven on R alone.
    if (!this.movedToBreakeven && this.rAt(bar.c) >= this.cfg.breakevenAtR) {
      this.position.stop = this.position.entry
      this.movedToBreakeven = true
      actions.push({ type: 'stop-moved', price: this.position.entry, reason: `${this.cfg.breakevenAtR}R reached` })
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
