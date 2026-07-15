# Paper Execution Start Plan

**This is a checklist, not an authorization.** It exists so that whenever the
decision to set `AUTOPILOT_EXECUTE_TRADES=true` is actually made, there's a
concrete sequence to follow instead of reasoning it out from scratch under
time pressure. Nothing in this document decides *when* that should happen,
changes any threshold, or grants permission - the decision itself stays
separate, explicit, and the user's alone. Writing this document changes no
code, no env var, and does not run any fire drill.

## 1. Pre-flight checklist (before touching `AUTOPILOT_EXECUTE_TRADES`)

- [ ] **Confirm which strategy will actually run.** `GET /api/autopilot/status`'s
      `strategyVersion` field is the ground truth - as of 2026-07-15 it
      reports `v1.2-confluence-scoring` (the original baseline strategy,
      `strategyEngine.ts`, 13-ticker universe), because `autopilotWorker.ts`
      does not import or call anything from `etfRotationStrategy.ts` - **ETF
      Rotation is not wired into any live/autopilot code path**, only into
      the standalone `backtest-etf-rotation*.ts` research scripts. Flipping
      `AUTOPILOT_EXECUTE_TRADES=true` today would start paper-trading the
      baseline strategy, not ETF Rotation. If the intent is to test ETF
      Rotation specifically (the actual subject of this project's Phase 2
      research), that integration must be built first - see
      `docs/product/ROADMAP.md` Phase 3's status note. Don't let this
      checklist's other items create a false sense that everything is ready
      when this one, most consequential fact hasn't been confirmed.
- [ ] Re-read `docs/ops/PAPER_INFRASTRUCTURE_GATE.md`'s current status summary
      in full - don't rely on memory of what it said on 2026-07-15. Confirm
      nothing has drifted (code changes, Render plan/config changes).
- [ ] **Item 6 (alerts surviving a real restart while halted)**: already
      explicitly accepted as a deferred risk for paper execution
      (`docs/ops/PAPER_INFRASTRUCTURE_GATE.md`, decided 2026-07-15) - no
      further action needed here for paper. That acceptance is scoped to
      paper only, though - if this checklist is ever being used to prepare
      for **micro-live** capital instead, item 6 must be revisited first
      (real observation or a deliberate fire drill), not carried forward
      silently.
- [ ] Confirm the Render service's disk/instance topology hasn't changed
      since the gate was last verified (still one instance, still has the
      persistent disk attached, still mounted at
      `/opt/render/project/src/backend/data`) - the gate's guarantees for
      items 1/2/7 are contingent on this topology, not permanent facts.
- [ ] Confirm `docs/product/ROADMAP.md` Phase 0.5 (tax/accounting gate) is
      understood as a **live-capital** gate, not a paper-execution one - its
      absence doesn't block this, but don't let that distinction blur into
      "nothing to do before live" later.
- [ ] Review the actual values of `AUTOPILOT_TICKERS`,
      `AUTOPILOT_MAX_DRAWDOWN_FROM_PEAK_PERCENT`,
      `AUTOPILOT_MAX_BUCKET_EQUITY_FRACTION`, `AUTOPILOT_ALLOW_BUY`/
      `AUTOPILOT_ALLOW_SELL`, and any BUY-side filter toggles
      (`AUTOPILOT_SENTIMENT_FILTER`, `AUTOPILOT_INSIDER_FILTER`,
      `AUTOPILOT_REGIME_FILTER`, `AUTOPILOT_ALLOW_FRACTIONAL_SHARES`) in
      Render's actual environment - confirm they're deliberate choices for
      this start, not stale defaults nobody re-checked.
- [ ] Confirm `TRADE_MODE=paper` and `ALLOW_MANUAL_TRADES=false` are still
      set exactly as expected - this plan is about paper execution only;
      nothing here should be read as preparing a live-mode switch.
- [ ] Confirm Telegram alerting is actually working right now (a recent
      real alert was received, not just "the code path exists") - this is
      the main channel for finding out something needs attention without
      having to poll the dashboard constantly.
- [ ] Confirm `GET /api/autopilot/circuit-breaker/review` currently reports
      not-halted, and `GET /api/autopilot/status` reports the expected
      `enabled`/`executeTrades` state *before* the change.

## 2. How to flip it (mechanical steps)

**`AUTOPILOT_EXECUTE_TRADES=true` alone is not sufficient** - confirmed via
a real 2026-07-15 check (see "Verification log" below): `AUTOPILOT_ALLOW_BUY`
and `AUTOPILOT_ALLOW_SELL` are separate gates (`autopilotWorker.ts:240-241`),
each defaulting to `false` unless explicitly set to the exact string
`"true"`, checked independently inside `analyzeTicker` (`:1023`/`:1033`)
*after* the `AUTOPILOT_EXECUTE_TRADES` check already passes. As of
2026-07-15 both are `false` - setting only `AUTOPILOT_EXECUTE_TRADES=true`
would still block every BUY and SELL with an explicit
"execution blocked" log line, not silently do nothing.

1. In the Render dashboard, set **all three** relevant to what should
   actually happen: `AUTOPILOT_EXECUTE_TRADES=true`, and `AUTOPILOT_ALLOW_BUY=true`/
   `AUTOPILOT_ALLOW_SELL=true` for whichever side(s) should be allowed to
   execute (both, typically, for a normal paper-execution start).
