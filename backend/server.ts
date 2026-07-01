import express, { type Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import * as AlpacaModule from "@alpacahq/alpaca-trade-api";
import { z } from "zod";

import { runTradingAgentStep } from "./agent.js";
import { evaluateTrade, type AccountState } from "./riskManager.js";
import { createAutopilotWorker } from "./autopilotWorker.js";

dotenv.config();

type UnknownRecord = Record<string, unknown>;

interface AlpacaLike {
  getAccount(): Promise<unknown>;
  getPositions(): Promise<unknown>;
  getOrders(params?: unknown): Promise<unknown>;
  getLatestTrade(symbol: string): Promise<unknown>;
  createOrder(payload: unknown): Promise<unknown>;
}

interface PositionSnapshot {
  shares: number;
  avgPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
}

interface WatchlistItem {
  ticker: string;
  name: string;
  price: number;
  change: number;
  isUp: boolean;
}

type AlpacaConstructor = new (config: {
  keyId: string;
  secretKey: string;
  paper: boolean;
}) => AlpacaLike;

const defaultWatchlist = ["NVDA", "AAPL", "TSLA", "MSFT", "AMD"];

function asRecord(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null
    ? (value as UnknownRecord)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
}

function toStringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function extractAlpacaPrice(value: unknown): number {
  const record = asRecord(value);

  const possibleFields = [
    record.Price,
    record.price,
    record.p,
    record.P,
    record.close,
    record.c,
  ];

  for (const field of possibleFields) {
    const parsed = toNumber(field, 0);
    if (parsed > 0) return parsed;
  }

  return 0;
}

const AlpacaClient = ((AlpacaModule as { default?: unknown; Alpaca?: unknown })
  .default ??
  (AlpacaModule as { default?: unknown; Alpaca?: unknown }).Alpaca ??
  AlpacaModule) as AlpacaConstructor;

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  FRONTEND_ORIGIN: z.string().default("http://localhost:5173"),
  TRADE_MODE: z.enum(["paper", "live"]).default("paper"),

  OPENAI_API_KEY: z.string().min(1, "Missing OPENAI_API_KEY"),

  APCA_API_KEY_ID: z.string().min(1, "Missing APCA_API_KEY_ID"),
  APCA_API_SECRET_KEY: z.string().min(1, "Missing APCA_API_SECRET_KEY"),

  APCA_API_KEY_ID_LIVE: z.string().optional(),
  APCA_API_SECRET_KEY_LIVE: z.string().optional(),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
});

const envParse = envSchema.safeParse(process.env);

if (!envParse.success) {
  console.error("[ENV] Invalid environment variables:");
  console.error(envParse.error.flatten().fieldErrors);
  process.exit(1);
}

const ENV = envParse.data;

if (ENV.TRADE_MODE === "live") {
  if (!ENV.APCA_API_KEY_ID_LIVE || !ENV.APCA_API_SECRET_KEY_LIVE) {
    console.error("[ENV] TRADE_MODE=live but live Alpaca keys are missing.");
    process.exit(1);
  }
}

const app = express();

app.disable("etag");

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  }),
);

app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  console.log(`[HTTP-IN] ${req.method} ${req.originalUrl}`);

  const startedAt = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - startedAt;
    console.log(
      `[HTTP-OUT] ${req.method} ${req.originalUrl} -> ${res.statusCode} ${duration}ms`,
    );
  });

  next();
});

const isLiveMode = ENV.TRADE_MODE === "live";

const alpaca = new AlpacaClient({
  keyId: isLiveMode ? ENV.APCA_API_KEY_ID_LIVE! : ENV.APCA_API_KEY_ID,
  secretKey: isLiveMode
    ? ENV.APCA_API_SECRET_KEY_LIVE!
    : ENV.APCA_API_SECRET_KEY,
  paper: !isLiveMode,
});

let transactionHistory: Array<{
  timestamp: string;
  ticker: string;
  action: "BUY" | "SELL";
  shares: number;
  price: number;
  orderId?: string;
}> = [];

const sseClients = new Set<Response>();

function writeSSE(res: Response, payload: unknown) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastSSE(payload: unknown) {
  for (const client of sseClients) {
    try {
      writeSSE(client, payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

async function sendTelegramAlert(message: string) {
  if (!ENV.TELEGRAM_BOT_TOKEN || !ENV.TELEGRAM_CHAT_ID) return;

  try {
    const url = `https://api.telegram.org/bot${ENV.TELEGRAM_BOT_TOKEN}/sendMessage`;

    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: ENV.TELEGRAM_CHAT_ID,
        text: message,
      }),
    });
  } catch (error) {
    console.error("[TELEGRAM] Failed to send alert:", error);
  }
}

