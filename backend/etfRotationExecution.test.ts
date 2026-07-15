import { describe, expect, it, vi } from "vitest";

import {
  computeOverallExecutionStatus,
  executeEtfRotationOrders,
  type EtfRotationExecuteSafeTrade,
  type EtfRotationExecutionGates,
} from "./etfRotationExecution.js";
import type {
  EtfRotationOrderAuditEvent,
} from "./etfRotationOrderAuditLog.js";
import type { RebalanceOrder } from "./etfRotationStrategy.js";
import type { PortfolioSnapshot } from "./src/strategy/portfolioSafety.js";

const ALLOW_ALL: EtfRotationExecutionGates = {
  executeTradesEnabled: true,
  allowBuy: true,
  allowSell: true,
};

function makeSnapshot(balance: number): PortfolioSnapshot {
  return { balance, equity: balance, currency: "USD", positions: {} };
}

function fixedClock(iso = "2026-07-15T00:00:00.000Z"): () => string {
  return () => iso;
}

function collectingAuditRecorder(): {
  events: EtfRotationOrderAuditEvent[];
  appendAuditEvent: (event: EtfRotationOrderAuditEvent) => Promise<void>;
} {
  const events: EtfRotationOrderAuditEvent[] = [];
  return {
    events,
    appendAuditEvent: async (event) => {
      events.push(event);
    },
  };
}

function throwingExecuteSafeTrade(): EtfRotationExecuteSafeTrade {
  return async () => {
    throw new Error(
      "executeSafeTrade should NEVER be called for this test scenario.",
    );
  };
}

function successfulExecuteSafeTrade(
  brokerOrderId = "broker-1",
): EtfRotationExecuteSafeTrade {
  return async () => ({
    status: "success",
    order: { id: brokerOrderId },
  });
}

const baseParams = {
  rebalanceMonthKey: "2026-07",
  configVariantKey: "baseline-2",
  currentPriceByTicker: new Map([
    ["SPY", 500],
    ["QQQ", 400],
    ["GLD", 200],
  ]),
  now: fixedClock(),
};

describe("executeEtfRotationOrders - global execute-trades gate", () => {
  it("never calls executeSafeTrade when AUTOPILOT_EXECUTE_TRADES is false, and blocks every leg", async () => {
    const orders: RebalanceOrder[] = [
      { ticker: "SPY", action: "BUY", shares: 10, targetWeightPercent: 50 },
      { ticker: "GLD", action: "SELL", shares: 5 },
    ];
    const audit = collectingAuditRecorder();

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: { ...ALLOW_ALL, executeTradesEnabled: false },
      executeSafeTrade: throwingExecuteSafeTrade(),
      appendAuditEvent: audit.appendAuditEvent,
      refreshPortfolioSnapshot: async () => makeSnapshot(100000),
    });

    expect(result.status).toBe("not_attempted");
    expect(result.blockedOrders).toHaveLength(2);
    expect(result.executedOrders).toHaveLength(0);
    expect(audit.events).toHaveLength(0);
  });
});

describe("executeEtfRotationOrders - per-leg side gates", () => {
  it("blocks a SELL leg when AUTOPILOT_ALLOW_SELL is false, without calling executeSafeTrade for it", async () => {
    const orders: RebalanceOrder[] = [
      { ticker: "GLD", action: "SELL", shares: 5 },
    ];
    const executeSafeTrade = vi.fn(throwingExecuteSafeTrade());

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: { ...ALLOW_ALL, allowSell: false },
      executeSafeTrade,
      appendAuditEvent: async () => {},
      refreshPortfolioSnapshot: async () => makeSnapshot(100000),
    });

    expect(executeSafeTrade).not.toHaveBeenCalled();
    expect(result.blockedOrders).toHaveLength(1);
    expect(result.blockedOrders[0]!.blockReason).toContain("AUTOPILOT_ALLOW_SELL");
  });

  it("blocks a BUY leg when AUTOPILOT_ALLOW_BUY is false, without calling executeSafeTrade for it", async () => {
    const orders: RebalanceOrder[] = [
      { ticker: "SPY", action: "BUY", shares: 10, targetWeightPercent: 50 },
    ];
    const executeSafeTrade = vi.fn(throwingExecuteSafeTrade());

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: { ...ALLOW_ALL, allowBuy: false },
      executeSafeTrade,
      appendAuditEvent: async () => {},
      refreshPortfolioSnapshot: async () => makeSnapshot(100000),
    });

    expect(executeSafeTrade).not.toHaveBeenCalled();
    expect(result.blockedOrders).toHaveLength(1);
    expect(result.blockedOrders[0]!.blockReason).toContain("AUTOPILOT_ALLOW_BUY");
  });

  it("a disallowed SELL does not prevent an unrelated ticker's allowed BUY from proceeding", async () => {
    const orders: RebalanceOrder[] = [
      { ticker: "GLD", action: "SELL", shares: 5 },
      { ticker: "SPY", action: "BUY", shares: 10, targetWeightPercent: 50 },
    ];

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: { ...ALLOW_ALL, allowSell: false },
      executeSafeTrade: successfulExecuteSafeTrade(),
      appendAuditEvent: async () => {},
      refreshPortfolioSnapshot: async () => makeSnapshot(100000),
    });

    expect(result.blockedOrders.map((o) => o.ticker)).toEqual(["GLD"]);
    expect(result.executedOrders.map((o) => o.ticker)).toEqual(["SPY"]);
  });
});

