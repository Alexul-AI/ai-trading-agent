import path from "path";

import { describe, expect, it, vi } from "vitest";

import {
  makeDailyBarsSeries,
  makePortfolioSnapshot,
  makeTempDataDir,
  todayDateKey,
} from "./autopilotWorker.characterization.helpers.js";
import { runEtfRotationCycle } from "./etfRotationCycle.js";
import { ETF_ROTATION_MVP_BASELINE_CONFIG } from "./etfRotationStrategy.js";
import type { ExecuteSafeTradeResult } from "./src/types/autopilotTypes.js";

// This module takes bars/config/gates as explicit parameters rather than
// reading process.env internally (that's the whole point of the extraction
// - see docs/ops/AUTOPILOT_WORKER_MAP.md), so unlike
// autopilotWorker.characterization.*.test.ts these tests need no
// vi.stubEnv/dynamic-import gymnastics and no global fetch stub - bars are
// injected directly via fetchBars.

const UNIVERSE = ETF_ROTATION_MVP_BASELINE_CONFIG.universe; // ["SPY", "QQQ", "EFA", "TLT", "GLD"]

function makeBarsByTicker(today: string) {
  // Differential growth rates so SPY/QQQ are unambiguously the top-2
  // momentum picks (holdCount=2) - not a tie, so which tickers become BUY
  // vs. SELL targets is deterministic.
  return {
    SPY: makeDailyBarsSeries(230, today, 100, 0.0015),
    QQQ: makeDailyBarsSeries(230, today, 100, 0.0012),
    EFA: makeDailyBarsSeries(230, today, 100, 0.0004),
    TLT: makeDailyBarsSeries(230, today, 100, 0.0002),
    GLD: makeDailyBarsSeries(230, today, 100, 0.0001),
  };
}

function makeFetchBars(barsByTicker: Record<string, ReturnType<typeof makeDailyBarsSeries>>) {
  return async (ticker: string) => barsByTicker[ticker] ?? [];
}

describe("runEtfRotationCycle: asymmetric allowBuy/allowRebalanceSells gates", () => {
  it("allowBuy=true, allowRebalanceSells=false: BUY legs reach the broker and get accepted, SELL legs are blocked before submission", async () => {
    const tempDir = await makeTempDataDir("etf-rotation-cycle-asym-buy-");
    const today = todayDateKey();
    const barsByTicker = makeBarsByTicker(today);

    // GLD has an existing position that will NOT be a top-2 pick (lowest
    // growth rate) - computeRebalanceOrders always SELLs an existing
    // position regardless of new targets (full liquidate-then-rebuy), so
    // this deterministically produces a SELL order for GLD alongside BUY
    // orders for SPY/QQQ.
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

    const decisions = await runEtfRotationCycle({
      portfolio,
      config: ETF_ROTATION_MVP_BASELINE_CONFIG,
      configVariantKey: "baseline-2",
      barsDays: 400,
      warmupTradingDays: 210,
      executionGates: {
        executeTradesEnabled: true,
        allowBuy: true,
        allowRebalanceSells: false,
        maxAllowedPositions: Number.POSITIVE_INFINITY,
      },
      fetchBars: makeFetchBars(barsByTicker),
      broadcastSSE: () => {},
      executeSafeTrade,
      getPortfolioSnapshot: async () => portfolio,
      etfRotationStateFilePath: path.join(tempDir, "etf-rotation-worker-state.json"),
      etfRotationOrderAuditLogFilePath: path.join(tempDir, "etf-rotation-order-audit.jsonl"),
    });

    const byTicker = new Map(decisions.map((d) => [d.ticker, d]));

    // BUY legs (SPY/QQQ) reached the broker and were accepted.
    for (const ticker of ["SPY", "QQQ"]) {
      const decision = byTicker.get(ticker);
      expect(decision?.action).toBe("BUY");
      expect(decision?.executionStatus).toBe("executed");
      expect(decision?.executed).toBe(true);
    }

    // SELL leg (GLD) was blocked by the allowRebalanceSells=false gate,
    // never reaching executeSafeTrade.
    const gldDecision = byTicker.get("GLD");
    expect(gldDecision?.action).toBe("SELL");
    expect(gldDecision?.executionStatus).toBe("blocked");
    expect(gldDecision?.executed).toBe(false);
    expect(gldDecision?.executionBlockReasonDetail).toContain("AUTOPILOT_ALLOW_REBALANCE_SELLS");

    // The critical field-swap regression guard: executeSafeTrade was called
    // for the BUY tickers, never for the blocked SELL ticker. If allowBuy/
    // allowRebalanceSells were transposed at the autopilotWorker.ts call
    // site, this assertion would fail (either GLD would get called, or
    // SPY/QQQ wouldn't).
    const calledTickers = executeSafeTrade.mock.calls.map((call) => call[0]);
    expect(calledTickers).toEqual(expect.arrayContaining(["SPY", "QQQ"]));
    expect(calledTickers).not.toContain("GLD");
  });

  it("allowBuy=false, allowRebalanceSells=true: SELL legs reach the broker, BUY legs are blocked before submission", async () => {
    const tempDir = await makeTempDataDir("etf-rotation-cycle-asym-sell-");
    const today = todayDateKey();
    const barsByTicker = makeBarsByTicker(today);

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

    const decisions = await runEtfRotationCycle({
      portfolio,
      config: ETF_ROTATION_MVP_BASELINE_CONFIG,
      configVariantKey: "baseline-2",
      barsDays: 400,
      warmupTradingDays: 210,
      executionGates: {
        executeTradesEnabled: true,
        allowBuy: false,
        allowRebalanceSells: true,
        maxAllowedPositions: Number.POSITIVE_INFINITY,
      },
      fetchBars: makeFetchBars(barsByTicker),
      broadcastSSE: () => {},
      executeSafeTrade,
      getPortfolioSnapshot: async () => portfolio,
      etfRotationStateFilePath: path.join(tempDir, "etf-rotation-worker-state.json"),
      etfRotationOrderAuditLogFilePath: path.join(tempDir, "etf-rotation-order-audit.jsonl"),
    });

    const byTicker = new Map(decisions.map((d) => [d.ticker, d]));

    const gldDecision = byTicker.get("GLD");
    expect(gldDecision?.action).toBe("SELL");
    expect(gldDecision?.executionStatus).toBe("executed");
    expect(gldDecision?.executed).toBe(true);

    for (const ticker of ["SPY", "QQQ"]) {
      const decision = byTicker.get(ticker);
      expect(decision?.action).toBe("BUY");
      expect(decision?.executionStatus).toBe("blocked");
      expect(decision?.executed).toBe(false);
      expect(decision?.executionBlockReasonDetail).toContain("AUTOPILOT_ALLOW_BUY");
    }

    const calledTickers = executeSafeTrade.mock.calls.map((call) => call[0]);
    expect(calledTickers).toContain("GLD");
    expect(calledTickers).not.toEqual(expect.arrayContaining(["SPY", "QQQ"]));
  });
});

