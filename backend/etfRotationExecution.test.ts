import { describe, expect, it, vi } from "vitest";

import {
  computeOverallExecutionStatus,
  computeRampMaxShares,
  createWaitForSellFill,
  executeEtfRotationOrders,
  resolveEtfRotationSellFillTimingMs,
  resolveMaxAllowedPositions,
  resolveRampMaxPositionEquityPercent,
  type EtfRotationExecutionGates,
  type EtfRotationSubmitOrderLeg,
  type GetOrderStatus,
} from "./etfRotationExecution.js";
import type {
  EtfRotationOrderAuditEvent,
} from "./etfRotationOrderAuditLog.js";
import type { RebalanceOrder } from "./etfRotationStrategy.js";
import type { PortfolioSnapshot } from "./src/strategy/portfolioSafety.js";

const ALLOW_ALL: EtfRotationExecutionGates = {
  executeTradesEnabled: true,
  allowBuy: true,
  allowRebalanceSells: true,
  maxAllowedPositions: Number.POSITIVE_INFINITY,
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

function throwingSubmitOrderLeg(): EtfRotationSubmitOrderLeg {
  return async () => {
    throw new Error(
      "submitOrderLeg should NEVER be called for this test scenario.",
    );
  };
}

function acceptingSubmitOrderLeg(
  brokerOrderId = "broker-1",
): EtfRotationSubmitOrderLeg {
  return async () => ({ outcome: "accepted", brokerOrderId });
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
  // Matches pre-fill-confirmation-wait behavior for every test that doesn't
  // care about this specifically - a rebuild BUY proceeds immediately.
  waitForSellFill: async () => "filled" as const,
};

describe("executeEtfRotationOrders - global execute-trades gate", () => {
  it("never calls submitOrderLeg when AUTOPILOT_EXECUTE_TRADES is false, and blocks every leg", async () => {
    const orders: RebalanceOrder[] = [
      { ticker: "SPY", action: "BUY", shares: 10, targetWeightPercent: 50 },
      { ticker: "GLD", action: "SELL", shares: 5 },
    ];
    const audit = collectingAuditRecorder();

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: { ...ALLOW_ALL, executeTradesEnabled: false },
      submitOrderLeg: throwingSubmitOrderLeg(),
      appendAuditEvent: audit.appendAuditEvent,
      refreshPortfolioSnapshot: async () => makeSnapshot(100000),
    });

    expect(result.status).toBe("not_attempted");
    expect(result.blockedOrders).toHaveLength(2);
    expect(result.acceptedOrders).toHaveLength(0);
    expect(audit.events).toHaveLength(0);
  });
});

describe("executeEtfRotationOrders - per-leg side gates", () => {
  it("blocks a SELL leg when AUTOPILOT_ALLOW_REBALANCE_SELLS is false, without calling submitOrderLeg for it", async () => {
    const orders: RebalanceOrder[] = [
      { ticker: "GLD", action: "SELL", shares: 5 },
    ];
    const submitOrderLeg = vi.fn(throwingSubmitOrderLeg());

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: { ...ALLOW_ALL, allowRebalanceSells: false },
      submitOrderLeg,
      appendAuditEvent: async () => {},
      refreshPortfolioSnapshot: async () => makeSnapshot(100000),
    });

    expect(submitOrderLeg).not.toHaveBeenCalled();
    expect(result.blockedOrders).toHaveLength(1);
    expect(result.blockedOrders[0]!.blockReason).toContain("AUTOPILOT_ALLOW_REBALANCE_SELLS");
  });

  it("blocks a BUY leg when AUTOPILOT_ALLOW_BUY is false, without calling submitOrderLeg for it", async () => {
    const orders: RebalanceOrder[] = [
      { ticker: "SPY", action: "BUY", shares: 10, targetWeightPercent: 50 },
    ];
    const submitOrderLeg = vi.fn(throwingSubmitOrderLeg());

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: { ...ALLOW_ALL, allowBuy: false },
      submitOrderLeg,
      appendAuditEvent: async () => {},
      refreshPortfolioSnapshot: async () => makeSnapshot(100000),
    });

    expect(submitOrderLeg).not.toHaveBeenCalled();
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
      executionGates: { ...ALLOW_ALL, allowRebalanceSells: false },
      submitOrderLeg: acceptingSubmitOrderLeg(),
      appendAuditEvent: async () => {},
      refreshPortfolioSnapshot: async () => makeSnapshot(100000),
    });

    expect(result.blockedOrders.map((o) => o.ticker)).toEqual(["GLD"]);
    expect(result.acceptedOrders.map((o) => o.ticker)).toEqual(["SPY"]);
  });
});

