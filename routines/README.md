# Trading routine prompts

Rebuilt versions of the five routines that have been disabled since 2026-08-14,
translated onto the same fresh-session-per-fire pattern used for the NQ forward
data collection routine (`trig_01LxL9MysEMFTsmdkojt2Mu4`, rebuilt 2026-08-21).

Each file is the full prompt for one Routine. They are stored here so the text
is reviewable and version-controlled rather than living only inside trigger
configuration.

## Why the old ones died

All five were bound to a single persistent session, `session_01GcDEyFWjzM36LJ5rDKbc3P`:

| Routine | Trigger | Cron (UTC) |
|---|---|---|
| Daily earnings drift (bound) | `trig_01LdcofzZeD7QrxSJz6sz3LA` | `15 19 * * 1-5` |
| Daily volatility ramp (bound) | `trig_01SxzuB2hgX7KdkFkujahAJi` | `45 18 * * 1-5` |
| Daily swing scan (bound) | `trig_01J7MFXbCNdU5qUfC5dBE8sn` | `15 21 * * *` |
| Zero-DTE positioning (bound) | `trig_019BFfWFZrzBqPtAtCEN3MAZ` | `30 15,18,19 * * 1-5` |
| Daily ETF trend + LEAP rotation (bound) | `trig_01PDDjPkmahw9HSVSc1X185F` | `15 0 * * 2-6` |

Two consequences of that binding:

1. **They fire into one conversation, and die with it.** When that session went
   away, every routine bound to it went with it. Their `next_run_at` values are
   still frozen at 2026-08-15 / 2026-08-17.
2. **They produce no run record.** A Routine bound to a persistent session does
   not record `last_run`, so `list_triggers` shows `null` for all five — there
   was never any way to tell a silent failure from a quiet day.

The prompts assumed that binding too. Each opened with some variant of
"repo is at /home/user/New, you have full context" and then gave no checkout
instructions, because the bound session already had the repo. Fired into a
fresh session, they would have had nothing to run against.

## What changed in the rebuild

- **Fresh session per fire**, pinned to an environment, so nothing depends on a
  conversation staying alive — and each run records a `last_run`.
- **`STEP 0` checkout block** on every routine: fetch/checkout/pull, or clone if
  no checkout is present. Nothing is assumed to be on disk.
- **Explicit branch** — `claude/remove-fable-5-auwiw2` — named in the prompt
  rather than inherited from the session's working directory.
- **Push made explicit and load-bearing**: `git push -u origin <branch>`, retry
  4x with exponential backoff, report the exact error rather than working
  around it. The swing and drift prompts say what is lost when a push fails,
  because in both cases the committed JSON *is* the dedupe/position state.
- **Artifact republish spelled out**, including that `url` is required and what
  to do when a publish is refused for an unviewed live version — the old
  prompts said "pass `url`" but not how to recover from the refusal.
- **Guardrails preserved verbatim**: market-hours `[guard]` handling, the
  push-notification gating, the "a quiet day is silent" rule, and every standing
  statistical caution (drift's t=1.18, ramp's -5.8% after costs, 0DTE's 0-for-3
  magnet, BTC's -0.3R on the swing timeframe).

## One deliberate content change

`drift.md` drops this paragraph from the old prompt:

> NOTE ON FIRST RUN: data/drift.json has never existed — the original routine was
> created on 04 Aug and its environment was deleted before it ever fired.

It is now stale: `data/drift.json` exists on `claude/remove-fable-5-auwiw2`.
Keeping it would have told the run to expect an empty state and to explain away
a burst of alerts that is no longer going to happen.
