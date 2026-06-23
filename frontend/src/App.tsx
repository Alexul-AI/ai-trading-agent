import React, { useState, useRef, useEffect } from "react";
import {
  Send,
  Bot,
  User,
  Activity,
  TrendingUp,
  AlertTriangle,
  ArrowUpRight,
  ArrowDownRight,
  Layers,
  PieChart,
  Wallet,
  Newspaper,
  Gauge,
} from "lucide-react";

interface ChartPoint {
  date: string;
  price: number;
}
interface PortfolioAllocation {
  ticker: string;
  percentage: number;
  amount: number;
  reasoning: string;
}
interface TechnicalData {
  rsi: number;
  macd: number;
  signal: number;
  histogram: number;
  state: string;
}
interface SentimentData {
  sentiment: "BULLISH" | "BEARISH" | "NEUTRAL";
  summary: string;
}

interface Message {
  id: string;
  role: "user" | "agent" | "system";
  content: string;
  chartData?: ChartPoint[];
  ticker?: string;
  portfolio?: PortfolioAllocation[];
  technicalData?: TechnicalData;
  sentimentData?: SentimentData;
}

interface WatchlistItem {
  ticker: string;
  name: string;
  price: number;
  change: number;
  isUp: boolean;
}
interface UserPortfolio {
  balance: number;
  currency: string;
  positions: Record<
    string,
    {
      shares: number;
      avgPrice: number;
      currentPrice?: number;
      pnl?: number;
      pnlPercent?: number;
    }
  >;
}
interface PendingOrder {
  id: string;
  ticker: string;
  action: string;
  qty: number;
  orderType: string;
  limitPrice: number | null;
  status: string;
}

function SentimentWidget({ data }: { data?: SentimentData }) {
  if (!data) return null;
  const isBull = data.sentiment === "BULLISH";
  const isBear = data.sentiment === "BEARISH";

  return (
    <div className="mt-4 bg-[#0B0F19] rounded-lg p-4 border border-slate-800/80 w-full">
      <div className="flex items-center mb-3">
        <Newspaper className="w-4 h-4 text-purple-400 mr-2" />
        <span className="text-xs font-semibold uppercase tracking-wider text-purple-400">
          Market Sentiment & News
        </span>
      </div>
      <div className="flex flex-col sm:flex-row sm:items-center space-y-3 sm:space-y-0 sm:space-x-4">
        <div
          className={`px-4 py-1.5 rounded-md border font-bold text-xs tracking-widest text-center flex-shrink-0 ${isBull ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" : isBear ? "bg-rose-500/10 border-rose-500/20 text-rose-400" : "bg-slate-500/10 border-slate-500/20 text-slate-400"}`}
        >
          {data.sentiment}
        </div>
        <p className="text-xs text-slate-300 leading-relaxed italic border-l-2 border-slate-700 pl-3">
          "{data.summary}"
        </p>
      </div>
    </div>
  );
}

