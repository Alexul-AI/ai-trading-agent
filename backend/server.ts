import crypto from "node:crypto";
import express, { type Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import * as AlpacaModule from "@alpacahq/alpaca-trade-api";
import { z } from "zod";

import { runTradingAgentStep } from "./agent.js";
import { evaluateTrade, type AccountState } from "./riskManager.js";
import { createAutopilotWorker } from "./autopilotWorker.js";
import {
  getAutopilotJournalPath,
  readAutopilotRuns,
  summarizeAutopilotRuns,
} from "./decisionJournal.js";
import {
  buildHealthReport,
  getSafeErrorMessage,
  type ServiceHealth,
} from "./envHealth.js";
import {
  calculateBollingerBands,
  calculateMACD,
  calculateRSI,
} from "./indicators.js";
import type {
  UnknownRecord,
  AlpacaLike,
  PositionSnapshot,
  WatchlistItem,
  AlpacaBar,
  AlpacaBarsResponse,
  MarketChartPoint,
  MarketChartResponse,
  AlpacaClockResponse,
  MarketClockResponse,
  AlpacaConstructor,
} from "./src/types/serverTypes.js";
import {
  asArray,
  asRecord,
  roundOrNull,
  toNumber,
  toStringValue,
} from "./src/utils/values.js";
import { toIsoDate } from "./src/utils/time.js";
import {
  formatCountdownDuration,
  formatIsraelMarketTime,
} from "./src/market/clockTime.js";
import { extractAlpacaPrice } from "./src/alpaca/price.js";
import {
  normalizeCorsOrigin,
  parseCorsOrigins,
  resolveAllowedCorsOrigin,
} from "./src/config/cors.js";

dotenv.config();

interface DashboardHealthWarning {
  service: string;
  status: ServiceHealth["status"];
  message: string;
}

interface DashboardHealthSummary {
  ok: boolean;
  warnings: DashboardHealthWarning[];
}

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

const ADMIN_SESSION_COOKIE = "alexul_admin_session";
const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60;

function getCookieValue(req: express.Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;

  const cookies = header.split(";").map((part) => part.trim());

  for (const cookie of cookies) {
    const separatorIndex = cookie.indexOf("=");
    if (separatorIndex <= 0) continue;

    const cookieName = cookie.slice(0, separatorIndex);
    const cookieValue = cookie.slice(separatorIndex + 1);

    if (cookieName === name) {
      try {
        return decodeURIComponent(cookieValue);
      } catch {
        return cookieValue;
      }
    }
  }

  return null;
}

function getAdminSessionSecret(): string | null {
  return ENV.ADMIN_SESSION_SECRET || ENV.ADMIN_API_TOKEN || null;
}

function timingSafeEqualString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) return false;

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function signAdminSession(expiresAtMs: number): string {
  const secret = getAdminSessionSecret();

  if (!secret) {
    throw new Error("Missing admin session secret.");
  }

  return crypto
    .createHmac("sha256", secret)
    .update(String(expiresAtMs))
    .digest("hex");
}

function createAdminSessionToken(): string {
  const expiresAtMs = Date.now() + ADMIN_SESSION_TTL_SECONDS * 1000;
  const signature = signAdminSession(expiresAtMs);

  return `${expiresAtMs}.${signature}`;
}

function isAdminSessionValid(token: string | null): boolean {
  if (!token) return false;

  const [expiresAtText, signature] = token.split(".");
  if (!expiresAtText || !signature) return false;

  const expiresAtMs = Number.parseInt(expiresAtText, 10);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return false;

  const expectedSignature = signAdminSession(expiresAtMs);

  return timingSafeEqualString(signature, expectedSignature);
}

function hasValidAdminSession(req: express.Request): boolean {
  return isAdminSessionValid(getCookieValue(req, ADMIN_SESSION_COOKIE));
}

function getAdminCookieAttributes(req: express.Request): string {
  const origin =
    typeof req.headers.origin === "string" ? req.headers.origin : "";

  const requiresCrossSiteCookie =
    origin.startsWith("https://") && !origin.includes("localhost");

  if (requiresCrossSiteCookie || process.env.NODE_ENV === "production") {
    return "HttpOnly; Secure; SameSite=None; Path=/";
  }

  return "HttpOnly; SameSite=Lax; Path=/";
}

function setAdminSessionCookie(req: express.Request, res: express.Response) {
  const token = createAdminSessionToken();

  res.setHeader(
    "Set-Cookie",
    `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${ADMIN_SESSION_TTL_SECONDS}; ${getAdminCookieAttributes(req)}`,
  );
}

function clearAdminSessionCookie(req: express.Request, res: express.Response) {
  res.setHeader(
    "Set-Cookie",
    `${ADMIN_SESSION_COOKIE}=; Max-Age=0; ${getAdminCookieAttributes(req)}`,
  );
}

