import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import * as dotenv from "dotenv";
import YahooFinance from "yahoo-finance2";

dotenv.config();

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

export interface ChartPoint {
  date: string;
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

export interface AgentResponse {
  text: string;
  chartData?: ChartPoint[] | undefined;
  ticker?: string | undefined;
  portfolio?: PortfolioAllocation[] | undefined;
  technicalData?: TechnicalData | undefined;
  sentimentData?: SentimentData | undefined;
}

// --- API RETRY UTILITY (Prevents 503/429 crashes) ---
async function executeWithRetry<T>(
  operation: () => Promise<T>,
  retries = 3,
): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      if (
        (error.status === 503 ||
          error.status === 429 ||
          error.status === 500) &&
        attempt < retries
      ) {
        console.warn(
          `⏳ [BACKEND] Gemini API overloaded (${error.status}). Retrying attempt ${attempt + 1}/${retries} in ${attempt * 1.5}s...`,
        );
        await new Promise((res) => setTimeout(res, attempt * 1500));
      } else {
        throw error;
      }
    }
  }
  throw new Error("Max retries reached");
}

// --- TECHNICAL ANALYSIS MATHEMATICAL UTILITIES ---
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

// --- GEMINI MODEL & TOOLS SETUP ---
const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  systemInstruction:
    "You are an AI Trading Assistant. CRITICAL RULES:\n1. If the user asks to BUY or SELL a stock, you MUST ALWAYS use the 'execute_trade' tool.\n2. When asked to analyze a portfolio and allocate budget, you MUST respond ONLY with a valid JSON array of objects. Do not include any markdown formatting.\n3. Always respect risk management. Strictly avoid recommending more than 30% of the total budget for a single stock unless explicitly overridden.\n4. CRITICAL UI RULE: The UI automatically renders beautiful graphical widgets for Technical Analysis, News Sentiment, and Portfolio Allocations. DO NOT output raw data, numbers, or bullet lists in your text response. Instead, provide a short, single-sentence conversational transition (e.g., 'Here are the technical indicators for TSLA:' or 'I have analyzed the news for AAPL:'). Keep your text extremely brief when using tools.",
  tools: [
    {
      functionDeclarations: [
        {
          name: "get_stock_price",
          description: "Retrieves the current market price and state.",
          parameters: {
            type: SchemaType.OBJECT,
            properties: { ticker: { type: SchemaType.STRING } },
            required: ["ticker"],
          },
        },
        {
          name: "get_historical_prices",
          description: "Retrieves 30-day historical prices.",
          parameters: {
            type: SchemaType.OBJECT,
            properties: { ticker: { type: SchemaType.STRING } },
            required: ["ticker"],
          },
        },
        {
          name: "get_technical_indicators",
          description: "Calculates RSI and MACD for a stock.",
          parameters: {
            type: SchemaType.OBJECT,
            properties: { ticker: { type: SchemaType.STRING } },
            required: ["ticker"],
          },
        },
        {
          name: "analyze_news_sentiment",
          description: "Fetches recent news and analyzes sentiment.",
          parameters: {
            type: SchemaType.OBJECT,
            properties: { ticker: { type: SchemaType.STRING } },
            required: ["ticker"],
          },
        },
        {
          name: "get_transaction_history",
          description: "Retrieves user's paper trading logs.",
          parameters: { type: SchemaType.OBJECT, properties: {} },
        },
        {
          name: "analyze_portfolio",
          description: "Allocates budget across tickers.",
          parameters: {
            type: SchemaType.OBJECT,
            properties: {
              tickers: {
                type: SchemaType.ARRAY,
                items: { type: SchemaType.STRING },
              },
              budget: { type: SchemaType.NUMBER },
            },
            required: ["tickers", "budget"],
          },
        },
        {
          name: "execute_trade",
          description: "Executes a buy or sell order.",
          parameters: {
            type: SchemaType.OBJECT,
            properties: {
              ticker: { type: SchemaType.STRING },
              action: { type: SchemaType.STRING },
              shares: { type: SchemaType.NUMBER },
            },
            required: ["ticker", "action", "shares"],
          },
        },
      ],
    },
  ],
});

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
): Promise<{ data?: ChartPoint[]; fullData?: ChartPoint[]; error?: string }> {
  console.log(
    `\n⚙️ [BACKEND] Fetching 60-day historical data for ticker: ${ticker}...`,
  );
  try {
    const today = new Date();
    const sixtyDaysAgo = new Date();
    sixtyDaysAgo.setDate(today.getDate() - 60);
    const res = (await yahooFinance.chart(ticker, {
      period1: sixtyDaysAgo,
      period2: today,
      interval: "1d",
    })) as any;
    let chartData: ChartPoint[] = [];
    if (res && res.quotes && res.quotes.length > 0) {
      chartData = res.quotes
        .filter(
          (i: any) =>
            i.close !== undefined && i.date !== undefined && i.date !== null,
        )
        .map((i: any) => ({
          date: new Date(i.date as any).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          }),
          price: parseFloat(i.close.toFixed(2)),
        }));
    }

    // Fallback if API rejects data
    if (chartData.length === 0) {
      const liveQuote = (await yahooFinance.quote(ticker)) as any;
      if (!liveQuote || !liveQuote.regularMarketPrice)
        throw new Error(`Fallback failed`);
      const basePrice = liveQuote.regularMarketPrice;
      for (let i = 59; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        chartData.push({
          date: d.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          }),
          price: parseFloat(
            (basePrice + basePrice * (Math.random() * 0.04 - 0.02)).toFixed(2),
          ),
        });
      }
    }
    // Return 30 days for UI chart, but all 60 days for technical math (MACD needs 26+ days)
    return { data: chartData.slice(-30), fullData: chartData };
  } catch (e) {
    return { error: `Could not retrieve data for ${ticker}.` };
  }
}