describe("executeEtfRotationOrders - SELL-before-BUY sequencing", () => {
  it("calls executeSafeTrade for all SELL legs before any BUY leg", async () => {
    const callOrder: string[] = [];
    const executeSafeTrade: EtfRotationExecuteSafeTrade = async (ticker, action) => {
      callOrder.push(`${ticker}:${action}`);
      return { status: "success", order: { id: `broker-${ticker}` } };
    };

    const orders: RebalanceOrder[] = [
      { ticker: "SPY", action: "BUY", shares: 10, targetWeightPercent: 50 },
      { ticker: "QQQ", action: "BUY", shares: 5, targetWeightPercent: 50 },
      { ticker: "GLD", action: "SELL", shares: 3 },
      { ticker: "TLT", action: "SELL", shares: 4 },
    ];

    await executeEtfRotationOrders({
      ...baseParams,
      currentPriceByTicker: new Map([
        ["SPY", 500],
        ["QQQ", 400],
        ["GLD", 200],
        ["TLT", 90],
      ]),
      orders,
      executionGates: ALLOW_ALL,
      executeSafeTrade,
      appendAuditEvent: async () => {},
      refreshPortfolioSnapshot: async () => makeSnapshot(100000),
    });

    expect(callOrder).toEqual(["GLD:SELL", "TLT:SELL", "SPY:BUY", "QQQ:BUY"]);
  });
});

describe("executeEtfRotationOrders - failed SELL blocks its paired BUY", () => {
  it("does not call executeSafeTrade for a ticker's BUY leg when that same ticker's SELL leg failed", async () => {
    const buyAttempts: string[] = [];
    const executeSafeTrade: EtfRotationExecuteSafeTrade = async (ticker, action) => {
      if (action === "SELL" && ticker === "SPY") {
        return { status: "rejected", reason: "insufficient shares to sell" };
      }
      buyAttempts.push(ticker);
      return { status: "success", order: { id: `broker-${ticker}` } };
    };

    // SPY continues as a target (both a SELL of old shares and a BUY to
    // rebuild), QQQ is a brand-new pick with only a BUY leg.
    const orders: RebalanceOrder[] = [
      { ticker: "SPY", action: "SELL", shares: 20 },
      { ticker: "SPY", action: "BUY", shares: 25, targetWeightPercent: 50 },
      { ticker: "QQQ", action: "BUY", shares: 10, targetWeightPercent: 50 },
    ];

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: ALLOW_ALL,
      executeSafeTrade,
      appendAuditEvent: async () => {},
      refreshPortfolioSnapshot: async () => makeSnapshot(100000),
    });

    expect(buyAttempts).toEqual(["QQQ"]);
    expect(result.blockedOrders.map((o) => `${o.ticker}:${o.action}`)).toEqual([
      "SPY:BUY",
    ]);
    expect(result.failedOrders.map((o) => `${o.ticker}:${o.action}`)).toEqual([
      "SPY:SELL",
    ]);
    expect(result.executedOrders.map((o) => o.ticker)).toEqual(["QQQ"]);
    expect(result.status).toBe("partial");
  });
});