describe("executeEtfRotationOrders - SELL-before-BUY sequencing", () => {
  it("calls submitOrderLeg for all SELL legs before any BUY leg", async () => {
    const callOrder: string[] = [];
    const submitOrderLeg: EtfRotationSubmitOrderLeg = async (ticker, action) => {
      callOrder.push(`${ticker}:${action}`);
      return { outcome: "accepted", brokerOrderId: `broker-${ticker}` };
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
      submitOrderLeg,
      appendAuditEvent: async () => {},
      refreshPortfolioSnapshot: async () => makeSnapshot(100000),
    });

    expect(callOrder).toEqual(["GLD:SELL", "TLT:SELL", "SPY:BUY", "QQQ:BUY"]);
  });
});

describe("executeEtfRotationOrders - failed SELL blocks its paired BUY", () => {
  it("does not call submitOrderLeg for a ticker's BUY leg when that same ticker's SELL leg was rejected", async () => {
    const buyAttempts: string[] = [];
    const submitOrderLeg: EtfRotationSubmitOrderLeg = async (ticker, action) => {
      if (action === "SELL" && ticker === "SPY") {
        return { outcome: "rejected", reason: "insufficient shares to sell" };
      }
      buyAttempts.push(ticker);
      return { outcome: "accepted", brokerOrderId: `broker-${ticker}` };
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
      submitOrderLeg,
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
    expect(result.acceptedOrders.map((o) => o.ticker)).toEqual(["QQQ"]);
    expect(result.status).toBe("partial");
  });
});

describe("executeEtfRotationOrders - audit events per outcome", () => {
  it("writes ORDER_SUBMITTED then ORDER_ACCEPTED for an accepted leg", async () => {
    const audit = collectingAuditRecorder();
    const orders: RebalanceOrder[] = [
      { ticker: "SPY", action: "BUY", shares: 10, targetWeightPercent: 50 },
    ];

    await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: ALLOW_ALL,
      submitOrderLeg: acceptingSubmitOrderLeg("broker-abc"),
      appendAuditEvent: audit.appendAuditEvent,
      refreshPortfolioSnapshot: async () => makeSnapshot(100000),
    });

    expect(audit.events.map((e) => e.type)).toEqual([
      "ORDER_SUBMITTED",
      "ORDER_ACCEPTED",
    ]);
    expect(audit.events[1]!.brokerOrderId).toBe("broker-abc");
  });

  it("writes ORDER_REJECTED when submitOrderLeg returns outcome: rejected", async () => {
    const audit = collectingAuditRecorder();
    const orders: RebalanceOrder[] = [
      { ticker: "GLD", action: "SELL", shares: 5 },
    ];
    const submitOrderLeg: EtfRotationSubmitOrderLeg = async () => ({
      outcome: "rejected",
      reason: "insufficient buying power",
    });

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: ALLOW_ALL,
      submitOrderLeg,
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

  it("writes ORDER_AMBIGUOUS when submitOrderLeg returns outcome: ambiguous", async () => {
    const audit = collectingAuditRecorder();
    const orders: RebalanceOrder[] = [
      { ticker: "GLD", action: "SELL", shares: 5 },
    ];
    const submitOrderLeg: EtfRotationSubmitOrderLeg = async () => ({
      outcome: "ambiguous",
      reason: "socket hang up - broker acknowledgement unknown",
    });

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: ALLOW_ALL,
      submitOrderLeg,
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

  it("treats an unexpected thrown error from submitOrderLeg as ambiguous, never a silent success or confident rejection", async () => {
    const audit = collectingAuditRecorder();
    const orders: RebalanceOrder[] = [
      { ticker: "GLD", action: "SELL", shares: 5 },
    ];
    const submitOrderLeg: EtfRotationSubmitOrderLeg = async () => {
      throw new Error("unexpected bug in the injected wrapper");
    };

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: ALLOW_ALL,
      submitOrderLeg,
      appendAuditEvent: audit.appendAuditEvent,
      refreshPortfolioSnapshot: async () => makeSnapshot(100000),
    });

    expect(result.ambiguousOrders).toHaveLength(1);
    expect(result.acceptedOrders).toHaveLength(0);
    expect(result.failedOrders).toHaveLength(0);
    expect(audit.events.map((e) => e.type)).toEqual([
      "ORDER_SUBMITTED",
      "ORDER_AMBIGUOUS",
    ]);
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
      submitOrderLeg: throwingSubmitOrderLeg(),
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
      submitOrderLeg: acceptingSubmitOrderLeg(),
      appendAuditEvent: async () => {},
      // $500/share, only $10,000 available -> can afford 20 shares, not 100.
      refreshPortfolioSnapshot: async () => makeSnapshot(10000),
    });

    expect(result.acceptedOrders).toHaveLength(1);
    expect(result.acceptedOrders[0]!.requestedQty).toBe(100);
    expect(result.acceptedOrders[0]!.submittedQty).toBe(20);
  });

  it("blocks a BUY leg entirely when refreshed cash can't afford even one share", async () => {
    const orders: RebalanceOrder[] = [
      { ticker: "SPY", action: "BUY", shares: 10, targetWeightPercent: 50 },
    ];

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: ALLOW_ALL,
      submitOrderLeg: throwingSubmitOrderLeg(),
      appendAuditEvent: async () => {},
      refreshPortfolioSnapshot: async () => makeSnapshot(100), // $100 cash, SPY is $500/share
    });

    expect(result.blockedOrders).toHaveLength(1);
    expect(result.blockedOrders[0]!.blockReason).toContain("Insufficient available cash");
  });

  it("decrements the available cash pool across multiple BUY legs in the same cycle", async () => {
    const submittedQtyByTicker: Record<string, number> = {};
    const submitOrderLeg: EtfRotationSubmitOrderLeg = async (ticker, _action, shares) => {
      submittedQtyByTicker[ticker] = shares;
      return { outcome: "accepted", brokerOrderId: `broker-${ticker}` };
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
      submitOrderLeg,
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
      submitOrderLeg: acceptingSubmitOrderLeg(),
      appendAuditEvent: async () => {},
      refreshPortfolioSnapshot: async () => {
        refreshCalls.push(1);
        return makeSnapshot(100000);
      },
    });

    // The only injected side effects are appendAuditEvent, submitOrderLeg,
    // and refreshPortfolioSnapshot - all supplied by the caller. This
    // module has no import of etfRotationWorkerState.ts at all, so there is
    // no code path here that could write planned/executing/executed state.
    expect(refreshCalls).toHaveLength(1);
    expect(result).toEqual({
      status: "accepted",
      acceptedOrders: result.acceptedOrders,
      failedOrders: [],
      blockedOrders: [],
      ambiguousOrders: [],
    });
  });
});

