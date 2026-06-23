import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import Alpaca from "@alpacahq/alpaca-trade-api";
import * as dotenv from "dotenv";
import { runTradingAgentStep, getWatchlistQuotes } from "./agent.js";

// Load environment variables from .env
dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(cors({ origin: "http://localhost:5173" }));

// --- ALPACA BROKER SETUP ---
// Casting Alpaca to 'any' resolves TypeScript error TS2351 caused by CommonJS to ES Module interop missing construct signatures.
const alpaca = new (Alpaca as any)({
  keyId: process.env.APCA_API_KEY_ID,
  secretKey: process.env.APCA_API_SECRET_KEY,
  paper: true, // IMPORTANT: We are operating in Paper Trading (simulation) mode
});

// --- DATABASE SETUP (For transaction history logging only) ---
const db = new Database("trading_bot.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    action TEXT NOT NULL,
    shares REAL NOT NULL,
    price REAL NOT NULL,
    date TEXT NOT NULL
  );
`);

// --- BROKER ACCESS HELPERS ---
const getAlpacaPortfolio = async () => {
  try {
    // 1. Fetch real account balance from the broker
    const account = await alpaca.getAccount();
    // 2. Fetch all open positions from the exchange
    const positions = await alpaca.getPositions();

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

    // Map broker data to match our frontend interface
    positions.forEach((p: any) => {
      posMap[p.symbol] = {
        shares: parseFloat(p.qty),
        avgPrice: parseFloat(p.avg_entry_price),
        currentPrice: parseFloat(p.current_price),
        pnl: parseFloat(p.unrealized_pl), // Broker calculates PnL
        pnlPercent: parseFloat(p.unrealized_plpc) * 100, // Convert decimal to percentage
      };
    });

    return {
      balance: parseFloat(account.cash), // Available cash balance
      currency: account.currency || "USD",
      positions: posMap,
    };
  } catch (error) {
    console.error("[ALPACA] Error fetching portfolio:", error);
    throw error;
  }
};

const executeAlpacaTrade = async (
  ticker: string,
  action: string,
  shares: number,
  price: number,
) => {
  ticker = ticker.toUpperCase();

  try {
    console.log(
      `[ALPACA] Sending ${action} order for ${shares}x ${ticker} to the exchange...`,
    );

    // Send a real market order to the broker
    const order = await alpaca.createOrder({
      symbol: ticker,
      qty: shares,
      side: action.toLowerCase() as "buy" | "sell",
      type: "market",
      time_in_force: "day", // Order is valid until the end of the trading day
    });

    // Save history for agent context in SQLite
    db.prepare(
      "INSERT INTO history (ticker, action, shares, price, date) VALUES (?, ?, ?, ?, ?)",
    ).run(ticker, action, shares, price, new Date().toISOString());

    console.log(`[ALPACA] Order acknowledged! Status: ${order.status}`);

    return {
      success: `Order placed successfully at broker: ${action} ${shares} shares of ${ticker}. Current status: ${order.status}.`,
    };
  } catch (error: any) {
    console.warn(`[ALPACA] Trade rejected by broker: ${error.message}`);
    return { error: `Broker rejected the trade: ${error.message}` };
  }
};

// --- ENDPOINTS ---
app.get("/api/portfolio", async (req, res) => {
  try {
    const portfolio = await getAlpacaPortfolio();
    res.json(portfolio);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch portfolio from broker" });
  }
});

app.get("/api/history", (req, res) => {
  const history = db
    .prepare(
      "SELECT ticker, action, shares, price, date FROM history ORDER BY id DESC LIMIT 50",
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

  const result = await executeAlpacaTrade(ticker, action, shares, price);
  if (result.error) {
    res.status(400).json(result);
  } else {
    res.json({ success: true, portfolio: await getAlpacaPortfolio() });
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

    // Wrapper for agent integration
    const agentResponse = await runTradingAgentStep(
      message,
      history,
      transactionHistory as any[],
      executeAlpacaTrade,
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
  } catch (error) {
    console.error("Watchlist fetch error:", error);
    res.status(500).json({ error: "Watchlist error" });
  }
});

app.listen(PORT, () =>
  console.log(`[SERVER] Running on http://localhost:${PORT}`),
);
