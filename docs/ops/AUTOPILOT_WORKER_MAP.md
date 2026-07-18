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
4. **Standalone module-level functions** (declared before
   `createAutopilotWorker`, closure-free): `toIsoDate`, `getErrorMessage`,
   the sentiment veto pair (`evaluateSentimentVeto` pure /
   `getBuySentimentVeto` impure wrapper), the insider veto pair
   (`evaluateInsiderVeto` pure / `getBuyInsiderVeto` impure wrapper),
   `shouldBlockNormalSellBelowAverageEntry` (pure, baseline-only),
   `appendSafetyNote` (pure), `isSignalReadyDecision` (pure, shared),
   `mapExecuteSafeTradeResultToLegOutcome`/`mapEtfRotationExecutionStatusToRebalanceStatus`
   (pure, ETF-rotation-only bridging functions), `fetchAlpacaBarsUncached`/
   `fetchAlpacaBars` (impure, shared by both paths), `calculateBarsSinceLastBuy`
   (pure, baseline-only), `buildSignalKey` (pure, shared).
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
| `lastBuyAtByTicker`, `entryAtrPercentByTicker` | `analyzeTicker` only | `analyzeTicker` only - **baseline-path-only, untouched by ETF Rotation** |
| `lastTelegramSentAtBySignal` | both Telegram-sending helpers | both - **shared across both strategy paths** |

Each `createAutopilotWorker(options)` call gets its own fresh closure state -
no cross-instance state leakage, which is what makes constructing a
separate instance per characterization test safe.

### Functions inside the closure

- **`analyzeTicker`** (baseline path) - per-ticker pipeline: indicators →
  `decideTradeSignal` → safety caps → gates (guard/breaker/regime/sentiment/
  insider/confidence/quantity) → dry-run or live execution. The largest
  single function in the file. Mutates `lastBuyAtByTicker`/
  `entryAtrPercentByTicker`.
- **`sendTelegramForNewSignalReadyDecisions`** / **`sendTelegramForFilterBlocks`** -
  cooldown-deduped Telegram sends, shared by both paths, mutate
  `lastTelegramSentAtBySignal`.
- **`runEtfRotationCycle`** (ETF Rotation path) - the second-largest
  function. Restart-hazard gate check → bars fetch → warmup check →
  target/order computation → plan-record → dry-run stub or live execution
  via `executeEtfRotationOrders` → terminal-status record → per-ticker
  decision-log construction. **Confirmed to touch no baseline-only helper
  and no closure `let` variable** - it only needs the `portfolio` param, a
  subset of `options`, the shared `fetchAlpacaBars`, and ETF-rotation
  constants. This is why PR #53 (extracting it into its own module) is
  expected to be low-risk.
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
`appendSafetyNote`, the `lastBuyAtByTicker`/`entryAtrPercentByTicker` closure
maps, the regime-bucket prefetch block inside `runOnce` (gated on
`AUTOPILOT_STRATEGY === "baseline"`).

**ETF-Rotation-only**: `runEtfRotationCycle`,
`mapExecuteSafeTradeResultToLegOutcome`,
`mapEtfRotationExecutionStatusToRebalanceStatus`, the
`ETF_ROTATION_*`-prefixed constants.

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

| Real file | Touched via | Seam added in PR #52 |
|---|---|---|
| `autopilot-worker.lock` | `tryClaimWorkerLock` (`runOnce`), `releaseWorkerLock` (`releaseLockOnShutdown`) | `options.testDataFilePaths.lockFilePath` |
| `circuit-breaker-state.json` | `updatePortfolioCircuitBreaker`, `recordReminderSent` | `options.testDataFilePaths.circuitBreakerStateFilePath` |
| `circuit-breaker-audit.jsonl` | `appendCircuitBreakerAuditEvent` (2 call sites: trip, daily reminder) | `options.testDataFilePaths.circuitBreakerAuditLogFilePath` |
| `etf-rotation-worker-state.json` | `readRebalanceStateStrict`, `recordRebalancePlanned`, `recordRebalanceExecuting`, `recordRebalanceTerminal` (2 call sites) | `options.testDataFilePaths.etfRotationStateFilePath` |
| `autopilot-decisions.jsonl` | `appendAutopilotRun` | `options.testDataFilePaths.journalFilePath` (required adding a `filePath` param to `decisionJournal.ts`'s `appendAutopilotRun` too - it was the one sibling module missing this convention) |

`fetchAlpacaBars`/`fetchAlpacaBarsUncached` call the ambient global `fetch(...)`
directly (not an imported reference) - characterization tests intercept this
with `vi.stubGlobal("fetch", ...)` rather than a new DI seam, since no
`autopilotWorker.ts` source change is needed for that one.

All `testDataFilePaths` fields default to `undefined`, which every
underlying function already treats as "use the real file" - `server.ts`'s
real `createAutopilotWorker(...)` call site needs zero changes.

## Staged refactor roadmap

- **PR #52 (this PR)**: characterization tests around `runOnce()`'s
  observable behavior + this map doc + the types extraction above. No
  module splitting yet.
- **PR #53**: extract `runEtfRotationCycle` into its own module (confirmed
  cleanly separable, see above).
- **PR #54**: extract the baseline `analyzeTicker` path into its own module.
  Bigger - touches closure state directly. SELL-path logic must not be
  *changed* until the next live monthly ETF-rotation rebalance is observed;
  pure extraction is fine once proven behavior-preserving.
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
