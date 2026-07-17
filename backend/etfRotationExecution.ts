// ETF Rotation Stage 2D, PR #46 - an isolated execution adapter, built and
// tested standalone. Per the approved plan, this file is NOT imported or
// called from autopilotWorker.ts - it exists so the riskiest remaining
// logic (side-aware gates, SELL-before-BUY sequencing, cash-aware BUY
// resizing, per-leg audit trail) can be built and fully unit-tested before
// a later PR ever makes it reachable from the live worker cycle. This file
// deliberately does not import anything from autopilotWorker.ts or
// server.ts - order submission is received as an injected dependency, so
// tests never need real Alpaca calls or a live worker.
//
// This module never touches the rebalance state machine
// (etfRotationWorkerState.ts) - no import from that file exists here. The
// caller (a future execution-wiring PR) is responsible for translating
// this function's returned EtfRotationExecutionResult into a
// planned/executing/executed/partial/failed/failed_needs_review
// transition; this adapter only reports what it attempted.
//
// IMPORTANT for the execution-wiring PR (caught in review before merge,
// not self-caught): the injected `submitOrderLeg` is deliberately NOT the
// real `executeSafeTrade` (server.ts)'s own signature - that function's
// outer try/catch already collapses both `definitive_rejection` and
// `ambiguous_network_error` (see orderIdempotency.ts's classifyOrderError,
// used internally) into an identical `{ status: "error", reason: message }`
// shape before it ever resolves. A wrapper written around the *unmodified*
// `executeSafeTrade` cannot recover that lost distinction - the
// classification has to be preserved *inside* whatever produces the
// result this adapter receives. `submitOrderLeg` therefore requires its
// caller to return one of exactly three outcomes directly
// (accepted/rejected/ambiguous), forcing the execution-wiring PR to either
// change `executeSafeTrade` itself (or a sibling function sharing its
// internals) to stop discarding the classification, rather than silently
// wrapping the function as-is and losing ambiguous-vs-definitive handling.
//
// Also note: "accepted" here means the broker accepted the order request
// (`executeSafeTrade` returns right after `alpaca.createOrder(...)`
// resolves, with no fill-confirmation poll) - it is not a claim that the
// order has actually filled. Deliberately not called "filled"/"executed"
// at this layer for that reason; a future PR mapping this adapter's
// result into the rebalance state machine's own "executed" terminal
// status is a separate, visible decision to make explicitly, not implied
// by matching vocabulary here.

import {
  deriveLegType,
  type EtfRotationOrderAuditEvent,
  type EtfRotationOrderLegType,
} from "./etfRotationOrderAuditLog.js";
import type { RebalanceOrder } from "./etfRotationStrategy.js";
import type { PortfolioSnapshot } from "./src/strategy/portfolioSafety.js";

export type EtfRotationOrderLegOutcomeKind = "accepted" | "rejected" | "ambiguous";

export interface EtfRotationSubmitOrderLegResult {
  outcome: EtfRotationOrderLegOutcomeKind;
  /** Only meaningful for "accepted". */
  brokerOrderId?: string;
  /** Only meaningful for "rejected"/"ambiguous" - why the leg didn't cleanly succeed. */
  reason?: string;
}

// Deliberately NOT the real executeSafeTrade's signature - see the
// file-level comment above. The caller is contractually required to
// classify the outcome itself and never leak an unclassified thrown
// error; if it does throw anyway, this adapter treats that defensively as
// "ambiguous" (see attemptLeg below), never as a silent success or a
// confident rejection.
export type EtfRotationSubmitOrderLeg = (
  ticker: string,
  action: "BUY" | "SELL",
  requestedShares: number,
) => Promise<EtfRotationSubmitOrderLegResult>;

export interface EtfRotationExecutionGates {
  /** AUTOPILOT_EXECUTE_TRADES - global off switch. False blocks every leg, uniformly. */
  executeTradesEnabled: boolean;
  /** AUTOPILOT_ALLOW_BUY - checked per BUY leg, independent of allowSell. */
  allowBuy: boolean;
  /** AUTOPILOT_ALLOW_SELL - checked per SELL leg, independent of allowBuy. */
  allowSell: boolean;
  /**
   * AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT - caps any single BUY
   * leg's dollar size to this percent of refreshed equity, independent of
   * cash affordability and independent per leg (not a shared pool - the
   * number of BUY legs that appear in a cycle isn't fixed, since a pick can
   * fail the trend filter and drop to cash; a shared pool would silently
   * change per-position sizing based on how many picks happened to
   * qualify). undefined = uncapped (current, unchanged behavior).
   */
  rampMaxPositionEquityPercent?: number;
}