describe("runEtfRotationCycle: real accepted-outcome bookkeeping", () => {
  it("records a genuine broker-accepted BUY correctly, including the terminal rebalance state", async () => {
    const tempDir = await makeTempDataDir("etf-rotation-cycle-accepted-");
    const today = todayDateKey();
    const barsByTicker = makeBarsByTicker(today);
    const etfRotationStateFilePath = path.join(tempDir, "etf-rotation-worker-state.json");

    const portfolio = makePortfolioSnapshot({ equity: 10_000, balance: 10_000 });

    const executeSafeTrade = vi.fn(
      async (): Promise<ExecuteSafeTradeResult> => ({
        status: "success",
        order: { id: "broker-order-1" },
      }),
    );

    const decisions = await runEtfRotationCycle({
      portfolio,
      config: ETF_ROTATION_MVP_BASELINE_CONFIG,
      configVariantKey: "baseline-2",
      barsDays: 400,
      warmupTradingDays: 210,
      executionGates: {
        executeTradesEnabled: true,
        allowBuy: true,
        allowRebalanceSells: true,
        maxAllowedPositions: Number.POSITIVE_INFINITY,
      },
      fetchBars: makeFetchBars(barsByTicker),
      broadcastSSE: () => {},
      executeSafeTrade,
      getPortfolioSnapshot: async () => portfolio,
      etfRotationStateFilePath,
      etfRotationOrderAuditLogFilePath: path.join(tempDir, "etf-rotation-order-audit.jsonl"),
    });

    const spyDecision = decisions.find((d) => d.ticker === "SPY");
    expect(spyDecision?.action).toBe("BUY");
    expect(spyDecision?.executionStatus).toBe("executed");
    expect(spyDecision?.executed).toBe(true);
    expect(spyDecision?.reason).toContain("broker-accepted");

    // The state machine's terminal status: an all-accepted result maps to
    // "executed" (mapEtfRotationExecutionStatusToRebalanceStatus), and this
    // cycle's own recordRebalancePlanned/recordRebalanceExecuting/
    // recordRebalanceTerminal calls should have left the state file in a
    // fully resolved (not stuck "executing") state.
    const { promises: fs } = await import("fs");
    const state = JSON.parse(await fs.readFile(etfRotationStateFilePath, "utf-8"));
    expect(state.status).toBe("executed");
  });
});
