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

`status` is one of `"planned" | "executing" | "executed" | "partial" | "failed" | "cancelled"` (see "Stage 2A — resolutions to §11" below for a sixth value, `"failed_needs_review"`, added to cover a restart found mid-`"executing"`).

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

## 11. Original open questions from Stage 2 design

**All three below were left unresolved in PR #41; each is resolved in "Stage 2A — resolutions to §11" immediately following this section.** Kept here verbatim as the historical record of what was originally asked, not as a currently-open list.

- **Mid-`"executing"` restart**: if the process restarts while `status` is `"executing"` (some legs submitted, some not), does the next cycle resume the same rebalance, or does it wait for the next scheduled month and treat the interrupted one as abandoned? Needs a decision before Stage 2 is implemented, not during.
- **`legType` granularity**: does the audit log actually need to distinguish "exit removed pick" from "liquidate for rebuild" (a continuing ticker's SELL leg before its BUY leg), or does that distinction only matter for human readability in the audit log, not for any behavior? If it's readability-only, it can be derived at write time from whether the ticker also has a paired BUY that cycle, without new decision logic.
- **`holdCount` sanity ceiling**: since bucket/position caps are bypassed for this strategy (§3), should `EtfRotationConfig` gain its own hard ceiling (e.g. reject a `holdCount` low enough that `100/holdCount` would exceed some fixed maximum), so a future config change can't silently create a single-ticker position larger than intended? Originally left unresolved in PR #41; resolved in Stage 2A below.

## Stage 2A — resolutions to §11 (2026-07-15)

All three open questions above are now resolved, ahead of any Stage 2B implementation code (still not started — this update is itself doc-only, same as the rest of this document).

**Mid-`"executing"` restart → manual-review-required, no automatic resume.** After a crash mid-sequence, local state cannot safely tell us which orders actually reached Alpaca, which filled, and which are still pending — reconstructing that reliably would need to reconcile against Alpaca's own order/position state, and an automatic resume that gets that reconciliation wrong risks a second layer of errors on top of the first. So: a process that finds `status: "executing"` left over from a previous run does **not** resume the rebalance. It marks the cycle `"failed_needs_review"` (a new terminal value, added to §4's status enum alongside `"executed"`/`"partial"`/`"failed"`/`"cancelled"`), sends the existing Telegram/SSE alert (same convention as circuit-breaker trip alerts), and leaves the monthly gate closed (no new BUYs/SELLs attempted) until a human clears it. **`failed_needs_review` blocks further ETF Rotation execution until manually cleared; it is not treated as a successful rebalance** — it does not satisfy §4's gate rule (only `"executed"` or an accepted `"partial"` does), so there is no ambiguity between this state and a completed rebalance.

**New, added to Stage 2B's scope**: a read-only `GET /api/autopilot/etf-rotation/review` endpoint, mirroring the existing `GET /api/autopilot/circuit-breaker/review` precedent exactly — surfaces the interrupted cycle's audit-log entries (§7) alongside a fresh, real `getPortfolioSnapshot()` read, so "manual review" means looking at one assembled view, not grepping the audit-log file and cross-referencing Alpaca's dashboard by hand. **The read-only review endpoint is not sufficient by itself** — Stage 2B must also include an admin-gated manual clear/reset action for `failed_needs_review`, requiring a `reason` field and writing an audit-log entry, mirroring the existing `POST /api/autopilot/circuit-breaker/reset` precedent (which already requires a non-blank reason and logs the reset). No automatic clear, and no manual state-file editing (e.g. via a Render shell), should be part of normal operation — the same reasoning that makes the circuit breaker's reset manual-only and reason-required applies here identically.

