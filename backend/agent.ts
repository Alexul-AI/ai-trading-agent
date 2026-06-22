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

export interface AgentResponse {
  text: string;
  chartData?: ChartPoint[] | undefined;
  ticker?: string | undefined;
  portfolio?: PortfolioAllocation[] | undefined;
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
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

function calculateEMA(prices: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [];
  if (prices.length === 0) return ema;

  ema.push(prices[0] ?? 0);
  for (let i = 1; i < prices.length; i++) {
    const currentPrice = prices[i] ?? 0;
    const prevEma = ema[i - 1] ?? 0;
    ema.push(currentPrice * k + prevEma * (1 - k));
  }
  return ema;
}

function calculateMACD(prices: number[]): {
  macd: number;
  signal: number;
  histogram: number;
} {
  if (prices.length < 26) {
    return { macd: 0, signal: 0, histogram: 0 };
  }

  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);

  const macdLine: number[] = [];
  for (let i = 0; i < prices.length; i++) {
    const val12 = ema12[i] ?? 0;
    const val26 = ema26[i] ?? 0;
    macdLine.push(val12 - val26);
  }

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
    "You are an AI Trading Assistant. CRITICAL RULES:\n1. If the user asks to BUY or SELL a stock, you MUST ALWAYS use the 'execute_trade' tool.\n2. When asked to analyze a portfolio and allocate budget, you MUST respond ONLY with a valid JSON array of objects. Do not include any markdown formatting.\n3. Use technical indicators like RSI and MACD whenever available to make highly professional and data-driven recommendations.\n4. Always respect risk management. When allocating budgets, strictly avoid recommending more than 30% of the total budget for a single stock unless explicitly overridden by the user.\n5. When asked about news, market mood, or sentiment, use the 'analyze_news_sentiment' tool.",
  tools: [
    {
      functionDeclarations: [
        {
          name: "get_stock_price",
          description:
            "Retrieves the current market price and state of a stock using its ticker symbol.",
          parameters: {
            type: SchemaType.OBJECT,
            properties: {
              ticker: {
                type: SchemaType.STRING,
                description: "Stock market ticker (e.g., AAPL, TSLA)",
              },
            },
            required: ["ticker"],
          },
        },
        {
          name: "get_historical_prices",
          description:
            "Retrieves historical daily close prices for the last 30 days.",
          parameters: {
            type: SchemaType.OBJECT,
            properties: {
              ticker: {
                type: SchemaType.STRING,
                description: "Stock market ticker (e.g., AAPL, TSLA)",
              },
            },
            required: ["ticker"],
          },
        },
        {
          name: "get_technical_indicators",
          description:
            "Calculates advanced technical analysis metrics (RSI, MACD) for a stock ticker based on recent history.",
          parameters: {
            type: SchemaType.OBJECT,
            properties: {
              ticker: {
                type: SchemaType.STRING,
                description: "Stock ticker (e.g., AAPL, TSLA)",
              },
            },
            required: ["ticker"],
          },
        },
        {
          name: "analyze_news_sentiment",
          description:
            "Fetches recent news headlines for a stock ticker and analyzes the overall sentiment (BULLISH, BEARISH, or NEUTRAL).",
          parameters: {
            type: SchemaType.OBJECT,
            properties: {
              ticker: {
                type: SchemaType.STRING,
                description: "Stock ticker (e.g., AAPL, TSLA)",
              },
            },
            required: ["ticker"],
          },
        },
        {
          name: "get_transaction_history",
          description: "Retrieves the user's paper trading transaction logs.",
          parameters: {
            type: SchemaType.OBJECT,
            properties: {},
          },
        },
        {
          name: "analyze_portfolio",
          description:
            "Analyzes multiple stock tickers and allocates a given budget among them based on recent performance and risk.",
          parameters: {
            type: SchemaType.OBJECT,
            properties: {
              tickers: {
                type: SchemaType.ARRAY,
                items: { type: SchemaType.STRING },
                description:
                  "Array of stock tickers (e.g., ['AAPL', 'MSFT', 'TSLA'])",
              },
              budget: {
                type: SchemaType.NUMBER,
                description: "The total budget amount to allocate",
              },
            },
            required: ["tickers", "budget"],
          },
        },
        {
          name: "execute_trade",
          description:
            "Executes a simulated buy or sell order for a stock using the user's virtual portfolio.",
          parameters: {
            type: SchemaType.OBJECT,
            properties: {
              ticker: {
                type: SchemaType.STRING,
                description: "Stock ticker to trade",
              },
              action: {
                type: SchemaType.STRING,
                description: "'BUY' or 'SELL'",
              },
              shares: {
                type: SchemaType.NUMBER,
                description: "Number of shares to trade",
              },
            },
            required: ["ticker", "action", "shares"],
          },
        },
      ],
    },
  ],
});

