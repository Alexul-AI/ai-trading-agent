import express from "express";
import cors from "cors";
import Alpaca from "@alpacahq/alpaca-trade-api";
import * as dotenv from "dotenv";
// IMPORTANT: Using .js extension is required when moduleResolution is Node16/NodeNext in tsconfig
import {
  runTradingAgentStep,
  getWatchlistQuotes,
  getTrendingStocks,
} from "./agent.js";
import { logTrade } from "./db.js";

dotenv.config();

// --- TELEGRAM NOTIFICATIONS ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

async function sendTelegramAlert(message: string) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "Markdown",
      }),
    });
  } catch (error) {
    console.error("[TELEGRAM] Failed to send alert", error);
  }
}

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(
  cors({ origin: process.env.FRONTEND_ORIGIN || "http://localhost:5173" }),
);

// Alpaca API setup
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const alpaca = new (Alpaca as any)({
  keyId: process.env.APCA_API_KEY_ID,
  secretKey: process.env.APCA_API_SECRET_KEY,
  paper: true,
});

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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  stopLoss?: number,
  takeProfit?: number,
) => {
  ticker = ticker.toUpperCase();
  try {
    console.log(
      `[ALPACA] Sending ${action} ${orderType.toUpperCase()} order for ${shares}x ${ticker}...`,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orderPayload: any = {
      symbol: ticker,
      qty: shares,
      side: action.toLowerCase() as "buy" | "sell",
      type: orderType.toLowerCase(),
      time_in_force: orderType.toLowerCase() === "limit" ? "gtc" : "day",
    };

    if (orderType.toLowerCase() === "limit" && limitPrice) {
      orderPayload.limit_price = limitPrice;
    }

    if (action.toLowerCase() === "buy" && (stopLoss || takeProfit)) {
      orderPayload.order_class = "bracket";
      if (takeProfit) orderPayload.take_profit = { limit_price: takeProfit };
      if (stopLoss)
        orderPayload.stop_loss = {
          stop_price: stopLoss,
          limit_price: parseFloat((stopLoss * 0.99).toFixed(2)),
        };
      console.log(
        `[ALPACA] Attached risk management brackets -> SL: $${stopLoss || "None"}, TP: $${takeProfit || "None"}`,
      );
    }

    const order = await alpaca.createOrder(orderPayload);
    console.log(`[ALPACA] Order acknowledged! Status: ${order.status}`);

    // RECORD TO DATABASE JOURNAL
    logTrade(
      ticker,
      action.toUpperCase(),
      shares,
      limitPrice || 0,
      `Order Type: ${orderType.toUpperCase()}`,
    );

    return {
      success: `Order placed successfully at broker: ${action} ${shares} shares of ${ticker}. Type: ${orderType}. Current status: ${order.status}.`,
    };
  } catch (error: any) {
    console.warn(`[ALPACA] Trade rejected by broker: ${error.message}`);
    return { error: `Broker rejected the trade: ${error.message}` };
  }
};

// --- LIVE DATA STREAMING & SCREENER ---
let connectedClients: express.Response[] = [];
let isAutopilotEnabled = false;
let isProcessingAutopilot = false;
let dynamicScreenerTickers: string[] = ["NVDA", "AAPL", "TSLA", "MSFT", "AMD"];

// Refresh trending stocks every 15 minutes
setInterval(
  async () => {
    dynamicScreenerTickers = await getTrendingStocks();
    console.log(
      `[SCREENER] Updated trending tickers: ${dynamicScreenerTickers.join(", ")}`,
    );
  },
  15 * 60 * 1000,
);

// Fetch immediately on startup
getTrendingStocks().then((tickers) => {
  dynamicScreenerTickers = tickers;
  console.log(
    `[SCREENER] Initial trending tickers: ${dynamicScreenerTickers.join(", ")}`,
  );
});

app.post("/api/autopilot", (req, res) => {
  isAutopilotEnabled = req.body.enabled;
  console.log(
    `[AUTOPILOT] Engine status: ${isAutopilotEnabled ? "ENABLED" : "DISABLED"}`,
  );
  res.json({ enabled: isAutopilotEnabled });
});

app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  connectedClients.push(res);
  req.on("close", () => {
    connectedClients = connectedClients.filter((client) => client !== res);
  });
});

// The Heartbeat: Polls the broker and market data every 3 seconds and pushes to all connected clients
setInterval(async () => {
  if (connectedClients.length === 0) return;

  try {
    const portfolio = await getAlpacaPortfolio();
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

    const activeTickers = Array.from(
      new Set([
        ...dynamicScreenerTickers,
        ...Object.keys(portfolio.positions),
        ...formattedOrders.map((o: any) => o.ticker),
      ]),
    );
    const watchlist = await getWatchlistQuotes(activeTickers);

    const payload = JSON.stringify({
      type: "update",
      portfolio,
      orders: formattedOrders,
      watchlist,
    });

    connectedClients.forEach((client) => client.write(`data: ${payload}\n\n`));
  } catch (error) {
    // Silently catch polling errors to prevent stream crash
  }
}, 3000);