**`legType` granularity → audit-only, derived, no behavioral coupling.** Confirmed: `legType` exists purely for human readability in the audit log (§7) and never drives any execution decision. It is derived at write time — a ticker's SELL leg is logged as `"liquidate_existing"` if that same ticker also has a paired BUY leg in the same cycle's order list (i.e. it's being rebuilt, not exited), otherwise `"exit_removed"`; a BUY leg is `"rebuild_target"` if paired with a SELL, otherwise `"open_new"`. No new decision logic anywhere — this is a label computed from data the execution sequencer (§5) already has in hand.

**`holdCount` sanity ceiling → hard reject outside `2 ≤ holdCount ≤ universe.length`.** Note this collapses to a single rule, not two: "max slot weight ≤ 50%" (`100/holdCount ≤ 50`) is algebraically identical to `holdCount ≥ 2` — Stage 2B should implement it once, not as two separate checks that happen to agree today and could silently drift apart later. The upper bound (`holdCount ≤ config.universe.length`, currently 5) guards against a config that could never be satisfiable (asking for more concentrated slots than there are tickers to fill them). Enforced at **config-resolution time** (inside `resolveEtfRotationConfigVariant`, or as an assertion at the point each named config constant is defined in `etfRotationStrategy.ts`), throwing loudly at process startup rather than being checked per-cycle — this is a static property of whichever config variant is selected, not something that can change mid-run, so it belongs with this project's existing "fail fast and loud on a bad config" convention (e.g. `agent.ts` throwing at load if `OPENAI_API_KEY` is unset) rather than a runtime check repeated every rebalance.

## Stage 2B/2C implementation progress (2026-07-15)

**PR #43** (merged) built the foundational, no-execution-risk primitives from §4/§7/§11: the extended `etfRotationWorkerState.ts` state machine, `etfRotationOrderAuditLog.ts`, and `assertValidEtfRotationConfig`. Deliberately did not touch `autopilotWorker.ts` - Stage 1's live decision-only behavior was completely unchanged.

**PR #44** (this PR) added `GET /api/autopilot/etf-rotation/review` (read-only, no admin gate, same convention as the circuit-breaker review endpoint) and admin-gated `POST /api/autopilot/etf-rotation/clear-review` (§11's Stage 2A resolution - requires a non-blank `reason`, refuses with 409 unless the current state is actually `failed_needs_review`, writes an audit entry, transitions to `"cancelled"` via `recordRebalanceTerminal`). Also added: `readRebalanceStateStrict`, a fail-closed state reader distinguishing "no file yet" (safe, a normal first run) from "file exists but corrupt" (must not be silently treated as a fresh start - both the review endpoint and the future execution path use this, not the soft `getRebalanceState`); `configVariantKey` on the persisted state (so the review/clear endpoints and audit trail can report which config was active for the cycle in question); and `REBALANCE_MANUALLY_CLEARED` added to `etfRotationOrderAuditLog.ts`'s event union (a rebalance-lifecycle event, not an order leg, kept in the same log/reader so a review UI gets one merged timeline instead of stitching two files together). Verified against the real local server: the review endpoint returns real portfolio data with `status: null` (no rotation cycle has run there yet); the clear-review endpoint correctly 409s with no stuck rebalance and 400s on a missing/blank reason, matching the circuit-breaker reset endpoint's exact validation behavior.

**Two integration hazards flagged in review of PR #43, both now closed by PR #45 (2026-07-15):**

1. ~~The monthly gate must be fully replaced, not layered.~~ **Closed.** `autopilotWorker.ts`'s `runEtfRotationCycle` no longer calls `getLastRebalanceDateKey`/`isMonthlyRebalanceDate` at all (both removed from this file's imports) - replaced entirely by a new pure `decideEtfRotationGateAction(stateResult, monthKey)` (`etfRotationWorkerState.ts`), which composes `readRebalanceStateStrict` + `isRebalanceMonthDone` plus the two new restart-handling branches below into a single exhaustive decision.
2. ~~Fail-closed reads are now available but not yet consumed by any execution path.~~ **Closed.** `runEtfRotationCycle` now calls `readRebalanceStateStrict` every cycle (not the soft `getRebalanceState`/`getLastRebalanceDateKey`). A corrupt state file returns `"state_corrupt_fail_closed"` - the cycle alerts, returns HOLD/blocked decisions for every ticker, and does **not** write to the state file at all (verified: a corrupt file is left corrupt, never silently "fixed" by an overwrite). A leftover `status: "executing"` (a crash between planning and a future PR's execution) returns `"stale_executing_needs_review"` - transitions to `failed_needs_review` via `recordRebalanceTerminal`, alerts once, and (on all subsequent cycles) the now-`failed_needs_review` state returns `"blocked_failed_needs_review"`, which blocks quietly (no repeat alert) until a human clears it via `POST /api/autopilot/etf-rotation/clear-review` (PR #44).

**PR #45 also confirmed, by real verification against live Alpaca data, an accepted interim property from the Stage 2D plan's question 2**: since no execution path exists yet, a rebalance can never reach `"executed"`/`"partial"`, so `isRebalanceMonthDone` never returns true for the current month - every cycle within the month recomputes a fresh `"planned"` state (confirmed: running twice in the same month re-planned with a new `startedAt`, rather than skipping). This is expected and harmless (nothing executes, decisions are idempotent to recompute) and resolves itself once the execution-wiring PR makes `"executed"` reachable. Verified end to end for all five scenarios (fresh, same-month replan, corrupt, stale-executing, blocked failed_needs_review) plus baseline-path parity (`AUTOPILOT_STRATEGY` unset never touches the ETF Rotation state file at all) against real live Alpaca data - not mocked. 243/243 tests, typecheck clean. `executeSafeTrade` still has zero call sites in this function.

## What this document does not do

Neither this document nor PR #43/#44 wire anything into `autopilotWorker.ts`'s live `runOnce()`/`runEtfRotationCycle` path, call `executeSafeTrade`, or touch `.env`/Render's environment. Stage 2's actual order-execution wiring is a separate, future PR, following this design (and closing the two integration hazards above first), still gated behind the same env vars and still requiring explicit approval before merge — and, per the standing project rule, no execution is ever performed on the user's behalf regardless of any of this.
