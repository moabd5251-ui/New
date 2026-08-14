"""Forward-test the zero-DTE read: record the call, then score it against the close.

A backtest of this would be built on the same chains the rules were designed against,
and the magnet ranking has already been rewritten once because its first version simply
rediscovered spot. Rules tuned to a chain and then tested on that chain are not evidence.
A forward log cannot be fitted after the fact: the prediction is written down before the
outcome exists.

Three claims are scored, each against a benchmark, because "price closed near max pain"
means nothing on its own — the level sits close to spot most days, so it is right by
accident constantly. What matters is whether it beats the naive alternative.

  MAX PAIN     did the close move TOWARD max pain from the open? Benchmark: a coin
               flip. Being near it is not the claim; being drawn to it is.
  REGIME       was realised range smaller on long-gamma days than short-gamma ones?
               This is the most mechanical claim and the one most likely to hold.
  EXPECTED     did the day's move stay inside the ATM straddle? A straddle is roughly
               fair when this happens about two-thirds of the time.

A fourth claim, MAGNET — did the close land nearer the top magnet than the open did —
was cut on 14 Aug 2026 after 12 scored sessions. It came back 1-for-12, or 8.3%,
against a 50% coin-flip benchmark. That is not a weak result awaiting more data: a
metric that far below its benchmark is either measuring the opposite of what it claims
or measuring nothing, and neither is worth another thirty sessions to confirm. The
magnet LEVELS remain on the dashboard, because large open-interest strikes are still
worth seeing; what was withdrawn is the claim that price is drawn toward them.

Entries scored before that date keep their magnet fields. The point of a forward log is
that it cannot be rewritten after the outcome is known, and that applies to the results
that go against the strategy as much as the ones that flatter it.

Scoring compares OPEN to CLOSE, not the reading's spot to close, because the read is
taken intraday and using its own spot would credit the move that had already happened.
"""
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOG = ROOT / "data" / "zerodte_log.json"


def load():
    if LOG.exists():
        try:
            return json.loads(LOG.read_text() or "[]")
        except json.JSONDecodeError:
            pass
    return []


def save(rows):
    LOG.parent.mkdir(parents=True, exist_ok=True)
    LOG.write_text(json.dumps(rows, indent=2, default=str))


def record(a, session_open=None):
    """Write today's call. Returns the entry, or None when one already exists."""
    if a.get("error"):
        return None
    rows = load()
    key = (a["symbol"], a["expiry"])
    prior = next((r for r in rows if (r["symbol"], r["expiry"]) == key), None)
    if prior is not None:
        # The CLAIM is fixed at the first read — max pain and expected move are
        # the prediction, and letting a later capture revise them would be marking your
        # own homework. The REGIME is not a claim, it is a condition that holds during
        # the day, and it moves: on 11 Aug SPY and QQQ were +1.73bn and +0.29bn at 15:35
        # and -2.57bn and -0.91bn by the close. Both then ran about twice their expected
        # move while IWM, which stayed long gamma throughout, moved 0.02%. Scoring all
        # three as "long" would have filed two amplifying days in the damping bucket and
        # buried the one relationship in this study that is actually behaving.
        if not prior.get("scored"):
            g = a.get("total_gex") or 0
            prior["regime_last"] = "long" if g > 0 else "short"
            prior["gex_last"] = g
            prior["regime_flipped"] = prior["regime_last"] != prior.get("regime")
            prior["regime_last_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            save(rows)
        return None                      # one call per symbol per expiry
    entry = dict(
        symbol=a["symbol"], expiry=a["expiry"],
        recorded_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        spot_at_read=a["spot"], session_open=session_open,
        max_pain=a.get("max_pain"), zero_gamma=a.get("zero_gamma"),
        total_gex=a.get("total_gex"),
        regime=("long" if (a.get("total_gex") or 0) > 0 else "short"),
        straddle=a.get("straddle"), expected_move_pct=a.get("expected_move_pct"),
        flow_bias=(a.get("flow") or {}).get("bias"),
        flow_ratio=(a.get("flow") or {}).get("ratio"),
        close=None, scored=False)
    rows.append(entry)
    save(rows)
    return entry


def score(symbol, expiry, close, day_open=None, day_high=None, day_low=None):
    """Attach the outcome to a recorded call and grade it."""
    rows = load()
    hit = next((r for r in rows if r["symbol"] == symbol and r["expiry"] == expiry), None)
    if hit is None or hit.get("scored"):
        return None
    o = day_open if day_open is not None else hit.get("session_open")
    hit["close"] = close
    hit["day_open"], hit["day_high"], hit["day_low"] = day_open, day_high, day_low

    mp = hit.get("max_pain")
    if mp is not None and o is not None:
        # Did the close end nearer max pain than the open was? Distance, not direction,
        # so a day that overshoots through the level does not count as a hit.
        hit["maxpain_moved_toward"] = abs(close - mp) < abs(o - mp)
        hit["maxpain_dist_open"] = round(abs(o - mp), 2)
        hit["maxpain_dist_close"] = round(abs(close - mp), 2)

    if o:
        hit["realised_move_pct"] = round(abs(close - o) / o * 100, 3)
        if day_high is not None and day_low is not None:
            hit["realised_range_pct"] = round((day_high - day_low) / o * 100, 3)
        em = hit.get("expected_move_pct")
        if em:
            hit["inside_expected"] = hit["realised_move_pct"] <= em

    hit["scored"] = True
    save(rows)
    return hit


def summary():
    """Tally the scored calls, each against its benchmark."""
    rows = [r for r in load() if r.get("scored")]
    if not rows:
        return dict(n=0, note="nothing scored yet")

    def rate(key):
        v = [r[key] for r in rows if r.get(key) is not None]
        return (round(sum(1 for x in v if x) / len(v) * 100, 1), len(v)) if v else (None, 0)

    mp_rate, mp_n = rate("maxpain_moved_toward")
    ie_rate, ie_n = rate("inside_expected")

    # Prefer the last observed regime over the first. A day is classified by the state
    # dealers were actually in as it played out, not by a label frozen at the first read.
    def regime_of(r):
        return r.get("regime_last") or r.get("regime")

    lng = [r["realised_range_pct"] for r in rows
           if regime_of(r) == "long" and r.get("realised_range_pct") is not None]
    sht = [r["realised_range_pct"] for r in rows
           if regime_of(r) == "short" and r.get("realised_range_pct") is not None]
    flipped = sum(1 for r in rows if r.get("regime_flipped"))
    mean = lambda x: round(sum(x) / len(x), 3) if x else None

    return dict(
        n=len(rows),
        maxpain_toward_pct=mp_rate, maxpain_n=mp_n,
        inside_expected_pct=ie_rate, inside_expected_n=ie_n,
        long_gamma_range_pct=mean(lng), long_gamma_n=len(lng),
        short_gamma_range_pct=mean(sht), short_gamma_n=len(sht),
        note=("Benchmarks: max pain wants to beat 50% — a coin flip on whether "
              "the close ended nearer than the open. Inside-expected wants roughly 65%, "
              "which is where a straddle is fairly priced. The regime claim wants "
              "long-gamma days to show a SMALLER average range than short-gamma days. "
              "Nothing below is meaningful under about 30 sessions."))
