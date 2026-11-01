import { promises as fs } from "fs";
import path from "path";

import { describe, expect, it, vi } from "vitest";

import {
  currentMonthKey,
  makeDailyBarsSeries,
  makePortfolioSnapshot,
  makeTempDataDir,
  todayDateKey,
} from "./autopilotWorker.characterization.helpers.js";
import {
  buildLiveSubmitOrderLeg,
  checkMarketIsOpen,
  rejectUnsupportedNotionalLeg,
  runEtfRotationCycle,
} from "./etfRotationCycle.js";
import {
  readRebalanceStateStrict,
  recordRebalancePlanned,
  recordRebalanceTerminal,
} from "./etfRotationWorkerState.js";
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
      getMarketIsOpen: async () => true,
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
      getMarketIsOpen: async () => true,
      // GLD's SELL is unpaired (not a top-2 pick this cycle, so no GLD BUY
      // to pair it with) - since 2026-08-08, every accepted SELL is
      // fill-confirmed before the BUY phase, paired or not (see
      // etfRotationExecution.ts's SELL-settlement barrier), so this must
      // be supplied even though this test doesn't exercise the wait's
      // outcome-handling directly.
      waitForSellFill: async () => "filled" as const,
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

describe("rejectUnsupportedNotionalLeg", () => {
  it("returns a clear, actionable rejection reason naming the ticker, amount, and the adapter gap - not a generic message", () => {
    const result = rejectUnsupportedNotionalLeg("SPY", 50);

    expect(result.outcome).toBe("rejected");
    expect(result.reason).toContain("SPY");
    expect(result.reason).toContain("$50.00");
    expect(result.reason).toContain("does not yet support notional");
    expect(result.reason).toContain("allowFractionalShares");
  });
});

describe("buildLiveSubmitOrderLeg", () => {
  it("rejects a notional leg with a clear reason and never calls executeSafeTrade", async () => {
    const executeSafeTrade = vi.fn(
      async (): Promise<ExecuteSafeTradeResult> => ({
        status: "success",
        order: { id: "should-never-be-called" },
      }),
    );

    const submitOrderLeg = buildLiveSubmitOrderLeg(executeSafeTrade);
    const result = await submitOrderLeg("SPY", "BUY", 0, 50);

    expect(result.outcome).toBe("rejected");
    expect(result.reason).toContain("does not yet support notional");
    expect(executeSafeTrade).not.toHaveBeenCalled();
  });

  it("still forwards an ordinary whole-share leg to executeSafeTrade unchanged (no requestedNotional)", async () => {
    const executeSafeTrade = vi.fn(
      async (): Promise<ExecuteSafeTradeResult> => ({
        status: "success",
        order: { id: "broker-1" },
      }),
    );

    const submitOrderLeg = buildLiveSubmitOrderLeg(executeSafeTrade);
    const result = await submitOrderLeg("SPY", "BUY", 10);

    expect(result.outcome).toBe("accepted");
    expect(result.brokerOrderId).toBe("broker-1");
    expect(executeSafeTrade).toHaveBeenCalledWith("SPY", "BUY", 10);
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
      getMarketIsOpen: async () => true,
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
    const state = JSON.parse(await fs.readFile(etfRotationStateFilePath, "utf-8"));
    expect(state.status).toBe("executed");
  });
});

describe("runEtfRotationCycle: cheap already-done-this-month short-circuit (2026-08-08)", () => {
  it("never calls fetchBars when this month is already terminal-successful, and sources price from the portfolio snapshot", async () => {
    const tempDir = await makeTempDataDir("etf-rotation-cycle-already-done-");
    const today = todayDateKey();
    const month = currentMonthKey();
    const etfRotationStateFilePath = path.join(tempDir, "etf-rotation-worker-state.json");

    await fs.writeFile(
      etfRotationStateFilePath,
      JSON.stringify({
        lastRebalanceDateKey: today,
        rebalanceMonthKey: month,
        status: "executed",
      }),
      "utf-8",
    );

    const portfolio = makePortfolioSnapshot({
      equity: 10_000,
      balance: 10_000,
      positions: {
        SPY: { shares: 5, avgPrice: 100, currentPrice: 123.45, pnl: 0, pnlPercent: 0 },
      },
    });

    // Throws if ever invoked - proves the bar-fetch is genuinely skipped,
    // not just that its result happened to go unused.
    const fetchBars = vi.fn(async (): Promise<ReturnType<typeof makeDailyBarsSeries>> => {
      throw new Error("fetchBars should never be called - already done this month.");
    });

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
      fetchBars,
      broadcastSSE: () => {},
      executeSafeTrade: vi.fn(async (): Promise<ExecuteSafeTradeResult> => {
        throw new Error("executeSafeTrade should never be called - already done this month.");
      }),
      getPortfolioSnapshot: async () => portfolio,
      getMarketIsOpen: async () => true,
      etfRotationStateFilePath,
      etfRotationOrderAuditLogFilePath: path.join(tempDir, "etf-rotation-order-audit.jsonl"),
    });

    expect(fetchBars).not.toHaveBeenCalled();
    expect(decisions).toHaveLength(UNIVERSE.length);

    const byTicker = new Map(decisions.map((d) => [d.ticker, d]));

    for (const ticker of UNIVERSE) {
      const decision = byTicker.get(ticker);
      expect(decision?.reasonType).toBe("NOT_REBALANCE_DAY");
      expect(decision?.action).toBe("HOLD");
      expect(decision?.executionStatus).toBe("not_attempted");
      expect(decision?.executed).toBe(false);
      expect(decision?.reason).toContain("skipped market-data fetch");
    }

    // Held ticker (SPY) gets a real price from the portfolio snapshot, not
    // a bare 0 - the observability improvement over the state_corrupt/
    // stale_executing blocks above, which have no such shortcut available.
    expect(byTicker.get("SPY")?.price).toBe(123.45);

    // Unheld universe tickers (no position in the snapshot) fall back to 0
    // - consistent with the other pre-bars early-return blocks, not a
    // regression introduced by this change.
    expect(byTicker.get("QQQ")?.price).toBe(0);

    // The state file's own month must actually match "now" for this test
    // to be a meaningful proof, not an accident of a stale fixture.
    expect(month).toBe(today.slice(0, 7));
  });
});

