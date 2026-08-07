/**
 * Alert feed.
 *
 * The scanner polls continuously, so the interesting event is not "this stock
 * qualifies" (it will keep qualifying for the next hour) but "this stock just
 * started qualifying". This tracks the transition and keeps a bounded history,
 * mirroring a momentum alert window.
 */

const MAX_ALERTS = 100;
// Once a symbol drops off the qualified list, wait this long before it can
// alert again, so a stock hovering on the threshold does not spam the feed.
const REARM_MS = 10 * 60 * 1000;

export class AlertTracker {
  constructor({ maxAlerts = MAX_ALERTS, rearmMs = REARM_MS } = {}) {
    this.maxAlerts = maxAlerts;
    this.rearmMs = rearmMs;
    this.alerts = [];
    this.lastQualifiedAt = new Map();
  }

  /**
   * Compare a fresh scan against the previous one and return the alerts that
   * fired this round (also appended to the rolling feed).
   */
  ingest(results = [], now = Date.now()) {
    const fired = [];

    for (const result of results) {
      if (!result.qualified) continue;
      const previous = this.lastQualifiedAt.get(result.symbol);
      const isNew = previous === undefined || now - previous > this.rearmMs;
      this.lastQualifiedAt.set(result.symbol, now);
      if (!isNew) continue;

      fired.push({
        id: `${result.symbol}-${now}`,
        symbol: result.symbol,
        name: result.name ?? null,
        price: result.price,
        changeFromClosePct: result.changeFromClosePct,
        relativeVolume: result.relativeVolume,
        float: result.float,
        grade: result.grade,
        headline: result.catalysts?.[0]?.headline ?? null,
        firedAt: new Date(now).toISOString(),
      });
    }

    if (fired.length) {
      this.alerts = [...fired, ...this.alerts].slice(0, this.maxAlerts);
    }

    // Forget symbols that have gone quiet, so the map cannot grow unbounded
    // across a long-running session.
    for (const [symbol, at] of this.lastQualifiedAt) {
      if (now - at > this.rearmMs * 6) this.lastQualifiedAt.delete(symbol);
    }

    return fired;
  }

  list(limit = 50) {
    return this.alerts.slice(0, limit);
  }

  clear() {
    this.alerts = [];
    this.lastQualifiedAt.clear();
  }
}
