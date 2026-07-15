# ETF Rotation Stage 2 — Paper Execution Semantics

**Status: design doc only. No execution code exists yet. Nothing in this document changes any running behavior, any environment variable, or any Render configuration.**

## Why this document exists

Stage 1 (`AUTOPILOT_STRATEGY=etf_rotation`, merged in PR #40) wired ETF Rotation into `autopilotWorker.ts` as a fully separate, mutually-exclusive decision path. It computes real monthly-rebalance targets and orders against live bars and journals them — but it never calls `executeSafeTrade`, by construction, not by flag. That is a deliberate, hard stopping point: decision computation and order execution are different problems with different failure modes, and Stage 1 was scoped to prove out the first one against real data with zero execution risk.

Before Stage 2 writes any execution code, three concrete gaps need a resolved design, not an ad-hoc implementation:

1. The persisted rebalance-gate state (`etfRotationWorkerState.ts`) currently only tracks `lastRebalanceDateKey`, written immediately after `computeRebalanceOrders` runs. That's correct for Stage 1 (nothing executes, so there's nothing to wait for) but wrong for Stage 2 — the gate needs to reflect whether execution actually completed, not just whether targets were computed.
2. Stage 1's journal merges a ticker's SELL+BUY legs (full liquidate-then-rebuy) into one decision row. That's the right shape for a decision *summary*, but real execution needs to track each leg separately — a SELL that fails and a BUY that fails are different situations that need to be visible independently.
3. Execution must reuse the account's existing safety gates, and reuse them *correctly* — some of those gates are already side-aware (they don't block SELLs), some are not, and getting this wrong in either direction is a real risk (either liquidations get blocked when they shouldn't, or a gate that should stop a BUY doesn't).

This document resolves the design for all three, plus the surrounding execution mechanics, before any of it is implemented.

## 1. Scope / non-goals

**In scope**: the design for wiring real (paper) order execution into the ETF Rotation path that Stage 1 already computes decisions for.

**Non-goals, explicitly**:
- Running ETF Rotation and the baseline strategy concurrently against the same account. Still out of scope — the two remain mutually exclusive per `AUTOPILOT_STRATEGY`, as decided in the Stage 1 design.
- Promoting `candidate-hold3` to the default config. That is a separate, already-tracked validation question (forward validation, `docs/product/ROADMAP.md`) unrelated to execution semantics.
- Any change to `.env` or Render's environment. This document does not enable execution — it designs what execution would look like *if and when* someone later flips the relevant env vars, which remains a separate, explicit decision.
- Writing any code. This PR is the document only.

## 2. Current Stage 1 behavior (recap)

- `runEtfRotationCycle` (`autopilotWorker.ts`) fetches the 5-ETF universe with a long warm-up window, checks a monthly-rebalance gate, computes targets via `decideRotationTargets`, translates them to orders via `computeRebalanceOrders` (full liquidate-then-rebuy, SELLs before BUYs in the returned array), and journals one merged decision per universe ticker.
- The gate's only state is `{ lastRebalanceDateKey }` in `data/etf-rotation-worker-state.json`, written right after orders are computed — before, and regardless of, any execution, since none happens.
- Every BUY/SELL decision is journaled with `executionStatus: "dry_run"` unconditionally. `runEtfRotationCycle` contains no call to `executeSafeTrade` anywhere — this is a hard, code-level guarantee, not something gated by `AUTOPILOT_EXECUTE_TRADES`.

## 3. Execution gates

Every gate an ETF Rotation order will pass through once Stage 2 ships, and whether it's inherited for free or needs new code:

| Gate | Blocks | Side-aware today? | Stage 2 work |
|---|---|---|---|
| `AUTOPILOT_STRATEGY=etf_rotation` | Whole rotation path | N/A (outer selector) | None — unchanged from Stage 1 |
| `AUTOPILOT_EXECUTE_TRADES` | All execution | N/A (global) | None — same flag, same meaning |
| `AUTOPILOT_ALLOW_BUY` / `AUTOPILOT_ALLOW_SELL` | BUY / SELL independently | **Not free** — today only checked inside `autopilotWorker.ts`'s `analyzeTicker` (the baseline path), not inside `executeSafeTrade`/`evaluateTrade` | New code: mirror `analyzeTicker`'s exact check (`blockReasonCode: "BUY_DISABLED"`/`"SELL_DISABLED"`) in the rotation execution path |
| Peak-drawdown portfolio circuit breaker | BUY only | **Free** — structurally an `if (action === "BUY")` block inside `executeSafeTrade` (`server.ts`); cannot fire for a SELL | None — inherited automatically by routing through `executeSafeTrade` |
| Daily -5% kill switch | BUY only | **Free** — `evaluateTrade` (`riskManager.ts`) returns early for SELL before the drawdown check is reached | None — inherited automatically |
| Per-ticker / bucket concentration caps (`TICKER_TO_BUCKET`, `getSafeBuySharesForBucketCap`, etc.) | BUY sizing | N/A | **Explicitly NOT reused** — see the conflict below |