describe("checkMarketIsOpen", () => {
  it("maps an explicit true to open and an explicit false to closed", async () => {
    await expect(checkMarketIsOpen(async () => true)).resolves.toEqual({ status: "open" });
    await expect(checkMarketIsOpen(async () => false)).resolves.toEqual({ status: "closed" });
  });

  it("treats anything that is not exactly true as closed - never as a guess that the market is open", async () => {
    await expect(
      checkMarketIsOpen(async () => undefined as unknown as boolean),
    ).resolves.toEqual({ status: "closed" });
    await expect(
      checkMarketIsOpen(async () => "true" as unknown as boolean),
    ).resolves.toEqual({ status: "closed" });
  });

  it("reports a thrown clock error as unavailable, with a single-line message", async () => {
    const result = await checkMarketIsOpen(async () => {
      throw new Error("Alpaca market clock failed: HTTP 503\n  upstream   unavailable");
    });

    expect(result).toEqual({
      status: "unavailable",
      error: "Alpaca market clock failed: HTTP 503 upstream unavailable",
    });
  });

  it("bounds a hung clock read by the timeout instead of waiting forever", async () => {
    const result = await checkMarketIsOpen(() => new Promise<boolean>(() => {}), 20);

    expect(result.status).toBe("unavailable");
    expect(result.status === "unavailable" && result.error).toContain("timed out after 20ms");
  });
});