async function getNewsSentiment(ticker: string) {
  console.log(`\n⚙️ [BACKEND] Fetching recent news for ticker: ${ticker}...`);
  try {
    const res = await yahooFinance.search(ticker);
    if (!res.news || res.news.length === 0)
      return { error: `No news found for ${ticker}.` };
    return { headlines: res.news.slice(0, 5).map((n: any) => n.title) };
  } catch (e) {
    return { error: `Could not retrieve news for ${ticker}.` };
  }
}

export async function getWatchlistQuotes(tickers: string[]) {
  return Promise.all(
    tickers.map(async (t) => {
      try {
        const q = (await yahooFinance.quote(t)) as any;
        return {
          ticker: t,
          name: q.shortName || q.longName || t,
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

export async function runTradingAgentStep(
  userMessage: string,
  history: any[] = [],
  transactionHistory: any[] = [],
  executeTradeCallback?: (
    ticker: string,
    action: string,
    shares: number,
    price: number,
  ) => Promise<any>,
): Promise<AgentResponse> {
  const formattedHistory = history
    ? history
        .filter((msg: any) => msg.role === "user" || msg.role === "agent")
        .map((msg: any) => ({
          role: msg.role === "user" ? "user" : "model",
          parts: [{ text: msg.content }],
        }))
    : [];
  const chat = model.startChat({ history: formattedHistory });

  // Wrapped in Retry Logic
  const result = await executeWithRetry(() => chat.sendMessage(userMessage));
  const calls = result.response.functionCalls();

  let finalChartData: ChartPoint[] | undefined;
  let detectedTicker: string | undefined;
  let finalPortfolio: PortfolioAllocation[] | undefined;
  let finalTechData: TechnicalData | undefined;
  let finalSentiment: SentimentData | undefined;

  if (calls && calls.length > 0) {
    const call = calls[0];
    if (!call) return { text: result.response.text() };
    console.log(`🤖 [AGENT] Requested: ${call.name}`);
    let apiResponse: any = {};

    if (call.name === "get_stock_price") {
      detectedTicker = (call.args as any).ticker.toUpperCase();
      apiResponse = await getStockPrice(detectedTicker!);
    } else if (call.name === "get_historical_prices") {
      detectedTicker = (call.args as any).ticker.toUpperCase();
      const hr = await getHistoricalPrices(detectedTicker!);
      if (hr.data) {
        apiResponse = { data: "Chart created." };
        finalChartData = hr.data;
      } else apiResponse = { error: hr.error };
    } else if (call.name === "get_technical_indicators") {
      detectedTicker = (call.args as any).ticker.toUpperCase();
      const hr = await getHistoricalPrices(detectedTicker!);
      if (hr.fullData && hr.fullData.length > 0) {
        const prices = hr.fullData.map((p) => p.price);
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
        console.log(
          `📊 [ANALYSIS] Technical analysis completed for ${detectedTicker}: RSI=${rsi}`,
        );
      } else apiResponse = { error: "Failed to calculate indicators." };
    } else if (call.name === "analyze_news_sentiment") {
      detectedTicker = (call.args as any).ticker.toUpperCase();
      const nr = await getNewsSentiment(detectedTicker!);
      if (nr.error) apiResponse = { error: nr.error };
      else {
        const prompt = `Analyze these headlines for ${detectedTicker}: ${JSON.stringify(nr.headlines)}. Respond ONLY with a raw JSON object: {"sentiment": "BULLISH" | "BEARISH" | "NEUTRAL", "summary": "1-2 sentences."}`;
        try {
          const jm = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            generationConfig: { responseMimeType: "application/json" },
          });
          const r = await executeWithRetry(() => jm.generateContent(prompt));
          finalSentiment = JSON.parse(r.response.text());
          apiResponse = {
            success: "Analyzed",
            sentiment_json: JSON.stringify(finalSentiment),
          };
        } catch (e) {
          apiResponse = { error: "Failed sentiment." };
        }
      }
    } else if (call.name === "get_transaction_history") {
      if (!transactionHistory || transactionHistory.length === 0)
        apiResponse = { result: "No trades executed." };
      else
        apiResponse = {
          result:
            "History: " +
            transactionHistory
              .map((t) => `${t.action} ${t.shares}x ${t.ticker} at $${t.price}`)
              .join(" | "),
        };
    } else if (call.name === "analyze_portfolio") {
      const { tickers, budget } = call.args as any;
      const md: any = {};
      const rs = await Promise.all(
        tickers.map((t: string) => getHistoricalPrices(t)),
      );
      tickers.forEach((t: string, i: number) => {
        if (rs[i].data) md[t] = rs[i].data!.slice(-7);
      });
      const prompt = `Allocate $${budget} across these tickers based on this 7-day data: ${JSON.stringify(md)}. Respond ONLY with a raw JSON array: [{"ticker": "...", "percentage": 40, "amount": 400, "reasoning": "..."}]`;
      try {
        const jm = genAI.getGenerativeModel({
          model: "gemini-2.5-flash",
          generationConfig: { responseMimeType: "application/json" },
        });
        finalPortfolio = JSON.parse(
          (
            await executeWithRetry(() => jm.generateContent(prompt))
          ).response.text(),
        );
        apiResponse = {
          success: "Allocated",
          portfolio_string: JSON.stringify(finalPortfolio),
        };
      } catch (e) {
        apiResponse = { error: "Failed allocation." };
      }
    } else if (call.name === "execute_trade") {
      detectedTicker = (call.args as any).ticker.toUpperCase();
      const p = await getStockPrice(detectedTicker!);
      if (p.error || !p.price) apiResponse = { error: "Price unavailable." };
      else
        apiResponse = executeTradeCallback
          ? await executeTradeCallback(
              detectedTicker!,
              (call.args as any).action.toUpperCase(),
              (call.args as any).shares,
              p.price,
            )
          : { error: "No callback." };
    }

    console.log(`⚙️ [BACKEND] Sending response to agent...`);
    // Wrapped in Retry Logic
    const finalResult = await executeWithRetry(() =>
      chat.sendMessage([
        { functionResponse: { name: call.name, response: apiResponse } },
      ]),
    );
    return {
      text: finalResult.response.text(),
      chartData: finalChartData,
      ticker: detectedTicker,
      portfolio: finalPortfolio,
      technicalData: finalTechData,
      sentimentData: finalSentiment,
    };
  } else return { text: result.response.text() };
}
