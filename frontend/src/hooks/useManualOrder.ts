import { useState, type SyntheticEvent } from "react";

import { MANUAL_TRADING_ENABLED } from "../api/client";
import type { TradeResponse } from "../types";
import { getErrorMessage } from "../utils";

type FetchWithAdminSession = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;

type AddLog = (message: string) => void;
type RefreshDashboard = () => Promise<void>;

interface UseManualOrderOptions {
  addAutopilotLog: AddLog;
  fetchWithAdminSession: FetchWithAdminSession;
  refreshDashboard: RefreshDashboard;
}

export function useManualOrder({
  addAutopilotLog,
  fetchWithAdminSession,
  refreshDashboard,
}: UseManualOrderOptions) {
  const [tradeTicker, setTradeTicker] = useState("");
  const [tradeAction, setTradeAction] = useState<"BUY" | "SELL">("BUY");
  const [tradeQty, setTradeQty] = useState(1);
  const [tradeType, setTradeType] = useState("market");
  const [tradeLimitPrice, setTradeLimitPrice] = useState("");
  const [tradeSL, setTradeSL] = useState("");
  const [tradeTP, setTradeTP] = useState("");

  async function executeManualTrade(event: SyntheticEvent) {
    event.preventDefault();

    if (!MANUAL_TRADING_ENABLED) {
      alert("Manual trades are disabled by UI safety lock.");
      return;
    }

    if (!tradeTicker.trim()) return;

    try {
      const response = await fetchWithAdminSession("/api/trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker: tradeTicker,
          action: tradeAction,
          shares: tradeQty,
          orderType: tradeType,
          limitPrice: tradeLimitPrice
            ? Number.parseFloat(tradeLimitPrice)
            : undefined,
          stopLoss: tradeSL ? Number.parseFloat(tradeSL) : undefined,
          takeProfit: tradeTP ? Number.parseFloat(tradeTP) : undefined,
        }),
      });

      const result = (await response.json()) as TradeResponse;
      if (!response.ok || !result.success) {
        throw new Error(result.error || "Trade rejected.");
      }

      addAutopilotLog(
        `Manual order accepted: ${tradeAction} ${tradeQty} ${tradeTicker}.`,
      );
      setTradeTicker("");
      setTradeSL("");
      setTradeTP("");
      await refreshDashboard();
    } catch (error) {
      alert(`Trade failed: ${getErrorMessage(error)}`);
    }
  }

  return {
    manualTradingEnabled: MANUAL_TRADING_ENABLED,
    tradeTicker,
    setTradeTicker,
    tradeAction,
    setTradeAction,
    tradeQty,
    setTradeQty,
    tradeType,
    setTradeType,
    tradeLimitPrice,
    setTradeLimitPrice,
    tradeSL,
    setTradeSL,
    tradeTP,
    setTradeTP,
    executeManualTrade,
  };
}
