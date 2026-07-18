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

// Execution is globally enabled, but both per-side gates are off - this
// exercises executeEtfRotationOrders's own allowBuy/allowSell checks (a
// different gate than AUTOPILOT_EXECUTE_TRADES itself), which must also
// never reach submitOrderLeg/executeSafeTrade.
vi.stubEnv("AUTOPILOT_STRATEGY", "etf_rotation");
vi.stubEnv("AUTOPILOT_EXECUTE_TRADES", "true");
vi.stubEnv("AUTOPILOT_ALLOW_BUY", "false");
vi.stubEnv("AUTOPILOT_ALLOW_SELL", "false");
// fetchAlpacaBarsUncached throws before ever calling fetch if these are
// empty - must not depend on a real .env being present (CI has none).
vi.stubEnv("APCA_API_KEY_ID", "test-key-id");
vi.stubEnv("APCA_API_SECRET_KEY", "test-secret-key");

const { createAutopilotWorker } = await import("./autopilotWorker.js");

describe("autopilotWorker characterization: AUTOPILOT_ALLOW_BUY/ALLOW_SELL=false never reaches the broker", () => {
  let dataFilesBefore: RealDataFileSnapshot[];

  beforeAll(async () => {
    dataFilesBefore = await snapshotRealDataFiles();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await assertRealDataFilesUnchanged(dataFilesBefore);
  });

  it("blocks every BUY leg via the per-side gate without ever calling executeSafeTrade", async () => {
    const tempDir = await makeTempDataDir("autopilot-allow-buy-disabled-");
    const today = todayDateKey();

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
    expect(buyDecisions.length).toBeGreaterThan(0);
    for (const decision of buyDecisions) {
      // Blocked by the per-side gate inside executeEtfRotationOrders, not a
      // dry-run - a different code path than the EXECUTE_TRADES=false case.
      expect(decision.executed).toBe(false);
      expect(decision.executionStatus).not.toBe("executed");
    }
    expect(executeSafeTrade).not.toHaveBeenCalled();
  });
});
