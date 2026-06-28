import React, { useState, useEffect, useRef } from "react";

const API_BASE_URL = "http://localhost:3000";

interface Position {
  shares: number;
  avgPrice: number;
  currentPrice?: number;
  pnl?: number;
  pnlPercent?: number;
}

interface Portfolio {
  balance: number;
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

interface WidgetData {
  ticker?: string;
  technical?: {
    rsi: number;
    macd: number;
    signal: number;
    histogram: number;
    bb?: { lower: number; sma: number; upper: number };
    state: string;
  };
  sentiment?: { sentiment: "BULLISH" | "BEARISH" | "NEUTRAL"; summary: string };
  fundamental?: {
    ticker: string;
    marketCap: string;
    peRatio: string;
    forwardPE: string;
    dividendYield: string;
    fiftyTwoWeekHigh: string;
    fiftyTwoWeekLow: string;
    analystRating: string;
  };
}

export default function App() {
  const [tradeMode, setTradeMode] = useState<"paper" | "live">("paper");
  const [portfolio, setPortfolio] = useState<Portfolio>({
    balance: 0,
    currency: "USD",
    positions: {},
  });
  const [orders, setOrders] = useState<Order[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [autopilotEnabled, setAutopilotEnabled] = useState(false);
  const [autopilotLogs, setAutopilotLogs] = useState<string[]>([]);

  // Chat States
  const [chatInput, setChatInput] = useState("");
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([
    {
      id: "1",
      role: "agent",
      content:
        "Welcome to Alexul-AI Hub. I am monitoring your broker account and ready to assist you. Ask me to buy/sell assets, perform complex RSI/MACD studies, or analyze news sentiment.",
      timestamp: new Date().toLocaleTimeString(),
    },
  ]);
  const [isWaitingOnAI, setIsWaitingOnAI] = useState(false);

  // Widget Overlay State
  const [activeWidget, setActiveWidget] = useState<WidgetData | null>(null);

  // Manual Trade Form States
  const [tradeTicker, setTradeTicker] = useState("");
  const [tradeAction, setTradeAction] = useState<"BUY" | "SELL">("BUY");
  const [tradeQty, setTradeQty] = useState(1);
  const [tradeType, setTradeType] = useState("MARKET");
  const [tradeLimitPrice, setTradeLimitPrice] = useState("");
  const [tradeSL, setTradeSL] = useState("");
  const [tradeTP, setTradeTP] = useState("");

  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory]);

