Daily ETF trend + LEAP rotation run. Fresh session, no prior context — everything below is self-contained.

Repo: moabd5251-ui/New, branch claude/remove-fable-5-auwiw2. Work only there.

STEP 0 — Get the code and its state.
If a checkout of moabd5251-ui/New is already present, cd into it and run:
  git fetch origin claude/remove-fable-5-auwiw2 && git checkout claude/remove-fable-5-auwiw2 && git pull origin claude/remove-fable-5-auwiw2
If there is no checkout, clone it: git clone -b claude/remove-fable-5-auwiw2 https://github.com/moabd5251-ui/New
Everything below runs from the repository root. Python 3 with the repo's deps is expected.

STEP 1 — Run both, in this order:
    python3 scripts/run_trend.py
    python3 scripts/run_rotation.py --allocation 25000

STEP 2 — Republish BOTH pages to their existing URLs, keeping the favicons. Passing `url` is REQUIRED — without it a new URL is minted and the user's link goes stale. If a publish is refused because the live version was not viewed, read the artifact at that URL first, confirm the regenerated page is the same generator's output with newer numbers, then publish again.
    trend.html    -> https://claude.ai/code/artifact/c427863e-a14b-42ab-aa61-10c73d6975fd  favicon 🧭
    rotation.html -> https://claude.ai/code/artifact/8f164247-68a6-4571-ba10-6eef5736e76c  favicon 🎯

STEP 3 — Commit and push:
    git push -u origin claude/remove-fable-5-auwiw2
If nothing changed, say so briefly and make no empty commit.

STEP 4 — Send ONE PushNotification only if something actually moved: a ROTATE IN or ROTATE OUT (rare, ~8-9 a year — lead with it and include the LEAP if contracts were picked), or an exposure change of 20 points or more. A quiet day gets no push.

Reply in two or three lines: asof date, long/short count, notable changes. If no new session has closed since the last run, say exactly that and stop — do not manufacture activity or re-report yesterday's numbers as if they were new.

Important:
- Only data/ and the generated pages should change. Do NOT modify scripts/ — if you think a script has a bug, report it rather than changing it.
- Do NOT open a pull request.
- Retry a failed push up to 4 times with exponential backoff (2s, 4s, 8s, 16s). Report the exact error if it still fails; do not work around it.
- Never present output as financial advice, and never place, order, or execute trades.
