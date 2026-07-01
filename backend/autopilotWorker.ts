import {
  calculateBollingerBands,
  calculateMACD,
  calculateRSI,
} from "./indicators.js";
import {
  DEFAULT_STRATEGY_CONFIG,
  decideTradeSignal,
  type StrategyDecision,
} from "./strategyEngine.js";

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface AlpacaBarsResponse {
  bars?: AlpacaBar[];
  next_page_token?: string | null;
}

export interface PortfolioPositionSnapshot {
  shares: number;
  avgPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
}

export interface PortfolioSnapshot {
  balance: number;
  equity: number;
  currency: string;
  positions: Record<string, PortfolioPositionSnapshot>;
}

export interface ExecuteSafeTradeResult {
  status: string;
  reason?: string;
  [key: string]: unknown;
}

export type ExecuteSafeTrade = (
  ticker: string,
  action: "BUY" | "SELL",
  requestedShares: number,
  orderType?: string,
  limitPrice?: number,
  stopLoss?: number,
  takeProfit?: number,
) => Promise<ExecuteSafeTradeResult>;

export interface AutopilotWorkerOptions {
  tradeMode: "paper" | "live";
  getPortfolioSnapshot: () => Promise<PortfolioSnapshot>;
  executeSafeTrade: ExecuteSafeTrade;
  broadcastSSE: (payload: unknown) => void;
  sendTelegramAlert?: (message: string) => Promise<void>;
}

export interface AutopilotDecisionLog {
  ticker: string;
  timestamp: string;
  price: number;
  rsi: number;
  macdHistogram: number;
  previousMacdHistogram: number;
  bollingerLower: number;
  bollingerUpper: number;
  action: StrategyDecision["action"];
  confidence: number;
  suggestedShares: number;
  reasonType: StrategyDecision["reasonType"];
  reason: string;
  executed: boolean;
  skippedReason?: string;
  result?: ExecuteSafeTradeResult;
}

export interface AutopilotStatus {
  enabled: boolean;
  executeTrades: boolean;
  tradeMode: "paper" | "live";
  running: boolean;
  intervalMs: number;
  tickers: string[];
  minConfidence: number;
  lastRunAt: string | null;
  lastError: string | null;
  lastDecisions: AutopilotDecisionLog[];
}

const APCA_API_KEY_ID = process.env.APCA_API_KEY_ID ?? "";
const APCA_API_SECRET_KEY = process.env.APCA_API_SECRET_KEY ?? "";

const AUTOPILOT_INTERVAL_MS = Number.parseInt(
  process.env.AUTOPILOT_INTERVAL_MS || "60000",
  10,
);

const AUTOPILOT_BARS_DAYS = Number.parseInt(
  process.env.AUTOPILOT_BARS_DAYS || "180",
  10,
);

const AUTOPILOT_MIN_CONFIDENCE = Number.parseFloat(
  process.env.AUTOPILOT_MIN_CONFIDENCE || "0.75",
);

const AUTOPILOT_COOLDOWN_MINUTES = Number.parseInt(
  process.env.AUTOPILOT_COOLDOWN_MINUTES || "60",
  10,
);

const ALPACA_DATA_FEED = process.env.ALPACA_DATA_FEED || "iex";

const AUTOPILOT_TICKERS = (
  process.env.AUTOPILOT_TICKERS || "AMD,NVDA,AAPL,MSFT,TSLA"
)
  .split(",")
  .map((ticker) => ticker.trim().toUpperCase())
  .filter(Boolean);

const AUTOPILOT_EXECUTE_TRADES =
  process.env.AUTOPILOT_EXECUTE_TRADES === "true";

const AUTOPILOT_ENABLED_DEFAULT =
  process.env.AUTOPILOT_ENABLED_DEFAULT === "true";