function requireAdminToken(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (hasValidAdminSession(req)) {
    next();
    return;
  }

  if (!ENV.ADMIN_API_TOKEN) {
    if (ENV.TRADE_MODE === "live") {
      res.status(503).json({
        error: "Admin token is required in live mode.",
      });
      return;
    }

    next();
    return;
  }

  const providedToken =
    typeof req.headers["x-admin-token"] === "string"
      ? req.headers["x-admin-token"]
      : "";

  if (providedToken !== ENV.ADMIN_API_TOKEN) {
    res.status(401).json({
      error: "Unauthorized",
    });
    return;
  }

  next();
}

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

function getAlpacaTradingBaseUrl(): string {
  return isLiveMode
    ? "https://api.alpaca.markets"
    : "https://paper-api.alpaca.markets";
}

async function fetchAlpacaMarketClock(): Promise<MarketClockResponse> {
  const keyId = isLiveMode ? ENV.APCA_API_KEY_ID_LIVE! : ENV.APCA_API_KEY_ID;
  const secretKey = isLiveMode
    ? ENV.APCA_API_SECRET_KEY_LIVE!
    : ENV.APCA_API_SECRET_KEY;

  const response = await fetch(`${getAlpacaTradingBaseUrl()}/v2/clock`, {
    headers: {
      "APCA-API-KEY-ID": keyId,
      "APCA-API-SECRET-KEY": secretKey,
    },
  });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `Alpaca market clock failed: HTTP ${response.status} ${body}`,
    );
  }

  const clock = (await response.json()) as AlpacaClockResponse;
  const marketTimestamp = new Date(clock.timestamp);
  const nextEventTimestamp = new Date(
    clock.is_open ? clock.next_close : clock.next_open,
  );
  const countdownMs = Math.max(
    0,
    nextEventTimestamp.getTime() - marketTimestamp.getTime(),
  );

  return {
    isOpen: clock.is_open,
    timestamp: clock.timestamp,
    nextOpen: clock.next_open,
    nextClose: clock.next_close,
    nextOpenIsrael: formatIsraelMarketTime(clock.next_open),
    nextCloseIsrael: formatIsraelMarketTime(clock.next_close),
    countdownMs,
    countdownLabel: formatCountdownDuration(countdownMs),
    statusLabel: clock.is_open ? "MARKET OPEN" : "MARKET CLOSED",
    nextEventLabel: clock.is_open ? "Closes in" : "Opens in",
    timezone: "Asia/Jerusalem",
    source: "alpaca",
  };
}

async function getPreviousCloseFromAlpaca(ticker: string): Promise<number> {
  const endDate = new Date();
  const startDate = new Date();

  // Wider window handles weekends and market holidays.
  startDate.setDate(endDate.getDate() - 14);

  const url = new URL(`https://data.alpaca.markets/v2/stocks/${ticker}/bars`);

  url.searchParams.set("timeframe", "1Day");
  url.searchParams.set("start", toIsoDate(startDate));
  url.searchParams.set("end", toIsoDate(endDate));
  url.searchParams.set("adjustment", "raw");
  url.searchParams.set("feed", ALPACA_DATA_FEED);
  url.searchParams.set("limit", "10");

  const keyId = isLiveMode ? ENV.APCA_API_KEY_ID_LIVE! : ENV.APCA_API_KEY_ID;
  const secretKey = isLiveMode
    ? ENV.APCA_API_SECRET_KEY_LIVE!
    : ENV.APCA_API_SECRET_KEY;

  const response = await fetch(url.toString(), {
    headers: {
      "APCA-API-KEY-ID": keyId,
      "APCA-API-SECRET-KEY": secretKey,
    },
  });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `Alpaca previous close request failed for ${ticker}: HTTP ${response.status} ${body}`,
    );
  }

  const data = (await response.json()) as AlpacaBarsResponse;
  const bars = data.bars ?? [];

  if (bars.length === 0) return 0;

  const sortedBars = bars.sort(
    (a, b) => new Date(a.t).getTime() - new Date(b.t).getTime(),
  );

  // Prefer previous completed daily bar. Fallback to latest available bar.
  const previousBar =
    sortedBars.length >= 2
      ? sortedBars[sortedBars.length - 2]
      : sortedBars[sortedBars.length - 1];

  return previousBar?.c ?? 0;
}