  // Initial loads and Live Updates Listening via SSE
  useEffect(() => {
    // 1. Get current trade mode
    fetch(`${API_BASE_URL}/api/mode`)
      .then((res) => res.json())
      .then((data) => setTradeMode(data.mode || "paper"))
      .catch(() => console.warn("Could not retrieve server trading mode."));

    // 2. Open Stream
    const eventSource = new EventSource(`${API_BASE_URL}/api/stream`);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "update") {
          setPortfolio(data.portfolio);
          setOrders(data.orders);
          setWatchlist(data.watchlist);
          if (data.tradeMode) setTradeMode(data.tradeMode);
        } else if (data.type === "autopilot_log") {
          setAutopilotLogs((prev) => [data.message, ...prev].slice(0, 50));

          // Render widget autonomously if received payload
          if (
            data.ticker &&
            (data.technicalData || data.sentimentData || data.fundamentalData)
          ) {
            setActiveWidget({
              ticker: data.ticker,
              technical: data.technicalData,
              sentiment: data.sentimentData,
              fundamental: data.fundamentalData,
            });
          }
        }
      } catch (err) {
        console.error("SSE Update error:", err);
      }
    };

    return () => eventSource.close();
  }, []);

  const handleAutopilotToggle = async () => {
    const targetState = !autopilotEnabled;
    try {
      const res = await fetch(`${API_BASE_URL}/api/autopilot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: targetState }),
      });
      if (res.ok) {
        setAutopilotEnabled(targetState);
        setAutopilotLogs((prev) => [
          `[Autopilot System] Engine set to: ${targetState ? "ENABLED" : "DISABLED"}.`,
          ...prev,
        ]);
      }
    } catch (e) {
      console.error("Could not toggle autopilot.", e);
    }
  };

  const handleSendMessage = async (e: React.SyntheticEvent) => {
    e.preventDefault();
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
      const res = await fetch(`${API_BASE_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMsg.content,
          history: chatHistory.map((h) => ({
            role: h.role,
            content: h.content,
          })),
        }),
      });
      const data = await res.json();

      const agentMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: "agent",
        content: data.reply || "Processing complete.",
        timestamp: new Date().toLocaleTimeString(),
      };

      setChatHistory((prev) => [...prev, agentMsg]);

      // If response contained actionable telemetry widgets
      if (
        data.ticker &&
        (data.technicalData || data.sentimentData || data.fundamentalData)
      ) {
        setActiveWidget({
          ticker: data.ticker,
          technical: data.technicalData,
          sentiment: data.sentimentData,
          fundamental: data.fundamentalData,
        });
      }
    } catch (e) {
      setChatHistory((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          role: "agent",
          content: "API Connection Error. Please verify server status.",
          timestamp: new Date().toLocaleTimeString(),
        },
      ]);
      console.error("Chat error:", e);
    } finally {
      setIsWaitingOnAI(false);
    }
  };

  const executeManualTrade = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (!tradeTicker.trim()) return;

    try {
      const res = await fetch(`${API_BASE_URL}/api/trade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker: tradeTicker,
          action: tradeAction,
          shares: tradeQty,
          orderType: tradeType,
          limitPrice: tradeLimitPrice ? parseFloat(tradeLimitPrice) : undefined,
          stopLoss: tradeSL ? parseFloat(tradeSL) : undefined,
          takeProfit: tradeTP ? parseFloat(tradeTP) : undefined,
        }),
      });
      const result = await res.json();
      if (result.success) {
        alert(
          `Order placed: ${tradeAction} ${tradeQty} shares of ${tradeTicker}`,
        );
        setTradeTicker("");
        setTradeSL("");
        setTradeTP("");
      } else {
        alert(`Error: ${result.error}`);
      }
    } catch (err) {
      console.error("Manual trade error:", err);
      alert("Network failure occurred executing manual trade.");
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans transition-colors duration-300">
      {/* SECURITY SAFEGUARD HEADER BANNERS */}
      {tradeMode === "live" ? (
        <div className="bg-gradient-to-r from-red-600 via-rose-700 to-red-600 text-white font-black text-center py-2 px-4 shadow-xl flex items-center justify-center gap-3 animate-pulse">
          <svg
            className="w-6 h-6 animate-bounce"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <span>
            WARNING: REAL CAPITAL ENVIRONMENT CURRENTLY IN OPERATION (LIVE
            TRADING ACTIVE)
          </span>
          <svg
            className="w-6 h-6 animate-bounce"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
      ) : (
        <div className="bg-emerald-950/80 border-b border-emerald-500/30 text-emerald-400 font-medium text-center py-1 px-4 text-xs tracking-wider flex items-center justify-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-ping"></div>
          <span>SIMULATION MODE ENGAGED (ALPACAPAPER VIRTUAL ASSETS)</span>
        </div>
      )}

      {/* DASHBOARD TOP BAR */}
      <header
        className={`px-6 py-4 flex flex-col sm:flex-row items-center justify-between border-b ${tradeMode === "live" ? "border-red-900 bg-red-950/20" : "border-slate-800 bg-slate-900/40"} gap-4`}
      >
        <div className="flex items-center gap-4">
          <div
            className={`p-2.5 rounded-xl ${tradeMode === "live" ? "bg-red-500/10 text-red-400 border border-red-500/30" : "bg-blue-500/10 text-blue-400 border border-blue-500/30"}`}
          >
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
                className={`text-xs px-2.5 py-0.5 rounded-full uppercase tracking-widest border font-semibold ${tradeMode === "live" ? "bg-red-500/20 text-red-300 border-red-500/50" : "bg-emerald-500/20 text-emerald-300 border-emerald-500/50"}`}
              >
                {tradeMode}
              </span>
            </h1>
            <p className="text-xs text-slate-400">
              Autonomous Investment Operating System
            </p>
          </div>
        </div>

        {/* AUTOPILOT CONTROL */}
        <div className="flex items-center gap-4 bg-slate-900/80 p-2 rounded-xl border border-slate-800">
          <div className="text-right">
            <p className="text-xs font-semibold text-slate-300">
              AUTOPILOT ENGINE
            </p>
            <p className="text-[10px] text-slate-500">
              Scans market setups every 60s
            </p>
          </div>
          <button
            onClick={handleAutopilotToggle}
            className={`px-4 py-2 rounded-lg font-bold text-xs tracking-wider transition-all duration-300 shadow-md ${
              autopilotEnabled
                ? tradeMode === "live"
                  ? "bg-red-600 hover:bg-red-500 text-white ring-2 ring-red-400"
                  : "bg-emerald-600 hover:bg-emerald-500 text-white ring-2 ring-emerald-400"
                : "bg-slate-800 text-slate-400 hover:bg-slate-700"
            }`}
          >
            {autopilotEnabled ? "AUTO-PILOT ACTIVE" : "ENGAGE ENGINE"}
          </button>
        </div>
      </header>

      {/* CORE GRID LAYOUT */}
      <main className="flex-1 grid grid-cols-1 xl:grid-cols-12 p-6 gap-6 overflow-hidden">
        {/* LEFT COLUMN: WATCHLIST & MANUAL ENTRY (xl:col-span-3) */}
        <div className="xl:col-span-3 flex flex-col gap-6">
          {/* WATCHLIST / SCREENER MODULE */}
          <div className="bg-slate-900/60 rounded-2xl border border-slate-800 p-4 flex flex-col flex-1 min-h-[300px]">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold tracking-wider text-slate-400">
                HOT MARKET HIGHLIGHTS
              </h2>
              <span className="text-[10px] bg-slate-800 text-slate-400 px-2 py-0.5 rounded">
                Real-time
              </span>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2 pr-1 max-h-[350px] xl:max-h-none">
              {watchlist.length === 0 ? (
                <div className="text-center text-slate-500 py-12 text-xs">
                  No watchlisted stocks loaded yet.
                </div>
              ) : (
                watchlist.map((item) => (
                  <div
                    key={item.ticker}
                    className="flex items-center justify-between p-3 rounded-xl bg-slate-950/40 hover:bg-slate-950 border border-slate-800/40 transition-colors"
                  >
                    <div>
                      <div className="font-bold text-sm tracking-wide">
                        {item.ticker}
                      </div>
                      <div className="text-[10px] text-slate-500 truncate max-w-[120px]">
                        {item.name}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-xs font-semibold">
                        ${item.price.toFixed(2)}
                      </div>
                      <div
                        className={`text-[10px] font-bold ${item.isUp ? "text-emerald-400" : "text-rose-500"}`}
                      >
                        {item.isUp ? "▲" : "▼"} {Math.abs(item.change)}%
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* QUICK MANUAL SECURE TRADE */}
          <div className="bg-slate-900/60 rounded-2xl border border-slate-800 p-4">
            <h2 className="text-sm font-bold tracking-wider text-slate-400 mb-3 flex items-center justify-between">
              MANUAL RISK-PROTECTED SENTRY
              <span
                className={`w-2 h-2 rounded-full ${tradeMode === "live" ? "bg-red-500" : "bg-emerald-500"}`}
              ></span>
            </h2>

            <form onSubmit={executeManualTrade} className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setTradeAction("BUY")}
                  className={`py-1.5 rounded-lg text-xs font-bold transition-all ${
                    tradeAction === "BUY"
                      ? "bg-emerald-600/20 text-emerald-400 border border-emerald-500/40"
                      : "bg-slate-950 text-slate-500 border border-transparent"
                  }`}
                >
                  BUY SETUP
                </button>
                <button
                  type="button"
                  onClick={() => setTradeAction("SELL")}
                  className={`py-1.5 rounded-lg text-xs font-bold transition-all ${
                    tradeAction === "SELL"
                      ? "bg-rose-600/20 text-rose-400 border border-rose-500/40"
                      : "bg-slate-950 text-slate-500 border border-transparent"
                  }`}
                >
                  SELL LIQUIDATE
                </button>
              </div>

              <div>
                <label className="text-[10px] font-bold text-slate-500 block mb-1">
                  STOCK TICKER
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. TSLA"
                  value={tradeTicker}
                  onChange={(e) => setTradeTicker(e.target.value.toUpperCase())}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-slate-600"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] font-bold text-slate-500 block mb-1">
                    QTY (SHARES)
                  </label>
                  <input
                    type="number"
                    min="1"
                    required
                    value={tradeQty}
                    onChange={(e) =>
                      setTradeQty(Math.max(1, parseInt(e.target.value) || 1))
                    }
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-slate-600"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-slate-500 block mb-1">
                    ORDER TYPE
                  </label>
                  <select
                    value={tradeType}
                    onChange={(e) => setTradeType(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-slate-600"
                  >
                    <option value="MARKET">Market</option>
                    <option value="LIMIT">Limit</option>
                  </select>
                </div>
              </div>

              {tradeType === "LIMIT" && (
                <div>
                  <label className="text-[10px] font-bold text-slate-500 block mb-1">
                    LIMIT PRICE ($)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="Limit Target"
                    value={tradeLimitPrice}
                    onChange={(e) => setTradeLimitPrice(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none"
                  />
                </div>
              )}

              {tradeAction === "BUY" && (
                <div className="grid grid-cols-2 gap-2 pt-1 border-t border-slate-800/40">
                  <div>
                    <label className="text-[9px] font-bold text-rose-500/80 block mb-1">
                      STOP LOSS ($)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="SL Bracket"
                      value={tradeSL}
                      onChange={(e) => setTradeSL(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1 text-xs text-white focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[9px] font-bold text-emerald-500/80 block mb-1">
                      TAKE PROFIT ($)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="TP Bracket"
                      value={tradeTP}
                      onChange={(e) => setTradeTP(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1 text-xs text-white focus:outline-none"
                    />
                  </div>
                </div>
              )}

              <button
                type="submit"
                className={`w-full py-2 rounded-xl font-bold text-xs tracking-wider transition-all duration-300 mt-2 ${
                  tradeMode === "live"
                    ? "bg-red-700 hover:bg-red-600 text-white hover:shadow-lg shadow-red-500/10"
                    : "bg-blue-600 hover:bg-blue-500 text-white"
                }`}
              >
                EXECUTE ORDER ({tradeAction})
              </button>
            </form>
          </div>
        </div>

        {/* MIDDLE COLUMN: PORTFOLIO & TRACKING (xl:col-span-5) */}
        <div className="xl:col-span-5 flex flex-col gap-6">
          {/* BALANCE METRICS */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-slate-900/60 rounded-2xl border border-slate-800 p-4">
              <span className="text-[10px] font-bold tracking-wider text-slate-500 block">
                TOTAL AVAILABLE CASH
              </span>
              <span className="text-2xl font-black font-mono tracking-tight text-white block mt-1">
                $
                {portfolio.balance.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
            </div>

            <div className="bg-slate-900/60 rounded-2xl border border-slate-800 p-4">
              <span className="text-[10px] font-bold tracking-wider text-slate-500 block font-sans">
                PORTFOLIO EXPOSURE
              </span>
              <span className="text-2xl font-black font-mono tracking-tight block mt-1 text-blue-400">
                {Object.keys(portfolio.positions).length} Assets
              </span>
            </div>
          </div>

          {/* OPEN PORTFOLIO POSITIONS */}
          <div className="bg-slate-900/60 rounded-2xl border border-slate-800 p-4 flex-1 flex flex-col min-h-[250px]">
            <h2 className="text-sm font-bold tracking-wider text-slate-400 mb-3">
              ACTIVE STOCK POSITIONS
            </h2>

            <div className="flex-1 overflow-y-auto space-y-2 max-h-[250px] xl:max-h-none pr-1">
              {Object.keys(portfolio.positions).length === 0 ? (
                <div className="text-center text-slate-500 py-16 text-xs font-sans">
                  No open stock positions currently held.
                </div>
              ) : (
                Object.entries(portfolio.positions).map(([symbol, data]) => {
                  const shares = data.shares;
                  const avgPrice = data.avgPrice;
                  const currentPrice = data.currentPrice || avgPrice;
                  const pnl = data.pnl || 0;
                  const pnlPct = data.pnlPercent || 0;
                  const isGain = pnl >= 0;

                  return (
                    <div
                      key={symbol}
                      className="p-3.5 rounded-xl bg-slate-950/40 border border-slate-800/60 flex items-center justify-between hover:bg-slate-950/80 transition-colors"
                    >
                      <div>
                        <div className="font-extrabold text-sm tracking-wide">
                          {symbol}
                        </div>
                        <div className="text-[10px] text-slate-500">
                          {shares} Shares @ avg ${avgPrice.toFixed(2)}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-mono text-xs font-bold">
                          ${(shares * currentPrice).toFixed(2)}
                        </div>
                        <div
                          className={`text-[10px] font-black ${isGain ? "text-emerald-400" : "text-rose-500"}`}
                        >
                          {isGain ? "▲" : "▼"} ${Math.abs(pnl).toFixed(2)} (
                          {pnlPct.toFixed(2)}%)
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* PENDING / PROTECTIVE BRACKETS */}
          <div className="bg-slate-900/60 rounded-2xl border border-slate-800 p-4 flex flex-col h-[200px]">
            <h2 className="text-sm font-bold tracking-wider text-slate-400 mb-2">
              ACTIVE OR PROTECTION ORDERS (OCO)
            </h2>
            <div className="flex-1 overflow-y-auto pr-1">
              {orders.length === 0 ? (
                <div className="text-center text-slate-500 py-8 text-xs">
                  No pending orders or brackets in queue.
                </div>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-800/40 text-slate-500 text-[10px] uppercase font-bold">
                      <th className="pb-2">Symbol</th>
                      <th className="pb-2">Type</th>
                      <th className="pb-2 text-right">Target Price</th>
                      <th className="pb-2 text-right">Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((o) => (
                      <tr
                        key={o.id}
                        className="border-b border-slate-800/20 last:border-0 hover:bg-slate-950/20"
                      >
                        <td className="py-2.5 font-bold">{o.ticker}</td>
                        <td className="py-2.5">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-extrabold ${
                              o.action === "BUY"
                                ? "bg-emerald-500/10 text-emerald-400"
                                : "bg-rose-500/10 text-rose-400"
                            }`}
                          >
                            {o.action}
                          </span>
                        </td>
                        <td className="py-2.5 text-right font-mono text-slate-300">
                          {o.limitPrice
                            ? `$${o.limitPrice.toFixed(2)}`
                            : "Market"}
                        </td>
                        <td className="py-2.5 text-right font-mono text-slate-400">
                          {o.qty}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: CHAT TERMINAL & LOGS (xl:col-span-4) */}
        <div className="xl:col-span-4 flex flex-col gap-6">
          {/* TERMINAL CONTAINER */}
          <div className="bg-slate-900/60 rounded-2xl border border-slate-800 flex flex-col flex-1 h-[450px] xl:h-auto overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800/80 flex items-center justify-between bg-slate-900/40">
              <span className="text-xs font-black tracking-widest text-slate-400">
                SECURE SHELL CHAT TERMINAL
              </span>
              <div className="flex gap-1.5">
                <div className="w-2.5 h-2.5 rounded-full bg-rose-500"></div>
                <div className="w-2.5 h-2.5 rounded-full bg-amber-500"></div>
                <div className="w-2.5 h-2.5 rounded-full bg-emerald-500"></div>
              </div>
            </div>

            {/* CHAT MESSAGES PANEL */}
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
                      className={`text-[9px] font-black tracking-wider uppercase px-1.5 rounded ${
                        msg.role === "user"
                          ? "bg-slate-800 text-slate-300"
                          : "bg-blue-900/50 text-blue-300"
                      }`}
                    >
                      {msg.role === "user" ? "Operator" : "AI Agent"}
                    </span>
                  </div>
                  <div
                    className={`p-3 rounded-2xl text-xs max-w-[85%] leading-relaxed ${
                      msg.role === "user"
                        ? "bg-slate-800 text-white rounded-tr-none"
                        : "bg-slate-950/60 text-slate-200 rounded-tl-none border border-slate-800/60"
                    }`}
                  >
                    {msg.content}
                  </div>
                </div>
              ))}
              {isWaitingOnAI && (
                <div className="flex flex-col items-start animate-pulse">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[9px] font-black tracking-wider uppercase px-1.5 bg-blue-950 text-blue-400 rounded">
                      AI ANALYZING
                    </span>
                  </div>
                  <div className="p-3 bg-slate-950/60 text-slate-500 rounded-2xl rounded-tl-none border border-slate-800/60 text-xs flex items-center gap-2">
                    <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-ping"></span>
                    Evaluating indicators, news sentiment and current balance...
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* MESSAGE INPUT BAR */}
            <form
              onSubmit={handleSendMessage}
              className="p-3 bg-slate-950 border-t border-slate-800/80 flex gap-2"
            >
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Ask Alexul-AI to study charts or execute trades..."
                className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-slate-700"
              />
              <button
                type="submit"
                disabled={isWaitingOnAI}
                className={`p-2.5 rounded-xl flex items-center justify-center transition-all ${
                  tradeMode === "live"
                    ? "bg-red-700 hover:bg-red-600 text-white"
                    : "bg-blue-600 hover:bg-blue-500 text-white"
                }`}
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2.5"
                    d="M14 5l7 7m0 0l-7 7m7-7H3"
                  />
                </svg>
              </button>
            </form>
          </div>

          {/* REALTIME SYSTEM AUDIT ENGINE LOGS */}
          <div className="bg-slate-900/60 rounded-2xl border border-slate-800 p-4 h-[200px] flex flex-col">
            <h2 className="text-sm font-bold tracking-wider text-slate-400 mb-2">
              AUTOPILOT DIAGNOSTIC SHELL
            </h2>
            <div className="flex-1 overflow-y-auto pr-1 font-mono text-[10px] space-y-1.5 text-slate-400">
              {autopilotLogs.length === 0 ? (
                <div className="text-slate-600 text-center py-12">
                  Shell logs currently idle. Initiate Autopilot.
                </div>
              ) : (
                autopilotLogs.map((log, index) => (
                  <div
                    key={index}
                    className="p-1.5 rounded bg-slate-950/40 border border-slate-800/40 leading-normal"
                  >
                    <span className="text-slate-500 font-bold">
                      [{new Date().toLocaleTimeString()}]
                    </span>{" "}
                    {log}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </main>

      {/* FLOATING TELEMETRY INTEGRATION WIDGET OVERLAY */}
      {activeWidget && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-slate-800 max-w-md w-full rounded-2xl overflow-hidden shadow-2xl relative">
            <button
              onClick={() => setActiveWidget(null)}
              className="absolute top-4 right-4 text-slate-400 hover:text-white transition-colors p-1"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2.5"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>

            <div className="p-6">
              <h3 className="text-lg font-black tracking-wide border-b border-slate-800 pb-3 mb-4 flex items-center justify-between text-blue-400">
                <span>TELEMETRY: {activeWidget.ticker}</span>
                <span className="text-[10px] bg-slate-800 text-slate-400 px-2 py-0.5 rounded uppercase font-bold">
                  INJECTED DATA
                </span>
              </h3>

              {/* TECHNICAL DATA PANEL */}
              {activeWidget.technical && (
                <div className="mb-4 bg-slate-950/60 p-4 rounded-xl border border-slate-800/50">
                  <h4 className="text-xs font-bold text-slate-400 mb-2 uppercase tracking-wider">
                    Technical Indicators
                  </h4>
                  <div className="grid grid-cols-2 gap-4 text-xs font-mono">
                    <div>
                      RSI (14):{" "}
                      <span className="text-slate-100 font-bold">
                        {activeWidget.technical.rsi}
                      </span>
                    </div>
                    <div>
                      State:{" "}
                      <span
                        className={`font-bold ${
                          activeWidget.technical.state === "OVERSOLD"
                            ? "text-emerald-400"
                            : activeWidget.technical.state === "OVERBOUGHT"
                              ? "text-rose-500"
                              : "text-amber-400"
                        }`}
                      >
                        {activeWidget.technical.state}
                      </span>
                    </div>
                    <div>
                      MACD Line:{" "}
                      <span className="text-slate-300">
                        {activeWidget.technical.macd}
                      </span>
                    </div>
                    <div>
                      Histogram:{" "}
                      <span className="text-slate-300">
                        {activeWidget.technical.histogram}
                      </span>
                    </div>

                    {/* NEW: Bollinger Bands Display */}
                    {activeWidget.technical.bb && (
                      <div className="col-span-2 pt-2 border-t border-slate-800/50 mt-1">
                        <div className="text-[10px] text-slate-500 mb-1">
                          BOLLINGER BANDS (20,2)
                        </div>
                        <div className="flex justify-between text-slate-300 font-bold">
                          <span>L: ${activeWidget.technical.bb.lower}</span>
                          <span className="text-slate-500">
                            SMA: ${activeWidget.technical.bb.sma}
                          </span>
                          <span>U: ${activeWidget.technical.bb.upper}</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* NEWS SENTIMENT PANEL */}
              {activeWidget.sentiment && (
                <div className="mb-4 bg-slate-950/60 p-4 rounded-xl border border-slate-800/50">
                  <h4 className="text-xs font-bold text-slate-400 mb-2 uppercase tracking-wider">
                    Sentiment Studies
                  </h4>
                  <div className="text-xs">
                    <div className="font-bold flex items-center gap-2 mb-1">
                      Score:
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-black ${
                          activeWidget.sentiment.sentiment === "BULLISH"
                            ? "bg-emerald-500/20 text-emerald-400"
                            : activeWidget.sentiment.sentiment === "BEARISH"
                              ? "bg-rose-500/20 text-rose-400"
                              : "bg-slate-800 text-slate-300"
                        }`}
                      >
                        {activeWidget.sentiment.sentiment}
                      </span>
                    </div>
                    <p className="text-slate-300 italic">
                      "{activeWidget.sentiment.summary}"
                    </p>
                  </div>
                </div>
              )}

              {/* FUNDAMENTAL DATA PANEL */}
              {activeWidget.fundamental && (
                <div className="bg-slate-950/60 p-4 rounded-xl border border-slate-800/50">
                  <h4 className="text-xs font-bold text-slate-400 mb-2 uppercase tracking-wider">
                    Fundamentals & Valuation
                  </h4>
                  <div className="grid grid-cols-2 gap-2 text-xs font-mono text-slate-300">
                    <div>
                      Market Cap:{" "}
                      <span className="text-white">
                        {activeWidget.fundamental.marketCap}
                      </span>
                    </div>
                    <div>
                      P/E Ratio:{" "}
                      <span className="text-white">
                        {activeWidget.fundamental.peRatio}
                      </span>
                    </div>
                    <div>
                      Forward P/E:{" "}
                      <span className="text-white">
                        {activeWidget.fundamental.forwardPE}
                      </span>
                    </div>
                    <div>
                      Div Yield:{" "}
                      <span className="text-white">
                        {activeWidget.fundamental.dividendYield}
                      </span>
                    </div>
                    <div>
                      52W High:{" "}
                      <span className="text-white">
                        ${activeWidget.fundamental.fiftyTwoWeekHigh}
                      </span>
                    </div>
                    <div>
                      52W Low:{" "}
                      <span className="text-white">
                        ${activeWidget.fundamental.fiftyTwoWeekLow}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
