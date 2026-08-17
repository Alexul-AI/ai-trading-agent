# ETF rotation forward validation report

Generated: 2026-08-17T23:29:34.214Z
Target anchor (candidate-hold3 named, historical out-of-sample declared exhausted): 2026-07-14

## Simulated window (fresh cash start, pinned to the anchor)
- baseline-2: 2026-07-14 to 2026-08-17 (25 trading days)
- candidate-hold3: 2026-07-14 to 2026-08-17 (25 trading days)
- Achieved start is exactly on the target anchor (no pre-anchor data included).

Both simulations start with pure cash and execute their first rebalance immediately on day one (isMonthlyRebalanceDate's "first simulated day" rule). The simulated window is pinned to never start earlier than the anchor (via runEtfRotationWindowAnalysis's simStartDateOverride) - pre-anchor price history is used only to warm up momentum/SMA indicators, never simulated or traded. This fixes a real bug caught in review before merge: an earlier version of this script let the simulation start wherever warmup happened to clear, which drifted 26 calendar days before the anchor and included pre-anchor performance in what was meant to be a forward-only read (see PR #31 review).

## Result (NEXT_OPEN)
| series | return% | maxDD% | trading days | rebalances |
|---|---|---|---|---|
| baseline-2 | 1.53 | -5.28 | 25 | 2 |
| candidate-hold3 | 2.08 | -3.86 | 25 | 2 |


## Benchmarks (same period, context)
- SPY buy & hold: 2.75%
- Equal-weight 5-ETF (approx. - simple average of individual price returns, not a whole-share rebalanced sim): 2.85%

## Decisions - baseline-2
- 2026-07-15 BUY QQQ - 6 sh @ $724.52 (~43.6% of equity)
- 2026-07-15 BUY SPY - 6 sh @ $754.60 (~45.5% of equity)
- 2026-08-04 SELL SPY - 6 sh @ $760.25 (~45.2% of equity)
- 2026-08-04 SELL QQQ - 6 sh @ $708.13 (~42.1% of equity)
- 2026-08-04 BUY QQQ - 7 sh @ $708.83 (~49.1% of equity)
- 2026-08-04 BUY SPY - 6 sh @ $761.01 (~45.2% of equity)

## Decisions - candidate-hold3
- 2026-07-15 BUY QQQ - 4 sh @ $724.52 (~29.0% of equity)
- 2026-07-15 BUY SPY - 4 sh @ $754.60 (~30.2% of equity)
- 2026-07-15 BUY EFA - 31 sh @ $104.47 (~32.5% of equity)
- 2026-08-04 SELL SPY - 4 sh @ $760.25 (~30.0% of equity)
- 2026-08-04 SELL QQQ - 4 sh @ $708.13 (~27.9% of equity)
- 2026-08-04 SELL EFA - 31 sh @ $106.70 (~32.6% of equity)
- 2026-08-04 BUY QQQ - 4 sh @ $708.83 (~28.0% of equity)
- 2026-08-04 BUY SPY - 4 sh @ $761.01 (~30.0% of equity)
- 2026-08-04 BUY EFA - 31 sh @ $106.81 (~32.6% of equity)

## Pre-declared read criteria (written before any forward data existed)
- 0 rebalances: nothing to read yet.
- 1-2 rebalances (~1-2 months): report the numbers, informational only - too early for a promotion decision.
- 3+ rebalances (~3 months, matching the original estimate): candidate-hold3 is read as "holding up so far" only if BOTH (a) its max drawdown is not worse than baseline-2's, and (b) its return is not worse than baseline-2's by more than 5 percentage points. Either condition failing is a flagged concern worth more data/discussion, not an automatic rejection.
- Regardless of the read at any sample size: this is supplementary color on top of the already-completed historical multi-window validation (PR #27/#28), not a replacement for it. It does not by itself trigger promoting candidate-hold3 to DEFAULT_ETF_ROTATION_CONFIG - that stays a separate, explicit, user-approved step.

## Current read
2 rebalance(s) since the anchor - too early for a promotion decision, informational only.

## Caveats
- Raw Alpaca bars (adjustment=raw) - no dividends/distributions, same caveat as every other ETF rotation report in this repo.
- The equal-weight benchmark above is an approximation (simple average of five individual price returns), not a whole-share rebalanced simulation like this strategy's own whole-window benchmark elsewhere in this repo.
- The simulated window is intentionally short and grows only by re-running this script later (each run re-fetches from a fresh anchor-sized window, so day counts are not directly comparable run-to-run the way the accumulating CSV log's rebalance_count column is).
- Small sample by construction - this only grows richer over repeated future runs of this script. See the pre-declared criteria above for how to read it at different sample sizes.
- This script performs no trades and touches no live/paper execution path - it only reads Alpaca's historical/current bars, the same as every other backtest script in this repo.
