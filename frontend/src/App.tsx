import React, { useEffect, useRef, useState } from "react";

const API_BASE_URL =
  window.location.hostname === "localhost"
    ? "http://localhost:3000"
    : "https://ai-trading-agent-i4nr.onrender.com";

type TradeMode = "paper" | "live";
type SignalAction = "BUY" | "SELL" | "HOLD";
type ReasonType =
  | "BUY_SIGNAL"
  | "SELL_SIGNAL"
  | "STOP_LOSS"
  | "TAKE_PROFIT"
  | "NO_SIGNAL"
  | "RISK_LIMIT";

interface Position {
  shares: number;
  avgPrice: number;
  currentPrice?: number;
  pnl?: number;
  pnlPercent?: number;
}

interface Portfolio {
  balance: number;
  equity?: number;
  currency: string;
  positions: Record<string, Position>;
}

interface Order {
  id: string;
  ticker: string;
  action: string;
  qty: number;
  orderType: string;
  limitPrice: number | null;
  status: string;
}

interface WatchlistItem {
  ticker: string;
  name: string;
  price: number;
  change: number;
  isUp: boolean;
}

interface ChatMessage {
  id: string;
  role: "user" | "agent";
  content: string;
  timestamp: string;
}

interface AutopilotDecision {
  ticker: string;
  timestamp: string;
  price: number;
  rsi: number;
  macdHistogram: number;
  previousMacdHistogram: number;
  bollingerLower: number;
  bollingerUpper: number;
  action: SignalAction;
  confidence: number;
  suggestedShares: number;
  originalSuggestedShares?: number;
  reasonType: ReasonType;
  reason: string;
  safetyNote?: string;
  executed: boolean;
  skippedReason?: string;
}

interface AutopilotStatus {
  enabled: boolean;
  executeTrades: boolean;
  allowBuy: boolean;
  allowSell: boolean;
  tradeMode: TradeMode;
  running: boolean;
  intervalMs: number;
  tickers: string[];
  minConfidence: number;
  maxSellFraction: number;
  telegramCooldownMinutes: number;
  lastJournalRunId?: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  lastDecisions: AutopilotDecision[];
}

interface JournalRun {
  id: string;
  timestamp: string;
  trigger: "manual" | "scheduled";
  executeTrades: boolean;
  tradeMode: TradeMode;
  enabled: boolean;
  tickers: string[];
  actionableCount: number;
  decisions: AutopilotDecision[];
}

interface JournalResponse {
  file: string;
  runs: JournalRun[];
}

interface JournalSummary {
  totalRuns: number;
  totalDecisions: number;
  actionableSignals: number;
  executedSignals: number;
  byAction: Record<string, number>;
  byTicker: Record<string, number>;
  byReasonType: Record<string, number>;
  lastRunAt: string | null;
}

interface DashboardResponse {
  tradeMode?: TradeMode;
  autopilotEnabled?: boolean;
  autopilot?: AutopilotStatus;
  portfolio?: Portfolio;
  orders?: Order[];
  watchlist?: WatchlistItem[];
}

interface AutopilotRunResponse {
  skipped: boolean;
  reason?: string;
  decisions?: AutopilotDecision[];
  status: AutopilotStatus;
  error?: string;
}

interface AutopilotToggleResponse {
  success: boolean;
  enabled: boolean;
  autopilot: AutopilotStatus;
}

interface ChatResponse {
  reply?: string;
}

interface TradeResponse {
  success?: boolean;
  error?: string;
  result?: unknown;
}

interface SseEvent {
  type?: string;
  tradeMode?: TradeMode;
  autopilot?: AutopilotStatus;
  enabled?: boolean;
  executeTrades?: boolean;
  message?: string;
  data?: AutopilotDecision;
  decisions?: AutopilotDecision[];
  actionableCount?: number;
  timestamp?: string;
}

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