async function getPortfolioSnapshot() {
  const accountRecord = asRecord(await alpaca.getAccount());
  const positions = asArray(await alpaca.getPositions());

  const positionMap: Record<string, PositionSnapshot> = {};

  for (const position of positions) {
    const p = asRecord(position);
    const symbol = toStringValue(p.symbol).toUpperCase();

    if (!symbol) continue;

    positionMap[symbol] = {
      shares: toNumber(p.qty),
      avgPrice: toNumber(p.avg_entry_price),
      currentPrice: toNumber(p.current_price),
      pnl: toNumber(p.unrealized_pl),
      pnlPercent: toNumber(p.unrealized_plpc) * 100,
    };
  }

  return {
    balance: toNumber(accountRecord.cash),
    equity: toNumber(accountRecord.equity),
    currency: toStringValue(accountRecord.currency, "USD"),
    positions: positionMap,
  };
}

async function getOrdersSnapshot() {
  const orders = asArray(
    await alpaca.getOrders({
      status: "open",
      direction: "desc",
    }),
  );

  return orders.map((order) => {
    const o = asRecord(order);

    return {
      id: toStringValue(o.id),
      ticker: toStringValue(o.symbol).toUpperCase(),
      action: toStringValue(o.side).toUpperCase(),
      qty: toNumber(o.qty),
      orderType: toStringValue(o.order_type || o.type).toUpperCase(),
      limitPrice: o.limit_price ? toNumber(o.limit_price) : null,
      status: toStringValue(o.status),
    };
  });
}

async function getWatchlistQuotesFromAlpaca(
  tickers: string[],
  positions: Record<string, PositionSnapshot>,
): Promise<WatchlistItem[]> {
  const uniqueTickers = Array.from(
    new Set(
      tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean),
    ),
  );

  const items = await Promise.all(
    uniqueTickers.map(async (ticker): Promise<WatchlistItem> => {
      const position = positions[ticker];

      if (position && position.currentPrice > 0) {
        return {
          ticker,
          name: ticker,
          price: position.currentPrice,
          change: position.pnlPercent,
          isUp: position.pnlPercent >= 0,
        };
      }

      try {
        const latestTrade = await alpaca.getLatestTrade(ticker);
        const price = extractAlpacaPrice(latestTrade);

        if (price <= 0) {
          console.warn(
            `[WATCHLIST] Alpaca returned no price for ${ticker}`,
            latestTrade,
          );
        }

        return {
          ticker,
          name: ticker,
          price,
          change: 0,
          isUp: true,
        };
      } catch (error) {
        console.warn(
          `[WATCHLIST] Failed to fetch ${ticker} from Alpaca:`,
          error,
        );

        return {
          ticker,
          name: `${ticker} (unavailable)`,
          price: 0,
          change: 0,
          isUp: true,
        };
      }
    }),
  );

  return items;
}

async function getDashboardSnapshot() {
  const portfolio = await getPortfolioSnapshot();
  const orders = await getOrdersSnapshot();

  const tickers = Array.from(
    new Set([
      ...defaultWatchlist,
      ...Object.keys(portfolio.positions),
      ...orders.map((order) => order.ticker),
    ]),
  ).filter(Boolean);

  const watchlist = await getWatchlistQuotesFromAlpaca(
    tickers,
    portfolio.positions,
  );

  return {
    tradeMode: ENV.TRADE_MODE,
    autopilotEnabled: autopilotWorker.getStatus().enabled,
    autopilot: autopilotWorker.getStatus(),
    portfolio,
    orders,
    watchlist,
  };
}

async function getEstimatedPrice(ticker: string, fallbackPrice?: number) {
  if (fallbackPrice && fallbackPrice > 0) return fallbackPrice;

  const latestTrade = await alpaca.getLatestTrade(ticker);
  const numericPrice = extractAlpacaPrice(latestTrade);

  return numericPrice > 0 ? numericPrice : 1;
}