export interface EtfRotationLegOutcome {
  ticker: string;
  action: "BUY" | "SELL";
  legType: EtfRotationOrderLegType;
  requestedQty: number;
  /** The actually-attempted quantity, which may be less than requestedQty for a cash-resized BUY leg. Absent if never attempted (blocked). */
  submittedQty?: number;
  brokerOrderId?: string;
  error?: string;
  /** Only set for blockedOrders - why this leg was never attempted. */
  blockReason?: string;
}

export type EtfRotationExecutionStatus =
  | "not_attempted"
  | "blocked"
  | "accepted"
  | "partial"
  | "failed"
  | "ambiguous";

export interface EtfRotationExecutionResult {
  status: EtfRotationExecutionStatus;
  /** Legs the broker accepted (not fill-confirmed - see the file-level comment). */
  acceptedOrders: EtfRotationLegOutcome[];
  failedOrders: EtfRotationLegOutcome[];
  blockedOrders: EtfRotationLegOutcome[];
  ambiguousOrders: EtfRotationLegOutcome[];
}

export interface ExecuteEtfRotationOrdersParams {
  rebalanceMonthKey: string;
  configVariantKey: string;
  orders: RebalanceOrder[];
  executionGates: EtfRotationExecutionGates;
  submitOrderLeg: EtfRotationSubmitOrderLeg;
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
 * Priority: an empty order set is trivially "accepted" (nothing needed).
 * Any ambiguous leg wins over everything else - §8's "never assume
 * success" rule means one uncertain leg makes the whole cycle worth a
 * human's attention, regardless of how many other legs succeeded. Full
 * acceptance only when every leg was accepted. "blocked" only when
 * nothing was attempted at all (every leg gate-blocked or paired-SELL-
 * blocked) and nothing failed. Any accepted leg alongside a non-accepted
 * one is "partial". Otherwise "failed" (attempted and failed, nothing
 * accepted).
 */
export function computeOverallExecutionStatus(counts: {
  accepted: number;
  failed: number;
  blocked: number;
  ambiguous: number;
  total: number;
}): EtfRotationExecutionStatus {
  if (counts.total === 0) return "accepted";
  if (counts.ambiguous > 0) return "ambiguous";
  if (counts.accepted === counts.total) return "accepted";
  if (counts.accepted === 0 && counts.failed === 0) return "blocked";
  if (counts.accepted > 0) return "partial";
  return "failed";
}

/**
 * Pure sizing ceiling for the paper-execution ramp - a per-position cap
 * on how many shares a single BUY leg may request, independent of cash
 * affordability. `undefined` means uncapped (current, unchanged
 * behavior) - returning `Infinity` rather than `order.shares` itself so
 * the caller can combine this with the existing cash ceiling via a plain
 * `Math.min` without a separate "is this capped at all" branch.
 */
export function computeRampMaxShares(
  price: number,
  equity: number,
  rampMaxPositionEquityPercent: number | undefined,
): number {
  if (rampMaxPositionEquityPercent === undefined) return Infinity;
  return Math.max(
    0,
    Math.floor((rampMaxPositionEquityPercent / 100) * equity / price),
  );
}

/**
 * Fails loud at module load (same convention as `assertValidEtfRotationConfig`
 * for `holdCount`), not per-cycle: unlike `resolveEtfRotationConfigVariant`
 * (where falling back to the validated baseline is the safe direction),
 * falling back to *uncapped* here would be the one outcome this whole
 * feature exists to prevent - a fat-fingered out-of-range value must never
 * silently degrade to "no cap at all". `raw === undefined` (the env var
 * genuinely absent) is the only input that returns `undefined` - checked
 * before parsing, never inferred from falsiness, since `"0"` is a
 * deliberate, legitimate "block all BUYs via ramp" setting and must not
 * collapse into "uncapped" the way a `parsed || fallback` pattern would.
 */
export function resolveRampMaxPositionEquityPercent(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(
      `Invalid AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT (${JSON.stringify(raw)}): must be a number between 0 and 100, or unset for uncapped (current) behavior.`,
    );
  }
  return parsed;
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

/**
 * Translates a rebalance's computed orders into real (paper) order
 * submissions - SELL legs first, then a refreshed-cash-aware pass over BUY
 * legs. Never called from any live path yet (see the file-level comment
 * above).
 */
export async function executeEtfRotationOrders(
  params: ExecuteEtfRotationOrdersParams,
): Promise<EtfRotationExecutionResult> {
  const {
    rebalanceMonthKey,
    configVariantKey,
    orders,
    executionGates,
    submitOrderLeg,
    appendAuditEvent,
    refreshPortfolioSnapshot,
    currentPriceByTicker,
    now,
  } = params;

  const acceptedOrders: EtfRotationLegOutcome[] = [];
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
        accepted: acceptedOrders.length,
        failed: failedOrders.length,
        blocked: blockedOrders.length,
        ambiguous: ambiguousOrders.length,
        total: orders.length,
      }),
      acceptedOrders,
      failedOrders,
      blockedOrders,
      ambiguousOrders,
    };
  }

  if (orders.length === 0) {
    return finalize();
  }

  // Global off switch - every leg blocked uniformly, submitOrderLeg never
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
      acceptedOrders,
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

    let legResult: EtfRotationSubmitOrderLegResult;

    try {
      legResult = await submitOrderLeg(order.ticker, order.action, submittedQty);
    } catch (error) {
      // submitOrderLeg is contractually required to classify and never
      // throw - but if it does anyway, treat it the safest possible way:
      // as ambiguous (we genuinely don't know what happened), never as a
      // confident rejection and never as a silent success.
      legResult = { outcome: "ambiguous", reason: extractErrorMessage(error) };
    }

    if (legResult.outcome === "rejected") {
      outcome.error = legResult.reason ?? "Order leg rejected.";
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

    if (legResult.outcome === "ambiguous") {
      // Never assumed successful (design doc §8/§3) - the order may
      // genuinely have reached the broker, so a paired BUY is blocked the
      // same as a confirmed SELL failure, and cash is conservatively
      // treated as possibly spent by the caller's own bookkeeping below.
      outcome.error = legResult.reason ?? "Order leg outcome could not be confirmed.";
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
      return;
    }

    // "accepted" - see the file-level comment: broker-accepted, not
    // fill-confirmed.
    outcome.brokerOrderId = legResult.brokerOrderId;
    acceptedOrders.push(outcome);

    await appendAuditEvent({
      type: "ORDER_ACCEPTED",
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

    // Ramp cap checked first, as its own sequential stage, so a block
    // caused by the ramp can be attributed to the ramp specifically -
    // folding this into a single three-way Math.min with the cash check
    // below would lose which ceiling actually bound at zero.
    const rampMaxShares = computeRampMaxShares(
      price,
      refreshedSnapshot.equity,
      executionGates.rampMaxPositionEquityPercent,
    );
    const rampCappedRequest = Math.min(order.shares, rampMaxShares);

    if (rampCappedRequest <= 0) {
      blockedOrders.push({
        ...makeOutcome(order),
        blockReason: `Blocked by AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT=${executionGates.rampMaxPositionEquityPercent} (wanted ${order.shares} shares, ramp cap allows 0 at ~$${price.toFixed(2)}).`,
      });
      continue;
    }

    const maxAffordableShares = Math.floor(availableCash / price);
    const sizedQty = Math.min(rampCappedRequest, maxAffordableShares);

    if (sizedQty <= 0) {
      blockedOrders.push({
        ...makeOutcome(order),
        blockReason: `Insufficient available cash after SELL legs settled (wanted ${rampCappedRequest} shares at ~$${price.toFixed(2)}, can afford 0).`,
      });
      continue;
    }

    const acceptedCountBefore = acceptedOrders.length;
    const ambiguousCountBefore = ambiguousOrders.length;

    await attemptLeg(order, sizedQty);

    // Decrement the running cash pool so a later BUY leg in the same
    // cycle can't double-spend cash this leg already committed. Ambiguous
    // is treated conservatively (assume spent) per the comment above;
    // a definitive failure spends nothing.
    if (
      acceptedOrders.length > acceptedCountBefore ||
      ambiguousOrders.length > ambiguousCountBefore
    ) {
      availableCash -= sizedQty * price;
    }
  }

  return finalize();
}
