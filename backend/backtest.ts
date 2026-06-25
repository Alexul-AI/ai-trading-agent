import { OpenAI } from "openai";
import * as dotenv from "dotenv";
import YahooFinance from "yahoo-finance2";

dotenv.config();

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  maxRetries: 3,
});

// --- BACKTEST CONFIGURATION ---
let virtualBalance = 10000;
let sharesOwned = 0;
const TICKER = "TSLA";
const BACKTEST_DAYS = 30;

// Simplified toolset strictly for backtesting execution
const tools: any[] = [
  {
    type: "function",
    function: {
      name: "execute_trade",
      description: "Executes a buy or sell order.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "BUY or SELL" },
          shares: { type: "number" },
        },
        required: ["action", "shares"],
      },
    },
  },
];

async function runBacktest() {
  console.log(
    `\n🚀 Starting Backtest: ${TICKER} over the last ${BACKTEST_DAYS} days`,
  );
  console.log(`💵 Starting Capital: $${virtualBalance}\n`);

  // 1. Fetch historical data
  const today = new Date();
  const pastDate = new Date();
  pastDate.setDate(today.getDate() - BACKTEST_DAYS);

  const chartData = (await yahooFinance.chart(TICKER, {
    period1: pastDate,
    period2: today,
    interval: "1d",
  })) as any;

  if (!chartData || !chartData.quotes || chartData.quotes.length === 0) {
    console.log("❌ Failed to retrieve historical market data.");
    return;
  }

  const dailyQuotes = chartData.quotes.filter(
    (i: any) => i.close !== undefined,
  );

  // 2. Simulation: Day-by-Day Loop
  for (let i = 14; i < dailyQuotes.length; i++) {
    // Start at day 14 to allow for basic indicator context (like a 14-day RSI)
    const currentDay = dailyQuotes[i];
    const currentPrice = parseFloat(currentDay.close.toFixed(2));
    const dateStr = new Date(currentDay.date).toLocaleDateString("en-US");

    console.log(
      `\n📅 Day ${i + 1}/${dailyQuotes.length} (${dateStr}) - Price: $${currentPrice}`,
    );

    // Provide recent context to the AI (acting as its "memory" up to this exact day)
    const recentPrices = dailyQuotes
      .slice(i - 14, i + 1)
      .map((q: any) => parseFloat(q.close.toFixed(2)));

    const prompt = `[BACKTEST MODE] The current price of ${TICKER} is $${currentPrice}. 
      Recent 14-day closing prices: ${JSON.stringify(recentPrices)}.
      You have $${virtualBalance.toFixed(2)} in cash and currently own ${sharesOwned} shares.
      Analyze the immediate trend. 
      If you see strong upward momentum, BUY 1 share. 
      If you see a downward trend and you own shares, SELL 1 share to secure profit or cut losses. 
      If uncertain, do nothing.
      Call 'execute_trade' if you decide to act, or simply reply 'HOLD'.`;

    const messages: any[] = [{ role: "user", content: prompt }];

    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: messages,
        tools: tools,
      });

      const message = response.choices[0]?.message;

      if (message?.tool_calls && message.tool_calls.length > 0) {
        const toolCall = message.tool_calls[0];

        if (toolCall && toolCall.type === "function") {
          const args = JSON.parse(toolCall.function.arguments);

          if (args.action === "BUY" && virtualBalance >= currentPrice) {
            virtualBalance -= currentPrice;
            sharesOwned += args.shares;
            console.log(
              `🟢 AI BUYS ${args.shares} share(s) at $${currentPrice}. Cash left: $${virtualBalance.toFixed(2)}`,
            );
          } else if (args.action === "SELL" && sharesOwned >= args.shares) {
            virtualBalance += currentPrice;
            sharesOwned -= args.shares;
            console.log(
              `🔴 AI SELLS ${args.shares} share(s) at $${currentPrice}. Cash left: $${virtualBalance.toFixed(2)}`,
            );
          } else {
            console.log(
              `⚪ AI attempted to ${args.action} but failed due to insufficient funds/shares.`,
            );
          }
        }
      } else {
        console.log(`🟡 AI decided to HOLD.`);
      }
    } catch (e: any) {
      console.log(`⚠️ API Error on day ${i}: ${e.message}`);
    }
  }

  // 3. Final Portfolio Evaluation
  const finalPrice = parseFloat(
    dailyQuotes[dailyQuotes.length - 1].close.toFixed(2),
  );
  const finalPortfolioValue = virtualBalance + sharesOwned * finalPrice;
  const pnl = finalPortfolioValue - 10000;
  const pnlPercent = (pnl / 10000) * 100;

  console.log(`\n=========================================`);
  console.log(`📊 BACKTEST RESULTS (${TICKER})`);
  console.log(`=========================================`);
  console.log(`Remaining Cash: $${virtualBalance.toFixed(2)}`);
  console.log(
    `Shares Owned: ${sharesOwned} (Valued at $${(sharesOwned * finalPrice).toFixed(2)})`,
  );
  console.log(`Final Portfolio Value: $${finalPortfolioValue.toFixed(2)}`);
  console.log(
    `Absolute PnL: $${pnl.toFixed(2)} (${pnlPercent > 0 ? "+" : ""}${pnlPercent.toFixed(2)}%)`,
  );
  console.log(`=========================================`);
}

runBacktest();
