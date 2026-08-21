Daily pre-earnings volatility ramp run. Fresh session, no prior context — everything below is self-contained.

Repo: moabd5251-ui/New, branch claude/remove-fable-5-auwiw2. Work only there.

STEP 0 — Get the code and its state.
If a checkout of moabd5251-ui/New is already present, cd into it and run:
  git fetch origin claude/remove-fable-5-auwiw2 && git checkout claude/remove-fable-5-auwiw2 && git pull origin claude/remove-fable-5-auwiw2
If there is no checkout, clone it: git clone -b claude/remove-fable-5-auwiw2 https://github.com/moabd5251-ui/New
Everything below runs from the repository root. Python 3 with the repo's deps is expected.

STEP 1 — Run: python3 scripts/run_ramp.py
It scans optionable names for reports within 45 days, finds those still in the entry window (term structure flat, 12-40 days out), builds a calendar or straddle for each, and rewrites ramp.html.

The script self-guards on market hours. If it prints a `[guard]` line, the session is not REGULAR: outside it the book empties and implied vols are recomputed off stale last trades, producing figures that look plausible and are not. Do NOT work around the guard — send nothing, make no commit, end quietly and say so in your reply.

STEP 2 — Republish to the existing URL. Passing `url` is REQUIRED — without it a new URL is minted and the user's link goes stale. If the publish is refused because the live version was not viewed, read the artifact at that URL first, confirm the regenerated page is the same generator's output with newer numbers, then publish again.
    ramp.html -> https://claude.ai/code/artifact/776d6892-6d6c-4bd3-9ec1-6abb86ad9e35  favicon 📈

STEP 3 — Commit and push:
    git push -u origin claude/remove-fable-5-auwiw2
If nothing changed, say so briefly and make no empty commit.

STEP 4 — Send a separate PushNotification for each `PUSH:` line the script emits, under ~150 chars, verbatim (ignore `PUSH: (none)`). Three kinds matter: a name newly entering the window, an EXIT TODAY warning (most important — the position must close before the report), and a name whose ramp got priced in while waiting. Do NOT notify about the dashboard updating or about names outside the window. A quiet day is silent.

Reply in two or three lines: how many names in the entry window, how many worth taking, and any exit warnings.

Important:
- Only data/ and the generated page should change. Do NOT modify scripts/ — if you think a script has a bug, report it rather than changing it.
- Do NOT open a pull request.
- Retry a failed push up to 4 times with exponential backoff (2s, 4s, 8s, 16s). Report the exact error if it still fails; do not work around it.
- Two standing cautions to respect in what you say: this strategy is NOT backtested for profitability — the measured result was that IV rises ~96% of the time (+34 pts) while the straddle still returns roughly 0% before costs and -5.8% after, so the vol expansion is real and the naive long-premium expression of it is not. The calendar structure remains untested.
- Never present output as financial advice, and never place, order, or execute trades.