function calculateDailyChangePercent(
  price: number,
  previousClose: number,
): number {
  if (price <= 0 || previousClose <= 0) return 0;
  return Number((((price - previousClose) / previousClose) * 100).toFixed(2));
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

      try {
        let price = 0;

        if (position && position.currentPrice > 0) {
          price = position.currentPrice;
        } else {
          const latestTrade = await alpaca.getLatestTrade(ticker);
          price = extractAlpacaPrice(latestTrade);
        }

        if (price <= 0) {
          console.warn(`[WATCHLIST] Alpaca returned no price for ${ticker}`);
        }

        let change = 0;

        try {
          const previousClose = await getPreviousCloseFromAlpaca(ticker);
          change = calculateDailyChangePercent(price, previousClose);
        } catch (error) {
          console.warn(
            `[WATCHLIST] Failed to fetch previous close for ${ticker}:`,
            error,
          );
        }

        return {
          ticker,
          name: ticker,
          price,
          change,
          isUp: change >= 0,
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
async function fetchDailyBarsForChart(
  ticker: string,
  days: number,
): Promise<AlpacaBar[]> {
  if (!ticker) {
    throw new Error("Ticker is required.");
  }

  const safeDays = Math.max(30, Math.min(365, days));
  const endDate = new Date();
  const startDate = new Date();

  // Add buffer for weekends and market holidays.
  startDate.setDate(endDate.getDate() - safeDays - 20);

  const allBars: AlpacaBar[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`https://data.alpaca.markets/v2/stocks/${ticker}/bars`);

    url.searchParams.set("timeframe", "1Day");
    url.searchParams.set("start", toIsoDate(startDate));
    url.searchParams.set("end", toIsoDate(endDate));
    url.searchParams.set("adjustment", "raw");
    url.searchParams.set("feed", ALPACA_DATA_FEED);
    url.searchParams.set("limit", "1000");

    if (pageToken) {
      url.searchParams.set("page_token", pageToken);
    }

    const keyId = isLiveMode ? ENV.APCA_API_KEY_ID_LIVE! : ENV.APCA_API_KEY_ID;
    const secretKey = isLiveMode
      ? ENV.APCA_API_SECRET_KEY_LIVE!
      : ENV.APCA_API_SECRET_KEY;

    const response = await fetch(url.toString(), {
      headers: {
        "APCA-API-KEY-ID": keyId,
        "APCA-API-SECRET-KEY": secretKey,
      },
    });

    if (!response.ok) {
      const body = await response.text();

      throw new Error(
        `Alpaca chart bars request failed for ${ticker}: HTTP ${response.status} ${body}`,
      );
    }

    const data = (await response.json()) as AlpacaBarsResponse;

    if (data.bars) {
      allBars.push(...data.bars);
    }

    pageToken = data.next_page_token || undefined;
  } while (pageToken);

  return allBars
    .sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime())
    .slice(-safeDays);
}

function buildMarketChartPoints(bars: AlpacaBar[]): MarketChartPoint[] {
  return bars.map((bar, index) => {
    const closesUpToPoint = bars.slice(0, index + 1).map((item) => item.c);

    const hasRsi = closesUpToPoint.length >= 15;
    const hasMacd = closesUpToPoint.length >= 35;
    const hasBollinger = closesUpToPoint.length >= 20;

    const rsi = hasRsi ? calculateRSI(closesUpToPoint, 14) : null;
    const macd = hasMacd ? calculateMACD(closesUpToPoint) : null;
    const bb = hasBollinger
      ? calculateBollingerBands(closesUpToPoint, 20, 2)
      : null;

    return {
      date: bar.t.split("T")[0] ?? bar.t,
      open: Number(bar.o.toFixed(2)),
      high: Number(bar.h.toFixed(2)),
      low: Number(bar.l.toFixed(2)),
      close: Number(bar.c.toFixed(2)),
      volume: bar.v,
      rsi: roundOrNull(rsi, 2),
      macdHistogram: roundOrNull(macd?.histogram, 4),
      bollingerLower: roundOrNull(bb?.lower, 2),
      bollingerMiddle: bb ? roundOrNull((bb.upper + bb.lower) / 2, 2) : null,
      bollingerUpper: roundOrNull(bb?.upper, 2),
    };
  });
}
function toHealthWarning(
  service: ServiceHealth,
): DashboardHealthWarning | null {
  if (service.status === "ok") return null;

  return {
    service: service.name,
    status: service.status,
    message: service.message,
  };
}

async function buildDashboardHealthSummary(): Promise<DashboardHealthSummary> {
  const report = await buildHealthReport({
    checkAlpacaConnectivity: false,
    checkOpenAIConnectivity: false,
  });

  const warnings = report.services
    .map(toHealthWarning)
    .filter((warning): warning is DashboardHealthWarning => warning !== null);

  return {
    ok: warnings.length === 0,
    warnings,
  };
}

async function safeCall<T>(
  label: string,
  operation: () => Promise<T>,
  fallback: T,
  warnings: DashboardHealthWarning[],
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    warnings.push({
      service: label,
      status: "error",
      message: getSafeErrorMessage(error),
    });

    return fallback;
  }
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

    res.status(report.ok ? 200 : 503).json(report);
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
    const bars = await fetchDailyBarsForChart(ticker, safeDays);

    const payload: MarketChartResponse = {
      ticker,
      days: Math.max(30, Math.min(365, safeDays)),
      feed: ALPACA_DATA_FEED,
      points: buildMarketChartPoints(bars),
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
    const runs = await readAutopilotRuns(Number.isFinite(limit) ? limit : 50);

    res.json({
      file: getAutopilotJournalPath(),
      runs,
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
