# ETF rotation ADJUSTED-SHADOW forward validation report

Generated: 2026-08-17T23:29:35.877Z
Target anchor (adjustment=all shadow-tracking decided): 2026-08-08

**ADJUSTED-SHADOW TRACKING - methodology evidence, not production clearance.** This track simulates the same two config variants under `adjustment=all` (dividend/distribution-adjusted bars) instead of the live `raw` default - it answers "would `adjustment=all` change forward results," not "does candidate-hold3 beat baseline-2 under the current production methodology" (see the separate raw-production forward-validation report for that - its own clock is untouched by this track). Does not by itself trigger any live or config change. Full decision plan: `docs/product/ROADMAP.md` Phase 2.

## Simulated window (fresh cash start, pinned to the anchor)
- baseline-2: 2026-08-10 to 2026-08-17 (6 trading days)
- candidate-hold3: 2026-08-10 to 2026-08-17 (6 trading days)
- Achieved start is 2 calendar day(s) after the target anchor (the anchor fell on a non-trading day; still no pre-anchor data included).

Both simulations start with pure cash and execute their first rebalance immediately on day one (isMonthlyRebalanceDate's "first simulated day" rule). The simulated window is pinned to never start earlier than the anchor (via runEtfRotationWindowAnalysis's simStartDateOverride) - pre-anchor price history is used only to warm up momentum/SMA indicators, never simulated or traded. This fixes a real bug caught in review before merge: an earlier version of this script let the simulation start wherever warmup happened to clear, which drifted 26 calendar days before the anchor and included pre-anchor performance in what was meant to be a forward-only read (see PR #31 review).

## Result (NEXT_OPEN)
| series | return% | maxDD% | trading days | rebalances |
|---|---|---|---|---|
| baseline-2 | 0.26 | -0.57 | 6 | 1 |
| candidate-hold3 | 0.15 | -0.51 | 6 | 1 |


## Benchmarks (same period, context)
- SPY buy & hold: -0.05%
- Equal-weight 5-ETF (approx. - simple average of individual price returns, not a whole-share rebalanced sim): 0.31%

## Decisions - baseline-2
- 2026-08-11 BUY QQQ - 6 sh @ $723.37 (~43.6% of equity)
- 2026-08-11 BUY SPY - 6 sh @ $774.90 (~46.8% of equity)

## Decisions - candidate-hold3
- 2026-08-11 BUY QQQ - 4 sh @ $723.37 (~29.1% of equity)
- 2026-08-11 BUY SPY - 4 sh @ $774.90 (~31.2% of equity)
- 2026-08-11 BUY EFA - 30 sh @ $108.53 (~32.7% of equity)

## Pre-declared read criteria (written before any forward data existed)
- 0 rebalances: nothing to read yet.
- 1-2 rebalances (~1-2 months): report the numbers, informational only - too early for a promotion decision.
- 3+ rebalances (~3 months, matching the original estimate): candidate-hold3 is read as "holding up so far" only if BOTH (a) its max drawdown is not worse than baseline-2's, and (b) its return is not worse than baseline-2's by more than 5 percentage points. Either condition failing is a flagged concern worth more data/discussion, not an automatic rejection.
- Regardless of the read at any sample size: this is supplementary color on top of the already-completed historical multi-window validation (PR #27/#28), not a replacement for it. It does not by itself trigger promoting candidate-hold3 to DEFAULT_ETF_ROTATION_CONFIG - that stays a separate, explicit, user-approved step.

## Current read
1 rebalance(s) since the anchor - too early for a promotion decision, informational only.

**ADJUSTED-SHADOW TRACK**: this read is about candidate-hold3 vs baseline-2 UNDER adjustment=all specifically - it is not a read on production (raw) methodology, has its own separate clock from the raw-production track, and does not by itself trigger any live or config change.

## Caveats
- Adjustment=all Alpaca bars (dividend/distribution-adjusted) - this is the shadow/experimental track. The live production strategy and the raw-production forward-validation track both still use adjustment=raw; see docs/product/ROADMAP.md Phase 2 for the decision plan this is part of.
- The equal-weight benchmark above is an approximation (simple average of five individual price returns), not a whole-share rebalanced simulation like this strategy's own whole-window benchmark elsewhere in this repo.
- The simulated window is intentionally short and grows only by re-running this script later (each run re-fetches from a fresh anchor-sized window, so day counts are not directly comparable run-to-run the way the accumulating CSV log's rebalance_count column is).
- Small sample by construction - this only grows richer over repeated future runs of this script. See the pre-declared criteria above for how to read it at different sample sizes.
- This script performs no trades and touches no live/paper execution path - it only reads Alpaca's historical/current bars, the same as every other backtest script in this repo.