describe("computeOverallExecutionStatus", () => {
  it("is 'accepted' for an empty order set (nothing needed)", () => {
    expect(
      computeOverallExecutionStatus({ accepted: 0, failed: 0, blocked: 0, ambiguous: 0, total: 0 }),
    ).toBe("accepted");
  });

  it("is 'ambiguous' whenever any leg is ambiguous, regardless of other outcomes", () => {
    expect(
      computeOverallExecutionStatus({ accepted: 3, failed: 0, blocked: 0, ambiguous: 1, total: 4 }),
    ).toBe("ambiguous");
  });

  it("is 'accepted' when every leg was accepted", () => {
    expect(
      computeOverallExecutionStatus({ accepted: 4, failed: 0, blocked: 0, ambiguous: 0, total: 4 }),
    ).toBe("accepted");
  });

  it("is 'blocked' when nothing accepted or failed, only blocked", () => {
    expect(
      computeOverallExecutionStatus({ accepted: 0, failed: 0, blocked: 3, ambiguous: 0, total: 3 }),
    ).toBe("blocked");
  });

  it("is 'partial' when some legs accepted and others did not", () => {
    expect(
      computeOverallExecutionStatus({ accepted: 2, failed: 1, blocked: 0, ambiguous: 0, total: 3 }),
    ).toBe("partial");
  });

  it("is 'failed' when nothing accepted but some legs failed", () => {
    expect(
      computeOverallExecutionStatus({ accepted: 0, failed: 2, blocked: 1, ambiguous: 0, total: 3 }),
    ).toBe("failed");
  });
});

