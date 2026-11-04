# ETF Rotation: bounded auto-recovery and escalation (spec, not implementation)

Generated: 2026-11-04. Status: **design/spec only - no code, config, env var or gate is changed by this document.**

## 1. Why this exists

The target operating model (ROADMAP.md, 2026-08-24 principle) is: *the operator approves policy, the bot performs ordinary recovery.* Two real incidents show the bot currently cannot, and that "a human will notice" is not a reliable recovery mechanism.

| | 2026-08-03 | 2026-10-01 |
|---|---|---|
| What happened | SELL accepted; paired rebuild BUY rejected (HTTP 403) because the SELL had not filled yet | Both SELLs accepted; Alpaca filled them 22.5s / 32.9s later; the 10s wait gave up, rebuild BUYs were (correctly) not sent |
| Resulting state | `partial` - a *terminal-success* status, so the month closed itself | `failed_needs_review` - blocked until a human calls `POST /etf-rotation/clear-review` |
| Time to recovery | 29 days, fixed by the next monthly rebalance, not by any recovery logic | **still unresolved after a month** (account 100% cash; the November rebalance was skipped because the block outranks a month change) |
| Reminders | daily, from 08-06 | daily from 10-01, one identical message per Jerusalem day, ~34 of them with no escalation, no age, no instruction |

The second incident was fail-closed exactly as designed (nothing was lost), but "not filled yet" was escalated to a human as if it were "unknown forever". The reminder mechanism repeats a message; it has no notion of how long a problem has been open or what the bot will do about it.

**Out of scope here:** raising the ramp cap, fractional sizing, delta-only, any live-money behavior. Auto-recovery in `TRADE_MODE=live` is a non-goal of this document (see section 8).

## 2. Principles

