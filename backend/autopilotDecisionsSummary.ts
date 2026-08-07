// Decision-array shaping/counting for autopilotWorker.ts's runOnce() -
// extracted in the autopilotWorker refactor Slice 3 (2026-08-07, see
// docs/ops/AUTOPILOT_WORKER_MAP.md). Pure, no I/O, no closure state, no
// broker/execution path, no env/gates - the safest remaining extraction
// target identified after Slices 1-2, per the user's own review.
//
// isSignalReadyDecision moved here unchanged (pure relocation) since
// summarizeAutopilotDecisions below needs it - re-exported from
// autopilotWorker.ts so autopilotFilters.test.ts needs no changes.
import { AUTOPILOT_MIN_CONFIDENCE } from "./autopilotConfig.js";
import type { AutopilotDecisionLog } from "./src/types/autopilotTypes.js";

export function isSignalReadyDecision(decision: AutopilotDecisionLog): boolean {
  if (typeof decision.isSignalReady === "boolean") {
    return decision.isSignalReady;
  }

  return (
    decision.action !== "HOLD" &&
    decision.confidence >= AUTOPILOT_MIN_CONFIDENCE &&
    (decision.suggestedShares > 0 || (decision.suggestedNotional ?? 0) > 0) &&
    !decision.skippedReason
  );
}

export interface AutopilotDecisionsSummary {
  signalReady: AutopilotDecisionLog[];
  signalCandidates: AutopilotDecisionLog[];
  dryRunSignals: AutopilotDecisionLog[];
  executedSignals: AutopilotDecisionLog[];
  signalReadyCount: number;
  signalBlockedCount: number;
  dryRunCount: number;
  executedCount: number;
}

// Moved byte-for-byte from runOnce() - same filtering logic, same
// signalBlockedCount formula (signalCandidates.length - signalReady.length,
// not a separate "blocked" filter), just relocated and given a name.
export function summarizeAutopilotDecisions(
  decisions: AutopilotDecisionLog[],
): AutopilotDecisionsSummary {
  const signalReady = decisions.filter(isSignalReadyDecision);
  const signalCandidates = decisions.filter(
    (decision) => decision.action === "BUY" || decision.action === "SELL",
  );
  const dryRunSignals = signalReady.filter(
    (decision) => decision.executionStatus === "dry_run",
  );
  const executedSignals = signalReady.filter(
    (decision) => decision.executed || decision.executionStatus === "executed",
  );

  return {
    signalReady,
    signalCandidates,
    dryRunSignals,
    executedSignals,
    signalReadyCount: signalReady.length,
    signalBlockedCount: signalCandidates.length - signalReady.length,
    dryRunCount: dryRunSignals.length,
    executedCount: executedSignals.length,
  };
}
