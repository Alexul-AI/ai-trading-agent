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
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(
  cors({ origin: process.env.FRONTEND_ORIGIN || "http://localhost:5173" }),
);

// --- ALPACA API SETUP (PAPER VS LIVE) ---
const isLiveMode = process.env.TRADE_MODE === "live";
const alpacaKey = isLiveMode
  ? process.env.APCA_API_KEY_ID_LIVE
  : process.env.APCA_API_KEY_ID;
const alpacaSecret = isLiveMode
  ? process.env.APCA_API_SECRET_KEY_LIVE
  : process.env.APCA_API_SECRET_KEY;

if (!alpacaKey || !alpacaSecret) {
  console.error(
    `[FATAL] Missing Alpaca API keys for ${isLiveMode ? "LIVE" : "PAPER"} mode!`,
  );
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const alpaca = new (Alpaca as any)({
  keyId: alpacaKey,
  secretKey: alpacaSecret,
  paper: !isLiveMode,
});

console.log(
  `[SYSTEM] Trading Engine initialized in ${isLiveMode ? "🔴 LIVE (REAL MONEY)" : "🟢 PAPER (SIMULATED)"} mode.`,
);

// --- RISK MANAGER (KILL SWITCH) ---
let RISK_MANAGER_TRIPWIRE = false;
const MAX_DAILY_DRAWDOWN_PERCENT = 5.0; // Stop trading if account loses > 5% in a day

async function checkRiskLimits() {
  if (RISK_MANAGER_TRIPWIRE) return; // Already tripped, skip checking
  try {
    const account = await alpaca.getAccount();
    const currentEquity = parseFloat(account.equity);
    const lastEquity = parseFloat(account.last_equity);

    // Calculate drawdown
    if (lastEquity > 0 && currentEquity < lastEquity) {
      const drawdown = ((lastEquity - currentEquity) / lastEquity) * 100;

      if (drawdown >= MAX_DAILY_DRAWDOWN_PERCENT) {
        RISK_MANAGER_TRIPWIRE = true;
        isAutopilotEnabled = false; // Disable Autopilot immediately
        const alertMsg = `🚨 *FATAL RISK ALERT*\nTrading HALTED. Max daily drawdown exceeded: -${drawdown.toFixed(2)}%.\nAutopilot engine disengaged.`;
        console.error(
          `\n[RISK MANAGER] KILL SWITCH ENGAGED! Drawdown: ${drawdown.toFixed(2)}%\n`,
        );
        await sendTelegramAlert(alertMsg);
      }
    }
  } catch (error) {
    console.error("[RISK MANAGER] Failed to verify account equity:", error);
  }
}

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
      equity: parseFloat(account.equity),
      currency: account.currency || "USD",
      positions: posMap,
      tripwireTripped: RISK_MANAGER_TRIPWIRE,
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

  // RISK MANAGER INTERVENTION
  if (RISK_MANAGER_TRIPWIRE && action.toLowerCase() === "buy") {
    const blockMsg = `Risk Manager halted trading. Daily drawdown limit exceeded. BUY order for ${ticker} rejected.`;
    console.warn(`🛡️ [RISK MANAGER] Blocked BUY order for ${ticker}`);
    return { error: blockMsg };
  }

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
        `[ALPACA] Attached risk brackets -> SL: $${stopLoss || "None"}, TP: $${takeProfit || "None"}`,
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
      `Type: ${orderType.toUpperCase()}`,
    );

    return {
      success: `Order placed successfully: ${action} ${shares} shares of ${ticker}. Type: ${orderType}. Status: ${order.status}.`,
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
  if (RISK_MANAGER_TRIPWIRE && req.body.enabled) {
    return res.status(403).json({
      error: "Cannot enable Autopilot. Risk Manager Kill Switch is active.",
    });
  }
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
    await checkRiskLimits(); // Check risk manager on every heartbeat

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
      tradeMode: process.env.TRADE_MODE || "paper",
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
    connectedClients.length === 0 ||
    RISK_MANAGER_TRIPWIRE
  )
    return;

  isProcessingAutopilot = true;
  try {
    console.log("[AUTOPILOT] Initiating autonomous market scan...");

    // FETCH BALANCE FOR STRICT RISK MANAGEMENT
    const portfolio = await getAlpacaPortfolio();
    const availableCash = portfolio.balance;
    const maxTradeValue = availableCash * 0.2; // STRICT 20% LIMIT PER TRADE

    const prompt = `[AUTOPILOT MODE] Your available cash is $${availableCash.toFixed(2)}. 
    Perform a fast market scan for these trending tickers: ${dynamicScreenerTickers.join(", ")}. 
    Check their technical indicators (RSI, MACD, Bollinger Bands) or news. 
    RULE: NEVER buy more than 20% of your total cash in a single trade (Max trade value: $${maxTradeValue.toFixed(2)}). Calculate shares carefully.
    If you identify a highly profitable trade setup, execute a BUY order immediately. Otherwise, briefly state that you are holding cash and observing. Keep the text extremely concise.`;

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

    const responseText = agentResponse.text || "";
    const lowerText = responseText.toLowerCase();

    // FIX FOR TELEGRAM SPAM:
    // Ignore empty messages, fallback text, or typical idle text.
    const isIdleOrError =
      lowerText.includes("holding cash") ||
      lowerText.includes("no response generated") ||
      responseText.trim() === "";

    if (!isIdleOrError) {
      await sendTelegramAlert(`🤖 *AUTOPILOT ALERT*\n${responseText}`);
    }

    // Only update UI if the AI's conclusion has changed to prevent UI flicker
    if (responseText && responseText !== lastAutopilotLog && !isIdleOrError) {
      lastAutopilotLog = responseText;

      const payload = JSON.stringify({
        type: "autopilot_log",
        message: responseText,
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
app.get("/api/mode", (req, res) => {
  res.json({ mode: process.env.TRADE_MODE || "paper" });
});

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