describe("executeEtfRotationOrders - ramp cap", () => {
  it("ramp unset reproduces byte-identical behavior to the existing cash-resize test (regression)", async () => {
    const orders: RebalanceOrder[] = [
      { ticker: "SPY", action: "BUY", shares: 100, targetWeightPercent: 50 },
    ];

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: { ...ALLOW_ALL, rampMaxPositionEquityPercent: undefined },
      submitOrderLeg: acceptingSubmitOrderLeg(),
      appendAuditEvent: async () => {},
      refreshPortfolioSnapshot: async () => makeSnapshot(10000),
    });

    expect(result.acceptedOrders).toHaveLength(1);
    expect(result.acceptedOrders[0]!.requestedQty).toBe(100);
    expect(result.acceptedOrders[0]!.submittedQty).toBe(20);
  });

  it("ramp binding tighter than cash resizes the BUY leg to the ramp-derived count", async () => {
    const orders: RebalanceOrder[] = [
      { ticker: "SPY", action: "BUY", shares: 100, targetWeightPercent: 50 },
    ];

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: { ...ALLOW_ALL, rampMaxPositionEquityPercent: 10 },
      submitOrderLeg: acceptingSubmitOrderLeg(),
      appendAuditEvent: async () => {},
      // $100,000 equity/cash - cash alone would afford 200 shares, but a
      // 10% ramp caps this leg to floor(0.10 * 100000 / 500) = 20 shares.
      refreshPortfolioSnapshot: async () => makeSnapshot(100000),
    });

    expect(result.acceptedOrders).toHaveLength(1);
    expect(result.acceptedOrders[0]!.requestedQty).toBe(100);
    expect(result.acceptedOrders[0]!.submittedQty).toBe(20);
  });

  it("cash binding tighter than ramp keeps the existing cash-specific block wording, not the ramp wording", async () => {
    const orders: RebalanceOrder[] = [
      { ticker: "SPY", action: "BUY", shares: 10, targetWeightPercent: 50 },
    ];

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      // Generous ramp (50% of a large equity) - not the binding constraint
      // here; cash is scarce despite equity being large (makeSnapshot ties
      // balance/equity together, so this is constructed directly).
      executionGates: { ...ALLOW_ALL, rampMaxPositionEquityPercent: 50 },
      submitOrderLeg: throwingSubmitOrderLeg(),
      appendAuditEvent: async () => {},
      refreshPortfolioSnapshot: async () => ({
        balance: 100, // $100 cash, SPY is $500/share
        equity: 1000000,
        currency: "USD",
        positions: {},
      }),
    });

    expect(result.blockedOrders).toHaveLength(1);
    expect(result.blockedOrders[0]!.blockReason).toContain("Insufficient available cash");
    expect(result.blockedOrders[0]!.blockReason).not.toContain("RAMP_MAX_POSITION_PERCENT");
  });

  it("ramp exactly zero fully blocks a BUY leg without ever calling submitOrderLeg", async () => {
    const orders: RebalanceOrder[] = [
      { ticker: "SPY", action: "BUY", shares: 10, targetWeightPercent: 50 },
    ];

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: { ...ALLOW_ALL, rampMaxPositionEquityPercent: 0 },
      submitOrderLeg: throwingSubmitOrderLeg(),
      appendAuditEvent: async () => {},
      // Cash is generous - proves ramp=0 alone is what blocks this, not cash.
      refreshPortfolioSnapshot: async () => makeSnapshot(1000000),
    });

    expect(result.blockedOrders).toHaveLength(1);
    expect(result.blockedOrders[0]!.blockReason).toContain(
      "AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT",
    );
    // "not_attempted" is reserved for the global executeTradesEnabled=false
    // gate specifically - a ramp-caused block (nothing accepted, nothing
    // failed) is "blocked", per computeOverallExecutionStatus's own rules.
    expect(result.status).toBe("blocked");
  });

  it("caps two independent BUY legs to their own ramp-derived count, not a shared pool", async () => {
    const submittedQtyByTicker: Record<string, number> = {};
    const submitOrderLeg: EtfRotationSubmitOrderLeg = async (ticker, _action, shares) => {
      submittedQtyByTicker[ticker] = shares;
      return { outcome: "accepted", brokerOrderId: `broker-${ticker}` };
    };

    const orders: RebalanceOrder[] = [
      { ticker: "SPY", action: "BUY", shares: 100, targetWeightPercent: 50 },
      { ticker: "QQQ", action: "BUY", shares: 100, targetWeightPercent: 50 },
    ];

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: { ...ALLOW_ALL, rampMaxPositionEquityPercent: 10 },
      submitOrderLeg,
      appendAuditEvent: async () => {},
      // $100,000 equity, plenty of cash - ramp is the only binding ceiling.
      // SPY @ $500: floor(0.10 * 100000 / 500) = 20.
      // QQQ @ $400: floor(0.10 * 100000 / 400) = 25.
      refreshPortfolioSnapshot: async () => makeSnapshot(100000),
    });

    expect(submittedQtyByTicker.SPY).toBe(20);
    expect(submittedQtyByTicker.QQQ).toBe(25);
    expect(result.acceptedOrders).toHaveLength(2);
  });

  it("applies the ramp cap the same way to a same-ticker SELL+BUY (rebuild_target) pair", async () => {
    const submittedQtyByTicker: Record<string, number> = {};
    const submitOrderLeg: EtfRotationSubmitOrderLeg = async (ticker, action, shares) => {
      if (action === "BUY") submittedQtyByTicker[ticker] = shares;
      return { outcome: "accepted", brokerOrderId: `broker-${ticker}-${action}` };
    };

    // SPY continues as a target (SELL of old shares, BUY to rebuild) -
    // the rebuild BUY leg should be ramp-capped exactly like a fresh-open
    // BUY leg, regardless of its legType.
    const orders: RebalanceOrder[] = [
      { ticker: "SPY", action: "SELL", shares: 20 },
      { ticker: "SPY", action: "BUY", shares: 100, targetWeightPercent: 50 },
    ];

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: { ...ALLOW_ALL, rampMaxPositionEquityPercent: 10 },
      submitOrderLeg,
      appendAuditEvent: async () => {},
      refreshPortfolioSnapshot: async () => makeSnapshot(100000),
    });

    expect(submittedQtyByTicker.SPY).toBe(20);
    expect(result.acceptedOrders.map((o) => `${o.ticker}:${o.action}`)).toEqual([
      "SPY:SELL",
      "SPY:BUY",
    ]);
  });
});

