import { promises as fs } from "fs";
import os from "os";
import path from "path";

import { describe, expect, it, vi } from "vitest";

import {
  checkEtfRotationRepairPolicyGates,
  computeRepairBuyShares,
  hasAcceptedPriorRepair,
  decideEtfRotationRepairEligibility,
  decideEtfRotationRepairPreconditions,
  decideEtfRotationRepairSizing,
  performEtfRotationRepairMissingBuy,
  type EtfRotationRepairDecision,
} from "./etfRotationRepair.js";
import type { EtfRotationOrderAuditEvent } from "./etfRotationOrderAuditLog.js";
import type { EtfRotationOffTargetState } from "./etfRotationReview.js";
import type { RebalanceStateReadResult } from "./etfRotationWorkerState.js";
import type { PortfolioSnapshot } from "./src/strategy/portfolioSafety.js";
import type { ExecuteSafeTradeResult } from "./src/types/autopilotTypes.js";

// Manual QQQ off-target repair-flow, built after the real 2026-08-03
// incident (a rebuild BUY rejected mid-rebalance left QQQ at 0 shares).
// Execution-adjacent (submits a real, paper-only order), so this test file
// is deliberately thorough - direct tests for every pure function, plus
// orchestrator-level tests against performEtfRotationRepairMissingBuy with
// fake I/O, matching the user's own explicit pre-merge scenario list.

const MONTH = "2026-08";

describe("checkEtfRotationRepairPolicyGates", () => {
  const paperAllowed = {
    tradeMode: "paper",
    activeStrategy: "etf_rotation",
    executeTradesEnabled: true,
    allowBuyEnabled: true,
  };

  it("allows when paper mode, etf_rotation is active, and both trade gates are enabled", () => {
    expect(checkEtfRotationRepairPolicyGates(paperAllowed)).toEqual({ allowed: true });
  });

  it("blocks with LIVE_MODE_NOT_SUPPORTED when tradeMode is not paper - hard, unconditional block", () => {
    const result = checkEtfRotationRepairPolicyGates({ ...paperAllowed, tradeMode: "live" });
    expect(result).toEqual({
      allowed: false,
      code: "LIVE_MODE_NOT_SUPPORTED",
      error: expect.stringContaining("paper-only"),
    });
  });

  it("blocks with ETF_ROTATION_STRATEGY_DISABLED when AUTOPILOT_STRATEGY isn't etf_rotation - prevents repairing stale rotation state after a switch back to baseline", () => {
    const result = checkEtfRotationRepairPolicyGates({
      ...paperAllowed,
      activeStrategy: "baseline",
    });
    expect(result).toEqual({
      allowed: false,
      code: "ETF_ROTATION_STRATEGY_DISABLED",
      error: expect.stringContaining("etf_rotation"),
    });
  });

  it("blocks with EXECUTE_TRADES_DISABLED when AUTOPILOT_EXECUTE_TRADES is off", () => {
    const result = checkEtfRotationRepairPolicyGates({
      ...paperAllowed,
      executeTradesEnabled: false,
    });
    expect(result.allowed).toBe(false);
    expect((result as { code: string }).code).toBe("EXECUTE_TRADES_DISABLED");
  });

  it("blocks with ALLOW_BUY_DISABLED when AUTOPILOT_ALLOW_BUY is off", () => {
    const result = checkEtfRotationRepairPolicyGates({
      ...paperAllowed,
      allowBuyEnabled: false,
    });
    expect(result.allowed).toBe(false);
    expect((result as { code: string }).code).toBe("ALLOW_BUY_DISABLED");
  });

  it("checks tradeMode before the strategy/trade gates, matching the endpoint's stated check order", () => {
    const result = checkEtfRotationRepairPolicyGates({
      tradeMode: "live",
      activeStrategy: "baseline",
      executeTradesEnabled: false,
      allowBuyEnabled: false,
    });
    expect((result as { code: string }).code).toBe("LIVE_MODE_NOT_SUPPORTED");
  });

  it("checks activeStrategy before the trade-execution gates", () => {
    const result = checkEtfRotationRepairPolicyGates({
      tradeMode: "paper",
      activeStrategy: "baseline",
      executeTradesEnabled: false,
      allowBuyEnabled: false,
    });
    expect((result as { code: string }).code).toBe("ETF_ROTATION_STRATEGY_DISABLED");
  });
});

