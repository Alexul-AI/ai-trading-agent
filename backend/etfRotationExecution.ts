// ETF Rotation Stage 2D, PR #46 - an isolated execution adapter, built and
// tested standalone. Per the approved plan, this file is NOT imported or
// called from autopilotWorker.ts - it exists so the riskiest remaining
// logic (side-aware gates, SELL-before-BUY sequencing, cash-aware BUY
// resizing, per-leg audit trail) can be built and fully unit-tested before
// a later PR ever makes it reachable from the live worker cycle. This file
// deliberately does not import anything from autopilotWorker.ts or
// server.ts - `executeSafeTrade` and every other side effect are received
// as injected dependencies, so tests never need real Alpaca calls or a
// live worker.
//
// This module never touches the rebalance state machine
// (etfRotationWorkerState.ts) - no import from that file exists here. The
// caller (a future execution-wiring PR) is responsible for translating
// this function's returned EtfRotationExecutionResult into a
// planned/executing/executed/partial/failed/failed_needs_review
// transition; this adapter only reports what it attempted.

import {
  deriveLegType,
  type EtfRotationOrderAuditEvent,
  type EtfRotationOrderLegType,
} from "./etfRotationOrderAuditLog.js";
import type { RebalanceOrder } from "./etfRotationStrategy.js";
import { classifyOrderError, type AlpacaErrorLike } from "./orderIdempotency.js";
import type { PortfolioSnapshot } from "./src/strategy/portfolioSafety.js";

// Deliberately not imported from autopilotWorker.ts/server.ts - a narrower,
// locally-declared type that the real `executeSafeTrade` (server.ts) is
// structurally assignable to (its extra orderType/limitPrice/stopLoss/
// takeProfit/requestedNotional params are all optional, and its own
// `action: string` parameter is wider than "BUY"|"SELL", so it satisfies
// this signature without any wrapper). ETF Rotation orders are always
// whole-share, no bracket, no notional - the real function's extra
// parameters are never needed here.
export interface EtfRotationExecuteSafeTradeResult {
  status: string;
  reason?: string;
  [key: string]: unknown;
}

export type EtfRotationExecuteSafeTrade = (
  ticker: string,
  action: "BUY" | "SELL",
  requestedShares: number,
) => Promise<EtfRotationExecuteSafeTradeResult>;

export interface EtfRotationExecutionGates {
  /** AUTOPILOT_EXECUTE_TRADES - global off switch. False blocks every leg, uniformly. */
  executeTradesEnabled: boolean;
  /** AUTOPILOT_ALLOW_BUY - checked per BUY leg, independent of allowSell. */
  allowBuy: boolean;
  /** AUTOPILOT_ALLOW_SELL - checked per SELL leg, independent of allowBuy. */
  allowSell: boolean;
}

export interface EtfRotationLegOutcome {
  ticker: string;
  action: "BUY" | "SELL";
  legType: EtfRotationOrderLegType;
  requestedQty: number;
  /** The actually-attempted quantity, which may be less than requestedQty for a cash-resized BUY leg. Absent if never attempted (blocked). */
  submittedQty?: number;
  clientOrderId?: string;
  brokerOrderId?: string;
  error?: string;
  /** Only set for blockedOrders - why this leg was never attempted. */
  blockReason?: string;
}

export type EtfRotationExecutionStatus =
  | "not_attempted"
  | "blocked"
  | "executed"
  | "partial"
  | "failed"
  | "ambiguous";

export interface EtfRotationExecutionResult {
  status: EtfRotationExecutionStatus;
  executedOrders: EtfRotationLegOutcome[];
  failedOrders: EtfRotationLegOutcome[];
  blockedOrders: EtfRotationLegOutcome[];
  ambiguousOrders: EtfRotationLegOutcome[];
}

export interface ExecuteEtfRotationOrdersParams {
  rebalanceMonthKey: string;
  configVariantKey: string;
  orders: RebalanceOrder[];
  executionGates: EtfRotationExecutionGates;
  executeSafeTrade: EtfRotationExecuteSafeTrade;
  appendAuditEvent: (event: EtfRotationOrderAuditEvent) => Promise<void>;
  refreshPortfolioSnapshot: () => Promise<PortfolioSnapshot>;
  /**
   * Not part of the originally-specified DI list - added because sizing a
   * BUY leg against refreshed cash (see the design doc's §5) requires a
   * price per ticker, and RebalanceOrder itself carries no price. Callers
   * already have this (it's the same map runEtfRotationCycle builds from
   * fetched bars) - just threaded through explicitly here for testability.
   */
  currentPriceByTicker: Map<string, number>;
  /** Injected clock for deterministic audit-event timestamps in tests. */
  now: () => string;
}

