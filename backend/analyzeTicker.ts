// The baseline per-ticker confluence-scoring analysis path - extracted from
// autopilotWorker.ts (PR #54, Stage 3 of the staged refactor - see
// docs/ops/AUTOPILOT_WORKER_MAP.md). Unlike runEtfRotationCycle (PR #53),
// this function genuinely touches cross-cycle state (lastBuyAtByTicker/
// entryAtrPercentByTicker) - those two Maps still live in
// autopilotWorker.ts's createAutopilotWorker closure (they must persist at
// worker-instance lifetime, not call-lifetime) and are passed in by
// reference; mutating a passed-in Map is identical to mutating it via
// closure capture, same object identity either way.
//
// Every module-level constant autopilotWorker.ts used to read directly is
// now an explicit parameter here (including ones only this file uses) -
// this is what lets analyzeTicker.test.ts be a plain top-level import with
// no vi.stubEnv/dynamic-import gymnastics, matching etfRotationCycle.ts's
// own testability, and matches the precedent PR #53 already set (it kept
// single-consumer, even hardcoded constants like ETF_ROTATION_WARMUP_TRADING_DAYS
// in autopilotWorker.ts and passed them through rather than moving them).
//
// SELL-path logic (the safe-sell-shares cap, the position-guard block, the
// SELL execution-permission gate) moved byte-for-byte, verified unchanged
// via a golden-snapshot comparison against the pre-extraction code (see
// analyzeTicker.test.ts) - per this project's standing rule, SELL semantics
// must not change until a live SELL has actually been observed.
//
// Real finding along the way: shouldBlockNormalSellBelowAverageEntry's own
// blocking branch is currently unreachable through the real decideTradeSignal
// pipeline - strategyEngine.ts's own downgradeNormalSellBelowAverageEntry
// config (hardcoded true, never overridden anywhere) already downgrades any
// losing SELL_SIGNAL to HOLD one layer up, before this guard's inputs could
// ever match its trigger condition. Moved unchanged regardless (dead code
// moved untouched is still zero behavior change, and it could become
// reachable later if that default or a call site changes) - verified via a
// direct unit test of the pure predicate instead of an unreachable
// integration path.
import {
  calculateATR,
  calculateBollingerBands,
  calculateMACD,
  calculateRSI,
} from "./indicators.js";
import {
  DEFAULT_STRATEGY_CONFIG,
  decideTradeSignal,
  type StrategyDecision,
} from "./strategyEngine.js";
import { getNewsSentiment, getInsiderActivity } from "./agent.js";
import {
  isBuySuppressedByRegime,
  type RegimeBucketConfig,
  type RegimeState,
} from "./src/strategy/portfolioRegimeFilter.js";
import {
  getSafeBuyNotionalForBucketCap,
  getSafeBuySharesForBucketCap,
  getSafeSellShares,
  type PortfolioSnapshot,
} from "./src/strategy/portfolioSafety.js";
import type { CircuitBreakerState } from "./portfolioCircuitBreaker.js";
import type {
  AlpacaBar,
  AutopilotDecisionLog,
  ExecuteSafeTrade,
  SentimentCacheEntry,
  SentimentVetoResult,
  InsiderCacheEntry,
} from "./src/types/autopilotTypes.js";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

const SENTIMENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const sentimentCacheByTicker = new Map<string, SentimentCacheEntry>();

// Pure decision rule, kept separate from the fetch/cache orchestration
// below so it's testable without mocking network calls.
export function evaluateSentimentVeto(
  ticker: string,
  sentiment: string,
  summary: string,
): SentimentVetoResult {
  if (sentiment === "BEARISH") {
    return {
      blocked: true,
      note: `News sentiment filter: BEARISH for ${ticker} - ${summary}`,
    };
  }

  return {
    blocked: false,
    note: `News sentiment filter: ${sentiment} for ${ticker} - not blocking.`,
  };
}

