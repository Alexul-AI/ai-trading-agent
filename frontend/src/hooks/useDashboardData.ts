import {
  useCallback,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import { API_BASE_URL } from "../api/client";
import type {
  AutopilotStatus,
  DashboardHealthSummary,
  DashboardResponse,
  Order,
  Portfolio,
  TradeMode,
  WatchlistItem,
} from "../types";

export type ConnectionStatus = "connecting" | "connected" | "error";

const EMPTY_PORTFOLIO: Portfolio = {
  balance: 0,
  currency: "USD",
  positions: {},
};

export function useDashboardData(
  setAutopilotStatus: Dispatch<SetStateAction<AutopilotStatus>>,
) {
  const [tradeMode, setTradeMode] = useState<TradeMode>("paper");
  const [portfolio, setPortfolio] = useState<Portfolio>(EMPTY_PORTFOLIO);
  const [orders, setOrders] = useState<Order[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [dashboardHealth, setDashboardHealth] =
    useState<DashboardHealthSummary | null>(null);
  const [lastDashboardUpdate, setLastDashboardUpdate] = useState<string | null>(
    null,
  );

  const applyDashboardData = useCallback(
    (data: DashboardResponse) => {
      if (data.health) setDashboardHealth(data.health);
      if (data.tradeMode) setTradeMode(data.tradeMode);
      if (data.portfolio) setPortfolio(data.portfolio);
      if (data.orders) setOrders(data.orders);
      if (data.watchlist) setWatchlist(data.watchlist);
      if (data.autopilot) {
        setAutopilotStatus(data.autopilot);
      } else if (typeof data.autopilotEnabled === "boolean") {
        setAutopilotStatus((prev) => ({
          ...prev,
          enabled: data.autopilotEnabled ?? prev.enabled,
        }));
      }
      setLastDashboardUpdate(new Date().toLocaleTimeString());
    },
    [setAutopilotStatus],
  );

  const refreshDashboard = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/dashboard`, {
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error(`Dashboard request failed: ${response.status}`);
      }

      const data = (await response.json()) as DashboardResponse;
      applyDashboardData(data);
      setConnectionStatus("connected");
    } catch (error) {
      setConnectionStatus("error");
      console.warn("Dashboard refresh failed:", error);
    }
  }, [applyDashboardData]);

  return {
    tradeMode,
    setTradeMode,
    portfolio,
    orders,
    watchlist,
    connectionStatus,
    setConnectionStatus,
    dashboardHealth,
    lastDashboardUpdate,
    refreshDashboard,
  };
}