function toIsoDate(date: Date): string {
  return date.toISOString().split("T")[0] ?? date.toISOString();
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

async function fetchAlpacaBars(ticker: string): Promise<AlpacaBar[]> {
  if (!APCA_API_KEY_ID || !APCA_API_SECRET_KEY) {
    throw new Error("Missing Alpaca API keys for market data.");
  }

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - AUTOPILOT_BARS_DAYS);

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

    const response = await fetch(url.toString(), {
      headers: {
        "APCA-API-KEY-ID": APCA_API_KEY_ID,
        "APCA-API-SECRET-KEY": APCA_API_SECRET_KEY,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Alpaca bars request failed for ${ticker}: HTTP ${response.status} ${body}`,
      );
    }

    const data = (await response.json()) as AlpacaBarsResponse;

    if (data.bars) {
      allBars.push(...data.bars);
    }

    pageToken = data.next_page_token || undefined;
  } while (pageToken);

  return allBars.sort(
    (a, b) => new Date(a.t).getTime() - new Date(b.t).getTime(),
  );
}

function calculateBarsSinceLastBuy(
  ticker: string,
  lastBuyAtByTicker: Map<string, number>,
): number {
  const lastBuyAt = lastBuyAtByTicker.get(ticker);

  if (!lastBuyAt) {
    return DEFAULT_STRATEGY_CONFIG.cooldownBars;
  }

  const elapsedMs = Date.now() - lastBuyAt;
  const cooldownMs = AUTOPILOT_COOLDOWN_MINUTES * 60 * 1000;

  return elapsedMs >= cooldownMs ? DEFAULT_STRATEGY_CONFIG.cooldownBars : 0;
}

export function createAutopilotWorker(options: AutopilotWorkerOptions) {
  let enabled = AUTOPILOT_ENABLED_DEFAULT;
  let running = false;
  let timer: NodeJS.Timeout | null = null;
  let lastRunAt: string | null = null;
  let lastError: string | null = null;
  let lastDecisions: AutopilotDecisionLog[] = [];
  const lastBuyAtByTicker = new Map<string, number>();

  async function analyzeTicker(
    ticker: string,
    portfolio: PortfolioSnapshot,
  ): Promise<AutopilotDecisionLog> {
    const bars = await fetchAlpacaBars(ticker);

    if (bars.length < 35) {
      throw new Error(
        `Not enough bars for ${ticker}. Received ${bars.length}; need at least 35.`,
      );
    }

    const prices = bars.map((bar) => bar.c);
    const previousPrices = prices.slice(0, -1);
    const latestBar = bars[bars.length - 1];

    if (!latestBar) {
      throw new Error(`No latest bar for ${ticker}.`);
    }

    const price = Number(latestBar.c.toFixed(2));
    const rsi = calculateRSI(prices, 14);
    const macd = calculateMACD(prices);
    const previousMacd = calculateMACD(previousPrices);
    const bb = calculateBollingerBands(prices, 20, 2);

    const position = portfolio.positions[ticker];
    const sharesOwned = position?.shares ?? 0;
    const averageEntryPrice = position?.avgPrice ?? 0;
    const barsSinceLastBuy = calculateBarsSinceLastBuy(
      ticker,
      lastBuyAtByTicker,
    );

    const decision = decideTradeSignal({
      ticker,
      price,
      cash: portfolio.balance,
      portfolioValue: portfolio.equity,
      sharesOwned,
      averageEntryPrice,
      rsi,
      macdHistogram: macd.histogram,
      previousMacdHistogram: previousMacd.histogram,
      bollingerLower: bb.lower,
      bollingerUpper: bb.upper,
      barsSinceLastBuy,
    });

    const log: AutopilotDecisionLog = {
      ticker,
      timestamp: new Date().toISOString(),
      price,
      rsi,
      macdHistogram: macd.histogram,
      previousMacdHistogram: previousMacd.histogram,
      bollingerLower: bb.lower,
      bollingerUpper: bb.upper,
      action: decision.action,
      confidence: decision.confidence,
      suggestedShares: decision.suggestedShares,
      reasonType: decision.reasonType,
      reason: decision.reason,
      executed: false,
    };

    if (decision.action === "HOLD") {
      log.skippedReason = "HOLD decision.";
      return log;
    }

    if (decision.confidence < AUTOPILOT_MIN_CONFIDENCE) {
      log.skippedReason = `Confidence ${decision.confidence} is below min ${AUTOPILOT_MIN_CONFIDENCE}.`;
      return log;
    }

    if (!AUTOPILOT_EXECUTE_TRADES) {
      log.skippedReason =
        "Dry-run mode. Set AUTOPILOT_EXECUTE_TRADES=true to allow paper-trading execution.";
      return log;
    }

    if (options.tradeMode !== "paper") {
      log.skippedReason =
        "Autopilot execution is blocked outside paper mode.";
      return log;
    }

    if (decision.suggestedShares <= 0) {
      log.skippedReason = "No positive share quantity suggested.";
      return log;
    }

    const stopLoss =
      decision.action === "BUY"
        ? Number((price * (1 - DEFAULT_STRATEGY_CONFIG.stopLossPercent)).toFixed(2))
        : undefined;

    const takeProfit =
      decision.action === "BUY"
        ? Number((price * (1 + DEFAULT_STRATEGY_CONFIG.takeProfitPercent)).toFixed(2))
        : undefined;

    const result = await options.executeSafeTrade(
      ticker,
      decision.action,
      decision.suggestedShares,
      "market",
      undefined,
      stopLoss,
      takeProfit,
    );

    log.result = result;

    if (result.status === "success") {
      log.executed = true;

      if (decision.action === "BUY") {
        lastBuyAtByTicker.set(ticker, Date.now());
      }
    } else {
      log.skippedReason = result.reason || "Trade execution did not succeed.";
    }

    return log;
  }

  async function runOnce(trigger: "manual" | "scheduled" = "manual") {
    if (running) {
      return {
        skipped: true,
        reason: "Autopilot worker is already running.",
        status: getStatus(),
      };
    }

    running = true;
    lastError = null;

    options.broadcastSSE({
      type: "autopilot_worker_started",
      trigger,
      timestamp: new Date().toISOString(),
      executeTrades: AUTOPILOT_EXECUTE_TRADES,
    });

    try {
      const portfolio = await options.getPortfolioSnapshot();
      const tickers = Array.from(
        new Set([
          ...AUTOPILOT_TICKERS,
          ...Object.keys(portfolio.positions).map((ticker) =>
            ticker.toUpperCase(),
          ),
        ]),
      );

      const decisions: AutopilotDecisionLog[] = [];

      for (const ticker of tickers) {
        try {
          const decision = await analyzeTicker(ticker, portfolio);
          decisions.push(decision);

          options.broadcastSSE({
            type: "autopilot_signal",
            data: decision,
          });
        } catch (error) {
          const message = getErrorMessage(error);

          const failedDecision: AutopilotDecisionLog = {
            ticker,
            timestamp: new Date().toISOString(),
            price: 0,
            rsi: 0,
            macdHistogram: 0,
            previousMacdHistogram: 0,
            bollingerLower: 0,
            bollingerUpper: 0,
            action: "HOLD",
            confidence: 0,
            suggestedShares: 0,
            reasonType: "NO_SIGNAL",
            reason: `Autopilot analysis failed for ${ticker}: ${message}`,
            executed: false,
            skippedReason: message,
          };

          decisions.push(failedDecision);

          options.broadcastSSE({
            type: "autopilot_signal_error",
            data: failedDecision,
          });
        }
      }

      lastDecisions = decisions;
      lastRunAt = new Date().toISOString();

      const actionable = decisions.filter(
        (decision) =>
          decision.action !== "HOLD" &&
          decision.confidence >= AUTOPILOT_MIN_CONFIDENCE,
      );

      options.broadcastSSE({
        type: "autopilot_worker_finished",
        trigger,
        timestamp: lastRunAt,
        decisions,
        actionableCount: actionable.length,
      });

      if (options.sendTelegramAlert && actionable.length > 0) {
        const lines = actionable.map(
          (decision) =>
            `${decision.ticker}: ${decision.action} ${decision.suggestedShares}, confidence=${decision.confidence}, executed=${decision.executed}, reason=${decision.reason}`,
        );

        await options.sendTelegramAlert(
          `Autopilot ${AUTOPILOT_EXECUTE_TRADES ? "EXECUTION" : "DRY-RUN"} signals:\n${lines.join(
            "\n",
          )}`,
        );
      }

      return {
        skipped: false,
        decisions,
        status: getStatus(),
      };
    } catch (error) {
      lastError = getErrorMessage(error);

      options.broadcastSSE({
        type: "autopilot_worker_error",
        message: lastError,
        timestamp: new Date().toISOString(),
      });

      return {
        skipped: false,
        error: lastError,
        status: getStatus(),
      };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;

    timer = setInterval(() => {
      if (!enabled) return;

      void runOnce("scheduled");
    }, AUTOPILOT_INTERVAL_MS);
  }

  function stop() {
    if (!timer) return;

    clearInterval(timer);
    timer = null;
  }

  function setEnabled(nextEnabled: boolean) {
    enabled = nextEnabled;

    options.broadcastSSE({
      type: "autopilot_status",
      enabled,
      executeTrades: AUTOPILOT_EXECUTE_TRADES,
      timestamp: new Date().toISOString(),
    });
  }

  function getStatus(): AutopilotStatus {
    return {
      enabled,
      executeTrades: AUTOPILOT_EXECUTE_TRADES,
      tradeMode: options.tradeMode,
      running,
      intervalMs: AUTOPILOT_INTERVAL_MS,
      tickers: AUTOPILOT_TICKERS,
      minConfidence: AUTOPILOT_MIN_CONFIDENCE,
      lastRunAt,
      lastError,
      lastDecisions,
    };
  }

  return {
    start,
    stop,
    setEnabled,
    getStatus,
    runOnce,
  };
}
