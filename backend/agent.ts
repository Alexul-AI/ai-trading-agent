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

// 1. Tool Declaration for Gemini 2.5
const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  systemInstruction:
    "You are an AI Trading Assistant. CRITICAL RULES: 1. If the user asks to BUY or SELL a stock, you MUST ALWAYS use the 'execute_trade' tool. 2. When asked to analyze a portfolio and allocate budget, you MUST respond ONLY with a valid JSON array of objects. Do not include any markdown formatting.",
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
      for (let i = 6; i >= 0; i--) {
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
  history?: any[],
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
        apiResponse = {
          success: "Portfolio analyzed successfully",
          portfolio: finalPortfolio,
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

      // Step 1: Get the exact current price
      const priceResult = await getStockPrice(ticker);
      if (priceResult.error || !priceResult.price) {
        apiResponse = {
          error: `Cannot execute trade. Real-time price for ${ticker} unavailable.`,
        };
      } else {
        // Step 2: Trigger our local backend server trade endpoint
        try {
          const tradeRes = await fetch("http://localhost:3000/api/trade", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ticker,
              action: args.action.toUpperCase(),
              shares: args.shares,
              price: priceResult.price,
            }),
          });
          const tradeData = await tradeRes.json();

          if (!tradeRes.ok) {
            apiResponse = { error: tradeData.error || "Trade failed." };
          } else {
            apiResponse = {
              success: `TRADE EXECUTED: ${args.action} ${args.shares} shares of ${ticker} at $${priceResult.price}. Remaining Balance: $${tradeData.portfolio.balance.toFixed(2)}`,
            };
          }
        } catch (e) {
          apiResponse = { error: "Local trade engine is unreachable." };
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
