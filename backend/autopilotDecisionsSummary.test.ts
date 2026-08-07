import { describe, expect, it } from "vitest";

import {
  isSignalReadyDecision,
  summarizeAutopilotDecisions,
} from "./autopilotDecisionsSummary.js";
import type { AutopilotDecisionLog } from "./src/types/autopilotTypes.js";

// autopilotWorker refactor Slice 3 (2026-08-07) - pure decision-array
// shaping, no I/O, no closure state, no broker/execution path, no
// env/gates. Fixtures set isSignalReady explicitly (rather than relying on
// isSignalReadyDecision's confidence-threshold fallback) so these tests
// don't depend on AUTOPILOT_MIN_CONFIDENCE's actual resolved value -
// except the two dedicated fallback-path tests at the bottom, which
// exercise that intentionally.

function makeDecision(overrides: Partial<AutopilotDecisionLog>): AutopilotDecisionLog {
  return {
    ticker: "SPY",
    timestamp: "2026-08-07T12:00:00.000Z",
    price: 748.15,
    action: "HOLD",
    confidence: 0,
    suggestedShares: 0,
    reasonType: "NO_SIGNAL",
    reason: "test fixture",
    executed: false,
    ...overrides,
  };
}

describe("summarizeAutopilotDecisions", () => {
  it("returns all-empty/all-zero for an empty decisions array", () => {
    const summary = summarizeAutopilotDecisions([]);

    expect(summary).toEqual({
      signalReady: [],
      signalCandidates: [],
      dryRunSignals: [],
      executedSignals: [],
      signalReadyCount: 0,
      signalBlockedCount: 0,
      dryRunCount: 0,
      executedCount: 0,
    });
  });

  it("excludes HOLD decisions from signalCandidates entirely", () => {
    const holds = [
      makeDecision({ ticker: "A", action: "HOLD" }),
      makeDecision({ ticker: "B", action: "HOLD", isSignalReady: false }),
    ];

    const summary = summarizeAutopilotDecisions(holds);

    expect(summary.signalCandidates).toEqual([]);
    expect(summary.signalReady).toEqual([]);
    expect(summary.signalBlockedCount).toBe(0);
  });

  it("classifies a realistic mix of statuses correctly, including the signalBlockedCount subtraction formula", () => {
    const dryRunBuy = makeDecision({
      ticker: "SPY",
      action: "BUY",
      isSignalReady: true,
      executionStatus: "dry_run",
      executed: false,
    });
    const executedBuy = makeDecision({
      ticker: "QQQ",
      action: "BUY",
      isSignalReady: true,
      executionStatus: "executed",
      executed: true,
    });
    const blockedSell = makeDecision({
      ticker: "EFA",
      action: "SELL",
      isSignalReady: false,
      executionStatus: "blocked",
      executed: false,
    });
    const holdDecision = makeDecision({
      ticker: "TLT",
      action: "HOLD",
      isSignalReady: false,
    });
    // executed via the `executed` boolean flag, not executionStatus - the
    // function's own executedSignals filter checks both independently.
    const executedSellViaFlag = makeDecision({
      ticker: "GLD",
      action: "SELL",
      isSignalReady: true,
      executionStatus: "ambiguous",
      executed: true,
    });

    const decisions = [dryRunBuy, executedBuy, blockedSell, holdDecision, executedSellViaFlag];
    const summary = summarizeAutopilotDecisions(decisions);

    expect(summary.signalCandidates).toEqual([dryRunBuy, executedBuy, blockedSell, executedSellViaFlag]);
    expect(summary.signalReady).toEqual([dryRunBuy, executedBuy, executedSellViaFlag]);
    expect(summary.signalReadyCount).toBe(3);
    // 4 candidates (BUY/SELL), 3 signal-ready -> 1 blocked (blockedSell).
    expect(summary.signalBlockedCount).toBe(1);
    expect(summary.dryRunSignals).toEqual([dryRunBuy]);
    expect(summary.dryRunCount).toBe(1);
    expect(summary.executedSignals).toEqual([executedBuy, executedSellViaFlag]);
    expect(summary.executedCount).toBe(2);
  });

  it("only draws dryRunSignals/executedSignals from signalReady, never from a blocked candidate", () => {
    // A blocked (isSignalReady: false) decision that happens to also carry
    // executionStatus: "dry_run" or executed: true must not leak into
    // dryRunSignals/executedSignals - both are filtered from signalReady,
    // not from the raw decisions array.
    const blockedButFlaggedExecuted = makeDecision({
      ticker: "AMD",
      action: "BUY",
      isSignalReady: false,
      executed: true,
      executionStatus: "dry_run",
    });

    const summary = summarizeAutopilotDecisions([blockedButFlaggedExecuted]);

    expect(summary.signalReady).toEqual([]);
    expect(summary.dryRunSignals).toEqual([]);
    expect(summary.executedSignals).toEqual([]);
    expect(summary.signalBlockedCount).toBe(1);
  });
});

describe("isSignalReadyDecision", () => {
  it("uses the explicit isSignalReady flag when present, ignoring the confidence fallback entirely", () => {
    expect(
      isSignalReadyDecision(
        makeDecision({ isSignalReady: true, confidence: 0, suggestedShares: 0 }),
      ),
    ).toBe(true);
    expect(
      isSignalReadyDecision(
        makeDecision({
          isSignalReady: false,
          action: "BUY",
          confidence: 1,
          suggestedShares: 100,
        }),
      ),
    ).toBe(false);
  });

  it("falls back to the confidence/shares/skippedReason check when isSignalReady is absent", () => {
    expect(
      isSignalReadyDecision(
        makeDecision({ action: "BUY", confidence: 1, suggestedShares: 10 }),
      ),
    ).toBe(true);
    // Below any plausible AUTOPILOT_MIN_CONFIDENCE threshold.
    expect(
      isSignalReadyDecision(
        makeDecision({ action: "BUY", confidence: 0, suggestedShares: 10 }),
      ),
    ).toBe(false);
    // HOLD never counts as signal-ready via the fallback, regardless of confidence.
    expect(
      isSignalReadyDecision(
        makeDecision({ action: "HOLD", confidence: 1, suggestedShares: 10 }),
      ),
    ).toBe(false);
    // Zero shares and zero notional never counts as signal-ready.
    expect(
      isSignalReadyDecision(
        makeDecision({ action: "BUY", confidence: 1, suggestedShares: 0 }),
      ),
    ).toBe(false);
    // A skippedReason blocks the fallback path regardless of the other fields.
    expect(
      isSignalReadyDecision(
        makeDecision({
          action: "BUY",
          confidence: 1,
          suggestedShares: 10,
          skippedReason: "blocked for some reason",
        }),
      ),
    ).toBe(false);
  });
});
