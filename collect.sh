#!/usr/bin/env bash
# Daily NQ collection. Runs on THIS machine because the cloud routine sandbox
# blocks Yahoo Finance (403 on CONNECT via the egress proxy, verified
# 2026-08-21) while this box reaches it fine (HTTP 200).
#
# Runs in its own clone, NOT in ~/New and NOT in ~/propfirm-mirror:
#   ~/New              is where you work — this must never commit over you
#   ~/propfirm-mirror  runs `git reset --hard` before every local routine, so
#                      anything written there is destroyed
#
# Why daily matters: the forward journal is exactly-once and its value is that
# signals are recorded BEFORE their outcomes are known. Backfilling a week later
# from Databento recovers the bars but destroys that property.
set -uo pipefail

REPO=/home/valuedcustomer/nq-collect
BRANCH=claude/propfirm-trading-system-3z03tj
LOG=$REPO/collect.log
MARKER=$REPO/.collect-failed
STAMP() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say() { echo "[$(STAMP)] $*" >> "$LOG"; }

# node comes from nvm, which lives in .bashrc — a systemd unit sources none of
# that. Resolve it explicitly or this fails with "node: command not found"
# while everything else looks fine.
NODE=$(command -v node || ls -1d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)
[ -x "$NODE" ] || { say "FATAL no node runtime"; exit 1; }

cd "$REPO" || { say "FATAL cannot cd $REPO"; exit 1; }
say "=== start ==="

# Persistent=true means a run missed while the machine was off/asleep fires as
# soon as the user manager is back — which on a resume beats the network by
# anywhere from seconds to minutes. On 2026-08-25 the catch-up run lost that
# race and exited 1 on "Could not resolve host: github.com". Wait for DNS
# instead of treating a cold network as a collection failure.
wait_for_net() {
  local i
  for i in $(seq 1 30); do
    if getent hosts github.com >/dev/null 2>&1; then
      [ "$i" -gt 1 ] && say "network came up after $(( i * 10 ))s"
      return 0
    fi
    sleep 10
  done
  say "ABORT: no DNS for github.com after 300s — network never came up"
  return 1
}
wait_for_net || exit 1

# Take whatever the cloud or your own pushes have added. --ff-only so a
# divergence is a loud failure rather than a silent merge commit.
git fetch -q origin "$BRANCH" 2>>"$LOG"
if ! git merge --ff-only "origin/$BRANCH" >>"$LOG" 2>&1; then
  say "ABORT: local and origin diverged — not auto-merging a journal. Resolve by hand."
  exit 1
fi

cd propfirm || exit 1
say "collect (yahoo 1m 7d)"
# Retried rather than one-shot: the failure that matters is transient (DNS not
# up yet, Yahoo refusing briefly), and the cost of giving up is permanent —
# Yahoo serves a moving 7-day window, so a session lost for a week is gone.
collected=0
for attempt in 1 2 3; do
  if timeout 420 "$NODE" src/cli.js collect --source yahoo --symbol NQ \
        --interval 1m --range 7d >>"$LOG" 2>&1; then
    [ "$attempt" -gt 1 ] && say "collect succeeded on attempt $attempt"
    collected=1
    break
  fi
  say "collect attempt $attempt/3 failed"
  [ "$attempt" -lt 3 ] && sleep $(( attempt * 60 ))
done
if [ "$collected" -ne 1 ]; then
  say "ERROR collect failed after 3 attempts — see above. Bars for missed days are"
  say "      still buyable from Databento (~\$0.01/day, ohlcv-1m) but the forward"
  say "      property is lost."
  exit 1
fi
# Collection is what the marker is about, so clear it here rather than at exit.
rm -f "$MARKER"

say "score"
timeout 300 "$NODE" src/cli.js forward   >>"$LOG" 2>&1
timeout 300 "$NODE" src/cli.js trend     >>"$LOG" 2>&1
# Playbook A. Omitted until 2026-08-26, which left the one component that has
# ever measured positive as the only journal this routine did not score — it had
# silently drifted four sessions behind before anyone noticed.
timeout 300 "$NODE" src/cli.js sweep     --symbol NQ >>"$LOG" 2>&1
timeout 300 "$NODE" src/cli.js overnight --symbol NQ >>"$LOG" 2>&1

cd "$REPO"
if git diff --quiet -- propfirm/data/; then
  say "no new data — nothing to commit"
  say "=== done (no-op) ==="
  exit 0
fi

git add propfirm/data/
git commit -q -m "Collect NQ 1m and score forward journals ($(date -u +%Y-%m-%d))" 2>>"$LOG"
if git push -q origin "$BRANCH" 2>>"$LOG"; then
  say "pushed $(git rev-parse --short HEAD)"
else
  say "PUSH FAILED — commit is local only. Next run will abort on divergence."
fi
say "=== done ==="
