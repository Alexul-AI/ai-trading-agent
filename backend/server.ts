import express, { type Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import * as AlpacaModule from "@alpacahq/alpaca-trade-api";
import { z } from "zod";

import {
  runTradingAgentStep,
  getNewsSentiment,
  getFundamentals,
  getInsiderActivity,
} from "./agent.js";
import { evaluateTrade, type AccountState } from "./riskManager.js";
import { createAutopilotWorker } from "./autopilotWorker.js";
import {
  getPortfolioCircuitBreakerState,
  resetPortfolioCircuitBreaker,
  getMaxDrawdownFromPeakPercent,
  type EquityHistoryPoint,
} from "./portfolioCircuitBreaker.js";
import { appendCircuitBreakerAuditEvent } from "./circuitBreakerAuditLog.js";
import {
  readRebalanceStateStrict,
  recordRebalanceTerminal,
} from "./etfRotationWorkerState.js";
import {
  appendEtfRotationOrderAuditEvent,
  readEtfRotationOrderAuditLog,
} from "./etfRotationOrderAuditLog.js";
import {
  classifyOrderError,
  createPersistedClientOrderIdTracker,
  type AlpacaErrorLike,
  type OrderErrorClassification,
} from "./orderIdempotency.js";
import { createAdminAuth } from "./src/auth/adminAuth.js";
import {
  getAutopilotJournalPath,
  getJournalTruncationInfo,
  readAutopilotRuns,
  summarizeAutopilotRuns,
} from "./decisionJournal.js";
import { buildHealthReport, getSafeErrorMessage } from "./envHealth.js";
import {
  buildDashboardHealthSummary,
  safeCall,
} from "./src/dashboard/health.js";
import type {
  UnknownRecord,
  PositionSnapshot,
  MarketChartResponse,
  AlpacaConstructor,
} from "./src/types/serverTypes.js";
import {
  asArray,
  asRecord,
  toNumber,
  toStringValue,
} from "./src/utils/values.js";
import { buildMarketChartPoints } from "./src/market/chartPoints.js";
import { createAlpacaMarketData } from "./src/market/alpacaMarketData.js";
import {
  normalizeCorsOrigin,
  parseCorsOrigins,
  resolveAllowedCorsOrigin,
} from "./src/config/cors.js";
import { getBuildInfo } from "./src/config/buildInfo.js";

dotenv.config();

const defaultWatchlist = ["NVDA", "AAPL", "TSLA", "MSFT", "AMD"];
const ALPACA_DATA_FEED = process.env.ALPACA_DATA_FEED || "iex";

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

  ADMIN_API_TOKEN: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  ADMIN_SESSION_SECRET: z.string().optional(),

  ALLOW_MANUAL_TRADES: z.enum(["true", "false"]).default("false"),
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

const allowedCorsOrigins = parseCorsOrigins(ENV.FRONTEND_ORIGIN);

if (allowedCorsOrigins.length === 0) {
  console.error("[ENV] FRONTEND_ORIGIN must contain at least one origin.");
  process.exit(1);
}

app.use(
  cors({
    origin(
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) {
      if (!origin) {
        callback(null, true);
        return;
      }

      const normalizedOrigin = normalizeCorsOrigin(origin);

      if (allowedCorsOrigins.includes(normalizedOrigin)) {
        callback(null, true);
        return;
      }

      console.warn(`[CORS] Blocked origin: ${origin}`);
      callback(null, false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-admin-token"],
    credentials: true,
  }),
);

app.use(express.json({ limit: "1mb" }));

const adminAuth = createAdminAuth({
  adminApiToken: ENV.ADMIN_API_TOKEN,
  adminPassword: ENV.ADMIN_PASSWORD,
  adminSessionSecret: ENV.ADMIN_SESSION_SECRET,
  tradeMode: ENV.TRADE_MODE,
  nodeEnv: process.env.NODE_ENV,
});

const {
  getAdminSessionSecret,
  timingSafeEqualString,
  hasValidAdminSession,
  setAdminSessionCookie,
  clearAdminSessionCookie,
  requireAdminToken,
} = adminAuth;

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

function areManualTradesAllowed(): boolean {
  return ENV.ALLOW_MANUAL_TRADES === "true";
}

const alpaca = new AlpacaClient({
  keyId: isLiveMode ? ENV.APCA_API_KEY_ID_LIVE! : ENV.APCA_API_KEY_ID,
  secretKey: isLiveMode
    ? ENV.APCA_API_SECRET_KEY_LIVE!
    : ENV.APCA_API_SECRET_KEY,
  paper: !isLiveMode,
});

const marketData = createAlpacaMarketData({
  alpaca,
  isLiveMode,
  alpacaDataFeed: ALPACA_DATA_FEED,
  paperKeyId: ENV.APCA_API_KEY_ID,
  paperSecretKey: ENV.APCA_API_SECRET_KEY,
  liveKeyId: ENV.APCA_API_KEY_ID_LIVE,
  liveSecretKey: ENV.APCA_API_SECRET_KEY_LIVE,
});

const {
  fetchAlpacaMarketClock,
  getWatchlistQuotesFromAlpaca,
  fetchDailyBarsForChart,
  getEstimatedPrice,
} = marketData;

let transactionHistory: Array<{
  timestamp: string;
  ticker: string;
  action: "BUY" | "SELL";
  shares: number;
  notional?: number;
  price: number;
  orderId?: string;
}> = [];

// Kept alive for this process's lifetime (see orderIdempotency.ts) - a
// client_order_id for a given ticker+action is held until we get a
// definitive outcome, not regenerated per call. Persisted to
// data/order-idempotency-state.json so a pending ambiguous-error entry
// survives a restart instead of letting a retry mint a fresh id that
// Alpaca's own dedup can't catch (docs/ops/PAPER_INFRASTRUCTURE_GATE.md
// item 4).
const clientOrderIdTracker = await createPersistedClientOrderIdTracker();

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

// Feeds the portfolio circuit breaker's peak-equity tracking (see
// portfolioCircuitBreaker.ts) - leans on Alpaca's own durably-stored equity
// history instead of us maintaining that number ourselves in a local file.
async function getEquityHistorySince(
  startDate: string,
): Promise<EquityHistoryPoint[]> {
  // Alpaca rejects the request if its own default date_end resolves to
  // before date_start (observed: when date_start is "today", the default
  // end can land on the prior session's open) - pass an explicit date_end
  // a day ahead to always stay on the safe side of that comparison.
  const dateEnd = new Date();
  dateEnd.setDate(dateEnd.getDate() + 1);

  const history = asRecord(
    await alpaca.getPortfolioHistory({
      date_start: startDate.split("T")[0],
      date_end: dateEnd.toISOString().split("T")[0],
      timeframe: "1D",
    }),
  );

  const timestamps = asArray(history.timestamp);
  const equityValues = asArray(history.equity);

  const points: EquityHistoryPoint[] = [];

  for (let i = 0; i < timestamps.length; i += 1) {
    const timestamp = toNumber(timestamps[i]);
    const equity = toNumber(equityValues[i]);

    if (Number.isFinite(timestamp) && equity > 0) {
      points.push({ timestamp, equity });
    }
  }

  return points;
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

async function getDashboardSnapshot() {
  const health = await buildDashboardHealthSummary();
  const warnings = [...health.warnings];

  const portfolio = await safeCall(
    "alpaca_portfolio",
    getPortfolioSnapshot,
    {
      balance: 0,
      equity: 0,
      currency: "USD",
      positions: {},
    },
    warnings,
  );

  const orders = await safeCall(
    "alpaca_orders",
    getOrdersSnapshot,
    [],
    warnings,
  );

  const watchlistTickers = Array.from(
    new Set([...defaultWatchlist, ...Object.keys(portfolio.positions)]),
  ).filter(Boolean);

  const watchlist = await safeCall(
    "alpaca_watchlist",
    () => getWatchlistQuotesFromAlpaca(watchlistTickers, portfolio.positions),
    [],
    warnings,
  );

  return {
    tradeMode: ENV.TRADE_MODE,
    autopilotEnabled: autopilotWorker.getStatus().enabled,
    autopilot: autopilotWorker.getStatus(),
    portfolio,
    orders,
    watchlist,
    health: {
      ok: warnings.length === 0,
      warnings,
    },
  };
}

// Carries classifyOrderError's classification through executeSafeTrade's
// own outer try/catch below, which otherwise collapses every failure into
// an identical { status: "error", reason } - losing the ambiguous-vs-
// definitive distinction before any caller ever sees it. Purely additive:
// nothing here changes existing behavior for any current caller of
// executeSafeTrade (all of them only ever read status/reason), but a
// caller that wants the classification (the ETF Rotation execution
// adapter, etfRotationExecution.ts) can now recover it.
class ClassifiedOrderError extends Error {
  readonly classification: OrderErrorClassification;

  constructor(classification: OrderErrorClassification, cause: unknown) {
    super(cause instanceof Error ? cause.message : "Unknown trade error");
    this.name = "ClassifiedOrderError";
    this.classification = classification;
  }
}

async function executeSafeTrade(
  rawTicker: string,
  rawAction: string,
  rawRequestedShares: number,
  rawOrderType: string = "market",
  limitPrice?: number,
  stopLoss?: number,
  takeProfit?: number,
  rawNotional?: number,
) {
  try {
    const ticker = rawTicker.trim().toUpperCase();
    const action = rawAction.toUpperCase() as "BUY" | "SELL";
    const requestedShares = Number(rawRequestedShares);
    const orderType = rawOrderType.toLowerCase();
    const requestedNotional =
      rawNotional !== undefined &&
      Number.isFinite(rawNotional) &&
      rawNotional > 0
        ? Number(rawNotional)
        : undefined;
    // Fractional-fallback BUY (see strategyEngine.ts's allowFractionalShares):
    // requestedShares is 0 in this case, a notional dollar amount drives
    // sizing instead.
    const isNotionalOrder = requestedNotional !== undefined && requestedShares <= 0;

    if (
      !ticker ||
      (!isNotionalOrder &&
        (!Number.isFinite(requestedShares) || requestedShares <= 0))
    ) {
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

    if (action === "BUY") {
      const circuitBreakerState = await getPortfolioCircuitBreakerState();

      if (circuitBreakerState?.tripped) {
        const reason = `REJECTED: Portfolio circuit breaker tripped (equity down from peak ${circuitBreakerState.peakEquity.toFixed(
          2,
        )}). New BUYs blocked until reset via /api/autopilot/circuit-breaker/reset.`;

        broadcastSSE({
          type: "notification",
          level: "error",
          message: reason,
        });

        return {
          status: "rejected",
          reason,
        };
      }

      if (circuitBreakerState?.dataStale) {
        const reason =
          "REJECTED: Portfolio circuit breaker could not confirm current drawdown (equity history fetch failed) - new BUYs blocked until it succeeds again.";

        broadcastSSE({
          type: "notification",
          level: "error",
          message: reason,
        });

        return {
          status: "rejected",
          reason,
        };
      }
    }

    const riskResult = evaluateTrade(
      {
        ticker,
        action,
        requestedShares: isNotionalOrder ? 0 : requestedShares,
        estimatedPrice,
        requestedNotional: isNotionalOrder ? requestedNotional : undefined,
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
    const finalNotional = riskResult.adjustedNotional;

    const clientOrderId = await clientOrderIdTracker.getOrCreate(ticker, action);

    const orderPayload: UnknownRecord = {
      symbol: ticker,
      side: action.toLowerCase(),
      type: orderType,
      // Alpaca requires time_in_force=day for fractional/notional orders
      // (no gtc/ioc/fok/opg/cls) - forced regardless of orderType here.
      time_in_force:
        finalNotional !== undefined
          ? "day"
          : orderType === "limit"
            ? "gtc"
            : "day",
      client_order_id: clientOrderId,
    };

    if (finalNotional !== undefined) {
      orderPayload.notional = finalNotional;
    } else {
      orderPayload.qty = finalShares;
    }

    if (orderType === "limit") {
      if (!limitPrice || limitPrice <= 0) {
        return {
          status: "rejected",
          reason: "Limit order requires a positive limitPrice.",
        };
      }

      orderPayload.limit_price = limitPrice;
    }

    // No bracket for fractional/notional orders - Alpaca's docs don't
    // confirm order_class=bracket works with notional sizing, so we don't
    // assume it does (see strategyEngine.ts's allowFractionalShares).
    if (
      action === "BUY" &&
      finalNotional === undefined &&
      (stopLoss || takeProfit)
    ) {
      orderPayload.order_class = "bracket";

      if (takeProfit && takeProfit > 0) {
        orderPayload.take_profit = { limit_price: takeProfit };
      }

      if (stopLoss && stopLoss > 0) {
        orderPayload.stop_loss = { stop_price: stopLoss };
      }
    }

    let createdOrder: UnknownRecord;

    try {
      createdOrder = asRecord(await alpaca.createOrder(orderPayload));
      await clientOrderIdTracker.clear(ticker, action);
    } catch (orderError) {
      const classification = classifyOrderError(
        orderError as AlpacaErrorLike,
      );

      if (classification === "duplicate_client_order_id") {
        // Our previous attempt with this exact client_order_id actually
        // went through (this call is a retry after we couldn't confirm
        // that) - fetch what Alpaca actually did instead of erroring.
        createdOrder = asRecord(
          await alpaca.getOrderByClientId(clientOrderId),
        );
        await clientOrderIdTracker.clear(ticker, action);
      } else if (classification === "definitive_rejection") {
        // A real problem with the order itself - retrying the identical
        // request won't fix it, safe to free up this ticker+action for a
        // fresh attempt.
        await clientOrderIdTracker.clear(ticker, action);
        throw new ClassifiedOrderError(classification, orderError);
      } else {
        // Ambiguous network error (timeout, DNS, connection reset) - we
        // genuinely don't know if Alpaca received it. Deliberately do NOT
        // clear the tracker: a future attempt for this ticker+action
        // reuses this same client_order_id, so if it turns out this
        // attempt did land, that retry resolves safely via the duplicate
        // branch above instead of submitting a second real order.
        throw new ClassifiedOrderError(classification, orderError);
      }
    }

    const orderId = toStringValue(createdOrder.id);
    const quantityLabel =
      finalNotional !== undefined
        ? `$${finalNotional.toFixed(2)} (fractional)`
        : `${finalShares}`;

    transactionHistory.push({
      timestamp: new Date().toISOString(),
      ticker,
      action,
      shares: finalShares,
      notional: finalNotional,
      price: estimatedPrice,
      orderId,
    });

    broadcastSSE({
      type: "trade",
      data: {
        ticker,
        action,
        shares: finalShares,
        notional: finalNotional,
        price: estimatedPrice,
        orderId,
      },
    });

    await sendTelegramAlert(
      `ORDER ${action} ${quantityLabel} ${ticker} @ approx $${estimatedPrice}`,
    );

    return {
      status: "success",
      order: createdOrder,
      adjustedShares: finalShares,
      adjustedNotional: finalNotional,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown trade error";
    console.error("[TRADE] Failed:", error);

    return {
      status: "error",
      reason: message,
      classification:
        error instanceof ClassifiedOrderError ? error.classification : undefined,
    };
  }
}

const autopilotWorker = createAutopilotWorker({
  tradeMode: ENV.TRADE_MODE,
  getPortfolioSnapshot,
  getEquityHistorySince,
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
// ADMIN AUTH ROUTES
// -----------------------------------------------------------------------------

app.get("/api/admin/session", (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  res.json({
    authenticated: hasValidAdminSession(req),
    loginEnabled: Boolean(ENV.ADMIN_PASSWORD),
    sessionConfigured: Boolean(getAdminSessionSecret()),
  });
});

app.post("/api/admin/login", (req, res) => {
  const parsed = z.object({ password: z.string().min(1) }).safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid login request",
      details: parsed.error.flatten(),
    });
    return;
  }

  if (!ENV.ADMIN_PASSWORD || !getAdminSessionSecret()) {
    res.status(503).json({
      error: "Admin session login is not configured.",
    });
    return;
  }

  if (!timingSafeEqualString(parsed.data.password, ENV.ADMIN_PASSWORD)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  setAdminSessionCookie(req, res);
  res.json({ success: true, authenticated: true });
});

app.post("/api/admin/logout", (req, res) => {
  clearAdminSessionCookie(req, res);
  res.json({ success: true, authenticated: false });
});
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
  const sseAllowedOrigin = resolveAllowedCorsOrigin(
    typeof req.headers.origin === "string" ? req.headers.origin : undefined,
    allowedCorsOrigins,
  );

  if (sseAllowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", sseAllowedOrigin);
    res.setHeader("Vary", "Origin");
  }

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

app.get("/api/health", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    const deep =
      String(req.query.deep ?? "false").toLowerCase() === "true" ||
      String(req.query.deep ?? "0") === "1";

    const report = await buildHealthReport({
      checkAlpacaConnectivity: deep,
      checkOpenAIConnectivity: false,
    });

    res.status(report.ok ? 200 : 503).json({
      ...report,
      build: getBuildInfo(),
    });
  } catch (error) {
    console.error("[API] /api/health failed:", error);
    res.status(500).json({
      ok: false,
      error: getSafeErrorMessage(error),
    });
  }
});

app.get("/api/dashboard", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    res.json(await getDashboardSnapshot());
  } catch (error) {
    console.error("[API] /api/dashboard failed:", error);

    res.status(200).json({
      tradeMode: ENV.TRADE_MODE,
      autopilotEnabled: autopilotWorker.getStatus().enabled,
      autopilot: autopilotWorker.getStatus(),
      portfolio: {
        balance: 0,
        equity: 0,
        currency: "USD",
        positions: {},
      },
      orders: [],
      watchlist: [],
      health: {
        ok: false,
        warnings: [
          {
            service: "dashboard",
            status: "error",
            message: getSafeErrorMessage(error),
          },
        ],
      },
    });
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

app.get("/api/market/clock", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    res.json(await fetchAlpacaMarketClock());
  } catch (error) {
    console.error("[API] /api/market/clock failed:", error);
    res.status(500).json({
      error:
        error instanceof Error ? error.message : "Failed to load market clock",
    });
  }
});

app.get("/api/market/chart/:ticker", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    const ticker = String(req.params.ticker ?? "")
      .trim()
      .toUpperCase();
    const days = Number.parseInt(String(req.query.days ?? "120"), 10);
    const safeDays = Number.isFinite(days) ? days : 120;
    const clampedDays = Math.max(30, Math.min(365, safeDays));
    const bars = await fetchDailyBarsForChart(ticker, safeDays);

    const payload: MarketChartResponse = {
      ticker,
      days: clampedDays,
      feed: ALPACA_DATA_FEED,
      // bars includes extra warm-up history so RSI/MACD are computed
      // accurately; trim to the requested display window here.
      points: buildMarketChartPoints(bars, clampedDays),
    };

    res.json(payload);
  } catch (error) {
    console.error("[API] /api/market/chart/:ticker failed:", error);
    res.status(500).json({
      error:
        error instanceof Error ? error.message : "Failed to load chart data",
    });
  }
});

app.get("/api/autopilot/status", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(autopilotWorker.getStatus());
});

app.get("/api/autopilot/journal", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    const limit = Number.parseInt(String(req.query.limit ?? "50"), 10);
    const [runs, truncationInfo] = await Promise.all([
      readAutopilotRuns(Number.isFinite(limit) ? limit : 50),
      getJournalTruncationInfo(),
    ]);

    res.json({
      file: getAutopilotJournalPath(),
      runs,
      truncated: truncationInfo.truncated,
      fileSizeBytes: truncationInfo.fileSizeBytes,
    });
  } catch (error) {
    console.error("[API] /api/autopilot/journal failed:", error);
    res.status(500).json({ error: "Failed to read autopilot journal" });
  }
});