describe("executeEtfRotationOrders - audit events per outcome", () => {
  it("writes ORDER_SUBMITTED then ORDER_FILLED for a successful leg", async () => {
    const audit = collectingAuditRecorder();
    const orders: RebalanceOrder[] = [
      { ticker: "SPY", action: "BUY", shares: 10, targetWeightPercent: 50 },
    ];

    await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: ALLOW_ALL,
      executeSafeTrade: successfulExecuteSafeTrade("broker-abc"),
      appendAuditEvent: audit.appendAuditEvent,
      refreshPortfolioSnapshot: async () => makeSnapshot(100000),
    });

    expect(audit.events.map((e) => e.type)).toEqual([
      "ORDER_SUBMITTED",
      "ORDER_FILLED",
    ]);
    expect(audit.events[1]!.brokerOrderId).toBe("broker-abc");
  });

  it("writes ORDER_REJECTED for a definitive (non-ambiguous) rejection", async () => {
    const audit = collectingAuditRecorder();
    const orders: RebalanceOrder[] = [
      { ticker: "GLD", action: "SELL", shares: 5 },
    ];
    const executeSafeTrade: EtfRotationExecuteSafeTrade = async () => {
      const error = new Error("insufficient buying power") as Error & {
        response?: { status: number; data: { message: string } };
      };
      error.response = { status: 403, data: { message: "forbidden" } };
      throw error;
    };

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: ALLOW_ALL,
      executeSafeTrade,
      appendAuditEvent: audit.appendAuditEvent,
      refreshPortfolioSnapshot: async () => makeSnapshot(100000),
    });

    expect(audit.events.map((e) => e.type)).toEqual([
      "ORDER_SUBMITTED",
      "ORDER_REJECTED",
    ]);
    expect(result.failedOrders).toHaveLength(1);
    expect(result.ambiguousOrders).toHaveLength(0);
    expect(result.status).toBe("failed");
  });

  it("writes ORDER_AMBIGUOUS for a thrown error with no response (network-level failure)", async () => {
    const audit = collectingAuditRecorder();
    const orders: RebalanceOrder[] = [
      { ticker: "GLD", action: "SELL", shares: 5 },
    ];
    const executeSafeTrade: EtfRotationExecuteSafeTrade = async () => {
      throw new Error("socket hang up");
    };

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: ALLOW_ALL,
      executeSafeTrade,
      appendAuditEvent: audit.appendAuditEvent,
      refreshPortfolioSnapshot: async () => makeSnapshot(100000),
    });

    expect(audit.events.map((e) => e.type)).toEqual([
      "ORDER_SUBMITTED",
      "ORDER_AMBIGUOUS",
    ]);
    expect(result.ambiguousOrders).toHaveLength(1);
    expect(result.failedOrders).toHaveLength(0);
    expect(result.status).toBe("ambiguous");
  });

  it("does not write any audit event for a blocked (never-attempted) leg", async () => {
    const audit = collectingAuditRecorder();
    const orders: RebalanceOrder[] = [
      { ticker: "SPY", action: "BUY", shares: 10, targetWeightPercent: 50 },
    ];

    await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: { ...ALLOW_ALL, allowBuy: false },
      executeSafeTrade: throwingExecuteSafeTrade(),
      appendAuditEvent: audit.appendAuditEvent,
      refreshPortfolioSnapshot: async () => makeSnapshot(100000),
    });

    expect(audit.events).toHaveLength(0);
  });
});

