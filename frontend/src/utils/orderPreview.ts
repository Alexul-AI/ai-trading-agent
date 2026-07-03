import type { AutopilotDecision, AutopilotStatus } from "../types";

export type BrokerOrderSide = "buy" | "sell";

export interface SafeTradeCallPreview {
  function: "executeSafeTrade";
  ticker: string;
  action: AutopilotDecision["action"];
  requestedShares: number;
  orderType: "market";
  limitPrice: null;
  stopLoss: number | null;
  takeProfit: number | null;
}

export interface BrokerStylePayloadPreview {
  symbol: string;
  side: BrokerOrderSide | null;
  qty: number;
  type: "market";
  time_in_force: "day";
  extended_hours: false;
}

export interface OrderPreviewPlan {
  gate: "WOULD_SUBMIT_PAPER_ORDER" | "BLOCKED";
  willSubmit: boolean;
  blockedBy: string[];
  estimatedNotional: number;
  safeTradeCall: SafeTradeCallPreview;
  brokerStylePayload: BrokerStylePayloadPreview;
}

function readConfigNumber(
  config: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
): number {
  const value = config?.[key];

  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toBrokerSide(
  action: AutopilotDecision["action"],
): BrokerOrderSide | null {
  if (action === "BUY") return "buy";
  if (action === "SELL") return "sell";

  return null;
}

export function buildOrderPreviewPlan(
  decision: AutopilotDecision | null,
  status: AutopilotStatus,
  signalIsStale: boolean,
): OrderPreviewPlan | null {
  if (!decision) return null;

  const side = toBrokerSide(decision.action);
  const stopLossPercent = readConfigNumber(
    status.strategyConfig,
    "stopLossPercent",
    0.08,
  );
  const takeProfitPercent = readConfigNumber(
    status.strategyConfig,
    "takeProfitPercent",
    0.15,
  );
  const stopLoss =
    decision.action === "BUY"
      ? Number((decision.price * (1 - stopLossPercent)).toFixed(2))
      : null;
  const takeProfit =
    decision.action === "BUY"
      ? Number((decision.price * (1 + takeProfitPercent)).toFixed(2))
      : null;

  const blockedBy: string[] = [];

  if (signalIsStale) blockedBy.push("STALE_SIGNAL");
  if (status.tradeMode !== "paper") blockedBy.push("NOT_PAPER_MODE");
  if (!status.executeTrades) blockedBy.push("DRY_RUN");
  if (decision.action === "BUY" && !status.allowBuy)
    blockedBy.push("BUY_DISABLED");
  if (decision.action === "SELL" && !status.allowSell) {
    blockedBy.push("SELL_DISABLED");
  }
  if (side === null) blockedBy.push("NOT_BUY_OR_SELL");
  if (decision.suggestedShares <= 0) blockedBy.push("NO_SHARES");

  const estimatedNotional = Number(
    (decision.price * decision.suggestedShares).toFixed(2),
  );

  return {
    gate: blockedBy.length === 0 ? "WOULD_SUBMIT_PAPER_ORDER" : "BLOCKED",
    willSubmit: blockedBy.length === 0,
    blockedBy,
    estimatedNotional,
    safeTradeCall: {
      function: "executeSafeTrade",
      ticker: decision.ticker,
      action: decision.action,
      requestedShares: decision.suggestedShares,
      orderType: "market",
      limitPrice: null,
      stopLoss,
      takeProfit,
    },
    brokerStylePayload: {
      symbol: decision.ticker,
      side,
      qty: decision.suggestedShares,
      type: "market",
      time_in_force: "day",
      extended_hours: false,
    },
  };
}