/**
 * Pure priority logic for the overall cycle status, given final per-leg
 * counts. Extracted and directly tested (same convention as every other
 * risk-adjacent decision in this project) rather than left inline.
 *
 * Priority: an empty order set is trivially "executed" (nothing needed).
 * Any ambiguous leg wins over everything else - §8's "never assume
 * success" rule means one uncertain leg makes the whole cycle worth a
 * human's attention, regardless of how many other legs succeeded. Full
 * success only when every leg executed. "blocked" only when nothing was
 * attempted at all (every leg gate-blocked or paired-SELL-blocked) and
 * nothing failed. Any executed leg alongside a non-executed one is
 * "partial". Otherwise "failed" (attempted and failed, nothing succeeded).
 */
export function computeOverallExecutionStatus(counts: {
  executed: number;
  failed: number;
  blocked: number;
  ambiguous: number;
  total: number;
}): EtfRotationExecutionStatus {
  if (counts.total === 0) return "executed";
  if (counts.ambiguous > 0) return "ambiguous";
  if (counts.executed === counts.total) return "executed";
  if (counts.executed === 0 && counts.failed === 0) return "blocked";
  if (counts.executed > 0) return "partial";
  return "failed";
}

function isDefinitiveFailureStatus(status: string): boolean {
  return status === "rejected" || status === "error";
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

function extractBrokerOrderId(result: EtfRotationExecuteSafeTradeResult): string | undefined {
  const order = result.order;
  if (order && typeof order === "object" && "id" in order) {
    const id = (order as { id?: unknown }).id;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

/**
 * Translates a rebalance's computed orders into real (paper) executions -
 * SELL legs first, then a refreshed-cash-aware pass over BUY legs. Never
 * called from any live path yet (see the file-level comment above).
 */
export async function executeEtfRotationOrders(
  params: ExecuteEtfRotationOrdersParams,
): Promise<EtfRotationExecutionResult> {
  const {
    rebalanceMonthKey,
    configVariantKey,
    orders,
    executionGates,
    executeSafeTrade,
    appendAuditEvent,
    refreshPortfolioSnapshot,
    currentPriceByTicker,
    now,
  } = params;

  const executedOrders: EtfRotationLegOutcome[] = [];
  const failedOrders: EtfRotationLegOutcome[] = [];
  const blockedOrders: EtfRotationLegOutcome[] = [];
  const ambiguousOrders: EtfRotationLegOutcome[] = [];

  const sellOrders = orders.filter((order) => order.action === "SELL");
  const buyOrders = orders.filter((order) => order.action === "BUY");
  const sellTickers = new Set(sellOrders.map((order) => order.ticker));
  const buyTickers = new Set(buyOrders.map((order) => order.ticker));

  function makeOutcome(order: RebalanceOrder): EtfRotationLegOutcome {
    const hasPairedOpposite =
      order.action === "BUY" ? sellTickers.has(order.ticker) : buyTickers.has(order.ticker);

    return {
      ticker: order.ticker,
      action: order.action,
      legType: deriveLegType(order.action, hasPairedOpposite),
      requestedQty: order.shares,
    };
  }

  function finalize(): EtfRotationExecutionResult {
    return {
      status: computeOverallExecutionStatus({
        executed: executedOrders.length,
        failed: failedOrders.length,
        blocked: blockedOrders.length,
        ambiguous: ambiguousOrders.length,
        total: orders.length,
      }),
      executedOrders,
      failedOrders,
      blockedOrders,
      ambiguousOrders,
    };
  }

  if (orders.length === 0) {
    return finalize();
  }

  // Global off switch - every leg blocked uniformly, executeSafeTrade never
  // called for anything. Distinct from a per-leg side-gate block below (a
  // different reason, worth distinguishing in the returned status).
  if (!executionGates.executeTradesEnabled) {
    for (const order of orders) {
      blockedOrders.push({
        ...makeOutcome(order),
        blockReason: "AUTOPILOT_EXECUTE_TRADES is false.",
      });
    }
    return {
      status: "not_attempted",
      executedOrders,
      failedOrders,
      blockedOrders,
      ambiguousOrders,
    };
  }

  const sellFailedTickers = new Set<string>();

  async function attemptLeg(
    order: RebalanceOrder,
    submittedQty: number,
  ): Promise<void> {
    const outcome = makeOutcome(order);
    outcome.submittedQty = submittedQty;

    await appendAuditEvent({
      type: "ORDER_SUBMITTED",
      timestamp: now(),
      rebalanceMonthKey,
      configVariantKey,
      ticker: order.ticker,
      side: order.action,
      legType: outcome.legType,
      requestedQty: order.shares,
      submittedQty,
    });

    try {
      const result = await executeSafeTrade(order.ticker, order.action, submittedQty);

      if (isDefinitiveFailureStatus(result.status)) {
        outcome.error = result.reason ?? `executeSafeTrade returned status "${result.status}".`;
        failedOrders.push(outcome);
        if (order.action === "SELL") sellFailedTickers.add(order.ticker);

        await appendAuditEvent({
          type: "ORDER_REJECTED",
          timestamp: now(),
          rebalanceMonthKey,
          configVariantKey,
          ticker: order.ticker,
          side: order.action,
          legType: outcome.legType,
          requestedQty: order.shares,
          submittedQty,
          error: outcome.error,
        });
        return;
      }

      outcome.brokerOrderId = extractBrokerOrderId(result);
      executedOrders.push(outcome);

      await appendAuditEvent({
        type: "ORDER_FILLED",
        timestamp: now(),
        rebalanceMonthKey,
        configVariantKey,
        ticker: order.ticker,
        side: order.action,
        legType: outcome.legType,
        requestedQty: order.shares,
        submittedQty,
        brokerOrderId: outcome.brokerOrderId,
      });
    } catch (error) {
      const classification = classifyOrderError(error as AlpacaErrorLike);
      outcome.error = extractErrorMessage(error);

      if (classification === "ambiguous_network_error") {
        // Never assumed successful (design doc §8/§3) - but the order may
        // genuinely have reached Alpaca, so a paired BUY is blocked the
        // same as a confirmed SELL failure, and cash is conservatively
        // treated as possibly spent by the caller's own bookkeeping below.
        ambiguousOrders.push(outcome);
        if (order.action === "SELL") sellFailedTickers.add(order.ticker);

        await appendAuditEvent({
          type: "ORDER_AMBIGUOUS",
          timestamp: now(),
          rebalanceMonthKey,
          configVariantKey,
          ticker: order.ticker,
          side: order.action,
          legType: outcome.legType,
          requestedQty: order.shares,
          submittedQty,
          error: outcome.error,
        });
      } else {
        failedOrders.push(outcome);
        if (order.action === "SELL") sellFailedTickers.add(order.ticker);

        await appendAuditEvent({
          type: "ORDER_REJECTED",
          timestamp: now(),
          rebalanceMonthKey,
          configVariantKey,
          ticker: order.ticker,
          side: order.action,
          legType: outcome.legType,
          requestedQty: order.shares,
          submittedQty,
          error: outcome.error,
        });
      }
    }
  }

  // SELL legs first - frees cash/positions before BUY sizing below.
  for (const order of sellOrders) {
    if (!executionGates.allowSell) {
      blockedOrders.push({
        ...makeOutcome(order),
        blockReason: "AUTOPILOT_ALLOW_SELL is false.",
      });
      // A SELL that's deliberately gated off is treated the same as one
      // that failed to clear - the paired BUY should not rebuild a
      // position whose liquidation never happened.
      sellFailedTickers.add(order.ticker);
      continue;
    }

    await attemptLeg(order, order.shares);
  }

  // Refresh cash after SELLs settle (design doc §5) - sizing BUYs off a
  // stale pre-SELL cash figure risks over-committing. Always refreshed,
  // even if there were no SELL legs this cycle, for a consistent sequence.
  const refreshedSnapshot = await refreshPortfolioSnapshot();
  let availableCash = refreshedSnapshot.balance;

  for (const order of buyOrders) {
    if (sellFailedTickers.has(order.ticker)) {
      blockedOrders.push({
        ...makeOutcome(order),
        blockReason:
          "Paired SELL leg for this ticker did not clear (failed, ambiguous, or gated off) - not attempting to rebuild the position.",
      });
      continue;
    }

    if (!executionGates.allowBuy) {
      blockedOrders.push({
        ...makeOutcome(order),
        blockReason: "AUTOPILOT_ALLOW_BUY is false.",
      });
      continue;
    }

    const price = currentPriceByTicker.get(order.ticker) ?? 0;
    if (price <= 0) {
      blockedOrders.push({
        ...makeOutcome(order),
        blockReason: "No known current price for this ticker - cannot size or submit.",
      });
      continue;
    }

    const maxAffordableShares = Math.floor(availableCash / price);
    const sizedQty = Math.min(order.shares, maxAffordableShares);

    if (sizedQty <= 0) {
      blockedOrders.push({
        ...makeOutcome(order),
        blockReason: `Insufficient available cash after SELL legs settled (wanted ${order.shares} shares at ~$${price.toFixed(2)}, can afford 0).`,
      });
      continue;
    }

    const executedCountBefore = executedOrders.length;
    const ambiguousCountBefore = ambiguousOrders.length;

    await attemptLeg(order, sizedQty);

    // Decrement the running cash pool so a later BUY leg in the same
    // cycle can't double-spend cash this leg already committed. Ambiguous
    // is treated conservatively (assume spent) per the comment above;
    // a definitive failure spends nothing.
    if (
      executedOrders.length > executedCountBefore ||
      ambiguousOrders.length > ambiguousCountBefore
    ) {
      availableCash -= sizedQty * price;
    }
  }

  return finalize();
}
