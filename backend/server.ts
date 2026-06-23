import express from "express";
import cors from "cors";
import Alpaca from "@alpacahq/alpaca-trade-api";
import * as dotenv from "dotenv";
// IMPORTANT: Using .js extension is required when moduleResolution is Node16/NodeNext in tsconfig
import { runTradingAgentStep, getWatchlistQuotes } from "./agent.js";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(cors({ origin: "http://localhost:5173" }));

// Alpaca API setup
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

    const orderPayload: any = {
      symbol: ticker,
      qty: shares,
      side: action.toLowerCase() as "buy" | "sell",
      type: orderType.toLowerCase(),
      time_in_force: orderType.toLowerCase() === "limit" ? "gtc" : "day", // Market usually requires 'day', Limit can be 'gtc'
    };

    if (orderType.toLowerCase() === "limit" && limitPrice) {
      orderPayload.limit_price = limitPrice;
    }

    // Advanced Risk Management: Bracket Orders
    if (action.toLowerCase() === "buy" && (stopLoss || takeProfit)) {
      orderPayload.order_class = "bracket";

      if (takeProfit) {
        orderPayload.take_profit = { limit_price: takeProfit };
      }

      if (stopLoss) {
        orderPayload.stop_loss = {
          stop_price: stopLoss,
          // Limit price prevents extreme slippage on flash crashes. Rounded to 2 decimals to prevent API rejection.
          limit_price: parseFloat((stopLoss * 0.99).toFixed(2)),
        };
      }
      console.log(
        `[ALPACA] Attached risk management brackets -> SL: $${stopLoss || "None"}, TP: $${takeProfit || "None"}`,
      );
    }

    const order = await alpaca.createOrder(orderPayload);

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

// Using Alpaca's API to fetch actual executed trades (fills) directly from the exchange
app.get("/api/history", async (req, res) => {
  try {
    const activities = await alpaca.getAccountActivities({
      activityTypes: ["FILL"],
    });
    const history = activities.map((a: any) => ({
      id: a.id,
      ticker: a.symbol,
      action: a.side.toUpperCase(),
      shares: parseFloat(a.qty),
      price: parseFloat(a.price),
      date: a.transaction_time,
    }));
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch history" });
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
    // Fetch real-time executed trades from Alpaca to provide context to the agent
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
    res.status(500).json({ error: "Watchlist error" });
  }
});

app.listen(PORT, () =>
  console.log(`[SERVER] Running on http://localhost:${PORT}`),
);
