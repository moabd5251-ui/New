# Pre-registration: the `wide` ladder on two years of hourly bars

Written **before** the run, and not edited afterwards. The point is that three
findings in this project looked solid and evaporated once tested properly, and
in every case the tightening happened *after* seeing the result. This fixes
what is being tested and how it will be judged, in advance.

## Hypothesis

The multi-timeframe continuation strategy failed on 5-minute bars for two
measurable reasons: stops a few tenths of a percent wide, so ordinary spread
consumed a fifth of every R; and 91% of decision bars coming back
`not_aligned`, so it traded the rare 9% and was wrong.

A slower ladder should improve both. Hourly-timed stops are several times wider
in percentage terms, making the same spread a much smaller fraction of R. And
daily/4-hour/hourly trends are more persistent than daily/hourly/5-minute, so
agreement between rungs should be less rare.

**Prediction, stated in advance:** expectancy improves relative to the -0.820R
per trade the `swing` ladder produced on large caps. Whether it clears zero is
the open question.

## Configuration — fixed, not to be tuned

| | |
|---|---|
| Ladder | `wide` — `1d → 4h → 1h` |
| Strategy thresholds | **library defaults, unchanged**: `maxRetracePct` 61.8, `minRetracePct` 15, `maxPullbackBars` 12, `minLegAtr` 2, `swingSpan` 2, `minMeasuredR` 2 |
| Backtest | defaults: pessimistic ambiguous bars, gap fills at the open, R against planned risk, flatten at the bell |
| Costs | 0.05% per side headline; 0.00% and 0.20% reported alongside |
| Screen | none |
| Data | Yahoo, `interval=1h`, ~2 years, `interval=1d` for the daily rung |

## Universe — fixed before the run

45 US symbols spanning mega caps, volatile mid caps, speculative small caps and
index ETFs. Chosen for liquidity and for spanning a range of volatility, not
for past performance:

```
AAPL MSFT NVDA AMZN GOOGL META TSLA AMD AVGO NFLX
INTC MU QCOM SMCI PLTR CRWD SNOW COIN MSTR SHOP
SOFI RIOT MARA PLUG CHPT LCID RIVN AFRM UPST ROKU
DKNG HOOD IONQ RGTI SOUN BBAI CLSK NIO GME AMC
SPY QQQ IWM ARKK TQQQ
```

## How it will be judged

One replay per symbol over the whole history. Trades are then split by the date
they opened:

- **Earlier period** — everything before the last six months.
- **Held-out period** — the most recent six months.

Nothing is fitted on the earlier period; the thresholds above are library
defaults. The split is a stability check: a result that appears in one period
and not the other is noise, whatever its total.

**The headline number is the held-out period at 0.05% costs.** It will be
reported whichever way it comes out, including if it contradicts the
prediction above.

A result is worth pursuing only if it is positive in **both** periods. Positive
overall but negative in the held-out slice counts as a failure.