function TechnicalWidget({ data }: { data?: TechnicalData }) {
  if (!data) return null;
  const rsiPos = Math.min(100, Math.max(0, data.rsi));

  return (
    <div className="mt-4 bg-[#0B0F19] rounded-lg p-4 border border-slate-800/80 w-full">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center">
          <Gauge className="w-4 h-4 text-orange-400 mr-2" />
          <span className="text-xs font-semibold uppercase tracking-wider text-orange-400">
            Technical Indicators
          </span>
        </div>
        <span
          className={`text-[10px] px-2 py-0.5 rounded font-mono font-bold ${data.state === "OVERSOLD" ? "bg-emerald-500/20 text-emerald-400" : data.state === "OVERBOUGHT" ? "bg-rose-500/20 text-rose-400" : "bg-slate-700 text-slate-300"}`}
        >
          {data.state}
        </span>
      </div>
      <div className="space-y-5">
        <div>
          <div className="flex justify-between text-xs mb-1.5">
            <span className="text-slate-400 font-medium">RSI (14 Days)</span>
            <span className="font-mono text-white font-bold">{data.rsi}</span>
          </div>
          <div className="relative w-full h-2.5 bg-slate-800 rounded-full overflow-hidden flex">
            <div
              className="h-full bg-emerald-500/60"
              style={{ width: "30%" }}
              title="Oversold (Buy)"
            ></div>
            <div
              className="h-full bg-slate-600/60"
              style={{ width: "40%" }}
              title="Neutral"
            ></div>
            <div
              className="h-full bg-rose-500/60"
              style={{ width: "30%" }}
              title="Overbought (Sell)"
            ></div>
            <div
              className="absolute top-0 bottom-0 w-1.5 bg-white rounded shadow-[0_0_8px_rgba(255,255,255,0.9)]"
              style={{ left: `${rsiPos}%`, transform: "translateX(-50%)" }}
            ></div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-[#111827] p-2.5 rounded border border-slate-800/50">
            <div className="text-[10px] text-slate-500 mb-0.5">MACD</div>
            <div className="font-mono text-xs text-white">{data.macd}</div>
          </div>
          <div className="bg-[#111827] p-2.5 rounded border border-slate-800/50">
            <div className="text-[10px] text-slate-500 mb-0.5">Signal</div>
            <div className="font-mono text-xs text-white">{data.signal}</div>
          </div>
          <div className="bg-[#111827] p-2.5 rounded border border-slate-800/50">
            <div className="text-[10px] text-slate-500 mb-0.5">Histogram</div>
            <div
              className={`font-mono text-xs ${data.histogram > 0 ? "text-emerald-400" : "text-rose-400"}`}
            >
              {data.histogram > 0 ? "+" : ""}
              {data.histogram}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PortfolioWidget({
  allocations,
}: {
  allocations: PortfolioAllocation[];
}) {
  if (!allocations || allocations.length === 0) return null;
  return (
    <div className="mt-4 bg-[#0B0F19] rounded-lg p-4 border border-slate-800/80 w-full">
      <div className="flex items-center mb-4 pb-3 border-b border-slate-800/80">
        <PieChart className="w-4 h-4 text-emerald-400 mr-2" />
        <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
          Recommended Allocation
        </span>
      </div>
      <div className="space-y-4">
        {allocations.map((item, idx) => (
          <div
            key={idx}
            className="bg-[#111827] rounded-md p-3 border border-slate-800/50"
          >
            <div className="flex justify-between items-center mb-2">
              <div className="flex items-center space-x-2">
                <span className="text-sm font-bold text-white bg-blue-500/10 px-2 py-0.5 rounded border border-blue-500/20 font-mono">
                  {item.ticker}
                </span>
                <span className="text-xs font-medium text-slate-400">
                  {Number(item.percentage || 0)}%
                </span>
              </div>
              <span className="text-sm font-semibold text-emerald-400 font-mono">
                ${Number(item.amount || 0).toFixed(2)}
              </span>
            </div>
            <div className="w-full bg-slate-800 rounded-full h-1.5 mb-3">
              <div
                className="bg-blue-500 h-1.5 rounded-full"
                style={{ width: `${Number(item.percentage || 0)}%` }}
              ></div>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed italic">
              "{item.reasoning}"
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function TradingChart({
  data,
  ticker,
}: {
  data: ChartPoint[];
  ticker: string;
}) {
  const [hoveredPoint, setHoveredPoint] = useState<ChartPoint | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  if (!data || data.length === 0) return null;

  const prices = data.map((d) => d.price);
  const minPrice = Math.min(...prices) * 0.99;
  const maxPrice = Math.max(...prices) * 1.01;
  const priceRange = maxPrice - minPrice;
  const width = 500;
  const height = 180;
  const paddingX = 40;
  const paddingY = 20;

  const points = data.map((d, index) => {
    const x =
      data.length > 1
        ? paddingX + (index / (data.length - 1)) * (width - paddingX * 2)
        : paddingX + (width - paddingX * 2) / 2;
    const y =
      priceRange > 0
        ? height -
          paddingY -
          ((d.price - minPrice) / priceRange) * (height - paddingY * 2)
        : height / 2;
    return { x, y, ...d };
  });

  const linePath = points.reduce(
    (path, p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `${path} L ${p.x} ${p.y}`),
    "",
  );
  const fillPath =
    points.length > 0
      ? `${linePath} L ${points[points.length - 1].x} ${height - paddingY} L ${points[0].x} ${height - paddingY} Z`
      : "";

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement, MouseEvent>) => {
    const svgRect = e.currentTarget.getBoundingClientRect();
    const svgX = (e.clientX - svgRect.left) * (width / svgRect.width);
    let closestIndex = 0;
    let minDiff = Infinity;
    points.forEach((p, idx) => {
      const diff = Math.abs(p.x - svgX);
      if (diff < minDiff) {
        minDiff = diff;
        closestIndex = idx;
      }
    });
    setHoverIndex(closestIndex);
    setHoveredPoint(data[closestIndex]);
  };
  const handleMouseLeave = () => {
    setHoveredPoint(null);
    setHoverIndex(null);
  };

  return (
    <div className="mt-4 bg-[#0B0F19] rounded-lg p-4 border border-slate-800/80 w-full select-none">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-blue-400 flex items-center">
          <Layers className="w-3.5 h-3.5 mr-1.5" />
          {ticker} 30-Day Trend
        </span>
        {hoveredPoint ? (
          <div className="text-right">
            <span className="text-xs text-slate-500 mr-2">
              {hoveredPoint.date}:
            </span>
            <span className="text-sm font-semibold text-white font-mono">
              ${hoveredPoint.price}
            </span>
          </div>
        ) : (
          <span className="text-xs text-slate-500">Hover graph</span>
        )}
      </div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-auto overflow-visible cursor-crosshair"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          <defs>
            <linearGradient id="chart-glow" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2563EB" stopOpacity="0.4" />
              <stop offset="100%" stopColor="#2563EB" stopOpacity="0.0" />
            </linearGradient>
          </defs>
          <line
            x1={paddingX}
            y1={paddingY}
            x2={width - paddingX}
            y2={paddingY}
            stroke="#1E293B"
            strokeDasharray="3,3"
          />
          <line
            x1={paddingX}
            y1={height / 2}
            x2={width - paddingX}
            y2={height / 2}
            stroke="#1E293B"
            strokeDasharray="3,3"
          />
          <line
            x1={paddingX}
            y1={height - paddingY}
            x2={width - paddingX}
            y2={height - paddingY}
            stroke="#1E293B"
            strokeDasharray="3,3"
          />
          <path d={fillPath} fill="url(#chart-glow)" />
          <path
            d={linePath}
            fill="none"
            stroke="#3B82F6"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <text
            x={paddingX - 10}
            y={paddingY + 4}
            fill="#64748B"
            fontSize="9"
            textAnchor="end"
            className="font-mono"
          >
            ${maxPrice.toFixed(0)}
          </text>
          <text
            x={paddingX - 10}
            y={height - paddingY + 4}
            fill="#64748B"
            fontSize="9"
            textAnchor="end"
            className="font-mono"
          >
            ${minPrice.toFixed(0)}
          </text>
          <text
            x={paddingX}
            y={height - 4}
            fill="#64748B"
            fontSize="9"
            textAnchor="start"
          >
            {data[0].date}
          </text>
          <text
            x={width - paddingX}
            y={height - 4}
            fill="#64748B"
            fontSize="9"
            textAnchor="end"
          >
            {data[data.length - 1].date}
          </text>
          {hoverIndex !== null && (
            <>
              <line
                x1={points[hoverIndex].x}
                y1={paddingY}
                x2={points[hoverIndex].x}
                y2={height - paddingY}
                stroke="#3B82F6"
                strokeWidth="1"
                strokeDasharray="2,2"
              />
              <circle
                cx={points[hoverIndex].x}
                cy={points[hoverIndex].y}
                r="6"
                fill="#3B82F6"
                opacity="0.3"
              />
              <circle
                cx={points[hoverIndex].x}
                cy={points[hoverIndex].y}
                r="3.5"
                fill="#60A5FA"
                stroke="#1E293B"
                strokeWidth="1"
              />
            </>
          )}
        </svg>
      </div>
    </div>
  );
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "1",
      role: "system",
      content:
        "AI Trading Engine initialized. Connected to Alpaca Live Market Environment.",
    },
  ]);
  const [inputMessage, setInputMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isLive, setIsLive] = useState(false);

  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([
    { ticker: "TSLA", name: "Tesla Inc.", price: 0, change: 0, isUp: true },
    { ticker: "AAPL", name: "Apple Inc.", price: 0, change: 0, isUp: true },
    {
      ticker: "VRNS",
      name: "Varonis Systems",
      price: 0,
      change: 0,
      isUp: true,
    },
    { ticker: "LUMI.TA", name: "Leumi Bank", price: 0, change: 0, isUp: true },
  ]);
  const [userPortfolio, setUserPortfolio] = useState<UserPortfolio | null>(
    null,
  );
  const [pendingOrders, setPendingOrders] = useState<PendingOrder[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () =>
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  useEffect(() => scrollToBottom(), [messages]);

  // LIVE STREAM HOOK (Re-added from previous phase)
  useEffect(() => {
    let isMounted = true;

    // Initial fetch to paint the screen immediately
    const fetchInitialData = async () => {
      try {
        const tickers = ["TSLA", "AAPL", "VRNS", "LUMI.TA"];
        const [wRes, pRes, oRes] = await Promise.all([
          fetch("http://localhost:3000/api/watchlist", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tickers }),
          }),
          fetch("http://localhost:3000/api/portfolio"),
          fetch("http://localhost:3000/api/orders"),
        ]);
        if (isMounted) {
          if (wRes.ok) setWatchlist(await wRes.json());
          if (pRes.ok) setUserPortfolio(await pRes.json());
          if (oRes.ok) setPendingOrders(await oRes.json());
        }
      } catch (error) {
        console.error("Initial data fetch error:", error);
      }
    };
    fetchInitialData();

    // Setup Server-Sent Events (SSE) for Real-Time Updates
    const eventSource = new EventSource("http://localhost:3000/api/stream");

    eventSource.onopen = () => setIsLive(true);
    eventSource.onerror = () => setIsLive(false);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "update" && isMounted) {
          setUserPortfolio(data.portfolio);
          setPendingOrders(data.orders);
          setWatchlist(data.watchlist);
        }
      } catch (e) {
        console.error("Error parsing stream data:", e);
      }
    };

    return () => {
      isMounted = false;
      eventSource.close();
    };
  }, []);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputMessage.trim()) return;
    const newUserMsg: Message = {
      id: Date.now().toString(),
      role: "user",
      content: inputMessage.trim(),
    };
    setMessages((prev) => [...prev, newUserMsg]);
    setInputMessage("");
    setIsLoading(true);

    try {
      const response = await fetch("http://localhost:3000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: newUserMsg.content,
          history: messages,
        }),
      });
      if (!response.ok) throw new Error("Network error");
      const data = await response.json();

      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: "agent",
          content: data.reply || "No response.",
          chartData: data.chartData,
          ticker: data.ticker,
          portfolio: data.portfolio,
          technicalData: data.technicalData,
          sentimentData: data.sentimentData,
        },
      ]);
    } catch (error) {
      console.error("Chat Error:", error);
      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: "system",
          content:
            "AI Service connection failed. Please ensure the backend is running.",
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0B0F19] text-slate-300 font-sans flex items-center justify-center p-2 sm:p-4 selection:bg-blue-500/30">
      <div className="w-full max-w-7xl bg-[#111827] rounded-xl shadow-2xl border border-slate-800 flex flex-col md:flex-row h-[92vh] overflow-hidden relative">
        <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-5 pointer-events-none"></div>

        <aside className="w-full md:w-80 bg-[#161D30] border-b md:border-b-0 md:border-r border-slate-800/80 p-5 flex flex-col shrink-0 z-10 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
          <div className="flex items-center space-x-3.5 mb-6">
            <div className="w-9 h-9 bg-blue-600/20 rounded-lg flex items-center justify-center border border-blue-500/20">
              <Activity className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <h2 className="text-md font-semibold text-white tracking-wide">
                Alexul-AI Hub
              </h2>
              <div className="flex items-center space-x-1.5">
                <span className="flex w-2.5 h-2.5 bg-emerald-500 rounded-full animate-pulse"></span>
                <span className="text-[11px] text-slate-400 font-mono">
                  NODE ACTIVE
                </span>
              </div>
            </div>
          </div>

          <div className="mb-6 bg-[#0B0F19] rounded-xl border border-slate-800/80 p-4">
            <div className="flex justify-between items-center mb-3">
              <h3 className="text-[10px] font-bold tracking-wider text-slate-500 uppercase flex items-center">
                <Wallet className="w-3 h-3 mr-1.5" /> Paper Trading
              </h3>
            </div>
            <div className="mb-3">
              <div className="text-[10px] text-slate-500 mb-0.5">
                Available Cash
              </div>
              <div className="text-xl font-bold text-white font-mono">
                ${userPortfolio?.balance.toFixed(2) || "0.00"}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="text-[10px] text-slate-500 mb-1 border-b border-slate-800 pb-1">
                Open Positions
              </div>
              {userPortfolio &&
              Object.keys(userPortfolio.positions).length > 0 ? (
                Object.entries(userPortfolio.positions).map(([tick, pos]) => {
                  const isProfit = (pos.pnl || 0) >= 0;
                  return (
                    <div
                      key={tick}
                      className="flex justify-between items-center text-xs"
                    >
                      <div>
                        <span className="font-mono text-blue-400 font-semibold">
                          {tick}
                        </span>
                        <span className="text-slate-500 block text-[9px]">
                          {pos.shares} shares @ ${pos.avgPrice.toFixed(2)}
                        </span>
                      </div>
                      <div className="text-right">
                        <span className="text-slate-200 block text-xs font-mono">
                          ${(pos.currentPrice || pos.avgPrice).toFixed(2)}
                        </span>
                        <span
                          className={`text-[9px] font-mono font-medium ${isProfit ? "text-emerald-400" : "text-rose-400"}`}
                        >
                          {isProfit ? "+" : ""}
                          {(pos.pnl || 0).toFixed(2)} (
                          {(pos.pnlPercent || 0).toFixed(2)}%)
                        </span>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="text-xs text-slate-500 italic">
                  No open positions.
                </div>
              )}
            </div>

            <div className="space-y-1.5 mt-4">
              <div className="text-[10px] text-slate-500 mb-1 border-b border-slate-800 pb-1">
                Pending Orders
              </div>
              {pendingOrders.length > 0 ? (
                pendingOrders.map((order) => (
                  <div
                    key={order.id}
                    className="flex justify-between items-center text-xs bg-slate-800/30 p-2 rounded border border-slate-700/50"
                  >
                    <div>
                      <span
                        className={`font-mono font-bold ${order.action === "BUY" ? "text-emerald-400" : "text-rose-400"}`}
                      >
                        {order.action}
                      </span>
                      <span className="font-mono text-white ml-1.5">
                        {order.qty}x {order.ticker}
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="text-[9px] text-slate-400 uppercase">
                        {order.orderType}
                      </span>
                      {order.limitPrice && (
                        <span className="text-slate-300 block text-[10px] font-mono">
                          Limit: ${order.limitPrice.toFixed(2)}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-xs text-slate-500 italic">
                  No pending orders.
                </div>
              )}
            </div>
          </div>

          <div className="space-y-2 mb-6">
            <h3 className="text-[10px] font-bold tracking-wider text-slate-500 uppercase">
              Quick Actions
            </h3>
            <div className="grid grid-cols-1 gap-1.5">
              <button
                onClick={() => setInputMessage("Buy 2 shares of TSLA")}
                className="w-full text-left text-xs bg-[#1F2937]/50 hover:bg-[#1F2937] border border-slate-800/80 px-3 py-2 rounded-md hover:border-slate-700 text-emerald-300 transition-all font-medium"
              >
                🛒 Buy 2 shares of TSLA
              </button>
              <button
                onClick={() => setInputMessage("Analyze recent news for AAPL")}
                className="w-full text-left text-xs bg-[#1F2937]/50 hover:bg-[#1F2937] border border-slate-800/80 px-3 py-2 rounded-md hover:border-slate-700 text-purple-300 transition-all font-medium"
              >
                📰 Analyze AAPL News
              </button>
              <button
                onClick={() =>
                  setInputMessage("Show me technical indicators for VRNS")
                }
                className="w-full text-left text-xs bg-[#1F2937]/50 hover:bg-[#1F2937] border border-slate-800/80 px-3 py-2 rounded-md hover:border-slate-700 text-orange-300 transition-all font-medium"
              >
                📊 VRNS Technicals
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-[10px] font-bold tracking-wider text-slate-500 uppercase">
                Local Watchlist
              </h3>
              <div className="flex items-center space-x-1.5 px-2 py-0.5 rounded-full bg-slate-800/50 border border-slate-700/50 shadow-inner">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${isLive ? "bg-emerald-500 animate-pulse shadow-[0_0_5px_#10B981]" : "bg-rose-500"}`}
                ></span>
                <span className="text-[9px] font-mono font-bold text-slate-400 tracking-widest">
                  {isLive ? "LIVE" : "SYNCING"}
                </span>
              </div>
            </div>

            <div className="space-y-1.5">
              {watchlist.map((stock) => (
                <div
                  key={stock.ticker}
                  className="flex items-center justify-between p-2.5 rounded bg-[#101524]/60 border border-slate-800/30 hover:border-slate-700 transition"
                >
                  <div>
                    <div className="text-xs font-bold text-white font-mono">
                      {stock.ticker}
                    </div>
                    <div className="text-[10px] text-slate-500 w-24 truncate">
                      {stock.name}
                    </div>
                  </div>
                  <div className="text-right">
                    {stock.price === 0 ? (
                      <div className="w-10 h-3 bg-slate-800 animate-pulse rounded ml-auto mb-1"></div>
                    ) : (
                      <div className="text-xs font-semibold font-mono text-slate-200">
                        ${stock.price.toFixed(2)}
                      </div>
                    )}
                    {stock.price === 0 ? (
                      <div className="w-8 h-2 bg-slate-800 animate-pulse rounded ml-auto"></div>
                    ) : (
                      <div
                        className={`text-[9px] flex items-center justify-end font-mono font-medium ${stock.isUp ? "text-emerald-400" : "text-rose-400"}`}
                      >
                        {stock.isUp ? (
                          <ArrowUpRight className="w-2.5 h-2.5 mr-0.5" />
                        ) : (
                          <ArrowDownRight className="w-2.5 h-2.5 mr-0.5" />
                        )}
                        {Math.abs(stock.change).toFixed(2)}%
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </aside>

        <section className="flex-1 flex flex-col h-full bg-[#111827] relative z-10 overflow-hidden">
          <header className="bg-[#181F30] border-b border-slate-800 px-6 py-4 flex items-center justify-between">
            <div>
              <h1 className="text-sm font-semibold text-white tracking-wide">
                Autonomous Engine Terminal
              </h1>
              <p className="text-[10px] text-slate-500 font-mono">
                PROMPT CONNECTION: GPT-4o-MINI // LIVE MARKET CONTEXT
              </p>
            </div>
            <div className="flex items-center space-x-2 text-xs">
              <span className="flex items-center bg-[#0B0F19] px-3 py-1.5 rounded border border-slate-800 text-[10px] font-mono text-emerald-400">
                <TrendingUp className="w-3.5 h-3.5 mr-1.5" />
                Live Feed Connective
              </span>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6 scroll-smooth scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[90%] md:max-w-[80%] rounded-xl px-4 py-3 shadow-sm flex items-start space-x-3.5 ${msg.role === "user" ? "bg-blue-600 text-white ml-auto rounded-br-sm" : msg.role === "system" ? "bg-rose-500/10 border border-rose-500/20 text-rose-300 w-full justify-center" : "bg-[#1F2937] border border-slate-800/80 text-slate-200 rounded-bl-sm"}`}
                >
                  {msg.role === "agent" && (
                    <div className="w-8 h-8 rounded bg-blue-500/10 border border-blue-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Bot className="w-4.5 h-4.5 text-blue-400" />
                    </div>
                  )}
                  {msg.role === "system" && (
                    <AlertTriangle className="w-5 h-5 text-rose-400 mt-0.5" />
                  )}

                  <div className="flex-1 overflow-hidden">
                    <p className="text-[13px] sm:text-[14px] leading-relaxed whitespace-pre-wrap">
                      {msg.content}
                    </p>

                    <TechnicalWidget data={msg.technicalData} />
                    <SentimentWidget data={msg.sentimentData} />
                    {msg.portfolio && (
                      <PortfolioWidget allocations={msg.portfolio} />
                    )}
                    {msg.chartData && (
                      <TradingChart
                        data={msg.chartData}
                        ticker={msg.ticker || "UNKNOWN"}
                      />
                    )}
                  </div>

                  {msg.role === "user" && (
                    <div className="w-8 h-8 rounded bg-slate-800 border border-slate-700 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <User className="w-4.5 h-4.5 text-slate-400" />
                    </div>
                  )}
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-[#1F2937] border border-slate-800/80 text-slate-200 rounded-xl rounded-bl-sm px-5 py-4 shadow-sm flex items-center space-x-4">
                  <div className="w-8 h-8 rounded bg-blue-500/10 border border-blue-500/20 flex items-center justify-center flex-shrink-0">
                    <Bot className="w-4.5 h-4.5 text-blue-400" />
                  </div>
                  <div className="flex space-x-1.5 items-center h-full">
                    <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce"></div>
                    <div
                      className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce"
                      style={{ animationDelay: "0.15s" }}
                    ></div>
                    <div
                      className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce"
                      style={{ animationDelay: "0.3s" }}
                    ></div>
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="p-4 bg-[#111827] border-t border-slate-800">
            <form
              onSubmit={handleSendMessage}
              className="flex items-center space-x-3 bg-[#192132] border border-slate-800 rounded-xl px-2 py-2 focus-within:ring-2 focus-within:ring-blue-500/40 focus-within:border-blue-500 transition-all duration-200"
            >
              <input
                type="text"
                value={inputMessage}
                onChange={(e) => setInputMessage(e.target.value)}
                placeholder="Ask e.g., 'Analyze recent news for AAPL'..."
                disabled={isLoading}
                className="flex-1 bg-transparent border-none focus:outline-none text-[13px] text-white placeholder-slate-500 px-4 py-2"
              />
              <button
                type="submit"
                disabled={isLoading || !inputMessage.trim()}
                className="bg-blue-600 text-white px-4 py-2.5 rounded-lg hover:bg-blue-500 disabled:opacity-50 disabled:hover:bg-blue-600 transition-colors shadow-sm flex items-center"
              >
                <Send className="w-4 h-4 mr-2" />
                <span className="text-xs sm:text-sm font-medium">Send</span>
              </button>
            </form>
          </div>
        </section>
      </div>
    </div>
  );
}
