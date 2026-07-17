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
| `AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT` | BUY sizing | Per-leg, BUY only | Added post-PR #47b — see §12, "Paper execution ramp" |

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

Proposed event shape (superseded: `ORDER_FILLED` → `ORDER_ACCEPTED` - see PR #46's correction note below, added once implementation surfaced that "filled" overclaimed a fill-confirmation this design never actually has):

```ts
interface EtfRotationOrderAuditEvent {
  type: "ORDER_SUBMITTED" | "ORDER_ACCEPTED" | "ORDER_REJECTED" | "ORDER_AMBIGUOUS";
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

**PR #45 review note, not yet acted on**: currently `runEtfRotationCycle` fetches market-data bars for the whole universe *before* reading the strict rebalance state. Not a problem for PR #45 (no execution exists yet either way), but for the execution-wiring PR: if the bars fetch itself fails or is slow, a pending `corrupt`/`failed_needs_review` block never even gets evaluated that cycle - the cycle just errors out a different way instead. Worth reading state before fetching bars in that PR, so the block applies even when market data is temporarily unavailable. Flagged here rather than acted on now, to keep PR #45/#46's scope from growing.

**PR #46** built `etfRotationExecution.ts` - an isolated `executeEtfRotationOrders` adapter, fully dependency-injected so it never imports from `autopilotWorker.ts` or `server.ts` and is testable with zero real Alpaca calls. **Not imported or called from `autopilotWorker.ts` anywhere** - confirmed via `git diff --stat`. Implements SELL-legs-before-BUY-legs sequencing; per-leg `AUTOPILOT_ALLOW_BUY`/`AUTOPILOT_ALLOW_SELL` gates (a disallowed SELL also blocks its own paired BUY, same as a SELL that actually failed); a global `AUTOPILOT_EXECUTE_TRADES` off-switch blocking every leg uniformly; cash-aware BUY resizing against a *refreshed* portfolio snapshot taken after SELL legs settle, with a running cash pool decremented across multiple BUY legs in the same cycle; per-leg audit events for every *attempted* leg only; a pure `computeOverallExecutionStatus` that treats any ambiguous leg as the whole cycle's status regardless of what else succeeded.

**PR #46 correction (2026-07-16, caught in review before merge, not self-caught)**: the first version injected a parameter shaped exactly like the real `executeSafeTrade` (server.ts) and classified its outcome via a local `try`/`catch` (using `orderIdempotency.ts`'s `classifyOrderError` on a thrown error to detect `ambiguous_network_error` vs. `definitive_rejection`). **This does not actually work against the real function**: `executeSafeTrade`'s own inner `try`/`catch` (server.ts) already classifies ambiguous-vs-definitive internally to decide whether to clear the idempotency tracker, but its *outer* `try`/`catch` then collapses whatever was thrown into an identical `{ status: "error", reason: message }` for every case - the classification never reaches a caller. A wrapper written around the *unmodified* `executeSafeTrade` cannot recover this distinction from the outside; the information is genuinely gone by the time the function resolves. Fixed by inverting the contract: the adapter's injected dependency (renamed `submitOrderLeg`) must now return one of exactly three outcomes directly - `{ outcome: "accepted" | "rejected" | "ambiguous", ... }` - shifting the classification responsibility onto whatever produces that result. **This means the execution-wiring PR cannot simply pass `executeSafeTrade` in as-is** - it must either modify `executeSafeTrade` itself (or add a sibling function sharing its internals) to stop discarding the classification before wrapping it to match this contract, or the ambiguous path silently never fires once wired to something real. Documented directly in `etfRotationExecution.ts`'s file-level comment so this can't be missed by re-reading the design doc alone.

**Second correction in the same review**: `ORDER_FILLED` (the audit event) and `executedOrders`/`"executed"` (the adapter's result vocabulary) both overclaimed certainty the adapter doesn't have. The real `executeSafeTrade` returns immediately after `alpaca.createOrder(...)` resolves, with no fill-confirmation poll - "the broker accepted the order request" and "the order has filled" are different claims, and Stage 2's design says the monthly gate should only close on confirmed *terminal* execution, not on acceptance. Renamed throughout: `ORDER_FILLED` → `ORDER_ACCEPTED` (`etfRotationOrderAuditLog.ts`'s event union), `executedOrders` → `acceptedOrders`, status value `"executed"` → `"accepted"` (`etfRotationExecution.ts`). Deliberately did **not** rename `etfRotationWorkerState.ts`'s own `RebalanceStatus`'s `"executed"` value (already shipped in PR #43) - a future PR mapping this adapter's `"accepted"` result into that state machine's `"executed"` terminal status is a separate, visible decision to make explicitly in that PR, not one to imply now by reusing the same word across two layers with different actual meanings.

21 tests for this file (264/264 total across the whole suite), typecheck clean - covering the global gate, per-leg gates, SELL-before-BUY ordering, a failed SELL blocking its paired BUY while an unrelated ticker's BUY proceeds normally, all three audit-event outcomes (accepted/rejected/ambiguous) plus an unexpected thrown error from `submitOrderLeg` itself being treated as ambiguous (never a silent success or confident rejection), cash resizing (including the multi-leg cash-pool decrement), and confirming the adapter's return value has no state-machine side effects.

## PR #47 — wiring plan (2026-07-16)

Split into two PRs, per the same "isolated primitive before wiring" discipline used throughout (PR #43 before #44's endpoints, PR #46's adapter before this).

**PR #47a** (this PR) closes the one real gap PR #46's review found: `executeSafeTrade`'s outer `try`/`catch` (`server.ts:672-681`) collapsed `definitive_rejection` and `ambiguous_network_error` into an identical `{ status: "error", reason }` before a caller could ever see the difference - no wrapper written around the *unmodified* function could recover it. Fixed with a small, additive `ClassifiedOrderError extends Error` class: the inner `catch`'s two re-throw sites (`:622`, `:630`) now throw `new ClassifiedOrderError(classification, orderError)` instead of the raw error, and the outer `catch` includes `classification` in its returned object when applicable. Zero behavior change for any existing caller - all of them only ever read `status`/`reason`.

Also added two pure, directly-tested bridge functions in `autopilotWorker.ts` (not wired into `runEtfRotationCycle` yet - `executeEtfRotationOrders` still has zero call sites there, confirmed via `git diff --stat`):
- `mapExecuteSafeTradeResultToLegOutcome` - `executeSafeTrade`'s result → `etfRotationExecution.ts`'s `{ outcome: "accepted"|"rejected"|"ambiguous" }` contract.
- `mapEtfRotationExecutionStatusToRebalanceStatus` - the one deliberate vocabulary bridge: `"accepted"` → `"executed"`, `"partial"` → `"partial"`, `"failed"` → `"failed"`, `"ambiguous"` → `"failed_needs_review"` (same "stop, a human should look" posture already used for a restart-interrupted cycle), `"blocked"`/`"not_attempted"` → `"cancelled"` (nothing wrong, nothing attempted, let the gate reopen next cycle).

12 new tests (276/276 total), typecheck clean.

**PR #47b (2026-07-16)** actually wires `executeEtfRotationOrders` into `runEtfRotationCycle`'s `"proceed_to_plan"` branch - the first point in the whole ETF Rotation effort where `options.executeSafeTrade` is reachable from this path. Still requires `AUTOPILOT_STRATEGY=etf_rotation` + `AUTOPILOT_EXECUTE_TRADES=true` + the relevant side gate, none of which are set that way in Render.

Resolved the structural conflict flagged by PR #45's review note above (bars-fetch-before-state-read): `decideEtfRotationGateAction` (`etfRotationWorkerState.ts`) was widened to accept `monthKey: string | null`, with a new `"needs_month_key"` return value covering the case where none of the three restart hazards apply but `monthKey` isn't known yet. `runEtfRotationCycle` now calls `readRebalanceStateStrict()` and this function (with `monthKey: null`) at the very top, **before** `fetchAlpacaBars` - a corrupt/stale-executing/failed_needs_review state is now caught even on a day the market-data fetch itself would fail or hang. Only after bars are fetched and `monthKey` is derived does a second call (same `stateResult`, real `monthKey`) resolve to `"already_done_this_month"` or `"proceed_to_plan"`.

Inside `"proceed_to_plan"`, after the existing `recordRebalancePlanned(...)` call: `AUTOPILOT_EXECUTE_TRADES=false` returns the exact same dry-run decision shape Stage 1 already produced (unchanged); otherwise `recordRebalanceExecuting()` (the only place `"executing"` is written in this file) → `executeEtfRotationOrders(...)` via a `submitOrderLeg` wrapper around `options.executeSafeTrade` (using PR #47a's `mapExecuteSafeTradeResultToLegOutcome`) → `recordRebalanceTerminal(mapEtfRotationExecutionStatusToRebalanceStatus(...))` → real per-ticker decisions built from the adapter's four outcome arrays, mirroring the baseline path's own `finalStatus`/`executionStatus`/`executionBlockReasonCategory`/`executionBlockReasonCode` conventions. `ExecutionStatus` gained an `"ambiguous"` value (`autopilotWorker.ts`, `decisionJournal.ts`, `frontend/src/types.ts`) so an unconfirmed leg is never forced into a falsely-confident bucket.

**Verified against real live Alpaca data (portfolio/bars reads only) with a FAKE `executeSafeTrade` in every scenario - the real order-submission function was never called, in any scenario, at any point in this verification:**
1. `AUTOPILOT_EXECUTE_TRADES=false` (Render's actual current value) + a **throwing** stub → the stub was never invoked (would have crashed the process if it had been), decisions matched Stage 1's exact dry-run shape, state stayed `"planned"`, no audit file was written. Proves the broker path is physically unreachable when the flag is off, not merely told not to fire.
2. `AUTOPILOT_EXECUTE_TRADES=true` (local script env only, never Render) + a canned-success fake → confirmed `planned → executing → executed`, correct `ORDER_SUBMITTED`/`ORDER_ACCEPTED` audit events, and `executionStatus: "executed"` decisions with the broker-accepted-not-fill-confirmed wording intact.
3. Same local-only setup, fake portfolio holding existing SPY/QQQ (the real account holds neither yet, so this is the only way to exercise a same-ticker SELL+BUY pair) with the SPY SELL leg rejected → confirmed overall `"partial"`, the paired SPY BUY correctly blocked (`sellFailedTickers`), QQQ's SELL+BUY unaffected.
4. Same setup with the SPY SELL leg returning `ambiguous_network_error` → confirmed `"failed_needs_review"`, and a follow-up cycle (still local-only, still a throwing stub) confirmed the gate blocks quietly pre-bars-fetch with the stub never invoked and the audit log unchanged - the restart-hazard path works with a real execution-shaped history behind it, not just a freshly-planned state.
5. Baseline path (`AUTOPILOT_STRATEGY` unset) re-confirmed byte-for-byte unchanged (`v1.2-confluence-scoring`, no ETF Rotation state/audit files touched).

**Real finding from scenario 3/4, not previously anticipated**: `runEtfRotationCycle` builds exactly one `AutopilotDecisionLog` per universe ticker per cycle (an intentional Stage 1 constraint - two decisions for the same ticker would collide on the frontend's `` `${ticker}-${timestamp}` `` React key). When a ticker has **both** a SELL and a BUY leg this cycle (the "continuing top pick" liquidate-then-rebuy case) and the two legs land in different outcome buckets, the per-ticker decision only surfaces one of them, via `accepted ?? failed ?? ambiguous ?? blocked` precedence - in scenario 3, SPY's decision showed the failed SELL but said nothing about the paired BUY that was consequently blocked. Nothing is actually lost system-wide: the per-leg audit log (`etf-rotation-order-audit.jsonl`) and the `/review` endpoint both retain full fidelity for every leg, and the cycle's overall `status` (`"partial"`/`"failed_needs_review"`) is computed correctly regardless. But a human reading only the decision journal/Telegram summary for a "continuing pick" ticker would see just the worse-priority leg's outcome, not that its sibling leg was also affected. Flagged here as a known, accepted limitation of the existing one-decision-per-ticker design now that it has a real (not just dry-run) consequence for the first time - not fixed in this PR, since doing so would mean changing the per-ticker decision shape into a per-leg one, a larger change than this PR's wiring-only scope.

Merge criteria confirmed: `autopilotWorker.ts`/`etfRotationWorkerState.ts` (+ `etfRotationWorkerState.test.ts`, `decisionJournal.ts`, `frontend/src/types.ts`) are the only files touched (`git diff --stat`); `options.executeSafeTrade` has exactly one new call site (inside `submitOrderLeg`); `"executing"` is written in exactly one place; the monthly gate only closes on `"executed"`/`"partial"`. 281/281 backend tests, backend + frontend typecheck clean.

## Post-merge operational sequence (2026-07-16/17)

Following PR #47b's merge, three explicitly-approved operational steps were taken on the real Render deployment, each gated by its own separate confirmation (per the standing rule that a strategy-identity or execution-gate change is never bundled with a code merge):

- **Stage A** (read-only): confirmed via `GET /api/autopilot/status` and the journal that the deployed instance was still running the baseline strategy (`v1.2-confluence-scoring`), `tradeMode: paper`, execution disabled - nothing changed, verification only.
- **Stage B**: `AUTOPILOT_STRATEGY=etf_rotation` set in Render (execution gates still `false`). Confirmed via a real scheduled cycle: `strategyVersion: "etf-rotation-baseline-2"`, 5-ETF universe, `executionStatus: "dry_run"` on both BUY legs (SPY/QQQ), `etf-rotation/review` showed real `status: "planned"` for the first time - decision-only shadow confirmed working on the live account.
- **Stage C0** (execution-gate rehearsal, no broker order attempts): `AUTOPILOT_EXECUTE_TRADES=true` set in Render, **`AUTOPILOT_ALLOW_BUY=false`/`AUTOPILOT_ALLOW_SELL=false` left unchanged** - deliberately exercises the full `state → executeEtfRotationOrders → gates → audit` path for the first time in production without ever reaching a real broker submission. Confirmed via a real scheduled cycle: both BUY legs blocked with `AUTOPILOT_ALLOW_BUY is false` (`ETF_ROTATION_ORDER_BLOCKED`), rebalance state correctly transitioned to `"cancelled"` (not `"executed"`/`"partial"`, so the monthly gate stays open), and `etf-rotation-order-audit.jsonl` stayed empty - `submitOrderLeg`/`executeSafeTrade` were never invoked, proven by production behavior, not just a local stub.

This is the point at which the user (product/risk owner) paused before flipping `AUTOPILOT_ALLOW_BUY=true`: see §12 below.

## 12. Paper execution ramp (post-PR #47b)

**Motivation.** At the shipped default `holdCount=2`, a real BUY cycle deploys ~99% of the account into 2 positions (50% each) with **zero per-ticker/bucket concentration cap** (§3's "why bucket/position-fraction caps are not reused" applies in full here) and **no stop-loss mechanism at all** for this strategy - the only exit path is the next monthly rebalance, up to ~30 days out. The user judged the first real BUY too large a single step: it would simultaneously test execution plumbing, sizing, concentration, and monthly-horizon behavioral risk all at once. Decision: add a static, manually-configured cap on how much any single BUY leg can deploy, so the first real BUYs are small and controlled.

**What it is.** `AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT` - a new execution-time gate (a sibling of `AUTOPILOT_ALLOW_BUY`/`AUTOPILOT_EXECUTE_TRADES`, not a strategy-decision parameter - no change to `EtfRotationConfig`/`ETF_ROTATION_CONFIG_VARIANTS`). Enforced inside `executeEtfRotationOrders`'s BUY loop (`etfRotationExecution.ts`) as a sequential check *ahead of* the existing cash-affordability check, via a new pure `computeRampMaxShares(price, equity, rampMaxPositionEquityPercent)`: `undefined` → `Infinity` (uncapped, unchanged behavior); a percent → `floor((percent/100) * equity / price)` shares. The BUY request is first capped by ramp, then by cash - so a distinct, correctly-attributed block reason is possible for each ceiling (a ramp-caused block never gets mislabeled as a cash shortfall, or vice versa).

**Semantics that must not be misread: this is a per-position cap, not a per-cycle total.** At `holdCount=2`, a ramp of 10% caps *each* of the 2 legs independently to 10% of equity - so total capital deployed in a cycle is `holdCount × ramp%` (~20% for a 10% ramp at `holdCount=2`), not 10%. It is deliberately **not** a shared pool split across legs: the number of BUY legs that actually appear in a given cycle isn't fixed (a pick can fail the trend filter and drop to cash), so a shared pool would silently change per-position sizing based on how many picks happened to qualify that month - a per-leg cap against `equity` stays invariant regardless.

**Resolution is deliberately asymmetric, and that asymmetry is required, not accidental.** `resolveRampMaxPositionEquityPercent(raw)`: the env var genuinely absent → `undefined` (uncapped, current behavior - the safe default when nobody has opted in yet). But an env var *present* with an out-of-range or unparseable value (e.g. a fat-fingered `1000` or `-10`) **throws at module load**, rather than silently falling back to uncapped - unlike `resolveEtfRotationConfigVariant` (where falling back to the validated baseline *is* the safe direction), falling back to uncapped here is the one outcome this whole feature exists to prevent. A second, separate footgun this resolver closes: `"0"` (a deliberate, legitimate "block all BUYs via ramp" setting) must parse to `0`, not fall through to `undefined` the way a naive `raw || fallback` pattern (the existing style used for `AUTOPILOT_ETF_ROTATION_BARS_DAYS`) would.

**Where a ramp block is visible.** A full block-to-zero from ramp behaves exactly like an existing cash-block-to-zero already does: it is **not** written to `etf-rotation-order-audit.jsonl` (blocked/never-attempted legs never get an `ORDER_*` audit event, only attempted legs do), but **is** fully visible in `data/autopilot-decisions.jsonl` via `blockReason`/`executionBlockReasonDetail`. A ramp-*reduced-but-accepted* leg is visible via the existing `requestedQty`/`submittedQty` fields in both the audit log and, additionally, via a `" (ramp-capped from N)"` note appended to the decision's `reason` string (`autopilotWorker.ts`) so it's visible in the dashboard/Telegram summary without opening the audit log - computed by independently re-calling `computeRampMaxShares` with the same price/equity, rather than threading new state through `EtfRotationLegOutcome` (which is unchanged by this feature).

**Explicit non-goals.** Auto-escalating the percent over time (manual env-var edit only, same discipline as every other gate here). Bundling a `holdCount` change (kept as the only new variable this step, matching the same discipline already used for the BUY/SELL gate sequencing in Stage C0). Retrofitting baseline's bucket/position caps. Surfacing the resolved value in `getStatus()`/the frontend dashboard (left for a follow-up PR - `allowBuy` alone already touches 4 frontend files). Actually setting `AUTOPILOT_ALLOW_BUY=true` or choosing a ramp percentage in Render, both of which remain separate, later, explicitly-approved operational decisions.

**Tests**: 8 new cases in `etfRotationExecution.test.ts` covering ramp-unset regression (byte-identical to the pre-existing cash-resize test), ramp-tighter-than-cash, cash-tighter-than-ramp (confirms the cash-specific wording survives unaffected), ramp-exactly-zero (confirms `submitOrderLeg` is never called, via a throwing stub), two independent BUY legs each capped to their own ramp ceiling (proves "not a shared pool" - the most novel part of the design), a same-ticker SELL+BUY (`rebuild_target`) pair with ramp active, plus `computeRampMaxShares`/`resolveRampMaxPositionEquityPercent` unit tests including the `"0"` footgun case. 296/296 backend tests, typecheck clean.

## What this document does not do

Nothing merged so far, including this PR, sets a ramp percentage or `AUTOPILOT_ALLOW_BUY=true` in Render, and nothing touches `.env`/Render's environment from any of these PRs. The ramp mechanism this PR makes available in code stays inert (no effect on the current dry-run/gate-blocked behavior) until an operator explicitly sets both a ramp percentage and `AUTOPILOT_ALLOW_BUY=true` there - a separate, future, explicitly-approved operational decision, not implied by this PR's merge. Per the standing project rule, no execution is ever performed on the user's behalf regardless of any of this.