// Filters BUY signals against cached news sentiment. Fails open: if
// sentiment can't be fetched (rate limit, API error), the trade is not
// blocked - this is a risk-reducing enhancement, not a reliability
// dependency for the core strategy.
async function getBuySentimentVeto(
  ticker: string,
  enabled: boolean,
): Promise<SentimentVetoResult | null> {
  if (!enabled) return null;

  const cached = sentimentCacheByTicker.get(ticker);
  const isFresh =
    cached !== undefined &&
    Date.now() - cached.fetchedAt < SENTIMENT_CACHE_TTL_MS;

  let entry: SentimentCacheEntry;

  if (isFresh) {
    entry = cached;
  } else {
    try {
      const result = await getNewsSentiment(ticker);

      entry = {
        sentiment: result.sentiment,
        summary: result.summary,
        fetchedAt: Date.now(),
      };
      sentimentCacheByTicker.set(ticker, entry);
    } catch (error) {
      console.warn(
        `[AUTOPILOT] Sentiment filter fetch failed for ${ticker}, not blocking trade:`,
        getErrorMessage(error),
      );
      return null;
    }
  }

  return evaluateSentimentVeto(ticker, entry.sentiment, entry.summary);
}

const INSIDER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const INSIDER_SELL_CLUSTER_THRESHOLD = 2;
const insiderCacheByTicker = new Map<string, InsiderCacheEntry>();

// Pure decision rule, kept separate from the fetch/cache orchestration
// below so it's testable without mocking network calls.
export function evaluateInsiderVeto(
  ticker: string,
  buyCount: number,
  sellCount: number,
): SentimentVetoResult {
  if (sellCount >= INSIDER_SELL_CLUSTER_THRESHOLD && buyCount === 0) {
    return {
      blocked: true,
      note: `Insider activity filter: ${sellCount} open-market insider sells with no offsetting buys for ${ticker}.`,
    };
  }

  return {
    blocked: false,
    note: `Insider activity filter: ${buyCount} buys / ${sellCount} sells for ${ticker} - not blocking.`,
  };
}

// Filters BUY signals against cached open-market insider transactions.
// Fails open on fetch errors, same as the sentiment filter.
async function getBuyInsiderVeto(
  ticker: string,
  enabled: boolean,
): Promise<SentimentVetoResult | null> {
  if (!enabled) return null;

  const cached = insiderCacheByTicker.get(ticker);
  const isFresh =
    cached !== undefined &&
    Date.now() - cached.fetchedAt < INSIDER_CACHE_TTL_MS;

  let entry: InsiderCacheEntry;

  if (isFresh) {
    entry = cached;
  } else {
    try {
      const result = await getInsiderActivity(ticker);
      const openMarket = result.transactions.filter((tx) => tx.isOpenMarket);

      entry = {
        buyCount: openMarket.filter((tx) => tx.transactionCode === "P").length,
        sellCount: openMarket.filter((tx) => tx.transactionCode === "S").length,
        fetchedAt: Date.now(),
      };
      insiderCacheByTicker.set(ticker, entry);
    } catch (error) {
      console.warn(
        `[AUTOPILOT] Insider filter fetch failed for ${ticker}, not blocking trade:`,
        getErrorMessage(error),
      );
      return null;
    }
  }

  return evaluateInsiderVeto(ticker, entry.buyCount, entry.sellCount);
}

/**
 * Genuinely SELL-path logic - see this file's header comment for the
 * currently-unreachable-through-the-real-pipeline finding. Exported
 * (visibility-only change from the pre-extraction private function) so it
 * can be unit-tested directly with hand-crafted inputs.
 */
