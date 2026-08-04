// ETF Rotation Stage 2D, PR #46 - an isolated execution adapter, originally
// built and tested standalone before PR #47b wired it into the live
// runEtfRotationCycle (etfRotationCycle.ts) - it now IS reachable from the
// live worker cycle. Kept the isolation on purpose: this file still
// deliberately does not import anything from autopilotWorker.ts or
// server.ts directly - order submission is received as an injected
// dependency, so tests never need real Alpaca calls or a live worker.
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
// resolves) - it is not by itself a claim that the order has actually
// filled. Deliberately not called "filled"/"executed" at this layer for
// that reason; a future PR mapping this adapter's result into the
// rebalance state machine's own "executed" terminal status is a separate,
// visible decision to make explicitly, not implied by matching vocabulary
// here.
//
// UPDATE (2026-08-04, real production incident): a liquidate_existing SELL
// being merely "accepted" (not yet filled) turned out not to be safe
// enough for its paired rebuild_target BUY specifically - Alpaca rejected
// a same-ticker BUY submitted before its SELL had filled (a same-symbol
// order-crossing/wash-trade check, confirmed via order timestamps: QQQ's
// rebuild BUY was submitted at 13:52:26.043, before its SELL filled at
// 13:52:27.009, and was rejected HTTP 403; SPY's succeeded only because
// its SELL happened to fill before the BUY was submitted). See
// waitForSellFill below - this is now a genuine fill-confirmation wait,
// scoped narrowly to exactly the leg pairing that needs it.

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

// "filled": safe to submit the paired rebuild BUY. "definitively_not_filled":
// the SELL, despite being accepted, later resolved to rejected/canceled/
// expired - treated the same as an outright-rejected SELL (the paired BUY
// must not rebuild a position whose liquidation never actually happened).
// "unconfirmed": still not filled (or its status couldn't be read) when the
// timeout elapsed - genuinely unknown, not safe to assume either way, so
// this must escalate the cycle to ambiguous/failed_needs_review rather than
// silently proceeding or silently blocking as if it were a normal failure.
export type SellFillWaitOutcome =
  | "filled"
  | "definitively_not_filled"
  | "unconfirmed";

// Deliberately just the status string, not the full order object - keeps
// the real implementation (server.ts, wrapping alpaca.getOrder) trivial and
// keeps tests for the polling logic below from needing to fabricate a full
// order shape.
export type GetOrderStatus = (brokerOrderId: string) => Promise<string>;

export type WaitForSellFill = (
  brokerOrderId: string,
  ticker: string,
) => Promise<SellFillWaitOutcome>;

const FILLED_ORDER_STATUSES = new Set(["filled"]);
// Alpaca terminal statuses that definitively mean "did not end up filled" -
// anything else (new, accepted, pending_new, partially_filled, held, etc.)
// is treated as still-in-progress and worth another poll.
const TERMINAL_NOT_FILLED_ORDER_STATUSES = new Set([
  "rejected",
  "canceled",
  "expired",
  "stopped",
  "suspended",
  "done_for_day",
]);

/**
 * Builds the real waitForSellFill implementation from a raw single-order
 * status getter - the Alpaca-status-semantics mapping (what counts as
 * filled vs. terminally-not-filled vs. still-pending) lives here, once,
 * directly unit-tested; server.ts/autopilotWorker.ts only need to supply a
 * thin `getOrderStatus`. A getOrderStatus failure is treated as "still
 * unknown" and just retried on the next poll rather than surfaced - if it
 * keeps failing until the timeout, that correctly resolves to "unconfirmed"
 * on its own, no separate error handling needed.
 */
