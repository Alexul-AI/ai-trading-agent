import { useEffect, type Dispatch, type SetStateAction } from "react";

import { API_BASE_URL } from "../api/client";
import type { AutopilotStatus, SseEvent, TradeMode } from "../types";
import type { ConnectionStatus } from "./useDashboardData";

type AddLog = (message: string) => void;
type Refresh = () => Promise<void>;

interface UseAutopilotStreamOptions {
  addAutopilotLog: AddLog;
  setTradeMode: (tradeMode: TradeMode) => void;
  setAutopilotStatus: Dispatch<SetStateAction<AutopilotStatus>>;
  setConnectionStatus: Dispatch<SetStateAction<ConnectionStatus>>;
  refreshAutopilotStatus: Refresh;
  refreshAutopilotJournal: Refresh;
  refreshDashboard: Refresh;
}

export function useAutopilotStream({
  addAutopilotLog,
  setTradeMode,
  setAutopilotStatus,
  setConnectionStatus,
  refreshAutopilotStatus,
  refreshAutopilotJournal,
  refreshDashboard,
}: UseAutopilotStreamOptions) {
  useEffect(() => {
    const eventSource = new EventSource(`${API_BASE_URL}/api/stream`);

    eventSource.onopen = () => setConnectionStatus("connected");
    eventSource.onerror = () => setConnectionStatus("error");

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as SseEvent;

        if (data.type === "connected") {
          if (data.tradeMode) setTradeMode(data.tradeMode);
          if (data.autopilot) setAutopilotStatus(data.autopilot);
          addAutopilotLog("SSE connected.");
          return;
        }

        if (data.type === "autopilot_status") {
          addAutopilotLog(
            `Autopilot ${data.enabled ? "enabled" : "disabled"}.`,
          );
          void refreshAutopilotStatus();
          return;
        }

        if (data.type === "autopilot_worker_started") {
          addAutopilotLog(
            `Worker started (${data.executeTrades ? "execution" : "dry-run"}).`,
          );
          setAutopilotStatus((prev) => ({ ...prev, running: true }));
          return;
        }

        if (data.type === "autopilot_signal" && data.data) {
          const decision = data.data;
          addAutopilotLog(
            `${decision.ticker}: ${decision.action} ${decision.suggestedShares} / conf ${decision.confidence}.`,
          );
          setAutopilotStatus((prev) => ({
            ...prev,
            lastDecisions: [
              decision,
              ...prev.lastDecisions.filter(
                (existing) => existing.ticker !== decision.ticker,
              ),
            ],
          }));
          return;
        }

        if (data.type === "autopilot_worker_finished") {
          addAutopilotLog(
            `Worker finished. Signal-ready signals: ${data.signalReadyCount ?? 0}.`,
          );
          if (data.decisions) {
            setAutopilotStatus((prev) => ({
              ...prev,
              running: false,
              lastRunAt: data.timestamp ?? new Date().toISOString(),
              lastDecisions: data.decisions ?? prev.lastDecisions,
            }));
          } else {
            void refreshAutopilotStatus();
          }
          void refreshAutopilotJournal();
          return;
        }

        if (data.type === "autopilot_worker_error") {
          addAutopilotLog(`Worker error: ${data.message ?? "Unknown error"}.`);
          setAutopilotStatus((prev) => ({
            ...prev,
            running: false,
            lastError: data.message ?? "Unknown error",
          }));
          return;
        }

        if (data.type === "trade") {
          addAutopilotLog("Trade event received. Refreshing dashboard.");
          void refreshDashboard();
        }
      } catch (error) {
        console.error("SSE parse error:", error);
      }
    };

    return () => {
      eventSource.close();
    };
  }, [
    addAutopilotLog,
    refreshAutopilotJournal,
    refreshAutopilotStatus,
    refreshDashboard,
    setAutopilotStatus,
    setConnectionStatus,
    setTradeMode,
  ]);
}