**Why bucket/position-fraction caps are not reused for ETF Rotation.** These caps were sized around the baseline's 13-ticker diversified universe: 20% per ticker, 40% per bucket (20% for the high-beta bucket). ETF Rotation's own weighting model conflicts with those numbers directly, not as an edge case: at the shipped default `holdCount=2`, each pick is deliberately sized to **50%** of equity; at `holdCount=3`, **33%**. Both already exceed the 20% single-ticker cap. Worse, if `QQQ` were added to `TICKER_TO_BUCKET`'s `us_broad` bucket alongside `SPY`, a `holdCount=2` rebalance that picks both would have its combined 100% target silently chopped to the bucket's 40% cap — directly undermining `decideRotationTargets`'s deliberate allocation, not a rare interaction.

Rotation's own `holdCount` (2–4 concentrated slots, each pass a trend filter or the slot goes to cash) is already a deliberate concentration control, fit for a small ETF universe rather than a stock-picking universe. Retrofitting caps designed for the other strategy would fight the strategy's own design instead of protecting it. This also means `QQQ` does not need to be added to `TICKER_TO_BUCKET` for rotation's sake — that map stays a baseline-only concern.

## 4. Rebalance state machine

Extend `etfRotationWorkerState.ts`'s existing persisted file — same fail-soft, `filePath`-overridable read/write pattern already used here and in `portfolioCircuitBreaker.ts`/`orderIdempotency.ts`, not a new storage mechanism — from:

```json
{ "lastRebalanceDateKey": "2026-07-14" }
```

to something like:

```json
{
  "lastRebalanceDateKey": "2026-07-14",
  "rebalanceMonthKey": "2026-07",
  "status": "executed",
  "startedAt": "2026-07-14T14:32:00.000Z",
  "completedAt": "2026-07-14T14:32:41.000Z",
  "plannedOrders": [ /* the RebalanceOrder[] computed this cycle */ ],
  "targets": [ /* the RotationTarget[] computed this cycle */ ]
}
```

`status` is one of `"planned" | "executing" | "executed" | "partial" | "failed" | "cancelled"`.

**The rule that fixes Stage 1's gap**: the monthly gate only treats a month as "done" (i.e. `isMonthlyRebalanceDate` sees a matching `lastRebalanceDateKey`/`rebalanceMonthKey` and skips recomputation) when `status` has reached a terminal success state — `"executed"`, or an explicitly accepted `"partial"`. It is **not** written immediately after `computeRebalanceOrders`, unlike Stage 1's current (correct-for-Stage-1, because nothing executes) shortcut. A crash or restart between `"planned"` and a terminal state leaves the gate open, so the next cycle can pick the rebalance back up rather than silently treating a half-finished month as done.

## 5. Order sequencing

