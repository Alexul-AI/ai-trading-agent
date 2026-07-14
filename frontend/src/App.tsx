import { useCallback, useEffect, useState } from "react";
import { ActionableSignalDebugPanel } from "./components/ActionableSignalDebugPanel";
import { AutopilotControlCenter } from "./components/AutopilotControlCenter";
import { AutopilotLogs } from "./components/AutopilotLogs";
import { ChatTerminal } from "./components/ChatTerminal";
import { DecisionJournalPanel } from "./components/DecisionJournalPanel";
import { ExecutionReadinessPanel } from "./components/ExecutionReadinessPanel";
import { LastAutopilotDecisions } from "./components/LastAutopilotDecisions";
import { ManualOrderPanel } from "./components/ManualOrderPanel";
import { MarketClockPanel } from "./components/MarketClockPanel";
import { MarketIntelPanel } from "./components/MarketIntelPanel";
import { StrategyComparisonPanel } from "./components/StrategyComparisonPanel";
import { StrategyConfigPanel } from "./components/StrategyConfigPanel";
import { StrategyQualityPanel } from "./components/StrategyQualityPanel";
import { SystemHealthBanner } from "./components/SystemHealthBanner";
import { TickerChartPanel } from "./components/TickerChartPanel";
import type {
  AutopilotRunResponse,
  AutopilotStatus,
  AutopilotToggleResponse,
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
import { useAdminSessionFetch } from "./hooks/useAdminSessionFetch";
import { useAutopilotJournal } from "./hooks/useAutopilotJournal";
import { useMarketClock } from "./hooks/useMarketClock";
import { useNewsSentiment } from "./hooks/useNewsSentiment";
import { useFundamentals } from "./hooks/useFundamentals";
import { useInsiderActivity } from "./hooks/useInsiderActivity";
import { useDashboardData } from "./hooks/useDashboardData";
import { useAutopilotStream } from "./hooks/useAutopilotStream";
import { useChatTerminal } from "./hooks/useChatTerminal";
import { useManualOrder } from "./hooks/useManualOrder";
import { API_BASE_URL } from "./api/client";

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
  circuitBreaker: null,
  circuitBreakerMaxDrawdownFromPeakPercent: -0.15,
};

export default function App() {
  const [autopilotStatus, setAutopilotStatus] = useState<AutopilotStatus>(
    EMPTY_AUTOPILOT_STATUS,
  );

  const {
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
  } = useDashboardData(setAutopilotStatus);

  const [autopilotLogs, setAutopilotLogs] = useState<string[]>([]);

  const [isRunningAutopilot, setIsRunningAutopilot] = useState(false);

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

  const {
    journalRuns,
    journalSummary,
    journalFile,
    isLoadingJournal,
    refreshAutopilotJournal,
  } = useAutopilotJournal(addAutopilotLog);

  const { marketClock, marketClockError, refreshMarketClock } =
    useMarketClock();

  const fetchWithAdminSession = useAdminSessionFetch(addAutopilotLog);

  const {
    chatInput,
    chatHistory,
    isWaitingOnAI,
    chatEndRef,
    setChatInput,
    handleSendMessage,
  } = useChatTerminal(fetchWithAdminSession);

  const { sentiment, isLoadingSentiment, sentimentError, fetchSentiment } =
    useNewsSentiment(fetchWithAdminSession);

  const {
    fundamentals,
    isLoadingFundamentals,
    fundamentalsError,
    fetchFundamentals,
  } = useFundamentals(fetchWithAdminSession);

  const {
    insiderActivity,
    isLoadingInsiderActivity,
    insiderActivityError,
    fetchInsiderActivity,
  } = useInsiderActivity(fetchWithAdminSession);

  const manualOrder = useManualOrder({
    addAutopilotLog,
    fetchWithAdminSession,
    refreshDashboard,
  });

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

  useAutopilotStream({
    addAutopilotLog,
    setTradeMode,
    setAutopilotStatus,
    setConnectionStatus,
    refreshAutopilotStatus,
    refreshAutopilotJournal,
    refreshDashboard,
  });

  useEffect(() => {
    void refreshDashboard();
    void refreshAutopilotJournal();
    void refreshMarketClock();

    const dashboardTimer = window.setInterval(() => {
      void refreshDashboard();
    }, 5000);

    const journalTimer = window.setInterval(() => {
      void refreshAutopilotJournal();
    }, 15000);

    const marketClockTimer = window.setInterval(() => {
      void refreshMarketClock();
    }, 30000);

    return () => {
      window.clearInterval(dashboardTimer);
      window.clearInterval(journalTimer);
      window.clearInterval(marketClockTimer);
    };
  }, [refreshAutopilotJournal, refreshDashboard, refreshMarketClock]);

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

        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-[10px]">
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
          <MarketClockPanel clock={marketClock} error={marketClockError} />

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

          <ManualOrderPanel tradeMode={tradeMode} manualOrder={manualOrder} />
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

          <MarketIntelPanel
            watchlist={watchlist}
            sentiment={sentiment}
            isLoadingSentiment={isLoadingSentiment}
            sentimentError={sentimentError}
            onFetchSentiment={fetchSentiment}
            fundamentals={fundamentals}
            isLoadingFundamentals={isLoadingFundamentals}
            fundamentalsError={fundamentalsError}
            onFetchFundamentals={fetchFundamentals}
            insiderActivity={insiderActivity}
            isLoadingInsiderActivity={isLoadingInsiderActivity}
            insiderActivityError={insiderActivityError}
            onFetchInsiderActivity={fetchInsiderActivity}
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
