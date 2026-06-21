import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import * as dotenv from "dotenv";
// IMPORT FIX: Use uppercase for v3+
import YahooFinance from "yahoo-finance2";

// Load environment variables
dotenv.config();

// INITIALIZATION FIX: Suppress the annoying survey notice
const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

// 1. Initialize Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  tools: [
    {
      functionDeclarations: [
        {
          name: "get_stock_price",
          description:
            "Fetches the current stock price using its market ticker.",
          parameters: {
            type: SchemaType.OBJECT,
            properties: {
              ticker: {
                type: SchemaType.STRING,
                description:
                  "The stock ticker symbol (e.g., AAPL for Apple, TSLA for Tesla, LUMI.TA for Bank Leumi)",
              },
            },
            required: ["ticker"],
          },
        },
      ],
    },
  ],
});

// 2. Real Backend Function
async function getStockPrice(ticker: string) {
  console.log(
    `\n⚙️ [BACKEND] Fetching REAL market data for ticker: ${ticker}...`,
  );

  try {
    // Fetching real data from Yahoo Finance.
    // We cast it to 'any' to bypass strict TS inference issues with yahoo-finance2.
    const quote = (await yahooFinance.quote(ticker)) as any;

    return {
      price: quote.regularMarketPrice,
      currency: quote.currency,
      exchange: quote.exchange,
      marketState: quote.marketState,
    };
  } catch (error: any) {
    console.error(`\n❌ [BACKEND ERROR]: Failed to fetch data for ${ticker}`);
    console.error(`🔍 [DEBUG DETAILS]:`, error.message || error);
    return {
      error: `Data for ticker ${ticker} not found. Please check the ticker format.`,
    };
  }
}

// 3. Main Agent Logic (Refactored for API usage)
// We export this function so server.ts can use it
export async function runTradingAgentStep(
  userMessage: string,
  history: any[] = [],
) {
  // In a real app, you'd pass 'history' to startChat to maintain context
  const chat = model.startChat({
    history: history, // Gemini will remember previous turns
  });

  console.log(`👤 [USER]: ${userMessage}`);

  const result = await chat.sendMessage(userMessage);
  const calls = result.response.functionCalls();

  if (calls && calls.length > 0) {
    const call = calls[0];

    if (!call) return "Error processing function call.";

    console.log(
      `🤖 [AGENT] Requested function call: ${call.name} with arguments:`,
      call.args,
    );

    if (call.name === "get_stock_price") {
      const args = call.args as { ticker: string };
      const ticker = args.ticker;

      const apiResponse = await getStockPrice(ticker);

      console.log(`⚙️ [BACKEND] Sending result back to agent:`, apiResponse);

      const finalResult = await chat.sendMessage([
        {
          functionResponse: {
            name: "get_stock_price",
            response: apiResponse,
          },
        },
      ]);

      const replyText = finalResult.response.text();
      console.log(`\n🤖 [AGENT (Final Answer)]: ${replyText}`);
      return replyText; // Возвращаем текст на сервер
    }
  } else {
    const replyText = result.response.text();
    console.log(`\n🤖 [AGENT]: ${replyText}`);
    return replyText; // Возвращаем текст на сервер
  }
}
