# Paper Infrastructure Gate

Runbook for `docs/product/ROADMAP.md` Phase 3's 8-item "Paper Infrastructure
Gate" — the checks required before `AUTOPILOT_EXECUTE_TRADES=true`. This
document is a fact-finding/status snapshot (written 2026-07-15), not a
one-time sign-off: re-check anything marked ⚠️/❌ before actually flipping
`AUTOPILOT_EXECUTE_TRADES`, since code and Render config both drift over
time.

**Scope note**: this document only records current state and identifies
gaps. It does not change any code, threshold, or execution behavior.

## Status summary

| # | Item | Status |
|---|---|---|
| 1 | One worker instance | ❓ Not verifiable from the repo — needs a Render dashboard check |
| 2 | Persistent disk behavior | ⚠️ Partially confirmed (see below) |
| 3 | Restart with circuit breaker tripped | ⚠️ Unit-tested only, never observed against a real restart |
| 4 | Restart with pending/ambiguous order | ✅ Fixed 2026-07-15 — see below |
| 5 | Audit/journal survives deploy | ✅ Empirically confirmed |
| 6 | Alerts work after restart | ⚠️ Should work (state-backed), never observed live |
| 7 | No duplicate worker cycles | ⚠️ Logic exists and is tested, contingent on item 1 |
| 8 | Emergency stop documented | ✅ See `EMERGENCY_STOP.md` |

## 1. One worker instance

Not something the code can confirm on its own — no `render.yaml`, `Procfile`,
or other deploy-config file exists in this repository (checked root and
`backend/`); the Render service is configured entirely through Render's
dashboard.

**How to verify**: in the Render dashboard, open the backend service →
confirm its plan/scaling settings show exactly 1 instance (not autoscaling,
not multiple instances). This matters because every safety mechanism below
that says "same-host only" (the worker lock, the in-memory order-idempotency
tracker) provides **zero** protection if Render ever runs more than one
instance of this service with separate memory/disk.

**Status**: open until someone actually looks at the dashboard and records
the answer here.

## 2. Persistent disk behavior

**Confirmed**: the disk survives redeploys for this service — observed
empirically across roughly 10 redeploys in one session (per `CLAUDE.md`);
the audit log and decision journal (item 5) are direct evidence of this.

**Not confirmed**: whether the disk is *shared* across instances if this
service is ever scaled beyond one instance (see item 1). `autopilotWorkerLock.ts`'s
own code comment already states this is an open question, not assumed true.

All four disk-backed state files resolve their path the same way — relative
to `process.cwd()`, not an absolute/configured path:
- Circuit breaker state: `backend/portfolioCircuitBreaker.ts:4-5` →
  `data/circuit-breaker-state.json` (full overwrite via `fs.writeFile` each
  update, `portfolioCircuitBreaker.ts:148-151`).
- Circuit breaker audit log: `backend/circuitBreakerAuditLog.ts:4-5` →
  `data/circuit-breaker-audit.jsonl` (appended, `:31-37`).
- Decision journal: `backend/decisionJournal.ts:134-135` →
  `data/autopilot-decisions.jsonl` (appended per run, `:244-276`).
- Worker lock: `backend/autopilotWorkerLock.ts:4-5` → `data/autopilot-worker.lock`.

All four live in the same `data/` directory, so they rise or fall together
on the disk-persistence question — there's no reason to expect one survives
a redeploy differently than another.

## 3. Restart while circuit breaker is tripped

**Expected behavior**: the sticky-trip state (`applyStickyTrip`,
`portfolioCircuitBreaker.ts`) is written to `circuit-breaker-state.json` on
every change, so a restart should reload it and continue blocking new BUYs
(SELLs stay allowed) — this exact logic is unit-tested in isolation
(`portfolioCircuitBreaker.test.ts`).

**Not yet verified**: against a real process restart while genuinely
tripped. This has never happened in production paper trading (the breaker
has not tripped there), so this path has only ever been exercised by unit
tests, never end-to-end.

**How to test without waiting for a real -15% drawdown**: there's currently
no "force a trip" mechanism — only `POST /api/autopilot/circuit-breaker/reset`
exists (which clears a trip, not creates one). Testing this for real would
require either a temporary lowered threshold in a disposable test run, or
directly writing a tripped `circuit-breaker-state.json` and restarting the
process locally to confirm it loads and behaves correctly. Left as a
follow-up (candidate for PR B), not solved here.

## 4. Restart with pending/ambiguous order state