describe("executeEtfRotationOrders - max-allowed-positions guardrail", () => {
  it("blocks a BUY that would open a brand-new position once the cap is already reached", async () => {
    const submitOrderLeg = acceptingSubmitOrderLeg();
    const orders: RebalanceOrder[] = [
      { ticker: "GLD", action: "BUY", shares: 5, targetWeightPercent: 50 },
    ];

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: { ...ALLOW_ALL, maxAllowedPositions: 2 },
      submitOrderLeg,
      appendAuditEvent: async () => {},
      // Already holding 2 positions within the universe - GLD would be a
      // 3rd, brand-new one.
      refreshPortfolioSnapshot: async () => ({
        balance: 100000,
        equity: 100000,
        currency: "USD",
        positions: {
          SPY: { shares: 10, avgPrice: 400, currentPrice: 500, pnl: 1000, pnlPercent: 25 },
          QQQ: { shares: 10, avgPrice: 300, currentPrice: 400, pnl: 1000, pnlPercent: 33 },
        },
      }),
    });

    expect(result.blockedOrders).toHaveLength(1);
    expect(result.blockedOrders[0]!.blockReason).toContain(
      "AUTOPILOT_ETF_ROTATION_MAX_POSITIONS",
    );
  });

  it("does not block a BUY that resizes an already-open position, even at the cap", async () => {
    const submitOrderLeg = acceptingSubmitOrderLeg();
    const orders: RebalanceOrder[] = [
      { ticker: "SPY", action: "BUY", shares: 5, targetWeightPercent: 50 },
    ];

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: { ...ALLOW_ALL, maxAllowedPositions: 1 },
      submitOrderLeg,
      appendAuditEvent: async () => {},
      refreshPortfolioSnapshot: async () => ({
        balance: 100000,
        equity: 100000,
        currency: "USD",
        positions: {
          SPY: { shares: 10, avgPrice: 400, currentPrice: 500, pnl: 1000, pnlPercent: 25 },
        },
      }),
    });

    expect(result.acceptedOrders.map((o) => o.ticker)).toEqual(["SPY"]);
    expect(result.blockedOrders).toHaveLength(0);
  });

  it("counts a position opened earlier in the same cycle against a later BUY in that cycle", async () => {
    const submitOrderLeg = acceptingSubmitOrderLeg();
    const orders: RebalanceOrder[] = [
      { ticker: "SPY", action: "BUY", shares: 5, targetWeightPercent: 50 },
      { ticker: "QQQ", action: "BUY", shares: 5, targetWeightPercent: 50 },
    ];

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      // Already at 1 open position (GLD); cap of 2 allows exactly one more
      // brand-new position this cycle, not two.
      executionGates: { ...ALLOW_ALL, maxAllowedPositions: 2 },
      submitOrderLeg,
      appendAuditEvent: async () => {},
      refreshPortfolioSnapshot: async () => ({
        balance: 100000,
        equity: 100000,
        currency: "USD",
        positions: {
          GLD: { shares: 5, avgPrice: 150, currentPrice: 200, pnl: 250, pnlPercent: 33 },
        },
      }),
    });

    expect(result.acceptedOrders.map((o) => o.ticker)).toEqual(["SPY"]);
    expect(result.blockedOrders.map((o) => o.ticker)).toEqual(["QQQ"]);
    expect(result.blockedOrders[0]!.blockReason).toContain(
      "AUTOPILOT_ETF_ROTATION_MAX_POSITIONS",
    );
  });
});