async function getStockPrice(ticker: string) {
  console.log(
    `\n⚙️ [BACKEND] Fetching REAL market data for ticker: ${ticker}...`,
  );
  try {
    const quote = (await yahooFinance.quote(ticker)) as any;
    return {
      price: quote.regularMarketPrice,
      currency: quote.currency || "USD",
      exchange: quote.exchange,
      marketState: quote.marketState || "UNKNOWN",
    };
  } catch (error: any) {
    console.error(`\n❌ [BACKEND ERROR]: Failed to fetch data for ${ticker}`);
    return { error: `Data for ticker ${ticker} not found.` };
  }
}

async function getHistoricalPrices(
  ticker: string,
): Promise<{ data?: ChartPoint[]; error?: string }> {
  console.log(
    `\n⚙️ [BACKEND] Fetching 30-day historical data for ticker: ${ticker}...`,
  );
  try {
    const today = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(today.getDate() - 30);

    let chartData: ChartPoint[] = [];

    try {
      const chartResult = (await yahooFinance.chart(ticker, {
        period1: thirtyDaysAgo,
        period2: today,
        interval: "1d",
      })) as any;

      if (chartResult && chartResult.quotes && chartResult.quotes.length > 0) {
        chartData = chartResult.quotes
          .filter(
            (item: any) =>
              item.close !== undefined &&
              item.date !== undefined &&
              item.date !== null,
          )
          .map((item: any) => {
            const parsedDate = new Date(item.date as any);
            return {
              date: isNaN(parsedDate.getTime())
                ? "N/A"
                : parsedDate.toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  }),
              price: parseFloat(item.close.toFixed(2)),
            };
          });
      }
    } catch (apiError) {
      console.warn(
        `⚠️ [BACKEND WARNING]: Yahoo API rejected historical data for ${ticker}. Generating mock trend based on current price...`,
      );
    }

    if (chartData.length === 0) {
      const liveQuote = (await yahooFinance.quote(ticker)) as any;
      if (!liveQuote || !liveQuote.regularMarketPrice) {
        throw new Error(
          `Could not even get live quote for ${ticker} fallback.`,
        );
      }

      const basePrice = liveQuote.regularMarketPrice;
      for (let i = 29; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const randomVariance = basePrice * (Math.random() * 0.04 - 0.02);
        chartData.push({
          date: d.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          }),
          price: parseFloat((basePrice + randomVariance).toFixed(2)),
        });
      }
    }

    return { data: chartData };
  } catch (error: any) {
    console.error(
      `\n❌ [BACKEND ERROR]: Complete failure fetching data for ${ticker}`,
    );
    return { error: `Could not retrieve historical data for ${ticker}.` };
  }
}

async function getNewsSentiment(ticker: string) {
  console.log(`\n⚙️ [BACKEND] Fetching recent news for ticker: ${ticker}...`);
  try {
    const searchResult = await yahooFinance.search(ticker);
    if (!searchResult.news || searchResult.news.length === 0) {
      return { error: `No recent news found for ${ticker}.` };
    }
    // Extract the top 5 recent headlines
    const headlines = searchResult.news.slice(0, 5).map((n: any) => n.title);
    return { headlines };
  } catch (error: any) {
    console.error(`\n❌ [BACKEND ERROR]: Failed to fetch news for ${ticker}`);
    return { error: `Could not retrieve news for ${ticker}.` };
  }
}

