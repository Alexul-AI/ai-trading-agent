import { promises as fs } from "fs";
import path from "path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  assertRealDataFilesUnchanged,
  makeTempDataDir,
  makeThrowingExecuteSafeTrade,
  snapshotRealDataFiles,
  type RealDataFileSnapshot,
} from "./autopilotWorker.characterization.helpers.js";

vi.stubEnv("AUTOPILOT_STRATEGY", "baseline");
vi.stubEnv("AUTOPILOT_EXECUTE_TRADES", "false");

const { createAutopilotWorker } = await import("./autopilotWorker.js");

describe("autopilotWorker characterization: cross-process (foreign lock) skip path", () => {
  let dataFilesBefore: RealDataFileSnapshot[];

  beforeAll(async () => {
    dataFilesBefore = await snapshotRealDataFiles();
  });

  afterEach(async () => {
    await assertRealDataFilesUnchanged(dataFilesBefore);
  });

  it("skips the cycle when a fresh foreign lock is held, without ever fetching the portfolio", async () => {
    const tempDir = await makeTempDataDir("autopilot-foreign-lock-");
    const lockFilePath = path.join(tempDir, "autopilot-worker.lock");

    // A different, unrelated ownerId with a fresh heartbeat - simulates a
    // genuinely different, still-alive worker instance holding the lock.
    await fs.writeFile(
      lockFilePath,
      JSON.stringify({
        ownerId: "some-other-process-owner-id",
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      }),
      "utf-8",
    );

    const executeSafeTrade = makeThrowingExecuteSafeTrade();
    const getPortfolioSnapshot = vi.fn(async () => {
      throw new Error(
        "getPortfolioSnapshot should not be reached when the lock is held elsewhere.",
      );
    });

    const worker = createAutopilotWorker({
      tradeMode: "paper",
      getPortfolioSnapshot,
      getEquityHistorySince: async () => [],
      executeSafeTrade,
      broadcastSSE: () => {},
      testDataFilePaths: {
        lockFilePath,
        etfRotationStateFilePath: path.join(tempDir, "etf-rotation-worker-state.json"),
        circuitBreakerStateFilePath: path.join(tempDir, "circuit-breaker-state.json"),
        circuitBreakerAuditLogFilePath: path.join(tempDir, "circuit-breaker-audit.jsonl"),
        journalFilePath: path.join(tempDir, "autopilot-decisions.jsonl"),
      },
    });

    const result = await worker.runOnce("manual");

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("lock held elsewhere");
    expect(getPortfolioSnapshot).not.toHaveBeenCalled();
    expect(executeSafeTrade).not.toHaveBeenCalled();

    // The foreign lock must be left untouched, not overwritten.
    const stillThere = JSON.parse(await fs.readFile(lockFilePath, "utf-8"));
    expect(stillThere.ownerId).toBe("some-other-process-owner-id");
  });
});