describe("executeEtfRotationOrders - paired SELL fill-confirmation wait (2026-08-04 race-condition fix)", () => {
  function buildPairedOrders(): RebalanceOrder[] {
    return [
      { ticker: "SPY", action: "SELL", shares: 20 },
      { ticker: "SPY", action: "BUY", shares: 25, targetWeightPercent: 50 },
    ];
  }

  it("proceeds with the rebuild BUY when the wait confirms filled", async () => {
    const attempted: string[] = [];
    const submitOrderLeg: EtfRotationSubmitOrderLeg = async (ticker, action) => {
      attempted.push(`${ticker}:${action}`);
      return { outcome: "accepted", brokerOrderId: `broker-${ticker}-${action}` };
    };

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders: buildPairedOrders(),
      executionGates: ALLOW_ALL,
      submitOrderLeg,
      appendAuditEvent: async () => {},
      refreshPortfolioSnapshot: async () => makeSnapshot(100000),
      waitForSellFill: async () => "filled",
    });

    expect(attempted).toEqual(["SPY:SELL", "SPY:BUY"]);
    expect(result.acceptedOrders.map((o) => `${o.ticker}:${o.action}`)).toEqual([
      "SPY:SELL",
      "SPY:BUY",
    ]);
    expect(result.status).toBe("accepted");
  });

  it("demotes the SELL out of acceptedOrders (not left as a phantom success) and blocks the rebuild BUY when the wait finds the SELL definitively did not fill", async () => {
    const attempted: string[] = [];
    const submitOrderLeg: EtfRotationSubmitOrderLeg = async (ticker, action) => {
      attempted.push(`${ticker}:${action}`);
      return { outcome: "accepted", brokerOrderId: `broker-${ticker}-${action}` };
    };
    const audit = collectingAuditRecorder();

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders: buildPairedOrders(),
      executionGates: ALLOW_ALL,
      submitOrderLeg,
      appendAuditEvent: audit.appendAuditEvent,
      refreshPortfolioSnapshot: async () => makeSnapshot(100000),
      waitForSellFill: async () => "definitively_not_filled",
    });

    // The BUY leg is never even attempted (submitOrderLeg not called for it).
    expect(attempted).toEqual(["SPY:SELL"]);

    // The SELL must NOT remain in acceptedOrders - the initial "accepted"
    // signal is superseded by the later, confirmed "did not fill" fact.
    // A leftover acceptedOrders entry here would report "partial" (a
    // TERMINAL_SUCCESS_STATUSES value that closes the monthly gate) for a
    // SELL that definitively never happened, and would show as "executed"
    // in the journal - the exact bug caught in review before merge.
    expect(result.acceptedOrders).toHaveLength(0);
    expect(result.failedOrders.map((o) => `${o.ticker}:${o.action}`)).toEqual([
      "SPY:SELL",
    ]);
    expect(result.blockedOrders.map((o) => `${o.ticker}:${o.action}`)).toEqual([
      "SPY:BUY",
    ]);
    expect(result.ambiguousOrders).toHaveLength(0);

    // Nothing accepted, one failed, one blocked - "failed", not "partial".
    expect(result.status).toBe("failed");

    // The audit trail records the demotion explicitly, not just silently
    // leaving the original ORDER_ACCEPTED entry as the last word on it.
    const sellEvents = audit.events.filter((e) => e.ticker === "SPY" && e.side === "SELL");
    expect(sellEvents.map((e) => e.type)).toEqual([
      "ORDER_SUBMITTED",
      "ORDER_ACCEPTED",
      "ORDER_REJECTED",
    ]);
  });

  it("escalates to ambiguous (not a plain block) when the SELL fill cannot be confirmed within the timeout", async () => {
    const attempted: string[] = [];
    const submitOrderLeg: EtfRotationSubmitOrderLeg = async (ticker, action) => {
      attempted.push(`${ticker}:${action}`);
      return { outcome: "accepted", brokerOrderId: `broker-${ticker}-${action}` };
    };
    const audit = collectingAuditRecorder();

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders: buildPairedOrders(),
      executionGates: ALLOW_ALL,
      submitOrderLeg,
      appendAuditEvent: audit.appendAuditEvent,
      refreshPortfolioSnapshot: async () => makeSnapshot(100000),
      waitForSellFill: async () => "unconfirmed",
    });

    // The BUY leg is never attempted, and appears exactly once (in
    // ambiguousOrders) - never also duplicated into blockedOrders.
    expect(attempted).toEqual(["SPY:SELL"]);
    expect(result.blockedOrders).toHaveLength(0);
    expect(result.ambiguousOrders.map((o) => `${o.ticker}:${o.action}`)).toEqual([
      "SPY:BUY",
    ]);
    expect(result.status).toBe("ambiguous");
    expect(audit.events.map((e) => e.type)).toContain("PAIRED_SELL_FILL_UNCONFIRMED");
  });

  it("calls waitForSellFill for an exit_removed SELL too (no paired BUY, but still needs fill confirmation - 2026-08-08 generalization) and proceeds normally when filled", async () => {
    const orders: RebalanceOrder[] = [{ ticker: "GLD", action: "SELL", shares: 10 }];
    const waitForSellFill = vi.fn(async (): Promise<"filled"> => "filled");

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: ALLOW_ALL,
      submitOrderLeg: acceptingSubmitOrderLeg(),
      appendAuditEvent: async () => {},
      refreshPortfolioSnapshot: async () => makeSnapshot(100000),
      waitForSellFill,
    });

    expect(waitForSellFill).toHaveBeenCalledTimes(1);
    expect(waitForSellFill).toHaveBeenCalledWith("broker-1", "GLD");
    expect(result.acceptedOrders.map((o) => o.ticker)).toEqual(["GLD"]);
  });

  it("demotes an unpaired (exit_removed) SELL to ambiguousOrders - not failedOrders - when its own fill cannot be confirmed (2026-08-08)", async () => {
    const orders: RebalanceOrder[] = [{ ticker: "GLD", action: "SELL", shares: 10 }];
    const audit = collectingAuditRecorder();

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: ALLOW_ALL,
      submitOrderLeg: acceptingSubmitOrderLeg(),
      appendAuditEvent: audit.appendAuditEvent,
      refreshPortfolioSnapshot: async () => makeSnapshot(100000),
      waitForSellFill: async () => "unconfirmed",
    });

    // No paired BUY exists for GLD, so there's nothing to redirect into
    // ambiguousOrders except the SELL leg itself.
    expect(result.acceptedOrders).toHaveLength(0);
    expect(result.failedOrders).toHaveLength(0);
    expect(result.blockedOrders).toHaveLength(0);
    expect(result.ambiguousOrders.map((o) => `${o.ticker}:${o.action}`)).toEqual([
      "GLD:SELL",
    ]);
    expect(result.status).toBe("ambiguous");

    const gldEvents = audit.events.filter((e) => e.ticker === "GLD");
    expect(gldEvents.map((e) => e.type)).toEqual([
      "ORDER_SUBMITTED",
      "ORDER_ACCEPTED",
      "ORDER_AMBIGUOUS",
    ]);
  });

  it("demotes an unpaired (exit_removed) SELL to failedOrders when it definitively did not fill (2026-08-08 - previously unreachable for an unpaired ticker)", async () => {
    const orders: RebalanceOrder[] = [{ ticker: "GLD", action: "SELL", shares: 10 }];
    const audit = collectingAuditRecorder();

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: ALLOW_ALL,
      submitOrderLeg: acceptingSubmitOrderLeg(),
      appendAuditEvent: audit.appendAuditEvent,
      refreshPortfolioSnapshot: async () => makeSnapshot(100000),
      waitForSellFill: async () => "definitively_not_filled",
    });

    expect(result.acceptedOrders).toHaveLength(0);
    expect(result.ambiguousOrders).toHaveLength(0);
    expect(result.failedOrders.map((o) => `${o.ticker}:${o.action}`)).toEqual([
      "GLD:SELL",
    ]);
    expect(result.status).toBe("failed");

    const gldEvents = audit.events.filter((e) => e.ticker === "GLD");
    expect(gldEvents.map((e) => e.type)).toEqual([
      "ORDER_SUBMITTED",
      "ORDER_ACCEPTED",
      "ORDER_REJECTED",
    ]);
  });

  it("the actual settlement-barrier proof: waitForSellFill is awaited for an unpaired SELL before refreshPortfolioSnapshot is ever called (2026-08-08)", async () => {
    const callOrder: string[] = [];
    const orders: RebalanceOrder[] = [
      { ticker: "GLD", action: "SELL", shares: 10 },
      { ticker: "QQQ", action: "BUY", shares: 5, targetWeightPercent: 50 },
    ];

    const submitOrderLeg: EtfRotationSubmitOrderLeg = async (ticker, action) => {
      callOrder.push(`submit:${ticker}:${action}`);
      return { outcome: "accepted", brokerOrderId: `broker-${ticker}` };
    };
    const waitForSellFill = vi.fn(async (): Promise<"filled"> => {
      callOrder.push("wait:GLD");
      return "filled";
    });

    await executeEtfRotationOrders({
      ...baseParams,
      orders,
      executionGates: ALLOW_ALL,
      submitOrderLeg,
      appendAuditEvent: async () => {},
      refreshPortfolioSnapshot: async () => {
        callOrder.push("refresh");
        return makeSnapshot(100000);
      },
      waitForSellFill,
    });

    // GLD's SELL is unpaired (no GLD BUY this cycle) - before this PR,
    // waitForSellFill was never called for it at all, so "refresh" could
    // run (and the BUY phase could size/gate itself) before GLD's fill was
    // ever confirmed. Now the wait must happen, and it must happen before
    // the refresh that the BUY phase depends on.
    expect(callOrder).toEqual([
      "submit:GLD:SELL",
      "wait:GLD",
      "refresh",
      "submit:QQQ:BUY",
    ]);
  });

  it("never calls waitForSellFill when the SELL leg itself is gated off before ever reaching the broker", async () => {
    const waitForSellFill = vi.fn(async (): Promise<"filled"> => {
      throw new Error("waitForSellFill should never be called when the SELL is gated off.");
    });

    const result = await executeEtfRotationOrders({
      ...baseParams,
      orders: buildPairedOrders(),
      executionGates: { ...ALLOW_ALL, allowRebalanceSells: false },
      submitOrderLeg: throwingSubmitOrderLeg(),
      appendAuditEvent: async () => {},
      refreshPortfolioSnapshot: async () => makeSnapshot(100000),
      waitForSellFill,
    });

    expect(waitForSellFill).not.toHaveBeenCalled();
    expect(result.blockedOrders.map((o) => `${o.ticker}:${o.action}`)).toEqual(
      expect.arrayContaining(["SPY:SELL", "SPY:BUY"]),
    );
  });
});

