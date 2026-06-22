import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import { runTradingAgentStep, getWatchlistQuotes } from "./agent.js";

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(cors({ origin: "http://localhost:5173" }));

// --- DATABASE SETUP (SQLite) ---
// This creates a local file 'trading_bot.db' to persist data across server restarts
const db = new Database("trading_bot.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS portfolio (
    id INTEGER PRIMARY KEY,
    balance REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS positions (
    ticker TEXT PRIMARY KEY,
    shares REAL NOT NULL,
    avgPrice REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    action TEXT NOT NULL,
    shares REAL NOT NULL,
    price REAL NOT NULL,
    date TEXT NOT NULL
  );
`);

// Initialize default balance if the database is completely empty
const initPortfolio = db.prepare("SELECT * FROM portfolio WHERE id = 1").get();
if (!initPortfolio) {
  db.prepare("INSERT INTO portfolio (id, balance) VALUES (1, 1000.0)").run();
  console.log(
    `🌱 [DB] Initialized new portfolio with default $1000.00 balance.`,
  );
}

// --- DB ACCESS HELPERS ---
const getPortfolioState = () => {
  const pRow = db
    .prepare("SELECT balance FROM portfolio WHERE id = 1")
    .get() as { balance: number };
  const positions = db
    .prepare("SELECT ticker, shares, avgPrice FROM positions")
    .all() as Array<{ ticker: string; shares: number; avgPrice: number }>;

  const posMap: Record<
    string,
    {
      shares: number;
      avgPrice: number;
      currentPrice?: number;
      pnl?: number;
      pnlPercent?: number;
    }
  > = {};
  positions.forEach((p) => {
    posMap[p.ticker] = { shares: p.shares, avgPrice: p.avgPrice };
  });

  return {
    balance: pRow.balance,
    currency: "USD",
    positions: posMap,
  };
};

// Database execution layer ensuring atomicity with DB Transactions
const executeDbTrade = (
  ticker: string,
  action: string,
  shares: number,
  price: number,
) => {
  ticker = ticker.toUpperCase();
  const cost = shares * price;

  let resultMessage = "";

  const tradeTx = db.transaction(() => {
    const pRow = db
      .prepare("SELECT balance FROM portfolio WHERE id = 1")
      .get() as { balance: number };
    let currentBalance = pRow.balance;

    const posRow = db
      .prepare("SELECT shares, avgPrice FROM positions WHERE ticker = ?")
      .get(ticker) as { shares: number; avgPrice: number } | undefined;
    let posShares = posRow ? posRow.shares : 0;
    let posAvgPrice = posRow ? posRow.avgPrice : 0;

    if (action === "BUY") {
      if (currentBalance < cost) throw new Error("Insufficient funds.");
      currentBalance -= cost;

      const newAvgPrice =
        (posShares * posAvgPrice + cost) / (posShares + shares);
      posShares += shares;

      db.prepare("UPDATE portfolio SET balance = ? WHERE id = 1").run(
        currentBalance,
      );
      db.prepare(
        `
        INSERT INTO positions (ticker, shares, avgPrice) 
        VALUES (?, ?, ?) 
        ON CONFLICT(ticker) DO UPDATE SET shares=excluded.shares, avgPrice=excluded.avgPrice
      `,
      ).run(ticker, posShares, newAvgPrice);

      resultMessage = `Successfully executed: BUY ${shares} shares of ${ticker} at $${price.toFixed(2)}.`;
    } else if (action === "SELL") {
      if (posShares < shares) throw new Error("Insufficient shares.");
      currentBalance += cost;
      posShares -= shares;

      db.prepare("UPDATE portfolio SET balance = ? WHERE id = 1").run(
        currentBalance,
      );
      if (posShares === 0) {
        db.prepare("DELETE FROM positions WHERE ticker = ?").run(ticker);
      } else {
        db.prepare("UPDATE positions SET shares = ? WHERE ticker = ?").run(
          posShares,
          ticker,
        );
      }

      resultMessage = `Successfully executed: SELL ${shares} shares of ${ticker} at $${price.toFixed(2)}.`;
    } else {
      throw new Error("Invalid action.");
    }

    db.prepare(
      "INSERT INTO history (ticker, action, shares, price, date) VALUES (?, ?, ?, ?, ?)",
    ).run(ticker, action, shares, price, new Date().toISOString());
  });

  try {
    tradeTx();
    console.log(`✅ [DB] Trade committed: ${action} ${shares}x ${ticker}`);
    return { success: resultMessage };
  } catch (error: any) {
    console.warn(`⚠️ [DB] Trade rejected: ${error.message}`);
    return { error: error.message };
  }
};

// --- ENDPOINTS ---
app.get("/api/portfolio", async (req, res) => {
  try {
    const portfolio = getPortfolioState();
    const tickers = Object.keys(portfolio.positions);

    if (tickers.length > 0) {
      // Fetch fresh, live quotes for all open positions directly from Yahoo API
      const quotes = await getWatchlistQuotes(tickers);

      for (const ticker of tickers) {
        const quote = quotes.find((q) => q.ticker === ticker);
        const pos = portfolio.positions[ticker]!;

        const currentPrice = quote?.price || pos.avgPrice;

        pos.currentPrice = currentPrice;
        pos.pnl = (currentPrice - pos.avgPrice) * pos.shares;
        pos.pnlPercent =
          pos.avgPrice > 0
            ? ((currentPrice - pos.avgPrice) / pos.avgPrice) * 100
            : 0;
      }
    }

    res.json(portfolio);
  } catch (error) {
    console.error("Portfolio enrichment error:", error);
    res.json(getPortfolioState());
  }
});

app.get("/api/history", (req, res) => {
  const history = db
    .prepare(
      "SELECT ticker, action, shares, price, date FROM history ORDER BY id ASC",
    )
    .all();
  res.json(history);
});

app.post("/api/trade", async (req, res) => {
  const { ticker, action, shares, price } = req.body;
  if (!ticker || !action || !shares || !price) {
    res.status(400).json({ error: "Missing parameters." });
    return;
  }

  const result = executeDbTrade(ticker, action, shares, price);
  if (result.error) {
    res.status(400).json(result);
  } else {
    res.json({ success: true, portfolio: getPortfolioState() });
  }
});

app.post("/api/chat", async (req, res) => {
  const { message, history } = req.body;
  try {
    const transactionHistory = db
      .prepare(
        "SELECT ticker, action, shares, price, date FROM history ORDER BY id ASC",
      )
      .all();

    // Wrapper to ensure standard Promise resolution expected by the agent runner
    const asyncExecuteTrade = async (
      t: string,
      a: string,
      s: number,
      p: number,
    ) => {
      return executeDbTrade(t, a, s, p);
    };

    const agentResponse = await runTradingAgentStep(
      message,
      history,
      transactionHistory as any[],
      asyncExecuteTrade,
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
    // Live execution data without drift
    res.json(await getWatchlistQuotes(tickers));
  } catch (error) {
    console.error("Watchlist fetch error:", error);
    res.status(500).json({ error: "Watchlist error" });
  }
});

app.listen(PORT, () =>
  console.log(`🚀 [SERVER] Running on http://localhost:${PORT}`),
);