describe("computeRepairBuyShares", () => {
  it("matches etfRotationStrategy.ts's computeRebalanceOrders formula exactly", () => {
    // 50% of $88,152.86 equity / $769.80 price = floor(57.24) = 57 raw shares.
    expect(computeRepairBuyShares(50, 88152.86, 769.8, undefined)).toBe(57);
  });

  it("applies the ramp cap when it's tighter than the raw target size", () => {
    // Raw target would be 57 shares (as above); a 2% ramp cap on the same
    // equity/price allows floor(0.02 * 88152.86 / 769.8) = 2 shares.
    expect(computeRepairBuyShares(50, 88152.86, 769.8, 2)).toBe(2);
  });

  it("is uncapped when rampMaxPositionEquityPercent is undefined", () => {
    expect(computeRepairBuyShares(50, 10000, 100, undefined)).toBe(50);
  });

  it("returns 0 for a non-positive price rather than dividing by zero/negative", () => {
    expect(computeRepairBuyShares(50, 10000, 0, undefined)).toBe(0);
    expect(computeRepairBuyShares(50, 10000, -5, undefined)).toBe(0);
  });

  it("never returns negative shares", () => {
    expect(computeRepairBuyShares(50, 100, 10000, undefined)).toBe(0);
  });
});

function auditEvent(
  overrides: Partial<EtfRotationOrderAuditEvent> &
    Pick<EtfRotationOrderAuditEvent, "type">,
): EtfRotationOrderAuditEvent {
  return {
    timestamp: "2026-08-03T13:52:26.895Z",
    rebalanceMonthKey: MONTH,
    configVariantKey: "baseline-2",
    ...overrides,
  };
}

describe("hasAcceptedPriorRepair", () => {
  it("finds a matching prior accepted repair", () => {
    const events = [
      auditEvent({ type: "ORDER_ACCEPTED", ticker: "QQQ", legType: "repair" }),
    ];
    expect(hasAcceptedPriorRepair(events, MONTH, "QQQ")).toBe(true);
  });

  it("ignores an accepted event that isn't tagged legType: repair (an ordinary rebalance-cycle leg)", () => {
    const events = [
      auditEvent({ type: "ORDER_ACCEPTED", ticker: "QQQ", legType: "rebuild_target" }),
    ];
    expect(hasAcceptedPriorRepair(events, MONTH, "QQQ")).toBe(false);
  });

  it("ignores a rejected or ambiguous repair - only ACCEPTED blocks a repeat", () => {
    const events = [
      auditEvent({ type: "ORDER_REJECTED", ticker: "QQQ", legType: "repair" }),
      auditEvent({ type: "ORDER_AMBIGUOUS", ticker: "QQQ", legType: "repair" }),
    ];
    expect(hasAcceptedPriorRepair(events, MONTH, "QQQ")).toBe(false);
  });

  it("ignores a match for a different ticker", () => {
    const events = [
      auditEvent({ type: "ORDER_ACCEPTED", ticker: "SPY", legType: "repair" }),
    ];
    expect(hasAcceptedPriorRepair(events, MONTH, "QQQ")).toBe(false);
  });

  it("ignores a match from a different rebalance month - stale history doesn't block a new month", () => {
    const events = [
      auditEvent({
        type: "ORDER_ACCEPTED",
        ticker: "QQQ",
        legType: "repair",
        rebalanceMonthKey: "2026-07",
      }),
    ];
    expect(hasAcceptedPriorRepair(events, MONTH, "QQQ")).toBe(false);
  });
});