describe("createWaitForSellFill", () => {
  it("returns filled immediately when the first poll already shows filled", async () => {
    const getOrderStatus: GetOrderStatus = async () => "filled";
    const waitForSellFill = createWaitForSellFill(getOrderStatus, 5, 50);

    await expect(waitForSellFill("order-1", "SPY")).resolves.toBe("filled");
  });

  it("polls multiple times before returning filled", async () => {
    const statuses = ["accepted", "accepted", "filled"];
    let callCount = 0;
    const getOrderStatus: GetOrderStatus = async () => statuses[callCount++] ?? "filled";
    const waitForSellFill = createWaitForSellFill(getOrderStatus, 5, 200);

    await expect(waitForSellFill("order-1", "SPY")).resolves.toBe("filled");
    expect(callCount).toBe(3);
  });

  it("returns definitively_not_filled on a terminal negative status", async () => {
    const getOrderStatus: GetOrderStatus = async () => "rejected";
    const waitForSellFill = createWaitForSellFill(getOrderStatus, 5, 50);

    await expect(waitForSellFill("order-1", "SPY")).resolves.toBe(
      "definitively_not_filled",
    );
  });

  it("returns unconfirmed when still pending once the timeout elapses", async () => {
    const getOrderStatus: GetOrderStatus = async () => "accepted";
    const waitForSellFill = createWaitForSellFill(getOrderStatus, 5, 20);

    await expect(waitForSellFill("order-1", "SPY")).resolves.toBe("unconfirmed");
  });

  it("treats a getOrderStatus failure as still-pending and keeps polling instead of throwing", async () => {
    let callCount = 0;
    const getOrderStatus: GetOrderStatus = async () => {
      callCount++;
      if (callCount < 3) throw new Error("transient network error");
      return "filled";
    };
    const waitForSellFill = createWaitForSellFill(getOrderStatus, 5, 200);

    await expect(waitForSellFill("order-1", "SPY")).resolves.toBe("filled");
    expect(callCount).toBe(3);
  });
});

