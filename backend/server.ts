import express from "express";
import cors from "cors";
import { runTradingAgentStep, getWatchlistQuotes } from "./agent.js";

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(cors({ origin: "http://localhost:5173" }));

// --- PORTFOLIO & HISTORY STATE ---
let userPortfolio = {
  balance: 1000.0,
  currency: "USD",
  positions: {} as Record<string, { shares: number; avgPrice: number }>,
};

let transactionHistory: Array<{
  ticker: string;
  action: string;
  shares: number;
  price: number;
  date: string;
}> = [];

const executeTradeInMemory = async (
  ticker: string,
  action: string,
  shares: number,
  price: number,
) => {
  const cost = shares * price;
  if (action === "BUY") {
    if (userPortfolio.balance >= cost) {
      userPortfolio.balance -= cost;
      if (!userPortfolio.positions[ticker])
        userPortfolio.positions[ticker] = { shares: 0, avgPrice: 0 };
      const pos = userPortfolio.positions[ticker];
      pos.avgPrice = (pos.shares * pos.avgPrice + cost) / (pos.shares + shares);
      pos.shares += shares;
      transactionHistory.push({
        ticker,
        action,
        shares,
        price,
        date: new Date().toISOString(),
      });
      console.log(
        `✅ [SERVER] Bought ${shares}x ${ticker}. Balance: $${userPortfolio.balance.toFixed(2)}`,
      );
      return {
        success: `Successfully executed: BUY ${shares} shares of ${ticker} at $${price.toFixed(2)}.`,
      };
    } else return { error: "Insufficient funds." };
  } else if (action === "SELL") {
    const pos = userPortfolio.positions[ticker];
    if (pos && pos.shares >= shares) {
      userPortfolio.balance += cost;
      pos.shares -= shares;
      if (pos.shares === 0) delete userPortfolio.positions[ticker];
      transactionHistory.push({
        ticker,
        action,
        shares,
        price,
        date: new Date().toISOString(),
      });
      console.log(
        `✅ [SERVER] Sold ${shares}x ${ticker}. Balance: $${userPortfolio.balance.toFixed(2)}`,
      );
      return {
        success: `Successfully executed: SELL ${shares} shares of ${ticker} at $${price.toFixed(2)}.`,
      };
    } else return { error: "Insufficient shares." };
  }
  return { error: "Invalid action." };
};

app.get("/api/portfolio", (req, res) => res.json(userPortfolio));
app.get("/api/history", (req, res) => res.json(transactionHistory));

app.post("/api/trade", async (req, res) => {
  const { ticker, action, shares, price } = req.body;
  if (!ticker || !action || !shares || !price) {
    res.status(400).json({ error: "Missing parameters." });
    return;
  }
  const result = await executeTradeInMemory(ticker, action, shares, price);
  if (result.error) res.status(400).json(result);
  else res.json({ success: true, portfolio: userPortfolio });
});

app.post("/api/chat", async (req, res) => {
  const { message, history } = req.body;
  try {
    const agentResponse = await runTradingAgentStep(
      message,
      history,
      transactionHistory,
      executeTradeInMemory,
    );
    res.json({
      reply: agentResponse.text,
      chartData: agentResponse.chartData,
      ticker: agentResponse.ticker,
      portfolio: agentResponse.portfolio,
      technicalData: agentResponse.technicalData,
      sentimentData: agentResponse.sentimentData,
    });
  } catch (error) {
    console.error("Chat API error:", error);
    res.status(500).json({ error: "AI engine error" });
  }
});

app.post("/api/watchlist", async (req, res) => {
  const { tickers } = req.body;
  try {
    res.json(await getWatchlistQuotes(tickers));
  } catch (e) {
    res.status(500).json({ error: "Watchlist error" });
  }
});

app.listen(PORT, () =>
  console.log(`🚀 [SERVER] Running on http://localhost:${PORT}`),
);
