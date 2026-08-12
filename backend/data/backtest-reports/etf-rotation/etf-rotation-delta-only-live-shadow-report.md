# ETF Rotation delta-only live-portfolio shadow

Generated: 2026-08-12T22:30:44.903Z
Rebalance month: 2026-08
Config variant: baseline-2 (holdCount=2, original MVP)

**Read-only, research-only - no live, execution, or config change.** This is a **one-cycle counterfactual**: given the REAL current Alpaca portfolio and the REAL targets the live full-liquidate cycle already decided this month, what would `computeDeltaRebalanceOrders` have done differently - NOT a continuous delta-only simulation (see PR #83's backtest grid for that question). Targets are read from the real, already-persisted live decision (never recomputed independently), so this measures "mechanism differs," not "signal differs." Prices are current market quotes at run time, not the exact price the real cycle traded at - a minor, disclosed timing difference, not a mechanism difference. A real off-target gap (a target ticker currently holding 0 shares) is read as-is, not special-cased - `computeDeltaRebalanceOrders` naturally computes a full-target BUY for it, the same magnitude a fresh full-liquidate rebuild would.

## Per-ticker current weight vs. target

| ticker | current weight | target weight | deviation |
|---|---|---|---|
| QQQ | 0.00% | 50.00% | 50.00pp |
| SPY | 1.75% | 50.00% | 48.25pp |

## Real full-liquidate (this cycle's actual plan) vs. delta-only at each threshold

Real full-liquidate planned gross value: **$93334.55** (4 legs).

| threshold | delta-only gross value | reduction vs. real | legs |
|---|---|---|---|
| 0% | $85857.85 | 8.0% | 2 |
| 1% | $85857.85 | 8.0% | 2 |
| 2% | $85857.85 | 8.0% | 2 |
| 5% | $85857.85 | 8.0% | 2 |

**Read this reduction number carefully**: it is well below PR #83's backtest range (55-85%). Average deviation from target this cycle is 49.1pp - the real live portfolio is currently far from its target weights (see the per-ticker table above), likely due to the live ramp cap (`AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT`) constraining real position sizes. When a portfolio is this far from target, the delta to trade is nearly as large as the full target itself, so delta-only has little turnover left to save. This is not a contradiction of PR #83 - it is the real-data confirmation of PR #84's point 4: delta-only's benefit and the ramp-cap decision are not independent questions.

## Delta-only legs by threshold (PR #84's proposed legType vocabulary - dormant, read-only, not the real audit log)

### Threshold 0%

- open_new: BUY QQQ - 60 share(s)
- increase_target: BUY SPY - 55 share(s)

### Threshold 1%

- open_new: BUY QQQ - 60 share(s)
- increase_target: BUY SPY - 55 share(s)

### Threshold 2%

- open_new: BUY QQQ - 60 share(s)
- increase_target: BUY SPY - 55 share(s)

### Threshold 5%

- open_new: BUY QQQ - 60 share(s)
- increase_target: BUY SPY - 55 share(s)

## Caveats

- One-cycle counterfactual against the real, full-liquidate-managed portfolio - not a compounding delta-only simulation.
- Targets/plannedOrders read from the real live state via `GET /api/autopilot/etf-rotation/review` - never recomputed.
- Prices are current market quotes at run time, not the real cycle's actual trade prices - both sides of every $ comparison use the same price map, so the comparison stays internally consistent even though it isn't the exact historical price.
- `legType` values here are PR #84's proposed, dormant vocabulary for a possible future live audit log - this report does not write to `etf-rotation-order-audit.jsonl` and does not affect it in any way.
- No orders were submitted. This script never calls `executeSafeTrade` or any repair/execution endpoint.
