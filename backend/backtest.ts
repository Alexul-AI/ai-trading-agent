import { OpenAI } from "openai";
import * as dotenv from "dotenv";
import YahooFinance from "yahoo-finance2";

dotenv.config();

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  maxRetries: 3,
});

// --- TECHNICAL ANALYSIS HELPERS ---
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

// --- BACKTEST CONFIGURATION ---
let virtualBalance = 10000;
let sharesOwned = 0;
const TICKER = "TSLA";
const BACKTEST_DAYS = 60; // Increased to 60 days to allow accurate MACD (26-day EMA) calculation

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
    `\n🚀 Starting Advanced Backtest: ${TICKER} over the last ${BACKTEST_DAYS} days`,
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
  for (let i = 26; i < dailyQuotes.length; i++) {
    // Start at day 26 to allow for MACD
    const currentDay = dailyQuotes[i];
    const currentPrice = parseFloat(currentDay.close.toFixed(2));
    const dateStr = new Date(currentDay.date).toLocaleDateString("en-US");

    // Calculate Indicators up to this day
    const historicalPrices = dailyQuotes
      .slice(0, i + 1)
      .map((q: any) => parseFloat(q.close.toFixed(2)));
    const currentRSI = calculateRSI(historicalPrices);
    const currentMACD = calculateMACD(historicalPrices);

    console.log(
      `\n📅 Day ${i + 1}/${dailyQuotes.length} (${dateStr}) - Price: $${currentPrice} | RSI: ${currentRSI} | MACD Hist: ${currentMACD.histogram}`,
    );

    const prompt = `[BACKTEST MODE] The current price of ${TICKER} is $${currentPrice}. 
      Technical Context:
      - RSI (14): ${currentRSI} (Under 30 is Oversold/Buy, Over 70 is Overbought/Sell)
      - MACD Histogram: ${currentMACD.histogram} (Positive implies bullish momentum, Negative implies bearish)
      
      You have $${virtualBalance.toFixed(2)} in cash and currently own ${sharesOwned} shares.
      
      RULES:
      1. ONLY BUY if RSI is approaching Oversold (< 40) OR if MACD Histogram turns sharply positive. Buy 1 share.
      2. ONLY SELL if RSI is Overbought (> 65) AND MACD is weakening, AND you own shares. Sell 1 share to secure profit.
      3. If conditions are not met, do nothing (HOLD).
      
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