app.get("/api/autopilot/journal/summary", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    const limit = Number.parseInt(String(req.query.limit ?? "200"), 10);
    const summary = await summarizeAutopilotRuns(
      Number.isFinite(limit) ? limit : 200,
    );

    res.json(summary);
  } catch (error) {
    console.error("[API] /api/autopilot/journal/summary failed:", error);
    res.status(500).json({ error: "Failed to summarize autopilot journal" });
  }
});

app.post("/api/autopilot/run-once", requireAdminToken, async (_req, res) => {
  const result = await autopilotWorker.runOnce("manual");
  res.json(result);
});

const circuitBreakerResetSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required to reset the circuit breaker."),
});

app.post(
  "/api/autopilot/circuit-breaker/reset",
  requireAdminToken,
  async (req, res) => {
    const parsedBody = circuitBreakerResetSchema.safeParse(req.body);

    if (!parsedBody.success) {
      res.status(400).json({
        error: parsedBody.error.flatten().fieldErrors.reason?.[0] ??
          "A reason is required to reset the circuit breaker.",
      });
      return;
    }

    const { reason } = parsedBody.data;

    try {
      const portfolio = await getPortfolioSnapshot();
      const previousState = await getPortfolioCircuitBreakerState();
      const state = await resetPortfolioCircuitBreaker(portfolio.equity);

      const drawdownPercent = previousState
        ? ((portfolio.equity - previousState.peakEquity) /
            previousState.peakEquity) *
          100
        : 0;

      await appendCircuitBreakerAuditEvent({
        type: "CIRCUIT_BREAKER_RESET",
        timestamp: new Date().toISOString(),
        equity: portfolio.equity,
        peakEquity: previousState?.peakEquity ?? state.peakEquity,
        drawdownPercent,
        thresholdPercent: getMaxDrawdownFromPeakPercent() * 100,
        reason,
      });

      const confirmationMessage = `Circuit breaker manually reset.\nPrevious peak: ${(
        previousState?.peakEquity ?? state.peakEquity
      ).toFixed(2)}\nNew peak (rebased to current equity): ${state.peakEquity.toFixed(
        2,
      )}\nReason: ${reason}`;

      broadcastSSE({
        type: "notification",
        level: "info",
        message: confirmationMessage,
      });

      await sendTelegramAlert(confirmationMessage);

      res.json({ status: "reset", state });
    } catch (error) {
      console.error("[API] /api/autopilot/circuit-breaker/reset failed:", error);
      res.status(500).json({ error: "Failed to reset circuit breaker" });
    }
  },
);

