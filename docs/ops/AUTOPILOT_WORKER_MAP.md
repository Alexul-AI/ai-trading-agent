# Autopilot Worker Structural Map

Structural reference for `backend/autopilotWorker.ts` (~2400 lines as of
2026-07-18), the live orchestration core of the paper-trading autopilot.
Written as Stage 1 (PR #52) of a staged refactor - see the roadmap at the
bottom. This is a fact-finding/reference document, not a design doc: it
describes what the file currently does and how its pieces depend on each
other, so a future extraction PR doesn't have to re-derive this from scratch.

**Scope note**: describes structure only. Does not itself change any
behavior. Line numbers drift as the file changes - this doc names blocks by
function/section, not exact line numbers, to stay useful longer.

## Top-level shape

1. **Imports** - from `strategyEngine.ts`, `decisionJournal.ts`,
   `etfRotationStrategy.ts`, `etfRotationWorkerState.ts`,
   `etfRotationExecution.ts`, `etfRotationOrderAuditLog.ts`, `agent.ts`
   (sentiment/insider fetches), `portfolioCircuitBreaker.ts`,
   `circuitBreakerAuditLog.ts`, `src/strategy/portfolioRegimeFilter.ts`,
   `autopilotWorkerLock.ts`, `src/strategy/portfolioSafety.ts`. Types come
   from `src/types/autopilotTypes.ts` (extracted in this PR) via an
   import-then-re-export block, matching `src/strategy/portfolioSafety.ts`'s
   own extraction precedent - existing consumers (e.g.
   `autopilotFilters.test.ts`) see no change.
2. **Module-level env-derived constants** - ~30 `const`s computed once at
   import time from `process.env` (e.g. `AUTOPILOT_STRATEGY`,
   `AUTOPILOT_EXECUTE_TRADES`, `AUTOPILOT_ALLOW_BUY`/`ALLOW_SELL`,
   `AUTOPILOT_INTERVAL_MS`, `AUTOPILOT_LOCK_STALE_AFTER_MS`,
   `AUTOPILOT_TICKERS`, `REGIME_BUCKETS`, `TICKER_TO_BUCKET`,
   `ETF_ROTATION_ACTIVE_CONFIG`, `AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT`,
   etc.). **Important for testing**: because these are `const`s evaluated at
   module load, not per-instance options, a test that needs a different
   value (e.g. `AUTOPILOT_STRATEGY=etf_rotation`) must set
   `process.env`/`vi.stubEnv()` *before* the module is first imported (a
   fresh module per test file, not a shared import) - see the
   characterization tests added in this PR for the working pattern.
3. **Module-level mutable caches** - `sentimentCacheByTicker`,
   `insiderCacheByTicker`, `barsCacheByTicker` (TTL-cached, keyed by
   `` `${ticker}:${days}` `` so the baseline and ETF-rotation paths' different
   warm-up windows can't collide). These are **process-lifetime singletons**,
   independent of any one `createAutopilotWorker()` instance - a
   consideration for a future extraction that wants to test in isolation.
4. **Standalone module-level functions remaining in `autopilotWorker.ts`**
   (declared before `createAutopilotWorker`, closure-free): `toIsoDate`,
   `getErrorMessage` (also duplicated in `analyzeTicker.ts` - a small,
   stateless utility, not worth sharing via a new module), `isSignalReadyDecision`
   (pure, shared), `mapExecuteSafeTradeResultToLegOutcome`/`mapEtfRotationExecutionStatusToRebalanceStatus`
   (now in `etfRotationCycle.ts`, re-exported), `fetchAlpacaBarsUncached`/
   `fetchAlpacaBars` (impure, shared by both paths - still here, injected into
   both extracted modules as `fetchBars`), `buildSignalKey` (pure, shared).
   Everything exclusively used by the baseline path (the sentiment/insider
   veto pairs, `shouldBlockNormalSellBelowAverageEntry`, `appendSafetyNote`,
   `calculateBarsSinceLastBuy`, plus the `sentimentCacheByTicker`/
   `insiderCacheByTicker` caches) moved into `backend/analyzeTicker.ts` in
   PR #54 - see below.
5. **`createAutopilotWorker(options)`** - a closure factory. Everything
   below lives inside it.

## `createAutopilotWorker`'s closure

### Mutable state (the `let`/`const Map` declarations at the top of the closure)

| Variable | Written by | Read by |
|---|---|---|
| `enabled` | `setEnabled` | `start`, `runOnce`, `getStatus` |
| `running` | `runOnce` only | `runOnce` (re-entrancy check), `releaseLockOnShutdown` (poll), `getStatus` |
| `timer` | `start`, `stop` | `start`, `stop` |
| `lastRunAt`, `lastJournalRunId`, `lastError`, `lastDecisions`, `lastCircuitBreakerState` | `runOnce` only | `runOnce` (internally), `getStatus` |
| `lastBuyAtByTicker`, `entryAtrPercentByTicker` | `analyzeTicker` (`backend/analyzeTicker.ts` since PR #54) only, via a passed-by-reference `Map` parameter | same - **baseline-path-only, untouched by ETF Rotation**. These two Maps stay declared in this closure (they must persist across cycles at worker-instance lifetime, not call-lifetime) even though the function that mutates them moved out - passing a `Map` by reference into an extracted function is identical to mutating it via closure capture, same object identity either way. |
| `lastTelegramSentAtBySignal` | both Telegram-sending helpers | both - **shared across both strategy paths** |

Each `createAutopilotWorker(options)` call gets its own fresh closure state -
no cross-instance state leakage, which is what makes constructing a
separate instance per characterization test safe.

### Functions inside the closure

- **`analyzeTicker`** - **extracted into `backend/analyzeTicker.ts` in
  PR #54**. Per-ticker pipeline: indicators → `decideTradeSignal` → safety
  caps → gates (guard/breaker/regime/sentiment/insider/confidence/quantity)
  → dry-run or live execution. Was the largest single function in the file.
  Bigger/riskier extraction than PR #53's, for two real reasons: it touches
  cross-cycle closure state (see the table above) and contains genuine
  SELL-path logic, which the user's standing rule says must not *change* -
  only relocate, proven unchanged. Verified via a golden-snapshot comparison
  (3 real fixtures - BUY_SIGNAL, SELL_SIGNAL, STOP_LOSS - run through the
  pre-extraction code first, then asserted byte-for-byte against the new
  standalone function) in `analyzeTicker.test.ts`, plus a direct unit test
  of `shouldBlockNormalSellBelowAverageEntry`'s pure predicate. **Real
  finding along the way**: that guard's own blocking branch is currently
  unreachable through the real `decideTradeSignal` pipeline -
  `strategyEngine.ts`'s own `downgradeNormalSellBelowAverageEntry` config
  (hardcoded `true`, never overridden anywhere in the repo) already
  downgrades any losing `SELL_SIGNAL` to `HOLD` one layer up, before this
  guard's inputs could ever match its trigger condition. Moved byte-for-byte
  regardless (dead code moved untouched is still zero behavior change, and
  it could become reachable later if that default changes) - not "fixed" as
  drive-by cleanup, since that would itself be a SELL-logic change. Also
  found: `options.tradeMode` (the actual paper/live execution safety switch)
  was nearly left out of the extracted function's params during initial
  drafting - caught by review before implementation, now an explicit,
  required `tradeMode` parameter. As with `runEtfRotationCycle`, every
  module-level constant `analyzeTicker` reads (including several used only
  by it, like `TICKER_TO_BUCKET`/`AUTOPILOT_SENTIMENT_FILTER_ENABLED`) stays
  in `autopilotWorker.ts` and is passed as an explicit parameter, matching
  PR #53's precedent exactly - this is what lets `analyzeTicker.test.ts` be
  a plain top-level import with no `vi.stubEnv`/dynamic-import setup.
- **`sendTelegramForNewSignalReadyDecisions`** / **`sendTelegramForFilterBlocks`** -
  cooldown-deduped Telegram sends, shared by both paths, mutate
  `lastTelegramSentAtBySignal`.
- **`runEtfRotationCycle`** - **extracted into `backend/etfRotationCycle.ts`
  in PR #53** (confirmed to have touched no baseline-only helper and no
  closure `let` variable, which is exactly what made the extraction
  low-risk). `autopilotWorker.ts` now only holds the `runOnce` call site
  that builds its params object (`config`, `configVariantKey`, `barsDays`,
  `warmupTradingDays`, `executionGates`, `fetchBars`, and the DI functions)
  from its own module-level constants/`options` and calls the imported
  function. The two mapping helpers
  (`mapExecuteSafeTradeResultToLegOutcome`/
  `mapEtfRotationExecutionStatusToRebalanceStatus`) moved with it (they're
  used only by it, and moving either into `etfRotationExecution.ts`/
  `etfRotationWorkerState.ts` instead would have created a coupling between
  those two sibling files that doesn't exist today) - `autopilotWorker.ts`
  re-exports both so `autopilotFilters.test.ts` needed zero changes.
- **`runOnce`** - the single public orchestrator: lock claim → portfolio
  snapshot → circuit-breaker update → strategy dispatch (`runEtfRotationCycle`
  vs. the per-ticker `analyzeTicker` loop) → daily-reminder check → journal
  write → SSE broadcast → Telegram sends. The only place that mutates
  `running`/`lastError`/`lastDecisions`/`lastRunAt`/`lastCircuitBreakerState`/
  `lastJournalRunId`.
- **`start`/`stop`** - arm/clear the `setInterval` scheduler.
- **`releaseLockOnShutdown`** (added PR #50) - bounded poll waiting for an
  in-flight cycle before releasing the worker lock on graceful shutdown.
- **`setEnabled`** / **`getStatus`** - the latter is a pure read of closure
  state, no I/O.

## ETF-rotation-path vs. baseline-path vs. shared

**Baseline-only**: `analyzeTicker`, `shouldBlockNormalSellBelowAverageEntry`,
the sentiment/insider veto pair, `calculateBarsSinceLastBuy`,
`appendSafetyNote` (all five now live in `backend/analyzeTicker.ts` since
PR #54), the `lastBuyAtByTicker`/`entryAtrPercentByTicker` closure maps
(still in `autopilotWorker.ts`, passed by reference), the regime-bucket
prefetch block inside `runOnce` (gated on `AUTOPILOT_STRATEGY === "baseline"`).

**ETF-Rotation-only**: `runEtfRotationCycle`,
`mapExecuteSafeTradeResultToLegOutcome`,
`mapEtfRotationExecutionStatusToRebalanceStatus` (all three now live in
`backend/etfRotationCycle.ts`, re-exported by `autopilotWorker.ts`), the
`ETF_ROTATION_*`-prefixed constants (still module-level in
`autopilotWorker.ts` - shared with `runOnce`/`getStatus`, threaded into
`runEtfRotationCycle` as explicit parameters).

**Shared by both**: `fetchAlpacaBars`/`fetchAlpacaBarsUncached` (different
`days` per path, same cache), `getErrorMessage`, `toIsoDate`,
`isSignalReadyDecision`, `buildSignalKey`, both Telegram-sending helpers,
`runOnce`/`start`/`stop`/`releaseLockOnShutdown`/`setEnabled`/`getStatus`,
and the `AUTOPILOT_EXECUTE_TRADES`/`AUTOPILOT_ALLOW_BUY`/`AUTOPILOT_ALLOW_SELL`
constants.

## Real, on-disk side effects (why PR #52 exists)

`runOnce()`/`runEtfRotationCycle()` touch several real files under
`backend/data/` - every one of the underlying functions already supports an
optional `filePath` override (matching this codebase's "fail-soft,
filePath-overridable" convention), but until this PR, `autopilotWorker.ts`'s
call sites never passed one, so a test calling the real `runOnce()` would
have corrupted or depended on live paper-trading state:

| Real file | Touched via | Seam added |
|---|---|---|
| `autopilot-worker.lock` | `tryClaimWorkerLock` (`runOnce`), `releaseWorkerLock` (`releaseLockOnShutdown`) | `options.testDataFilePaths.lockFilePath` (PR #52) |
| `circuit-breaker-state.json` | `updatePortfolioCircuitBreaker`, `recordReminderSent` | `options.testDataFilePaths.circuitBreakerStateFilePath` (PR #52) |
| `circuit-breaker-audit.jsonl` | `appendCircuitBreakerAuditEvent` (2 call sites: trip, daily reminder) | `options.testDataFilePaths.circuitBreakerAuditLogFilePath` (PR #52) |
| `etf-rotation-worker-state.json` | `readRebalanceStateStrict`, `recordRebalancePlanned`, `recordRebalanceExecuting`, `recordRebalanceTerminal` (2 call sites) | `options.testDataFilePaths.etfRotationStateFilePath` (PR #52) |
| `etf-rotation-order-audit.jsonl` | `appendEtfRotationOrderAuditEvent` (called once per submitted leg, inside `executeEtfRotationOrders`) | `options.testDataFilePaths.etfRotationOrderAuditLogFilePath` (PR #53 - **a real gap PR #52 missed**: none of its 3 characterization tests ever reached a real submitted leg, so this file kept writing to the live path until PR #53's own new tests - the first to exercise a real accepted execution - actually polluted the real file locally and got caught before merge) |
| `autopilot-decisions.jsonl` | `appendAutopilotRun` | `options.testDataFilePaths.journalFilePath` (PR #52, required adding a `filePath` param to `decisionJournal.ts`'s `appendAutopilotRun` too - it was the one sibling module missing this convention) |

`fetchAlpacaBars`/`fetchAlpacaBarsUncached` call the ambient global `fetch(...)`
directly (not an imported reference) - characterization tests intercept this
with `vi.stubGlobal("fetch", ...)` rather than a new DI seam, since no
`autopilotWorker.ts` source change is needed for that one. `runEtfRotationCycle`
itself now receives `fetchBars` as an explicit parameter (rather than reading
the module-level `fetchAlpacaBars` via closure), so its own direct tests
(`etfRotationCycle.test.ts`) inject canned bars straight through that
parameter and need no fetch stub at all.

All `testDataFilePaths` fields default to `undefined`, which every
underlying function already treats as "use the real file" - `server.ts`'s
real `createAutopilotWorker(...)` call site needs zero changes.

## Staged refactor roadmap

- **PR #52 (merged)**: characterization tests around `runOnce()`'s
  observable behavior + this map doc + the types extraction above. No
  module splitting yet.
- **PR #53 (merged)**: extract `runEtfRotationCycle` into
  `backend/etfRotationCycle.ts` (confirmed cleanly separable, see above).
  Along the way, found and fixed a real gap PR #52 missed - `appendEtfRotationOrderAuditEvent`
  had no `testDataFilePaths` seam, so real submitted-leg tests (which
  PR #52's own 3 characterization tests never exercised) would have
  written to the live `etf-rotation-order-audit.jsonl` - caught locally
  before merge when this PR's own new tests did exactly that.
- **PR #54 (this PR)**: extract the baseline `analyzeTicker` path into
  `backend/analyzeTicker.ts` - see the `analyzeTicker` bullet above for the
  `tradeMode`-omission and dead-code-SELL-guard findings from this PR.
  SELL-path logic itself was not changed, only relocated and verified
  unchanged via golden-snapshot comparison.
- **PR #55**: unify the confirmed real duplication between this file's own
  `fetchAlpacaBarsUncached` and `backend/src/market/alpacaMarketData.ts`'s
  `fetchDailyBarsForChart` (same Alpaca bars endpoint/params/pagination/sort
  pattern, different consumers/warmup windows) - deferred since merging is a
  behavior-consolidation change, not a pure move.
- **PR #56**: shrink `server.ts` further if still warranted.

Also noted, deliberately not acted on: `AutopilotDecisionLog` (this file) is
structurally similar to but independently-evolved from `decisionJournal.ts`'s
own `JournalDecision`, and `ExecutionStatus` is byte-for-byte duplicated as a
type union in both files. Not reconciled here - real duplication, but a
structural-mismatch risk not worth taking in a "foundation" PR.
