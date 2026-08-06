"""Re-price an open vertical spread against the live chain, and detect milestone events."""
import time
from datetime import datetime, timezone
import opt_lib as O


def mark_spread(pos):
    """Return current mid value of the spread (per-share) or None if it can't be priced."""
    ch = O.chain(pos["symbol"])
    spot = ch["quote"]["regularMarketPrice"]
    # find the expiry matching this position
    want = pos["expiry"]
    target_ts = None
    for ts in ch["expirationDates"]:
        if datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d") == want:
            target_ts = ts
            break
    if target_ts is None:
        return None, spot, None
    time.sleep(0.3)
    full = O.chain(pos["symbol"], target_ts)
    kind = "calls" if "CALL" in pos["structure"] else "puts"
    legs = {round(float(o["strike"]), 4): o for o in full["options"][0][kind]}
    lo = legs.get(round(float(pos["long_strike"]), 4))
    sh = legs.get(round(float(pos["short_strike"]), 4))
    if not lo or not sh:
        return None, spot, None
    def mid(o):
        b, a = o.get("bid") or 0, o.get("ask") or 0
        if b > 0 and a > 0:
            return (b + a) / 2
        return o.get("lastPrice") or 0
    value = mid(lo) - mid(sh)          # long leg minus short leg = current spread value
    dte = (datetime.fromtimestamp(target_ts, timezone.utc) - datetime.now(timezone.utc)).days
    return value, spot, dte


def evaluate(pos):
    """Mark the position and return (updated_pos, [event strings])."""
    events = []
    try:
        value, spot, dte = mark_spread(pos)
    except Exception as e:
        pos["mark_error"] = str(e)[:80]
        return pos, events
    if value is None:
        pos["mark_error"] = "contracts not found in live chain"
        return pos, events

    pos.pop("mark_error", None)
    debit = "DEBIT" in pos["structure"]
    entry = pos["net"]                                   # premium paid (debit) or received (credit)
    max_p, max_l = pos["max_profit"], pos["max_loss"]

    # P&L per spread, in dollars
    pnl = (value - entry) * 100 if debit else (entry - value) * 100
    pct_of_max = (pnl / (max_p * 100) * 100) if max_p > 0 else 0

    pos.update(spot=round(spot, 2), mark=round(value, 2), dte=dte,
               pnl=round(pnl, 2), pct_of_max=round(pct_of_max, 1),
               marked_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))

    fired = set(pos.get("fired", []))
    sym, struct = pos["symbol"], ("call" if "CALL" in pos["structure"] else "put")

    # milestone: half of maximum profit captured
    if pct_of_max >= 50 and "half_profit" not in fired:
        fired.add("half_profit")
        events.append(f"{sym} +{pct_of_max:.0f}% of max profit (${pnl:.0f}) — consider taking half off")

    # milestone: underlying crossed the breakeven, in the favourable direction
    be = pos["breakeven"]
    crossed = (spot > be) if struct == "call" else (spot < be)
    if crossed and "breakeven" not in fired:
        fired.add("breakeven")
        events.append(f"{sym} crossed breakeven {be} — spot {spot:.2f}, now profitable at expiry")
    if not crossed and "breakeven" in fired and "lost_be" not in fired:
        fired.add("lost_be")
        events.append(f"{sym} fell back through breakeven {be} — spot {spot:.2f}")

    # risk: half the premium gone
    if pnl <= -(max_l * 100) * 0.5 and "half_loss" not in fired:
        fired.add("half_loss")
        events.append(f"{sym} down ${abs(pnl):.0f}, half of max risk — review or close")

    # time: decay window
    if dte is not None and dte <= 7 and "expiry_soon" not in fired:
        fired.add("expiry_soon")
        events.append(f"{sym} {dte}d to expiry — gamma risk rising, close or roll")

    if dte is not None and dte <= 0:
        pos["status"] = "expired"
        events.append(f"{sym} expired — final P&L ${pnl:.0f}")

    pos["fired"] = sorted(fired)
    return pos, events
