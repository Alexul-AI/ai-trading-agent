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
| 1 | One worker instance | ✅ Confirmed 2026-07-15 — structurally guaranteed, not just observed (see below) |
| 2 | Persistent disk behavior | ✅ Confirmed 2026-07-15 |
| 3 | Restart with circuit breaker tripped | ✅ Restart-regression tested 2026-07-15 (simulated locally, not observed in a real production trip) |
| 4 | Restart with pending/ambiguous order | ✅ Code-fixed + restart-regression tested (PR #34); live-fire verification deferred to first real paper execution |
| 5 | Audit/journal survives deploy | ✅ Empirically confirmed |
| 6 | Alerts work after restart | 🟡 Accepted as deferred risk for paper (2026-07-15) - must be revisited before micro-live |
| 7 | No duplicate worker cycles | ✅ Materially addressed 2026-07-15 (bounded by topology); practical mitigation revised 2026-07-18 (shortened staleness window, not the graceful-shutdown code path - see item 7 below) |
| 8 | Emergency stop documented | ✅ See `EMERGENCY_STOP.md` |

## Current overall status (2026-07-15)

**All 8 items now have an explicit disposition for paper readiness: 7
materially addressed, 1 (item 6) consciously accepted as a deferred risk
scoped to paper only.** Deliberately not "8 of 8 closed" - item 6's deferral
is a decision with a scope and an expiry (revisit before micro-live), not a
resolution. Item 7 was originally (2026-07-15) bounded by the current
Render topology rather than a fix to the lock's own architecture. A real
production incident on 2026-07-18 (a routine redeploy orphaning the lock
for ~2 hours) prompted a graceful-shutdown release path (PR #50) - but
real-world SIGTERM delivery was never confirmed on this host (see item 7
below), so the operative fix that actually shipped is a shortened
staleness window (`AUTOPILOT_LOCK_STALE_AFTER_MS=600000`), not the
graceful-shutdown code itself. It remains best-effort/single-host-only by
design, not a real distributed lock.

Materially addressed:
1. Single Render instance — verified through the Scaling UI's "not
   supported for servers with disks" limitation.
2. Persistent disk — verified via the Render dashboard, mount path matches
   the code's own path construction exactly.
3. Circuit breaker restart persistence — local file-based regression
   tested.
4. Pending/ambiguous order idempotency — persisted and restart-regression
   tested.
5. Audit/journal persistence — documented and disk-backed.
7. Duplicate worker cycles — bounded by the current no-scaling Render
   topology plus the existing best-effort lock; not a distributed lock,
   and doesn't need to be one on this topology.
8. Emergency stop — documented (`EMERGENCY_STOP.md`).

Deferred (decided, not just open):
6. Alerts surviving a real restart/deploy while halted — **explicitly
   accepted as a deferred risk for paper execution (2026-07-15)**, not a
   dedicated fire drill. Reasoning: the mechanism this item would verify is
   notification continuity, not the safety mechanism itself - item 3
   already independently confirms new BUYs stay blocked across a restart
   regardless of whether a reminder fires on schedule. A fire drill would
   mean manually editing the live state file via Render's Shell to force a
   halt, then a real redeploy, purely to observe alert behavior - real
   action on production infrastructure for an observability question, not
   a capital-protection one. This service also redeploys on every merged
   PR, so if the breaker ever does trip during paper execution, a natural
   redeploy will likely occur during that window anyway, giving a real
   observation without manufacturing one. **This deferral is scoped to
   paper only - it must be explicitly revisited (fire drill or real
   observation) before micro-live capital, not silently carried forward.**

**What this does not mean**: it does not mean `AUTOPILOT_EXECUTE_TRADES`
should be turned on now - that remains a separate decision. It also does not
mean item 6 is closed - "accepted as deferred for paper" is a decision with
a scope (paper only), not a resolution of the underlying question.

## 1. One worker instance

**Confirmed 2026-07-15, via the Render dashboard (Scaling panel)**: not just
"currently 1 instance," but a **structural** guarantee - the dashboard
states outright, "Scaling is not supported for servers with disks." This
service (`ai-trading-agent`, Web Service, Node, Starter plan) has a
persistent disk attached, so Render itself disallows running more than one
instance as long as that disk stays attached. This is a stronger guarantee
than an observed-today setting - it can't silently drift to multi-instance
without someone first deliberately detaching the disk (which would also
break every persistence assumption in items 2/3/4/5, so it's not something
that could happen unnoticed).

This matters because every safety mechanism elsewhere in this document that
says "same-host only" (the worker lock, the order-idempotency tracker) was
previously an unverified assumption - it's now a confirmed, structurally
enforced one.

**Same dashboard check also confirmed the environment variables that matter
most here**: `TRADE_MODE=paper`, `ALLOW_MANUAL_TRADES=false`, and (as of this
writing) `AUTOPILOT_EXECUTE_TRADES=false` explicitly set in Render's
environment - consistent with every hard boundary in `CLAUDE.md`. This is a
2026-07-15 snapshot, not a permanent fact - re-check the actual value in
Render before ever flipping execution, rather than trusting this document.

**Caveat worth carrying forward**: if this service is ever scaled for
availability/performance reasons in the future, the disk would need to come
off first - at which point items 1, 2, 3, 4, 5, and 7 all need to be
re-examined from scratch (the whole local-disk state-file design assumes
single-instance). Not a concern today, but worth flagging so a future
"let's add another instance" decision doesn't silently reopen this gate.

## 2. Persistent disk behavior

**Confirmed**: the disk survives redeploys for this service — observed
empirically across roughly 10 redeploys in one session (per `CLAUDE.md`);
the audit log and decision journal (item 5) are direct evidence of this.

**Confirmed 2026-07-15, closing the previously-open question**: the
Render dashboard shows a 1 GB persistent disk mounted at
`/opt/render/project/src/backend/data`, with root directory set to
`backend`. Since `process.cwd()` for this service resolves to
`/opt/render/project/src/backend` (the configured root directory), and
every state file's path is built as `path.resolve(process.cwd(), "data")`
(see the four files listed below), the mount path **exactly matches** where
the code actually reads and writes - not a guess, a direct match between
the dashboard's own config and the code's own path construction. Combined
with item 1's confirmation (scaling structurally disabled while this disk
exists), the "is the disk shared across instances" question is now moot -
there's only ever one instance to share it with.

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

**Status: restart-regression tested (2026-07-15).** `portfolioCircuitBreaker.ts`'s
`readState`/`writeState` and the 4 functions that call them
(`updatePortfolioCircuitBreaker`, `resetPortfolioCircuitBreaker`,
`getPortfolioCircuitBreakerState`, `recordReminderSent`) gained an optional
`filePath` parameter (defaulting to the real state file - every production
call site is unaffected) specifically so this could be tested against a real
file instead of only in-process pure-logic tests. `portfolioCircuitBreaker.test.ts`
now covers: a tripped state written by a simulated "previous process" is read
back with nothing lost (`tripped`/`trippedAt`/`lastReminderSentDate` all
intact); a fresh `updatePortfolioCircuitBreaker` call against that same file,
fed equity that's recovered above the peak (which `evaluatePortfolioDrawdown`
alone would call "not tripped"), still returns `tripped: true` with the
original `trippedAt` preserved - the sticky rule survives a restart, not just
one process's lifetime; and `resetPortfolioCircuitBreaker` correctly clears
`tripped`/`trippedAt`/`lastReminderSentDate` together, verified by reading
the file back afterward.