// Read-only, no admin gate (same convention as /api/dashboard and
// /api/autopilot/journal) - this only surfaces data that already exists
// elsewhere (breaker state, portfolio, journal), nothing new is computed
// that would need to be kept private.
app.get("/api/autopilot/circuit-breaker/review", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    // A long halt can outlast a single fetch's window - the next-open
    // backtest finding (CLAUDE.md) saw one span 315 days, which at this
    // worker's hourly cadence is ~7,500+ runs. journalTruncated only signals
    // the journal FILE being bigger than the tail-read's byte window; it
    // says nothing about whether this specific fetch reaches back to
    // trippedAt, so it can't be trusted alone to vouch for
    // blockedBuyCountSinceHalt below. Widened past the default 5MB/50-run
    // read (this is an on-demand admin fetch, not the ~15s-polled
    // dashboard, so a larger, slower read here is an acceptable trade).
    const [circuitBreakerState, portfolio, journalRuns, truncationInfo] =
      await Promise.all([
        getPortfolioCircuitBreakerState(),
        getPortfolioSnapshot(),
        readAutopilotRuns(10000, undefined, 20 * 1024 * 1024),
        getJournalTruncationInfo(),
      ]);

    const tripped = circuitBreakerState?.tripped ?? false;
    const trippedAt = circuitBreakerState?.trippedAt ?? null;
    const peakEquity = circuitBreakerState?.peakEquity ?? 0;
    const drawdownFromPeakPercent =
      peakEquity > 0
        ? ((portfolio.equity - peakEquity) / peakEquity) * 100
        : 0;
    const daysHalted = trippedAt
      ? Math.max(
          1,
          Math.round(
            (Date.now() - Date.parse(trippedAt)) / (24 * 60 * 60 * 1000),
          ),
        )
      : null;

    const blockedDecisions = trippedAt
      ? journalRuns
          .flatMap((run) => run.decisions)
          .filter(
            (decision) =>
              decision.blockReasonCode === "PORTFOLIO_CIRCUIT_BREAKER" &&
              decision.timestamp >= trippedAt,
          )
      : [];

    // readAutopilotRuns returns most-recent-first, so the last element is
    // the oldest run actually fetched. If that's still after trippedAt, the
    // fetch window didn't reach back to the trip - blockedBuyCountSinceHalt
    // is then a lower bound over the loaded window only, not a true total.
    const oldestFetchedRunTimestamp =
      journalRuns.length > 0
        ? journalRuns[journalRuns.length - 1]!.timestamp
        : null;
    const blockedSignalDataCoversFullHalt =
      !trippedAt ||
      (oldestFetchedRunTimestamp !== null &&
        oldestFetchedRunTimestamp <= trippedAt);

    res.json({
      tripped,
      trippedAt,
      haltReason: tripped
        ? "Portfolio equity drew down more than the configured threshold from its peak."
        : null,
      peakEquity,
      peakEquityAt: circuitBreakerState?.peakEquityAt ?? null,
      currentEquity: portfolio.equity,
      drawdownFromPeakPercent,
      thresholdPercent: getMaxDrawdownFromPeakPercent() * 100,
      daysHalted,
      blockedBuyCountSinceHalt: blockedDecisions.length,
      // True total only when this is true - otherwise blockedBuyCountSinceHalt
      // and recentBlockedSignals are a lower bound over the fetched journal
      // window, not the whole halt. See comment above the journal fetch.
      blockedSignalDataCoversFullHalt,
      recentBlockedSignals: blockedDecisions.slice(0, 10).map((decision) => ({
        ticker: decision.ticker,
        timestamp: decision.timestamp,
        price: decision.price,
        reason: decision.blockReasonDetail ?? decision.reason,
      })),
      journalTruncated: truncationInfo.truncated,
      positions: portfolio.positions,
      cash: portfolio.balance,
    });
  } catch (error) {
    console.error(
      "[API] /api/autopilot/circuit-breaker/review failed:",
      error,
    );
    res.status(500).json({ error: "Failed to load circuit breaker review" });
  }
});

