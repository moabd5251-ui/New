/**
 * The trade journal.
 *
 * This is not paperwork. The grading in `confluence.js` is only meaningful if
 * the weights come from measured results, and the only source of those results
 * is a journal that records WHY each trade was taken — which model, which
 * session, which confluences were present, what the orderflow said — not just
 * the P&L.
 *
 * Storage is append-only JSONL: survives crashes, diffs cleanly, and never
 * rewrites history. Every entry keeps the full setup snapshot so a losing
 * pattern can be found later rather than remembered incorrectly.
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { futuresDayKey, sessionOf } from '../core/sessions.js'

/**
 * @typedef {Object} JournalEntry
 * @property {string} id
 * @property {number} entryTime
 * @property {number} exitTime
 * @property {'long'|'short'} direction
 * @property {string} model
 * @property {string} session
 * @property {string} grade
 * @property {number} entry
 * @property {number} exit
 * @property {number} stop
 * @property {number} contracts
 * @property {string} symbol
 * @property {number} pnl        dollars
 * @property {number} rMultiple
 * @property {string} exitReason
 * @property {string[]} reasons  the confluences present at entry
 * @property {string[]} conflicts
 * @property {boolean} orderflowIsProxy
 * @property {string} [review]   free-text, filled in after the fact
 * @property {string[]} [mistakes]
 */

export class Journal {
  /** @param {string|null} path JSONL file; null keeps the journal in memory. */
  constructor(path = null) {
    this.path = path
    this.entries = []
    if (path && existsSync(path)) this.load()
  }

  load() {
    const text = readFileSync(this.path, 'utf8')
    this.entries = text
      .split('\n')
      .filter((l) => l.trim())
      .map((l, i) => {
        try {
          return JSON.parse(l)
        } catch {
          throw new Error(`${this.path}: malformed JSON on line ${i + 1}`)
        }
      })
    return this.entries
  }

  /**
   * Record a closed trade.
   * @param {Partial<JournalEntry>} trade
   */
  add(trade) {
    const entry = {
      id: trade.id ?? `${trade.entryTime}-${trade.model ?? 'manual'}-${this.entries.length}`,
      day: futuresDayKey(trade.entryTime),
      session: trade.session ?? sessionOf(trade.entryTime),
      hourET: new Date(trade.entryTime).toISOString(),
      ...trade,
    }
    // Derive the R multiple when it was not supplied — the primary unit of
    // account here is R, not dollars, so it must never be missing.
    if (entry.rMultiple === undefined && entry.entry != null && entry.stop != null && entry.exit != null) {
      const risk = Math.abs(entry.entry - entry.stop)
      const move = entry.direction === 'long' ? entry.exit - entry.entry : entry.entry - entry.exit
      entry.rMultiple = risk > 0 ? move / risk : 0
    }
    this.entries.push(entry)
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true })
      appendFileSync(this.path, JSON.stringify(entry) + '\n')
    }
    return entry
  }

  /** Attach a post-trade review to an existing entry (in memory + appended). */
  review(id, { review, mistakes = [], followedPlan = null }) {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry) throw new Error(`No journal entry with id ${id}`)
    Object.assign(entry, { review, mistakes, followedPlan, reviewedAt: Date.now() })
    if (this.path) appendFileSync(this.path, JSON.stringify({ ...entry, _revision: true }) + '\n')
    return entry
  }

  filter(predicate) {
    return this.entries.filter(predicate)
  }

  byDay(day) {
    return this.entries.filter((e) => e.day === day)
  }

  /** Entries with the latest revision of each id winning. */
  resolved() {
    const byId = new Map()
    for (const e of this.entries) byId.set(e.id, { ...(byId.get(e.id) ?? {}), ...e })
    return [...byId.values()].sort((a, b) => a.entryTime - b.entryTime)
  }
}
