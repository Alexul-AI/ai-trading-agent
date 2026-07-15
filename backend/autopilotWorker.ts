import { randomUUID } from "crypto";
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
import {
  appendAutopilotRun,
  createStrategyConfigHash,
} from "./decisionJournal.js";
import {
  computeRebalanceOrders,
  decideRotationTargets,
  ETF_ROTATION_CONFIG_VARIANTS,
  isMonthlyRebalanceDate,
  resolveEtfRotationConfigVariant,
  type EtfRotationConfig,
  type RebalanceOrder,
} from "./etfRotationStrategy.js";
import {
  getLastRebalanceDateKey,
  recordRebalanceDateKey,
} from "./etfRotationWorkerState.js";
import { getNewsSentiment, getInsiderActivity } from "./agent.js";
import {
  updatePortfolioCircuitBreaker,
  getMaxDrawdownFromPeakPercent,
  shouldSendDailyReminder,
  recordReminderSent,
  type CircuitBreakerState,
  type FetchEquityHistory,
} from "./portfolioCircuitBreaker.js";
import { appendCircuitBreakerAuditEvent } from "./circuitBreakerAuditLog.js";
import {
  computeBucketRegimeByDate,
  isBuySuppressedByRegime,
  type RegimeBucketConfig,
  type RegimeState,
} from "./src/strategy/portfolioRegimeFilter.js";
import { tryClaimWorkerLock } from "./autopilotWorkerLock.js";
import {
  AUTOPILOT_MAX_SELL_FRACTION,
  clampFraction,
  getSafeBuyNotionalForBucketCap,
  getSafeBuySharesForBucketCap,
  getSafeSellShares,
  type PortfolioPositionSnapshot,
  type PortfolioSnapshot,
} from "./src/strategy/portfolioSafety.js";

export {
  getSafeBuyNotionalForBucketCap,
  getSafeBuySharesForBucketCap,
  getSafeSellShares,
};
export type { PortfolioPositionSnapshot, PortfolioSnapshot };

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
  requestedNotional?: number,
) => Promise<ExecuteSafeTradeResult>;

export interface AutopilotWorkerOptions {
  tradeMode: "paper" | "live";
  getPortfolioSnapshot: () => Promise<PortfolioSnapshot>;
  getEquityHistorySince: FetchEquityHistory;
  executeSafeTrade: ExecuteSafeTrade;
  broadcastSSE: (payload: unknown) => void;
  sendTelegramAlert?: (message: string) => Promise<void>;
}

export type SignalStatus = "hold" | "blocked" | "ready";
export type ExecutionStatus =
  | "not_attempted"
  | "dry_run"
  | "blocked"
  | "executed"
  | "failed";

export type DecisionFinalStatus =
  | "hold"
  | "blocked"
  | "signal_ready"
  | "executed"
  | "execution_failed"
  | "error";

export type BlockReasonCategory =
  | "confidence"
  | "position_guard"
  | "safety_cap"
  | "quantity"
  | "sentiment_filter"
  | "insider_filter"
  | "regime_filter"
  | "error"
  | "other";

export type ExecutionBlockReasonCategory =
  | "dry_run"
  | "trade_mode"
  | "permission"
  | "broker"
  | "other";

export interface AutopilotDecisionLog {
  ticker: string;
  timestamp: string;
  price: number;
  /**
   * Optional - single-ticker confluence-scoring indicators (strategyEngine.ts)
   * with no equivalent for an ETF Rotation rebalance decision (see
   * etfRotationStrategy.ts). Omitted for rotation decisions rather than
   * populated with misleading placeholder values.
   */
  rsi?: number;
  macdHistogram?: number;
  previousMacdHistogram?: number;
  bollingerLower?: number;
  bollingerUpper?: number;
  action: StrategyDecision["action"];
  confidence: number;
  suggestedShares: number;
  originalSuggestedShares?: number;
  /** Fractional-fallback dollar amount, set only when using notional sizing. */
  suggestedNotional?: number;
  originalSuggestedNotional?: number;
  /** A plain string, not restricted to StrategyDecision's own reasonType union - the ETF Rotation path uses its own vocabulary (REBALANCE_BUY/REBALANCE_SELL/etc), matching decisionJournal.ts's JournalDecision.reasonType (also an unrestricted string). */
  reasonType: string;
  reason: string;
  safetyNote?: string;
  finalStatus?: DecisionFinalStatus;
  signalStatus?: SignalStatus;
  executionStatus?: ExecutionStatus;
  isSignalReady?: boolean;
  blockReasonCategory?: BlockReasonCategory;
  blockReasonCode?: string;
  blockReasonDetail?: string;
  executionBlockReasonCategory?: ExecutionBlockReasonCategory;
  executionBlockReasonCode?: string;
  executionBlockReasonDetail?: string;
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
  circuitBreaker: CircuitBreakerState | null;
  circuitBreakerMaxDrawdownFromPeakPercent: number;
}

const APCA_API_KEY_ID = process.env.APCA_API_KEY_ID ?? "";
const APCA_API_SECRET_KEY = process.env.APCA_API_SECRET_KEY ?? "";

// Strategy decisions are computed from daily bars (RSI/MACD/BB don't change
// intraday), so polling every 60s previously just re-evaluated the same
// inputs ~390 times between meaningful data changes - added log/journal
// noise and API calls, not information. Hourly gives 24 evaluations/day
// instead, still frequent enough to react same-day, without the churn.
const AUTOPILOT_INTERVAL_MS = Number.parseInt(
  process.env.AUTOPILOT_INTERVAL_MS || "3600000",
  10,
);

