import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ||
  (window.location.hostname === "localhost"
    ? "http://localhost:3000"
    : "https://ai-trading-agent-i4nr.onrender.com");

type TradeMode = "paper" | "live";

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
  role: "user" | "agent" | "system";
  content: string;
  timestamp: string;
}

interface DashboardResponse {
  tradeMode?: TradeMode;
  autopilotEnabled?: boolean;
  portfolio?: Portfolio;
  orders?: Order[];
  watchlist?: WatchlistItem[];
}

interface SSEPayload {
  type: string;
  tradeMode?: TradeMode;
  autopilotEnabled?: boolean;
  enabled?: boolean;
  message?: string;
  level?: "info" | "warning" | "error";
  data?: unknown;
}

interface ApiErrorBody {
  error?: string;
  result?: {
    reason?: string;
  };
}

function nowTime() {
  return new Date().toLocaleTimeString();
}

function money(value: number | undefined | null) {
  const safeValue = typeof value === "number" && Number.isFinite(value) ? value : 0;

  return safeValue.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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

export default function App() {
  const [tradeMode, setTradeMode] = useState<TradeMode>("paper");
  const [portfolio, setPortfolio] = useState<Portfolio>({
    balance: 0,
    equity: 0,
    currency: "USD",
    positions: {},
  });
  const [orders, setOrders] = useState<Order[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [autopilotEnabled, setAutopilotEnabled] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<
    "connecting" | "connected" | "disconnected"
  >("connecting");

  const [logs, setLogs] = useState<string[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isWaitingOnAI, setIsWaitingOnAI] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "agent",
      content:
        "AI Trading Agent is ready. First goal: stable paper trading, safe routing, and reliable SSE connection.",
      timestamp: nowTime(),
    },
  ]);

  const [tradeTicker, setTradeTicker] = useState("");
  const [tradeAction, setTradeAction] = useState<"BUY" | "SELL">("BUY");
  const [tradeQty, setTradeQty] = useState(1);
  const [tradeType, setTradeType] = useState<"market" | "limit">("market");
  const [tradeLimitPrice, setTradeLimitPrice] = useState("");
  const [tradeSL, setTradeSL] = useState("");
  const [tradeTP, setTradeTP] = useState("");

  const chatEndRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const didInitRef = useRef(false);

  const equity = portfolio.equity ?? portfolio.balance;
  const positionsArray = useMemo(
    () => Object.entries(portfolio.positions || {}),
    [portfolio.positions],
  );

  const addLog = useCallback((message: string) => {
    setLogs((prev) => [`[${nowTime()}] ${message}`, ...prev].slice(0, 80));
  }, []);

  function addChatMessage(role: ChatMessage["role"], content: string) {
    setChatHistory((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random()}`,
        role,
        content,
        timestamp: nowTime(),
      },
    ]);
  }

  const loadDashboard = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/dashboard`, {
        cache: "no-store",
      });

      const data = (await res.json()) as DashboardResponse & ApiErrorBody;

      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      if (data.tradeMode) setTradeMode(data.tradeMode);
      if (typeof data.autopilotEnabled === "boolean") {
        setAutopilotEnabled(data.autopilotEnabled);
      }
      if (data.portfolio) setPortfolio(data.portfolio);
      if (data.orders) setOrders(data.orders);
      if (data.watchlist) setWatchlist(data.watchlist);
    } catch (error: unknown) {
      addLog(`/api/dashboard failed: ${getErrorMessage(error)}`);
    }
  }, [addLog]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory]);

  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;

    addLog(`Using API: ${API_BASE_URL}`);

    fetch(`${API_BASE_URL}/api/mode`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`/api/mode returned ${res.status}`);
        return res.json();
      })
      .then((data: { mode?: TradeMode }) => {
        setTradeMode(data.mode || "paper");
        addLog(`/api/mode OK: ${data.mode || "paper"}`);
      })
      .catch((error: unknown) => {
        addLog(`/api/mode failed: ${getErrorMessage(error)}`);
      });

    loadDashboard();

    const dashboardInterval = window.setInterval(() => {
      loadDashboard();
    }, 5_000);

    const streamUrl = `${API_BASE_URL}/api/stream`;
    addLog(`Opening SSE: ${streamUrl}`);

    const eventSource = new EventSource(streamUrl);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      setConnectionStatus("connected");
      addLog("SSE connected");
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as SSEPayload;

        if (data.type === "connected") {
          if (data.tradeMode) setTradeMode(data.tradeMode);
          if (typeof data.autopilotEnabled === "boolean") {
            setAutopilotEnabled(data.autopilotEnabled);
          }
          addLog("SSE handshake received");
          return;
        }

        if (data.type === "autopilot_status") {
          setAutopilotEnabled(Boolean(data.enabled));
          addLog(`Autopilot ${data.enabled ? "enabled" : "disabled"}`);
          return;
        }

        if (data.type === "trade") {
          addLog(`Trade event: ${JSON.stringify(data.data)}`);
          loadDashboard();
          return;
        }

        if (data.type === "notification") {
          addLog(`${data.level || "info"}: ${data.message || ""}`);
          return;
        }

        if (data.type === "autopilot_log") {
          addLog(data.message || "Autopilot log event");
          return;
        }

        addLog(`SSE message: ${JSON.stringify(data)}`);
      } catch {
        addLog("Failed to parse SSE message");
      }
    };

    eventSource.onerror = () => {
      setConnectionStatus("disconnected");
      addLog("SSE interrupted. Browser will retry automatically.");
    };

    return () => {
      window.clearInterval(dashboardInterval);
      eventSource.close();
      eventSourceRef.current = null;
      setConnectionStatus("disconnected");
    };
  }, [addLog, loadDashboard]);

  async function handleAutopilotToggle() {
    const targetState = !autopilotEnabled;

    try {
      const res = await fetch(`${API_BASE_URL}/api/autopilot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: targetState }),
      });

      const data = (await res.json()) as ApiErrorBody & {
        enabled?: boolean;
      };

      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      setAutopilotEnabled(Boolean(data.enabled));
      addLog(`Autopilot set to ${data.enabled ? "ENABLED" : "DISABLED"}`);
    } catch (error: unknown) {
      addLog(`Autopilot toggle failed: ${getErrorMessage(error)}`);
    }
  }

  async function handleSendMessage(event: React.FormEvent) {
    event.preventDefault();

    const content = chatInput.trim();
    if (!content || isWaitingOnAI) return;

    addChatMessage("user", content);
    setChatInput("");
    setIsWaitingOnAI(true);

    try {
      const res = await fetch(`${API_BASE_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: content,
          history: chatHistory.map((item) => ({
            role: item.role === "agent" ? "agent" : "user",
            content: item.content,
          })),
        }),
      });

      const data = (await res.json()) as ApiErrorBody & {
        reply?: string;
      };

      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      addChatMessage("agent", data.reply || "Done.");
      loadDashboard();
    } catch (error: unknown) {
      addChatMessage("system", `API error: ${getErrorMessage(error)}`);
    } finally {
      setIsWaitingOnAI(false);
    }
  }

  async function executeManualTrade(event: React.FormEvent) {
    event.preventDefault();

    if (!tradeTicker.trim()) return;

    try {
      const payload = {
        ticker: tradeTicker.trim().toUpperCase(),
        action: tradeAction,
        shares: tradeQty,
        orderType: tradeType,
        limitPrice: tradeLimitPrice ? Number.parseFloat(tradeLimitPrice) : undefined,
        stopLoss: tradeSL ? Number.parseFloat(tradeSL) : undefined,
        takeProfit: tradeTP ? Number.parseFloat(tradeTP) : undefined,
      };

      const res = await fetch(`${API_BASE_URL}/api/trade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = (await res.json()) as ApiErrorBody;

      if (!res.ok) {
        throw new Error(data.error || data.result?.reason || `HTTP ${res.status}`);
      }

      addLog(`Order accepted: ${tradeAction} ${tradeQty} ${tradeTicker.toUpperCase()}`);
      setTradeTicker("");
      setTradeSL("");
      setTradeTP("");
      loadDashboard();
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      addLog(`Trade failed: ${message}`);
      alert(`Trade failed: ${message}`);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
      <div
        className={`px-4 py-2 text-center text-xs font-bold tracking-widest ${
          tradeMode === "live"
            ? "bg-red-700 text-white animate-pulse"
            : "bg-emerald-950 text-emerald-300 border-b border-emerald-700/40"
        }`}
      >
        {tradeMode === "live"
          ? "LIVE TRADING MODE — REAL CAPITAL"
          : "PAPER TRADING MODE — SIMULATION"}
      </div>

      <header className="p-5 border-b border-slate-800 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-black">Alexul-AI Trading Agent</h1>
          <p className="text-sm text-slate-400">
            API: <span className="font-mono">{API_BASE_URL}</span>
          </p>
        </div>

        <div className="flex flex-wrap gap-3 items-center">
          <span
            className={`px-3 py-1 rounded-full text-xs font-bold ${
              connectionStatus === "connected"
                ? "bg-emerald-500/20 text-emerald-300"
                : connectionStatus === "connecting"
                  ? "bg-amber-500/20 text-amber-300"
                  : "bg-red-500/20 text-red-300"
            }`}
          >
            SSE: {connectionStatus}
          </span>

          <button
            onClick={handleAutopilotToggle}
            className={`px-4 py-2 rounded-xl text-xs font-black ${
              autopilotEnabled
                ? "bg-emerald-600 hover:bg-emerald-500"
                : "bg-slate-800 hover:bg-slate-700"
            }`}
          >
            {autopilotEnabled ? "AUTOPILOT ON" : "AUTOPILOT OFF"}
          </button>
        </div>
      </header>

      <main className="p-5 grid grid-cols-1 xl:grid-cols-12 gap-5">
        <section className="xl:col-span-3 space-y-5">
          <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-4">
            <h2 className="text-sm font-black text-slate-400 mb-3">Portfolio</h2>

            <div className="space-y-2">
              <div>
                <div className="text-xs text-slate-500">Equity</div>
                <div className="text-2xl font-mono font-black">
                  ${money(equity)}
                </div>
              </div>

              <div>
                <div className="text-xs text-slate-500">Cash</div>
                <div className="text-lg font-mono">${money(portfolio.balance)}</div>
              </div>

              <div>
                <div className="text-xs text-slate-500">Currency</div>
                <div className="text-sm">{portfolio.currency}</div>
              </div>
            </div>
          </div>

          <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-4">
            <h2 className="text-sm font-black text-slate-400 mb-3">
              Manual risk-protected trade
            </h2>

            <form onSubmit={executeManualTrade} className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setTradeAction("BUY")}
                  className={`py-2 rounded-lg text-xs font-bold ${
                    tradeAction === "BUY"
                      ? "bg-emerald-600"
                      : "bg-slate-800 text-slate-400"
                  }`}
                >
                  BUY
                </button>
                <button
                  type="button"
                  onClick={() => setTradeAction("SELL")}
                  className={`py-2 rounded-lg text-xs font-bold ${
                    tradeAction === "SELL"
                      ? "bg-red-600"
                      : "bg-slate-800 text-slate-400"
                  }`}
                >
                  SELL
                </button>
              </div>

              <input
                value={tradeTicker}
                onChange={(event) => setTradeTicker(event.target.value.toUpperCase())}
                placeholder="Ticker, e.g. AAPL"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm"
              />

              <input
                type="number"
                min={1}
                value={tradeQty}
                onChange={(event) =>
                  setTradeQty(Math.max(1, Number.parseInt(event.target.value) || 1))
                }
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm"
              />

              <select
                value={tradeType}
                onChange={(event) => setTradeType(event.target.value as "market" | "limit")}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm"
              >
                <option value="market">Market</option>
                <option value="limit">Limit</option>
              </select>

              {tradeType === "limit" && (
                <input
                  type="number"
                  step="0.01"
                  value={tradeLimitPrice}
                  onChange={(event) => setTradeLimitPrice(event.target.value)}
                  placeholder="Limit price"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm"
                />
              )}

              {tradeAction === "BUY" && (
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    step="0.01"
                    value={tradeSL}
                    onChange={(event) => setTradeSL(event.target.value)}
                    placeholder="Stop loss"
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm"
                  />
                  <input
                    type="number"
                    step="0.01"
                    value={tradeTP}
                    onChange={(event) => setTradeTP(event.target.value)}
                    placeholder="Take profit"
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm"
                  />
                </div>
              )}

              <button
                type="submit"
                className="w-full bg-blue-600 hover:bg-blue-500 py-2 rounded-xl text-xs font-black"
              >
                EXECUTE {tradeAction}
              </button>
            </form>
          </div>
        </section>

        <section className="xl:col-span-5 space-y-5">
          <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-4">
            <h2 className="text-sm font-black text-slate-400 mb-3">Positions</h2>

            {positionsArray.length === 0 ? (
              <div className="text-sm text-slate-500 py-8 text-center">
                No open positions.
              </div>
            ) : (
              <div className="space-y-2">
                {positionsArray.map(([symbol, position]) => {
                  const currentPrice = position.currentPrice ?? position.avgPrice;
                  const marketValue = position.shares * currentPrice;
                  const pnl = position.pnl ?? 0;
                  const pnlPercent = position.pnlPercent ?? 0;
                  const isGain = pnl >= 0;

                  return (
                    <div
                      key={symbol}
                      className="bg-slate-950/60 border border-slate-800 rounded-xl p-3 flex justify-between gap-3"
                    >
                      <div>
                        <div className="font-black">{symbol}</div>
                        <div className="text-xs text-slate-500">
                          {position.shares} shares @ avg ${money(position.avgPrice)}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-mono">${money(marketValue)}</div>
                        <div
                          className={`text-xs font-bold ${
                            isGain ? "text-emerald-400" : "text-red-400"
                          }`}
                        >
                          {isGain ? "▲" : "▼"} ${money(Math.abs(pnl))} (
                          {money(Math.abs(pnlPercent))}%)
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-4">
            <h2 className="text-sm font-black text-slate-400 mb-3">Open orders</h2>

            {orders.length === 0 ? (
              <div className="text-sm text-slate-500 py-8 text-center">
                No open orders.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-slate-500 text-xs">
                    <tr>
                      <th className="text-left py-2">Ticker</th>
                      <th className="text-left py-2">Action</th>
                      <th className="text-right py-2">Qty</th>
                      <th className="text-right py-2">Type</th>
                      <th className="text-right py-2">Limit</th>
                      <th className="text-right py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((order) => (
                      <tr key={order.id} className="border-t border-slate-800">
                        <td className="py-2 font-bold">{order.ticker}</td>
                        <td className="py-2">{order.action}</td>
                        <td className="py-2 text-right">{order.qty}</td>
                        <td className="py-2 text-right">{order.orderType}</td>
                        <td className="py-2 text-right">
                          {order.limitPrice ? `$${money(order.limitPrice)}` : "-"}
                        </td>
                        <td className="py-2 text-right">{order.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-4">
            <h2 className="text-sm font-black text-slate-400 mb-3">Watchlist</h2>

            {watchlist.length === 0 ? (
              <div className="text-sm text-slate-500 py-8 text-center">
                Waiting for watchlist data.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {watchlist.map((item) => (
                  <div
                    key={item.ticker}
                    className="bg-slate-950/60 border border-slate-800 rounded-xl p-3 flex justify-between"
                  >
                    <div>
                      <div className="font-black">{item.ticker}</div>
                      <div className="text-xs text-slate-500 truncate max-w-[180px]">
                        {item.name}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono">${money(item.price)}</div>
                      <div
                        className={`text-xs font-bold ${
                          item.isUp ? "text-emerald-400" : "text-red-400"
                        }`}
                      >
                        {item.isUp ? "▲" : "▼"} {money(Math.abs(item.change))}%
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="xl:col-span-4 space-y-5">
          <div className="bg-slate-900/70 border border-slate-800 rounded-2xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800 flex justify-between">
              <h2 className="text-sm font-black text-slate-400">AI chat</h2>
              <span className="text-xs text-slate-500">
                {isWaitingOnAI ? "thinking..." : "ready"}
              </span>
            </div>

            <div className="h-[420px] overflow-y-auto p-4 space-y-3">
              {chatHistory.map((message) => (
                <div
                  key={message.id}
                  className={`flex ${
                    message.role === "user" ? "justify-end" : "justify-start"
                  }`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl p-3 text-sm ${
                      message.role === "user"
                        ? "bg-blue-600 text-white rounded-tr-none"
                        : message.role === "system"
                          ? "bg-red-950/60 border border-red-800 text-red-200"
                          : "bg-slate-950/70 border border-slate-800 text-slate-200 rounded-tl-none"
                    }`}
                  >
                    <div className="text-[10px] opacity-60 mb-1">
                      {message.role} · {message.timestamp}
                    </div>
                    {message.content}
                  </div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>

            <form onSubmit={handleSendMessage} className="p-3 border-t border-slate-800 flex gap-2">
              <input
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                placeholder="Ask the agent..."
                className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm"
              />
              <button
                type="submit"
                disabled={isWaitingOnAI}
                className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-4 rounded-xl text-sm font-black"
              >
                SEND
              </button>
            </form>
          </div>

          <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-4">
            <h2 className="text-sm font-black text-slate-400 mb-3">System logs</h2>

            <div className="h-[260px] overflow-y-auto space-y-1 font-mono text-xs">
              {logs.length === 0 ? (
                <div className="text-slate-500 text-center py-10">No logs yet.</div>
              ) : (
                logs.map((log, index) => (
                  <div key={`${log}-${index}`} className="bg-slate-950/50 rounded-lg p-2 text-slate-400">
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
