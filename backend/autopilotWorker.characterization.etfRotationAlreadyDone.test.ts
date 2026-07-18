import { promises as fs } from "fs";
import path from "path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  assertRealDataFilesUnchanged,
  currentMonthKey,
  makeDailyBarsSeries,
  makePortfolioSnapshot,
  makeTempDataDir,
  makeThrowingExecuteSafeTrade,
  snapshotRealDataFiles,
  stubFetchForBarsByTicker,
  todayDateKey,
  type RealDataFileSnapshot,
} from "./autopilotWorker.characterization.helpers.js";

// Module-load-time constants (AUTOPILOT_STRATEGY etc.) must be set before
// autopilotWorker.js is first imported - each characterization test file
// gets its own fresh module graph (confirmed empirically before writing
// these tests), so this is safe and doesn't leak into other test files.
vi.stubEnv("AUTOPILOT_STRATEGY", "etf_rotation");
vi.stubEnv("AUTOPILOT_EXECUTE_TRADES", "false");

const { createAutopilotWorker } = await import("./autopilotWorker.js");

describe("autopilotWorker characterization: ETF Rotation already-done-this-month gate", () => {
  let dataFilesBefore: RealDataFileSnapshot[];

  beforeAll(async () => {
    dataFilesBefore = await snapshotRealDataFiles();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await assertRealDataFilesUnchanged(dataFilesBefore);
  });

  it("returns NOT_REBALANCE_DAY for every universe ticker and never calls executeSafeTrade", async () => {
    const tempDir = await makeTempDataDir("autopilot-etf-already-done-");
    const today = todayDateKey();
    const month = currentMonthKey();

    await fs.writeFile(
      path.join(tempDir, "etf-rotation-worker-state.json"),
      JSON.stringify({
        lastRebalanceDateKey: today,
        rebalanceMonthKey: month,
        status: "executed",
      }),
      "utf-8",
    );

    // Only 5 bars per ticker - deliberately short. The already-done-this-month
    // gate is checked before the 210-trading-day warmup check, so this
    // proves the gate short-circuits before that check even matters.
    const bars = makeDailyBarsSeries(5, today);
    stubFetchForBarsByTicker({ SPY: bars, QQQ: bars, EFA: bars, TLT: bars, GLD: bars });

    const executeSafeTrade = makeThrowingExecuteSafeTrade();

    const worker = createAutopilotWorker({
      tradeMode: "paper",
      getPortfolioSnapshot: async () => makePortfolioSnapshot(),
      getEquityHistorySince: async () => [],
      executeSafeTrade,
      broadcastSSE: () => {},
      testDataFilePaths: {
        lockFilePath: path.join(tempDir, "autopilot-worker.lock"),
        etfRotationStateFilePath: path.join(tempDir, "etf-rotation-worker-state.json"),
        circuitBreakerStateFilePath: path.join(tempDir, "circuit-breaker-state.json"),
        circuitBreakerAuditLogFilePath: path.join(tempDir, "circuit-breaker-audit.jsonl"),
        journalFilePath: path.join(tempDir, "autopilot-decisions.jsonl"),
      },
    });

    const result = await worker.runOnce("manual");

    expect(result.skipped).toBe(false);
    expect(result.decisions.length).toBeGreaterThan(0);
    for (const decision of result.decisions) {
      expect(decision.reasonType).toBe("NOT_REBALANCE_DAY");
      expect(decision.executionStatus).toBe("not_attempted");
    }
    expect(executeSafeTrade).not.toHaveBeenCalled();
  });
});