function formatMoney(value: number | undefined): string {
  const safeValue = Number.isFinite(value) ? (value ?? 0) : 0;
  return safeValue.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPercent(value: number | undefined): string {
  const safeValue = Number.isFinite(value) ? (value ?? 0) : 0;
  return `${safeValue >= 0 ? "+" : ""}${safeValue.toFixed(2)}%`;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString();
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

function actionPillClass(action: SignalAction): string {
  if (action === "BUY")
    return "bg-emerald-500/10 text-emerald-300 border-emerald-500/30";
  if (action === "SELL")
    return "bg-rose-500/10 text-rose-300 border-rose-500/30";
  return "bg-slate-800 text-slate-400 border-slate-700";
}

function confidenceClass(confidence: number): string {
  if (confidence >= 0.75) return "text-emerald-300";
  if (confidence >= 0.55) return "text-amber-300";
  return "text-slate-400";
}

function getDecisionForTicker(
  decisions: AutopilotDecision[],
  ticker: string,
): AutopilotDecision | undefined {
  return decisions.find((decision) => decision.ticker === ticker);
}

function getActionCount(
  summary: JournalSummary | null,
  action: SignalAction,
): number {
  return summary?.byAction?.[action] ?? 0;
}

function getTopTicker(summary: JournalSummary | null): string {
  if (!summary || Object.keys(summary.byTicker).length === 0) return "—";
  return (
    Object.entries(summary.byTicker).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—"
  );
}

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
  const actionableDecisions = latestDecisions.filter(
    (decision) =>
      decision.action !== "HOLD" &&
      decision.confidence >= autopilotStatus.minConfidence,
  );

  function addAutopilotLog(message: string) {
    setAutopilotLogs((prev) =>
      [`[${new Date().toLocaleTimeString()}] ${message}`, ...prev].slice(0, 80),
    );
  }

  function applyDashboardData(data: DashboardResponse) {
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
  }

  async function refreshDashboard() {
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
  }

  async function refreshAutopilotStatus() {
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
  }

  async function refreshAutopilotJournal() {
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
  }

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
            `Worker finished. Actionable signals: ${data.actionableCount ?? 0}.`,
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
  }, []);

  async function handleAutopilotToggle() {
    const targetState = !autopilotStatus.enabled;
    try {
      const response = await fetch(`${API_BASE_URL}/api/autopilot`, {
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
      const response = await fetch(`${API_BASE_URL}/api/autopilot/run-once`, {
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
        const actionableCount = (data.decisions ?? []).filter(
          (decision) =>
            decision.action !== "HOLD" &&
            decision.confidence >= data.status.minConfidence,
        ).length;
        addAutopilotLog(
          `Manual dry-run completed. Actionable signals: ${actionableCount}.`,
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
      const response = await fetch(`${API_BASE_URL}/api/chat`, {
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
    if (!tradeTicker.trim()) return;

    try {
      const response = await fetch(`${API_BASE_URL}/api/trade`, {
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
          WARNING: LIVE TRADING ENVIRONMENT — REAL CAPITAL RISK
        </div>
      ) : (
        <div className="bg-emerald-950/80 border-b border-emerald-500/30 text-emerald-300 font-medium text-center py-1 px-4 text-xs tracking-wider flex items-center justify-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
          PAPER MODE — ALPACA SIMULATED TRADING
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
              {lastDashboardUpdate ?? "—"}
            </div>
          </div>
        </div>
      </header>

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
                            {item.isUp ? "▲" : "▼"} {formatPercent(item.change)}
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
                className={`w-full py-2 rounded-xl font-bold text-xs tracking-wider transition-all ${
                  tradeMode === "live"
                    ? "bg-red-700 hover:bg-red-600 text-white"
                    : "bg-blue-600 hover:bg-blue-500 text-white"
                }`}
              >
                SUBMIT {tradeAction}
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
                            {isGain ? "▲" : "▼"} {formatMoney(Math.abs(pnl))} (
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
        </section>

        <section className="xl:col-span-4 flex flex-col gap-6">
          <div className="bg-slate-900/60 rounded-2xl border border-slate-800 p-4">
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <h2 className="text-sm font-bold tracking-wider text-slate-300">
                  AUTOPILOT CONTROL CENTER
                </h2>
                <p className="text-[10px] text-slate-500">
                  Shared strategyEngine, Alpaca bars, safety layer active
                </p>
              </div>
              <span
                className={`px-2 py-1 rounded-full border text-[10px] font-black ${autopilotStatus.running ? "bg-amber-500/10 text-amber-300 border-amber-500/30" : "bg-slate-950 text-slate-400 border-slate-800"}`}
              >
                {autopilotStatus.running ? "RUNNING" : "IDLE"}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 mb-4 text-[10px]">
              <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-3">
                <div className="text-slate-500 font-black uppercase">
                  Execution
                </div>
                <div
                  className={
                    autopilotStatus.executeTrades
                      ? "text-rose-300 font-bold"
                      : "text-blue-300 font-bold"
                  }
                >
                  {autopilotStatus.executeTrades
                    ? "CAN EXECUTE"
                    : "DRY-RUN ONLY"}
                </div>
              </div>
              <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-3">
                <div className="text-slate-500 font-black uppercase">
                  Buy / Sell
                </div>
                <div className="text-slate-300 font-bold">
                  BUY {autopilotStatus.allowBuy ? "ON" : "OFF"} · SELL{" "}
                  {autopilotStatus.allowSell ? "ON" : "OFF"}
                </div>
              </div>
              <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-3">
                <div className="text-slate-500 font-black uppercase">
                  Min Confidence
                </div>
                <div className="text-emerald-300 font-bold">
                  {autopilotStatus.minConfidence}
                </div>
              </div>
              <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-3">
                <div className="text-slate-500 font-black uppercase">
                  Max Sell
                </div>
                <div className="text-amber-300 font-bold">
                  {Math.round(autopilotStatus.maxSellFraction * 100)}% per
                  signal
                </div>
              </div>
            </div>

            <div className="flex gap-2 mb-4">
              <button
                onClick={handleRunAutopilotOnce}
                disabled={isRunningAutopilot}
                className="flex-1 px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-500 text-white font-bold text-xs transition-colors"
              >
                {isRunningAutopilot ? "RUNNING..." : "RUN ONCE"}
              </button>
              <button
                onClick={handleAutopilotToggle}
                className={`flex-1 px-3 py-2 rounded-xl font-bold text-xs transition-colors ${autopilotEnabled ? "bg-emerald-600 hover:bg-emerald-500 text-white" : "bg-slate-800 hover:bg-slate-700 text-slate-300"}`}
              >
                {autopilotEnabled ? "SCHEDULED ON" : "SCHEDULED OFF"}
              </button>
            </div>

            <div className="flex items-center justify-between text-[10px] text-slate-500 border-t border-slate-800 pt-3">
              <span>
                Last run: {formatTimestamp(autopilotStatus.lastRunAt)}
              </span>
              <span>
                Telegram cooldown: {autopilotStatus.telegramCooldownMinutes}m
              </span>
            </div>

            {autopilotStatus.lastError && (
              <div className="mt-3 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
                {autopilotStatus.lastError}
              </div>
            )}
          </div>

          <div className="bg-slate-900/60 rounded-2xl border border-slate-800 p-4">
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <h2 className="text-sm font-bold tracking-wider text-slate-300">
                  DECISION JOURNAL
                </h2>
                <p className="text-[10px] text-slate-500 truncate max-w-[300px]">
                  {journalFile || "backend/data/autopilot-decisions.jsonl"}
                </p>
              </div>
              <button
                onClick={refreshAutopilotJournal}
                disabled={isLoadingJournal}
                className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:text-slate-600 text-[10px] font-black text-slate-300"
              >
                {isLoadingJournal ? "LOADING" : "REFRESH"}
              </button>
            </div>

            <div className="grid grid-cols-4 gap-2 mb-4">
              <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-2">
                <div className="text-[9px] text-slate-500 font-black uppercase">
                  Runs
                </div>
                <div className="text-lg font-black text-white">
                  {journalSummary?.totalRuns ?? 0}
                </div>
              </div>
              <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-2">
                <div className="text-[9px] text-slate-500 font-black uppercase">
                  Signals
                </div>
                <div className="text-lg font-black text-amber-300">
                  {journalSummary?.actionableSignals ?? 0}
                </div>
              </div>
              <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-2">
                <div className="text-[9px] text-slate-500 font-black uppercase">
                  Executed
                </div>
                <div className="text-lg font-black text-emerald-300">
                  {journalSummary?.executedSignals ?? 0}
                </div>
              </div>
              <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-2">
                <div className="text-[9px] text-slate-500 font-black uppercase">
                  Top
                </div>
                <div className="text-lg font-black text-blue-300">
                  {getTopTicker(journalSummary)}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 mb-4 text-[10px]">
              <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-2">
                <span className="text-emerald-300 font-black">BUY</span>
                <span className="float-right font-mono">
                  {getActionCount(journalSummary, "BUY")}
                </span>
              </div>
              <div className="rounded-lg bg-rose-500/10 border border-rose-500/20 p-2">
                <span className="text-rose-300 font-black">SELL</span>
                <span className="float-right font-mono">
                  {getActionCount(journalSummary, "SELL")}
                </span>
              </div>
              <div className="rounded-lg bg-slate-950/60 border border-slate-800 p-2">
                <span className="text-slate-400 font-black">HOLD</span>
                <span className="float-right font-mono">
                  {getActionCount(journalSummary, "HOLD")}
                </span>
              </div>
            </div>

            <div className="space-y-2 max-h-[240px] overflow-y-auto pr-1">
              {journalRuns.length === 0 ? (
                <div className="text-center text-slate-600 py-8 text-xs">
                  No journal runs yet. Press RUN ONCE.
                </div>
              ) : (
                journalRuns.map((run) => {
                  const buyCount = run.decisions.filter(
                    (decision) => decision.action === "BUY",
                  ).length;
                  const sellCount = run.decisions.filter(
                    (decision) => decision.action === "SELL",
                  ).length;
                  const holdCount = run.decisions.filter(
                    (decision) => decision.action === "HOLD",
                  ).length;
                  const strongestDecision = [...run.decisions].sort(
                    (a, b) => b.confidence - a.confidence,
                  )[0];

                  return (
                    <div
                      key={run.id}
                      className="rounded-xl border border-slate-800 bg-slate-950/50 p-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-black text-white">
                              {formatTimestamp(run.timestamp)}
                            </span>
                            <span className="px-1.5 py-0.5 rounded bg-slate-800 text-[9px] font-black text-slate-400 uppercase">
                              {run.trigger}
                            </span>
                            <span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-[9px] font-black text-blue-300 uppercase">
                              {run.executeTrades ? "execution" : "dry-run"}
                            </span>
                          </div>
                          <div className="mt-1 text-[10px] text-slate-500">
                            BUY {buyCount} · SELL {sellCount} · HOLD {holdCount}
                          </div>
                        </div>

                        <div className="text-right">
                          <div className="text-xs font-black text-amber-300">
                            {run.actionableCount}
                          </div>
                          <div className="text-[9px] text-slate-500 uppercase">
                            actionable
                          </div>
                        </div>
                      </div>

                      {strongestDecision && (
                        <div className="mt-2 rounded-lg bg-slate-900/60 border border-slate-800 p-2 text-[10px]">
                          <span
                            className={`px-1.5 py-0.5 rounded-full border font-black mr-2 ${actionPillClass(strongestDecision.action)}`}
                          >
                            {strongestDecision.ticker}{" "}
                            {strongestDecision.action}
                          </span>
                          <span
                            className={confidenceClass(
                              strongestDecision.confidence,
                            )}
                          >
                            conf {strongestDecision.confidence}
                          </span>
                          {strongestDecision.originalSuggestedShares && (
                            <span className="text-amber-300 ml-2">
                              {strongestDecision.suggestedShares}/
                              {strongestDecision.originalSuggestedShares}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="bg-slate-900/60 rounded-2xl border border-slate-800 p-4 flex flex-col min-h-[360px]">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold tracking-wider text-slate-300">
                LAST AUTOPILOT DECISIONS
              </h2>
              <span className="text-[10px] text-slate-500">
                actionable {actionableDecisions.length}
              </span>
            </div>

            <div className="space-y-2 overflow-y-auto pr-1">
              {latestDecisions.length === 0 ? (
                <div className="text-center text-slate-600 py-16 text-xs">
                  Run dry-run to see signals.
                </div>
              ) : (
                latestDecisions.map((decision) => (
                  <div
                    key={`${decision.ticker}-${decision.timestamp}`}
                    className="rounded-xl border border-slate-800 bg-slate-950/50 p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-black text-sm">
                            {decision.ticker}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded-full border text-[10px] font-black ${actionPillClass(decision.action)}`}
                          >
                            {decision.action}
                          </span>
                        </div>
                        <div className="text-[10px] text-slate-500 mt-1">
                          RSI {decision.rsi} · MACD {decision.macdHistogram} ·
                          price {formatMoney(decision.price)}
                        </div>
                      </div>

                      <div className="text-right">
                        <div
                          className={`font-mono text-xs font-black ${confidenceClass(decision.confidence)}`}
                        >
                          {decision.confidence}
                        </div>
                        <div className="text-[10px] text-slate-500">
                          confidence
                        </div>
                      </div>
                    </div>

                    <div className="mt-2 text-xs text-slate-300 leading-relaxed">
                      {decision.reason}
                    </div>

                    {decision.action !== "HOLD" && (
                      <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
                        <div className="rounded-lg bg-slate-900/70 border border-slate-800 p-2">
                          <span className="text-slate-500">Suggested</span>
                          <div className="font-bold text-white">
                            {decision.suggestedShares} shares
                            {decision.originalSuggestedShares
                              ? ` / original ${decision.originalSuggestedShares}`
                              : ""}
                          </div>
                        </div>
                        <div className="rounded-lg bg-slate-900/70 border border-slate-800 p-2">
                          <span className="text-slate-500">Executed</span>
                          <div
                            className={
                              decision.executed
                                ? "font-bold text-emerald-300"
                                : "font-bold text-blue-300"
                            }
                          >
                            {decision.executed ? "YES" : "NO"}
                          </div>
                        </div>
                      </div>
                    )}

                    {decision.safetyNote && (
                      <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] text-amber-200">
                        {decision.safetyNote}
                      </div>
                    )}

                    {decision.skippedReason && (
                      <div className="mt-2 text-[10px] text-slate-500">
                        Skipped: {decision.skippedReason}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="bg-slate-900/60 rounded-2xl border border-slate-800 flex flex-col min-h-[420px] overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800/80 flex items-center justify-between bg-slate-900/40">
              <span className="text-xs font-black tracking-widest text-slate-400">
                CHAT TERMINAL
              </span>
              <span className="text-[10px] text-slate-500">
                OpenAI via backend
              </span>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {chatHistory.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] text-slate-500 font-bold">
                      {msg.timestamp}
                    </span>
                    <span
                      className={`text-[9px] font-black tracking-wider uppercase px-1.5 rounded ${msg.role === "user" ? "bg-slate-800 text-slate-300" : "bg-blue-900/50 text-blue-300"}`}
                    >
                      {msg.role === "user" ? "Operator" : "AI Agent"}
                    </span>
                  </div>
                  <div
                    className={`p-3 rounded-2xl text-xs max-w-[90%] leading-relaxed ${msg.role === "user" ? "bg-slate-800 text-white rounded-tr-none" : "bg-slate-950/60 text-slate-200 rounded-tl-none border border-slate-800/60"}`}
                  >
                    {msg.content}
                  </div>
                </div>
              ))}

              {isWaitingOnAI && (
                <div className="p-3 bg-slate-950/60 text-slate-500 rounded-2xl border border-slate-800/60 text-xs animate-pulse">
                  AI analyzing current Alpaca snapshot...
                </div>
              )}

              <div ref={chatEndRef} />
            </div>

            <form
              onSubmit={handleSendMessage}
              className="p-3 bg-slate-950 border-t border-slate-800/80 flex gap-2"
            >
              <input
                type="text"
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                placeholder="Ask about positions, signals, or risk..."
                className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-slate-700"
              />
              <button
                type="submit"
                disabled={isWaitingOnAI}
                className="p-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-500 text-white transition-all"
              >
                →
              </button>
            </form>
          </div>

          <div className="bg-slate-900/60 rounded-2xl border border-slate-800 p-4 h-[180px] flex flex-col">
            <h2 className="text-sm font-bold tracking-wider text-slate-400 mb-2">
              AUTOPILOT LOGS
            </h2>
            <div className="flex-1 overflow-y-auto pr-1 font-mono text-[10px] space-y-1.5 text-slate-400">
              {autopilotLogs.length === 0 ? (
                <div className="text-slate-600 text-center py-10">
                  Logs idle.
                </div>
              ) : (
                autopilotLogs.map((log, index) => (
                  <div
                    key={`${log}-${index}`}
                    className="p-1.5 rounded bg-slate-950/40 border border-slate-800/40 leading-normal"
                  >
                    {log}
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