async function executeSafeTrade(
  rawTicker: string,
  rawAction: string,
  rawRequestedShares: number,
  rawOrderType: string = "market",
  limitPrice?: number,
  stopLoss?: number,
  takeProfit?: number,
) {
  try {
    const ticker = rawTicker.trim().toUpperCase();
    const action = rawAction.toUpperCase() as "BUY" | "SELL";
    const requestedShares = Number(rawRequestedShares);
    const orderType = rawOrderType.toLowerCase();

    if (!ticker || !Number.isFinite(requestedShares) || requestedShares <= 0) {
      return {
        status: "rejected",
        reason: "Invalid ticker or share quantity.",
      };
    }

    const accountRecord = asRecord(await alpaca.getAccount());
    const positions = asArray(await alpaca.getPositions());
    const estimatedPrice = await getEstimatedPrice(ticker, limitPrice);

    const previousEquity =
      toNumber(accountRecord.last_equity) || toNumber(accountRecord.equity);
    const currentEquity = toNumber(accountRecord.equity);

    const dailyDrawdown =
      previousEquity > 0
        ? (currentEquity - previousEquity) / previousEquity
        : 0;

    const accountState: AccountState = {
      equity: currentEquity,
      cash: toNumber(accountRecord.cash),
      dailyDrawdownPercent: dailyDrawdown,
      currentPositions: positions.map((position) => {
        const p = asRecord(position);

        return {
          ticker: toStringValue(p.symbol).toUpperCase(),
          shares: toNumber(p.qty),
          marketValue: toNumber(p.market_value),
        };
      }),
    };

    const riskResult = evaluateTrade(
      {
        ticker,
        action,
        requestedShares,
        estimatedPrice,
      },
      accountState,
    );

    if (!riskResult.approved) {
      broadcastSSE({
        type: "notification",
        level: "error",
        message: riskResult.reason,
      });

      await sendTelegramAlert(
        `REJECTED ${action} ${ticker}: ${riskResult.reason}`,
      );

      return {
        status: "rejected",
        reason: riskResult.reason,
      };
    }

    const finalShares = riskResult.adjustedShares;

    const orderPayload: UnknownRecord = {
      symbol: ticker,
      qty: finalShares,
      side: action.toLowerCase(),
      type: orderType,
      time_in_force: orderType === "limit" ? "gtc" : "day",
    };

    if (orderType === "limit") {
      if (!limitPrice || limitPrice <= 0) {
        return {
          status: "rejected",
          reason: "Limit order requires a positive limitPrice.",
        };
      }

      orderPayload.limit_price = limitPrice;
    }

    if (action === "BUY" && (stopLoss || takeProfit)) {
      orderPayload.order_class = "bracket";

      if (takeProfit && takeProfit > 0) {
        orderPayload.take_profit = { limit_price: takeProfit };
      }

      if (stopLoss && stopLoss > 0) {
        orderPayload.stop_loss = { stop_price: stopLoss };
      }
    }

    const createdOrder = asRecord(await alpaca.createOrder(orderPayload));
    const orderId = toStringValue(createdOrder.id);

    transactionHistory.push({
      timestamp: new Date().toISOString(),
      ticker,
      action,
      shares: finalShares,
      price: estimatedPrice,
      orderId,
    });

    broadcastSSE({
      type: "trade",
      data: {
        ticker,
        action,
        shares: finalShares,
        price: estimatedPrice,
        orderId,
      },
    });

    await sendTelegramAlert(
      `ORDER ${action} ${finalShares} ${ticker} @ approx $${estimatedPrice}`,
    );

    return {
      status: "success",
      order: createdOrder,
      adjustedShares: finalShares,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown trade error";
    console.error("[TRADE] Failed:", error);

    return {
      status: "error",
      reason: message,
    };
  }
}

const autopilotWorker = createAutopilotWorker({
  tradeMode: ENV.TRADE_MODE,
  getPortfolioSnapshot,
  executeSafeTrade,
  broadcastSSE,
  sendTelegramAlert,
});

function createMarketContext(
  snapshot: Awaited<ReturnType<typeof getDashboardSnapshot>>,
) {
  return [
    "CURRENT ALPACA SNAPSHOT:",
    JSON.stringify({
      tradeMode: snapshot.tradeMode,
      autopilotEnabled: snapshot.autopilotEnabled,
      equity: snapshot.portfolio.equity,
      cash: snapshot.portfolio.balance,
      currency: snapshot.portfolio.currency,
      positions: snapshot.portfolio.positions,
      openOrders: snapshot.orders,
      watchlist: snapshot.watchlist,
      autopilot: snapshot.autopilot,
    }),
    "",
    "USER MESSAGE:",
  ].join("\n");
}

// -----------------------------------------------------------------------------
// ROUTES
// -----------------------------------------------------------------------------

app.get("/health", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    service: "ai-trading-agent-backend",
    mode: ENV.TRADE_MODE,
    yahooFinance: "removed",
    autopilot: autopilotWorker.getStatus(),
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/mode", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ mode: ENV.TRADE_MODE });
});

app.get("/api/stream", (req, res) => {
  console.log("[SSE] Incoming connection request");

  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Access-Control-Allow-Origin", "*");

  (res as unknown as { flushHeaders?: () => void }).flushHeaders?.();

  sseClients.add(res);

  console.log(`[SSE] Client connected. total=${sseClients.size}`);

  res.write(": connected\n\n");
  writeSSE(res, {
    type: "connected",
    tradeMode: ENV.TRADE_MODE,
    autopilot: autopilotWorker.getStatus(),
    timestamp: new Date().toISOString(),
  });

  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(heartbeat);
      sseClients.delete(res);
      return;
    }

    res.write(": heartbeat\n\n");
  }, 10_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    console.log(`[SSE] Client disconnected. total=${sseClients.size}`);
    res.end();
  });
});