// Best-effort, same-host-only protection (see autopilotWorkerLock.ts for
// the honest limitation) - default 3x the cycle interval, long enough that
// a normal cycle never falsely looks stale, short enough that a crashed
// process doesn't block recovery for long.
const AUTOPILOT_LOCK_STALE_AFTER_MS = Number.parseInt(
  process.env.AUTOPILOT_LOCK_STALE_AFTER_MS ||
    String(AUTOPILOT_INTERVAL_MS * 3),
  10,
);

const WORKER_OWNER_ID = randomUUID();

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

const ALPACA_DATA_FEED = process.env.ALPACA_DATA_FEED || "iex";

const AUTOPILOT_TICKERS = (
  process.env.AUTOPILOT_TICKERS ||
  "AMD,NVDA,AAPL,MSFT,TSLA,JPM,JNJ,XOM,PG,SPY,GLD,TLT,EFA"
)
  .split(",")
  .map((ticker) => ticker.trim().toUpperCase())
  .filter(Boolean);

const AUTOPILOT_EXECUTE_TRADES =
  process.env.AUTOPILOT_EXECUTE_TRADES === "true";

const AUTOPILOT_ALLOW_BUY = process.env.AUTOPILOT_ALLOW_BUY === "true";
const AUTOPILOT_ALLOW_SELL = process.env.AUTOPILOT_ALLOW_SELL === "true";

// Off by default: this signal cannot be backtested (news APIs only return
// current data, not point-in-time history), so enabling it is an explicit,
// unvalidated opt-in rather than a proven improvement.
const AUTOPILOT_SENTIMENT_FILTER_ENABLED =
  process.env.AUTOPILOT_SENTIMENT_FILTER === "true";
const SENTIMENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Same rationale as the sentiment filter: unbacktestable, off by default.
// Threshold is intentionally conservative - a single insider sale is a
// weak/noisy signal (taxes, diversification), so it only blocks on a
// cluster of open-market sells with zero offsetting buys.
const AUTOPILOT_INSIDER_FILTER_ENABLED =
  process.env.AUTOPILOT_INSIDER_FILTER === "true";
const INSIDER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const INSIDER_SELL_CLUSTER_THRESHOLD = 2;

// Off by default: backtest-validated (see backtest-sweep.ts's
// regime-filter-* variants), but "roughly matches baseline" isn't strong
// enough evidence to flip a new filter on by default - same standard
// already applied to useAtrStops.
const AUTOPILOT_REGIME_FILTER_ENABLED =
  process.env.AUTOPILOT_REGIME_FILTER === "true";

// Off by default: lets a BUY that would otherwise size to 0 whole shares
// (most/all tickers below ~$1,000-3,000 of capital) fall back to a
// fractional/notional order instead. That order gives up Alpaca's
// broker-side bracket stop_loss/take_profit (see
// strategyEngine.ts's allowFractionalShares doc comment) - an explicit
// capability-for-protection trade-off, not a pure risk reduction, so it's
// opt-in like the sentiment/insider filters rather than always-on like the
// bucket cap.
const AUTOPILOT_ALLOW_FRACTIONAL_SHARES_ENABLED =
  process.env.AUTOPILOT_ALLOW_FRACTIONAL_SHARES === "true";

// Every bucket-representative ticker below (SPY, EFA, TLT, GLD, AMD, NVDA,
// TSLA) is already part of AUTOPILOT_TICKERS and already fetched every
// cycle via fetchAlpacaBars's cache - this filter reads bars that are being
// fetched anyway, no extra API calls.
const REGIME_BUCKETS: RegimeBucketConfig[] = [
  {
    bucketId: "us_broad",
    label: "US broad market",
    tickers: ["SPY"],
    smaWindowDays: 200,
  },
  {
    bucketId: "international",
    label: "International developed",
    tickers: ["EFA"],
    smaWindowDays: 200,
  },
  {
    bucketId: "bonds",
    label: "Long treasuries",
    tickers: ["TLT"],
    smaWindowDays: 200,
  },
  {
    bucketId: "commodities",
    label: "Gold",
    tickers: ["GLD"],
    smaWindowDays: 200,
  },
  {
    bucketId: "high_beta_growth",
    label: "High-beta growth",
    tickers: ["AMD", "NVDA", "TSLA"],
    smaWindowDays: 200,
    // Backtest-validated: see backtest-sweep.ts's regime-filter-* variants -
    // an unvalidated hypothesis until checked against our own tickers, not
    // accepted as a given just because it was suggested.
    exempt: process.env.AUTOPILOT_REGIME_EXEMPT_HIGH_BETA !== "false",
  },
];

// Shared by the regime filter (#8) and the bucket concentration cap (#9) -
// same real-world correlation grouping serves both purposes.
const TICKER_TO_BUCKET: Record<string, string> = {
  AAPL: "us_broad",
  MSFT: "us_broad",
  JPM: "us_broad",
  JNJ: "us_broad",
  XOM: "us_broad",
  PG: "us_broad",
  SPY: "us_broad",
  EFA: "international",
  TLT: "bonds",
  GLD: "commodities",
  AMD: "high_beta_growth",
  NVDA: "high_beta_growth",
  TSLA: "high_beta_growth",
};