**This is a real, previously-undocumented gap, found while writing this
runbook — not a solved item.**

`orderIdempotency.ts`'s `client_order_id` tracker (`createClientOrderIdTracker`,
`:65-87`) is **in-memory only** — a plain `Map`, held in one process-lifetime
variable (`server.ts:225`). It is never written to disk. The three other
state files (circuit breaker, audit log, journal) all persist to `data/`;
this one does not.

**Concretely**: if the process restarts (a redeploy) while an order is in
the "ambiguous network error" state — submitted, but the response was lost
to a timeout/DNS/connection reset, so the tracker deliberately does **not**
clear the `client_order_id` (`orderIdempotency.ts`, the ambiguous-error
branch, `server.ts:611-618`) — a restart wipes that in-memory state. The new
process has no record that an order might already exist for that
ticker+action. If the autopilot cycle runs again for that ticker afterward,
it mints a **new** `client_order_id`, and Alpaca's own duplicate-ID rejection
(the mechanism this whole system relies on) has nothing to catch, since the
new ID doesn't match the old one. A genuine duplicate order becomes possible
in this specific, narrow window.

**Why this hasn't caused a problem yet**: `AUTOPILOT_EXECUTE_TRADES` is
`false`, so no real orders are being submitted — this window doesn't
currently exist in practice. It becomes live risk the moment paper execution
is turned on.

**Not fixed in this PR** (docs-only scope) — flagged as a concrete follow-up:
persisting the tracker (or at minimum, its ambiguous-pending entries) to
`data/`, the same way the other three state files already do, before
`AUTOPILOT_EXECUTE_TRADES=true` is ever set.

## 5. Audit/journal survives deploy

**Confirmed** — both `circuit-breaker-audit.jsonl` and
`autopilot-decisions.jsonl` have survived multiple real redeploys in
practice (same empirical evidence as item 2). Subject to the same open
question about multi-instance disk-sharing as item 2.

## 6. Alerts work after restart

Reminder logic (`shouldSendDailyReminder`, `lastReminderSentDate` field) is
part of the persisted circuit-breaker state, so it should correctly resume
its once-per-day cadence after a restart rather than re-firing or going
silent. This has not been observed against a real restart during an actual
halt (the breaker has never tripped in production), so it's a reasonable
inference from the state being persisted, not an empirical confirmation.

## 7. No duplicate worker cycles

`autopilotWorkerLock.ts` claim logic (`evaluateLockClaim`, `:27-55`): no
existing lock claims it; the same `ownerId` (a `randomUUID()` generated once
per process, `autopilotWorker.ts:206`) renews it; a foreign lock older than
`staleAfterMs` (default `AUTOPILOT_INTERVAL_MS * 3`, `autopilotWorker.ts:200-204`)
is reclaimed as presumed-crashed; anything else is refused. Checked once per
cycle (`tryClaimWorkerLock`, called from `autopilotWorker.ts:1228`), not on a
separate heartbeat timer. Unit-tested (`autopilotWorkerLock.test.ts`, 5
cases: no lock / same-owner renew / foreign-fresh refused / foreign-stale
claimed / exact-boundary-not-yet-stale refused).

The code's own comment (`autopilotWorkerLock.ts:7-13`) is explicit: this
protects against an old+new process briefly overlapping on the **same host**
during a deploy transition. It provides **no** protection if Render ever
runs genuinely separate instances with separate memory — which is exactly
item 1's open question. This item's real-world guarantee is only as strong
as item 1's answer.

## 8. Emergency stop documented

See `docs/ops/EMERGENCY_STOP.md`.

## Explicitly out of scope for this document

Per the roadmap and the discussion that produced this runbook, the following
are deliberately **not** part of this gate and not touched by it:
- Enabling paper execution (`AUTOPILOT_EXECUTE_TRADES=true`).
- Any strategy or circuit-breaker-threshold change.
- Auto-reset for the circuit breaker (multi-window research already found
  no reset policy is reliably safe across regimes — see `CLAUDE.md`).
- Promoting `candidate-hold3` to the ETF Rotation default.
- A live/production shadow-portfolio service.
- Expanding the tax export (`export-realized-pnl.ts`) into a full tax
  system — it exists to hand raw data to an accountant, not to compute a
  filing.
- The tax/accounting review itself (`docs/product/ROADMAP.md` Phase 0.5,
  items 1-5/7) — that's a required gate **before live capital**, but paper
  execution creates no real tax event, so it does not block this gate.
