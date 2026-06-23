import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import Alpaca from "@alpacahq/alpaca-trade-api";
import * as dotenv from "dotenv";
import { runTradingAgentStep, getWatchlistQuotes } from "./agent.js";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(cors({ origin: "http://localhost:5173" }));

const alpaca = new (Alpaca as any)({
  keyId: process.env.APCA_API_KEY_ID,
  secretKey: process.env.APCA_API_SECRET_KEY,
  paper: true,
});

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

const getAlpacaPortfolio = async () => {
  try {
    const account = await alpaca.getAccount();
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

    positions.forEach((p: any) => {
      posMap[p.symbol] = {
        shares: parseFloat(p.qty),
        avgPrice: parseFloat(p.avg_entry_price),
        currentPrice: parseFloat(p.current_price),
        pnl: parseFloat(p.unrealized_pl),
        pnlPercent: parseFloat(p.unrealized_plpc) * 100,
      };
    });

    return {
      balance: parseFloat(account.cash),
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
  orderType: string = "market",
  limitPrice?: number,
) => {
  ticker = ticker.toUpperCase();

  try {
    console.log(
      `[ALPACA] Sending ${action} ${orderType.toUpperCase()} order for ${shares}x ${ticker} to the exchange...`,
    );

    const orderPayload: any = {
      symbol: ticker,
      qty: shares,
      side: action.toLowerCase() as "buy" | "sell",
      type: orderType.toLowerCase(),
      time_in_force: "day",
    };

    if (orderType.toLowerCase() === "limit" && limitPrice) {
      orderPayload.limit_price = limitPrice;
    }

    const order = await alpaca.createOrder(orderPayload);

    db.prepare(
      "INSERT INTO history (ticker, action, shares, price, date) VALUES (?, ?, ?, ?, ?)",
    ).run(ticker, action, shares, limitPrice || 0, new Date().toISOString());

    console.log(`[ALPACA] Order acknowledged! Status: ${order.status}`);

    return {
      success: `Order placed successfully at broker: ${action} ${shares} shares of ${ticker}. Type: ${orderType}. Current status: ${order.status}.`,
    };
  } catch (error: any) {
    console.warn(`[ALPACA] Trade rejected by broker: ${error.message}`);
    return { error: `Broker rejected the trade: ${error.message}` };
  }
};

app.get("/api/portfolio", async (req, res) => {
  try {
    const portfolio = await getAlpacaPortfolio();
    res.json(portfolio);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch portfolio from broker" });
  }
});

app.get("/api/orders", async (req, res) => {
  try {
    const orders = await alpaca.getOrders({ status: "open" });
    const formattedOrders = orders.map((o: any) => ({
      id: o.id,
      ticker: o.symbol,
      action: o.side.toUpperCase(),
      qty: parseFloat(o.qty),
      orderType: o.order_type.toUpperCase(),
      limitPrice: o.limit_price ? parseFloat(o.limit_price) : null,
      status: o.status,
    }));
    res.json(formattedOrders);
  } catch (error) {
    console.error("[ALPACA] Error fetching orders:", error);
    res.status(500).json({ error: "Failed to fetch pending orders" });
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
  const { ticker, action, shares, orderType, limitPrice } = req.body;
  if (!ticker || !action || !shares) {
    res.status(400).json({ error: "Missing parameters." });
    return;
  }

  const type = orderType || "market";

  const result = await executeAlpacaTrade(
    ticker,
    action,
    shares,
    type,
    limitPrice,
  );
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