1. Compute targets (`decideRotationTargets`) and orders (`computeRebalanceOrders`) exactly as Stage 1 does today. Persist `status: "planned"`.
2. Set `status: "executing"`, persist.
3. Execute all SELL legs first, through `executeSafeTrade`.
4. **Re-fetch a fresh portfolio snapshot** (`getPortfolioSnapshot()`) after the SELLs settle. This is new relative to Stage 1: Stage 1 computes everything off one upfront snapshot since nothing executes, but Stage 2 must not size BUYs against a cash figure that predates the SELLs that were just submitted — that risks over-committing cash that isn't actually free yet.
5. Resize/recompute BUY legs, if needed, against the actual available cash from the refreshed snapshot (not the original plan's assumed cash).
6. Execute BUY legs through `executeSafeTrade`.
7. Persist the terminal `status` (`"executed"`, `"partial"`, or `"failed"` — see §8) with `completedAt`.

## 6. Idempotency model

The existing `orderIdempotency.ts` tracker key is exactly `` `${TICKER}:${ACTION}` `` (uppercased), a flat `Record<string,string>` persisted to `data/order-idempotency-state.json`, with a single shared tracker instance for the whole process (also used by the baseline strategy).

**This document recommends *not* changing that shared key format.** A rebalance emits at most one order per ticker per action (never two SELLs or two BUYs for the same ticker in the same cycle), and cross-strategy collision is already prevented by `AUTOPILOT_STRATEGY`'s mutual exclusivity. Changing the shared key shape to add rotation-specific context would be a shared-code risk touched by both strategies, for no real gain here.

Instead, the richer context (config variant, rebalance month, leg type) belongs in the **new order-level audit log** (§7), which is purely additive and doesn't touch code the baseline path also depends on. `client_order_id` generation itself is unchanged — still `orderIdempotency.ts`'s existing `getOrCreate(ticker, action)`.

## 7. Order-level audit

New `etfRotationOrderAuditLog.ts`, copying `circuitBreakerAuditLog.ts`'s exact pattern: an append-only JSONL file (`data/etf-rotation-order-audit.jsonl`), one small module with an `append` function and a tail-safe, parse-and-skip-on-error `read` function — the same shape already proven for the circuit breaker's audit trail. This is a **new schema**, not a reuse of the breaker's event types (which are breaker-lifecycle-specific: tripped/reminder/reset).

Proposed event shape:

```ts
interface EtfRotationOrderAuditEvent {
  type: "ORDER_SUBMITTED" | "ORDER_FILLED" | "ORDER_REJECTED" | "ORDER_AMBIGUOUS";
  timestamp: string;
  rebalanceMonthKey: string;
  configVariantKey: string;   // e.g. "baseline-2"
  ticker: string;
  side: "BUY" | "SELL";
  legType: "liquidate_existing" | "rebuild_target" | "open_new" | "exit_removed";
  requestedQty: number;
  submittedQty?: number;
  clientOrderId?: string;
  brokerOrderId?: string;
  error?: string;
}
```

This is what makes a case like "SELL succeeded, BUY failed" visible after the fact — the per-ticker journal row from Stage 1 stays a decision-level summary (unchanged); this is a new, separate, execution-level layer underneath it.

## 8. Failure / retry behavior

- A **failed SELL blocks its paired BUY** for that ticker in that cycle. Buying into a new target position whose corresponding liquidation didn't clear would compound exposure rather than reduce it — the opposite of what the rebalance intended.
- A **failed BUY does not roll back its SELL**. This matches the existing system's general posture elsewhere (e.g. `riskManager.ts`'s SELL-always-allowed logic): never reverse an already-settled risk-reducing action just because a subsequent step failed.
- Ambiguous network errors reuse `classifyOrderError`'s existing three-way classification (`duplicate_client_order_id` / `definitive_rejection` / `ambiguous_network_error`) unchanged — no new error taxonomy needed.
- The cycle's terminal state (§4) is `"executed"` if every leg succeeded, `"partial"` if some legs succeeded and some failed, `"failed"` if none did. All three are surfaced for manual review (existing Telegram alert / SSE broadcast conventions), not auto-retried within the same cycle — a failed or partial rebalance waits for the next scheduled cycle to be reconsidered, the same way a blocked baseline signal does today.

## 9. Safety gates and circuit breaker behavior (restated)

Concretely, per order, the check order is:

1. `AUTOPILOT_STRATEGY === "etf_rotation"` (outer selector, already true to be in this code path at all).
2. `AUTOPILOT_EXECUTE_TRADES === true` (global execution gate).
3. `AUTOPILOT_ALLOW_BUY` / `AUTOPILOT_ALLOW_SELL`, checked per the order's actual side (**new code**, §3).
4. `executeSafeTrade` → `evaluateTrade`: daily kill switch (BUY only, free), then the peak-drawdown circuit breaker (BUY only, free).
5. No bucket/position-fraction cap check (§3) — deliberately absent for this strategy.

## 10. Paper-only rollout plan

Stage 2 ships behind exactly the same three existing env vars the baseline strategy already uses — `AUTOPILOT_EXECUTE_TRADES`, `AUTOPILOT_ALLOW_BUY`, `AUTOPILOT_ALLOW_SELL` — plus `AUTOPILOT_STRATEGY=etf_rotation` to select the path at all. No new gate concept is introduced. No Render environment change is part of this document or the eventual Stage 2 PR by default — flipping any of these remains a separate, later, explicitly-approved decision, exactly as it already is for the baseline strategy today.

## 11. Open questions before implementation

- **Mid-`"executing"` restart**: if the process restarts while `status` is `"executing"` (some legs submitted, some not), does the next cycle resume the same rebalance, or does it wait for the next scheduled month and treat the interrupted one as abandoned? Needs a decision before Stage 2 is implemented, not during.
- **`legType` granularity**: does the audit log actually need to distinguish "exit removed pick" from "liquidate for rebuild" (a continuing ticker's SELL leg before its BUY leg), or does that distinction only matter for human readability in the audit log, not for any behavior? If it's readability-only, it can be derived at write time from whether the ticker also has a paired BUY that cycle, without new decision logic.
- **`holdCount` sanity ceiling**: since bucket/position caps are bypassed for this strategy (§3), should `EtfRotationConfig` gain its own hard ceiling (e.g. reject a `holdCount` low enough that `100/holdCount` would exceed some fixed maximum), so a future config change can't silently create a single-ticker position larger than intended? Not resolved here — flagged for the Stage 2 implementation to decide explicitly rather than inherit implicitly.

## What this document does not do

It does not implement any of the above. It does not change `etfRotationWorkerState.ts`, `autopilotWorker.ts`, or any other code. It does not touch `.env` or Render's environment. Stage 2's actual implementation is a separate, future PR, following this design, still gated behind the same env vars and still requiring explicit approval before merge — and, per the standing project rule, no execution is ever performed on the user's behalf regardless of any of this.
