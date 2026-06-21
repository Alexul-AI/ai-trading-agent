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

export interface AgentResponse {
  text: string;
  chartData?: ChartPoint[] | undefined;
  ticker?: string | undefined;
}

const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
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
                description: "Stock market ticker (e.g., AAPL, TSLA, LUMI.TA)",
              },
            },
            required: ["ticker"],
          },
        },
        {
          name: "get_historical_prices",
          description:
            "Retrieves historical daily close prices for the last 30 days for a specific stock ticker. Use this when the user asks for historical performance, charts, or trend analysis.",
          parameters: {
            type: SchemaType.OBJECT,
            properties: {
              ticker: {
                type: SchemaType.STRING,
                description: "Stock market ticker (e.g., AAPL, TSLA, VRNS)",
              },
            },
            required: ["ticker"],
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

    const result = {
      price: quote.regularMarketPrice,
      currency: quote.currency || "USD",
      exchange: quote.exchange,
      marketState: quote.marketState || "UNKNOWN",
    };

    console.log(`⚙️ [BACKEND] Sending result back to agent:`, result);
    return result;
  } catch (error: any) {
    console.error(`\n❌ [BACKEND ERROR]: Failed to fetch data for ${ticker}`);
    console.error(`🔍 [DEBUG DETAILS]: ${error.message || error}`);
    return {
      error: `Data for ticker ${ticker} not found. Please check the ticker format.`,
    };
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

    // FIX: Using .chart() instead of blocked .historical() endpoint to bypass Yahoo Finance restrictions
    const historicalData = (await yahooFinance.chart(ticker, {
      period1: thirtyDaysAgo,
      interval: "1d",
    })) as any;

    const historical = historicalData.quotes || [];

    if (!historical || historical.length === 0) {
      throw new Error("No historical data returned from Yahoo Finance.");
    }

    const chartData: ChartPoint[] = historical
      .filter(
        (item: any) =>
          item.close !== undefined &&
          item.date !== undefined &&
          item.date !== null,
      )
      .map((item: any) => {
        const parsedDate = new Date(item.date as any);
        const formattedDate = isNaN(parsedDate.getTime())
          ? "N/A"
          : parsedDate.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            });

        return {
          date: formattedDate,
          price: parseFloat(item.close.toFixed(2)),
        };
      });

    console.log(
      `⚙️ [BACKEND] Successfully parsed ${chartData.length} data points for ${ticker}`,
    );
    return { data: chartData };
  } catch (error: any) {
    console.error(
      `\n❌ [BACKEND ERROR]: Failed to fetch historical data for ${ticker}`,
    );
    console.error(`🔍 [DEBUG DETAILS]: ${error.message || error}`);
    return {
      error: `Could not retrieve historical data for ${ticker}.`,
    };
  }
}

export async function getWatchlistQuotes(tickers: string[]) {
  console.log(
    `\n⚙️ [BACKEND] Fetching batch quotes for watchlist: ${tickers.join(", ")}`,
  );
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

  const chat = model.startChat({
    history: formattedHistory,
  });

  console.log(`👤 [USER]: ${userMessage}`);

  const result = await chat.sendMessage(userMessage);
  const calls = result.response.functionCalls();

  let finalChartData: ChartPoint[] | undefined = undefined;
  let detectedTicker: string | undefined = undefined;

  if (calls && calls.length > 0) {
    const call = calls[0];
    if (!call) return { text: result.response.text() };

    console.log(
      `🤖 [AGENT] Requested function call: ${call.name} with arguments:`,
      call.args,
    );
    const args = call.args as { ticker: string };
    const ticker = args.ticker.toUpperCase();
    detectedTicker = ticker;

    let apiResponse: any = {};

    if (call.name === "get_stock_price") {
      apiResponse = await getStockPrice(ticker);
    } else if (call.name === "get_historical_prices") {
      const historicalResult = await getHistoricalPrices(ticker);
      if (historicalResult.data) {
        apiResponse = {
          data: "Historical data fetched successfully. A chart has been constructed.",
        };
        finalChartData = historicalResult.data;
      } else {
        apiResponse = { error: historicalResult.error };
      }
    }

    console.log(`⚙️ [BACKEND] Sending response to agent...`);

    const finalResult = await chat.sendMessage([
      {
        functionResponse: {
          name: call.name,
          response: apiResponse,
        },
      },
    ]);

    const responsePayload: AgentResponse = {
      text: finalResult.response.text(),
    };

    if (finalChartData) {
      responsePayload.chartData = finalChartData;
    }
    if (detectedTicker) {
      responsePayload.ticker = detectedTicker;
    }

    return responsePayload;
  } else {
    return {
      text: result.response.text(),
    };
  }
}