// Twice the single-ticker cap (maxPositionEquityFraction is 0.2) - allows up
// to two full-sized positions' worth of concentration in one correlated
// bucket, but blocks the AMD+NVDA+TSLA-all-at-20%-each scenario. Only bites
// for multi-ticker buckets (us_broad, high_beta_growth) - the single-ticker
// buckets never approach 40% since they're already capped at 20% each.
const AUTOPILOT_MAX_BUCKET_EQUITY_FRACTION = Number.parseFloat(
  process.env.AUTOPILOT_MAX_BUCKET_EQUITY_FRACTION || "0.4",
);

// ETF-first tilt: high_beta_growth (AMD/NVDA/TSLA) gets a tighter cap than
// the other buckets - equal to the single-ticker cap, so the whole bucket
// combined can never exceed what one full-sized individual position would
// already be allowed. Doesn't remove these tickers from the universe, just
// meaningfully reduces how concentrated the bot can get in speculative
// single names versus the ETF-heavy buckets (us_broad/international/
// bonds/commodities), which keep the looser 40% default.
const AUTOPILOT_HIGH_BETA_BUCKET_EQUITY_FRACTION = Number.parseFloat(
  process.env.AUTOPILOT_HIGH_BETA_BUCKET_EQUITY_FRACTION || "0.2",
);

const BUCKET_EQUITY_FRACTION_OVERRIDES: Record<string, number> = {
  high_beta_growth: AUTOPILOT_HIGH_BETA_BUCKET_EQUITY_FRACTION,
};

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

// Mutually exclusive with the baseline strategy above - never both in the
// same process. See docs/product/ROADMAP.md Phase 3 and the ETF Rotation
// live-integration plan: the baseline's 13-ticker universe and rotation's
// 5-ETF universe overlap (SPY/EFA/TLT/GLD), and neither order idempotency
// (server.ts's client_order_id, keyed only "TICKER:ACTION") nor position
// tracking (ticker-keyed only, no strategy attribution) could safely
// disambiguate two strategies trading the same ticker concurrently.
export type AutopilotStrategyKind = "baseline" | "etf_rotation";

const AUTOPILOT_STRATEGY: AutopilotStrategyKind =
  process.env.AUTOPILOT_STRATEGY === "etf_rotation"
    ? "etf_rotation"
    : "baseline";

const ETF_ROTATION_CONFIG_VARIANT_KEY = resolveEtfRotationConfigVariant(
  process.env.ETF_ROTATION_CONFIG,
);
const ETF_ROTATION_ACTIVE_CONFIG: EtfRotationConfig =
  ETF_ROTATION_CONFIG_VARIANTS[ETF_ROTATION_CONFIG_VARIANT_KEY].config;

const ETF_ROTATION_STRATEGY_VERSION = `etf-rotation-${ETF_ROTATION_CONFIG_VARIANT_KEY}`;
const ETF_ROTATION_STRATEGY_CONFIG_HASH = createStrategyConfigHash(
  ETF_ROTATION_ACTIVE_CONFIG,
);

// Momentum(126 trading days) + SMA(200 trading days) need ~210 trading days
// of runway before a decision is numerically valid (same WARMUP_BARS
// convention as backtest-etf-rotation.ts) - far more than the baseline
// path's 180-calendar-day default. 400 calendar days clears that with
// weekend/holiday margin to spare.
const AUTOPILOT_ETF_ROTATION_BARS_DAYS = Number.parseInt(
  process.env.AUTOPILOT_ETF_ROTATION_BARS_DAYS || "400",
  10,
);
const ETF_ROTATION_WARMUP_TRADING_DAYS = 210;

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

interface SentimentCacheEntry {
  sentiment: string;
  summary: string;
  fetchedAt: number;
}

const sentimentCacheByTicker = new Map<string, SentimentCacheEntry>();

