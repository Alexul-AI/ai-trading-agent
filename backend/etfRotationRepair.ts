// Manual, admin-triggered repair for a single missing ETF Rotation rebalance
// BUY leg already reported by GET /api/autopilot/etf-rotation/review's
// offTargetReview (built after the 2026-08-03 QQQ incident - a rebuild BUY
// rejected mid-rebalance left the portfolio silently under-target). This is
// execution-adjacent - it submits a real (paper-only) order - so every
// decision here is deliberately conservative: fresh reads only, no
// automatic retry, no full rebalance recompute, one ticker per call.
//
// New file, not folded into etfRotationReview.ts (explicitly read-only
// today) or etfRotationExecution.ts (coupled to multi-leg SELL/BUY pairing
// and a shared cash pool that a single-ticker BUY-only repair must not
// inherit) - matches this repo's one-concept-per-file convention.
import {
  mapExecuteSafeTradeResultToLegOutcome,
} from "./etfRotationCycle.js";
import { computeRampMaxShares } from "./etfRotationExecution.js";
import {
  appendEtfRotationOrderAuditEvent,
  readEtfRotationOrderAuditLog,
  type EtfRotationOrderAuditEvent,
} from "./etfRotationOrderAuditLog.js";
import { deriveEtfRotationOffTargetState } from "./etfRotationReview.js";
import type { EtfRotationOffTargetState } from "./etfRotationReview.js";
import {
  readRebalanceStateStrict,
  type RebalanceStateReadResult,
} from "./etfRotationWorkerState.js";
import type { PortfolioSnapshot } from "./src/strategy/portfolioSafety.js";
import type { ExecuteSafeTrade } from "./src/types/autopilotTypes.js";

// A generously large scan, not the review endpoint's tail-20 default - a
// real correctness gap found while designing this: if the "was there
// already a successful repair" check reused a small limit, a real prior
// ORDER_ACCEPTED could scroll off the tail and be missed, an actual
// double-submit risk. Matches circuit-breaker/review's own precedent of
// widening this exact kind of read for an on-demand admin fetch.
export const REPAIR_AUDIT_LOG_SCAN_LIMIT = 10000;

export interface EtfRotationRepairPolicyGateBlock {
  allowed: false;
  code: "LIVE_MODE_NOT_SUPPORTED" | "EXECUTE_TRADES_DISABLED" | "ALLOW_BUY_DISABLED";
  error: string;
}

// The three static, deployment-lifetime policy gates - pure so
// "tradeMode !== paper -> blocked" is directly testable without an Express
// app, unlike the state-dependent checks in decideEtfRotationRepairEligibility
// below, which genuinely need I/O first. Paper-only is a hard block for
// this version - no live support, not even behind a flag - checked first
// since it's the one gate meant to never be revisited without a separate,
// deliberate future decision.
export function checkEtfRotationRepairPolicyGates(params: {
  tradeMode: string;
  executeTradesEnabled: boolean;
  allowBuyEnabled: boolean;
}): { allowed: true } | EtfRotationRepairPolicyGateBlock {
  if (params.tradeMode !== "paper") {
    return {
      allowed: false,
      code: "LIVE_MODE_NOT_SUPPORTED",
      error:
        "ETF Rotation repair is paper-only in this version - no live support.",
    };
  }

  if (!params.executeTradesEnabled) {
    return {
      allowed: false,
      code: "EXECUTE_TRADES_DISABLED",
      error: "AUTOPILOT_EXECUTE_TRADES is disabled.",
    };
  }

  if (!params.allowBuyEnabled) {
    return {
      allowed: false,
      code: "ALLOW_BUY_DISABLED",
      error: "AUTOPILOT_ALLOW_BUY is disabled.",
    };
  }

  return { allowed: true };
}

// Same formula as etfRotationStrategy.ts's computeRebalanceOrders
// (verified against it directly, not reimplemented independently) - what a
// fresh rebalance cycle would compute today for this target, not the stale
// share count still sitting in the original incident's plannedOrders.
export function computeRepairBuyShares(
  targetWeightPercent: number,
  currentEquity: number,
  currentPrice: number,
  rampMaxPositionEquityPercent: number | undefined,
): number {
  if (currentPrice <= 0) return 0;

  const targetDollars = (targetWeightPercent / 100) * currentEquity;
  const rawShares = Math.floor(targetDollars / currentPrice);
  const rampMaxShares = computeRampMaxShares(
    currentPrice,
    currentEquity,
    rampMaxPositionEquityPercent,
  );

  return Math.max(0, Math.min(rawShares, rampMaxShares));
}