app.get("/api/dashboard", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    res.json(await getDashboardSnapshot());
  } catch (error) {
    console.error("[API] /api/dashboard failed:", error);
    res.status(500).json({ error: "Failed to fetch dashboard data" });
  }
});

app.get("/api/portfolio", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    res.json(await getPortfolioSnapshot());
  } catch (error) {
    console.error("[API] /api/portfolio failed:", error);
    res.status(500).json({ error: "Failed to fetch portfolio" });
  }
});

app.get("/api/orders", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    res.json(await getOrdersSnapshot());
  } catch (error) {
    console.error("[API] /api/orders failed:", error);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

app.get("/api/watchlist", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    const portfolio = await getPortfolioSnapshot();

    const tickers = Array.from(
      new Set([...defaultWatchlist, ...Object.keys(portfolio.positions)]),
    ).filter(Boolean);

    res.json(await getWatchlistQuotesFromAlpaca(tickers, portfolio.positions));
  } catch (error) {
    console.error("[API] /api/watchlist failed:", error);
    res.status(500).json({ error: "Failed to fetch watchlist" });
  }
});

app.get("/api/autopilot/status", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(autopilotWorker.getStatus());
});

app.post("/api/autopilot/run-once", async (_req, res) => {
  const result = await autopilotWorker.runOnce("manual");
  res.json(result);
});

app.post("/api/trade", async (req, res) => {
  const tradeSchema = z.object({
    ticker: z.string().trim().min(1),
    action: z.enum(["BUY", "SELL"]),
    shares: z.coerce.number().positive(),
    orderType: z
      .string()
      .default("market")
      .transform((value) => value.toLowerCase()),
    limitPrice: z.coerce.number().positive().optional(),
    stopLoss: z.coerce.number().positive().optional(),
    takeProfit: z.coerce.number().positive().optional(),
  });

  const parsed = tradeSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid trade request",
      details: parsed.error.flatten(),
    });
  }

  const result = await executeSafeTrade(
    parsed.data.ticker,
    parsed.data.action,
    parsed.data.shares,
    parsed.data.orderType,
    parsed.data.limitPrice,
    parsed.data.stopLoss,
    parsed.data.takeProfit,
  );

  if (result.status !== "success") {
    return res.status(400).json({
      success: false,
      error: result.reason || "Trade rejected",
      result,
    });
  }

  res.json({
    success: true,
    result,
  });
});

app.post("/api/chat", async (req, res) => {
  try {
    const chatSchema = z.object({
      message: z.string().min(1),
      history: z.array(z.unknown()).optional().default([]),
    });

    const parsed = chatSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid chat request",
        details: parsed.error.flatten(),
      });
    }

    const snapshot = await getDashboardSnapshot();
    const enrichedMessage = `${createMarketContext(snapshot)}\n${parsed.data.message}`;

    const response = await runTradingAgentStep(
      enrichedMessage,
      parsed.data.history,
      transactionHistory,
      executeSafeTrade,
    );

    res.json({
      reply: response.text,
      chartData: response.chartData,
      ticker: response.ticker,
      portfolio: response.portfolio,
      technicalData: response.technicalData,
      sentimentData: response.sentimentData,
      fundamentalData: response.fundamentalData,
    });
  } catch (error) {
    console.error("[API] /api/chat failed:", error);
    res.status(500).json({ error: "AI engine error" });
  }
});

app.post("/api/autopilot", (req, res) => {
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid autopilot request",
      details: parsed.error.flatten(),
    });
  }

  autopilotWorker.setEnabled(parsed.data.enabled);

  res.json({
    success: true,
    enabled: autopilotWorker.getStatus().enabled,
    autopilot: autopilotWorker.getStatus(),
  });
});

autopilotWorker.start();

app.listen(ENV.PORT, () => {
  console.log("");
  console.log("[SERVER] AI Trading Agent backend is running");
  console.log(`[SERVER] URL: http://localhost:${ENV.PORT}`);
  console.log(`[SERVER] Mode: ${ENV.TRADE_MODE}`);
  console.log(`[SERVER] Frontend origin: ${ENV.FRONTEND_ORIGIN}`);
  console.log("[SERVER] Yahoo Finance: removed");
  console.log(
    `[SERVER] Autopilot: ${autopilotWorker.getStatus().enabled ? "enabled" : "disabled"} / ${
      autopilotWorker.getStatus().executeTrades ? "execution" : "dry-run"
    }`,
  );
  console.log("");
});
