import path from "path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  assertRealDataFilesUnchanged,
  makePortfolioSnapshot,
  makeTempDataDir,
  makeThrowingExecuteSafeTrade,
  snapshotRealDataFiles,
  stubFetchForBarsByTicker,
  type RealDataFileSnapshot,
} from "./autopilotWorker.characterization.helpers.js";
import type { PortfolioSnapshot } from "./src/strategy/portfolioSafety.js";

// Default (baseline) strategy, default (disabled) execution - explicit for
// clarity even though these are the module's own defaults.
vi.stubEnv("AUTOPILOT_STRATEGY", "baseline");
vi.stubEnv("AUTOPILOT_EXECUTE_TRADES", "false");
// The first call's eventual per-ticker analysis would otherwise throw here
// before even reaching its own "not enough bars" check - stubbed so this
// test doesn't depend on a real .env being present (CI has none).
vi.stubEnv("APCA_API_KEY_ID", "test-key-id");
vi.stubEnv("APCA_API_SECRET_KEY", "test-secret-key");

const { createAutopilotWorker } = await import("./autopilotWorker.js");

describe("autopilotWorker characterization: in-process re-entrancy guard", () => {
  let dataFilesBefore: RealDataFileSnapshot[];

  beforeAll(async () => {
    dataFilesBefore = await snapshotRealDataFiles();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await assertRealDataFilesUnchanged(dataFilesBefore);
  });

  it("a second runOnce() call while the first is still in flight is skipped without reaching the broker", async () => {
    const tempDir = await makeTempDataDir("autopilot-reentrancy-");

    // The first call eventually proceeds into the baseline per-ticker loop
    // once its gated getPortfolioSnapshot resolves below - stub fetch so
    // that loop fails fast/cleanly per ticker (empty bars -> analyzeTicker's
    // own "not enough bars" throw, caught per-ticker) instead of making real
    // network calls to Alpaca.
    stubFetchForBarsByTicker({});

    // running only flips true AFTER the lock-claim await resolves (see
    // docs/ops/AUTOPILOT_WORKER_MAP.md) - firing two calls back-to-back with
    // no synchronization would NOT reliably land the second call inside the
    // window where this guard is armed. Gating the first call's
    // getPortfolioSnapshot (awaited right after running=true is set) and
    // polling getStatus().running is the deterministic way to do this.
    let resolveFirstSnapshot: (value: PortfolioSnapshot) => void = () => {};
    const firstSnapshotGate = new Promise<PortfolioSnapshot>((resolve) => {
      resolveFirstSnapshot = resolve;
    });

    let getPortfolioSnapshotCallCount = 0;
    const executeSafeTrade = makeThrowingExecuteSafeTrade();

    const worker = createAutopilotWorker({
      tradeMode: "paper",
      getPortfolioSnapshot: async () => {
        getPortfolioSnapshotCallCount++;
        if (getPortfolioSnapshotCallCount === 1) {
          return firstSnapshotGate;
        }
        throw new Error(
          "getPortfolioSnapshot should not be reached by a properly-skipped second call.",
        );
      },
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

    const firstCallPromise = worker.runOnce("manual");

    // Poll the real, exposed getStatus().running instead of guessing a
    // microtask count - the lock claim is real (temp-file) I/O, whose
    // timing shouldn't be assumed.
    const deadline = Date.now() + 2000;
    while (!worker.getStatus().running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(worker.getStatus().running).toBe(true);

    const secondResult = await worker.runOnce("manual");

    expect(secondResult.skipped).toBe(true);
    expect(secondResult.reason).toContain("already running");
    expect(getPortfolioSnapshotCallCount).toBe(1);
    expect(executeSafeTrade).not.toHaveBeenCalled();

    resolveFirstSnapshot(makePortfolioSnapshot());
    const firstResult = await firstCallPromise;
    expect(firstResult.skipped).toBe(false);
  });
});