// Only a prior ACCEPTED repair blocks a repeat - not rejected/ambiguous.
// legType: "repair" is what makes a repair BUY's outcome event
// distinguishable from an ordinary rebalance-cycle leg in the same log (a
// new 5th value on EtfRotationOrderLegType, never assigned by
// deriveLegType). Blocking on a prior rejection would contradict "a human
// can manually retry later if they choose to."
export function hasAcceptedPriorRepair(
  auditEvents: EtfRotationOrderAuditEvent[],
  rebalanceMonthKey: string,
  ticker: string,
): boolean {
  return auditEvents.some(
    (event) =>
      event.type === "ORDER_ACCEPTED" &&
      event.legType === "repair" &&
      event.ticker === ticker &&
      event.rebalanceMonthKey === rebalanceMonthKey,
  );
}

export type EtfRotationRepairBlockReason =
  | "STATE_CORRUPT"
  | "NOT_OFF_TARGET"
  | "MARKET_CLOSED"
  | "OPEN_ORDER_EXISTS"
  | "PRIOR_REPAIR_ALREADY_ACCEPTED"
  | "MAX_POSITIONS_REACHED"
  | "SIZE_ZERO";

export interface EtfRotationRepairDecision {
  allowed: boolean;
  blockReason?: EtfRotationRepairBlockReason;
  blockDetail?: string;
  requestedShares?: number;
  targetWeightPercent?: number;
  rebalanceMonthKey?: string;
}

/**
 * Every input is an explicit param, already fetched by the caller - no I/O,
 * directly unit-testable, same style as deriveEtfRotationOffTargetState/
 * decideEtfRotationGateAction. `offTargetState` must be derived by the
 * caller from the SAME state/portfolio/audit reads passed in here (not
 * independently re-fetched), so this function's own checks and the
 * off-target check agree on one consistent snapshot in time.
 */
export function decideEtfRotationRepairEligibility(params: {
  stateResult: RebalanceStateReadResult;
  offTargetState: EtfRotationOffTargetState;
  ticker: string;
  marketIsOpen: boolean;
  openBuyOrderExistsForTicker: boolean;
  recentAuditEvents: EtfRotationOrderAuditEvent[];
  openPositionCountInUniverse: number;
  maxAllowedPositions: number;
  currentEquity: number;
  currentPrice: number;
  rampMaxPositionEquityPercent: number | undefined;
}): EtfRotationRepairDecision {
  const {
    stateResult,
    offTargetState,
    ticker,
    marketIsOpen,
    openBuyOrderExistsForTicker,
    recentAuditEvents,
    openPositionCountInUniverse,
    maxAllowedPositions,
    currentEquity,
    currentPrice,
    rampMaxPositionEquityPercent,
  } = params;

  if (stateResult.corrupt) {
    return {
      allowed: false,
      blockReason: "STATE_CORRUPT",
      blockDetail:
        "ETF Rotation state file is unreadable/corrupt - cannot safely repair.",
    };
  }

  const rebalanceMonthKey = stateResult.state.rebalanceMonthKey ?? null;
  const missingLeg = offTargetState.missingLegs.find(
    (leg) => leg.ticker === ticker,
  );

  // Checked before market-hours/open-orders/etc so "nothing to repair" is
  // reported precisely, not masked by an unrelated gate.
  if (!offTargetState.offTarget || !missingLeg || rebalanceMonthKey === null) {
    return {
      allowed: false,
      blockReason: "NOT_OFF_TARGET",
      blockDetail: `${ticker} is not currently reported as an off-target missing BUY leg - nothing to repair.`,
    };
  }

  if (!marketIsOpen) {
    return {
      allowed: false,
      blockReason: "MARKET_CLOSED",
      blockDetail: "Market is currently closed.",
    };
  }

  if (openBuyOrderExistsForTicker) {
    return {
      allowed: false,
      blockReason: "OPEN_ORDER_EXISTS",
      blockDetail: `An open BUY order already exists for ${ticker} - refusing to submit a second one.`,
    };
  }

  if (hasAcceptedPriorRepair(recentAuditEvents, rebalanceMonthKey, ticker)) {
    return {
      allowed: false,
      blockReason: "PRIOR_REPAIR_ALREADY_ACCEPTED",
      blockDetail: `A repair BUY for ${ticker} was already accepted this rebalance month (${rebalanceMonthKey}).`,
    };
  }

  if (openPositionCountInUniverse >= maxAllowedPositions) {
    return {
      allowed: false,
      blockReason: "MAX_POSITIONS_REACHED",
      blockDetail: `Already holding ${openPositionCountInUniverse} position(s) within the universe, at or above the max of ${maxAllowedPositions}.`,
    };
  }

  const requestedShares = computeRepairBuyShares(
    missingLeg.targetWeightPercent,
    currentEquity,
    currentPrice,
    rampMaxPositionEquityPercent,
  );

  if (requestedShares <= 0) {
    return {
      allowed: false,
      blockReason: "SIZE_ZERO",
      blockDetail:
        "Computed repair BUY size is 0 shares at current equity/price/ramp cap.",
    };
  }

  return {
    allowed: true,
    requestedShares,
    targetWeightPercent: missingLeg.targetWeightPercent,
    rebalanceMonthKey,
  };
}