**What this is, precisely**: a real file-based regression test simulating a
restart locally (write state → construct as if a fresh process → read/act on
it), not an observed real Render redeploy while genuinely tripped in
production - the breaker has never actually tripped there. That gap (an
actual production restart-while-tripped event) can only be closed by
observation over time or a deliberate live-fire drill, not by more unit
tests - noted here so the distinction isn't lost.

## 4. Restart with pending/ambiguous order state

**Status: code-fixed / restart-regression tested (PR #34, 2026-07-15).
Live-fire paper verification: deferred until `AUTOPILOT_EXECUTE_TRADES=true`.**

`orderIdempotency.ts`'s `client_order_id` tracker was in-memory only (a plain
`Map`, held in one process-lifetime variable, `server.ts:225`) - unlike the
other three state files (circuit breaker, audit log, journal), which all
persist to `data/`. A restart during the "ambiguous network error" window
(order submitted, response lost to a timeout/DNS/connection reset - the
tracker deliberately does **not** clear the `client_order_id` in this case)
would wipe that in-memory record; a subsequent retry would mint a **new**
`client_order_id`, and Alpaca's own duplicate-ID rejection - the mechanism
this whole system relies on - would have nothing to catch, since the new ID
doesn't match the old one. A genuine duplicate order was possible in this
specific, narrow window.

