# ETF Rotation delta-only: live semantics design (spec, not implementation)

Generated: 2026-08-11. Status: **design/spec only - no code changes to any live path in this document.**

## Purpose and scope

PR #83 (`backtest-etf-rotation-delta-rebalance-feasibility.ts`, merged 2026-08-11) established that delta-only rebalancing (`computeDeltaRebalanceOrders`, `etfRotationStrategy.ts`) cuts turnover 55-85% and trade count ~60-75% versus today's full-liquidate-then-rebuy, with return/Calmar generally equal or slightly better, at real cost measured and disclosed (a real, though well-explained, higher-than-first-guessed simulation-level target-state divergence rate). That PR proved the *research* case. It explicitly did not touch `etfRotationCycle.ts`, `etfRotationExecution.ts`, `etfRotationReview.ts`, `etfRotationRepair.ts`, or any audit/state-machine code - `computeDeltaRebalanceOrders` is dormant, reachable only from the backtest engine and its own tests.

This document is the next agreed step: turn the research finding into a **safe future specification** for what wiring delta-only into the live path would actually require - not an implementation, not a live/config change, not a decision to proceed. It answers the six questions the user posed when scoping this work, each grounded in the real current code (file/line references below), not speculation.

**What this document is not**: it does not implement any of the below. It does not change `etfRotationCycle.ts`'s `computeRebalanceOrders` call to `computeDeltaRebalanceOrders`. It does not add any new env var. Every finding below describes a gap or a design choice a *future* implementation PR would need to close - this document exists so that future PR starts from a real spec instead of discovering these gaps live.

---

## 1. New `legType` values needed for delta-only

**Today's vocabulary** (`etfRotationOrderAuditLog.ts:65-77`): `liquidate_existing` | `rebuild_target` | `open_new` | `exit_removed` | `repair`, derived by `deriveLegType(side, hasPairedOppositeOrder)` (`etfRotationOrderAuditLog.ts:114-123`):

```ts
export function deriveLegType(side, hasPairedOppositeOrder) {
  if (side === "BUY") return hasPairedOppositeOrder ? "rebuild_target" : "open_new";
  return hasPairedOppositeOrder ? "liquidate_existing" : "exit_removed";
}
```

`hasPairedOppositeOrder` is computed in `etfRotationExecution.ts`'s `executeEtfRotationOrders` purely from *this cycle's own order list* - "does this ticker also have an order on the opposite side in this same cycle." That check is correct **only** because full-liquidate has a structural invariant delta-only breaks: a continuing pick under full-liquidate *always* gets both a SELL (of the old position) and a BUY (of the new target) in the same cycle. Under delta-only, a continuing pick that needs adjustment gets **exactly one** order - either a BUY (underweight) or a SELL (overweight) - never both for the same ticker in the same cycle.

**Concrete consequence if delta-only were wired today without changing `deriveLegType`**: a delta-only "top up toward target" BUY has no paired SELL this cycle, so it would be misclassified as `open_new` (reads as "a brand-new position," but it's actually an existing one being increased). A delta-only "trim toward target" SELL would be misclassified as `exit_removed` (reads as "the pick was dropped entirely," but it's actually a partial reduction that leaves a real position behind). This is not a cosmetic labeling issue - `exit_removed` vs. a partial trim have different operational meaning to a human reading the audit log during an incident review.

**Proposed vocabulary** (extends, does not replace, the existing 5 values):

| New value | Side | Condition |
|---|---|---|
| `increase_target` | BUY | ticker already held before this rebalance, still a target this cycle, delta > 0 |
| `decrease_target` | SELL | ticker already held before this rebalance, still a target this cycle, delta < 0, **resulting position remains > 0** |
| `open_new` | BUY | *(unchanged)* ticker not held before this rebalance |
| `exit_removed` | SELL | *(unchanged)* ticker held, no longer a target this cycle, full exit to 0 |
| `liquidate_existing` / `rebuild_target` | - | *(full-liquidate mode only - unchanged, still correct there)* |
| `repair` | - | *(unchanged, manual repair path)* |

The dividing line between `decrease_target` and `exit_removed` is not "which mode is active" but "does the resulting position hit exactly 0" - this matters because `computeDeltaRebalanceOrders`'s exit path (a dropped pick) and its decrease-toward-target path (a continuing pick trimmed down) both produce a SELL, and only the *reason* differs (dropped from targets entirely, vs. still a target but overweight).