2. Trigger (or wait for) the resulting redeploy.
3. Confirm the change actually took effect - two independent checks, not
   just one:
   - Render's own deploy logs show the startup line
     `[SERVER] Autopilot: enabled / execution` (not `/ dry-run` -
     `server.ts:1373-1376`).
   - `GET /api/autopilot/status` reports `"executeTrades": true` **and**
     `"allowBuy"`/`"allowSell"` matching what was intended, in the
     response body (`autopilotWorker.ts`'s `getStatus()`).
4. Do not consider this "done" until both checks agree - a log line alone
   could reflect a stale deploy; the live status endpoint is the
   ground truth for what the running process actually believes right now.

## 3. What to watch in the first hours/days

- **`GET /api/autopilot/journal`** (or the dashboard's journal view) after
  each scheduled cycle - confirm decisions are being made and, for any
  signal-ready BUY/SELL, that `executionStatus` shows a real attempt
  (`executed`/`failed`/`blocked`), not still `dry_run` or `not_attempted`.
- **The first real order**, whenever it happens - cross-check it against
  Alpaca's own order history directly (not just this app's journal) to
  confirm the two agree. This is the actual moment the persisted
  order-idempotency mechanism (`docs/ops/PAPER_INFRASTRUCTURE_GATE.md`
  item 4) starts mattering for real, for the first time.
- **`GET /api/autopilot/circuit-breaker/review`** - check it periodically
  even when nothing seems wrong, not only after a Telegram alert - this is
  also the first real opportunity to observe item 6 (alerts/state surviving
  a restart while something is actually happening), if a redeploy happens
  to coincide with an active cycle.
- **Telegram channel** - trip alerts, daily halted-reminders (if it trips),
  reset confirmations, and rejected-order alerts should all be arriving as
  designed - the first few days are the cheapest time to notice if one of
  these silently isn't firing.
- **`data/order-idempotency-state.json` and `data/circuit-breaker-state.json`**
  (via Render's shell, if needed) - spot-check that these are actually being
  written and cleared as expected, not just trusting the code path works
  because it was tested in isolation.

## 4. Rollback

Don't re-derive this here - see `docs/ops/EMERGENCY_STOP.md` for the full
procedure. Summary only, as a pointer:
- **Fast, temporary**: `POST /api/autopilot {"enabled": false}` - stops the
  entire cycle on the next tick, doesn't survive a restart on its own.
- **Durable**: `AUTOPILOT_EXECUTE_TRADES=false` + redeploy - the one that
  actually holds across restarts.

If anything in section 3 looks wrong, prefer the fast stop first, investigate
from the journal/audit trail, then decide whether the durable stop is also
needed.

## 5. Success criteria for the first stretch

Not a new list - these are `GOLIVE_CRITERIA.md`'s existing gates, restated
here only as a pointer so this plan doesn't duplicate or drift from them:
gate 1 (continuous scheduled operation), gate 2 (sample size before any
live-readiness judgment), gate 3 (stop-loss/take-profit/position caps/bucket
cap/circuit breaker each observed firing correctly at least once), gate 4
(experimental filters excluded from the readiness read). Re-read
`GOLIVE_CRITERIA.md` directly when judging whether a given stretch of paper
execution actually clears these - this document doesn't restate their exact
wording so the two can't quietly diverge.

## Verification log

Real, dated pre-flight checks - not hypothetical. Append future checks here
rather than overwriting, so drift over time is visible.

**2026-07-15** (read-only `GET` requests against the live Render deployment,
no state changed):
- `GET /api/autopilot/status`: `enabled: true`, `executeTrades: false`,
  `allowBuy: false`, `allowSell: false`, `tradeMode: "paper"`,
  `strategyVersion: "v1.2-confluence-scoring"`, `tickers`: the 13-ticker
  baseline universe (not the 5-ETF Rotation universe) - **confirms ETF
  Rotation is not the live strategy today** (see the pre-flight checklist's
  first item, above).
- `GET /api/autopilot/circuit-breaker/review`: `tripped: false`,
  `drawdownFromPeakPercent: 0`, `positions: {}`, `cash: 88131.18`.
- `GET /api/portfolio`: `equity: 88131.18`, `positions: {}` (empty).
- `GET /api/orders`: `[]` (no open orders).
- **Reading**: the paper account is currently clean - no leftover positions
  or open orders from the 2026-06 runaway-script incident (`docs/incidents/2026-06-automated-trading-loss.md`)
  or anything else, fully in cash. Equity (~$88,131) is consistent with that
  incident's traced loss, not a new or separate issue.
- **Not verified in this pass**: Telegram alerting (no read-only way to
  confirm a real alert was recently received without sending a test one).

**Decision recorded alongside this check (2026-07-15)**: do not enable
execution now. ETF Rotation is not wired into `autopilotWorker.ts` - ETF
Rotation live-integration is the next major piece of work, to be scoped as
its own dedicated design effort (see `docs/product/ROADMAP.md` Phase 3),
not assumed to be a quick follow-up to this checklist.

## Explicitly out of scope for this document

- Deciding whether/when to set `AUTOPILOT_EXECUTE_TRADES=true`.
- Running a fire drill for `PAPER_INFRASTRUCTURE_GATE.md` item 6 - that's a
  separate, explicitly-approved action on live infrastructure if it happens
  at all, not something this checklist triggers.
- Any change to strategy, thresholds, or the circuit breaker.
- Anything to do with `TRADE_MODE=live` or real capital - entirely out of
  scope; see `docs/product/ROADMAP.md` Phase 0.5/4 and `GOLIVE_CRITERIA.md`
  for that, separately, later.