// AUTOPILOT LOOP: Runs every 60 seconds to scan the market autonomously
let lastAutopilotLog = "";

setInterval(async () => {
  if (
    !isAutopilotEnabled ||
    isProcessingAutopilot ||
    connectedClients.length === 0
  )
    return;

  isProcessingAutopilot = true;
  try {
    console.log("[AUTOPILOT] Initiating autonomous market scan...");

    const prompt = `[AUTOPILOT MODE] Perform a fast market scan for these trending tickers: ${dynamicScreenerTickers.join(", ")}. Check their technical indicators or news. If you identify a highly profitable trade setup, execute a BUY order immediately. Otherwise, briefly state that you are holding cash and observing. Keep the text extremely concise.`;

    const activities = await alpaca.getAccountActivities({
      activityTypes: ["FILL"],
    });
    const transactionHistory = activities.map((a: any) => ({
      ticker: a.symbol,
      action: a.side.toUpperCase(),
      shares: parseFloat(a.qty),
      price: parseFloat(a.price),
      date: a.transaction_time,
    }));

    const agentResponse = await runTradingAgentStep(
      prompt,
      [],
      transactionHistory,
      executeAlpacaTrade,
    );

    // Send Telegram alert ONLY if autopilot decided to do something significant (not just holding cash)
    if (
      agentResponse.text &&
      !agentResponse.text.toLowerCase().includes("holding cash")
    ) {
      await sendTelegramAlert(`🤖 *AUTOPILOT ALERT*\n${agentResponse.text}`);
    }

    // Only update UI if the AI's conclusion has changed
    if (agentResponse.text && agentResponse.text !== lastAutopilotLog) {
      lastAutopilotLog = agentResponse.text;

      const payload = JSON.stringify({
        type: "autopilot_log",
        message: agentResponse.text,
        chartData: agentResponse.chartData,
        ticker: agentResponse.ticker,
        portfolio: agentResponse.portfolio,
        technicalData: agentResponse.technicalData,
        sentimentData: agentResponse.sentimentData,
        fundamentalData: agentResponse.fundamentalData,
      });

      connectedClients.forEach((client) =>
        client.write(`data: ${payload}\n\n`),
      );
    }
  } catch (error) {
    console.error("[AUTOPILOT] Cycle error:", error);
  } finally {
    isProcessingAutopilot = false;
  }
}, 60000);

// --- STANDARD ENDPOINTS ---
app.get("/api/portfolio", async (req, res) => {
  try {
    res.json(await getAlpacaPortfolio());
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch" });
  }
});

app.get("/api/orders", async (req, res) => {
  try {
    const orders = await alpaca.getOrders({ status: "open" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res.json(
      orders.map((o: any) => ({
        id: o.id,
        ticker: o.symbol,
        action: o.side.toUpperCase(),
        qty: parseFloat(o.qty),
        orderType: o.order_type.toUpperCase(),
        limitPrice: o.limit_price ? parseFloat(o.limit_price) : null,
        status: o.status,
      })),
    );
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch" });
  }
});

app.post("/api/trade", async (req, res) => {
  const {
    ticker,
    action,
    shares,
    orderType,
    limitPrice,
    stopLoss,
    takeProfit,
  } = req.body;
  if (!ticker || !action || !shares) {
    res.status(400).json({ error: "Missing parameters." });
    return;
  }
  const result = await executeAlpacaTrade(
    ticker,
    action,
    shares,
    orderType || "market",
    limitPrice,
    stopLoss,
    takeProfit,
  );
  if (result.error) res.status(400).json(result);
  else res.json({ success: true, portfolio: await getAlpacaPortfolio() });
});

app.post("/api/chat", async (req, res) => {
  const { message, history } = req.body;
  try {
    const activities = await alpaca.getAccountActivities({
      activityTypes: ["FILL"],
    });
    const transactionHistory = activities.map((a: any) => ({
      ticker: a.symbol,
      action: a.side.toUpperCase(),
      shares: parseFloat(a.qty),
      price: parseFloat(a.price),
      date: a.transaction_time,
    }));
    const agentResponse = await runTradingAgentStep(
      message,
      history,
      transactionHistory,
      executeAlpacaTrade,
    );
    res.json({
      reply: agentResponse.text,
      chartData: agentResponse.chartData,
      ticker: agentResponse.ticker,
      portfolio: agentResponse.portfolio,
      technicalData: agentResponse.technicalData,
      sentimentData: agentResponse.sentimentData,
      fundamentalData: agentResponse.fundamentalData,
    });
  } catch (error) {
    console.error("Chat API error:", error);
    res.status(500).json({ error: "AI engine error" });
  }
});

app.get("/api/watchlist", async (req, res) => {
  try {
    const portfolio = await getAlpacaPortfolio();
    const activeTickers = Array.from(
      new Set([...dynamicScreenerTickers, ...Object.keys(portfolio.positions)]),
    );
    res.json(await getWatchlistQuotes(activeTickers));
  } catch (error) {
    res.status(500).json({ error: "Watchlist error" });
  }
});

app.listen(PORT, () =>
  console.log(`[SERVER] Running on http://localhost:${PORT}`),
);
