# Emergency Stop

Two independent ways to stop the autopilot worker, in order of speed. Use
whichever fits — they aren't mutually exclusive and can be combined (fast
stop now, durable stop to follow).

## Tier 1 — Immediate, no redeploy (in-memory, temporary)

`POST /api/autopilot` with `{ "enabled": false }` (admin-token gated, same
endpoint `server.ts:1328` uses for the dashboard's own autopilot toggle).

This flips an in-memory `enabled` flag that the worker's scheduled tick
checks before doing anything at all (`autopilotWorker.ts:1570-1585`): `if
(!enabled) return;` — when false, the **entire cycle** is skipped, not just
order execution. No bars are fetched, no signal is computed, nothing is
journaled.

**What it does and doesn't guarantee**:
- Takes effect on the *next* scheduled tick, not instantly — if a cycle is
  already mid-run when this is called, that in-flight cycle finishes; only
  future ticks are prevented. Since `AUTOPILOT_INTERVAL_MS` defaults to 1
  hour, "next tick" in practice means "no further cycles until someone turns
  it back on," not "wait up to an hour."
- **Not durable.** The flag lives in process memory only — a restart or
  redeploy resets it back to whatever `AUTOPILOT_ENABLED_DEFAULT` is
  configured to. If you need the stop to survive a deploy, also do Tier 2.

## Tier 2 — Durable, survives restarts/redeploys (env var)

Set `AUTOPILOT_EXECUTE_TRADES=false` in Render's environment variables and
redeploy.

This is read once at module load (`autopilotWorker.ts:237-238`) and gates
the final order-submission step inside each ticker's analysis
(`autopilotWorker.ts:1003-1011`) — when false, a signal-ready decision is
marked `executionStatus: "dry_run"` and `executeSafeTrade` is never called.

**Important distinction from Tier 1**: this does **not** stop the cycle
itself — bars are still fetched, signals still computed, decisions still
journaled, the circuit breaker still evaluated. It only guarantees no order
is ever actually submitted to Alpaca. If you want the entire cycle silent
(e.g., to stop burning Alpaca/Alpha Vantage API rate-limit budget too), use
Tier 1 as well.

**Requires a redeploy to take effect** (env vars are read at startup, not
polled) — this is minutes, not instant, which is why Tier 1 exists as the
fast path.

## Verifying a stop actually took effect

- Check `GET /api/autopilot/status` (or the dashboard) for the current
  `enabled` state and last-run timestamp — confirm no new run has started
  since the stop.
- Check `data/autopilot-decisions.jsonl` (via `GET /api/autopilot/journal`)
  for no new entries after the stop time.
- If stopping specifically because of a circuit-breaker halt or a suspected
  bad order, also check `GET /api/autopilot/circuit-breaker/review` (no
  admin gate, `server.ts:1081-1175`) for the current halted/blocked state,
  and `data/circuit-breaker-audit.jsonl` for the event trail.

## What this does not cover

Neither tier cancels **already-open orders or positions** at Alpaca — this
is a "stop the bot from doing anything new," not a "flatten the account"
switch. Closing existing positions, if ever needed, is a manual action in
the Alpaca dashboard or this app's manual-order UI (currently disabled by
the user on purpose, per `CLAUDE.md`) — not something Claude will do on the
user's behalf under any circumstance (standing hard boundary: never execute
a trade).