describe("resolveEtfRotationSellFillTimingMs", () => {
  it("defaults to 10000ms timeout / 500ms poll when both env vars are absent", () => {
    expect(resolveEtfRotationSellFillTimingMs(undefined, undefined)).toEqual({
      timeoutMs: 10000,
      pollIntervalMs: 500,
    });
  });

  it("uses explicit values when set", () => {
    expect(resolveEtfRotationSellFillTimingMs("15000", "250")).toEqual({
      timeoutMs: 15000,
      pollIntervalMs: 250,
    });
  });

  it("throws on a non-numeric timeout value instead of silently truncating it", () => {
    expect(() => resolveEtfRotationSellFillTimingMs("10abc", undefined)).toThrow();
  });

  it("throws on a non-numeric poll interval value", () => {
    expect(() => resolveEtfRotationSellFillTimingMs(undefined, "5 ms")).toThrow();
  });

  it("throws on a negative value", () => {
    expect(() => resolveEtfRotationSellFillTimingMs("-1000", undefined)).toThrow();
  });
});

describe("computeRampMaxShares", () => {
  it("is Infinity when the ramp percent is undefined (uncapped)", () => {
    expect(computeRampMaxShares(500, 100000, undefined)).toBe(Infinity);
  });

  it("floors the share count for a normal percent", () => {
    expect(computeRampMaxShares(500, 100000, 10)).toBe(20);
  });

  it("is 0 when the ramp percent is 0", () => {
    expect(computeRampMaxShares(500, 100000, 0)).toBe(0);
  });
});

describe("resolveRampMaxPositionEquityPercent", () => {
  it("returns undefined when the env var is genuinely absent", () => {
    expect(resolveRampMaxPositionEquityPercent(undefined)).toBeUndefined();
  });

  it("parses a normal value", () => {
    expect(resolveRampMaxPositionEquityPercent("10")).toBe(10);
  });

  it("returns 0 (not undefined) when explicitly set to zero - the footgun case", () => {
    expect(resolveRampMaxPositionEquityPercent("0")).toBe(0);
  });

  it("throws on a negative value", () => {
    expect(() => resolveRampMaxPositionEquityPercent("-5")).toThrow();
  });

  it("throws on a value over 100", () => {
    expect(() => resolveRampMaxPositionEquityPercent("150")).toThrow();
  });

  it("throws on a non-numeric value", () => {
    expect(() => resolveRampMaxPositionEquityPercent("abc")).toThrow();
  });

  it("throws on a partially-numeric value instead of silently truncating it (parseFloat footgun)", () => {
    // Number.parseFloat("10abc") === 10 - a strict parse must reject this,
    // not silently accept the leading numeric portion.
    expect(() => resolveRampMaxPositionEquityPercent("10abc")).toThrow();
  });

  it("throws on a value with an embedded unit/word", () => {
    expect(() => resolveRampMaxPositionEquityPercent("5 percent")).toThrow();
  });

  it("tolerates surrounding whitespace but still parses correctly", () => {
    expect(resolveRampMaxPositionEquityPercent(" 10 \n")).toBe(10);
  });
});

describe("resolveMaxAllowedPositions", () => {
  it("defaults to holdCount+1 when the env var is genuinely absent", () => {
    expect(resolveMaxAllowedPositions(undefined, 2)).toBe(3);
    expect(resolveMaxAllowedPositions(undefined, 3)).toBe(4);
  });

  it("uses the explicit value when set", () => {
    expect(resolveMaxAllowedPositions("5", 2)).toBe(5);
  });

  it("allows 0 (block all new-position BUYs)", () => {
    expect(resolveMaxAllowedPositions("0", 2)).toBe(0);
  });

  it("throws on a negative value", () => {
    expect(() => resolveMaxAllowedPositions("-1", 2)).toThrow();
  });

  it("throws on a non-integer value", () => {
    expect(() => resolveMaxAllowedPositions("2.5", 2)).toThrow();
  });

  it("throws on a non-numeric value", () => {
    expect(() => resolveMaxAllowedPositions("abc", 2)).toThrow();
  });
});