**Fixed**: `createClientOrderIdTracker` gained an optional `initialState`
param and a `snapshot()` method; a new `createPersistedClientOrderIdTracker`
wraps it with a fail-soft read/write layer against
`data/order-idempotency-state.json`, mirroring `portfolioCircuitBreaker.ts`'s
own state-file pattern. `getOrCreate`/`clear` on the persisted tracker are
async and **await** the disk write before returning, so the durability
guarantee holds even if the process crashes immediately after. `server.ts`
constructs it via a top-level `await`.

**Tested**: `orderIdempotency.test.ts` includes a real restart-scenario
regression test (a real temp file, not a mock) - a pending entry left by a
simulated "previous process" is read back and honored (same `client_order_id`
returned), not replaced with a fresh one.

**Not yet done, and explicitly called out rather than implied**: this has
never been exercised against a real order submission, because
`AUTOPILOT_EXECUTE_TRADES=false` means no real orders are placed at all right
now. "Restart-regression tested" describes the persistence mechanism in
isolation, not an end-to-end confirmation against Alpaca's real broker path.
That confirmation is deferred to whenever paper execution is actually turned
on - the first real order-submission cycle (or a deliberate fire drill around
that time) is the natural point to watch this path fire for real, not
something to simulate further here.

## 5. Audit/journal survives deploy

**Confirmed** — both `circuit-breaker-audit.jsonl` and
`autopilot-decisions.jsonl` have survived multiple real redeploys in
practice (same empirical evidence as item 2). The multi-instance
disk-sharing question that used to qualify this is now closed (see item 1) -
there's only ever one instance for this disk to belong to.

## 6. Alerts work after restart

**Status: accepted as a deferred risk for paper execution (2026-07-15).
Not a fire drill, not a resolution - revisit before micro-live.**

Reminder logic (`shouldSendDailyReminder`, `lastReminderSentDate` field) is
part of the persisted circuit-breaker state, so it should correctly resume
its once-per-day cadence after a restart rather than re-firing or going
silent. This has not been observed against a real restart during an actual
halt (the breaker has never tripped in production), so it's a reasonable
inference from the state being persisted, not an empirical confirmation.

**Decision and reasoning (2026-07-15)**: rather than run a controlled fire
drill to close this now, the risk is explicitly accepted for the paper
stage. What this item would verify - alert/notification continuity - is
distinct from the actual safety mechanism (new BUYs staying blocked across
a restart), which item 3 already confirms independently via a real
file-based regression test. A fire drill to close this item specifically
would mean manually forcing a halted state onto the live Render disk (via
its Shell) and triggering a real redeploy purely to watch alert behavior -
a deliberate action on production infrastructure whose payoff is
observability, not capital protection. This service also redeploys on
every merged PR, so if the breaker ever genuinely trips during paper
execution, a natural redeploy is likely to land during that window anyway,
producing a real observation without manufacturing one.

**Explicit scope of this decision - not a general "good enough forever"**:
this acceptance applies to the paper stage only. Before any micro-live
capital, this must be revisited - either via a real observed occurrence
during paper trading, or a deliberate, separately-approved fire drill at
that point. Carrying this deferral forward silently into the live-readiness
discussion would be exactly the kind of judgment-call drift `GOLIVE_CRITERIA.md`
exists to prevent.

## 7. No duplicate worker cycles

