import path from "path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  assertRealDataFilesUnchanged,
  makeDailyBarsSeries,
  makePortfolioSnapshot,
  makeTempDataDir,
  makeThrowingExecuteSafeTrade,
  snapshotRealDataFiles,
  stubFetchForBarsByTicker,
  todayDateKey,
  type RealDataFileSnapshot,
} from "./autopilotWorker.characterization.helpers.js";

vi.stubEnv("AUTOPILOT_STRATEGY", "etf_rotation");
vi.stubEnv("AUTOPILOT_EXECUTE_TRADES", "false");
// fetchAlpacaBarsUncached throws before ever calling fetch if these are
// empty - must not depend on a real .env being present (CI has none).
vi.stubEnv("APCA_API_KEY_ID", "test-key-id");
vi.stubEnv("APCA_API_SECRET_KEY", "test-secret-key");

const { createAutopilotWorker } = await import("./autopilotWorker.js");

describe("autopilotWorker characterization: AUTOPILOT_EXECUTE_TRADES=false never reaches the broker", () => {
  let dataFilesBefore: RealDataFileSnapshot[];

  beforeAll(async () => {
    dataFilesBefore = await snapshotRealDataFiles();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await assertRealDataFilesUnchanged(dataFilesBefore);
  });

  it("produces dry_run BUY decisions for a fresh rebalance without ever calling executeSafeTrade", async () => {
    const tempDir = await makeTempDataDir("autopilot-execute-disabled-");
    const today = todayDateKey();

    // No pre-seeded state file - a genuinely fresh worker, so the monthly
    // gate resolves to "proceed_to_plan" and real targets get computed.
    // 230 trading days (> ETF_ROTATION_WARMUP_TRADING_DAYS=210) with a
    // slightly different growth rate per ticker so momentum ranking isn't a
    // 5-way tie.
    stubFetchForBarsByTicker({
      SPY: makeDailyBarsSeries(230, today, 100, 0.0012),
      QQQ: makeDailyBarsSeries(230, today, 100, 0.0010),
      EFA: makeDailyBarsSeries(230, today, 100, 0.0008),
      TLT: makeDailyBarsSeries(230, today, 100, 0.0006),
      GLD: makeDailyBarsSeries(230, today, 100, 0.0004),
    });

    const executeSafeTrade = makeThrowingExecuteSafeTrade();

    const worker = createAutopilotWorker({
      tradeMode: "paper",
      getPortfolioSnapshot: async () => makePortfolioSnapshot({ balance: 10_000, equity: 10_000 }),
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
    const buyDecisions = result.decisions.filter((decision) => decision.action === "BUY");
    // With holdCount=2 and no existing positions, a fresh rebalance should
    // pick 2 winners - if this is ever 0, the fixture (not the gate) is
    // broken and the rest of this assertion would be vacuous.
    expect(buyDecisions.length).toBeGreaterThan(0);
    for (const decision of buyDecisions) {
      expect(decision.executionStatus).toBe("dry_run");
      expect(decision.executed).toBe(false);
    }
    expect(executeSafeTrade).not.toHaveBeenCalled();
  });
});
