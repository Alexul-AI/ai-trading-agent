// The ETF Rotation strategy's per-cycle orchestration - extracted from
// autopilotWorker.ts (PR #53, Stage 2 of the staged refactor - see
// docs/ops/AUTOPILOT_WORKER_MAP.md). Confirmed to have zero dependency on
// createAutopilotWorker's closure state before this move - everything it
// needs comes in as an explicit parameter here instead of being read from
// process.env/closure scope, which is also what makes it directly
// unit-testable without the vi.stubEnv/dynamic-import gymnastics
// autopilotWorker.ts's own characterization tests need.
import {
  computeRebalanceOrders,
  decideRotationTargets,
  type EtfRotationConfig,
  type RebalanceOrder,
} from "./etfRotationStrategy.js";
import {
  decideEtfRotationGateAction,
  readRebalanceStateStrict,
  recordRebalanceExecuting,
  recordRebalancePlanned,
  recordRebalanceTerminal,
} from "./etfRotationWorkerState.js";
import {
  computeRampMaxShares,
  executeEtfRotationOrders,
  type EtfRotationExecutionGates,
  type EtfRotationExecutionStatus,
  type EtfRotationSubmitOrderLeg,
  type EtfRotationSubmitOrderLegResult,
} from "./etfRotationExecution.js";
import { appendEtfRotationOrderAuditEvent } from "./etfRotationOrderAuditLog.js";
import type {
  AlpacaBar,
  AutopilotDecisionLog,
  ExecuteSafeTrade,
  ExecuteSafeTradeResult,
} from "./src/types/autopilotTypes.js";
import type { PortfolioSnapshot } from "./src/strategy/portfolioSafety.js";
import type { RebalanceStatus } from "./etfRotationWorkerState.js";

/**
 * Bridges executeSafeTrade's (server.ts) loose result shape into
 * etfRotationExecution.ts's own submit-order-leg contract. The
 * `classification` field (set only for a "definitely rejected" vs.
 * "ambiguous, might have gone through" distinction classified by
 * orderIdempotency.ts's classifyOrderError, surfaced via
 * server.ts's ClassifiedOrderError, see the comment on
 * ExecuteSafeTradeResult above) is what lets this function tell "ambiguous,
 * might have gone through" apart from every other kind of failure, which
 * the adapter must never conflate (design doc §3/§8's "never assume
 * success" rule).
 */
export function mapExecuteSafeTradeResultToLegOutcome(
  result: ExecuteSafeTradeResult,
): EtfRotationSubmitOrderLegResult {
  if (result.status === "success") {
    const order = result.order;
    const brokerOrderId =
      order && typeof order === "object" && "id" in order
        ? (order as { id?: unknown }).id
        : undefined;

    return {
      outcome: "accepted",
      brokerOrderId: typeof brokerOrderId === "string" ? brokerOrderId : undefined,
    };
  }

  if (result.classification === "ambiguous_network_error") {
    return { outcome: "ambiguous", reason: result.reason };
  }

  // Any other non-success status - an early gate-check "rejected" (circuit
  // breaker, risk manager) or a classified "definitive_rejection" - is a
  // confirmed, not ambiguous, failure.
  return { outcome: "rejected", reason: result.reason };
}

/**
 * Bridges etfRotationExecution.ts's own result vocabulary into the
 * rebalance state machine's (etfRotationWorkerState.ts) terminal
 * RebalanceStatus values. The one deliberate word-mapping decision flagged
 * in the design doc: "accepted" (the adapter's word - broker-accepted, not
 * fill-confirmed, see etfRotationExecution.ts's file comment) becomes
 * "executed" (the state machine's word) here, explicitly, rather than the
 * two layers silently sharing a word with different actual meanings.
 * "ambiguous" maps to "failed_needs_review" - the same "stop and let a
 * human check" posture that state already has for a restart-interrupted
 * cycle. "blocked"/"not_attempted" map to "cancelled" - nothing went
 * wrong, nothing was attempted, the monthly gate should simply reopen next
 * cycle (isRebalanceMonthDone never treats "cancelled" as done).
 */
