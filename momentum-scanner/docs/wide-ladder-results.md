# Results: the `wide` ladder on two years of hourly bars

Companion to [the pre-registration](./wide-ladder-preregistration.md), which was
committed before this test ran. Nothing in the configuration was changed after
seeing a result; the one departure from the plan is labelled post-hoc below and
reported alongside the pre-registered number rather than in place of it.

**Data.** 45 symbols, 156,836 hourly bars, 2024-08-08 to 2026-08-07, via Yahoo.
Held-out period starts 2026-02-06. Lookahead check clean across all 45.

## The pre-registered result

Flattening at the closing bell, as specified.

| Costs | Period | Trades | Win | Total | Per trade | PF |
|---|---|---|---|---|---|---|
| 0.00% | earlier | 1,669 | 42.2% | -149R | -0.089R | 0.80 |
| 0.00% | **held out** | 622 | 40.4% | -63R | **-0.101R** | 0.78 |
| 0.05% | earlier | 1,668 | 39.7% | -275R | -0.165R | 0.67 |
| 0.05% | **held out** | 621 | 38.2% | -106R | **-0.171R** | 0.66 |
| 0.20% | held out | 621 | 31.4% | -233R | -0.375R | 0.41 |

**Headline: -0.171R per trade on held-out data.** The pre-registered bar was
"positive in both periods". It is negative in both.

## The post-hoc correction

The exits gave away a flaw in the test design: **1,431 of 2,289 trades — 63% —
exited at `session_end`**, and only 69 reached a target. Flattening at the bell
is right for a strategy timed on 5-minute bars and wrong for one timed on
hourly bars; the pre-registration itself describes this ladder's holding period
as "days to weeks". The specified test did not test the hypothesis it was
written for.

Rerun with overnight holds allowed. **This is post-hoc.**

| Costs | Period | Trades | Win | Total | Per trade | PF |
|---|---|---|---|---|---|---|
| 0.00% | earlier | 1,349 | 31.3% | -152R | -0.113R | 0.86 |
| 0.00% | **held out** | 513 | 32.0% | -22R | **-0.043R** | 0.95 |
| 0.05% | earlier | 1,344 | 30.8% | -254R | -0.189R | 0.78 |
| 0.05% | **held out** | 508 | 31.5% | -63R | **-0.124R** | 0.86 |

The fix did what it was supposed to mechanically — targets reached went from 69
to 424 — and changed the *shape* of the results without changing the bottom
line. Win rate fell from 39% to 31%, because the session-end exits it removed
were mostly small winners now allowed to run to a stop. Aggregate expectancy at
0.05% is -0.171R either way, to three decimal places of coincidence.

Average hold is 7.5 hourly bars, a little over one trading day — so even
unshackled the strategy is not holding for "days to weeks". The stop distance
and `maxHoldBars` bind long before the thesis does.

## Verdict

Negative in every cell of both tables. The best number anywhere — held out, zero
costs, post-hoc configuration — is -0.043R per trade at a profit factor of 0.95,
and that cell assumes trading is free.

What makes this conclusive rather than inconclusive is the agreement between
independent periods. In the pre-registered run, 1,668 earlier trades gave
-0.165R and 621 held-out trades gave -0.171R: six thousandths of an R apart.
That is not a sample too small to find an edge. It is a sample large enough to
measure a stable negative one precisely.

Two parts of the hypothesis were confirmed and did not help:

- **Costs stopped dominating.** Expectancy improved from -0.820R per trade on
  the 5-minute ladder to -0.167R here, and the gap between the 0.00% and 0.05%
  columns is far narrower than on the fast ladders. Wider stops did exactly what
  was predicted.
- **Alignment became less rare.** `not_aligned` fell from 91.1% of decision bars
  to 81.7%, and win rate roughly doubled, from 19% to 39%.

Both improvements were real and the strategy still loses. The problem is not
that the entry fires too rarely or that spread eats the edge; it is that the
entry has no edge to eat.

## What this does not say

It does not say multi-timeframe continuation cannot work. It says *this*
formulation — swing-structure alignment, entry on a pullback that holds the
structure rung, 2R/3R targets, these thresholds — has no edge in liquid US
equities at any of the four scales tested, over these periods, at any cost
level including zero.

Anything further should start from a different entry rule rather than from new
thresholds on this one. Four rounds of threshold work in this project produced
three findings that looked solid and evaporated on contact with new data; the
tooling that killed them is the durable result here.