**Derivation change required**: `deriveLegType`'s signature (`side`, `hasPairedOppositeOrder`) is no longer sufficient - it would need the ticker's *pre-rebalance holding status* (was it held before this cycle at all) in addition to whether it's a current target, not just cross-referencing the opposite side of *this cycle's own order list*. This is a real signature change to a function three other files already import (`etfRotationOrderAuditLog.ts` itself, `etfRotationExecution.ts`, `etfRotationRepair.ts`'s `legType: "repair"` sibling usage) - a future implementation PR needs to thread the pre-rebalance holdings snapshot into wherever `deriveLegType` is called, not just extend its two existing parameters.

## 2. Distinguishing "rebalanced to exact target" from "threshold skipped"

Confirmed via `computeOverallExecutionStatus` (`etfRotationExecution.ts`): an **empty order array** resolves to `"accepted"` status unconditionally ("An empty order set is trivially 'accepted' (nothing needed)"), which `mapEtfRotationExecutionStatusToRebalanceStatus` (`etfRotationCycle.ts`) maps to `"executed"`. For delta-only with a nonzero threshold, an empty order set can now mean **two structurally different things** the current plumbing cannot tell apart:
1. Every target ticker was already at *exactly* its target weight (nothing to do).
2. Every target ticker's deviation was *within the tolerance band* - deliberately left alone, even though it is not at exact target.

Neither today's `RebalanceStatus` vocabulary nor the audit log has any event carrying "we decided not to trade, on purpose, and here's how far off we actually were." Every existing audit event type is about an order that *was* submitted, or a lifecycle/notification event (`REBALANCE_MANUALLY_CLEARED`, `OFF_TARGET_REMINDER_SENT`) - none represent "a decision was made not to act."

**Proposed**: a new audit event type, e.g. `WITHIN_TOLERANCE_SKIPPED`, emitted once per target ticker where `computeDeltaRebalanceOrders` skips the trade due to the threshold, carrying `currentWeightPercent` / `targetWeightPercent` / `deviationPercent` (all three already computed inline in `computeDeltaRebalanceOrders` today, just discarded once the `continue` fires). This is a genuinely new event type, not a repurposing - it is the only kind of event in this log that represents an *intentional non-action*, distinct from every current type.

## 3. Repair / off-target logic for drift, not a binary check

Two concrete, already-real gaps found by reading the current code, not hypothesized:

**(a) `deriveEtfRotationOffTargetState` (`etfRotationReview.ts:86-133`) is explicitly, by its own doc comment, not a weight-drift check**: "Deliberately NOT a weight-drift check: `AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT` keeps every live position far below its nominal target weight on purpose... comparing actual vs. target weightPercent would flag every successful rebalance as 'off-target' too." Its actual check is binary: `currentShares > 0` → not off-target, full stop, regardless of magnitude (`etfRotationReview.ts:106-110`).

For delta-only, this creates a real, silent blind spot: if a **partial** delta BUY fails (say a continuing position needs to go from 15 → 20 shares, and the +5 BUY is rejected), the ticker still holds 15 shares (`currentShares > 0`) - today's check would **not** flag this as off-target, even though the intended top-up never happened. The binary check was correct for full-liquidate (where "any shares > 0" really did mean "the rebuild succeeded," ramp-capped or not) but is not correct for delta-only's partial-adjustment shape.

**(b) `computeRepairBuyShares` (`etfRotationRepair.ts:111-128`) computes the full target share count from scratch**, assuming the ticker starts at 0 (`Math.floor(targetDollars / currentPrice)`, then ramp-capped - no term for "shares already held"). If this were reused to repair a failed *partial* delta BUY, it would compute the full 20-share target and attempt to buy **20 more** on top of the 15 already held, landing at 35 - a real over-buy, not a repair.

**What a future implementation would need**: off-target detection for delta-only cannot reuse the binary `currentShares > 0` rule - it needs to compare *actual current weight* against *target weight* and flag a deviation beyond some threshold **combined with** a recorded failure event (to preserve the existing "don't flag a rebalance that just hasn't run yet" distinction, `etfRotationReview.ts:120-121`). Repair sizing needs to compute the *remaining* delta at repair time (`target - actual current shares`, re-derived fresh, matching `computeRepairBuyShares`'s own stated principle of "what a fresh rebalance cycle would compute today, not the stale plannedOrders" - it just needs the same freshness principle applied to a nonzero starting point instead of an assumed zero).

## 4. Ramp cap applied to a delta

This one is **already mechanically correct with no code change needed**, confirmed by re-reading `executeEtfRotationOrders`'s BUY loop (`etfRotationExecution.ts`): `computeRampMaxShares` / `computeRampMaxNotional` cap `order.shares` / `order.notional` regardless of what produced that number - a full-liquidate target or a delta-only delta look identical to the ramp-cap stage, since both arrive as a plain `RebalanceOrder`.

The design-relevant point is not correctness but **risk-profile shift**: deltas are typically much smaller than full targets (that is the entire point of delta-only), so the ramp cap will bind far less often under delta-only than under full-liquidate. Today's 2% ramp is a meaningful, frequently-binding constraint under full-liquidate; under delta-only it would frequently allow the *entire* delta through unconstrained, since most deltas already fall under 2% of equity. This means **delta-only and "whether/how much to raise the ramp cap" (the still-open decision from PR #80/#81) are not independent questions** - wiring delta-only live would, as a side effect, quietly change what the ramp cap actually protects against, even without anyone touching `AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT` itself. Any future live-wiring decision for delta-only should re-examine the ramp's effective behavior under delta-only, not just re-confirm today's full-liquidate-calibrated intuition about what "2%" means.

## 5. Fractional tails

`computeDeltaRebalanceOrders` has no fractional/notional support today (PR #83, deliberate v1 scope limit). But the fractional/notional *fallback* it doesn't use is itself already built and dormant (PR #80, `computeRebalanceOrders`'s `allowFractionalShares` path) - both capabilities are unreachable from the live worker today, but **if both were ever enabled together**, a real interaction appears: a prior notional BUY can leave a position at a non-integer share count (e.g. 2.35 shares). A delta-only computation the following month would then compute `delta = targetShares (integer, Math.floor) - currentShares (2.35)` - itself a fractional delta (e.g. 0.65) that `computeDeltaRebalanceOrders` today has no path to express (it only emits whole-share BUY/SELL orders).

This is a genuine second-order gap, only relevant if both dormant capabilities are ever enabled together - not urgent, but worth stating explicitly so a future PR doesn't discover it by surprise. **Recommendation for any future live-wiring PR**: either (a) explicitly forbid combining delta-only with fractional/notional until `computeDeltaRebalanceOrders` is extended to handle a fractional delta, or (b) do that extension as part of the same PR that enables both. Do not enable them independently and assume the combination "just works."

## 6. Merge gate before any future live switch

The user's own framing offered two options: a minimum shadow/dry-run delta-only tracking period, or treat PR #83's research plus this design as sufficient on its own.

**Recommendation: match this project's own already-established precedent, not a lighter bar just because the backtest numbers look strong.** Every prior live-adjacent capability in this project required both a research finding *and* a live shadow-tracking period before a live-switch decision was even considered - `adjustment=all` (PRs #76-79, still shadow-tracking today, no live switch made) is the closest precedent and should be treated as the template, not an exception. Concretely, before any live-wiring PR for delta-only is even proposed:

1. The gaps in sections 1-3 above (`legType` vocabulary, the `WITHIN_TOLERANCE_SKIPPED` event, drift-aware off-target/repair) need to be **implemented**, not just designed - this document is a spec, not a substitute for that work.
2. A shadow-tracking period, structurally similar to the existing `adjustment=all` shadow forward-validation (its own separate anchor/clock, own separate output files, explicitly labeled "methodology evidence, not production clearance"): compute what delta-only *would have* decided each real live rebalance cycle, alongside the actual full-liquidate decisions being executed, for at least the same 3+/6+ rebalance-cycle threshold this project already uses everywhere else as its minimum read bar.
3. Only after both of the above - a live-wiring PR, with its own explicit user signal, not bundled with either of the above.

This keeps delta-only on the same evidentiary standard as every other capability sitting dormant in this codebase, rather than fast-tracking it because PR #83's numbers were unusually strong.

---

## Summary table

| Question | Status today | Gap size |
|---|---|---|
| New `legType`s | 2 new values needed (`increase_target`/`decrease_target`); `deriveLegType`'s signature needs a pre-rebalance-holdings input it doesn't have today | Real, moderate |
| Exact-target vs. threshold-skipped | No mechanism exists at all - needs a new audit event type | Real, moderate |
| Off-target/repair for drift | Both `deriveEtfRotationOffTargetState` and `computeRepairBuyShares` are structurally binary/from-zero by explicit design; both would need real changes | Real, the largest of the four |
| Ramp cap on deltas | Mechanically already correct, no code gap - but its effective risk profile shifts and should be re-examined, not assumed unchanged | Design/calibration question, not a code gap |
| Fractional tails | No gap today (neither capability is live); a real second-order interaction if both are ever enabled together | Deferred, not urgent |
| Merge gate | Recommendation given above (match `adjustment=all`'s precedent) - final call is the user's | Decision, not implementation |

No code in this repository was changed by this document.
