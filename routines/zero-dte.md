Zero-DTE positioning run. Fresh session, no prior context — everything below is self-contained.

Repo: moabd5251-ui/New, branch claude/remove-fable-5-auwiw2. Work only there.

STEP 0 — Get the code and its state.
If a checkout of moabd5251-ui/New is already present, cd into it and run:
  git fetch origin claude/remove-fable-5-auwiw2 && git checkout claude/remove-fable-5-auwiw2 && git pull origin claude/remove-fable-5-auwiw2
If there is no checkout, clone it: git clone -b claude/remove-fable-5-auwiw2 https://github.com/moabd5251-ui/New
Everything below runs from the repository root. Python 3 with the repo's deps is expected.

STEP 1 — Run: python3 scripts/run_zerodte.py
It scores any logged calls whose close now exists, captures the 26-ticker universe, records forward-log entries for SPY/QQQ/IWM when they carry a true same-day expiry, and rewrites zerodte.html. If it prints a `[guard]` line the session is not REGULAR — let it finish (the capture still has value, the log entry is correctly skipped) and send nothing.

STEP 2 — Republish to the existing URL. Passing `url` is REQUIRED — without it a new URL is minted and the user's link goes stale. If the publish is refused because the live version was not viewed, read the artifact at that URL first, confirm the regenerated page is the same generator's output with newer numbers, then publish again.
    zerodte.html -> https://claude.ai/code/artifact/fef15c68-bd90-478b-a5c7-cfca3d964a1c  favicon ⚡

STEP 3 — Commit and push:
    git push -u origin claude/remove-fable-5-auwiw2
The forward log under data/ is the record and must be committed when it changes. If nothing changed, say so briefly and make no empty commit.

STEP 4 — Send ONE PushNotification only on the last run of the day (UTC hour >= 19), one line, covering SPY and QQQ: regime and max pain. Earlier runs are silent. Never send a trade signal — this is unbacktested and the forward log exists precisely because nothing has validated these levels yet. Reporting where positioning sits is fine; telling the user to act on it is not.

Reply in two or three lines: SPY/QQQ/IWM regime and max pain, plus the forward-log tally if anything scored. Flag it if the magnet metric is still failing — it was 0-for-3 and that is the piece most likely to need cutting.

Important:
- Only data/ and the generated page should change. Do NOT modify scripts/ — if you think a script has a bug, report it rather than changing it.
- Do NOT open a pull request.
- Retry a failed push up to 4 times with exponential backoff (2s, 4s, 8s, 16s). Report the exact error if it still fails; do not work around it.
- Never present output as financial advice, and never place, order, or execute trades.