1. **Bounded**: every recovery has a finite attempt count and a finite age; after either, it stops and escalates. No infinite retry.
2. **Reconcile, never repeat**: act only after comparing three independent facts - the stored broker order IDs, the actual positions, and a fresh portfolio snapshot. Never re-run the whole cycle and never blindly re-submit a SELL.
3. **Fail-closed on disagreement**: if those facts do not tell one coherent story, the bot does nothing new and escalates to a human.
4. **No new trading authority hidden in an observability change**: escalation (section 6) ships first and gives the bot no new powers. Auto-continue (section 5) is a separate, default-off gate that needs explicit approval.
5. **Same safety chain**: every order a recovery sends goes through the existing path - `AUTOPILOT_EXECUTE_TRADES`/`ALLOW_BUY`, ramp cap, circuit breaker, risk manager, idempotency, market-hours gate (#89), audit log.

## 3. Failure classes and what the bot may do

| Class | Example | Today | Proposed |
|---|---|---|---|
| A. SELL accepted, fill unconfirmed | 2026-10-01 | `failed_needs_review`, human clear | **auto-resolvable** (section 5) |
| B. BUY rejected after a confirmed SELL | 2026-08-03 | `partial`, month closes, off-target reminder | out of the first version; needs `partial` semantics rethought (section 9, question 4) |
| C. Ambiguous network error on an order | classified `ambiguous_network_error` | `ambiguous` -> `failed_needs_review` | **stays human-only**: retrying a possibly-submitted BUY risks a duplicate |
| D. Market closed / clock unreadable | weekend `clear-review` | deferral since #89 (no state change) | no change needed |
| E. Process crashed mid-sequence (`executing` found on start) | redeploy during a cycle | `failed_needs_review`, never resumed | stays human-only |

## 4. New state: `awaiting_sell_fill`

A non-terminal status, distinct from `executing` (which means "a process died mid-sequence and nobody knows what happened") and from `failed_needs_review`:

- Entered when `waitForSellFill` returns `unconfirmed` for a SELL that **has a stored broker order ID**. (No ID means nothing to poll: stays `failed_needs_review`.)
- Persisted in the worker state next to the existing fields: `pendingSells: [{ ticker, brokerOrderId, requestedQty, submittedAt }]`, the frozen `targets` and `plannedOrders` of the interrupted cycle, `firstUnresolvedAt`, `lastCheckedAt`, `recoveryChecks`.
- **Blocking** like `failed_needs_review` for new rebalances (a month change must not silently overtake it), but **auto-resolvable**. Not in `TERMINAL_SUCCESS_STATUSES`; `isRebalanceMonthDone` stays false.
- A new gate action (for example `resume_awaiting_sell_fill`) in `decideEtfRotationGateAction`, checked after the corrupt/`executing` hazards and before the month check.

## 5. Resume algorithm (class A)

Runs at the start of an hourly cycle when the state is `awaiting_sell_fill` and `AUTOPILOT_ETF_ROTATION_AUTO_RECOVERY=true` (new gate, default off). The hourly cadence is the cooldown.

1. **Gates first.** Market-hours gate (#89), execution flags, circuit breaker (BUYs only), worker lock. Any of them closed -> defer, no state change.
2. **Re-poll** each stored order with the bounded wait from #88 (a hung request cannot hold the cycle).
3. **Read** a fresh portfolio snapshot and the open orders for the rotation universe.
4. **Reconcile per pending SELL:**

| Broker order | Position | Verdict |
|---|---|---|
| `filled` | gone / reduced by the filled qty | CONFIRMED |
| still open (`new`/`accepted`/`partially_filled`) | unchanged | WAIT (counts a check) |
| terminal-not-filled (`canceled`/`expired`/`rejected`) | still held | **needs review** - never re-submit the SELL blindly |
| `filled` | does not match (qty differs, unexplained holdings) | **needs review** |
| not found | any | **needs review** |

5. **If every pending SELL is CONFIRMED and no universe order is open:** continue with a **BUY-only** plan. The *targets* stay frozen from the original decision (a delay of hours must not flip the picks - that would be a second signal evaluation); the *sizes* are recomputed from the fresh equity and prices, through `computeRebalanceOrders` with the confirmed tickers' shares zeroed and only BUY legs kept. The plan never contains a SELL. Execution goes through `executeEtfRotationOrders` unchanged; the result maps to `executed`/`partial`/`failed` as today, and an `ambiguous` result becomes `failed_needs_review` (BUYs are never auto-retried).
6. **Limits (numbers proposed, to be confirmed - section 9):** at most one check per cycle; a pending state older than **1 trading day** triggers escalation level 2 (section 6); older than **3 trading days**, or any NEEDS-REVIEW verdict, becomes `failed_needs_review`.
7. **Never:** re-run the whole cycle, re-submit a SELL that has a stored broker ID, act on the stale `plannedOrders` sizes, retry an ambiguous BUY, or run when any gate above is closed.

Every transition writes an audit event (proposed: `SELL_RECOVERY_CHECKED`, `SELL_RECOVERY_CONFIRMED`, `SELL_RECOVERY_ESCALATED`) and a Telegram message saying what the bot found and what it will do next.

## 6. Escalation and SLA (ships first; no new trading authority)

Today: one identical message per Jerusalem day (`shouldSendEtfRotationOffTargetReminder`). It cannot tell the reader how long the problem has been open, what the bot will do, or what is needed from them - and a month of identical reminders produced no reaction. Repetition is not escalation.

Proposed levels, measured in **trading days unresolved** since `firstUnresolvedAt` (also for today's `failed_needs_review`):

| Level | When | Content |
|---|---|---|
| L0 | on entering the state | what failed, what the bot will do next, whether anything is needed from a human |
| L1 | daily | the same facts plus **age** ("day 3"), a different text each day, and the exact next action |
| L2 | after 1 trading day | `ESCALATION` prefix, sent twice a day in Israel daytime, includes what waiting costs (idle cash share, rebalances skipped) |
| L3 | after 3 trading days, or a monthly rebalance was missed | a banner in the dashboard (same pattern as the circuit-breaker banner) and `unresolvedForTradingDays` in `GET /etf-rotation/review` |

The channels today are Telegram plus a transient SSE notification that only reaches an open dashboard, and the bot cannot receive replies, so "did anyone see it" is unknown. See section 9 (questions 2 and 3).

## 7. Observability and tests

- `GET /etf-rotation/review` gains `awaitingSellFill { pendingSells, firstUnresolvedAt, recoveryChecks, verdicts }` and `unresolvedForTradingDays`.
- Unit tests: the full reconcile matrix; a hung status request; a stale or unknown order ID; position mismatch; partial fill; a gate closing mid-resume; the attempt and age limits; an ambiguous continuation never retried; the state surviving a restart.
- Characterization tests through `runOnce()` with temp state paths (the established seam), asserting the real `backend/data/` files are untouched.

## 8. Rollout (each step independent; each behavior change restarts the clean streak in GOLIVE_CRITERIA.md gate 2)

| Phase | What | Trading authority | Clean streak |
|---|---|---|---|
| 0 (done) | #87 diagnostics, #88 bounded wait, #89 market-hours gate | none new | - |
| 1 | Escalation/SLA (section 6) | **none** | not restarted (alerts only) |
| 2 | **Shadow mode**: in a stuck state the bot computes and reports what it *would* do (the reconcile verdict and the BUY-only plan), sends no orders | none | not restarted |
| 3 | Auto-continue for class A in **paper**, behind `AUTOPILOT_ETF_ROTATION_AUTO_RECOVERY` (default off, explicit user approval to enable) | bounded BUY-only continuation | restarted |
| 4 | Anything for `TRADE_MODE=live` | **separate design review; not covered here** | - |

**Verification before Phase 3.** A controlled drill in an *isolated* Alpaca paper account (never the main $88k track): run a second instance with a deliberately tiny `AUTOPILOT_ETF_ROTATION_SELL_FILL_TIMEOUT_MS` (e.g. 1000), so real fills of 1-30s are reported "unconfirmed" and the recovery path runs against the real broker, with real order IDs and real positions. Credentials for that account are the user's to create and manage.

## 9. Open questions for the user

1. **Limits.** Is "1 trading day -> escalate, 3 trading days -> human" right, or should the bot try longer/shorter?
2. **Escalation intensity.** Twice a day during Israel daytime from L2 - acceptable, or too noisy for a low-energy day?
3. **Acknowledgement.** Add an admin endpoint to acknowledge ("I know, do not nag for 24h") that silences repeats but never hides the status? Telegram is send-only, so without it the bot cannot tell "seen" from "not seen".
4. **Class B** (BUY rejected after a confirmed SELL, the 2026-08-03 case). A bounded retry needs `partial` to stop closing the month when the missing leg was definitively rejected, and only definitive (not ambiguous) rejections would qualify. In or out of the first version?
5. **Live.** Confirm the default stays: no auto-recovery in `TRADE_MODE=live` without its own review.

## 10. Non-goals

No change to the manual repair endpoint's semantics; no auto-retry of ambiguous orders; no change to ramp, gates, or any env value by this document; no auto-recovery for `executing`-after-crash; nothing here enables a gate.
