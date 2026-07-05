import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActionableSignalDebugPanel } from "./components/ActionableSignalDebugPanel";
import { AutopilotControlCenter } from "./components/AutopilotControlCenter";
import { AutopilotLogs } from "./components/AutopilotLogs";
import { ChatTerminal } from "./components/ChatTerminal";
import { DecisionJournalPanel } from "./components/DecisionJournalPanel";
import { ExecutionReadinessPanel } from "./components/ExecutionReadinessPanel";
import { LastAutopilotDecisions } from "./components/LastAutopilotDecisions";
import { StrategyComparisonPanel } from "./components/StrategyComparisonPanel";
import { StrategyConfigPanel } from "./components/StrategyConfigPanel";
import { StrategyQualityPanel } from "./components/StrategyQualityPanel";
import { SystemHealthBanner } from "./components/SystemHealthBanner";
import { TickerChartPanel } from "./components/TickerChartPanel";
import type {
  AutopilotRunResponse,
  AutopilotStatus,
  AutopilotToggleResponse,
  ChatMessage,
  ChatResponse,
  DashboardHealthSummary,
  DashboardResponse,
  JournalResponse,
  JournalRun,
  JournalSummary,
  Order,
  Portfolio,
  SseEvent,
  TradeMode,
  TradeResponse,
  WatchlistItem,
} from "./types";
import {
  actionPillClass,
  confidenceClass,
  formatMoney,
  formatPercent,
  getDecisionForTicker,
  getErrorMessage,
} from "./utils";
import { isSignalReadyDecision } from "./utils/signalReadiness";

const API_BASE_URL =
  window.location.hostname === "localhost"
    ? "http://localhost:3000"
    : "https://ai-trading-agent-i4nr.onrender.com";

const MANUAL_TRADING_ENABLED =
  import.meta.env.VITE_ALLOW_MANUAL_TRADES === "true";

const EMPTY_PORTFOLIO: Portfolio = {
  balance: 0,
  currency: "USD",
  positions: {},
};

const EMPTY_AUTOPILOT_STATUS: AutopilotStatus = {
  enabled: false,
  executeTrades: false,
  allowBuy: false,
  allowSell: false,
  tradeMode: "paper",
  running: false,
  intervalMs: 60000,
  tickers: [],
  minConfidence: 0.75,
  maxSellFraction: 0.25,
  telegramCooldownMinutes: 30,
  lastJournalRunId: null,
  lastRunAt: null,
  lastError: null,
  lastDecisions: [],
};