// Read-only, no admin gate - same convention as the circuit-breaker review
// endpoint above (surfaces data that already exists elsewhere, nothing new
// is computed that would need to be kept private). Per
// docs/ops/ETF_ROTATION_PAPER_EXECUTION_PLAN.md §11's Stage 2A resolution:
// this is the "manual review" surface for a rebalance left in
// failed_needs_review, assembling one merged view instead of requiring a
// human to grep the audit log and cross-reference Alpaca's dashboard by
// hand. Uses the fail-closed reader (readRebalanceStateStrict) so a
// corrupt/unreadable state file is surfaced explicitly (stateReadError)
// rather than silently presenting a blank, fresh-looking state.
app.get("/api/autopilot/etf-rotation/review", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    const [stateResult, recentOrderEvents, portfolio] = await Promise.all([
      readRebalanceStateStrict(),
      readEtfRotationOrderAuditLog(20),
      getPortfolioSnapshot(),
    ]);

    res.json({
      stateReadError: stateResult.corrupt,
      status: stateResult.state.status ?? null,
      rebalanceMonthKey: stateResult.state.rebalanceMonthKey ?? null,
      configVariantKey: stateResult.state.configVariantKey ?? null,
      lastRebalanceDateKey: stateResult.state.lastRebalanceDateKey,
      startedAt: stateResult.state.startedAt ?? null,
      completedAt: stateResult.state.completedAt ?? null,
      targets: stateResult.state.targets ?? null,
      plannedOrders: stateResult.state.plannedOrders ?? null,
      recentOrderAuditEvents: recentOrderEvents,
      positions: portfolio.positions,
      cash: portfolio.balance,
      currentEquity: portfolio.equity,
    });
  } catch (error) {
    console.error("[API] /api/autopilot/etf-rotation/review failed:", error);
    res.status(500).json({ error: "Failed to load ETF Rotation review" });
  }
});

const etfRotationClearReviewSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "A reason is required to clear an ETF Rotation review state."),
});

// Admin-gated manual clear for a rebalance stuck in failed_needs_review
// (docs/ops/ETF_ROTATION_PAPER_EXECUTION_PLAN.md §11's Stage 2A resolution)
// - mirrors the circuit-breaker reset endpoint's exact reason-required,
// audited pattern. Deliberately refuses (409) unless the current state is
// actually failed_needs_review - this is not a general-purpose reset, only
// an acknowledgement of one specific stuck condition. No automatic clear
// and no manual state-file editing are ever part of normal operation; this
// endpoint is the only sanctioned way to clear it. Transitions status to
// "cancelled" (via recordRebalanceTerminal) - never to "executed"/"partial",
// since a human clearing a review is acknowledging an interrupted attempt,
// not vouching that it succeeded. This never calls executeSafeTrade and
// does not itself trigger a new rebalance attempt - it only re-opens the
// monthly gate (isRebalanceMonthDone) for the next scheduled cycle to try
// again from scratch.
app.post(
  "/api/autopilot/etf-rotation/clear-review",
  requireAdminToken,
  async (req, res) => {
    const parsedBody = etfRotationClearReviewSchema.safeParse(req.body);

    if (!parsedBody.success) {
      res.status(400).json({
        error:
          parsedBody.error.flatten().fieldErrors.reason?.[0] ??
          "A reason is required to clear an ETF Rotation review state.",
      });
      return;
    }

    const { reason } = parsedBody.data;

    try {
      const { state, corrupt } = await readRebalanceStateStrict();

      if (corrupt || state.status !== "failed_needs_review") {
        res.status(409).json({
          error:
            "No ETF Rotation rebalance is currently in failed_needs_review - nothing to clear.",
          status: corrupt ? null : (state.status ?? null),
        });
        return;
      }

      await recordRebalanceTerminal("cancelled");

      await appendEtfRotationOrderAuditEvent({
        type: "REBALANCE_MANUALLY_CLEARED",
        timestamp: new Date().toISOString(),
        rebalanceMonthKey: state.rebalanceMonthKey ?? "unknown",
        configVariantKey: state.configVariantKey ?? "unknown",
        reason,
      });

      const confirmationMessage = `ETF Rotation rebalance manually cleared from failed_needs_review.\nMonth: ${
        state.rebalanceMonthKey ?? "unknown"
      }\nReason: ${reason}`;

      broadcastSSE({
        type: "notification",
        level: "info",
        message: confirmationMessage,
      });

      await sendTelegramAlert(confirmationMessage);

      res.json({ status: "cleared" });
    } catch (error) {
      console.error(
        "[API] /api/autopilot/etf-rotation/clear-review failed:",
        error,
      );
      res.status(500).json({ error: "Failed to clear ETF Rotation review" });
    }
  },
);

