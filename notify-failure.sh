#!/usr/bin/env bash
# Turns a failed nq-collect run into something a human actually sees.
#
# Wired in via OnFailure= on nq-collect.service. Before 2026-08-26 there was no
# OnFailure= anywhere: the 2026-08-25 22:47 catch-up run died on DNS, left the
# unit in `failed` state, and nothing surfaced it. The data survived only
# because Yahoo's 7-day window still covered the gap the next morning.
#
# Two channels on purpose — a desktop toast you may miss, and a marker file the
# pre-session report reads, which you cannot.
set -uo pipefail

UNIT=${1:-nq-collect.service}
REPO=/home/valuedcustomer/nq-collect
MARKER=$REPO/.collect-failed
LOG=$REPO/collect.log
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

{
  echo "$STAMP  $UNIT FAILED"
  echo "last lines of collect.log:"
  # collect.log carries ANSI colour; strip it or the marker renders as garbage
  # wherever it is read back (the pre-session brief reads it verbatim).
  tail -6 "$LOG" 2>/dev/null | sed -e 's/\x1b\[[0-9;]*m//g' -e 's/^/    /' 
} > "$MARKER"

# notify-send needs a session bus; a user unit usually has one, but never assume.
if command -v notify-send >/dev/null 2>&1; then
  notify-send -u critical "NQ collection failed" \
    "$UNIT failed at $STAMP. Bars are recoverable for 7 days from Yahoo, then only from Databento." \
    2>/dev/null || true
fi
exit 0