export type EtfRotationRepairResult =
  | {
      kind: "blocked";
      blockReason: EtfRotationRepairBlockReason;
      blockDetail: string;
    }
  | {
      kind: "resolved";
      outcome: "accepted" | "rejected" | "ambiguous";
      ticker: string;
      rebalanceMonthKey: string;
      targetWeightPercent: number;
      requestedShares: number;
      brokerOrderId?: string;
      reason?: string;
    };

export interface PerformEtfRotationRepairMissingBuyParams {
  ticker: string;
  reason: string;
  configVariantKey: string;
  maxAllowedPositions: number;
  rampMaxPositionEquityPercent: number | undefined;
  universeTickers: string[];
  getPortfolioSnapshot: () => Promise<PortfolioSnapshot>;
  getEstimatedPrice: (ticker: string) => Promise<number>;
  checkOpenBuyOrderExists: (ticker: string) => Promise<boolean>;
  getMarketIsOpen: () => Promise<boolean>;
  executeSafeTrade: ExecuteSafeTrade;
  broadcastSSE: (payload: unknown) => void;
  sendTelegramAlert?: (message: string) => Promise<void>;
  etfRotationStateFilePath?: string;
  etfRotationOrderAuditLogFilePath?: string;
}

/**
 * The only impure function in this file - wires fresh reads, the pure
 * eligibility decision above, order submission, and audit logging together.
 * Every I/O dependency is an explicit injected param (matching
 * etfRotationCycle.ts's runEtfRotationCycle/etfRotationExecution.ts's
 * executeEtfRotationOrders convention) so this is directly testable with
 * fakes, without needing a real Express app or a live Alpaca connection -
 * server.ts's route handler is a thin wrapper that wires real dependencies
 * in and translates this function's result into an HTTP response.
 *
 * Deliberately never writes to etfRotationWorkerState.ts - the off-target
 * signal already self-clears the moment a fresh position read shows
 * shares > 0, so a successful repair needs no state-file mutation (matches
 * server.ts's clear-review endpoint, which also never touches
 * targets/plannedOrders).
 */