describe("runEtfRotationCycle: market-hours gate (deferral, never a terminal failure)", () => {
  const OPEN_GATES = {
    executeTradesEnabled: true,
    allowBuy: true,
    allowRebalanceSells: true,
    maxAllowedPositions: Number.POSITIVE_INFINITY,
  };

  async function setup(prefix: string) {
    const tempDir = await makeTempDataDir(prefix);
    const today = todayDateKey();
    const statePath = path.join(tempDir, "etf-rotation-worker-state.json");
    const auditPath = path.join(tempDir, "etf-rotation-order-audit.jsonl");
    const portfolio = makePortfolioSnapshot({ equity: 10_000, balance: 10_000 });
    const executeSafeTrade = vi.fn(
      async (ticker: string): Promise<ExecuteSafeTradeResult> => ({
        status: "success",
        order: { id: `broker-order-${ticker}` },
      }),
    );

    const run = (
      getMarketIsOpen: () => Promise<boolean>,
      executeTradesEnabled = true,
    ) =>
      runEtfRotationCycle({
        portfolio,
        config: ETF_ROTATION_MVP_BASELINE_CONFIG,
        configVariantKey: "baseline-2",
        barsDays: 400,
        warmupTradingDays: 210,
        executionGates: { ...OPEN_GATES, executeTradesEnabled },
        fetchBars: makeFetchBars(makeBarsByTicker(today)),
        broadcastSSE: () => {},
        executeSafeTrade,
        getPortfolioSnapshot: async () => portfolio,
        waitForSellFill: async () => "filled" as const,
        getMarketIsOpen,
        etfRotationStateFilePath: statePath,
        etfRotationOrderAuditLogFilePath: auditPath,
      });

    return { today, statePath, auditPath, executeSafeTrade, run };
  }

  async function exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  it("market closed: defers the whole rebalance - no order, no audit event, and not even a state file is written", async () => {
    const { statePath, auditPath, executeSafeTrade, run } = await setup("etf-rotation-gate-closed-");

    const decisions = await run(async () => false);

    expect(executeSafeTrade).not.toHaveBeenCalled();
    expect(await exists(statePath)).toBe(false);
    expect(await exists(auditPath)).toBe(false);
    expect(decisions).toHaveLength(ETF_ROTATION_MVP_BASELINE_CONFIG.universe.length);
    for (const decision of decisions) {
      expect(decision.action).toBe("HOLD");
      expect(decision.executed).toBe(false);
      expect(decision.executionStatus).toBe("not_attempted");
      expect(decision.blockReasonCode).toBe("ETF_ROTATION_MARKET_CLOSED");
      // Not NOT_REBALANCE_DAY: this is a rebalance day that was deferred,
      // and the journal summary counts decisions per reasonType.
      expect(decision.reasonType).toBe("ETF_ROTATION_MARKET_CLOSED");
      expect(decision.reasonType).not.toBe("NOT_REBALANCE_DAY");
      expect(decision.reason).toContain("no manual clear is needed");
    }
  });

  it("clock API error: fails closed the same way, with its own reason code, and logs a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { statePath, executeSafeTrade, run } = await setup("etf-rotation-gate-clockerr-");

    try {
      const decisions = await run(async () => {
        throw new Error("Alpaca market clock failed: HTTP 503");
      });

      expect(executeSafeTrade).not.toHaveBeenCalled();
      expect(await exists(statePath)).toBe(false);
      for (const decision of decisions) {
        expect(decision.blockReasonCode).toBe("ETF_ROTATION_MARKET_CLOCK_UNAVAILABLE");
        expect(decision.reasonType).toBe("ETF_ROTATION_MARKET_CLOCK_UNAVAILABLE");
        expect(decision.blockReasonCategory).toBe("error");
        expect(decision.reason).toContain("HTTP 503");
      }
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("dry-run (execution disabled) never consults the clock, so a closed or broken clock cannot block read-only planning", async () => {
    const { statePath, executeSafeTrade, run } = await setup("etf-rotation-gate-dryrun-");
    const clock = vi.fn(async (): Promise<boolean> => {
      throw new Error("the clock must not be consulted in dry-run");
    });

    const decisions = await run(clock, false);

    expect(clock).not.toHaveBeenCalled();
    expect(executeSafeTrade).not.toHaveBeenCalled();
    expect(decisions.some((d) => d.reasonType === "REBALANCE_BUY")).toBe(true);
    expect(decisions.every((d) => d.blockReasonCode !== "ETF_ROTATION_MARKET_CLOSED")).toBe(true);
    // Dry-run planning still records its planned state exactly as before.
    expect((await readRebalanceStateStrict(statePath)).state.status).toBe("planned");
  });

  it("a month that is already rebalanced short-circuits before the clock is ever read", async () => {
    const { today, statePath, auditPath, executeSafeTrade, run } = await setup("etf-rotation-gate-done-");
    await recordRebalancePlanned(
      {
        dateKey: today,
        rebalanceMonthKey: currentMonthKey(),
        configVariantKey: "baseline-2",
        targets: [],
        plannedOrders: [],
      },
      statePath,
    );
    await recordRebalanceTerminal("executed", statePath);
    const clock = vi.fn(async (): Promise<boolean> => {
      throw new Error("the clock must not be read for an already-rebalanced month");
    });

    const decisions = await run(clock);

    expect(clock).not.toHaveBeenCalled();
    expect(executeSafeTrade).not.toHaveBeenCalled();
    expect(await exists(auditPath)).toBe(false);
    expect(decisions.every((d) => d.reason?.startsWith("Already rebalanced this month"))).toBe(true);
  });

  it("the recovery scenario: after a manual clear (state cancelled), a closed market leaves the state untouched and a later open-market cycle completes the rebalance by itself", async () => {
    const { today, statePath, executeSafeTrade, run } = await setup("etf-rotation-gate-recovery-");
    // What POST /clear-review leaves behind: this month's rebalance is
    // "cancelled" - not done, so the next cycle may try again.
    await recordRebalancePlanned(
      {
        dateKey: today,
        rebalanceMonthKey: currentMonthKey(),
        configVariantKey: "baseline-2",
        targets: [],
        plannedOrders: [],
      },
      statePath,
    );
    await recordRebalanceTerminal("cancelled", statePath);
    const before = await readRebalanceStateStrict(statePath);

    // Weekend / pre-market cycle: deferred, state exactly what it was.
    const deferred = await run(async () => false);
    expect(deferred.every((d) => d.blockReasonCode === "ETF_ROTATION_MARKET_CLOSED")).toBe(true);
    expect(deferred.every((d) => d.reasonType === "ETF_ROTATION_MARKET_CLOSED")).toBe(true);
    expect(executeSafeTrade).not.toHaveBeenCalled();
    const afterDeferral = await readRebalanceStateStrict(statePath);
    expect(afterDeferral.state).toEqual(before.state);
    expect(afterDeferral.state.status).toBe("cancelled");

    // Next cycle with the market open: no manual step in between.
    const executed = await run(async () => true);
    const calledTickers = executeSafeTrade.mock.calls.map((call) => call[0]);
    expect(calledTickers).toEqual(expect.arrayContaining(["SPY", "QQQ"]));
    expect(executed.find((d) => d.ticker === "SPY")?.executed).toBe(true);
    expect((await readRebalanceStateStrict(statePath)).state.status).toBe("executed");
  });
});
