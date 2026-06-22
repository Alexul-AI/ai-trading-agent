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
  positions: {} as Record<
    string,
    {
      shares: number;
      avgPrice: number;
      currentPrice?: number;
      pnl?: number;
      pnlPercent?: number;
    }
  >,
};

let transactionHistory: Array<{
  ticker: string;
  action: string;
  shares: number;
  price: number;
  date: string;
}> = [];

// --- DYNAMIC MARKET DRIFT SIMULATOR ---
// Keeps persistent randomized price drifts in memory so stock prices fluctuate realistically
let priceDrifts: Record<string, number> = {};

const getDriftedPrice = (ticker: string, basePrice: number): number => {
  if (!priceDrifts[ticker]) {
    priceDrifts[ticker] = 1.0; // Start with no drift (base market price)
  }
  // Apply a tiny random walk (-0.15% to +0.15% per tick/refresh)
  const change = Math.random() * 0.003 - 0.0015;
  priceDrifts[ticker] = priceDrifts[ticker] * (1 + change);

  // Guardrail: Keep the drifted price within a realistic +/- 3% band of the real-world market price
  if (priceDrifts[ticker] > 1.03) priceDrifts[ticker] = 1.03;
  if (priceDrifts[ticker] < 0.97) priceDrifts[ticker] = 0.97;

  return basePrice * priceDrifts[ticker];
};

// Enrichment helper to keep watchlist and open position prices perfectly in sync
const getDriftedWatchlistQuotes = async (tickers: string[]) => {
  const rawQuotes = await getWatchlistQuotes(tickers);
  return rawQuotes.map((quote) => {
    const basePrice = quote.price;
    const currentPrice = getDriftedPrice(quote.ticker, basePrice);

    // Adjust daily change ratio based on our drifted price
    const driftRatio = currentPrice / (basePrice || 1);
    const newChange = quote.change * driftRatio;

    return {
      ...quote,
      price: parseFloat(currentPrice.toFixed(2)),
      change: parseFloat(newChange.toFixed(2)),
      isUp: newChange >= 0,
    };
  });
};

const executeTradeInMemory = async (
  ticker: string,
  action: string,
  shares: number,
  price: number,
) => {
  ticker = ticker.toUpperCase();
  const cost = shares * price;

  if (action === "BUY") {
    if (userPortfolio.balance >= cost) {
      userPortfolio.balance -= cost;
      if (!userPortfolio.positions[ticker]) {
        userPortfolio.positions[ticker] = { shares: 0, avgPrice: 0 };
      }

      const pos = userPortfolio.positions[ticker]!;
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
    } else {
      return { error: "Insufficient funds." };
    }
  } else if (action === "SELL") {
    const pos = userPortfolio.positions[ticker];
    if (pos && pos.shares >= shares) {
      userPortfolio.balance += cost;
      pos.shares -= shares;

      if (pos.shares === 0) {
        delete userPortfolio.positions[ticker];
      }

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
    } else {
      return { error: "Insufficient shares." };
    }
  }
  return { error: "Invalid action." };
};

// --- ENRICHED PORTFOLIO ENDPOINT (CALCULATES PNL) ---
app.get("/api/portfolio", async (req, res) => {
  try {
    const enrichedPortfolio = JSON.parse(JSON.stringify(userPortfolio));
    const tickers = Object.keys(enrichedPortfolio.positions);

    if (tickers.length > 0) {
      // Fetch fresh, drifted quotes for all open positions to calculate dynamic P&L
      const quotes = await getDriftedWatchlistQuotes(tickers);

      for (const ticker of tickers) {
        const quote = quotes.find((q) => q.ticker === ticker);
        const pos = enrichedPortfolio.positions[ticker];

        const currentPrice = quote?.price || pos.avgPrice;

        pos.currentPrice = currentPrice;
        pos.pnl = (currentPrice - pos.avgPrice) * pos.shares;
        pos.pnlPercent =
          pos.avgPrice > 0
            ? ((currentPrice - pos.avgPrice) / pos.avgPrice) * 100
            : 0;
      }
    }

    res.json(enrichedPortfolio);
  } catch (error) {
    console.error("Portfolio enrichment error:", error);
    res.json(userPortfolio);
  }
});

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
    res.json(await getDriftedWatchlistQuotes(tickers));
  } catch (error) {
    console.error("Watchlist fetch error:", error);
    res.status(500).json({ error: "Watchlist error" });
  }
});

app.listen(PORT, () =>
  console.log(`🚀 [SERVER] Running on http://localhost:${PORT}`),
);