describe("executeEtfRotationOrders - cash-aware BUY resizing", () => {
  it("resizes a BUY leg down when refreshed cash can't cover the full requested quantity", async () => {
    const orders: RebalanceOrder[] = [
      { ticker: "SPY", action: "BUY", shares: 100, targetWeightPercent: 50 },
    ];

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: ALLOW_ALL,
      executeSafeTrade: successfulExecuteSafeTrade(),
      appendAuditEvent: async () => {},
      // $500/share, only $10,000 available -> can afford 20 shares, not 100.
      refreshPortfolioSnapshot: async () => makeSnapshot(10000),
    });

    expect(result.executedOrders).toHaveLength(1);
    expect(result.executedOrders[0]!.requestedQty).toBe(100);
    expect(result.executedOrders[0]!.submittedQty).toBe(20);
  });

  it("blocks a BUY leg entirely when refreshed cash can't afford even one share", async () => {
    const orders: RebalanceOrder[] = [
      { ticker: "SPY", action: "BUY", shares: 10, targetWeightPercent: 50 },
    ];

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: ALLOW_ALL,
      executeSafeTrade: throwingExecuteSafeTrade(),
      appendAuditEvent: async () => {},
      refreshPortfolioSnapshot: async () => makeSnapshot(100), // $100 cash, SPY is $500/share
    });

    expect(result.blockedOrders).toHaveLength(1);
    expect(result.blockedOrders[0]!.blockReason).toContain("Insufficient available cash");
  });

  it("decrements the available cash pool across multiple BUY legs in the same cycle", async () => {
    const submittedQtyByTicker: Record<string, number> = {};
    const executeSafeTrade: EtfRotationExecuteSafeTrade = async (ticker, _action, shares) => {
      submittedQtyByTicker[ticker] = shares;
      return { status: "success", order: { id: `broker-${ticker}` } };
    };

    // $50,000 available. SPY wants 100 shares @ $500 = $50,000 (all of it).
    // QQQ wants 50 shares @ $400 = $20,000, but nothing should be left after SPY.
    const orders: RebalanceOrder[] = [
      { ticker: "SPY", action: "BUY", shares: 100, targetWeightPercent: 50 },
      { ticker: "QQQ", action: "BUY", shares: 50, targetWeightPercent: 50 },
    ];

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: ALLOW_ALL,
      executeSafeTrade,
      appendAuditEvent: async () => {},
      refreshPortfolioSnapshot: async () => makeSnapshot(50000),
    });

    expect(submittedQtyByTicker.SPY).toBe(100);
    expect(submittedQtyByTicker.QQQ).toBeUndefined();
    expect(result.blockedOrders.map((o) => o.ticker)).toEqual(["QQQ"]);
    expect(result.blockedOrders[0]!.blockReason).toContain("Insufficient available cash");
  });
});

describe("executeEtfRotationOrders - state machine isolation", () => {
  it("returns a plain result object with no side effects beyond the injected callbacks (no state-machine writes)", async () => {
    const refreshCalls: number[] = [];
    const orders: RebalanceOrder[] = [
      { ticker: "SPY", action: "BUY", shares: 10, targetWeightPercent: 50 },
    ];

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: ALLOW_ALL,
      executeSafeTrade: successfulExecuteSafeTrade(),
      appendAuditEvent: async () => {},
      refreshPortfolioSnapshot: async () => {
        refreshCalls.push(1);
        return makeSnapshot(100000);
      },
    });

    // The only injected side effects are appendAuditEvent, executeSafeTrade,
    // and refreshPortfolioSnapshot - all supplied by the caller. This
    // module has no import of etfRotationWorkerState.ts at all, so there is
    // no code path here that could write planned/executing/executed state.
    expect(refreshCalls).toHaveLength(1);
    expect(result).toEqual({
      status: "executed",
      executedOrders: result.executedOrders,
      failedOrders: [],
      blockedOrders: [],
      ambiguousOrders: [],
    });
  });
});

describe("computeOverallExecutionStatus", () => {
  it("is 'executed' for an empty order set (nothing needed)", () => {
    expect(
      computeOverallExecutionStatus({ executed: 0, failed: 0, blocked: 0, ambiguous: 0, total: 0 }),
    ).toBe("executed");
  });

  it("is 'ambiguous' whenever any leg is ambiguous, regardless of other outcomes", () => {
    expect(
      computeOverallExecutionStatus({ executed: 3, failed: 0, blocked: 0, ambiguous: 1, total: 4 }),
    ).toBe("ambiguous");
  });

  it("is 'executed' when every leg executed", () => {
    expect(
      computeOverallExecutionStatus({ executed: 4, failed: 0, blocked: 0, ambiguous: 0, total: 4 }),
    ).toBe("executed");
  });

  it("is 'blocked' when nothing executed or failed, only blocked", () => {
    expect(
      computeOverallExecutionStatus({ executed: 0, failed: 0, blocked: 3, ambiguous: 0, total: 3 }),
    ).toBe("blocked");
  });

  it("is 'partial' when some legs executed and others did not", () => {
    expect(
      computeOverallExecutionStatus({ executed: 2, failed: 1, blocked: 0, ambiguous: 0, total: 3 }),
    ).toBe("partial");
  });

  it("is 'failed' when nothing executed but some legs failed", () => {
    expect(
      computeOverallExecutionStatus({ executed: 0, failed: 2, blocked: 1, ambiguous: 0, total: 3 }),
    ).toBe("failed");
  });
});
