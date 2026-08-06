// Derived "is the live portfolio actually where the strategy last computed
// it should be" signal for GET /api/autopilot/etf-rotation/review - built
// after the 2026-08-03 QQQ incident (a rebuild BUY rejected mid-rebalance
// left the portfolio silently under-target with no active signal that
// anything needed attention until a human happened to check).
//
// Deliberately NOT a weight-drift check: AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT
// keeps every live position far below its nominal target weight on purpose
// during this cautious rollout - comparing actual vs. target weightPercent
// would flag every successful rebalance as "off-target" too (e.g. SPY's
// ramp-capped 2 shares vs. its 50% target), which is exactly the noisy
// signal that would make this useless. "Off-target" here means something
// narrower and more specific: a target ticker that should have been bought
// this cycle, currently holds zero shares, AND has a recorded broker-level
// failure (rejected/ambiguous/unconfirmed-fill) on this month's BUY attempt
// - not merely "hasn't rebalanced yet" (no attempt on record at all) and
// not "successfully bought at a ramp-capped size" (any shares > 0).
//
// Known limitation, not silently glossed over: a BUY blocked entirely by a
// gate (AUTOPILOT_ALLOW_BUY=false, the max-positions guardrail, or the ramp
// cap reducing a request to 0 shares) currently has no dedicated audit-log
// event of its own (etfRotationExecution.ts only logs SUBMITTED/ACCEPTED/
// REJECTED/AMBIGUOUS/PAIRED_SELL_FILL_UNCONFIRMED) - such a ticker would
// not be flagged off-target by this function. That class of "nothing was
// even attempted" state is already visible elsewhere (the execution gates
// in GET /api/autopilot/status) and widening the execution adapter's own
// audit trail to also log gate-blocked legs is out of scope for this
// read-only visibility pass.
import type { EtfRotationOrderAuditEvent } from "./etfRotationOrderAuditLog.js";
import type { RebalanceOrder, RotationTarget } from "./etfRotationStrategy.js";
import type { PortfolioPositionSnapshot } from "./src/strategy/portfolioSafety.js";

const FAILED_BUY_AUDIT_EVENT_TYPES = new Set<EtfRotationOrderAuditEvent["type"]>([
  "ORDER_REJECTED",
  "ORDER_AMBIGUOUS",
  "PAIRED_SELL_FILL_UNCONFIRMED",
]);

export interface EtfRotationOffTargetLeg {
  ticker: string;
  targetWeightPercent: number;
  currentShares: number;
  /** The recorded audit event's own error/detail text, or a generic fallback if the event has none. */
  reason: string;
}

export interface EtfRotationOffTargetState {
  offTarget: boolean;
  missingLegs: EtfRotationOffTargetLeg[];
}

export interface DeriveEtfRotationOffTargetStateParams {
  targets: RotationTarget[] | null;
  plannedOrders: RebalanceOrder[] | null;
  positions: Record<string, Pick<PortfolioPositionSnapshot, "shares">>;
  recentOrderAuditEvents: EtfRotationOrderAuditEvent[];
  /** The rebalance cycle these targets/plannedOrders belong to - audit events from an older month are never consulted, so a fresh new-month cycle that hasn't run yet doesn't get flagged using a prior month's stale failure. */
  rebalanceMonthKey: string | null;
}

export function deriveEtfRotationOffTargetState(
  params: DeriveEtfRotationOffTargetStateParams,
): EtfRotationOffTargetState {
  const { targets, plannedOrders, positions, recentOrderAuditEvents, rebalanceMonthKey } = params;

  if (!targets || targets.length === 0 || !plannedOrders || rebalanceMonthKey === null) {
    return { offTarget: false, missingLegs: [] };
  }

  const missingLegs: EtfRotationOffTargetLeg[] = [];

  for (const target of targets) {
    const plannedBuy = plannedOrders.find(
      (order) => order.ticker === target.ticker && order.action === "BUY",
    );
    // Nothing was even supposed to be bought this cycle for this ticker
    // (e.g. it dropped out of the target set entirely) - not this
    // function's concern.
    if (!plannedBuy) continue;

    const currentShares = positions[target.ticker]?.shares ?? 0;
    // Any real position - even a small, ramp-capped one - means the
    // rebuild succeeded. Not off-target regardless of how far the actual
    // share count is from a naive weight-percent-implied count.
    if (currentShares > 0) continue;

    const failedAttempt = recentOrderAuditEvents.find(
      (event) =>
        event.rebalanceMonthKey === rebalanceMonthKey &&
        event.ticker === target.ticker &&
        event.side === "BUY" &&
        FAILED_BUY_AUDIT_EVENT_TYPES.has(event.type),
    );

    // Zero shares with no recorded failure just means the rebalance hasn't
    // run yet this cycle (or hasn't reached this leg yet) - not "broken".
    if (!failedAttempt) continue;

    missingLegs.push({
      ticker: target.ticker,
      targetWeightPercent: target.weightPercent,
      currentShares,
      reason: failedAttempt.error ?? `${failedAttempt.type} with no recorded detail`,
    });
  }

  return { offTarget: missingLegs.length > 0, missingLegs };
}

// Same reasoning and shape as portfolioCircuitBreaker.ts's
// shouldSendDailyReminder - pure, calendar-day-scoped, testable without I/O.
// Unlike that one, there's no "tripped"-style stickiness to reason about
// here: deriveEtfRotationOffTargetState above is recomputed fresh from live
// state every cycle, so "offTarget" going false then true again on the same
// day is simply "false" then "true" as far as this function is concerned -
// no separate reset step is needed.
export function shouldSendEtfRotationOffTargetReminder(
  offTarget: boolean,
  lastReminderSentDate: string | null,
  todayDateKey: string,
): boolean {
  return offTarget && lastReminderSentDate !== todayDateKey;
}