// Real 2026-08-03 incident shape, reused across the eligibility tests below.
const REAL_INCIDENT_STATE_RESULT: RebalanceStateReadResult = {
  corrupt: false,
  state: {
    lastRebalanceDateKey: "2026-08-03",
    rebalanceMonthKey: MONTH,
    configVariantKey: "baseline-2",
    status: "partial",
    targets: [
      { ticker: "QQQ", weightPercent: 50 },
      { ticker: "SPY", weightPercent: 50 },
    ],
    plannedOrders: [
      { ticker: "QQQ", action: "BUY", shares: 63, targetWeightPercent: 50 },
      { ticker: "SPY", action: "BUY", shares: 58, targetWeightPercent: 50 },
    ],
  },
};

const REAL_INCIDENT_OFF_TARGET_STATE: EtfRotationOffTargetState = {
  offTarget: true,
  missingLegs: [
    {
      ticker: "QQQ",
      targetWeightPercent: 50,
      currentShares: 0,
      reason: "Request failed with status code 403",
    },
  ],
};

function baseEligibilityParams() {
  return {
    stateResult: REAL_INCIDENT_STATE_RESULT,
    offTargetState: REAL_INCIDENT_OFF_TARGET_STATE,
    ticker: "QQQ",
    marketIsOpen: true,
    openBuyOrderExistsForTicker: false,
    recentAuditEvents: [] as EtfRotationOrderAuditEvent[],
    openPositionCountInUniverse: 1,
    maxAllowedPositions: 3,
    currentEquity: 88152.86,
    currentPrice: 769.8,
    rampMaxPositionEquityPercent: 2,
  };
}

