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
import {
  appendAutopilotRun,
  createStrategyConfigHash,
} from "./decisionJournal.js";

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
  originalSuggestedShares?: number;
  reasonType: StrategyDecision["reasonType"];
  reason: string;
  safetyNote?: string;
  executed: boolean;
  skippedReason?: string;
  result?: ExecuteSafeTradeResult;
}

export interface AutopilotStatus {
  enabled: boolean;
  executeTrades: boolean;
  allowBuy: boolean;
  allowSell: boolean;
  tradeMode: "paper" | "live";
  strategyVersion: string;
  strategyConfigHash: string;
  strategyConfig: Record<string, unknown>;
  running: boolean;
  intervalMs: number;
  tickers: string[];
  minConfidence: number;
  maxSellFraction: number;
  blockSellBelowAverageEntry: boolean;
  telegramCooldownMinutes: number;
  lastJournalRunId: string | null;
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

const AUTOPILOT_TELEGRAM_COOLDOWN_MINUTES = Number.parseInt(
  process.env.AUTOPILOT_TELEGRAM_COOLDOWN_MINUTES || "30",
  10,
);

const AUTOPILOT_MAX_SELL_FRACTION = Number.parseFloat(
  process.env.AUTOPILOT_MAX_SELL_FRACTION || "0.25",
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

const AUTOPILOT_ALLOW_BUY = process.env.AUTOPILOT_ALLOW_BUY === "true";
const AUTOPILOT_ALLOW_SELL = process.env.AUTOPILOT_ALLOW_SELL === "true";

// Default safety behavior:
// normal SELL_SIGNAL should not sell a held position below average entry.
// STOP_LOSS remains allowed to protect capital.
const AUTOPILOT_BLOCK_SELL_BELOW_AVG =
  process.env.AUTOPILOT_BLOCK_SELL_BELOW_AVG !== "false";

const AUTOPILOT_ENABLED_DEFAULT =
  process.env.AUTOPILOT_ENABLED_DEFAULT === "true";

const STRATEGY_VERSION =
  process.env.STRATEGY_VERSION ?? "v1.2-confluence-scoring";

const STRATEGY_CONFIG_HASH = createStrategyConfigHash(DEFAULT_STRATEGY_CONFIG);

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

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0.25;
  return Math.max(0.01, Math.min(1, value));
}

function getSafeSellShares(
  reasonType: StrategyDecision["reasonType"],
  suggestedShares: number,
  sharesOwned: number,
): { shares: number; safetyNote?: string } {
  if (suggestedShares <= 0 || sharesOwned <= 0) {
    return { shares: 0 };
  }

  if (reasonType === "STOP_LOSS") {
    return {
      shares: Math.min(suggestedShares, sharesOwned),
      safetyNote: "STOP_LOSS can sell the full position.",
    };
  }

  const maxFraction = clampFraction(AUTOPILOT_MAX_SELL_FRACTION);
  const cappedShares = Math.max(1, Math.floor(sharesOwned * maxFraction));
  const safeShares = Math.min(suggestedShares, cappedShares, sharesOwned);

  if (safeShares < suggestedShares) {
    return {
      shares: safeShares,
      safetyNote: `Safety cap: reduced SELL from ${suggestedShares} to ${safeShares} shares (${Math.round(
        maxFraction * 100,
      )}% max sell fraction).`,
    };
  }

  return { shares: safeShares };
}

function shouldBlockNormalSellBelowAverageEntry({
  action,
  reasonType,
  sharesOwned,
  price,
  averageEntryPrice,
}: {
  action: StrategyDecision["action"];
  reasonType: StrategyDecision["reasonType"];
  sharesOwned: number;
  price: number;
  averageEntryPrice: number;
}): boolean {
  if (!AUTOPILOT_BLOCK_SELL_BELOW_AVG) return false;
  if (action !== "SELL") return false;
  if (reasonType !== "SELL_SIGNAL") return false;
  if (sharesOwned <= 0) return false;
  if (averageEntryPrice <= 0) return false;

  return price < averageEntryPrice;
}

function appendSafetyNote(
  existingNote: string | undefined,
  nextNote: string,
): string {
  if (!existingNote) return nextNote;
  return `${existingNote} | ${nextNote}`;
}

function isActionableDecision(decision: AutopilotDecisionLog): boolean {
  return (
    decision.action !== "HOLD" &&
    decision.confidence >= AUTOPILOT_MIN_CONFIDENCE &&
    decision.suggestedShares > 0 &&
    !decision.skippedReason
  );
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

function buildSignalKey(decision: AutopilotDecisionLog): string {
  return [
    decision.ticker,
    decision.action,
    decision.reasonType,
    decision.suggestedShares,
    decision.reason,
  ].join("|");
}

export function createAutopilotWorker(options: AutopilotWorkerOptions) {
  let enabled = AUTOPILOT_ENABLED_DEFAULT;
  let running = false;
  let timer: NodeJS.Timeout | null = null;
  let lastRunAt: string | null = null;
  let lastJournalRunId: string | null = null;
  let lastError: string | null = null;
  let lastDecisions: AutopilotDecisionLog[] = [];
  const lastBuyAtByTicker = new Map<string, number>();
  const lastTelegramSentAtBySignal = new Map<string, number>();

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

    let safeSuggestedShares = decision.suggestedShares;
    let safetyNote: string | undefined;

    if (decision.action === "SELL") {
      const safeSell = getSafeSellShares(
        decision.reasonType,
        decision.suggestedShares,
        sharesOwned,
      );

      safeSuggestedShares = safeSell.shares;
      safetyNote = safeSell.safetyNote;
    }

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
      suggestedShares: safeSuggestedShares,
      originalSuggestedShares:
        safeSuggestedShares !== decision.suggestedShares
          ? decision.suggestedShares
          : undefined,
      reasonType: decision.reasonType,
      reason: decision.reason,
      safetyNote,
      executed: false,
    };

    if (decision.action === "HOLD") {
      log.skippedReason = "HOLD decision.";
      return log;
    }

    if (
      shouldBlockNormalSellBelowAverageEntry({
        action: decision.action,
        reasonType: decision.reasonType,
        sharesOwned,
        price,
        averageEntryPrice,
      })
    ) {
      const guardNote = `Position guard: blocked normal SELL_SIGNAL because current price ${price.toFixed(
        2,
      )} is below average entry ${averageEntryPrice.toFixed(
        2,
      )}. STOP_LOSS can still sell below average entry.`;

      log.safetyNote = appendSafetyNote(log.safetyNote, guardNote);
      log.skippedReason =
        "Position guard blocked SELL_SIGNAL below average entry.";
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
      log.skippedReason = "Autopilot execution is blocked outside paper mode.";
      return log;
    }

    if (decision.action === "BUY" && !AUTOPILOT_ALLOW_BUY) {
      log.skippedReason =
        "BUY execution blocked. Set AUTOPILOT_ALLOW_BUY=true to allow autopilot buys.";
      return log;
    }

    if (decision.action === "SELL" && !AUTOPILOT_ALLOW_SELL) {
      log.skippedReason =
        "SELL execution blocked. Set AUTOPILOT_ALLOW_SELL=true to allow autopilot sells.";
      return log;
    }

    if (safeSuggestedShares <= 0) {
      log.skippedReason = "No positive safe share quantity suggested.";
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
      safeSuggestedShares,
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

  async function sendTelegramForNewActionableSignals(
    actionable: AutopilotDecisionLog[],
  ) {
    if (!options.sendTelegramAlert || actionable.length === 0) return;

    const now = Date.now();
    const cooldownMs = AUTOPILOT_TELEGRAM_COOLDOWN_MINUTES * 60 * 1000;

    const newSignals = actionable.filter((decision) => {
      const key = buildSignalKey(decision);
      const lastSentAt = lastTelegramSentAtBySignal.get(key);

      if (lastSentAt && now - lastSentAt < cooldownMs) {
        return false;
      }

      lastTelegramSentAtBySignal.set(key, now);
      return true;
    });

    if (newSignals.length === 0) return;

    const lines = newSignals.map((decision) => {
      const original = decision.originalSuggestedShares
        ? ` original=${decision.originalSuggestedShares}`
        : "";
      const safety = decision.safetyNote ? ` | ${decision.safetyNote}` : "";

      return `${decision.ticker}: ${decision.action} ${decision.suggestedShares}${original}, confidence=${decision.confidence}, executed=${decision.executed}, reason=${decision.reason}${safety}`;
    });

    await options.sendTelegramAlert(
      `Autopilot ${AUTOPILOT_EXECUTE_TRADES ? "EXECUTION" : "DRY-RUN"} signals:\n${lines.join(
        "\n",
      )}`,
    );
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

    let decisions: AutopilotDecisionLog[] = [];
    let topLevelError: string | null = null;

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

      const actionable = decisions.filter(isActionableDecision);

      try {
        const journalRun = await appendAutopilotRun({
          timestamp: lastRunAt,
          trigger,
          executeTrades: AUTOPILOT_EXECUTE_TRADES,
          tradeMode: options.tradeMode,
          enabled,
          tickers,
          actionableCount: actionable.length,
          strategyVersion: STRATEGY_VERSION,
          strategyConfigHash: STRATEGY_CONFIG_HASH,
          strategyConfig: DEFAULT_STRATEGY_CONFIG as unknown as Record<string, unknown>,
          decisions,
        });

        lastJournalRunId = journalRun.id;
      } catch (error) {
        const journalError = getErrorMessage(error);
        lastError = `Journal write failed: ${journalError}`;

        options.broadcastSSE({
          type: "autopilot_journal_error",
          message: journalError,
          timestamp: new Date().toISOString(),
        });
      }

      options.broadcastSSE({
        type: "autopilot_worker_finished",
        trigger,
        timestamp: lastRunAt,
        journalRunId: lastJournalRunId,
        decisions,
        actionableCount: actionable.length,
      });

      await sendTelegramForNewActionableSignals(actionable);
    } catch (error) {
      topLevelError = getErrorMessage(error);
      lastError = topLevelError;

      options.broadcastSSE({
        type: "autopilot_worker_error",
        message: topLevelError,
        timestamp: new Date().toISOString(),
      });
    } finally {
      running = false;
    }

    if (topLevelError) {
      return {
        skipped: false,
        error: topLevelError,
        status: getStatus(),
      };
    }

    return {
      skipped: false,
      decisions,
      status: getStatus(),
    };
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
      allowBuy: AUTOPILOT_ALLOW_BUY,
      allowSell: AUTOPILOT_ALLOW_SELL,
      timestamp: new Date().toISOString(),
    });
  }

  function getStatus(): AutopilotStatus {
    return {
      enabled,
      executeTrades: AUTOPILOT_EXECUTE_TRADES,
      allowBuy: AUTOPILOT_ALLOW_BUY,
      allowSell: AUTOPILOT_ALLOW_SELL,
      tradeMode: options.tradeMode,
      strategyVersion: STRATEGY_VERSION,
      strategyConfigHash: STRATEGY_CONFIG_HASH,
      strategyConfig: DEFAULT_STRATEGY_CONFIG as unknown as Record<string, unknown>,
      running,
      intervalMs: AUTOPILOT_INTERVAL_MS,
      tickers: AUTOPILOT_TICKERS,
      minConfidence: AUTOPILOT_MIN_CONFIDENCE,
      maxSellFraction: clampFraction(AUTOPILOT_MAX_SELL_FRACTION),
      blockSellBelowAverageEntry: AUTOPILOT_BLOCK_SELL_BELOW_AVG,
      telegramCooldownMinutes: AUTOPILOT_TELEGRAM_COOLDOWN_MINUTES,
      lastJournalRunId,
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
