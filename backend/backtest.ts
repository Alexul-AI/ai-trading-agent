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
const BACKTEST_DAYS = 180;

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

function calculateMACD(prices: number[]) {
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

// Bollinger Bands Calculation
function calculateBollingerBands(
  prices: number[],
  period = 20,
  multiplier = 2,
) {
  if (prices.length < period) return { upper: 0, lower: 0, sma: 0 };
  const slice = prices.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return {
    sma: parseFloat(sma.toFixed(2)),
    upper: parseFloat((sma + stdDev * multiplier).toFixed(2)),
    lower: parseFloat((sma - stdDev * multiplier).toFixed(2)),
  };
}

async function runBacktest() {
  console.log(
    `\n🚀 Starting Advanced Backtest: ${TICKER} over the last ${BACKTEST_DAYS} days`,
  );
  console.log(`💵 Starting Capital: $${virtualBalance}\n`);

  const today = new Date();
  const pastDate = new Date();
  pastDate.setDate(today.getDate() - BACKTEST_DAYS);

  const chartData = (await yahooFinance.chart(TICKER, {
    period1: pastDate,
    period2: today,
    interval: "1d",
  })) as any;
  if (!chartData || !chartData.quotes || chartData.quotes.length === 0) return;

  const dailyQuotes = chartData.quotes.filter(
    (i: any) => i.close !== undefined && i.close !== null,
  );

  for (let i = 30; i < dailyQuotes.length; i++) {
    const currentDay = dailyQuotes[i];
    const currentPrice = parseFloat(currentDay.close.toFixed(2));
    const dateStr = new Date(currentDay.date).toLocaleDateString("en-US");

    const priceHistoryForTA = dailyQuotes
      .slice(0, i + 1)
      .map((q: any) => parseFloat(q.close.toFixed(2)));

    const rsi = calculateRSI(priceHistoryForTA, 14);
    const macdData = calculateMACD(priceHistoryForTA);
    const bbData = calculateBollingerBands(priceHistoryForTA, 20, 2);

    // PRE-CALCULATE RISK LIMITS IN CODE (Not trusting LLM math)
    const maxSharesBuy = Math.floor((virtualBalance * 0.2) / currentPrice);

    console.log(
      `\n📅 Day ${i + 1}/${dailyQuotes.length} (${dateStr}) - Price: $${currentPrice}`,
    );
    console.log(
      `   📉 RSI: ${rsi} | MACD: ${macdData.histogram} | BB: [Lower: $${bbData.lower}, SMA: $${bbData.sma}, Upper: $${bbData.upper}]`,
    );

    // ENHANCED PROMPT WITH PRE-CALCULATED LIMITS
    const prompt = `[BACKTEST MODE] TICKER: ${TICKER} | Price: $${currentPrice}. 
      Cash: $${virtualBalance.toFixed(2)} | Shares Owned: ${sharesOwned}.
      
      TECHNICALS:
      - RSI(14): ${rsi}
      - MACD Hist: ${macdData.histogram}
      - Bollinger Bands: Lower=$${bbData.lower}, Upper=$${bbData.upper}

      TRADING RULES & RISK MANAGEMENT:
      1. You are a highly analytical algorithmic trader.
      2. If you decide to BUY, you MUST buy exactly ${maxSharesBuy} shares (this represents safely 20% of your cash). If ${maxSharesBuy} is 0, you cannot buy.
      3. If you decide to SELL, you can sell up to ${sharesOwned} shares to lock in profits or cut losses.
      4. BUY SIGNAL: RSI < 45 OR Price is near/below the BB Lower band ($${bbData.lower}) OR MACD is rising.
      5. SELL SIGNAL: RSI > 60 OR Price is near/above the BB Upper band ($${bbData.upper}). 
      6. Call 'execute_trade' to act. If no clear signal exists, reply 'HOLD'.`;

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

          // Code-level enforcement to prevent hallucinated trades
          const action = args.action.toUpperCase();
          const requestedShares = Math.abs(args.shares || 0);

          if (action === "BUY") {
            // Cap the shares to maxSharesBuy regardless of what AI said
            const actualSharesToBuy = Math.min(requestedShares, maxSharesBuy);
            const cost = currentPrice * actualSharesToBuy;

            if (actualSharesToBuy > 0 && virtualBalance >= cost) {
              virtualBalance -= cost;
              sharesOwned += actualSharesToBuy;
              console.log(
                `🟢 AI BUYS ${actualSharesToBuy} share(s). Cost: $${cost.toFixed(2)}. Cash left: $${virtualBalance.toFixed(2)}`,
              );
            } else {
              console.log(
                `⚪ AI BUY failed: Math limit reached or 0 shares allowed.`,
              );
            }
          } else if (action === "SELL") {
            // Cap the shares to what we actually own
            const actualSharesToSell = Math.min(requestedShares, sharesOwned);
            const revenue = currentPrice * actualSharesToSell;

            if (actualSharesToSell > 0) {
              virtualBalance += revenue;
              sharesOwned -= actualSharesToSell;
              console.log(
                `🔴 AI SELLS ${actualSharesToSell} share(s). Revenue: $${revenue.toFixed(2)}. Cash left: $${virtualBalance.toFixed(2)}`,
              );
            } else {
              console.log(`⚪ AI SELL failed: Does not own shares.`);
            }
          }
        }
      } else {
        console.log(`🟡 AI decided to HOLD.`);
      }
    } catch (e: any) {
      console.log(`⚠️ API Error on day ${i}: ${e.message}`);
    }
  }

  const finalPrice = parseFloat(
    dailyQuotes[dailyQuotes.length - 1].close.toFixed(2),
  );
  const finalPortfolioValue = virtualBalance + sharesOwned * finalPrice;
  const pnl = finalPortfolioValue - 10000;
  const pnlPercent = (pnl / 10000) * 100;

  console.log(`\n=========================================`);
  console.log(`📊 FINAL BACKTEST RESULTS (${TICKER})`);
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
