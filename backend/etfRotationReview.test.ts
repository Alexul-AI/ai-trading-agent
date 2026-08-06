import { describe, expect, it } from "vitest";

import { deriveEtfRotationOffTargetState } from "./etfRotationReview.js";
import type { EtfRotationOrderAuditEvent } from "./etfRotationOrderAuditLog.js";
import type { RebalanceOrder, RotationTarget } from "./etfRotationStrategy.js";

const MONTH = "2026-08";

const TARGETS: RotationTarget[] = [
  { ticker: "QQQ", weightPercent: 50 },
  { ticker: "SPY", weightPercent: 50 },
];

const PLANNED_ORDERS: RebalanceOrder[] = [
  { ticker: "SPY", action: "SELL", shares: 2 },
  { ticker: "QQQ", action: "SELL", shares: 2 },
  { ticker: "QQQ", action: "BUY", shares: 63, targetWeightPercent: 50 },
  { ticker: "SPY", action: "BUY", shares: 58, targetWeightPercent: 50 },
];

function auditEvent(
  overrides: Partial<EtfRotationOrderAuditEvent> &
    Pick<EtfRotationOrderAuditEvent, "type" | "ticker" | "side">,
): EtfRotationOrderAuditEvent {
  return {
    timestamp: "2026-08-03T13:52:26.000Z",
    rebalanceMonthKey: MONTH,
    configVariantKey: "baseline-2",
    ...overrides,
  };
}

