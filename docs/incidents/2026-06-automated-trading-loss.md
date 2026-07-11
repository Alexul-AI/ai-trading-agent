# Incident: automated-trading loss, 2026-06-22 to 2026-06-29

Written 2026-07-11, retrospectively - well after the incident, and after
most of the safety architecture referenced below already existed. This is
reconstructed from what the project's own memory (`CLAUDE.md`) and Alpaca's
ledger record, not from contemporaneous incident notes, which don't exist.
Where the record is incomplete, this document says so rather than filling
the gap with a plausible-sounding guess.

## Summary

A ~$13,444 realized loss occurred on the paper trading account between
2026-06-22 and 2026-06-29, from over 1,100 buy/sell fills on a single ticker
(AMD), executed seconds apart. This predates the current `strategyEngine.ts`
and this session's safety work entirely, and was traced after the fact via
Alpaca's own JNLC ledger entry, not caught by any in-app alerting at the
time (none existed).

## Impact

- Paper account equity dropped from a $100,000 starting balance.
- No real capital was at risk - this was paper trading throughout.
- The practical impact was on *confidence in the paper-trading record*, not
  real money: it introduced an unexplained equity dip into the account's
  history that had to be traced and attributed before the paper track
  record could be trusted for anything.

## Timeline

- **2026-06-22 to 2026-06-29**: over 1,100 buy/sell fills on AMD, seconds
  apart, realizing the ~$13,444 loss.
- **Date not recorded**: the loss is noticed and traced to this specific
  window via Alpaca's JNLC ledger entry.
- **After discovery**: manual trading disabled (`ALLOW_MANUAL_TRADES=false`).
- **2026-07-09**: a session traces the historical loss to this incident
  (confirming it as unrelated to the strategy code active at the time of
  that session), adds cooldown logic to `strategyEngine.ts`, adds the first
  unit tests, and writes `GOLIVE_CRITERIA.md` specifically so future
  go-live decisions rest on measurable gates instead of "it's been running
  fine" gut-feel.
- **2026-07-11**: this postmortem is written, after a session that added a
  portfolio circuit breaker, bucket concentration cap, worker lock, order
  idempotency, a price-fallback fix, and reduced the autopilot's poll
  frequency - all of which independently narrow the space this kind of
  incident could recur in, even though none were built *because of* this
  specific incident (see "Root cause," below, for why).

## Root cause

**Not definitively identified - this is the most important gap in this
document, not glossed over.** What is confirmed:

- The firing pattern (1,100+ fills on one ticker within a single week,
  seconds apart) is **structurally incompatible** with `strategyEngine.ts`'s
  current cooldown logic (`cooldownBars`, `AUTOPILOT_COOLDOWN_MINUTES`) -
  today's code cannot reproduce this pattern by construction.
- This means the incident came from either: a prior version of the
  automated logic that didn't yet have cooldown enforcement, a bug in the
  manual-trading UI/endpoint causing a submission loop, or an external
  script hitting the Alpaca API directly - outside `strategyEngine.ts`
  entirely.
- None of these three possibilities can be confirmed or ruled out from what
  the project currently has on record. No logs, code snapshot, or
  contemporaneous notes from the incident window survive in this repo's
  history to distinguish between them.

## Contributing factors

- No cooldown enforcement existed yet in whatever logic actually fired the
  orders (confirmed by exclusion, not directly observed).
- No portfolio-level circuit breaker existed to halt trading on unusual
  drawdown velocity.
- No real-time alerting on fill frequency or realized-loss velocity - the
  loss ran for about a week before being noticed and traced.
- No idempotency/audit trail on order submission at the time.

## Why existing protections failed

They didn't fail - they didn't exist yet. Everything in "Corrective actions"
below was built after this incident (most of it much later, in the
2026-07-11 session, prompted by a broader hardening review rather than by
this incident specifically). This incident is the reason `GOLIVE_CRITERIA.md`
exists at all, but by the time most of the concrete protections were built,
their design was driven by that checklist's gates and a subsequent code
review, not by a fresh investigation into this specific event.

## What worked

- Paper trading meant the loss had zero real financial consequence.
- Alpaca's own ledger (the JNLC entry) preserved an auditable trail that
  made the loss traceable after the fact, even without in-app logging from
  the time.

## What did not work

- Nothing detected the runaway pattern *while it was happening* - it ran
  for approximately a week before being noticed.
- No mechanism existed to automatically halt trading on abnormal fill
  velocity or drawdown rate, regardless of what was causing it.

## Corrective actions taken

- **Immediate** (date not recorded): `ALLOW_MANUAL_TRADES=false` - manual
  trading disabled pending investigation.
- **2026-07-09**: cooldown logic added to `strategyEngine.ts`
  (`cooldownBars`, `AUTOPILOT_COOLDOWN_MINUTES`) - makes the exact observed
  firing pattern (1,100+ fills/week on one ticker) structurally impossible
  today, regardless of whether it addresses the original root cause.
  `GOLIVE_CRITERIA.md` created to replace informal judgment with checkable
  gates before any live-money decision. First unit tests added.
- **2026-07-11**: portfolio circuit breaker (`portfolioCircuitBreaker.ts`,
  halts new BUYs at -15% drawdown from peak, always on), bucket
  concentration cap (`getSafeBuySharesForBucketCap`, always on), a
  best-effort worker lock (`autopilotWorkerLock.ts`, guards against a
  same-host duplicate-process scenario), order idempotency
  (`orderIdempotency.ts`, `client_order_id` prevents a same-signal retry
  from double-submitting), a fix so a Alpaca price-quote failure rejects
  the trade instead of silently sizing the order against a fake $1 price,
  and a reduction in autopilot poll frequency (60s -> 1 hour, since
  strategy decisions are computed from daily bars and don't change
  intraday - less surface area for any rapid-fire failure mode).

## Regression tests

- `strategyEngine.test.ts` covers cooldown behavior directly.
- `portfolioCircuitBreaker.test.ts`, `autopilotWorkerLock.test.ts`,
  `orderIdempotency.test.ts`, and the bucket-cap tests in
  `autopilotFilters.test.ts` cover each new safeguard's own decision logic
  in isolation (100+ tests total as of 2026-07-11, see `CLAUDE.md`).
- **Important honesty note**: there is no test that reproduces the original
  incident end-to-end, because its root cause was never confirmed. The
  protection against a recurrence is *indirect* - several independent
  safeguards that would each interrupt a similar pattern today - not a
  *targeted* regression test proving the original bug is fixed, since the
  original bug itself was never precisely identified.

## Remaining risks

- If the original root cause was a class of bug not touched by any of the
  fixes above (e.g., something specific to a manual-trading code path that
  no longer exists, but could be reintroduced in a different form), it
  could theoretically recur without any of today's safeguards noticing
  until after the fact.
- The worker lock is explicitly best-effort and same-host-only (see
  `CLAUDE.md`) - it does not protect against a genuine multi-instance
  deployment.
- Live-mode has no extra friction yet beyond the existing env vars
  (`TRADE_MODE`, `AUTOPILOT_EXECUTE_TRADES`) - flagged as backlog item #14
  in the original hardening list, not yet built.