export function mapEtfRotationExecutionStatusToRebalanceStatus(
  status: EtfRotationExecutionStatus,
): Exclude<RebalanceStatus, "planned" | "executing"> {
  switch (status) {
    case "accepted":
      return "executed";
    case "partial":
      return "partial";
    case "failed":
      return "failed";
    case "ambiguous":
      return "failed_needs_review";
    case "blocked":
    case "not_attempted":
      return "cancelled";
  }
}

export interface RunEtfRotationCycleParams {
  portfolio: PortfolioSnapshot;
  config: EtfRotationConfig;
  /** matches ExecuteEtfRotationOrdersParams.configVariantKey's existing plain-string looseness - not changed here. */
  configVariantKey: string;
  barsDays: number;
  warmupTradingDays: number;
  executionGates: EtfRotationExecutionGates;
  fetchBars: (ticker: string, days: number) => Promise<AlpacaBar[]>;
  broadcastSSE: (payload: unknown) => void;
  sendTelegramAlert?: (message: string) => Promise<void>;
  executeSafeTrade: ExecuteSafeTrade;
  getPortfolioSnapshot: () => Promise<PortfolioSnapshot>;
  etfRotationStateFilePath?: string;
  etfRotationOrderAuditLogFilePath?: string;
}

export async function runEtfRotationCycle(
  params: RunEtfRotationCycleParams,
): Promise<AutopilotDecisionLog[]> {
  const {
    portfolio,
    config,
    configVariantKey,
    barsDays,
    warmupTradingDays,
    executionGates,
    fetchBars,
    broadcastSSE,
    sendTelegramAlert,
    executeSafeTrade,
    getPortfolioSnapshot,
    etfRotationStateFilePath,
    etfRotationOrderAuditLogFilePath,
  } = params;

  const timestamp = new Date().toISOString();

  // Strict gate/state adoption (Stage 2D, PR #45), read BEFORE any
  // market-data fetch (PR #47b) - a corrupt state file or a stuck
  // failed_needs_review/executing must block the cycle even when
  // fetchAlpacaBars itself would fail or be slow; the old ordering (bars
  // first, state after) meant these restart hazards were never even
  // evaluated on a bad market-data day. decideEtfRotationGateAction
  // (etfRotationWorkerState.ts) fails closed on a corrupt state file,
  // detects a stale "executing" leftover from a crash mid-sequence
  // (transitions it to failed_needs_review rather than resuming), and
  // blocks on an existing failed_needs_review until a human clears it via
  // the admin-gated POST /api/autopilot/etf-rotation/clear-review endpoint
  // (server.ts). None of these first three checks need today's date, so
  // monthKey is passed as null here - see decideEtfRotationGateAction's
  // own doc comment for why this is an explicit, tested part of its
  // contract, not an accident of internal check ordering.
  const stateResult = await readRebalanceStateStrict(etfRotationStateFilePath);
  const preBarsGateAction = decideEtfRotationGateAction(stateResult, null);
  const noPricesYet = new Map<string, number>();

  if (preBarsGateAction === "state_corrupt_fail_closed") {
    const alertMessage =
      "ETF Rotation state file is unreadable/corrupt - failing closed, no new rebalance attempted this cycle. Investigate data/etf-rotation-worker-state.json.";

    broadcastSSE({
      type: "notification",
      level: "error",
      message: alertMessage,
    });
    if (sendTelegramAlert) {
      await sendTelegramAlert(alertMessage);
    }

    return config.universe.map((ticker) => ({
      ticker,
      timestamp,
      price: noPricesYet.get(ticker) ?? 0,
      action: "HOLD",
      confidence: 0,
      suggestedShares: 0,
      reasonType: "NOT_REBALANCE_DAY",
      reason: alertMessage,
      finalStatus: "blocked",
      signalStatus: "blocked",
      executionStatus: "not_attempted",
      isSignalReady: false,
      blockReasonCategory: "error",
      blockReasonCode: "ETF_ROTATION_STATE_CORRUPT",
      blockReasonDetail: alertMessage,
      executed: false,
      skippedReason: alertMessage,
    }));
  }

  if (preBarsGateAction === "stale_executing_needs_review") {
    // A previous process left the cycle mid-sequence (crash between SELL
    // and BUY legs, or between planning and execution starting) - never
    // resumed, per the design doc's Stage 2A resolution. Reachable for
    // real now that executeEtfRotationOrders is wired in below.
    await recordRebalanceTerminal("failed_needs_review", etfRotationStateFilePath);

    const alertMessage =
      'ETF Rotation found a stuck "executing" rebalance from a previous cycle/restart - marked failed_needs_review. Blocked until cleared via POST /api/autopilot/etf-rotation/clear-review.';

    broadcastSSE({
      type: "notification",
      level: "error",
      message: alertMessage,
    });
    if (sendTelegramAlert) {
      await sendTelegramAlert(alertMessage);
    }

    return config.universe.map((ticker) => ({
      ticker,
      timestamp,
      price: noPricesYet.get(ticker) ?? 0,
      action: "HOLD",
      confidence: 0,
      suggestedShares: 0,
      reasonType: "NOT_REBALANCE_DAY",
      reason: alertMessage,
      finalStatus: "blocked",
      signalStatus: "blocked",
      executionStatus: "not_attempted",
      isSignalReady: false,
      blockReasonCategory: "safety_cap",
      blockReasonCode: "ETF_ROTATION_STALE_EXECUTING",
      blockReasonDetail: alertMessage,
      executed: false,
      skippedReason: alertMessage,
    }));
  }

  if (preBarsGateAction === "blocked_failed_needs_review") {
    // Quiet on repeat cycles (unlike the one-time alert above) - the
    // transition into failed_needs_review already alerted once; staying
    // blocked every subsequent cycle until a human clears it shouldn't
    // re-alert every cycle.
    const reason = `ETF Rotation is blocked in failed_needs_review (month ${
      stateResult.state.rebalanceMonthKey ?? "unknown"
    }) - clear via POST /api/autopilot/etf-rotation/clear-review before further rebalancing.`;

    return config.universe.map((ticker) => ({
      ticker,
      timestamp,
      price: noPricesYet.get(ticker) ?? 0,
      action: "HOLD",
      confidence: 0,
      suggestedShares: 0,
      reasonType: "NOT_REBALANCE_DAY",
      reason,
      finalStatus: "blocked",
      signalStatus: "blocked",
      executionStatus: "not_attempted",
      isSignalReady: false,
      blockReasonCategory: "safety_cap",
      blockReasonCode: "ETF_ROTATION_FAILED_NEEDS_REVIEW",
      blockReasonDetail: reason,
      executed: false,
      skippedReason: reason,
    }));
  }

  // preBarsGateAction === "needs_month_key" - no restart hazard applies;
  // safe (and necessary) to fetch market data now.

  const barsByTicker = new Map<string, AlpacaBar[]>();

  await Promise.all(
    config.universe.map(async (ticker) => {
      barsByTicker.set(ticker, await fetchBars(ticker, barsDays));
    }),
  );

  let latestDateKey: string | null = null;
  const priceHistoryByTicker = new Map<string, number[]>();
  const currentPriceByTicker = new Map<string, number>();

  for (const ticker of config.universe) {
    const bars = barsByTicker.get(ticker) ?? [];
    const prices = bars.map((bar) => bar.c);
    priceHistoryByTicker.set(ticker, prices);

    const latestBar = bars[bars.length - 1];
    if (latestBar) {
      currentPriceByTicker.set(ticker, Number(latestBar.c.toFixed(2)));
      const dateKey = latestBar.t.split("T")[0] ?? latestBar.t;
      if (!latestDateKey || dateKey > latestDateKey) {
        latestDateKey = dateKey;
      }
    }
  }

  if (!latestDateKey) {
    throw new Error(
      "ETF Rotation: no bars available for any universe ticker.",
    );
  }

  const monthKey = latestDateKey.slice(0, 7);
  // Same stateResult as above, now with the real monthKey - only
  // "already_done_this_month" or "proceed_to_plan" are structurally
  // reachable here (the other three already returned above); calling the
  // same single-source-of-truth function again avoids re-deriving
  // isRebalanceMonthDone's logic inline a second time.
  const gateAction = decideEtfRotationGateAction(stateResult, monthKey);

  if (gateAction === "already_done_this_month") {
    return config.universe.map((ticker) => ({
      ticker,
      timestamp,
      price: currentPriceByTicker.get(ticker) ?? 0,
      action: "HOLD",
      confidence: 0,
      suggestedShares: 0,
      reasonType: "NOT_REBALANCE_DAY",
      reason: `Already rebalanced this month (${monthKey}, status ${stateResult.state.status}).`,
      finalStatus: "hold",
      signalStatus: "hold",
      executionStatus: "not_attempted",
      isSignalReady: false,
      executed: false,
    }));
  }

  // gateAction === "proceed_to_plan" falls through below.

  // Fails closed (skips the rebalance rather than computing targets off
  // partial history) if any universe ticker doesn't yet have enough bars
  // for a numerically valid momentum/SMA read - same "don't trust a short
  // window" principle as the RSI/MACD warmup fix elsewhere in this repo.
  const insufficientHistoryTickers = config.universe.filter(
    (ticker) =>
      (priceHistoryByTicker.get(ticker)?.length ?? 0) < warmupTradingDays,
  );

  if (insufficientHistoryTickers.length > 0) {
    return config.universe.map((ticker) => ({
      ticker,
      timestamp,
      price: currentPriceByTicker.get(ticker) ?? 0,
      action: "HOLD",
      confidence: 0,
      suggestedShares: 0,
      reasonType: "NOT_REBALANCE_DAY",
      reason: `Skipping rebalance: insufficient warmup history (need ${warmupTradingDays} trading days) for ${insufficientHistoryTickers.join(
        ", ",
      )}.`,
      finalStatus: "hold",
      signalStatus: "hold",
      executionStatus: "not_attempted",
      isSignalReady: false,
      executed: false,
      skippedReason: "Insufficient warmup history.",
    }));
  }

  const targets = decideRotationTargets(priceHistoryByTicker, config);

  const currentSharesByTicker = new Map<string, number>();
  for (const ticker of config.universe) {
    const position = portfolio.positions[ticker];
    if (position?.shares) {
      currentSharesByTicker.set(ticker, position.shares);
    }
  }

  const orders: RebalanceOrder[] = computeRebalanceOrders(
    targets,
    portfolio.equity,
    currentSharesByTicker,
    currentPriceByTicker,
    config.universe,
  );

  // Status "planned".
  await recordRebalancePlanned(
    {
      dateKey: latestDateKey,
      rebalanceMonthKey: monthKey,
      configVariantKey,
      targets,
      plannedOrders: orders,
    },
    etfRotationStateFilePath,
  );

  const targetByTicker = new Map(targets.map((target) => [target.ticker, target]));
  const sellByTicker = new Map(
    orders
      .filter((order) => order.action === "SELL")
      .map((order) => [order.ticker, order]),
  );
  const buyByTicker = new Map(
    orders
      .filter((order) => order.action === "BUY")
      .map((order) => [order.ticker, order]),
  );

  if (!executionGates.executeTradesEnabled) {
    // Global off switch (PR #47b) - the adapter is never even reached,
    // not merely told not to act. Preserves Stage 1/PR45's exact dry-run
    // decision shape unchanged whenever execution stays disabled
    // (today's real Render value) - this PR changes zero observable
    // behavior unless AUTOPILOT_EXECUTE_TRADES is explicitly flipped,
    // which it is not here or in Render.
    return config.universe.map((ticker): AutopilotDecisionLog => {
      const price = currentPriceByTicker.get(ticker) ?? 0;
      const buyOrder = buyByTicker.get(ticker);
      const sellOrder = sellByTicker.get(ticker);
      const target = targetByTicker.get(ticker);

      if (buyOrder) {
        const reason = sellOrder
          ? `Momentum/trend rebalance: continuing top pick at target weight ${target?.weightPercent.toFixed(
              1,
            )}% - liquidated ${sellOrder.shares} existing shares and rebuilt to ${
              buyOrder.shares
            } shares.`
          : `Momentum/trend rebalance: new top pick at target weight ${target?.weightPercent.toFixed(
              1,
            )}% - buying ${buyOrder.shares} shares.`;

        return {
          ticker,
          timestamp,
          price,
          action: "BUY",
          confidence: 1,
          suggestedShares: buyOrder.shares,
          reasonType: "REBALANCE_BUY",
          reason,
          finalStatus: "signal_ready",
          signalStatus: "ready",
          executionStatus: "dry_run",
          isSignalReady: true,
          executionBlockReasonCategory: "dry_run",
          executionBlockReasonCode: "ETF_ROTATION_STAGE_1_NO_EXECUTION",
          executionBlockReasonDetail:
            "ETF Rotation execution is disabled (AUTOPILOT_EXECUTE_TRADES=false).",
          executed: false,
        };
      }

      if (sellOrder) {
        return {
          ticker,
          timestamp,
          price,
          action: "SELL",
          confidence: 1,
          suggestedShares: sellOrder.shares,
          reasonType: "REBALANCE_SELL",
          reason: `Momentum/trend rebalance: no longer a top pick or failed the trend filter - liquidating ${sellOrder.shares} shares.`,
          finalStatus: "signal_ready",
          signalStatus: "ready",
          executionStatus: "dry_run",
          isSignalReady: true,
          executionBlockReasonCategory: "dry_run",
          executionBlockReasonCode: "ETF_ROTATION_STAGE_1_NO_EXECUTION",
          executionBlockReasonDetail:
            "ETF Rotation execution is disabled (AUTOPILOT_EXECUTE_TRADES=false).",
          executed: false,
        };
      }

      return {
        ticker,
        timestamp,
        price,
        action: "HOLD",
        confidence: 0,
        suggestedShares: 0,
        reasonType: "REBALANCE_HOLD",
        reason: "Not currently held and not selected in this rebalance.",
        finalStatus: "hold",
        signalStatus: "hold",
        executionStatus: "not_attempted",
        isSignalReady: false,
        executed: false,
      };
    });
  }

  // AUTOPILOT_EXECUTE_TRADES is true - transition to executing and call
  // the adapter. This is the only place "executing" is ever written in
  // this file, and only reached when the global flag genuinely allows
  // it. Still requires the relevant side gate per leg (checked inside
  // executeEtfRotationOrders) and AUTOPILOT_STRATEGY=etf_rotation to
  // even be in this function at all - none of which are set in Render.
  await recordRebalanceExecuting(etfRotationStateFilePath);

  const submitOrderLeg: EtfRotationSubmitOrderLeg = async (
    ticker,
    action,
    requestedShares,
  ) =>
    mapExecuteSafeTradeResultToLegOutcome(
      await executeSafeTrade(ticker, action, requestedShares),
    );

  const executionResult = await executeEtfRotationOrders({
    rebalanceMonthKey: monthKey,
    configVariantKey,
    orders,
    executionGates,
    submitOrderLeg,
    appendAuditEvent: (event) =>
      appendEtfRotationOrderAuditEvent(event, etfRotationOrderAuditLogFilePath),
    refreshPortfolioSnapshot: getPortfolioSnapshot,
    currentPriceByTicker,
    now: () => new Date().toISOString(),
  });

  await recordRebalanceTerminal(
    mapEtfRotationExecutionStatusToRebalanceStatus(executionResult.status),
    etfRotationStateFilePath,
  );

  // Build the final per-ticker decisions from what actually happened this
  // cycle - the first time this can show a real (not hardcoded dry_run)
  // executionStatus for the rotation path.
  const acceptedByTicker = new Map(
    executionResult.acceptedOrders.map((outcome) => [outcome.ticker, outcome]),
  );
  const failedByTicker = new Map(
    executionResult.failedOrders.map((outcome) => [outcome.ticker, outcome]),
  );
  const blockedByTicker = new Map(
    executionResult.blockedOrders.map((outcome) => [outcome.ticker, outcome]),
  );
  const ambiguousByTicker = new Map(
    executionResult.ambiguousOrders.map((outcome) => [outcome.ticker, outcome]),
  );

  return config.universe.map((ticker): AutopilotDecisionLog => {
    const price = currentPriceByTicker.get(ticker) ?? 0;
    const target = targetByTicker.get(ticker);
    const weightNote = target
      ? ` at target weight ${target.weightPercent.toFixed(1)}%`
      : "";

    const accepted = acceptedByTicker.get(ticker);
    const failed = failedByTicker.get(ticker);
    const blocked = blockedByTicker.get(ticker);
    const ambiguous = ambiguousByTicker.get(ticker);
    const outcome = accepted ?? failed ?? ambiguous ?? blocked;

    if (!outcome) {
      return {
        ticker,
        timestamp,
        price,
        action: "HOLD",
        confidence: 0,
        suggestedShares: 0,
        reasonType: "REBALANCE_HOLD",
        reason: "Not currently held and not selected in this rebalance.",
        finalStatus: "hold",
        signalStatus: "hold",
        executionStatus: "not_attempted",
        isSignalReady: false,
        executed: false,
      };
    }

    const reasonType = outcome.action === "BUY" ? "REBALANCE_BUY" : "REBALANCE_SELL";

    if (accepted) {
      const submittedQty = accepted.submittedQty ?? accepted.requestedQty;
      // Independently recomputed (not threaded through EtfRotationLegOutcome,
      // which is unchanged by this feature) - true regardless of whether cash
      // also happened to bind, since it asks "would the ramp cap alone have
      // reduced this request" rather than reading the already-combined
      // ramp+cash result backwards.
      const rampCapped =
        accepted.action === "BUY" &&
        computeRampMaxShares(
          price,
          portfolio.equity,
          executionGates.rampMaxPositionEquityPercent,
        ) < accepted.requestedQty;
      const rampNote = rampCapped
        ? ` (ramp-capped from ${accepted.requestedQty})`
        : "";
      return {
        ticker,
        timestamp,
        price,
        action: accepted.action,
        confidence: 1,
        suggestedShares: submittedQty,
        reasonType,
        reason: `Momentum/trend rebalance${weightNote} - ${
          accepted.action === "BUY" ? "bought" : "sold"
        } ${submittedQty} shares (broker-accepted, not fill-confirmed).${rampNote}`,
        finalStatus: "executed",
        signalStatus: "ready",
        executionStatus: "executed",
        isSignalReady: true,
        executed: true,
      };
    }

    if (failed) {
      const detail = failed.error ?? "Order rejected by broker.";
      return {
        ticker,
        timestamp,
        price,
        action: failed.action,
        confidence: 1,
        suggestedShares: failed.submittedQty ?? failed.requestedQty,
        reasonType,
        reason: `Momentum/trend rebalance${weightNote} - ${failed.action} rejected: ${detail}`,
        finalStatus: "execution_failed",
        signalStatus: "ready",
        executionStatus: "failed",
        isSignalReady: true,
        executionBlockReasonCategory: "broker",
        executionBlockReasonCode: "ETF_ROTATION_ORDER_REJECTED",
        executionBlockReasonDetail: detail,
        executed: false,
        skippedReason: detail,
      };
    }

    if (ambiguous) {
      const detail =
        ambiguous.error ?? "Order outcome could not be confirmed.";
      return {
        ticker,
        timestamp,
        price,
        action: ambiguous.action,
        confidence: 1,
        suggestedShares: ambiguous.submittedQty ?? ambiguous.requestedQty,
        reasonType,
        reason: `Momentum/trend rebalance${weightNote} - ${ambiguous.action} outcome could not be confirmed: ${detail} Needs manual review.`,
        finalStatus: "error",
        signalStatus: "ready",
        executionStatus: "ambiguous",
        isSignalReady: true,
        executionBlockReasonCategory: "broker",
        executionBlockReasonCode: "ETF_ROTATION_ORDER_AMBIGUOUS",
        executionBlockReasonDetail: detail,
        executed: false,
        skippedReason: detail,
      };
    }

    // blocked
    const blockedOutcome = blocked!;
    const detail = blockedOutcome.blockReason ?? "Order blocked before submission.";
    return {
      ticker,
      timestamp,
      price,
      action: blockedOutcome.action,
      confidence: 0,
      suggestedShares: blockedOutcome.requestedQty,
      reasonType,
      reason: `Momentum/trend rebalance${weightNote} - ${blockedOutcome.action} not attempted: ${detail}`,
      finalStatus: "blocked",
      signalStatus: "blocked",
      executionStatus: "blocked",
      isSignalReady: false,
      executionBlockReasonCategory: "other",
      executionBlockReasonCode: "ETF_ROTATION_ORDER_BLOCKED",
      executionBlockReasonDetail: detail,
      executed: false,
      skippedReason: detail,
    };
  });
}