app.post("/api/trade", requireAdminToken, async (req, res) => {
  if (!areManualTradesAllowed()) {
    return res.status(403).json({
      success: false,
      code: "MANUAL_TRADES_DISABLED",
      error: "Manual trades are disabled by backend safety policy.",
    });
  }

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

app.post("/api/chat", requireAdminToken, async (req, res) => {
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

app.get("/api/news-sentiment/:ticker", requireAdminToken, async (req, res) => {
  try {
    const ticker = toStringValue(req.params.ticker).toUpperCase();

    if (!ticker) {
      return res.status(400).json({ error: "Ticker is required" });
    }

    const result = await getNewsSentiment(ticker);

    res.json(result);
  } catch (error) {
    console.error("[API] /api/news-sentiment failed:", error);
    res.status(500).json({ error: "News sentiment engine error" });
  }
});

app.get("/api/fundamentals/:ticker", requireAdminToken, async (req, res) => {
  try {
    const ticker = toStringValue(req.params.ticker).toUpperCase();

    if (!ticker) {
      return res.status(400).json({ error: "Ticker is required" });
    }

    const result = await getFundamentals(ticker);

    res.json(result);
  } catch (error) {
    console.error("[API] /api/fundamentals failed:", error);
    res.status(500).json({ error: "Fundamentals engine error" });
  }
});

app.get(
  "/api/insider-activity/:ticker",
  requireAdminToken,
  async (req, res) => {
    try {
      const ticker = toStringValue(req.params.ticker).toUpperCase();

      if (!ticker) {
        return res.status(400).json({ error: "Ticker is required" });
      }

      const result = await getInsiderActivity(ticker);

      res.json(result);
    } catch (error) {
      console.error("[API] /api/insider-activity failed:", error);
      res.status(500).json({ error: "Insider activity engine error" });
    }
  },
);

app.post("/api/autopilot", requireAdminToken, (req, res) => {
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

// Render sends SIGTERM before killing the old container during a
// redeploy - releasing the autopilot worker lock here (if idle) closes
// the gap that otherwise blocks every scheduled cycle on the new process
// for up to the full staleness window (see autopilotWorkerLock.ts).
// Deliberately narrow in scope: no HTTP-connection draining, just the
// autopilot lock. process.exit(0) must run regardless of what
// releaseLockOnShutdown does - registering any signal handler here also
// disables Node's default immediate-terminate behavior for that signal,
// so skipping the unconditional exit would leave the process hanging
// until Render's own SIGKILL-after-grace-period instead of shutting down
// cleanly.
async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`[SERVER] Received ${signal}, shutting down...`);
  try {
    autopilotWorker.stop();
    await autopilotWorker.releaseLockOnShutdown();
  } catch (error) {
    console.error(
      "[SERVER] Error during graceful shutdown:",
      error instanceof Error ? error.message : error,
    );
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});

app.listen(ENV.PORT, () => {
  console.log("");
  console.log("[SERVER] AI Trading Agent backend is running");
  console.log(`[SERVER] URL: http://localhost:${ENV.PORT}`);
  console.log(`[SERVER] Mode: ${ENV.TRADE_MODE}`);
  console.log(`[SERVER] Frontend origin: ${ENV.FRONTEND_ORIGIN}`);
  console.log(
    `[SERVER] Admin token protection: ${ENV.ADMIN_API_TOKEN ? "enabled" : "disabled"}`,
  );
  console.log(
    `[SERVER] Admin session login: ${ENV.ADMIN_PASSWORD ? "enabled" : "disabled"}`,
  );
  console.log(
    `[SERVER] Manual trade protection: ${areManualTradesAllowed() ? "manual trades enabled" : "manual trades disabled"}`,
  );
  console.log(
    `[SERVER] Allowed CORS origins: ${allowedCorsOrigins.join(", ")}`,
  );
  console.log("[SERVER] Yahoo Finance: removed");
  console.log(
    `[SERVER] Autopilot: ${autopilotWorker.getStatus().enabled ? "enabled" : "disabled"} / ${
      autopilotWorker.getStatus().executeTrades ? "execution" : "dry-run"
    }`,
  );
  console.log("");
});
