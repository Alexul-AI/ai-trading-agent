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
  Briefcase,
} from "lucide-react";

interface ISeriesApi {
  setData(data: Array<{ time: string; value: number }>): void;
}

interface ITimeScaleApi {
  fitContent(): void;
}

interface IChartApi {
  addAreaSeries(options: {
    lineColor: string;
    topColor: string;
    bottomColor: string;
    lineWidth: number;
  }): ISeriesApi;
  timeScale(): ITimeScaleApi;
  applyOptions(options: { width: number }): void;
  remove(): void;
}

interface LightweightChartsAPI {
  createChart(
    container: HTMLElement,
    options: Record<string, unknown>,
  ): IChartApi;
  ColorType: { Solid: string };
}

declare global {
  interface Window {
    LightweightCharts?: LightweightChartsAPI;
  }
}

interface ChartPoint {
  date: string;
  time: string;
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
interface FundamentalData {
  ticker: string;
  marketCap: string;
  peRatio: string;
  forwardPE: string;
  dividendYield: string;
  fiftyTwoWeekHigh: string;
  fiftyTwoWeekLow: string;
  analystRating: string;
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
  fundamentalData?: FundamentalData;
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

// --- WIDGETS ---
function FundamentalWidget({ data }: { data?: FundamentalData }) {
  if (!data) return null;
  return (
    <div className="mt-4 bg-[#0B0F19] rounded-lg p-4 border border-slate-800/80 w-full">
      <div className="flex items-center mb-4 pb-3 border-b border-slate-800/80">
        <Briefcase className="w-4 h-4 text-blue-400 mr-2" />
        <span className="text-xs font-semibold uppercase tracking-wider text-blue-400">
          Fundamental Analysis
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div className="bg-[#111827] p-2.5 rounded border border-slate-800/50">
          <div className="text-[10px] text-slate-500 mb-0.5">Market Cap</div>
          <div className="font-mono text-xs text-white font-bold">
            {data.marketCap}
          </div>
        </div>
        <div className="bg-[#111827] p-2.5 rounded border border-slate-800/50">
          <div className="text-[10px] text-slate-500 mb-0.5">P/E Ratio</div>
          <div className="font-mono text-xs text-white font-bold">
            {data.peRatio}
          </div>
        </div>
        <div className="bg-[#111827] p-2.5 rounded border border-slate-800/50">
          <div className="text-[10px] text-slate-500 mb-0.5">Forward P/E</div>
          <div className="font-mono text-xs text-white font-bold">
            {data.forwardPE}
          </div>
        </div>
        <div className="bg-[#111827] p-2.5 rounded border border-slate-800/50">
          <div className="text-[10px] text-slate-500 mb-0.5">Div Yield</div>
          <div className="font-mono text-xs text-white font-bold">
            {data.dividendYield}
          </div>
        </div>
        <div className="bg-[#111827] p-2.5 rounded border border-slate-800/50">
          <div className="text-[10px] text-slate-500 mb-0.5">52W High</div>
          <div className="font-mono text-xs text-emerald-400 font-bold">
            ${data.fiftyTwoWeekHigh}
          </div>
        </div>
        <div className="bg-[#111827] p-2.5 rounded border border-slate-800/50">
          <div className="text-[10px] text-slate-500 mb-0.5">52W Low</div>
          <div className="font-mono text-xs text-rose-400 font-bold">
            ${data.fiftyTwoWeekLow}
          </div>
        </div>
      </div>
      <div className="mt-3 bg-[#111827] p-2.5 rounded border border-slate-800/50 flex justify-between items-center">
        <span className="text-[10px] text-slate-500">
          Analyst Rating (1=Buy, 5=Sell)
        </span>
        <span className="font-mono text-xs text-emerald-400 font-bold">
          {data.analystRating}
        </span>
      </div>
    </div>
  );
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
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!chartContainerRef.current || !data || data.length === 0) return;

    const handleResize = () => {
      if (chartRef.current && chartContainerRef.current) {
        chartRef.current.applyOptions({
          width: chartContainerRef.current.clientWidth,
        });
      }
    };