export async function performEtfRotationRepairMissingBuy(
  params: PerformEtfRotationRepairMissingBuyParams,
): Promise<EtfRotationRepairResult> {
  const ticker = params.ticker.trim().toUpperCase();

  const [stateResult, portfolio, marketIsOpen, openBuyOrderExists, recentAuditEvents] =
    await Promise.all([
      readRebalanceStateStrict(params.etfRotationStateFilePath),
      params.getPortfolioSnapshot(),
      params.getMarketIsOpen(),
      params.checkOpenBuyOrderExists(ticker),
      readEtfRotationOrderAuditLog(
        REPAIR_AUDIT_LOG_SCAN_LIMIT,
        params.etfRotationOrderAuditLogFilePath,
      ),
    ]);

  const offTargetState = deriveEtfRotationOffTargetState({
    targets: stateResult.state.targets ?? null,
    plannedOrders: stateResult.state.plannedOrders ?? null,
    positions: portfolio.positions,
    recentOrderAuditEvents: recentAuditEvents,
    rebalanceMonthKey: stateResult.state.rebalanceMonthKey ?? null,
  });

  const openPositionCountInUniverse = params.universeTickers.filter(
    (universeTicker) => (portfolio.positions[universeTicker]?.shares ?? 0) > 0,
  ).length;

  // A ticker being repaired is, by definition, currently unheld (0 shares -
  // that's what "missing" means), so it's never in portfolio.positions -
  // always falls through to a live quote.
  const currentPrice =
    portfolio.positions[ticker]?.currentPrice ??
    (await params.getEstimatedPrice(ticker));

  const decision = decideEtfRotationRepairEligibility({
    stateResult,
    offTargetState,
    ticker,
    marketIsOpen,
    openBuyOrderExistsForTicker: openBuyOrderExists,
    recentAuditEvents,
    openPositionCountInUniverse,
    maxAllowedPositions: params.maxAllowedPositions,
    currentEquity: portfolio.equity,
    currentPrice,
    rampMaxPositionEquityPercent: params.rampMaxPositionEquityPercent,
  });

  if (!decision.allowed) {
    return {
      kind: "blocked",
      blockReason: decision.blockReason as EtfRotationRepairBlockReason,
      blockDetail: decision.blockDetail ?? "Repair not allowed.",
    };
  }

  const rebalanceMonthKey = decision.rebalanceMonthKey as string;
  const targetWeightPercent = decision.targetWeightPercent as number;
  const requestedShares = decision.requestedShares as number;

  // Idempotency ordering: commit intent before the risky call, same
  // reasoning as this project's reminder paths (PR #65) - if the process
  // died between here and the outcome event below, the next attempt would
  // at least have this record to investigate against, even though it
  // wouldn't by itself block a retry (only an ACCEPTED outcome does).
  await appendEtfRotationOrderAuditEvent(
    {
      type: "REPAIR_MISSING_BUY_ATTEMPTED",
      timestamp: new Date().toISOString(),
      rebalanceMonthKey,
      configVariantKey: params.configVariantKey,
      ticker,
      side: "BUY",
      legType: "repair",
      requestedQty: requestedShares,
      reason: params.reason,
    },
    params.etfRotationOrderAuditLogFilePath,
  );

  const tradeResult = await params.executeSafeTrade(ticker, "BUY", requestedShares);
  const legOutcome = mapExecuteSafeTradeResultToLegOutcome(tradeResult);

  const outcomeEventType =
    legOutcome.outcome === "accepted"
      ? ("ORDER_ACCEPTED" as const)
      : legOutcome.outcome === "ambiguous"
        ? ("ORDER_AMBIGUOUS" as const)
        : ("ORDER_REJECTED" as const);

  await appendEtfRotationOrderAuditEvent(
    {
      type: outcomeEventType,
      timestamp: new Date().toISOString(),
      rebalanceMonthKey,
      configVariantKey: params.configVariantKey,
      ticker,
      side: "BUY",
      legType: "repair",
      requestedQty: requestedShares,
      submittedQty: requestedShares,
      brokerOrderId: legOutcome.brokerOrderId,
      error:
        legOutcome.outcome !== "accepted"
          ? (legOutcome.reason ?? "Repair BUY not accepted.")
          : undefined,
    },
    params.etfRotationOrderAuditLogFilePath,
  );

  // No auto-retry on rejected/ambiguous - this function returns the
  // outcome and stops. A human decides whether to call it again.
  const notifyMessage = `ETF Rotation repair BUY for ${ticker}: ${legOutcome.outcome}${
    legOutcome.reason ? ` (${legOutcome.reason})` : ""
  }. Requested ${requestedShares} shares. Admin reason: ${params.reason}`;

  // Best-effort only: the broker outcome above is already decided and
  // audit-logged by this point, so a notification failure (e.g. Telegram
  // down) must never turn an already-resolved outcome into a thrown
  // exception - the caller (server.ts) would otherwise report a false
  // "endpoint failed" 500 for a repair that may well have been accepted,
  // risking a confused manual retry even though the prior-accepted-repair
  // check would actually block a real double-submit.
  try {
    params.broadcastSSE({
      type: "notification",
      level: legOutcome.outcome === "accepted" ? "info" : "error",
      message: notifyMessage,
    });

    if (params.sendTelegramAlert) {
      await params.sendTelegramAlert(notifyMessage);
    }
  } catch (error) {
    console.warn(
      `[ETF Rotation Repair] Notification failed after a resolved outcome (${legOutcome.outcome}) for ${ticker}:`,
      error,
    );
  }

  return {
    kind: "resolved",
    outcome: legOutcome.outcome,
    ticker,
    rebalanceMonthKey,
    targetWeightPercent,
    requestedShares,
    brokerOrderId: legOutcome.brokerOrderId,
    reason: legOutcome.reason,
  };
}