describe("decideEtfRotationRepairEligibility", () => {
  it("allows the real 2026-08-03 QQQ incident shape, sized fresh (not the stale plannedOrders value of 63)", () => {
    const decision = decideEtfRotationRepairEligibility(baseEligibilityParams());

    expect(decision).toEqual<EtfRotationRepairDecision>({
      allowed: true,
      requestedShares: 2, // ramp-capped at 2%, not the original 63
      targetWeightPercent: 50,
      rebalanceMonthKey: MONTH,
    });
  });

  it("blocks with STATE_CORRUPT when the state file is unreadable", () => {
    const decision = decideEtfRotationRepairEligibility({
      ...baseEligibilityParams(),
      stateResult: { corrupt: true, state: { lastRebalanceDateKey: null } },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.blockReason).toBe("STATE_CORRUPT");
  });

  it("blocks with NOT_OFF_TARGET when offTargetState.offTarget is false", () => {
    const decision = decideEtfRotationRepairEligibility({
      ...baseEligibilityParams(),
      offTargetState: { offTarget: false, missingLegs: [] },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.blockReason).toBe("NOT_OFF_TARGET");
  });

  it("blocks with NOT_OFF_TARGET when the ticker isn't in missingLegs, even if some other ticker is", () => {
    const decision = decideEtfRotationRepairEligibility({
      ...baseEligibilityParams(),
      ticker: "SPY", // SPY's rebuild succeeded in the real incident, not missing
    });
    expect(decision.allowed).toBe(false);
    expect(decision.blockReason).toBe("NOT_OFF_TARGET");
  });

  it("blocks with MARKET_CLOSED when the market clock reports closed", () => {
    const decision = decideEtfRotationRepairEligibility({
      ...baseEligibilityParams(),
      marketIsOpen: false,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.blockReason).toBe("MARKET_CLOSED");
  });

  it("blocks with OPEN_ORDER_EXISTS when a pending BUY order for the ticker is already open", () => {
    const decision = decideEtfRotationRepairEligibility({
      ...baseEligibilityParams(),
      openBuyOrderExistsForTicker: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.blockReason).toBe("OPEN_ORDER_EXISTS");
  });

  it("blocks with PRIOR_REPAIR_ALREADY_ACCEPTED when this rebalanceMonthKey+ticker was already successfully repaired", () => {
    const decision = decideEtfRotationRepairEligibility({
      ...baseEligibilityParams(),
      recentAuditEvents: [
        auditEvent({ type: "ORDER_ACCEPTED", ticker: "QQQ", legType: "repair" }),
      ],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.blockReason).toBe("PRIOR_REPAIR_ALREADY_ACCEPTED");
  });

  it("blocks with MAX_POSITIONS_REACHED when already holding the max universe positions", () => {
    const decision = decideEtfRotationRepairEligibility({
      ...baseEligibilityParams(),
      openPositionCountInUniverse: 3,
      maxAllowedPositions: 3,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.blockReason).toBe("MAX_POSITIONS_REACHED");
  });

  it("blocks with SIZE_ZERO when the computed repair size rounds to 0 shares", () => {
    const decision = decideEtfRotationRepairEligibility({
      ...baseEligibilityParams(),
      currentEquity: 100,
      currentPrice: 769.8,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.blockReason).toBe("SIZE_ZERO");
  });
});

describe("decideEtfRotationRepairPreconditions", () => {
  // Same block reasons as decideEtfRotationRepairEligibility above, minus
  // SIZE_ZERO (which needs a price and belongs to decideEtfRotationRepairSizing
  // instead) - this is the half of eligibility the orchestrator runs BEFORE
  // fetching a live price quote (2026-08-08 review finding: a price fetch
  // must never happen before these checks, since it's wasted work - and a
  // potential spurious 500 - when the repair was already going to be
  // blocked for an unrelated reason).
  function baseParams() {
    const { currentEquity, currentPrice, rampMaxPositionEquityPercent, ...rest } =
      baseEligibilityParams();
    return rest;
  }

  it("allows the real 2026-08-03 QQQ incident shape without needing a price", () => {
    const result = decideEtfRotationRepairPreconditions(baseParams());
    expect(result).toEqual({
      allowed: true,
      rebalanceMonthKey: MONTH,
      targetWeightPercent: 50,
    });
  });

  it("blocks with STATE_CORRUPT when the state file is unreadable", () => {
    const result = decideEtfRotationRepairPreconditions({
      ...baseParams(),
      stateResult: { corrupt: true, state: { lastRebalanceDateKey: null } },
    });
    expect(result.allowed).toBe(false);
    expect((result as { blockReason: string }).blockReason).toBe("STATE_CORRUPT");
  });

  it("blocks with NOT_OFF_TARGET when offTargetState.offTarget is false", () => {
    const result = decideEtfRotationRepairPreconditions({
      ...baseParams(),
      offTargetState: { offTarget: false, missingLegs: [] },
    });
    expect(result.allowed).toBe(false);
    expect((result as { blockReason: string }).blockReason).toBe("NOT_OFF_TARGET");
  });

  it("blocks with MARKET_CLOSED when the market clock reports closed", () => {
    const result = decideEtfRotationRepairPreconditions({
      ...baseParams(),
      marketIsOpen: false,
    });
    expect(result.allowed).toBe(false);
    expect((result as { blockReason: string }).blockReason).toBe("MARKET_CLOSED");
  });

  it("blocks with OPEN_ORDER_EXISTS when a pending BUY order for the ticker is already open", () => {
    const result = decideEtfRotationRepairPreconditions({
      ...baseParams(),
      openBuyOrderExistsForTicker: true,
    });
    expect(result.allowed).toBe(false);
    expect((result as { blockReason: string }).blockReason).toBe("OPEN_ORDER_EXISTS");
  });

  it("blocks with PRIOR_REPAIR_ALREADY_ACCEPTED when this rebalanceMonthKey+ticker was already successfully repaired", () => {
    const result = decideEtfRotationRepairPreconditions({
      ...baseParams(),
      recentAuditEvents: [
        auditEvent({ type: "ORDER_ACCEPTED", ticker: "QQQ", legType: "repair" }),
      ],
    });
    expect(result.allowed).toBe(false);
    expect((result as { blockReason: string }).blockReason).toBe(
      "PRIOR_REPAIR_ALREADY_ACCEPTED",
    );
  });

  it("blocks with MAX_POSITIONS_REACHED when already holding the max universe positions", () => {
    const result = decideEtfRotationRepairPreconditions({
      ...baseParams(),
      openPositionCountInUniverse: 3,
      maxAllowedPositions: 3,
    });
    expect(result.allowed).toBe(false);
    expect((result as { blockReason: string }).blockReason).toBe("MAX_POSITIONS_REACHED");
  });
});

describe("decideEtfRotationRepairSizing", () => {
  it("allows and sizes when the computed shares are positive", () => {
    const result = decideEtfRotationRepairSizing({
      targetWeightPercent: 50,
      currentEquity: 88152.86,
      currentPrice: 769.8,
      rampMaxPositionEquityPercent: 2,
    });
    expect(result).toEqual({ allowed: true, requestedShares: 2 });
  });

  it("blocks with SIZE_ZERO when the computed repair size rounds to 0 shares", () => {
    const result = decideEtfRotationRepairSizing({
      targetWeightPercent: 50,
      currentEquity: 100,
      currentPrice: 769.8,
      rampMaxPositionEquityPercent: 2,
    });
    expect(result).toEqual({
      allowed: false,
      blockReason: "SIZE_ZERO",
      blockDetail: expect.any(String),
    });
  });
});

// --- Orchestrator-level tests, matching the user's own pre-merge scenario
// list exactly. Every I/O dependency is a fake/spy - no real Alpaca call,
// no real Express app needed (matches performEtfRotationRepairMissingBuy's
// own explicit design goal).

async function withTempDataFiles(
  run: (paths: { statePath: string; auditLogPath: string }) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "etf-rotation-repair-test-"));
  try {
    await run({
      statePath: path.join(dir, "etf-rotation-worker-state.json"),
      auditLogPath: path.join(dir, "etf-rotation-order-audit.jsonl"),
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function seedRealIncidentState(statePath: string): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(REAL_INCIDENT_STATE_RESULT.state), "utf-8");
}

// deriveEtfRotationOffTargetState only flags a ticker as off-target when
// there's a recorded FAILED audit event for it this rebalance month (not
// just "0 shares") - this is what actually makes the fresh re-derivation
// inside performEtfRotationRepairMissingBuy agree that QQQ is missing, the
// same real ORDER_REJECTED event from the 2026-08-03 incident used
// throughout this file's pure-function tests above.
async function seedRealIncidentAuditLog(
  auditLogPath: string,
  extraEvents: EtfRotationOrderAuditEvent[] = [],
): Promise<void> {
  await fs.mkdir(path.dirname(auditLogPath), { recursive: true });
  const events = [
    auditEvent({
      type: "ORDER_REJECTED",
      ticker: "QQQ",
      side: "BUY",
      legType: "rebuild_target",
      requestedQty: 63,
      submittedQty: 2,
      error: "Request failed with status code 403",
    }),
    ...extraEvents,
  ];
  await fs.writeFile(
    auditLogPath,
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf-8",
  );
}

async function readAuditLines(auditLogPath: string): Promise<Record<string, unknown>[]> {
  try {
    const raw = await fs.readFile(auditLogPath, "utf-8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function makePortfolio(overrides: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return {
    balance: 86613.26,
    equity: 88152.86,
    currency: "USD",
    positions: {
      SPY: { shares: 2, avgPrice: 752.53, currentPrice: 769.8, pnl: 34.54, pnlPercent: 2.3 },
    },
    ...overrides,
  };
}

function baseOrchestratorParams(paths: { statePath: string; auditLogPath: string }) {
  return {
    ticker: "QQQ",
    reason: "Manually repairing the 2026-08-03 QQQ 403 incident.",
    configVariantKey: "baseline-2",
    maxAllowedPositions: 3,
    rampMaxPositionEquityPercent: 2,
    universeTickers: ["SPY", "QQQ", "EFA", "TLT", "GLD"],
    getPortfolioSnapshot: async () => makePortfolio(),
    getEstimatedPrice: async () => 769.8,
    checkOpenBuyOrderExists: async () => false,
    getMarketIsOpen: async () => true,
    broadcastSSE: vi.fn(),
    etfRotationStateFilePath: paths.statePath,
    etfRotationOrderAuditLogFilePath: paths.auditLogPath,
  };
}

describe("performEtfRotationRepairMissingBuy", () => {
  it("missing QQQ + market open + no open orders: calls executeSafeTrade and records an accepted repair", async () => {
    await withTempDataFiles(async (paths) => {
      await seedRealIncidentState(paths.statePath);
      await seedRealIncidentAuditLog(paths.auditLogPath);

      const executeSafeTrade = vi.fn(
        async (): Promise<ExecuteSafeTradeResult> => ({
          status: "success",
          order: { id: "broker-order-repair-1" },
        }),
      );

      const result = await performEtfRotationRepairMissingBuy({
        ...baseOrchestratorParams(paths),
        executeSafeTrade,
      });

      expect(executeSafeTrade).toHaveBeenCalledTimes(1);
      expect(executeSafeTrade).toHaveBeenCalledWith("QQQ", "BUY", 2);
      expect(result).toEqual({
        kind: "resolved",
        outcome: "accepted",
        ticker: "QQQ",
        rebalanceMonthKey: MONTH,
        targetWeightPercent: 50,
        requestedShares: 2,
        brokerOrderId: "broker-order-repair-1",
        reason: undefined,
      });

      // Skip index 0 - the pre-seeded original 2026-08-03 ORDER_REJECTED
      // event this test seeded so the fresh off-target re-derivation would
      // agree QQQ is missing; the repair's own two new events are appended
      // after it.
      const auditLines = (await readAuditLines(paths.auditLogPath)).slice(1);
      expect(auditLines.map((e) => e.type)).toEqual([
        "REPAIR_MISSING_BUY_ATTEMPTED",
        "ORDER_ACCEPTED",
      ]);
      expect(auditLines[1]).toMatchObject({ legType: "repair", ticker: "QQQ" });
    });
  });

  it("a notification failure after an accepted outcome does not turn a resolved repair into a thrown exception", async () => {
    // The broker outcome and its audit event are already committed by the
    // time notification runs - a down Telegram must not make the caller
    // (server.ts) report a false 500 for a repair that may well have gone
    // through, which could provoke a confused manual retry.
    await withTempDataFiles(async (paths) => {
      await seedRealIncidentState(paths.statePath);
      await seedRealIncidentAuditLog(paths.auditLogPath);

      const executeSafeTrade = vi.fn(
        async (): Promise<ExecuteSafeTradeResult> => ({
          status: "success",
          order: { id: "broker-order-repair-2" },
        }),
      );
      const sendTelegramAlert = vi.fn(async () => {
        throw new Error("Telegram is down.");
      });

      const result = await performEtfRotationRepairMissingBuy({
        ...baseOrchestratorParams(paths),
        executeSafeTrade,
        sendTelegramAlert,
      });

      expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        kind: "resolved",
        outcome: "accepted",
        ticker: "QQQ",
        rebalanceMonthKey: MONTH,
        targetWeightPercent: 50,
        requestedShares: 2,
        brokerOrderId: "broker-order-repair-2",
        reason: undefined,
      });

      const auditLines = (await readAuditLines(paths.auditLogPath)).slice(1);
      expect(auditLines.map((e) => e.type)).toEqual([
        "REPAIR_MISSING_BUY_ATTEMPTED",
        "ORDER_ACCEPTED",
      ]);
    });
  });

  it("repeated successful repair for the same rebalanceMonthKey+ticker: blocks before calling executeSafeTrade", async () => {
    await withTempDataFiles(async (paths) => {
      await seedRealIncidentState(paths.statePath);
      await seedRealIncidentAuditLog(paths.auditLogPath, [
        auditEvent({ type: "ORDER_ACCEPTED", ticker: "QQQ", legType: "repair" }),
      ]);

      const executeSafeTrade = vi.fn(async (): Promise<ExecuteSafeTradeResult> => {
        throw new Error("executeSafeTrade should never be called - already repaired.");
      });

      const result = await performEtfRotationRepairMissingBuy({
        ...baseOrchestratorParams(paths),
        executeSafeTrade,
      });

      expect(executeSafeTrade).not.toHaveBeenCalled();
      expect(result).toEqual({
        kind: "blocked",
        blockReason: "PRIOR_REPAIR_ALREADY_ACCEPTED",
        blockDetail: expect.stringContaining("already accepted"),
      });
    });
  });

  it("open BUY order already exists for the ticker: blocks before calling executeSafeTrade", async () => {
    await withTempDataFiles(async (paths) => {
      await seedRealIncidentState(paths.statePath);
      await seedRealIncidentAuditLog(paths.auditLogPath);

      const executeSafeTrade = vi.fn(async (): Promise<ExecuteSafeTradeResult> => {
        throw new Error("executeSafeTrade should never be called - open order exists.");
      });

      const result = await performEtfRotationRepairMissingBuy({
        ...baseOrchestratorParams(paths),
        checkOpenBuyOrderExists: async () => true,
        executeSafeTrade,
      });

      expect(executeSafeTrade).not.toHaveBeenCalled();
      expect(result).toEqual({
        kind: "blocked",
        blockReason: "OPEN_ORDER_EXISTS",
        blockDetail: expect.stringContaining("QQQ"),
      });
    });
  });

  it("market closed: blocks before calling executeSafeTrade, and never fetches a price at all", async () => {
    await withTempDataFiles(async (paths) => {
      await seedRealIncidentState(paths.statePath);
      await seedRealIncidentAuditLog(paths.auditLogPath);

      const executeSafeTrade = vi.fn(async (): Promise<ExecuteSafeTradeResult> => {
        throw new Error("executeSafeTrade should never be called - market closed.");
      });
      // 2026-08-08 review finding: a precondition block (market closed here)
      // must short-circuit before any price fetch - a throwing price
      // dependency proves the orchestrator never reaches it.
      const getEstimatedPrice = vi.fn(async (): Promise<number> => {
        throw new Error("getEstimatedPrice should never be called - blocked before sizing.");
      });

      const result = await performEtfRotationRepairMissingBuy({
        ...baseOrchestratorParams(paths),
        getMarketIsOpen: async () => false,
        getEstimatedPrice,
        executeSafeTrade,
      });

      expect(getEstimatedPrice).not.toHaveBeenCalled();
      expect(executeSafeTrade).not.toHaveBeenCalled();
      expect(result).toEqual({
        kind: "blocked",
        blockReason: "MARKET_CLOSED",
        blockDetail: expect.any(String),
      });
    });
  });

  it("broker rejects the repair BUY: records the audit trail, does not retry, and resolves with outcome: rejected", async () => {
    await withTempDataFiles(async (paths) => {
      await seedRealIncidentState(paths.statePath);
      await seedRealIncidentAuditLog(paths.auditLogPath);

      const executeSafeTrade = vi.fn(
        async (): Promise<ExecuteSafeTradeResult> => ({
          status: "error",
          reason: "Request failed with status code 403",
          classification: "definitive_rejection",
        }),
      );

      const result = await performEtfRotationRepairMissingBuy({
        ...baseOrchestratorParams(paths),
        executeSafeTrade,
      });

      expect(executeSafeTrade).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        kind: "resolved",
        outcome: "rejected",
        ticker: "QQQ",
        rebalanceMonthKey: MONTH,
        targetWeightPercent: 50,
        requestedShares: 2,
        brokerOrderId: undefined,
        reason: "Request failed with status code 403",
      });

      const auditLines = (await readAuditLines(paths.auditLogPath)).slice(1);
      expect(auditLines.map((e) => e.type)).toEqual([
        "REPAIR_MISSING_BUY_ATTEMPTED",
        "ORDER_REJECTED",
      ]);
      expect(auditLines[1]).toMatchObject({
        legType: "repair",
        error: "Request failed with status code 403",
      });
    });
  });

  it("a notification failure after a rejected outcome also does not turn a resolved repair into a thrown exception", async () => {
    await withTempDataFiles(async (paths) => {
      await seedRealIncidentState(paths.statePath);
      await seedRealIncidentAuditLog(paths.auditLogPath);

      const executeSafeTrade = vi.fn(
        async (): Promise<ExecuteSafeTradeResult> => ({
          status: "error",
          reason: "Request failed with status code 403",
          classification: "definitive_rejection",
        }),
      );
      const sendTelegramAlert = vi.fn(async () => {
        throw new Error("Telegram is down.");
      });

      const result = await performEtfRotationRepairMissingBuy({
        ...baseOrchestratorParams(paths),
        executeSafeTrade,
        sendTelegramAlert,
      });

      expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        kind: "resolved",
        outcome: "rejected",
        ticker: "QQQ",
        rebalanceMonthKey: MONTH,
        targetWeightPercent: 50,
        requestedShares: 2,
        brokerOrderId: undefined,
        reason: "Request failed with status code 403",
      });
    });
  });

  it("broker outcome is ambiguous: records the audit trail, does not retry, and resolves with outcome: ambiguous", async () => {
    await withTempDataFiles(async (paths) => {
      await seedRealIncidentState(paths.statePath);
      await seedRealIncidentAuditLog(paths.auditLogPath);

      const executeSafeTrade = vi.fn(
        async (): Promise<ExecuteSafeTradeResult> => ({
          status: "error",
          reason: "network timeout",
          classification: "ambiguous_network_error",
        }),
      );

      const result = await performEtfRotationRepairMissingBuy({
        ...baseOrchestratorParams(paths),
        executeSafeTrade,
      });

      expect(executeSafeTrade).toHaveBeenCalledTimes(1);
      expect(result.kind).toBe("resolved");
      expect((result as { outcome: string }).outcome).toBe("ambiguous");

      const auditLines = (await readAuditLines(paths.auditLogPath)).slice(1);
      expect(auditLines.map((e) => e.type)).toEqual([
        "REPAIR_MISSING_BUY_ATTEMPTED",
        "ORDER_AMBIGUOUS",
      ]);
    });
  });

  it("does not repair a ticker not currently reported as off-target", async () => {
    await withTempDataFiles(async (paths) => {
      await seedRealIncidentState(paths.statePath);

      const executeSafeTrade = vi.fn(async (): Promise<ExecuteSafeTradeResult> => {
        throw new Error("executeSafeTrade should never be called - SPY isn't missing.");
      });

      const result = await performEtfRotationRepairMissingBuy({
        ...baseOrchestratorParams(paths),
        ticker: "SPY",
        executeSafeTrade,
      });

      expect(executeSafeTrade).not.toHaveBeenCalled();
      expect(result).toEqual({
        kind: "blocked",
        blockReason: "NOT_OFF_TARGET",
        blockDetail: expect.any(String),
      });
    });
  });
});
