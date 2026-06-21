import express from "express";
import cors from "cors";
import { runTradingAgentStep, getWatchlistQuotes } from "./agent.js";

const app = express();
const PORT = 3000;

app.use(express.json());

app.use(
  cors({
    origin: "http://localhost:5173",
  }),
);

// --- PORTFOLIO STATE (In-Memory MVP) ---
// This holds your initial $1000 to safely test AI recommendations.
let userPortfolio = {
  balance: 1000.0,
  currency: "USD",
  positions: {} as Record<string, { shares: number; avgPrice: number }>,
};

app.get("/api/portfolio", (req, res) => {
  res.json(userPortfolio);
});

app.post("/api/trade", (req, res) => {
  const { ticker, action, shares, price } = req.body;

  console.log(
    `\n💼 [SERVER] Executing trade request: ${action} ${shares} shares of ${ticker} at $${price}`,
  );

  if (!ticker || !action || !shares || !price) {
    res.status(400).json({ error: "Missing trade parameters." });
    return;
  }

  const cost = shares * price;

  if (action === "BUY") {
    if (userPortfolio.balance >= cost) {
      userPortfolio.balance -= cost;
      if (!userPortfolio.positions[ticker]) {
        userPortfolio.positions[ticker] = { shares: 0, avgPrice: 0 };
      }
      const pos = userPortfolio.positions[ticker];

      // Calculate new average weighted price
      pos.avgPrice = (pos.shares * pos.avgPrice + cost) / (pos.shares + shares);
      pos.shares += shares;

      console.log(
        `✅ [SERVER] Successfully bought ${shares}x ${ticker}. Remaining balance: $${userPortfolio.balance.toFixed(2)}`,
      );
      res.json({ success: true, portfolio: userPortfolio });
    } else {
      console.warn(
        `⚠️ [SERVER WARNING] Insufficient balance to BUY ${shares}x ${ticker} for $${cost.toFixed(2)}`,
      );
      res.status(400).json({ error: "Insufficient funds for this purchase." });
    }
  } else if (action === "SELL") {
    const pos = userPortfolio.positions[ticker];
    if (pos && pos.shares >= shares) {
      userPortfolio.balance += cost;
      pos.shares -= shares;

      if (pos.shares === 0) {
        delete userPortfolio.positions[ticker];
      }

      console.log(
        `✅ [SERVER] Successfully sold ${shares}x ${ticker}. Remaining balance: $${userPortfolio.balance.toFixed(2)}`,
      );
      res.json({ success: true, portfolio: userPortfolio });
    } else {
      console.warn(
        `⚠️ [SERVER WARNING] Attempted to SELL ${shares}x ${ticker} but only had ${pos ? pos.shares : 0} shares.`,
      );
      res.status(400).json({ error: "Insufficient shares to sell." });
    }
  } else {
    res.status(400).json({ error: "Invalid trade action." });
  }
});

app.post("/api/chat", async (req, res) => {
  const { message, history } = req.body;

  if (!message) {
    res.status(400).json({ error: "Message field is required." });
    return;
  }

  console.log(`\n💬 [SERVER] Received message from user: "${message}"`);

  try {
    const agentResponse = await (runTradingAgentStep as any)(message, history);

    console.log(`✉️ [SERVER] Sending response back to client`);
    res.json({
      reply: agentResponse.text,
      chartData: agentResponse.chartData,
      ticker: agentResponse.ticker,
      portfolio: agentResponse.portfolio,
    });
  } catch (error: any) {
    console.error(`\n❌ [SERVER ERROR]:`, error);
    res.status(500).json({
      error: "Failed to process request with AI Engine.",
      details: error.message || error,
    });
  }
});

app.post("/api/watchlist", async (req, res) => {
  const { tickers } = req.body;

  if (!tickers || !Array.isArray(tickers)) {
    res.status(400).json({ error: "Tickers array is required." });
    return;
  }

  try {
    const quotes = await getWatchlistQuotes(tickers);
    res.json(quotes);
  } catch (error: any) {
    console.error(`\n❌ [SERVER ERROR] Watchlist API failed:`, error);
    res.status(500).json({ error: "Failed to fetch watchlist quotes" });
  }
});

app.listen(PORT, () => {
  console.log(
    `\n🚀 [SERVER] Trading Agent API is running on http://localhost:3000`,
  );
  console.log(`📡 [SERVER] Awaiting requests from frontend...\n`);
});