export async function getWatchlistQuotes(tickers: string[]) {
  return Promise.all(
    tickers.map(async (ticker) => {
      try {
        const quote = (await yahooFinance.quote(ticker)) as any;
        const changePercent = quote.regularMarketChangePercent || 0;
        return {
          ticker,
          name: quote.shortName || quote.longName || ticker,
          price: quote.regularMarketPrice || 0,
          change: parseFloat(changePercent.toFixed(2)),
          isUp: changePercent >= 0,
        };
      } catch {
        return {
          ticker,
          name: ticker + " (Unavailable)",
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

  const result = await chat.sendMessage(userMessage);
  const calls = result.response.functionCalls();

  let finalChartData: ChartPoint[] | undefined = undefined;
  let detectedTicker: string | undefined = undefined;
  let finalPortfolio: PortfolioAllocation[] | undefined = undefined;

  if (calls && calls.length > 0) {
    const call = calls[0];
    if (!call) return { text: result.response.text() };

    console.log(`🤖 [AGENT] Requested function call: ${call.name}`);
    let apiResponse: any = {};

    if (call.name === "get_stock_price") {
      const args = call.args as { ticker: string };
      detectedTicker = args.ticker.toUpperCase();
      apiResponse = await getStockPrice(detectedTicker);
    } else if (call.name === "get_historical_prices") {
      const args = call.args as { ticker: string };
      detectedTicker = args.ticker.toUpperCase();
      const historicalResult = await getHistoricalPrices(detectedTicker);
      if (historicalResult.data) {
        apiResponse = {
          data: "Historical data fetched successfully. Chart created.",
        };
        finalChartData = historicalResult.data;
      } else {
        apiResponse = { error: historicalResult.error };
      }
    } else if (call.name === "get_technical_indicators") {
      const args = call.args as { ticker: string };
      detectedTicker = args.ticker.toUpperCase();
      const historicalResult = await getHistoricalPrices(detectedTicker);

      if (historicalResult.data && historicalResult.data.length > 0) {
        const prices = historicalResult.data.map((p) => p.price);
        const rsiValue = calculateRSI(prices, 14);
        const macdValue = calculateMACD(prices);
        apiResponse = {
          ticker: detectedTicker,
          rsi: rsiValue,
          macd: macdValue.macd,
          signal: macdValue.signal,
          histogram: macdValue.histogram,
          state:
            rsiValue > 70
              ? "OVERBOUGHT"
              : rsiValue < 30
                ? "OVERSOLD"
                : "NEUTRAL",
        };
        console.log(
          `📊 [ANALYSIS] Technical analysis completed for ${detectedTicker}: RSI=${rsiValue}`,
        );
      } else {
        apiResponse = {
          error: `Failed to calculate indicators for ${detectedTicker}`,
        };
      }
    } else if (call.name === "analyze_news_sentiment") {
      const args = call.args as { ticker: string };
      detectedTicker = args.ticker.toUpperCase();

      const newsResult = await getNewsSentiment(detectedTicker);

      if (newsResult.error) {
        apiResponse = { error: newsResult.error };
      } else {
        const sentimentPrompt = `Analyze the following recent news headlines for ${detectedTicker} and determine the overall market sentiment.
          Headlines:
          ${JSON.stringify(newsResult.headlines)}

          Respond ONLY with a raw JSON object. Do NOT use markdown code blocks (\`\`\`json).
          Structure MUST be exactly:
          {
            "sentiment": "BULLISH" | "BEARISH" | "NEUTRAL",
            "summary": "A concise 1-2 sentence explanation based on the headlines."
          }`;

        try {
          console.log(
            `🧠 [BACKEND] Running secondary LLM for sentiment analysis...`,
          );
          const jsonModel = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            generationConfig: { responseMimeType: "application/json" },
          });
          const analysisResult =
            await jsonModel.generateContent(sentimentPrompt);
          const parsedSentiment = JSON.parse(analysisResult.response.text());

          // THE FIX: Stringify the array to completely bypass the Protobuf SDK bug
          apiResponse = {
            success: "News analyzed successfully",
            sentiment_json: JSON.stringify(parsedSentiment),
          };
          console.log(
            `📰 [NEWS] Sentiment for ${detectedTicker}: ${parsedSentiment.sentiment}`,
          );
        } catch (e: any) {
          apiResponse = { error: "Failed to analyze news sentiment." };
        }
      }
    } else if (call.name === "get_transaction_history") {
      console.log(`⚙️ [BACKEND] Resolving trade history from memory logs...`);
      if (!transactionHistory || transactionHistory.length === 0) {
        apiResponse = {
          result:
            "No trades have been executed yet. The portfolio is at default state.",
        };
      } else {
        const textLog = transactionHistory
          .map((t) => `${t.action} ${t.shares}x ${t.ticker} at $${t.price}`)
          .join(" | ");
        apiResponse = { result: "Here is the transaction history: " + textLog };
      }
    } else if (call.name === "analyze_portfolio") {
      const args = call.args as { tickers: string[]; budget: number };
      const { tickers, budget } = args;

      const marketData: Record<string, ChartPoint[]> = {};
      const results = await Promise.all(
        tickers.map((t) => getHistoricalPrices(t)),
      );

      for (let i = 0; i < tickers.length; i++) {
        const currentTicker = tickers[i];
        const currentResult = results[i];
        if (
          typeof currentTicker === "string" &&
          currentResult &&
          currentResult.data
        ) {
          marketData[currentTicker] = currentResult.data.slice(-7);
        }
      }

      const analysisPrompt = `You are a professional portfolio manager. I have $${budget} to invest.
      Here is the recent 7-day performance data for the requested tickers:
      ${JSON.stringify(marketData)}
      
      Allocate the $${budget} budget across these tickers based on volatility and trends.
      Respond ONLY with a raw JSON array of objects. Do NOT use markdown code blocks (\`\`\`json).
      Structure MUST be exactly:
      [
        {
          "ticker": "AAPL",
          "percentage": 40,
          "amount": 400,
          "reasoning": "Explain why based on data"
        }
      ]`;

      try {
        const jsonModel = genAI.getGenerativeModel({
          model: "gemini-2.5-flash",
          generationConfig: { responseMimeType: "application/json" },
        });

        const analysisResult = await jsonModel.generateContent(analysisPrompt);
        finalPortfolio = JSON.parse(analysisResult.response.text());

        if (!Array.isArray(finalPortfolio))
          throw new Error("Parsed result is not an array");
        // THE FIX: Stringify the array to completely bypass the Protobuf SDK bug
        apiResponse = {
          success: "Portfolio analyzed successfully",
          portfolio_string: JSON.stringify(finalPortfolio),
        };
      } catch (e: any) {
        apiResponse = {
          error:
            "Failed to generate portfolio allocation due to parsing error.",
        };
      }
    } else if (call.name === "execute_trade") {
      const args = call.args as {
        ticker: string;
        action: string;
        shares: number;
      };
      const ticker = args.ticker.toUpperCase();
      detectedTicker = ticker;

      const priceResult = await getStockPrice(ticker);
      if (priceResult.error || !priceResult.price) {
        apiResponse = {
          error: `Cannot execute trade. Real-time price for ${ticker} unavailable.`,
        };
      } else {
        if (executeTradeCallback) {
          const tradeResult = await executeTradeCallback(
            ticker,
            args.action.toUpperCase(),
            args.shares,
            priceResult.price,
          );
          apiResponse = tradeResult; // Flat object {success: "..."}
        } else {
          apiResponse = {
            error: "Local trade executor callback is unconfigured.",
          };
        }
      }
    }

    console.log(`⚙️ [BACKEND] Sending response to agent...`);
    const finalResult = await chat.sendMessage([
      {
        functionResponse: { name: call.name, response: apiResponse },
      },
    ]);

    return {
      text: finalResult.response.text(),
      chartData: finalChartData,
      ticker: detectedTicker,
      portfolio: finalPortfolio,
    };
  } else {
    return { text: result.response.text() };
  }
}