export interface SentimentVetoResult {
  blocked: boolean;
  note: string;
}

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
): Promise<SentimentVetoResult | null> {
  if (!AUTOPILOT_SENTIMENT_FILTER_ENABLED) return null;

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

interface InsiderCacheEntry {
  buyCount: number;
  sellCount: number;
  fetchedAt: number;
}

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
): Promise<SentimentVetoResult | null> {
  if (!AUTOPILOT_INSIDER_FILTER_ENABLED) return null;

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

export function isSignalReadyDecision(decision: AutopilotDecisionLog): boolean {
  if (typeof decision.isSignalReady === "boolean") {
    return decision.isSignalReady;
  }

  return (
    decision.action !== "HOLD" &&
    decision.confidence >= AUTOPILOT_MIN_CONFIDENCE &&
    (decision.suggestedShares > 0 || (decision.suggestedNotional ?? 0) > 0) &&
    !decision.skippedReason
  );
}

async function fetchAlpacaBarsUncached(
  ticker: string,
  days: number = AUTOPILOT_BARS_DAYS,
): Promise<AlpacaBar[]> {
  if (!APCA_API_KEY_ID || !APCA_API_SECRET_KEY) {
    throw new Error("Missing Alpaca API keys for market data.");
  }

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - days);

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

// Daily bars cannot change more than once a day, so re-fetching the full
// 180-day history on every 60s tick (5 tickers x 1440 ticks/day = up to
// 7200 calls/day) was almost entirely redundant. A short cache cuts that
// by ~5x with zero effect on the actual decisions.
const BARS_CACHE_TTL_MS = 5 * 60 * 1000;
const barsCacheByTicker = new Map<
  string,
  { bars: AlpacaBar[]; fetchedAt: number }
>();

// Cache key includes days since the ETF Rotation path fetches the same
// tickers with a much longer warmup window than the baseline path - without
// this, whichever call happened to run first this cycle would silently
// serve its own days value's bars to the other.
async function fetchAlpacaBars(
  ticker: string,
  days: number = AUTOPILOT_BARS_DAYS,
): Promise<AlpacaBar[]> {
  const cacheKey = `${ticker}:${days}`;
  const cached = barsCacheByTicker.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < BARS_CACHE_TTL_MS) {
    return cached.bars;
  }

  const bars = await fetchAlpacaBarsUncached(ticker, days);

  barsCacheByTicker.set(cacheKey, { bars, fetchedAt: Date.now() });

  return bars;
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

// Deliberately excludes decision.reason and suggestedShares: both embed
// live indicator values (RSI, price) that drift almost every tick, which
// would make this key near-unique per call. That both defeats the
// cooldown dedup (Telegram would alert on nearly every tick instead of
// once per AUTOPILOT_TELEGRAM_COOLDOWN_MINUTES) and leaks memory forever
// in lastTelegramSentAtBySignal, since old keys are never evicted. Ticker
// + action + reasonType is a small, naturally bounded key space.
export function buildSignalKey(decision: AutopilotDecisionLog): string {
  return [decision.ticker, decision.action, decision.reasonType].join("|");
}

export function createAutopilotWorker(options: AutopilotWorkerOptions) {
  let enabled = AUTOPILOT_ENABLED_DEFAULT;
  let running = false;
  let timer: NodeJS.Timeout | null = null;
  let lastRunAt: string | null = null;
  let lastJournalRunId: string | null = null;
  let lastError: string | null = null;
  let lastDecisions: AutopilotDecisionLog[] = [];
  let lastCircuitBreakerState: CircuitBreakerState | null = null;
  const lastBuyAtByTicker = new Map<string, number>();
  // Entry-time ATR%, weighted-averaged across partial buys the same way
  // averageEntryPrice is - in-memory only (not persisted like the circuit
  // breaker): useAtrStops ships off by default and no trades execute yet
  // (AUTOPILOT_EXECUTE_TRADES=false), so there's nothing real to lose on a
  // restart today. decideTradeSignal falls back to the current cycle's ATR%
  // when a ticker has no recorded entry here.
  const entryAtrPercentByTicker = new Map<string, number>();
  const lastTelegramSentAtBySignal = new Map<string, number>();

  async function analyzeTicker(
    ticker: string,
    portfolio: PortfolioSnapshot,
    circuitBreakerState: CircuitBreakerState | null,
    regimeByBucketByDate: Map<string, Map<string, RegimeState>>,
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
        allowFractionalShares: AUTOPILOT_ALLOW_FRACTIONAL_SHARES_ENABLED,
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
        TICKER_TO_BUCKET,
        AUTOPILOT_MAX_BUCKET_EQUITY_FRACTION,
        BUCKET_EQUITY_FRACTION_OVERRIDES,
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
        TICKER_TO_BUCKET,
        AUTOPILOT_MAX_BUCKET_EQUITY_FRACTION,
        BUCKET_EQUITY_FRACTION_OVERRIDES,
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

      if (AUTOPILOT_REGIME_FILTER_ENABLED) {
        const regimeCheck = isBuySuppressedByRegime(
          regimeByBucketByDate,
          ticker,
          latestDateKey,
          TICKER_TO_BUCKET,
          REGIME_BUCKETS,
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

      const sentimentVeto = await getBuySentimentVeto(ticker);

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

      const insiderVeto = await getBuyInsiderVeto(ticker);

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

    if (decision.confidence < AUTOPILOT_MIN_CONFIDENCE) {
      const confidenceNote = `Confidence ${decision.confidence} is below min ${AUTOPILOT_MIN_CONFIDENCE}.`;

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

    if (!AUTOPILOT_EXECUTE_TRADES) {
      log.executionStatus = "dry_run";
      log.executionBlockReasonCategory = "dry_run";
      log.executionBlockReasonCode = "DRY_RUN";
      log.executionBlockReasonDetail =
        "Dry-run mode. Set AUTOPILOT_EXECUTE_TRADES=true to allow paper-trading execution.";
      log.skippedReason = log.executionBlockReasonDetail;
      return log;
    }

    if (options.tradeMode !== "paper") {
      log.executionStatus = "blocked";
      log.executionBlockReasonCategory = "trade_mode";
      log.executionBlockReasonCode = "NOT_PAPER_MODE";
      log.executionBlockReasonDetail =
        "Autopilot execution is blocked outside paper mode.";
      log.skippedReason = log.executionBlockReasonDetail;
      return log;
    }

    if (decision.action === "BUY" && !AUTOPILOT_ALLOW_BUY) {
      log.executionStatus = "blocked";
      log.executionBlockReasonCategory = "permission";
      log.executionBlockReasonCode = "BUY_DISABLED";
      log.executionBlockReasonDetail =
        "BUY execution blocked. Set AUTOPILOT_ALLOW_BUY=true to allow autopilot buys.";
      log.skippedReason = log.executionBlockReasonDetail;
      return log;
    }

    if (decision.action === "SELL" && !AUTOPILOT_ALLOW_SELL) {
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

    const result = await options.executeSafeTrade(
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

  async function sendTelegramForNewSignalReadyDecisions(
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
      const quantity = decision.suggestedNotional
        ? `$${decision.suggestedNotional.toFixed(2)} (fractional)`
        : `${decision.suggestedShares}`;

      return `${decision.ticker}: ${decision.action} ${quantity}${original}, confidence=${decision.confidence}, executed=${decision.executed}, reason=${decision.reason}${safety}`;
    });

    await options.sendTelegramAlert(
      `Autopilot ${AUTOPILOT_EXECUTE_TRADES ? "EXECUTION" : "DRY-RUN"} signals:\n${lines.join(
        "\n",
      )}`,
    );
  }

  // Sentiment/insider filters are experimental and off by default - when
  // enabled, the user should see a filter actually veto a signal, not have
  // to go dig through the journal to find out.
  async function sendTelegramForFilterBlocks(decisions: AutopilotDecisionLog[]) {
    if (!options.sendTelegramAlert) return;

    const blocked = decisions.filter(
      (decision) =>
        decision.blockReasonCategory === "sentiment_filter" ||
        decision.blockReasonCategory === "insider_filter",
    );

    if (blocked.length === 0) return;

    const now = Date.now();
    const cooldownMs = AUTOPILOT_TELEGRAM_COOLDOWN_MINUTES * 60 * 1000;

    const newBlocks = blocked.filter((decision) => {
      const key = `FILTER:${buildSignalKey(decision)}`;
      const lastSentAt = lastTelegramSentAtBySignal.get(key);

      if (lastSentAt && now - lastSentAt < cooldownMs) {
        return false;
      }

      lastTelegramSentAtBySignal.set(key, now);
      return true;
    });

    if (newBlocks.length === 0) return;

    const lines = newBlocks.map((decision) => {
      const filterName =
        decision.blockReasonCategory === "sentiment_filter"
          ? "Sentiment"
          : "Insider activity";

      return `${decision.ticker}: ${filterName} filter blocked a BUY - ${
        decision.blockReasonDetail ?? decision.skippedReason
      }`;
    });

    await options.sendTelegramAlert(
      `Autopilot experimental filter vetoed a signal:\n${lines.join("\n")}`,
    );
  }

  // ETF Rotation decision path (Stage 1: decision-only, see
  // docs/product/ROADMAP.md Phase 3 and the ETF Rotation live-integration
  // plan) - mutually exclusive with analyzeTicker's per-ticker baseline
  // loop, never both in the same runOnce() call. Every decision this
  // produces is journaled with executionStatus "dry_run" (BUY/SELL) or
  // "not_attempted" (HOLD) unconditionally - this function never calls
  // options.executeSafeTrade, by construction, regardless of
  // AUTOPILOT_EXECUTE_TRADES/AUTOPILOT_ALLOW_BUY/AUTOPILOT_ALLOW_SELL.
  async function runEtfRotationCycle(
    portfolio: PortfolioSnapshot,
  ): Promise<AutopilotDecisionLog[]> {
    const config = ETF_ROTATION_ACTIVE_CONFIG;
    const timestamp = new Date().toISOString();

    const barsByTicker = new Map<string, AlpacaBar[]>();

    await Promise.all(
      config.universe.map(async (ticker) => {
        barsByTicker.set(
          ticker,
          await fetchAlpacaBars(ticker, AUTOPILOT_ETF_ROTATION_BARS_DAYS),
        );
      }),
    );

    let latestDateKey: string | null = null;
    const priceHistoryByTicker = new Map<string, number[]>();
    const currentPriceByTicker = new Map<string, number>();

    for (const ticker of config.universe) {
      const bars = barsByTicker.get(ticker) ?? [];
      const prices = bars.map((bar) => bar.c);
      priceHistoryByTicker.set(ticker, prices);

      const latestBar = bars[bars.length - 1];
      if (latestBar) {
        currentPriceByTicker.set(ticker, Number(latestBar.c.toFixed(2)));
        const dateKey = latestBar.t.split("T")[0] ?? latestBar.t;
        if (!latestDateKey || dateKey > latestDateKey) {
          latestDateKey = dateKey;
        }
      }
    }

    if (!latestDateKey) {
      throw new Error(
        "ETF Rotation: no bars available for any universe ticker.",
      );
    }

    const lastRebalanceDateKey = await getLastRebalanceDateKey();
    const isRebalanceDay = isMonthlyRebalanceDate(
      latestDateKey,
      lastRebalanceDateKey,
    );

    if (!isRebalanceDay) {
      return config.universe.map((ticker) => ({
        ticker,
        timestamp,
        price: currentPriceByTicker.get(ticker) ?? 0,
        action: "HOLD",
        confidence: 0,
        suggestedShares: 0,
        reasonType: "NOT_REBALANCE_DAY",
        reason: `Not a monthly rebalance day (latest bar ${latestDateKey}, last rebalance ${
          lastRebalanceDateKey ?? "never"
        }).`,
        finalStatus: "hold",
        signalStatus: "hold",
        executionStatus: "not_attempted",
        isSignalReady: false,
        executed: false,
      }));
    }

    // Fails closed (skips the rebalance rather than computing targets off
    // partial history) if any universe ticker doesn't yet have enough bars
    // for a numerically valid momentum/SMA read - same "don't trust a short
    // window" principle as the RSI/MACD warmup fix elsewhere in this repo.
    const insufficientHistoryTickers = config.universe.filter(
      (ticker) =>
        (priceHistoryByTicker.get(ticker)?.length ?? 0) <
        ETF_ROTATION_WARMUP_TRADING_DAYS,
    );

    if (insufficientHistoryTickers.length > 0) {
      return config.universe.map((ticker) => ({
        ticker,
        timestamp,
        price: currentPriceByTicker.get(ticker) ?? 0,
        action: "HOLD",
        confidence: 0,
        suggestedShares: 0,
        reasonType: "NOT_REBALANCE_DAY",
        reason: `Skipping rebalance: insufficient warmup history (need ${ETF_ROTATION_WARMUP_TRADING_DAYS} trading days) for ${insufficientHistoryTickers.join(
          ", ",
        )}.`,
        finalStatus: "hold",
        signalStatus: "hold",
        executionStatus: "not_attempted",
        isSignalReady: false,
        executed: false,
        skippedReason: "Insufficient warmup history.",
      }));
    }

    const targets = decideRotationTargets(priceHistoryByTicker, config);

    const currentSharesByTicker = new Map<string, number>();
    for (const ticker of config.universe) {
      const position = portfolio.positions[ticker];
      if (position?.shares) {
        currentSharesByTicker.set(ticker, position.shares);
      }
    }

    const orders: RebalanceOrder[] = computeRebalanceOrders(
      targets,
      portfolio.equity,
      currentSharesByTicker,
      currentPriceByTicker,
      config.universe,
    );

    // Recorded even though nothing executes yet (Stage 1) - the monthly
    // gate's job is "did we already compute this month's targets," which is
    // true as soon as targets are computed, independent of execution. Stage
    // 2 will not need to change this.
    await recordRebalanceDateKey(latestDateKey);

    const targetByTicker = new Map(targets.map((target) => [target.ticker, target]));
    const sellByTicker = new Map(
      orders
        .filter((order) => order.action === "SELL")
        .map((order) => [order.ticker, order]),
    );
    const buyByTicker = new Map(
      orders
        .filter((order) => order.action === "BUY")
        .map((order) => [order.ticker, order]),
    );

    return config.universe.map((ticker): AutopilotDecisionLog => {
      const price = currentPriceByTicker.get(ticker) ?? 0;
      const buyOrder = buyByTicker.get(ticker);
      const sellOrder = sellByTicker.get(ticker);
      const target = targetByTicker.get(ticker);

      if (buyOrder) {
        const reason = sellOrder
          ? `Momentum/trend rebalance: continuing top pick at target weight ${target?.weightPercent.toFixed(
              1,
            )}% - liquidated ${sellOrder.shares} existing shares and rebuilt to ${
              buyOrder.shares
            } shares.`
          : `Momentum/trend rebalance: new top pick at target weight ${target?.weightPercent.toFixed(
              1,
            )}% - buying ${buyOrder.shares} shares.`;

        return {
          ticker,
          timestamp,
          price,
          action: "BUY",
          confidence: 1,
          suggestedShares: buyOrder.shares,
          reasonType: "REBALANCE_BUY",
          reason,
          finalStatus: "signal_ready",
          signalStatus: "ready",
          executionStatus: "dry_run",
          isSignalReady: true,
          executionBlockReasonCategory: "dry_run",
          executionBlockReasonCode: "ETF_ROTATION_STAGE_1_NO_EXECUTION",
          executionBlockReasonDetail:
            "ETF Rotation execution is not yet wired to order submission (Stage 1: decision-only).",
          executed: false,
        };
      }

      if (sellOrder) {
        return {
          ticker,
          timestamp,
          price,
          action: "SELL",
          confidence: 1,
          suggestedShares: sellOrder.shares,
          reasonType: "REBALANCE_SELL",
          reason: `Momentum/trend rebalance: no longer a top pick or failed the trend filter - liquidating ${sellOrder.shares} shares.`,
          finalStatus: "signal_ready",
          signalStatus: "ready",
          executionStatus: "dry_run",
          isSignalReady: true,
          executionBlockReasonCategory: "dry_run",
          executionBlockReasonCode: "ETF_ROTATION_STAGE_1_NO_EXECUTION",
          executionBlockReasonDetail:
            "ETF Rotation execution is not yet wired to order submission (Stage 1: decision-only).",
          executed: false,
        };
      }

      return {
        ticker,
        timestamp,
        price,
        action: "HOLD",
        confidence: 0,
        suggestedShares: 0,
        reasonType: "REBALANCE_HOLD",
        reason: "Not currently held and not selected in this rebalance.",
        finalStatus: "hold",
        signalStatus: "hold",
        executionStatus: "not_attempted",
        isSignalReady: false,
        executed: false,
      };
    });
  }

  async function runOnce(trigger: "manual" | "scheduled" = "manual") {
    if (running) {
      return {
        skipped: true,
        reason: "Autopilot worker is already running.",
        decisions: [],
        signalReadyCount: 0,
        signalBlockedCount: 0,
        dryRunCount: 0,
        executedCount: 0,
        status: getStatus(),
      };
    }

    const lockClaim = await tryClaimWorkerLock(
      WORKER_OWNER_ID,
      AUTOPILOT_LOCK_STALE_AFTER_MS,
    );

    if (!lockClaim.canProceed) {
      return {
        skipped: true,
        reason: `Autopilot worker lock held elsewhere: ${lockClaim.reason}`,
        decisions: [],
        signalReadyCount: 0,
        signalBlockedCount: 0,
        dryRunCount: 0,
        executedCount: 0,
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
    let runSignalReadyCount = 0;
    let runSignalBlockedCount = 0;
    let runDryRunCount = 0;
    let runExecutedCount = 0;
    let topLevelError: string | null = null;

    try {
      const portfolio = await options.getPortfolioSnapshot();
      const universeForCycle =
        AUTOPILOT_STRATEGY === "etf_rotation"
          ? ETF_ROTATION_ACTIVE_CONFIG.universe
          : AUTOPILOT_TICKERS;
      const tickers = Array.from(
        new Set([
          ...universeForCycle,
          ...Object.keys(portfolio.positions).map((ticker) =>
            ticker.toUpperCase(),
          ),
        ]),
      );

      // Updated once per cycle here, never inside analyzeTicker - tickers
      // are analyzed concurrently below, and a read-modify-write of the
      // breaker's persisted state from multiple concurrent callers would race.
      const circuitBreakerUpdate = await updatePortfolioCircuitBreaker(
        portfolio.equity,
        options.getEquityHistorySince,
      );
      lastCircuitBreakerState = circuitBreakerUpdate.state;

      const circuitBreakerDrawdownPercent =
        ((portfolio.equity - circuitBreakerUpdate.state.peakEquity) /
          circuitBreakerUpdate.state.peakEquity) *
        100;

      if (circuitBreakerUpdate.justTripped) {
        const alertMessage = `PORTFOLIO CIRCUIT BREAKER TRIPPED: equity ${portfolio.equity.toFixed(
          2,
        )} is down ${circuitBreakerDrawdownPercent.toFixed(
          1,
        )}% from peak ${circuitBreakerUpdate.state.peakEquity.toFixed(
          2,
        )}. New BUYs are blocked until manually reset.`;

        options.broadcastSSE({
          type: "notification",
          level: "error",
          message: alertMessage,
        });

        if (options.sendTelegramAlert) {
          await options.sendTelegramAlert(alertMessage);
        }

        await appendCircuitBreakerAuditEvent({
          type: "CIRCUIT_BREAKER_TRIPPED",
          timestamp: circuitBreakerUpdate.state.trippedAt ?? new Date().toISOString(),
          equity: portfolio.equity,
          peakEquity: circuitBreakerUpdate.state.peakEquity,
          drawdownPercent: circuitBreakerDrawdownPercent,
          thresholdPercent: getMaxDrawdownFromPeakPercent() * 100,
        });
      }

      // Computed once per cycle, before the concurrent per-ticker loop
      // below - every bucket-representative ticker (SPY, EFA, TLT, GLD,
      // AMD, NVDA, TSLA) is already part of AUTOPILOT_TICKERS, so this
      // reuses fetchAlpacaBars's existing cache rather than issuing new
      // requests. Baseline-strategy-only - the ETF Rotation path below has
      // its own trend filter and doesn't use this.
      const regimeByBucketByDate = new Map<string, Map<string, RegimeState>>();

      if (AUTOPILOT_STRATEGY === "baseline" && AUTOPILOT_REGIME_FILTER_ENABLED) {
        const regimeBarsByTicker = new Map<string, AlpacaBar[]>();
        const bucketTickers = new Set(
          REGIME_BUCKETS.flatMap((bucket) => bucket.tickers),
        );

        await Promise.all(
          Array.from(bucketTickers).map(async (ticker) => {
            try {
              regimeBarsByTicker.set(ticker, await fetchAlpacaBars(ticker));
            } catch (error) {
              console.warn(
                `[REGIME] Failed to fetch bars for ${ticker}: ${getErrorMessage(error)}`,
              );
            }
          }),
        );

        for (const bucket of REGIME_BUCKETS) {
          regimeByBucketByDate.set(
            bucket.bucketId,
            computeBucketRegimeByDate(regimeBarsByTicker, bucket),
          );
        }
      }

      if (AUTOPILOT_STRATEGY === "etf_rotation") {
        decisions = await runEtfRotationCycle(portfolio);

        for (const decision of decisions) {
          options.broadcastSSE({
            type: "autopilot_signal",
            data: decision,
          });
        }
      } else {
        // Each ticker's analysis only reads/writes its own per-ticker cache
        // and cooldown entries (bars, sentiment, insider caches; lastBuyAt),
        // and all of them read the same read-only portfolio snapshot and
        // circuit breaker state - safe to run concurrently. Errors are caught
        // per-ticker below so one failing ticker can never affect another or
        // reject the batch.
        decisions = await Promise.all(
          tickers.map(async (ticker): Promise<AutopilotDecisionLog> => {
            try {
              const decision = await analyzeTicker(
                ticker,
                portfolio,
                circuitBreakerUpdate.state,
                regimeByBucketByDate,
              );

              options.broadcastSSE({
                type: "autopilot_signal",
                data: decision,
              });

              return decision;
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
                finalStatus: "error",
                signalStatus: "blocked",
                executionStatus: "not_attempted",
                isSignalReady: false,
                blockReasonCategory: "error",
                blockReasonCode: "ANALYSIS_ERROR",
                blockReasonDetail: message,
                executed: false,
                skippedReason: message,
              };

              options.broadcastSSE({
                type: "autopilot_signal_error",
                data: failedDecision,
              });

              return failedDecision;
            }
          }),
        );
      }

      lastDecisions = decisions;
      lastRunAt = new Date().toISOString();

      const signalReady = decisions.filter(isSignalReadyDecision);
      const signalCandidates = decisions.filter(
        (decision) => decision.action === "BUY" || decision.action === "SELL",
      );
      const dryRunSignals = signalReady.filter(
        (decision) => decision.executionStatus === "dry_run",
      );
      const executedSignals = signalReady.filter(
        (decision) =>
          decision.executed || decision.executionStatus === "executed",
      );

      runSignalReadyCount = signalReady.length;
      runSignalBlockedCount = signalCandidates.length - signalReady.length;
      runDryRunCount = dryRunSignals.length;
      runExecutedCount = executedSignals.length;

      // Once-per-calendar-day nudge while the breaker stays tripped - the
      // trip alert above only fires once, ever, on the transition; this is
      // what stops a long halt (see CLAUDE.md's next-open finding: 315 of
      // 406 simulated days) from going unnoticed in between.
      const todayDateKey = lastRunAt.slice(0, 10);
      if (
        shouldSendDailyReminder(
          circuitBreakerUpdate.state.tripped,
          circuitBreakerUpdate.state.lastReminderSentDate,
          todayDateKey,
        )
      ) {
        const daysHalted = circuitBreakerUpdate.state.trippedAt
          ? Math.max(
              1,
              Math.round(
                (Date.parse(lastRunAt) -
                  Date.parse(circuitBreakerUpdate.state.trippedAt)) /
                  (24 * 60 * 60 * 1000),
              ),
            )
          : null;
        const blockedBuyCountToday = decisions.filter(
          (decision) => decision.blockReasonCode === "PORTFOLIO_CIRCUIT_BREAKER",
        ).length;

        const reminderMessage = `Trading still halted by circuit breaker.\nHalted since: ${
          circuitBreakerUpdate.state.trippedAt ?? "unknown"
        }\nHalt days: ${daysHalted ?? "unknown"}\nCurrent equity: ${portfolio.equity.toFixed(
          2,
        )}\nCurrent drawdown: ${circuitBreakerDrawdownPercent.toFixed(
          1,
        )}%\nBUY blocked today: ${blockedBuyCountToday}\nSELL still allowed.`;

        options.broadcastSSE({
          type: "notification",
          level: "error",
          message: reminderMessage,
        });

        if (options.sendTelegramAlert) {
          await options.sendTelegramAlert(reminderMessage);
        }

        await appendCircuitBreakerAuditEvent({
          type: "CIRCUIT_BREAKER_REMINDER_SENT",
          timestamp: lastRunAt,
          equity: portfolio.equity,
          peakEquity: circuitBreakerUpdate.state.peakEquity,
          drawdownPercent: circuitBreakerDrawdownPercent,
          thresholdPercent: getMaxDrawdownFromPeakPercent() * 100,
        });

        await recordReminderSent(todayDateKey);
      }

      try {
        const journalRun = await appendAutopilotRun({
          timestamp: lastRunAt,
          trigger,
          executeTrades: AUTOPILOT_EXECUTE_TRADES,
          tradeMode: options.tradeMode,
          enabled,
          tickers,
          signalReadyCount: runSignalReadyCount,
          signalBlockedCount: runSignalBlockedCount,
          dryRunCount: runDryRunCount,
          executedCount: runExecutedCount,
          strategyVersion:
            AUTOPILOT_STRATEGY === "etf_rotation"
              ? ETF_ROTATION_STRATEGY_VERSION
              : STRATEGY_VERSION,
          strategyConfigHash:
            AUTOPILOT_STRATEGY === "etf_rotation"
              ? ETF_ROTATION_STRATEGY_CONFIG_HASH
              : STRATEGY_CONFIG_HASH,
          strategyConfig: (AUTOPILOT_STRATEGY === "etf_rotation"
            ? ETF_ROTATION_ACTIVE_CONFIG
            : DEFAULT_STRATEGY_CONFIG) as unknown as Record<string, unknown>,
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
        signalReadyCount: runSignalReadyCount,
        signalBlockedCount: runSignalBlockedCount,
        dryRunCount: runDryRunCount,
        executedCount: runExecutedCount,
      });

      await sendTelegramForNewSignalReadyDecisions(signalReady);
      await sendTelegramForFilterBlocks(decisions);
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
        decisions,
        signalReadyCount: runSignalReadyCount,
        signalBlockedCount: runSignalBlockedCount,
        dryRunCount: runDryRunCount,
        executedCount: runExecutedCount,
        status: getStatus(),
      };
    }

    return {
      skipped: false,
      decisions,
      signalReadyCount: runSignalReadyCount,
      signalBlockedCount: runSignalBlockedCount,
      dryRunCount: runDryRunCount,
      executedCount: runExecutedCount,
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
      strategyVersion:
        AUTOPILOT_STRATEGY === "etf_rotation"
          ? ETF_ROTATION_STRATEGY_VERSION
          : STRATEGY_VERSION,
      strategyConfigHash:
        AUTOPILOT_STRATEGY === "etf_rotation"
          ? ETF_ROTATION_STRATEGY_CONFIG_HASH
          : STRATEGY_CONFIG_HASH,
      strategyConfig: (AUTOPILOT_STRATEGY === "etf_rotation"
        ? ETF_ROTATION_ACTIVE_CONFIG
        : DEFAULT_STRATEGY_CONFIG) as unknown as Record<string, unknown>,
      running,
      intervalMs: AUTOPILOT_INTERVAL_MS,
      tickers:
        AUTOPILOT_STRATEGY === "etf_rotation"
          ? ETF_ROTATION_ACTIVE_CONFIG.universe
          : AUTOPILOT_TICKERS,
      minConfidence: AUTOPILOT_MIN_CONFIDENCE,
      maxSellFraction: clampFraction(AUTOPILOT_MAX_SELL_FRACTION),
      blockSellBelowAverageEntry: AUTOPILOT_BLOCK_SELL_BELOW_AVG,
      telegramCooldownMinutes: AUTOPILOT_TELEGRAM_COOLDOWN_MINUTES,
      lastJournalRunId,
      lastRunAt,
      lastError,
      lastDecisions,
      circuitBreaker: lastCircuitBreakerState,
      circuitBreakerMaxDrawdownFromPeakPercent: getMaxDrawdownFromPeakPercent(),
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