export default function App() {
  const [tradeMode, setTradeMode] = useState<TradeMode>("paper");
  const [portfolio, setPortfolio] = useState<Portfolio>(EMPTY_PORTFOLIO);
  const [orders, setOrders] = useState<Order[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [autopilotStatus, setAutopilotStatus] = useState<AutopilotStatus>(
    EMPTY_AUTOPILOT_STATUS,
  );
  const [journalRuns, setJournalRuns] = useState<JournalRun[]>([]);
  const [journalSummary, setJournalSummary] = useState<JournalSummary | null>(
    null,
  );
  const [journalFile, setJournalFile] = useState<string>("");
  const [isLoadingJournal, setIsLoadingJournal] = useState(false);
  const [autopilotLogs, setAutopilotLogs] = useState<string[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<
    "connecting" | "connected" | "error"
  >("connecting");
  const [dashboardHealth, setDashboardHealth] =
    useState<DashboardHealthSummary | null>(null);
  const [isRunningAutopilot, setIsRunningAutopilot] = useState(false);
  const [lastDashboardUpdate, setLastDashboardUpdate] = useState<string | null>(
    null,
  );

  const [chatInput, setChatInput] = useState("");
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([
    {
      id: "1",
      role: "agent",
      content:
        "Alexul-AI is online. Dashboard uses Alpaca as source of truth. Autopilot starts in dry-run mode and will not execute trades unless explicitly enabled on the backend.",
      timestamp: new Date().toLocaleTimeString(),
    },
  ]);
  const [isWaitingOnAI, setIsWaitingOnAI] = useState(false);

  const [tradeTicker, setTradeTicker] = useState("");
  const [tradeAction, setTradeAction] = useState<"BUY" | "SELL">("BUY");
  const [tradeQty, setTradeQty] = useState(1);
  const [tradeType, setTradeType] = useState("market");
  const [tradeLimitPrice, setTradeLimitPrice] = useState("");
  const [tradeSL, setTradeSL] = useState("");
  const [tradeTP, setTradeTP] = useState("");

  const chatEndRef = useRef<HTMLDivElement>(null);

  const autopilotEnabled = autopilotStatus.enabled;
  const latestDecisions = autopilotStatus.lastDecisions;
  const signalReadyDecisions = latestDecisions.filter((decision) =>
    isSignalReadyDecision(decision, autopilotStatus.minConfidence),
  );

  const addAutopilotLog = useCallback((message: string) => {
    setAutopilotLogs((prev) =>
      [`[${new Date().toLocaleTimeString()}] ${message}`, ...prev].slice(0, 80),
    );
  }, []);

  const applyDashboardData = useCallback((data: DashboardResponse) => {
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
  }, []);

  const refreshDashboard = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/dashboard`, {
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(`Dashboard request failed: ${response.status}`);
      const data = (await response.json()) as DashboardResponse;
      applyDashboardData(data);
      setConnectionStatus("connected");
    } catch (error) {
      setConnectionStatus("error");
      console.warn("Dashboard refresh failed:", error);
    }
  }, [applyDashboardData]);

  const refreshAutopilotStatus = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/autopilot/status`, {
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(`Autopilot status failed: ${response.status}`);
      const data = (await response.json()) as AutopilotStatus;
      setAutopilotStatus(data);
    } catch (error) {
      console.warn("Autopilot status refresh failed:", error);
    }
  }, []);

  const refreshAutopilotJournal = useCallback(async () => {
    setIsLoadingJournal(true);
    try {
      const [journalResponse, summaryResponse] = await Promise.all([
        fetch(`${API_BASE_URL}/api/autopilot/journal?limit=20`, {
          cache: "no-store",
        }),
        fetch(`${API_BASE_URL}/api/autopilot/journal/summary?limit=200`, {
          cache: "no-store",
        }),
      ]);
      if (!journalResponse.ok)
        throw new Error(`Journal request failed: ${journalResponse.status}`);
      if (!summaryResponse.ok)
        throw new Error(`Journal summary failed: ${summaryResponse.status}`);

      const journal = (await journalResponse.json()) as JournalResponse;
      const summary = (await summaryResponse.json()) as JournalSummary;

      setJournalRuns(journal.runs);
      setJournalFile(journal.file);
      setJournalSummary(summary);
    } catch (error) {
      addAutopilotLog(`Journal refresh failed: ${getErrorMessage(error)}`);
      console.warn("Autopilot journal refresh failed:", error);
    } finally {
      setIsLoadingJournal(false);
    }
  }, [addAutopilotLog]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory]);

  useEffect(() => {
    void refreshDashboard();
    void refreshAutopilotJournal();

    const dashboardTimer = window.setInterval(() => {
      void refreshDashboard();
    }, 5000);

    const journalTimer = window.setInterval(() => {
      void refreshAutopilotJournal();
    }, 15000);

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
      window.clearInterval(dashboardTimer);
      window.clearInterval(journalTimer);
      eventSource.close();
    };
  }, [
    addAutopilotLog,
    refreshAutopilotJournal,
    refreshAutopilotStatus,
    refreshDashboard,
  ]);

  async function loginWithPrompt(): Promise<boolean> {
    const password = window.prompt("Admin password");

    if (!password) {
      addAutopilotLog("Admin login cancelled.");
      return false;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password }),
      });

      if (!response.ok) {
        throw new Error(`Admin login failed: ${response.status}`);
      }

      addAutopilotLog("Admin session established.");
      return true;
    } catch (error) {
      addAutopilotLog(`Admin login failed: ${getErrorMessage(error)}`);
      return false;
    }
  }

  async function fetchWithAdminSession(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const requestInit: RequestInit = {
      ...init,
      credentials: "include",
    };

    let response = await fetch(`${API_BASE_URL}${path}`, requestInit);

    if (response.status !== 401) {
      return response;
    }

    addAutopilotLog("Admin session required.");
    const loggedIn = await loginWithPrompt();

    if (!loggedIn) {
      return response;
    }

    response = await fetch(`${API_BASE_URL}${path}`, requestInit);

    return response;
  }
  async function handleAutopilotToggle() {
    const targetState = !autopilotStatus.enabled;
    try {
      const response = await fetchWithAdminSession("/api/autopilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: targetState }),
      });
      if (!response.ok) throw new Error(`Toggle failed: ${response.status}`);
      const data = (await response.json()) as AutopilotToggleResponse;
      setAutopilotStatus(data.autopilot);
      addAutopilotLog(
        `Scheduled autopilot ${data.enabled ? "enabled" : "disabled"}.`,
      );
    } catch (error) {
      addAutopilotLog(`Toggle failed: ${getErrorMessage(error)}`);
    }
  }

  async function handleRunAutopilotOnce() {
    setIsRunningAutopilot(true);
    try {
      const response = await fetchWithAdminSession("/api/autopilot/run-once", {
        method: "POST",
      });
      if (!response.ok) throw new Error(`Run once failed: ${response.status}`);
      const data = (await response.json()) as AutopilotRunResponse;
      setAutopilotStatus(data.status);
      void refreshAutopilotJournal();

      if (data.skipped) {
        addAutopilotLog(data.reason ?? "Run skipped.");
      } else if (data.error) {
        addAutopilotLog(`Run failed: ${data.error}`);
      } else {
        const signalReadyCount =
          data.signalReadyCount ??
          (data.decisions ?? []).filter((decision) =>
            isSignalReadyDecision(decision, data.status.minConfidence),
          ).length;

        addAutopilotLog(
          `Manual dry-run completed. Signal-ready signals: ${signalReadyCount}.`,
        );
      }
    } catch (error) {
      addAutopilotLog(`Manual run failed: ${getErrorMessage(error)}`);
    } finally {
      setIsRunningAutopilot(false);
    }
  }

  async function handleSendMessage(event: React.SyntheticEvent) {
    event.preventDefault();
    if (!chatInput.trim() || isWaitingOnAI) return;

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: "user",
      content: chatInput,
      timestamp: new Date().toLocaleTimeString(),
    };

    setChatHistory((prev) => [...prev, userMsg]);
    setChatInput("");
    setIsWaitingOnAI(true);

    try {
      const response = await fetchWithAdminSession("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMsg.content,
          history: chatHistory.map((msg) => ({
            role: msg.role,
            content: msg.content,
          })),
        }),
      });

      if (!response.ok) throw new Error(`Chat failed: ${response.status}`);
      const data = (await response.json()) as ChatResponse;

      setChatHistory((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: "agent",
          content: data.reply || "Processing complete.",
          timestamp: new Date().toLocaleTimeString(),
        },
      ]);
    } catch (error) {
      setChatHistory((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          role: "agent",
          content: `API connection error: ${getErrorMessage(error)}`,
          timestamp: new Date().toLocaleTimeString(),
        },
      ]);
    } finally {
      setIsWaitingOnAI(false);
    }
  }

  async function executeManualTrade(event: React.SyntheticEvent) {
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
      if (!response.ok || !result.success)
        throw new Error(result.error || "Trade rejected.");

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

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {tradeMode === "live" ? (
        <div className="bg-gradient-to-r from-red-700 via-rose-700 to-red-700 text-white font-black text-center py-2 px-4 shadow-xl flex items-center justify-center gap-3 animate-pulse">
          WARNING: LIVE TRADING ENVIRONMENT â€” REAL CAPITAL RISK
        </div>
      ) : (
        <div className="bg-emerald-950/80 border-b border-emerald-500/30 text-emerald-300 font-medium text-center py-1 px-4 text-xs tracking-wider flex items-center justify-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
          PAPER MODE â€” ALPACA SIMULATED TRADING
        </div>
      )}

      <header className="px-6 py-4 border-b border-slate-800 bg-slate-900/40 flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex items-center gap-4">
          <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-300 border border-blue-500/30">
            <svg
              className="w-7 h-7"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M13 10V3L4 14h7v7l9-11h-7z"
              />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-extrabold tracking-tight flex items-center gap-2">
              Alexul-AI Hub
              <span
                className={`text-xs px-2.5 py-0.5 rounded-full uppercase tracking-widest border font-semibold ${
                  tradeMode === "live"
                    ? "bg-red-500/20 text-red-300 border-red-500/50"
                    : "bg-emerald-500/20 text-emerald-300 border-emerald-500/50"
                }`}
              >
                {tradeMode}
              </span>
            </h1>
            <p className="text-xs text-slate-400">
              Alpaca-powered trading dashboard with safe Autopilot dry-run layer
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px]">
          <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2">
            <div className="text-slate-500 font-black uppercase">
              Connection
            </div>
            <div
              className={`font-bold ${
                connectionStatus === "connected"
                  ? "text-emerald-300"
                  : connectionStatus === "connecting"
                    ? "text-amber-300"
                    : "text-rose-300"
              }`}
            >
              {connectionStatus.toUpperCase()}
            </div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2">
            <div className="text-slate-500 font-black uppercase">Autopilot</div>
            <div
              className={
                autopilotEnabled
                  ? "text-emerald-300 font-bold"
                  : "text-slate-400 font-bold"
              }
            >
              {autopilotEnabled ? "SCHEDULED ON" : "SCHEDULED OFF"}
            </div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2">
            <div className="text-slate-500 font-black uppercase">Execution</div>
            <div
              className={
                autopilotStatus.executeTrades
                  ? "text-rose-300 font-bold"
                  : "text-blue-300 font-bold"
              }
            >
              {autopilotStatus.executeTrades ? "ENABLED" : "DRY-RUN"}
            </div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2">
            <div className="text-slate-500 font-black uppercase">
              Last Update
            </div>
            <div className="text-slate-300 font-bold">
              {lastDashboardUpdate ?? "â€”"}
            </div>
          </div>
        </div>
      </header>

      <SystemHealthBanner health={dashboardHealth} />

      <main className="flex-1 grid grid-cols-1 xl:grid-cols-12 p-6 gap-6">
        <section className="xl:col-span-3 flex flex-col gap-6">
          <div className="bg-slate-900/60 rounded-2xl border border-slate-800 p-4 flex flex-col min-h-[320px]">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold tracking-wider text-slate-400">
                WATCHLIST
              </h2>
              <span className="text-[10px] bg-slate-800 text-slate-400 px-2 py-0.5 rounded">
                Alpaca
              </span>
            </div>

            <div className="space-y-2 overflow-y-auto pr-1">
              {watchlist.length === 0 ? (
                <div className="text-center text-slate-500 py-12 text-xs">
                  No watchlist data yet.
                </div>
              ) : (
                watchlist.map((item) => {
                  const decision = getDecisionForTicker(
                    latestDecisions,
                    item.ticker,
                  );
                  return (
                    <div
                      key={item.ticker}
                      className="p-3 rounded-xl bg-slate-950/40 hover:bg-slate-950 border border-slate-800/40 transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="font-bold text-sm tracking-wide">
                            {item.ticker}
                          </div>
                          <div className="text-[10px] text-slate-500 truncate max-w-[130px]">
                            {item.name}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-mono text-xs font-semibold">
                            {formatMoney(item.price)}
                          </div>
                          <div
                            className={`text-[10px] font-bold ${item.isUp ? "text-emerald-400" : "text-rose-400"}`}
                          >
                            {item.isUp ? "â–²" : "â–¼"}{" "}
                            {formatPercent(item.change)}
                          </div>
                        </div>
                      </div>

                      {decision && (
                        <div className="mt-2 flex items-center justify-between gap-2">
                          <span
                            className={`px-2 py-0.5 rounded-full border text-[10px] font-black ${actionPillClass(decision.action)}`}
                          >
                            {decision.action}
                          </span>
                          <span
                            className={`text-[10px] font-mono ${confidenceClass(decision.confidence)}`}
                          >
                            conf {decision.confidence}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="bg-slate-900/60 rounded-2xl border border-slate-800 p-4">
            <h2 className="text-sm font-bold tracking-wider text-slate-400 mb-3 flex items-center justify-between">
              MANUAL ORDER
              <span
                className={`w-2 h-2 rounded-full ${tradeMode === "live" ? "bg-red-500" : "bg-emerald-500"}`}
              />
            </h2>

            {!MANUAL_TRADING_ENABLED && (
              <div className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                Manual order entry is disabled by default. RUN ONCE and journal
                analysis stay enabled.
              </div>
            )}

            <form onSubmit={executeManualTrade} className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setTradeAction("BUY")}
                  className={`py-1.5 rounded-lg text-xs font-bold transition-all ${
                    tradeAction === "BUY"
                      ? "bg-emerald-600/20 text-emerald-300 border border-emerald-500/40"
                      : "bg-slate-950 text-slate-500 border border-transparent"
                  }`}
                >
                  BUY
                </button>
                <button
                  type="button"
                  onClick={() => setTradeAction("SELL")}
                  className={`py-1.5 rounded-lg text-xs font-bold transition-all ${
                    tradeAction === "SELL"
                      ? "bg-rose-600/20 text-rose-300 border border-rose-500/40"
                      : "bg-slate-950 text-slate-500 border border-transparent"
                  }`}
                >
                  SELL
                </button>
              </div>

              <input
                type="text"
                required
                placeholder="Ticker, e.g. AMD"
                value={tradeTicker}
                onChange={(event) =>
                  setTradeTicker(event.target.value.toUpperCase())
                }
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-slate-600"
              />

              <div className="grid grid-cols-2 gap-2">
                <input
                  type="number"
                  min="1"
                  required
                  value={tradeQty}
                  onChange={(event) =>
                    setTradeQty(
                      Math.max(1, Number.parseInt(event.target.value) || 1),
                    )
                  }
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-slate-600"
                />
                <select
                  value={tradeType}
                  onChange={(event) => setTradeType(event.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-2 text-xs text-white focus:outline-none focus:border-slate-600"
                >
                  <option value="market">Market</option>
                  <option value="limit">Limit</option>
                </select>
              </div>

              {tradeType === "limit" && (
                <input
                  type="number"
                  step="0.01"
                  placeholder="Limit price"
                  value={tradeLimitPrice}
                  onChange={(event) => setTradeLimitPrice(event.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none"
                />
              )}

              {tradeAction === "BUY" && (
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    step="0.01"
                    placeholder="Stop loss"
                    value={tradeSL}
                    onChange={(event) => setTradeSL(event.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none"
                  />
                  <input
                    type="number"
                    step="0.01"
                    placeholder="Take profit"
                    value={tradeTP}
                    onChange={(event) => setTradeTP(event.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none"
                  />
                </div>
              )}

              <button
                type="submit"
                disabled={!MANUAL_TRADING_ENABLED}
                className={`w-full py-2 rounded-xl font-bold text-xs tracking-wider transition-all disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500 ${
                  tradeMode === "live"
                    ? "bg-red-700 hover:bg-red-600 text-white"
                    : "bg-blue-600 hover:bg-blue-500 text-white"
                }`}
              >
                {MANUAL_TRADING_ENABLED
                  ? `SUBMIT ${tradeAction}`
                  : "MANUAL TRADING DISABLED"}
              </button>
            </form>
          </div>
        </section>

        <section className="xl:col-span-5 flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-slate-900/60 rounded-2xl border border-slate-800 p-4">
              <span className="text-[10px] font-bold tracking-wider text-slate-500 block">
                EQUITY
              </span>
              <span className="text-2xl font-black font-mono text-white block mt-1">
                {formatMoney(portfolio.equity ?? portfolio.balance)}
              </span>
              <span className="text-[10px] text-slate-500">
                Cash: {formatMoney(portfolio.balance)}
              </span>
            </div>

            <div className="bg-slate-900/60 rounded-2xl border border-slate-800 p-4">
              <span className="text-[10px] font-bold tracking-wider text-slate-500 block">
                EXPOSURE
              </span>
              <span className="text-2xl font-black font-mono text-blue-300 block mt-1">
                {Object.keys(portfolio.positions).length} Assets
              </span>
              <span className="text-[10px] text-slate-500">
                Orders: {orders.length}
              </span>
            </div>
          </div>

          <div className="bg-slate-900/60 rounded-2xl border border-slate-800 p-4 flex-1 flex flex-col min-h-[260px]">
            <h2 className="text-sm font-bold tracking-wider text-slate-400 mb-3">
              ACTIVE POSITIONS
            </h2>

            <div className="space-y-2 overflow-y-auto pr-1">
              {Object.keys(portfolio.positions).length === 0 ? (
                <div className="text-center text-slate-500 py-16 text-xs">
                  No open positions.
                </div>
              ) : (
                Object.entries(portfolio.positions).map(([symbol, data]) => {
                  const shares = data.shares;
                  const avgPrice = data.avgPrice;
                  const currentPrice = data.currentPrice ?? avgPrice;
                  const marketValue = shares * currentPrice;
                  const pnl = data.pnl ?? 0;
                  const pnlPct = data.pnlPercent ?? 0;
                  const isGain = pnl >= 0;
                  const decision = getDecisionForTicker(
                    latestDecisions,
                    symbol,
                  );

                  return (
                    <div
                      key={symbol}
                      className="p-3.5 rounded-xl bg-slate-950/40 border border-slate-800/60 hover:bg-slate-950/80 transition-colors"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-extrabold text-sm tracking-wide">
                            {symbol}
                          </div>
                          <div className="text-[10px] text-slate-500">
                            {shares} shares @ avg {formatMoney(avgPrice)}
                          </div>
                          {decision && (
                            <div className="mt-2 flex items-center gap-2">
                              <span
                                className={`px-2 py-0.5 rounded-full border text-[10px] font-black ${actionPillClass(decision.action)}`}
                              >
                                {decision.action}
                              </span>
                              {decision.safetyNote && (
                                <span className="text-[10px] text-amber-300">
                                  safety cap active
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="text-right">
                          <div className="font-mono text-xs font-bold">
                            {formatMoney(marketValue)}
                          </div>
                          <div
                            className={`text-[10px] font-black ${isGain ? "text-emerald-400" : "text-rose-400"}`}
                          >
                            {isGain ? "â–²" : "â–¼"}{" "}
                            {formatMoney(Math.abs(pnl))} (
                            {formatPercent(pnlPct)})
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="bg-slate-900/60 rounded-2xl border border-slate-800 p-4 h-[210px] flex flex-col">
            <h2 className="text-sm font-bold tracking-wider text-slate-400 mb-2">
              OPEN / PROTECTION ORDERS
            </h2>
            <div className="flex-1 overflow-y-auto pr-1">
              {orders.length === 0 ? (
                <div className="text-center text-slate-500 py-8 text-xs">
                  No pending orders.
                </div>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-800/40 text-slate-500 text-[10px] uppercase font-bold">
                      <th className="pb-2">Symbol</th>
                      <th className="pb-2">Side</th>
                      <th className="pb-2 text-right">Price</th>
                      <th className="pb-2 text-right">Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((order) => (
                      <tr
                        key={order.id}
                        className="border-b border-slate-800/20 last:border-0"
                      >
                        <td className="py-2.5 font-bold">{order.ticker}</td>
                        <td className="py-2.5">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-extrabold ${order.action === "BUY" ? "bg-emerald-500/10 text-emerald-300" : "bg-rose-500/10 text-rose-300"}`}
                          >
                            {order.action}
                          </span>
                        </td>
                        <td className="py-2.5 text-right font-mono text-slate-300">
                          {order.limitPrice
                            ? formatMoney(order.limitPrice)
                            : "Market"}
                        </td>
                        <td className="py-2.5 text-right font-mono text-slate-400">
                          {order.qty}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <TickerChartPanel
            apiBaseUrl={API_BASE_URL}
            watchlist={watchlist}
            positions={portfolio.positions}
            latestDecisions={latestDecisions}
            journalRuns={journalRuns}
            minConfidence={autopilotStatus.minConfidence}
          />
        </section>

        <section className="xl:col-span-4 flex flex-col gap-6">
          <AutopilotControlCenter
            autopilotStatus={autopilotStatus}
            autopilotEnabled={autopilotEnabled}
            isRunningAutopilot={isRunningAutopilot}
            onRunOnce={handleRunAutopilotOnce}
            onToggleScheduled={handleAutopilotToggle}
          />

          <DecisionJournalPanel
            journalFile={journalFile}
            journalRuns={journalRuns}
            journalSummary={journalSummary}
            isLoadingJournal={isLoadingJournal}
            onRefresh={refreshAutopilotJournal}
          />

          <ExecutionReadinessPanel
            autopilotStatus={autopilotStatus}
            dashboardHealth={dashboardHealth}
            latestDecisions={latestDecisions}
          />

          <StrategyQualityPanel
            journalRuns={journalRuns}
            minConfidence={autopilotStatus.minConfidence}
          />

          <StrategyComparisonPanel
            journalRuns={journalRuns}
            minConfidence={autopilotStatus.minConfidence}
            liveStrategyVersion={autopilotStatus.strategyVersion}
            liveStrategyConfigHash={autopilotStatus.strategyConfigHash}
          />

          <ActionableSignalDebugPanel
            journalRuns={journalRuns}
            minConfidence={autopilotStatus.minConfidence}
            liveStrategyVersion={autopilotStatus.strategyVersion}
            liveStrategyConfigHash={autopilotStatus.strategyConfigHash}
          />

          <StrategyConfigPanel
            autopilotStatus={autopilotStatus}
            journalRuns={journalRuns}
          />

          <LastAutopilotDecisions
            latestDecisions={latestDecisions}
            signalReadyCount={signalReadyDecisions.length}
          />

          <ChatTerminal
            chatHistory={chatHistory}
            chatInput={chatInput}
            isWaitingOnAI={isWaitingOnAI}
            chatEndRef={chatEndRef}
            onInputChange={setChatInput}
            onSendMessage={handleSendMessage}
          />

          <AutopilotLogs logs={autopilotLogs} />
        </section>
      </main>
    </div>
  );
}