describe("deriveEtfRotationOffTargetState", () => {
  it("is not off-target when every target ticker's rebuild BUY actually succeeded, even at a ramp-capped size far below the target weight", () => {
    // The real 2026-08-03 outcome for SPY: requested 58 shares, ramp-capped
    // to 2, but accepted - a huge gap from its 50% weight target, and NOT
    // off-target. This is exactly the case a naive weight-drift check would
    // get wrong.
    const events: EtfRotationOrderAuditEvent[] = [
      auditEvent({ type: "ORDER_ACCEPTED", ticker: "SPY", side: "BUY", submittedQty: 2 }),
      auditEvent({ type: "ORDER_ACCEPTED", ticker: "QQQ", side: "BUY", submittedQty: 2 }),
    ];

    const result = deriveEtfRotationOffTargetState({
      targets: TARGETS,
      plannedOrders: PLANNED_ORDERS,
      positions: { SPY: { shares: 2 }, QQQ: { shares: 2 } },
      recentOrderAuditEvents: events,
      rebalanceMonthKey: MONTH,
    });

    expect(result).toEqual({ offTarget: false, missingLegs: [] });
  });

  it("flags QQQ off-target when its rebuild BUY was rejected and no shares were ever acquired - the real 2026-08-03 incident", () => {
    const events: EtfRotationOrderAuditEvent[] = [
      auditEvent({ type: "ORDER_ACCEPTED", ticker: "SPY", side: "BUY", submittedQty: 2 }),
      auditEvent({
        type: "ORDER_REJECTED",
        ticker: "QQQ",
        side: "BUY",
        error: "Request failed with status code 403",
      }),
    ];

    const result = deriveEtfRotationOffTargetState({
      targets: TARGETS,
      plannedOrders: PLANNED_ORDERS,
      positions: { SPY: { shares: 2 } }, // QQQ absent entirely, matching the real incident
      recentOrderAuditEvents: events,
      rebalanceMonthKey: MONTH,
    });

    expect(result.offTarget).toBe(true);
    expect(result.missingLegs).toEqual([
      {
        ticker: "QQQ",
        targetWeightPercent: 50,
        currentShares: 0,
        reason: "Request failed with status code 403",
      },
    ]);
  });

  it("is not off-target (nothing attempted yet) when a target has zero shares but no BUY was ever attempted this month", () => {
    // A brand-new month's rebalance that hasn't run yet - not the same as
    // "broken", and must not be conflated with it.
    const result = deriveEtfRotationOffTargetState({
      targets: TARGETS,
      plannedOrders: PLANNED_ORDERS,
      positions: {},
      recentOrderAuditEvents: [],
      rebalanceMonthKey: MONTH,
    });

    expect(result).toEqual({ offTarget: false, missingLegs: [] });
  });

  it("returns false/empty when there are no targets or no plannedOrders yet", () => {
    expect(
      deriveEtfRotationOffTargetState({
        targets: null,
        plannedOrders: PLANNED_ORDERS,
        positions: {},
        recentOrderAuditEvents: [],
        rebalanceMonthKey: MONTH,
      }),
    ).toEqual({ offTarget: false, missingLegs: [] });

    expect(
      deriveEtfRotationOffTargetState({
        targets: TARGETS,
        plannedOrders: null,
        positions: {},
        recentOrderAuditEvents: [],
        rebalanceMonthKey: MONTH,
      }),
    ).toEqual({ offTarget: false, missingLegs: [] });

    expect(
      deriveEtfRotationOffTargetState({
        targets: [],
        plannedOrders: PLANNED_ORDERS,
        positions: {},
        recentOrderAuditEvents: [],
        rebalanceMonthKey: MONTH,
      }),
    ).toEqual({ offTarget: false, missingLegs: [] });
  });

  it("returns false/empty when rebalanceMonthKey is null (no rebalance has ever completed)", () => {
    const result = deriveEtfRotationOffTargetState({
      targets: TARGETS,
      plannedOrders: PLANNED_ORDERS,
      positions: {},
      recentOrderAuditEvents: [],
      rebalanceMonthKey: null,
    });

    expect(result).toEqual({ offTarget: false, missingLegs: [] });
  });

  it("ignores a failed-BUY audit event from a previous month, so a fresh new-month cycle isn't flagged using stale history", () => {
    const events: EtfRotationOrderAuditEvent[] = [
      auditEvent({
        type: "ORDER_REJECTED",
        ticker: "QQQ",
        side: "BUY",
        rebalanceMonthKey: "2026-07", // an older month's failure
        error: "Request failed with status code 403",
      }),
    ];

    const result = deriveEtfRotationOffTargetState({
      targets: TARGETS,
      plannedOrders: PLANNED_ORDERS,
      positions: {},
      recentOrderAuditEvents: events,
      rebalanceMonthKey: MONTH, // this cycle is a new month, hasn't run yet
    });

    expect(result).toEqual({ offTarget: false, missingLegs: [] });
  });

  it("does not flag a ticker with no planned BUY leg this cycle (e.g. it dropped out of the target set)", () => {
    const result = deriveEtfRotationOffTargetState({
      targets: [{ ticker: "GLD", weightPercent: 50 }],
      plannedOrders: [{ ticker: "GLD", action: "SELL", shares: 5 }], // only a SELL, no BUY leg
      positions: {},
      recentOrderAuditEvents: [
        auditEvent({ type: "ORDER_REJECTED", ticker: "GLD", side: "SELL", error: "some sell error" }),
      ],
      rebalanceMonthKey: MONTH,
    });

    expect(result).toEqual({ offTarget: false, missingLegs: [] });
  });

  it("falls back to a generic reason when the failed audit event has no error text", () => {
    const events: EtfRotationOrderAuditEvent[] = [
      auditEvent({ type: "PAIRED_SELL_FILL_UNCONFIRMED", ticker: "QQQ", side: "BUY" }),
    ];

    const result = deriveEtfRotationOffTargetState({
      targets: TARGETS,
      plannedOrders: PLANNED_ORDERS,
      positions: {},
      recentOrderAuditEvents: events,
      rebalanceMonthKey: MONTH,
    });

    expect(result.offTarget).toBe(true);
    expect(result.missingLegs[0]!.reason).toBe(
      "PAIRED_SELL_FILL_UNCONFIRMED with no recorded detail",
    );
  });
});
