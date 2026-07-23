import path from "path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  assertRealDataFilesUnchanged,
  makeDailyBarsSeries,
  makePortfolioSnapshot,
  makeTempDataDir,
  snapshotRealDataFiles,
  stubFetchForBarsByTicker,
  todayDateKey,
  type RealDataFileSnapshot,
} from "./autopilotWorker.characterization.helpers.js";
import type { ExecuteSafeTradeResult } from "./src/types/autopilotTypes.js";

// This is the one gap PR #53's Plan-agent review flagged: the extracted
// runEtfRotationCycle's own tests (etfRotationCycle.test.ts) call it
// directly with hand-written params, which never exercises the *new* code
// in autopilotWorker.ts's runOnce() call site that builds those params from
// AUTOPILOT_ALLOW_BUY/AUTOPILOT_ALLOW_REBALANCE_SELLS - a same-typed field
// swap there would compile cleanly and pass every *symmetric* existing test
// (allowBuyDisabled sets both to false). This test goes through the real
// runOnce() with asymmetric gates and a real accepted execution,
// specifically to catch that class of wiring bug.
//
// AUTOPILOT_ALLOW_REBALANCE_SELLS (not AUTOPILOT_ALLOW_SELL) is the real
// gate for this path as of 2026-07-19 - AUTOPILOT_ALLOW_SELL only gates the
// baseline strategy's SELL/STOP_LOSS, never reached from this test since
// AUTOPILOT_STRATEGY is forced to etf_rotation below.
vi.stubEnv("AUTOPILOT_STRATEGY", "etf_rotation");
vi.stubEnv("AUTOPILOT_EXECUTE_TRADES", "true");
vi.stubEnv("AUTOPILOT_ALLOW_BUY", "true");
vi.stubEnv("AUTOPILOT_ALLOW_REBALANCE_SELLS", "false");
vi.stubEnv("APCA_API_KEY_ID", "test-key-id");
vi.stubEnv("APCA_API_SECRET_KEY", "test-secret-key");

const { createAutopilotWorker } = await import("./autopilotWorker.js");

describe("autopilotWorker characterization: asymmetric ALLOW_BUY/ALLOW_REBALANCE_SELLS through the real runOnce() call site", () => {
  let dataFilesBefore: RealDataFileSnapshot[];

  beforeAll(async () => {
    dataFilesBefore = await snapshotRealDataFiles();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await assertRealDataFilesUnchanged(dataFilesBefore);
  });

  it("AUTOPILOT_ALLOW_BUY=true/ALLOW_REBALANCE_SELLS=false: BUY legs reach the broker and are accepted, the SELL leg is blocked", async () => {
    const tempDir = await makeTempDataDir("autopilot-etf-asym-gates-");
    const today = todayDateKey();

    // Differential growth so SPY/QQQ are the unambiguous top-2 picks;
    // EFA/TLT/GLD are not selected.
    stubFetchForBarsByTicker({
      SPY: makeDailyBarsSeries(230, today, 100, 0.0015),
      QQQ: makeDailyBarsSeries(230, today, 100, 0.0012),
      EFA: makeDailyBarsSeries(230, today, 100, 0.0004),
      TLT: makeDailyBarsSeries(230, today, 100, 0.0002),
      GLD: makeDailyBarsSeries(230, today, 100, 0.0001),
    });

    // GLD holds an existing position that will be liquidated (full
    // liquidate-then-rebuy) since it's not a top-2 pick this cycle - this is
    // the SELL leg the allowRebalanceSells=false gate should block.
    const portfolio = makePortfolioSnapshot({
      equity: 10_000,
      balance: 10_000,
      positions: {
        GLD: { shares: 10, avgPrice: 100, currentPrice: 100, pnl: 0, pnlPercent: 0 },
      },
    });

    const executeSafeTrade = vi.fn(
      async (ticker: string): Promise<ExecuteSafeTradeResult> => ({
        status: "success",
        order: { id: `broker-order-${ticker}` },
      }),
    );

    const worker = createAutopilotWorker({
      tradeMode: "paper",
      getPortfolioSnapshot: async () => portfolio,
      getEquityHistorySince: async () => [],
      executeSafeTrade,
      broadcastSSE: () => {},
      testDataFilePaths: {
        lockFilePath: path.join(tempDir, "autopilot-worker.lock"),
        etfRotationStateFilePath: path.join(tempDir, "etf-rotation-worker-state.json"),
        etfRotationOrderAuditLogFilePath: path.join(tempDir, "etf-rotation-order-audit.jsonl"),
        circuitBreakerStateFilePath: path.join(tempDir, "circuit-breaker-state.json"),
        circuitBreakerAuditLogFilePath: path.join(tempDir, "circuit-breaker-audit.jsonl"),
        journalFilePath: path.join(tempDir, "autopilot-decisions.jsonl"),
      },
    });

    const result = await worker.runOnce("manual");

    expect(result.skipped).toBe(false);
    const byTicker = new Map(result.decisions.map((d) => [d.ticker, d]));

    for (const ticker of ["SPY", "QQQ"]) {
      const decision = byTicker.get(ticker);
      expect(decision?.action).toBe("BUY");
      expect(decision?.executionStatus).toBe("executed");
      expect(decision?.executed).toBe(true);
    }

    const gldDecision = byTicker.get("GLD");
    expect(gldDecision?.action).toBe("SELL");
    expect(gldDecision?.executionStatus).toBe("blocked");
    expect(gldDecision?.executed).toBe(false);

    // The actual field-swap regression guard for autopilotWorker.ts's
    // runOnce() call site: if allowBuy/allowRebalanceSells were transposed
    // when building executionGates there, this would flip (GLD would
    // execute, SPY/QQQ would be blocked) and these assertions would fail.
    const calledTickers = executeSafeTrade.mock.calls.map((call) => call[0]);
    expect(calledTickers).toEqual(expect.arrayContaining(["SPY", "QQQ"]));
    expect(calledTickers).not.toContain("GLD");
  });
});
