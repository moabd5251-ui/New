#!/usr/bin/env bash
# Pre-session bias check, run inside the killzone rather than hours after it.
#
# Playbook B's window was 07:00-10:00 ET (v1); as of spec v2 it is 11:30-14:30 ET
# = 08:30-11:30 PT. It is read from the spec below, never hardcoded. Previously the
# window had already closed. Twice in one week the bias was only read once it
# could no longer be acted on.
#
# Deliberately quiet: a NO TRADE day notifies NOTHING. Roughly half of recent
# sessions came back NO TRADE, and an alert that fires on those trains you to
# ignore it. Only a tradeable bias is worth waking someone for.
set -uo pipefail
REPO=/home/valuedcustomer/nq-collect
LOG=$REPO/bias-alert.log
STAMP() { TZ=America/New_York date +%Y-%m-%dT%H:%M:%S%z; }
say() { echo "[$(STAMP)] $*" >> "$LOG"; }

NODE=$(command -v node || ls -1d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)
[ -x "$NODE" ] || { say "FATAL no node runtime"; exit 1; }

OUT=$("$NODE" "$REPO/bias.mjs" 2>&1)
echo "$OUT" >> "$LOG"

if grep -q "NO TRADE TODAY" <<<"$OUT"; then
  WHY=$(grep -A1 "NO TRADE TODAY" <<<"$OUT" | tail -1 | sed 's/^ *//')
  say "quiet: NO TRADE — $WHY"
  exit 0
fi

DIR=$(grep -oE "BIAS: (LONG|SHORT) ONLY" <<<"$OUT" | head -1)
[ -n "$DIR" ] || { say "could not parse a bias — see output above"; exit 1; }
# State the window honestly rather than always claiming it is open. A manual or
# late run otherwise produces a marker that says OPEN hours after it closed —
# the same stale-text failure that made the GLD 421.82 alert misleading.
# Window read from the spec, not hardcoded, so a spec change cannot leave this
# script announcing a window the engine no longer uses.
KZ=$(node -e "import('/home/valuedcustomer/nq-collect/propfirm/src/research/trendcont.js').then(m=>{const S=m.TRENDCONT_SPEC;console.log(S.killzoneStart,S.killzoneEnd,S.version)})")
KZSTART=$(awk '{print $1}' <<<"$KZ"); KZEND=$(awk '{print $2}' <<<"$KZ"); KZVER=$(awk '{print $3}' <<<"$KZ")
hhmm(){ printf '%02d:%02d' $(( $1/60 )) $(( $1%60 )); }
ETMIN=$(( 10#$(TZ=America/New_York date +%H) * 60 + 10#$(TZ=America/New_York date +%M) ))
if   [ "$ETMIN" -lt "$KZSTART" ]; then WIN="opens in $(( KZSTART-ETMIN )) min"
elif [ "$ETMIN" -lt "$KZEND" ];   then WIN="OPEN, $(( KZEND-ETMIN )) min left"
else WIN="CLOSED $(( ETMIN-KZEND )) min ago — no Playbook B entry today"; fi
MSG="NQ Playbook B (spec v$KZVER): $DIR. Killzone $(hhmm $KZSTART)-$(hhmm $KZEND) ET $WIN. NOTHING MEASURED ON THIS WINDOW."
say "TRADEABLE — $DIR"

# Every channel we have, because the desktop one is not guaranteed to exist:
# notify-send is not installed on this box (verified 2026-08-27), so it is
# attempted but must never be the only path.
command -v notify-send >/dev/null 2>&1 && notify-send -u critical "NQ bias" "$MSG" 2>/dev/null || true
command -v wall        >/dev/null 2>&1 && wall "$MSG" 2>/dev/null || true
printf '%s\n%s\n' "$(STAMP)" "$MSG" > "$REPO/.bias-tradeable"