    const renderChart = () => {
      if (!chartContainerRef.current) return;

      chartContainerRef.current.innerHTML = "";

      const LightweightCharts = window.LightweightCharts;
      if (!LightweightCharts) return;

      const chart = LightweightCharts.createChart(chartContainerRef.current, {
        layout: {
          background: {
            type: LightweightCharts.ColorType.Solid,
            color: "transparent",
          },
          textColor: "#64748B",
        },
        grid: {
          vertLines: { color: "rgba(30, 41, 59, 0.3)" },
          horzLines: { color: "rgba(30, 41, 59, 0.3)" },
        },
        width: chartContainerRef.current.clientWidth,
        height: 250,
        timeScale: { timeVisible: false, borderColor: "rgba(30, 41, 59, 0.5)" },
        rightPriceScale: { borderColor: "rgba(30, 41, 59, 0.5)" },
        handleScroll: { mouseWheel: false, pressedMouseMove: false },
        handleScale: {
          axisPressedMouseMove: false,
          mouseWheel: false,
          pinch: false,
        },
      } as Record<string, unknown>);

      chartRef.current = chart;

      const areaSeries = chart.addAreaSeries({
        lineColor: "#3B82F6",
        topColor: "rgba(59, 130, 246, 0.4)",
        bottomColor: "rgba(59, 130, 246, 0.0)",
        lineWidth: 2,
      });

      const formattedData = data
        .map((d) => ({
          time: d.time,
          value: d.price,
        }))
        .sort(
          (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime(),
        );

      areaSeries.setData(formattedData);
      chart.timeScale().fitContent();

      window.addEventListener("resize", handleResize);
    };

    if (!window.LightweightCharts) {
      const script = document.createElement("script");
      script.src =
        "https://unpkg.com/lightweight-charts/dist/lightweight-charts.standalone.production.js";
      script.async = true;
      script.onload = renderChart;
      document.head.appendChild(script);
    } else {
      renderChart();
    }

    return () => {
      window.removeEventListener("resize", handleResize);
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
    };
  }, [data]);

  if (!data || data.length === 0) return null;

  return (
    <div className="mt-4 bg-[#0B0F19] rounded-lg p-4 border border-slate-800/80 w-full">
      <div className="flex items-center justify-between mb-4">
        <span className="text-xs font-semibold uppercase tracking-wider text-blue-400 flex items-center">
          <Layers className="w-3.5 h-3.5 mr-1.5" />
          {ticker} 30-Day Trend
        </span>
      </div>
      <div ref={chartContainerRef} className="w-full relative" />
    </div>
  );
}

// --- MAIN APP ---
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

  useEffect(() => {
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
        if (wRes.ok) setWatchlist(await wRes.json());
        if (pRes.ok) setUserPortfolio(await pRes.json());
        if (oRes.ok) setPendingOrders(await oRes.json());
      } catch (error) {
        console.error("Initial data fetch error:", error);
      }
    };
    fetchInitialData();

    const eventSource = new EventSource("http://localhost:3000/api/stream");

    eventSource.onopen = () => setIsLive(true);
    eventSource.onerror = () => setIsLive(false);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "update") {
          setUserPortfolio(data.portfolio);
          setPendingOrders(data.orders);
          setWatchlist(data.watchlist);
        }
      } catch (e) {
        console.error("Error parsing stream data:", e);
      }
    };

    return () => {
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
          fundamentalData: data.fundamentalData,
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
                  setInputMessage("What are the fundamentals for MSFT?")
                }
                className="w-full text-left text-xs bg-[#1F2937]/50 hover:bg-[#1F2937] border border-slate-800/80 px-3 py-2 rounded-md hover:border-slate-700 text-blue-300 transition-all font-medium"
              >
                💼 MSFT Fundamentals
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

                    <FundamentalWidget data={msg.fundamentalData} />
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
                <div className="bg-[#111827] border border-slate-800/80 text-slate-200 rounded-xl rounded-bl-sm px-5 py-4 shadow-sm flex items-center space-x-4">
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
                placeholder="Ask e.g., 'What are the fundamentals for MSFT?'..."
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