`autopilotWorkerLock.ts` claim logic (`evaluateLockClaim`): no
existing lock claims it; the same `ownerId` (a `randomUUID()` generated once
per process, `autopilotWorker.ts`'s `WORKER_OWNER_ID`) renews it; a foreign lock older than
`staleAfterMs` (default `AUTOPILOT_INTERVAL_MS * 3`) is reclaimed as presumed-crashed; anything else is refused. Checked once per
cycle (`tryClaimWorkerLock`, called from inside `runOnce()`), not on a
separate heartbeat timer. Unit-tested (`autopilotWorkerLock.test.ts` - both
the pure `evaluateLockClaim` cases, and, added 2026-07-18, real I/O-level
tests for `tryClaimWorkerLock`/`releaseWorkerLock` against a temp lock
file). (Note: this item's earlier `autopilotWorker.ts:206`/`:1228`-style
line references have drifted from actual current line numbers due to
unrelated ETF Rotation work landing since - referring to function/constant
names above instead of line numbers to avoid the same staleness recurring.)

The code's own comment (top of `autopilotWorkerLock.ts`) is explicit: this
protects against an old+new process briefly overlapping on the **same host**
during a deploy transition. It provides **no** protection against genuinely
separate instances with separate memory - that hasn't changed and isn't
being claimed to have changed.

**Materially addressed 2026-07-15 (bounded by topology). A real production
incident on 2026-07-18 prompted a code fix that turned out not to be the
thing that actually helped - worth recording precisely so the next person
doesn't rely on the wrong mechanism.**

**The incident**: a routine `AUTOPILOT_ALLOW_BUY`/ramp env-var redeploy left
the old process's lock file behind with a stale-looking heartbeat, and the
new process correctly refused to double-claim it - blocking every
scheduled autopilot cycle for ~2 hours (the full default staleness window)
even though the old process was genuinely dead. This empirically confirmed
Render's persistent disk **is** shared across the old/new process pair
during a redeploy on this service (the open question `CLAUDE.md` had prior
to this).

**PR #50 (same day)** added a graceful-shutdown release path: a normal
`SIGTERM` (which Render is documented to send before killing a container
during a redeploy) should release the lock immediately via
`releaseWorkerLock`/`releaseLockOnShutdown` (`server.ts`'s new `SIGTERM`/
`SIGINT` handler, with a bounded 250ms/8s poll so an in-flight cycle isn't
cut off sooner than Render's own grace period would). The logic is correct
and verified locally via direct function-level tests (idle/fast-cycle/
slow-cycle cases, all pass).

**But real-world signal delivery was never confirmed, and the evidence now
points the other way.** Across ~2 hours of production logs spanning
multiple real redeploys - including deliberately changing the Start
Command from `npm start` to `node dist/server.js` directly, specifically to
rule out npm's own signal-forwarding as the cause - the string
`[SERVER] Received SIGTERM` never appears once. Two separate manual
`run-once` checks after real redeploys both showed the lock still held by
a different, unreleased `ownerId`. The most likely explanation: Render, on
this service's plan/tier, does not deliver a catchable `SIGTERM` to this
process before terminating it - a platform-level constraint this
codebase cannot control, not a defect in the shipped code.

**The mitigation that actually shipped (2026-07-18, same day)**:
`AUTOPILOT_LOCK_STALE_AFTER_MS=600000` (10 minutes), set directly in
Render - no code dependency, no reliance on signal delivery. Real cycles
take ~1.6-2s, so 10 minutes retains a huge safety margin against two
instances genuinely overlapping, while bounding "stuck after a routine
redeploy" to ~10 minutes instead of ~3 hours, unconditionally. This is the
mechanism actually protecting cycle scheduling today - not PR #50's
SIGTERM handler, which should be treated as dormant-but-harmless on this
host rather than load-bearing. (Confirming the 10-minute window itself
behaves as expected still needs a real future stuck-lock occurrence to
observe - not yet directly demonstrated at time of writing, only inferred
from the staleness-check code path, which is unconditional and doesn't
depend on any of the same unresolved signal-delivery questions.)

Still best-effort and single-host-only by design, not a real distributed
lock, and still reopens if this service is ever scaled (item 1's own
caveat).

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
