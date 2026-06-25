import { OpenAI } from "openai";
import * as dotenv from "dotenv";
import YahooFinance from "yahoo-finance2";

dotenv.config();

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  maxRetries: 5,
});

export interface ChartPoint {
  date: string;
  time: string;
  price: number;
}
export interface PortfolioAllocation {
  ticker: string;
  percentage: number;
  amount: number;
  reasoning: string;
}
export interface TechnicalData {
  rsi: number;
  macd: number;
  signal: number;
  histogram: number;
  state: string;
}
export interface SentimentData {
  sentiment: "BULLISH" | "BEARISH" | "NEUTRAL";
  summary: string;
}
export interface FundamentalData {
  ticker: string;
  marketCap: string;
  peRatio: string;
  forwardPE: string;
  dividendYield: string;
  fiftyTwoWeekHigh: string;
  fiftyTwoWeekLow: string;
  analystRating: string;
}

export interface AgentResponse {
  text: string;
  chartData?: ChartPoint[] | undefined;
  ticker?: string | undefined;
  portfolio?: PortfolioAllocation[] | undefined;
  technicalData?: TechnicalData | undefined;
  sentimentData?: SentimentData | undefined;
  fundamentalData?: FundamentalData | undefined;
}

// --- TECHNICAL ANALYSIS ---
function calculateRSI(prices: number[], periods = 14): number {
  if (prices.length <= periods) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= periods; i++) {
    const diff = (prices[i] ?? 0) - (prices[i - 1] ?? 0);
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / periods;
  let avgLoss = losses / periods;
  for (let i = periods + 1; i < prices.length; i++) {
    const diff = (prices[i] ?? 0) - (prices[i - 1] ?? 0);
    avgGain = (avgGain * (periods - 1) + (diff > 0 ? diff : 0)) / periods;
    avgLoss = (avgLoss * (periods - 1) + (diff < 0 ? -diff : 0)) / periods;
  }
  if (avgLoss === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
}

function calculateEMA(prices: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [];
  if (prices.length === 0) return ema;
  ema.push(prices[0] ?? 0);
  for (let i = 1; i < prices.length; i++)
    ema.push((prices[i] ?? 0) * k + (ema[i - 1] ?? 0) * (1 - k));
  return ema;
}

function calculateMACD(prices: number[]): {
  macd: number;
  signal: number;
  histogram: number;
} {
  if (prices.length < 26) return { macd: 0, signal: 0, histogram: 0 };
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  const macdLine = prices.map((_, i) => (ema12[i] ?? 0) - (ema26[i] ?? 0));
  const signalLine = calculateEMA(macdLine.slice(25), 9);
  const currentMacd = macdLine[macdLine.length - 1] ?? 0;
  const currentSignal = signalLine[signalLine.length - 1] ?? 0;
  return {
    macd: parseFloat(currentMacd.toFixed(4)),
    signal: parseFloat(currentSignal.toFixed(4)),
    histogram: parseFloat((currentMacd - currentSignal).toFixed(4)),
  };
}

// --- OPENAI TOOLS SETUP ---
const SYSTEM_PROMPT = `You are an AI Trading Assistant. STRICT UI AND BEHAVIOR RULES:
1. NEVER pretend to execute trades using plain text. ALWAYS invoke 'execute_trade'.
2. STRICT RULE AGAINST DATA ECHOING: When you invoke tools like 'get_fundamental_data', 'get_technical_indicators', or 'analyze_portfolio', the user interface will automatically render beautiful widgets with the exact raw numbers (e.g., P/E ratio, Market Cap). DO NOT output bullet points repeating these numbers in your text response. Simply acknowledge the data and provide a high-level analytical conclusion.
3. When asked to analyze a portfolio, respond ONLY with a valid JSON array.
4. RISK MANAGEMENT IS AUTOMATIC: BUY orders automatically attach Stop-Loss (-5%) and Take-Profit (+15%).
5. CHARTS: ALWAYS invoke 'get_historical_prices' if the user asks for a chart.
6. FUNDAMENTALS: Invoke 'get_fundamental_data' for valuation, P/E, market cap, dividends.
7. AUTOPILOT MODE: If the user prompt starts with "[AUTOPILOT MODE]", you are running autonomously. Make decisions quickly. Keep your text response extremely brief (1-2 sentences max). Do not ask follow-up questions in autopilot mode.`;

const tools: any[] = [
  {
    type: "function",
    function: {
      name: "get_stock_price",
      description: "Retrieves the current market price and state.",
      parameters: {
        type: "object",
        properties: { ticker: { type: "string" } },
        required: ["ticker"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_historical_prices",
      description: "Retrieves 30-day historical prices.",
      parameters: {
        type: "object",
        properties: { ticker: { type: "string" } },
        required: ["ticker"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_technical_indicators",
      description: "Calculates RSI and MACD for a stock.",
      parameters: {
        type: "object",
        properties: { ticker: { type: "string" } },
        required: ["ticker"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_news_sentiment",
      description: "Fetches recent news and analyzes sentiment.",
      parameters: {
        type: "object",
        properties: { ticker: { type: "string" } },
        required: ["ticker"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_transaction_history",
      description: "Retrieves user's paper trading logs.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_portfolio",
      description: "Allocates budget across tickers.",
      parameters: {
        type: "object",
        properties: {
          tickers: { type: "array", items: { type: "string" } },
          budget: { type: "number" },
        },
        required: ["tickers", "budget"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_trade",
      description: "Executes a buy or sell order.",
      parameters: {
        type: "object",
        properties: {
          ticker: { type: "string" },
          action: { type: "string", description: "BUY or SELL" },
          shares: { type: "number" },
          orderType: { type: "string", description: "'market' or 'limit'" },
          limitPrice: { type: "number" },
          stopLoss: { type: "number" },
          takeProfit: { type: "number" },
        },
        required: ["ticker", "action", "shares"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_fundamental_data",
      description:
        "Retrieves deep fundamental data for a stock (P/E, Market Cap, Dividends, 52-Week High/Low).",
      parameters: {
        type: "object",
        properties: { ticker: { type: "string" } },
        required: ["ticker"],
      },
    },
  },
];

async function getStockPrice(ticker: string) {
  try {
    const q = (await yahooFinance.quote(ticker)) as any;
    return {
      price: q.regularMarketPrice,
      currency: q.currency || "USD",
      exchange: q.exchange,
      marketState: q.marketState || "UNKNOWN",
    };
  } catch (e) {
    return { error: `Data for ${ticker} not found.` };
  }
}

async function getHistoricalPrices(
  ticker: string,
  days = 30,
): Promise<{ data?: ChartPoint[]; error?: string }> {
  try {
    const today = new Date();
    const pastDate = new Date();
    pastDate.setDate(today.getDate() - days);
    const res = (await yahooFinance.chart(ticker, {
      period1: pastDate,
      period2: today,
      interval: "1d",
    })) as any;
    if (res && res.quotes && res.quotes.length > 0) {
      return {
        data: res.quotes
          .filter((i: any) => i.close !== undefined && i.date !== undefined)
          .map((i: any) => {
            const d = new Date(i.date as any);
            return {
              date: d.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              }),
              time: d.toISOString().split("T")[0],
              price: parseFloat(i.close.toFixed(2)),
            };
          }),
      };
    }
    return { data: [] };
  } catch (e) {
    return { error: `Could not retrieve data for ${ticker}.` };
  }
}

async function getNewsSentiment(ticker: string) {
  try {
    const res = await yahooFinance.search(ticker);
    if (!res.news || res.news.length === 0)
      return { error: `No news found for ${ticker}.` };
    return { headlines: res.news.slice(0, 5).map((n: any) => n.title) };
  } catch (e) {
    return { error: `Could not retrieve news for ${ticker}.` };
  }
}

async function getFundamentalData(ticker: string) {
  try {
    const quote = (await yahooFinance.quote(ticker)) as any;

    const formatNumber = (num: number) => {
      if (!num) return "N/A";
      if (num >= 1e12) return (num / 1e12).toFixed(2) + " Trillion";
      if (num >= 1e9) return (num / 1e9).toFixed(2) + " Billion";
      if (num >= 1e6) return (num / 1e6).toFixed(2) + " Million";
      return num.toLocaleString();
    };

    return {
      ticker: ticker.toUpperCase(),
      marketCap: formatNumber(quote.marketCap),
      peRatio: quote.trailingPE ? quote.trailingPE.toFixed(2) : "N/A",
      forwardPE: quote.forwardPE ? quote.forwardPE.toFixed(2) : "N/A",
      dividendYield: quote.trailingAnnualDividendYield
        ? (quote.trailingAnnualDividendYield * 100).toFixed(2) + "%"
        : "0.00%",
      fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh
        ? quote.fiftyTwoWeekHigh.toFixed(2)
        : "N/A",
      fiftyTwoWeekLow: quote.fiftyTwoWeekLow
        ? quote.fiftyTwoWeekLow.toFixed(2)
        : "N/A",
      analystRating: quote.averageAnalystRating
        ? quote.averageAnalystRating.toString()
        : "N/A",
    };
  } catch (e) {
    return { error: `Fundamental data for ${ticker} could not be retrieved.` };
  }
}

export async function getWatchlistQuotes(tickers: string[]) {
  return Promise.all(
    tickers.map(async (t) => {
      try {
        const q = (await yahooFinance.quote(t)) as any;
        return {
          ticker: t,
          name: q.shortName || t,
          price: q.regularMarketPrice || 0,
          change: parseFloat((q.regularMarketChangePercent || 0).toFixed(2)),
          isUp: (q.regularMarketChangePercent || 0) >= 0,
        };
      } catch {
        return {
          ticker: t,
          name: t + " (N/A)",
          price: 0,
          change: 0,
          isUp: true,
        };
      }
    }),
  );
}

export async function getTrendingStocks(): Promise<string[]> {
  try {
    const query = await yahooFinance.screener({
      scrIds: "day_gainers",
      count: 5,
    });
    if (query && query.quotes) {
      return query.quotes.map((q: any) => q.symbol);
    }
    return ["NVDA", "AAPL", "TSLA", "MSFT", "AMD"]; // Fallback
  } catch (error) {
    console.error("[SCREENER] Error fetching trending stocks:", error);
    return ["NVDA", "AAPL", "TSLA", "MSFT", "AMD"]; // Fallback
  }
}

export async function runTradingAgentStep(
  userMessage: string,
  history: any[] = [],
  transactionHistory: any[] = [],
  executeTradeCallback?: (
    ticker: string,
    action: string,
    shares: number,
    orderType: string,
    limitPrice?: number,
    stopLoss?: number,
    takeProfit?: number,
  ) => Promise<any>,
): Promise<AgentResponse> {
  const messages: any[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history
      .filter((msg: any) => msg.role === "user" || msg.role === "agent")
      .map((msg: any) => ({
        role: msg.role === "agent" ? "assistant" : "user",
        content: msg.content,
      })),
    { role: "user", content: userMessage },
  ];

  let finalChartData: ChartPoint[] | undefined;
  let detectedTicker: string | undefined;
  let finalPortfolio: PortfolioAllocation[] | undefined;
  let finalTechData: TechnicalData | undefined;
  let finalSentiment: SentimentData | undefined;
  let finalFundamental: FundamentalData | undefined;

  let response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: messages,
    tools: tools,
  });
  let message = response.choices[0]?.message;

  // АВТОМАТИЧЕСКАЯ ЦЕПОЧКА ДЕЙСТВИЙ (до 3 шагов)
  let iterations = 0;
  const MAX_ITERATIONS = 3;

  while (
    message &&
    message.tool_calls &&
    message.tool_calls.length > 0 &&
    iterations < MAX_ITERATIONS
  ) {
    messages.push(message);

    for (const toolCall of message.tool_calls) {
      if (toolCall.type !== "function") continue;

      const args = JSON.parse(toolCall.function.arguments);
      const funcName = toolCall.function.name;

      console.log(`[AGENT] Requested: ${funcName}`);
      let apiResponse: any = {};

      if (funcName === "get_stock_price") {
        detectedTicker = args.ticker.toUpperCase();
        apiResponse = await getStockPrice(detectedTicker!);
      } else if (funcName === "get_historical_prices") {
        detectedTicker = args.ticker.toUpperCase();
        const hr = await getHistoricalPrices(detectedTicker!, 30);
        if (hr.data) {
          apiResponse = { data: "Chart created." };
          finalChartData = hr.data;
        } else apiResponse = { error: hr.error };
      } else if (funcName === "get_technical_indicators") {
        detectedTicker = args.ticker.toUpperCase();
        const hr = await getHistoricalPrices(detectedTicker!, 60);
        if (hr.data && hr.data.length > 0) {
          const prices = hr.data.map((p) => p.price);
          const rsi = calculateRSI(prices, 14);
          const macd = calculateMACD(prices);
          finalTechData = {
            rsi,
            macd: macd.macd,
            signal: macd.signal,
            histogram: macd.histogram,
            state: rsi > 70 ? "OVERBOUGHT" : rsi < 30 ? "OVERSOLD" : "NEUTRAL",
          };
          apiResponse = { ticker: detectedTicker, ...finalTechData };
        } else apiResponse = { error: "Failed to calculate indicators." };
      } else if (funcName === "analyze_news_sentiment") {
        detectedTicker = args.ticker.toUpperCase();
        const nr = await getNewsSentiment(detectedTicker!);
        if (nr.error) apiResponse = { error: nr.error };
        else {
          const prompt = `Analyze these headlines for ${detectedTicker}: ${JSON.stringify(nr.headlines)}. Respond ONLY with a JSON object format: {"sentiment": "BULLISH" | "BEARISH" | "NEUTRAL", "summary": "1-2 sentences."}`;
          try {
            const jm = await openai.chat.completions.create({
              model: "gpt-4o-mini",
              messages: [{ role: "user", content: prompt }],
              response_format: { type: "json_object" },
            });
            finalSentiment = JSON.parse(
              jm.choices[0]?.message?.content || "{}",
            );
            apiResponse = {
              success: "Analyzed",
              sentiment_json: JSON.stringify(finalSentiment),
            };
          } catch (e) {
            apiResponse = { error: "Failed sentiment." };
          }
        }
      } else if (funcName === "get_transaction_history") {
        if (!transactionHistory || transactionHistory.length === 0)
          apiResponse = { result: "No trades executed." };
        else
          apiResponse = {
            result:
              "History: " +
              transactionHistory
                .map(
                  (t) => `${t.action} ${t.shares}x ${t.ticker} at $${t.price}`,
                )
                .join(" | "),
          };
      } else if (funcName === "analyze_portfolio") {
        const { tickers, budget } = args;
        const md: any = {};
        const rs = await Promise.all(
          tickers.map((t: string) => getHistoricalPrices(t, 30)),
        );
        tickers.forEach((t: string, i: number) => {
          if (rs[i].data) md[t] = rs[i].data!.slice(-7);
        });
        const prompt = `Allocate $${budget} across these tickers based on this 7-day data: ${JSON.stringify(md)}. Respond ONLY with a JSON object containing a "portfolio" array: {"portfolio": [{"ticker": "...", "percentage": 40, "amount": 400, "reasoning": "..."}]}`;
        try {
          const jm = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" },
          });
          finalPortfolio = JSON.parse(
            jm.choices[0]?.message?.content || "{}",
          ).portfolio;
          apiResponse = {
            success: "Allocated",
            portfolio_string: JSON.stringify(finalPortfolio),
          };
        } catch (e) {
          apiResponse = { error: "Failed allocation." };
        }
      } else if (funcName === "execute_trade") {
        detectedTicker = args.ticker.toUpperCase();
        const p = await getStockPrice(detectedTicker!);
        if (p.error || !p.price) {
          apiResponse = { error: "Price unavailable." };
        } else {
          const orderType = args.orderType || "market";
          let limitPrice = args.limitPrice;
          let finalStopLoss = args.stopLoss;
          let finalTakeProfit = args.takeProfit;

          if (args.action.toUpperCase() === "BUY") {
            const basePrice = limitPrice || p.price;
            if (!finalStopLoss)
              finalStopLoss = parseFloat((basePrice * 0.95).toFixed(2));
            if (!finalTakeProfit)
              finalTakeProfit = parseFloat((basePrice * 1.15).toFixed(2));
            console.log(
              `🛡️ [RISK MANAGEMENT] Auto-calculated SL: $${finalStopLoss}, TP: $${finalTakeProfit} for ${detectedTicker}`,
            );
          }

          apiResponse = executeTradeCallback
            ? await executeTradeCallback(
                detectedTicker!,
                args.action.toUpperCase(),
                args.shares,
                orderType,
                limitPrice || p.price,
                finalStopLoss,
                finalTakeProfit,
              )
            : { error: "No callback." };
        }
      } else if (funcName === "get_fundamental_data") {
        detectedTicker = args.ticker.toUpperCase();
        apiResponse = await getFundamentalData(detectedTicker!);
        if (!apiResponse.error) {
          finalFundamental = apiResponse as FundamentalData;
        }
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(apiResponse),
      });
    }

    // ПЕРЕЗАПРАШИВАЕМ ИИ С НОВЫМИ ДАННЫМИ
    response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messages,
      tools: tools,
    });
    message = response.choices[0]?.message;
    iterations++;
  }

  const replyText = message?.content || "No response generated.";

  return {
    text: replyText,
    chartData: finalChartData,
    ticker: detectedTicker,
    portfolio: finalPortfolio,
    technicalData: finalTechData,
    sentimentData: finalSentiment,
    fundamentalData: finalFundamental,
  };
}