export function createWaitForSellFill(
  getOrderStatus: GetOrderStatus,
  pollIntervalMs: number,
  timeoutMs: number,
): WaitForSellFill {
  return async (brokerOrderId: string): Promise<SellFillWaitOutcome> => {
    const deadline = Date.now() + timeoutMs;

    while (true) {
      let status = "";
      try {
        status = await getOrderStatus(brokerOrderId);
      } catch {
        // Treated as still-unknown - see the function doc comment above.
      }

      if (FILLED_ORDER_STATUSES.has(status)) return "filled";
      if (TERMINAL_NOT_FILLED_ORDER_STATUSES.has(status)) {
        return "definitively_not_filled";
      }
      if (Date.now() >= deadline) return "unconfirmed";

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  };
}

/**
 * Resolves AUTOPILOT_ETF_ROTATION_SELL_FILL_TIMEOUT_MS /
 * AUTOPILOT_ETF_ROTATION_SELL_FILL_POLL_MS. Same strict-whole-string-integer,
 * fail-loud-at-module-load convention as resolveRampMaxPositionEquityPercent
 * - a fat-fingered value ("10abc") must never silently become a truncated
 * number.
 */
export function resolveEtfRotationSellFillTimingMs(
  rawTimeoutMs: string | undefined,
  rawPollIntervalMs: string | undefined,
): { timeoutMs: number; pollIntervalMs: number } {
  const timeoutMs = parseStrictPositiveIntEnv(
    "AUTOPILOT_ETF_ROTATION_SELL_FILL_TIMEOUT_MS",
    rawTimeoutMs,
    10000,
  );
  const pollIntervalMs = parseStrictPositiveIntEnv(
    "AUTOPILOT_ETF_ROTATION_SELL_FILL_POLL_MS",
    rawPollIntervalMs,
    500,
  );
  return { timeoutMs, pollIntervalMs };
}

function parseStrictPositiveIntEnv(
  name: string,
  raw: string | undefined,
  defaultValue: number,
): number {
  if (raw === undefined) return defaultValue;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid ${name} (${JSON.stringify(raw)}): must be a non-negative integer, or unset to default to ${defaultValue}.`,
    );
  }
  return Number(trimmed);
}

export interface EtfRotationExecutionGates {
  /** AUTOPILOT_EXECUTE_TRADES - global off switch. False blocks every leg, uniformly. */
  executeTradesEnabled: boolean;
  /** AUTOPILOT_ALLOW_BUY - checked per BUY leg, independent of allowRebalanceSells. */
  allowBuy: boolean;
  /**
   * AUTOPILOT_ALLOW_REBALANCE_SELLS - gates this rotation cycle's own
   * SELL legs (freeing capital to open/replace positions each rebalance).
   * Deliberately a separate gate from the baseline strategy's
   * AUTOPILOT_ALLOW_SELL, which stays independently off - unblocking the
   * rotation's own liquidate-and-rebuy mechanism does not touch the
   * baseline path's SELL/STOP_LOSS gate at all.
   */
  allowRebalanceSells: boolean;
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
  /**
   * AUTOPILOT_ETF_ROTATION_MAX_POSITIONS - always-on guardrail (not an
   * opt-in like the ramp cap): blocks a BUY that would open a brand-new
   * rotation-universe position once the number of currently-open positions
   * already reaches this count. Exists specifically for the case
   * allowRebalanceSells is meant to prevent but can't guarantee (a SELL
   * leg that fails/is rejected/is ambiguous at the broker) - without this,
   * a ticker stuck unsold could accumulate alongside new picks indefinitely,
   * since nothing else in this file bounds total open-position count.
   * Resolved by the caller via resolveMaxAllowedPositions (default
   * holdCount+1), never left undefined.
   */
  maxAllowedPositions: number;
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
  /**
   * Called after an accepted liquidate_existing SELL (one with a paired
   * rebuild_target BUY this cycle) to confirm it actually filled before the
   * paired BUY is attempted - see the file-level 2026-08-04 update comment
   * above for why. Never called for exit_removed SELLs (no paired BUY to
   * gate) or for BUY legs.
   */
  waitForSellFill: WaitForSellFill;
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
 *
 * Uses a strict whole-string regex rather than `Number.parseFloat` -
 * `parseFloat` parses only the leading numeric portion of a string and
 * silently ignores trailing garbage (`Number.parseFloat("10abc") === 10`),
 * which would let a fat-fingered value like `"10abc"` or `"5 percent"`
 * quietly become a "valid" 10/5 instead of failing loud, defeating the
 * whole point of validating at module load. Surrounding whitespace is
 * trimmed first (a forgiving allowance for a stray newline/space in a
 * dashboard-entered env var), but no characters may remain after that.
 */
export function resolveRampMaxPositionEquityPercent(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(
      `Invalid AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT (${JSON.stringify(raw)}): must be a number between 0 and 100, or unset for uncapped (current) behavior.`,
    );
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(
      `Invalid AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT (${JSON.stringify(raw)}): must be a number between 0 and 100, or unset for uncapped (current) behavior.`,
    );
  }
  return parsed;
}

/**
 * Resolves AUTOPILOT_ETF_ROTATION_MAX_POSITIONS. Unlike the ramp cap, this
 * guardrail is always active - there is no "unset = uncapped" escape
 * hatch, since it exists specifically to bound a failure mode (a stuck
 * unsold position) rather than to gate an opt-in capability. Unset
 * defaults to holdCount+1 - normal operation holds exactly holdCount
 * positions, so the +1 buffer tolerates a single stuck position before
 * halting new BUYs, without silently allowing unbounded accumulation.
 * Fails loud at module load on a fat-fingered value, same convention as
 * resolveRampMaxPositionEquityPercent.
 */
export function resolveMaxAllowedPositions(
  raw: string | undefined,
  holdCount: number,
): number {
  if (raw === undefined) return holdCount + 1;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid AUTOPILOT_ETF_ROTATION_MAX_POSITIONS (${JSON.stringify(raw)}): must be a non-negative integer, or unset to default to holdCount+1 (${holdCount + 1}).`,
    );
  }
  return Number(trimmed);
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
    waitForSellFill,
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
  // Tickers whose paired BUY outcome was already recorded directly (pushed
  // into ambiguousOrders) by the fill-confirmation wait below - the BUY
  // loop must skip these entirely rather than also pushing a blockedOrders
  // entry for the same order, which would double-count it against
  // computeOverallExecutionStatus's totals.
  const pairedBuyAlreadyRecordedTickers = new Set<string>();

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
    if (!executionGates.allowRebalanceSells) {
      blockedOrders.push({
        ...makeOutcome(order),
        blockReason: "AUTOPILOT_ALLOW_REBALANCE_SELLS is false.",
      });
      // A SELL that's deliberately gated off is treated the same as one
      // that failed to clear - the paired BUY should not rebuild a
      // position whose liquidation never happened.
      sellFailedTickers.add(order.ticker);
      continue;
    }

    const acceptedCountBefore = acceptedOrders.length;
    await attemptLeg(order, order.shares);

    // Only a liquidate_existing SELL (paired with a rebuild BUY this cycle)
    // needs a fill-confirmation wait - see the file-level 2026-08-04 update
    // comment. An exit_removed SELL (no paired BUY) proceeds exactly as
    // before, no wait.
    const hasPairedBuy = buyTickers.has(order.ticker);
    const wasAccepted = acceptedOrders.length > acceptedCountBefore;

    if (wasAccepted && hasPairedBuy) {
      const acceptedOutcome = acceptedOrders[acceptedOrders.length - 1]!;
      const waitOutcome = acceptedOutcome.brokerOrderId
        ? await waitForSellFill(acceptedOutcome.brokerOrderId, order.ticker)
        : "unconfirmed"; // no broker order id to poll against - can't confirm

      if (waitOutcome === "definitively_not_filled") {
        // The SELL was accepted but later resolved to rejected/canceled/
        // expired - the initial "accepted" push into acceptedOrders is now
        // known-stale and must be demoted, not left as-is. Leaving it there
        // would let the cycle report "partial" (a TERMINAL_SUCCESS_STATUSES
        // value that closes the monthly gate) for a SELL that definitively
        // did not happen, and would show it as "executed" in the journal -
        // actively misleading, not just imprecise (caught in review before
        // merge, not self-caught). Demoted into failedOrders, the same
        // bucket an immediately-rejected SELL already lands in via
        // attemptLeg, so both paths converge on one outcome shape.
        sellFailedTickers.add(order.ticker);
        acceptedOrders.pop();
        acceptedOutcome.error = `SELL was initially accepted but did not end up filling (broker order ${acceptedOutcome.brokerOrderId ?? "unknown"} ultimately resolved to rejected/canceled/expired).`;
        failedOrders.push(acceptedOutcome);

        await appendAuditEvent({
          type: "ORDER_REJECTED",
          timestamp: now(),
          rebalanceMonthKey,
          configVariantKey,
          ticker: order.ticker,
          side: "SELL",
          legType: acceptedOutcome.legType,
          requestedQty: acceptedOutcome.requestedQty,
          submittedQty: acceptedOutcome.submittedQty,
          brokerOrderId: acceptedOutcome.brokerOrderId,
          error: acceptedOutcome.error,
        });
      } else if (waitOutcome === "unconfirmed") {
        sellFailedTickers.add(order.ticker);

        const pairedBuyOrder = buyOrders.find((buy) => buy.ticker === order.ticker);
        if (pairedBuyOrder) {
          pairedBuyAlreadyRecordedTickers.add(order.ticker);

          const buyOutcome = makeOutcome(pairedBuyOrder);
          buyOutcome.error = `Paired SELL (broker order ${acceptedOutcome.brokerOrderId ?? "unknown"}) fill could not be confirmed before the configured timeout - not safe to submit the rebuild BUY.`;
          ambiguousOrders.push(buyOutcome);

          await appendAuditEvent({
            type: "PAIRED_SELL_FILL_UNCONFIRMED",
            timestamp: now(),
            rebalanceMonthKey,
            configVariantKey,
            ticker: order.ticker,
            side: "BUY",
            legType: buyOutcome.legType,
            requestedQty: pairedBuyOrder.shares,
            brokerOrderId: acceptedOutcome.brokerOrderId,
            error: buyOutcome.error,
          });
        }
      }
      // "filled" - no action needed, the paired BUY proceeds normally below.
    }
  }

  // Refresh cash after SELLs settle (design doc §5) - sizing BUYs off a
  // stale pre-SELL cash figure risks over-committing. Always refreshed,
  // even if there were no SELL legs this cycle, for a consistent sequence.
  const refreshedSnapshot = await refreshPortfolioSnapshot();
  let availableCash = refreshedSnapshot.balance;

  // Starting point for the max-allowed-positions guardrail below - open
  // positions within the tracked universe (currentPriceByTicker's keys),
  // as of right after SELLs settled. Grown as new-ticker BUYs succeed in
  // the loop below, same running-tally pattern as availableCash.
  const openPositionTickers = new Set(
    Object.entries(refreshedSnapshot.positions)
      .filter(([ticker, position]) => position.shares > 0 && currentPriceByTicker.has(ticker))
      .map(([ticker]) => ticker),
  );

  for (const order of buyOrders) {
    // Already recorded directly (as an ambiguousOrders entry) by the
    // fill-confirmation wait above - do not also push a blockedOrders
    // entry for the same order, which would double-count it.
    if (pairedBuyAlreadyRecordedTickers.has(order.ticker)) {
      continue;
    }

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

    // Position-count guardrail checked as its own stage, before sizing -
    // a ticker not already held that would push the open-position count
    // past the cap is blocked outright, regardless of cash/ramp room.
    // Resizing an already-open position never counts against the cap.
    const opensNewPosition = !openPositionTickers.has(order.ticker);
    if (opensNewPosition && openPositionTickers.size >= executionGates.maxAllowedPositions) {
      blockedOrders.push({
        ...makeOutcome(order),
        blockReason: `Blocked by AUTOPILOT_ETF_ROTATION_MAX_POSITIONS=${executionGates.maxAllowedPositions}: already holding ${openPositionTickers.size} position(s) within the universe and this would open a new one.`,
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
      // Same conservative "assume it happened" treatment as the cash
      // decrement above - an ambiguous BUY may genuinely have opened the
      // position, so count it against the cap now rather than risk a
      // later leg in this same cycle overshooting the guardrail.
      if (opensNewPosition) {
        openPositionTickers.add(order.ticker);
      }
    }
  }

  return finalize();
}