export function shouldBlockNormalSellBelowAverageEntry({
  action,
  reasonType,
  sharesOwned,
  price,
  averageEntryPrice,
  blockSellBelowAverageEntry,
}: {
  action: StrategyDecision["action"];
  reasonType: StrategyDecision["reasonType"];
  sharesOwned: number;
  price: number;
  averageEntryPrice: number;
  blockSellBelowAverageEntry: boolean;
}): boolean {
  if (!blockSellBelowAverageEntry) return false;
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

function calculateBarsSinceLastBuy(
  ticker: string,
  lastBuyAtByTicker: Map<string, number>,
  cooldownMinutes: number,
): number {
  const lastBuyAt = lastBuyAtByTicker.get(ticker);

  if (!lastBuyAt) {
    return DEFAULT_STRATEGY_CONFIG.cooldownBars;
  }

  const elapsedMs = Date.now() - lastBuyAt;
  const cooldownMs = cooldownMinutes * 60 * 1000;

  return elapsedMs >= cooldownMs ? DEFAULT_STRATEGY_CONFIG.cooldownBars : 0;
}

export interface AnalyzeTickerExecutionGates {
  executeTradesEnabled: boolean;
  allowBuy: boolean;
  allowSell: boolean;
}

export interface AnalyzeTickerParams {
  ticker: string;
  portfolio: PortfolioSnapshot;
  circuitBreakerState: CircuitBreakerState | null;
  regimeByBucketByDate: Map<string, Map<string, RegimeState>>;
  tradeMode: "paper" | "live";
  minConfidence: number;
  cooldownMinutes: number;
  allowFractionalShares: boolean;
  blockSellBelowAverageEntry: boolean;
  regimeFilterEnabled: boolean;
  regimeBuckets: RegimeBucketConfig[];
  tickerToBucket: Record<string, string>;
  maxBucketEquityFraction: number;
  bucketEquityFractionOverrides: Record<string, number>;
  sentimentFilterEnabled: boolean;
  insiderFilterEnabled: boolean;
  executionGates: AnalyzeTickerExecutionGates;
  barsDays: number;
  fetchBars: (ticker: string, days: number) => Promise<AlpacaBar[]>;
  executeSafeTrade: ExecuteSafeTrade;
  lastBuyAtByTicker: Map<string, number>;
  entryAtrPercentByTicker: Map<string, number>;
}

export async function analyzeTicker(
  params: AnalyzeTickerParams,
): Promise<AutopilotDecisionLog> {
  const {
    ticker,
    portfolio,
    circuitBreakerState,
    regimeByBucketByDate,
    tradeMode,
    minConfidence,
    cooldownMinutes,
    allowFractionalShares,
    blockSellBelowAverageEntry,
    regimeFilterEnabled,
    regimeBuckets,
    tickerToBucket,
    maxBucketEquityFraction,
    bucketEquityFractionOverrides,
    sentimentFilterEnabled,
    insiderFilterEnabled,
    executionGates,
    barsDays,
    fetchBars,
    executeSafeTrade,
    lastBuyAtByTicker,
    entryAtrPercentByTicker,
  } = params;

  const bars = await fetchBars(ticker, barsDays);

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
  const latestDateKey = latestBar.t.split("T")[0] ?? latestBar.t;
  const rsi = calculateRSI(prices, 14);
  const macd = calculateMACD(prices);
  const previousMacd = calculateMACD(previousPrices);
  const bb = calculateBollingerBands(prices, 20, 2);
  const atr = calculateATR(bars, 14);
  const atrPercent = price > 0 ? atr / price : 0;

  const position = portfolio.positions[ticker];
  const sharesOwned = position?.shares ?? 0;
  const averageEntryPrice = position?.avgPrice ?? 0;
  const barsSinceLastBuy = calculateBarsSinceLastBuy(
    ticker,
    lastBuyAtByTicker,
    cooldownMinutes,
  );
  const entryAtrPercent = entryAtrPercentByTicker.get(ticker) ?? atrPercent;

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
    entryAtrPercent,
    config: {
      allowFractionalShares,
    },
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

  if (decision.action === "BUY") {
    const bucketCap = getSafeBuySharesForBucketCap(
      ticker,
      safeSuggestedShares,
      price,
      portfolio,
      tickerToBucket,
      maxBucketEquityFraction,
      bucketEquityFractionOverrides,
    );

    safeSuggestedShares = bucketCap.shares;
    if (bucketCap.safetyNote) {
      safetyNote = appendSafetyNote(safetyNote, bucketCap.safetyNote);
    }
  }

  let safeSuggestedNotional = decision.suggestedNotional ?? 0;

  if (decision.action === "BUY" && safeSuggestedNotional > 0) {
    const notionalBucketCap = getSafeBuyNotionalForBucketCap(
      ticker,
      safeSuggestedNotional,
      portfolio,
      tickerToBucket,
      maxBucketEquityFraction,
      bucketEquityFractionOverrides,
    );

    safeSuggestedNotional = notionalBucketCap.notional;
    if (notionalBucketCap.safetyNote) {
      safetyNote = appendSafetyNote(safetyNote, notionalBucketCap.safetyNote);
    }
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
    suggestedNotional:
      safeSuggestedNotional > 0 ? safeSuggestedNotional : undefined,
    originalSuggestedNotional:
      safeSuggestedNotional > 0 &&
      safeSuggestedNotional !== decision.suggestedNotional
        ? decision.suggestedNotional
        : undefined,
    reasonType: decision.reasonType,
    reason: decision.reason,
    safetyNote,
    finalStatus: decision.action === "HOLD" ? "hold" : "blocked",
    signalStatus: decision.action === "HOLD" ? "hold" : "blocked",
    executionStatus: "not_attempted",
    isSignalReady: false,
    executed: false,
  };

  if (decision.action === "HOLD") {
    log.finalStatus = "hold";
    log.signalStatus = "hold";
    log.executionStatus = "not_attempted";
    log.isSignalReady = false;
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
      blockSellBelowAverageEntry,
    })
  ) {
    const guardNote = `Position guard: blocked normal SELL_SIGNAL because current price ${price.toFixed(
      2,
    )} is below average entry ${averageEntryPrice.toFixed(
      2,
    )}. STOP_LOSS can still sell below average entry.`;

    log.safetyNote = appendSafetyNote(log.safetyNote, guardNote);
    log.finalStatus = "blocked";
    log.signalStatus = "blocked";
    log.executionStatus = "not_attempted";
    log.isSignalReady = false;
    log.blockReasonCategory = "position_guard";
    log.blockReasonCode = "SELL_BELOW_AVG_ENTRY";
    log.blockReasonDetail = guardNote;
    log.skippedReason =
      "Position guard blocked SELL_SIGNAL below average entry.";
    return log;
  }

  if (decision.action === "BUY") {
    if (circuitBreakerState?.tripped) {
      const breakerNote = `Portfolio circuit breaker tripped: equity is down ${(
        ((portfolio.equity - circuitBreakerState.peakEquity) /
          circuitBreakerState.peakEquity) *
        100
      ).toFixed(1)}% from peak ${circuitBreakerState.peakEquity.toFixed(
        2,
      )} (recorded ${circuitBreakerState.peakEquityAt}). New BUYs blocked until reset.`;

      log.finalStatus = "blocked";
      log.signalStatus = "blocked";
      log.executionStatus = "not_attempted";
      log.isSignalReady = false;
      log.blockReasonCategory = "safety_cap";
      log.blockReasonCode = "PORTFOLIO_CIRCUIT_BREAKER";
      log.blockReasonDetail = breakerNote;
      log.safetyNote = appendSafetyNote(log.safetyNote, breakerNote);
      log.skippedReason = breakerNote;
      return log;
    }

    // Fail closed on new risk when the breaker's own risk state can't be
    // confirmed this cycle (equity-history fetch failed) - a hard safety
    // layer shouldn't assume the best case just because a data source had
    // a bad moment. SELL/STOP_LOSS are unaffected either way.
    if (circuitBreakerState?.dataStale) {
      const staleNote =
        "Portfolio circuit breaker could not confirm current drawdown this cycle (equity history fetch failed) - new BUYs blocked until it succeeds again.";

      log.finalStatus = "blocked";
      log.signalStatus = "blocked";
      log.executionStatus = "not_attempted";
      log.isSignalReady = false;
      log.blockReasonCategory = "safety_cap";
      log.blockReasonCode = "PORTFOLIO_CIRCUIT_BREAKER_DATA_STALE";
      log.blockReasonDetail = staleNote;
      log.safetyNote = appendSafetyNote(log.safetyNote, staleNote);
      log.skippedReason = staleNote;
      return log;
    }

    if (regimeFilterEnabled) {
      const regimeCheck = isBuySuppressedByRegime(
        regimeByBucketByDate,
        ticker,
        latestDateKey,
        tickerToBucket,
        regimeBuckets,
      );

      if (regimeCheck.suppressed) {
        log.finalStatus = "blocked";
        log.signalStatus = "blocked";
        log.executionStatus = "not_attempted";
        log.isSignalReady = false;
        log.blockReasonCategory = "regime_filter";
        log.blockReasonCode = "REGIME_RISK_OFF";
        log.blockReasonDetail = regimeCheck.reason;
        log.safetyNote = appendSafetyNote(log.safetyNote, regimeCheck.reason);
        log.skippedReason = regimeCheck.reason;
        return log;
      }
    }

    const sentimentVeto = await getBuySentimentVeto(ticker, sentimentFilterEnabled);

    if (sentimentVeto?.blocked) {
      log.finalStatus = "blocked";
      log.signalStatus = "blocked";
      log.executionStatus = "not_attempted";
      log.isSignalReady = false;
      log.blockReasonCategory = "sentiment_filter";
      log.blockReasonCode = "BEARISH_SENTIMENT";
      log.blockReasonDetail = sentimentVeto.note;
      log.safetyNote = appendSafetyNote(log.safetyNote, sentimentVeto.note);
      log.skippedReason = sentimentVeto.note;
      return log;
    }

    const insiderVeto = await getBuyInsiderVeto(ticker, insiderFilterEnabled);

    if (insiderVeto?.blocked) {
      log.finalStatus = "blocked";
      log.signalStatus = "blocked";
      log.executionStatus = "not_attempted";
      log.isSignalReady = false;
      log.blockReasonCategory = "insider_filter";
      log.blockReasonCode = "INSIDER_SELL_CLUSTER";
      log.blockReasonDetail = insiderVeto.note;
      log.safetyNote = appendSafetyNote(log.safetyNote, insiderVeto.note);
      log.skippedReason = insiderVeto.note;
      return log;
    }
  }

  if (decision.confidence < minConfidence) {
    const confidenceNote = `Confidence ${decision.confidence} is below min ${minConfidence}.`;

    log.finalStatus = "blocked";
    log.signalStatus = "blocked";
    log.executionStatus = "not_attempted";
    log.isSignalReady = false;
    log.blockReasonCategory = "confidence";
    log.blockReasonCode = "CONFIDENCE_BELOW_MIN";
    log.blockReasonDetail = confidenceNote;
    log.skippedReason = confidenceNote;
    return log;
  }

  if (safeSuggestedShares <= 0 && safeSuggestedNotional <= 0) {
    log.finalStatus = "blocked";
    log.signalStatus = "blocked";
    log.executionStatus = "not_attempted";
    log.isSignalReady = false;
    log.blockReasonCategory = "quantity";
    log.blockReasonCode = "NO_SAFE_QUANTITY";
    log.blockReasonDetail = "No positive safe share quantity suggested.";
    log.skippedReason = "No positive safe share quantity suggested.";
    return log;
  }

  const isFractionalOrder = safeSuggestedShares <= 0 && safeSuggestedNotional > 0;

  log.finalStatus = "signal_ready";
  log.signalStatus = "ready";
  log.executionStatus = "not_attempted";
  log.isSignalReady = true;

  if (!executionGates.executeTradesEnabled) {
    log.executionStatus = "dry_run";
    log.executionBlockReasonCategory = "dry_run";
    log.executionBlockReasonCode = "DRY_RUN";
    log.executionBlockReasonDetail =
      "Dry-run mode. Set AUTOPILOT_EXECUTE_TRADES=true to allow paper-trading execution.";
    log.skippedReason = log.executionBlockReasonDetail;
    return log;
  }

  if (tradeMode !== "paper") {
    log.executionStatus = "blocked";
    log.executionBlockReasonCategory = "trade_mode";
    log.executionBlockReasonCode = "NOT_PAPER_MODE";
    log.executionBlockReasonDetail =
      "Autopilot execution is blocked outside paper mode.";
    log.skippedReason = log.executionBlockReasonDetail;
    return log;
  }

  if (decision.action === "BUY" && !executionGates.allowBuy) {
    log.executionStatus = "blocked";
    log.executionBlockReasonCategory = "permission";
    log.executionBlockReasonCode = "BUY_DISABLED";
    log.executionBlockReasonDetail =
      "BUY execution blocked. Set AUTOPILOT_ALLOW_BUY=true to allow autopilot buys.";
    log.skippedReason = log.executionBlockReasonDetail;
    return log;
  }

  if (decision.action === "SELL" && !executionGates.allowSell) {
    log.executionStatus = "blocked";
    log.executionBlockReasonCategory = "permission";
    log.executionBlockReasonCode = "SELL_DISABLED";
    log.executionBlockReasonDetail =
      "SELL execution blocked. Set AUTOPILOT_ALLOW_SELL=true to allow autopilot sells.";
    log.skippedReason = log.executionBlockReasonDetail;
    return log;
  }

  const useAtrForOrder =
    DEFAULT_STRATEGY_CONFIG.useAtrStops && atrPercent > 0;

  // Fractional/notional BUYs don't get a bracket order (see
  // strategyEngine.ts's allowFractionalShares doc comment - unconfirmed
  // whether Alpaca supports brackets with notional sizing), so no
  // stop_loss/take_profit legs are attached for that case.
  const stopLoss =
    decision.action === "BUY" && !isFractionalOrder
      ? Number(
          (
            price *
            (1 -
              (useAtrForOrder
                ? atrPercent * DEFAULT_STRATEGY_CONFIG.atrStopMultiplier
                : DEFAULT_STRATEGY_CONFIG.stopLossPercent))
          ).toFixed(2),
        )
      : undefined;

  const takeProfit =
    decision.action === "BUY" && !isFractionalOrder
      ? Number(
          (
            price *
            (1 +
              (useAtrForOrder
                ? atrPercent * DEFAULT_STRATEGY_CONFIG.atrTakeProfitMultiplier
                : DEFAULT_STRATEGY_CONFIG.takeProfitPercent))
          ).toFixed(2),
        )
      : undefined;

  const result = await executeSafeTrade(
    ticker,
    decision.action,
    safeSuggestedShares,
    "market",
    undefined,
    stopLoss,
    takeProfit,
    isFractionalOrder ? safeSuggestedNotional : undefined,
  );

  log.result = result;

  if (result.status === "success") {
    log.finalStatus = "executed";
    log.executionStatus = "executed";
    log.executed = true;

    if (decision.action === "BUY") {
      lastBuyAtByTicker.set(ticker, Date.now());

      const previousPositionCost = averageEntryPrice * sharesOwned;
      const previousAtrWeight = entryAtrPercent * previousPositionCost;
      const newBuyCost = isFractionalOrder
        ? safeSuggestedNotional
        : price * safeSuggestedShares;
      const newPositionCost = previousPositionCost + newBuyCost;

      entryAtrPercentByTicker.set(
        ticker,
        newPositionCost > 0
          ? (previousAtrWeight + atrPercent * newBuyCost) / newPositionCost
          : atrPercent,
      );
    }
  } else {
    const executionFailure =
      result.reason || "Trade execution did not succeed.";

    log.finalStatus = "execution_failed";
    log.executionStatus = "failed";
    log.executionBlockReasonCategory = "broker";
    log.executionBlockReasonCode = "EXECUTION_FAILED";
    log.executionBlockReasonDetail = executionFailure;
    log.skippedReason = executionFailure;
  }

  return log;
}
