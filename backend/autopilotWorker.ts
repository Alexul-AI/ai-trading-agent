// See docs/ops/AUTOPILOT_WORKER_MAP.md for a structural map of this file
// (block/dependency/side-effect breakdown, baseline-vs-ETF-Rotation-path
// separation) - kept there rather than as a giant comment here so it stays
// easier to keep in sync as the file changes.
import { randomUUID } from "crypto";
import { DEFAULT_STRATEGY_CONFIG } from "./strategyEngine.js";
import {
  appendAutopilotRun,
  createStrategyConfigHash,
} from "./decisionJournal.js";
import {
  ETF_ROTATION_CONFIG_VARIANTS,
  resolveEtfRotationConfigVariant,
  type EtfRotationConfig,
} from "./etfRotationStrategy.js";
import { resolveRampMaxPositionEquityPercent } from "./etfRotationExecution.js";
import {
  runEtfRotationCycle,
  mapExecuteSafeTradeResultToLegOutcome,
  mapEtfRotationExecutionStatusToRebalanceStatus,
} from "./etfRotationCycle.js";
import {
  analyzeTicker,
  evaluateSentimentVeto,
  evaluateInsiderVeto,
} from "./analyzeTicker.js";

export {
  mapExecuteSafeTradeResultToLegOutcome,
  mapEtfRotationExecutionStatusToRebalanceStatus,
  evaluateSentimentVeto,
  evaluateInsiderVeto,
};
import {
  updatePortfolioCircuitBreaker,
  getMaxDrawdownFromPeakPercent,
  shouldSendDailyReminder,
  recordReminderSent,
  type CircuitBreakerState,
} from "./portfolioCircuitBreaker.js";
import { appendCircuitBreakerAuditEvent } from "./circuitBreakerAuditLog.js";
import {
  computeBucketRegimeByDate,
  type RegimeBucketConfig,
  type RegimeState,
} from "./src/strategy/portfolioRegimeFilter.js";
import { releaseWorkerLock, tryClaimWorkerLock } from "./autopilotWorkerLock.js";
import {
  AUTOPILOT_MAX_SELL_FRACTION,
  clampFraction,
  getSafeBuyNotionalForBucketCap,
  getSafeBuySharesForBucketCap,
  getSafeSellShares,
  type PortfolioPositionSnapshot,
  type PortfolioSnapshot,
} from "./src/strategy/portfolioSafety.js";
import { fetchAlpacaDailyBarsPaginated } from "./src/market/alpacaBarsFetch.js";

export {
  getSafeBuyNotionalForBucketCap,
  getSafeBuySharesForBucketCap,
  getSafeSellShares,
};
export type { PortfolioPositionSnapshot, PortfolioSnapshot };

// Types live in src/types/autopilotTypes.ts (extracted, same "pure move,
// re-exported" pattern as src/strategy/portfolioSafety.ts) - see
// docs/ops/AUTOPILOT_WORKER_MAP.md for the full structural map.
import type {
  AlpacaBar,
  AutopilotDecisionLog,
  AutopilotStatus,
  AutopilotStrategyKind,
  AutopilotWorkerOptions,
  BlockReasonCategory,
  DecisionFinalStatus,
  ExecuteSafeTrade,
  ExecuteSafeTradeResult,
  ExecutionBlockReasonCategory,
  ExecutionStatus,
  InsiderCacheEntry,
  SentimentCacheEntry,
  SentimentVetoResult,
  SignalStatus,
} from "./src/types/autopilotTypes.js";

export type {
  AutopilotDecisionLog,
  AutopilotStatus,
  AutopilotStrategyKind,
  AutopilotWorkerOptions,
  BlockReasonCategory,
  DecisionFinalStatus,
  ExecuteSafeTrade,
  ExecuteSafeTradeResult,
  ExecutionBlockReasonCategory,
  ExecutionStatus,
  SentimentVetoResult,
  SignalStatus,
};

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

// Fails loud at process startup on a bad value (see
// resolveRampMaxPositionEquityPercent's own doc comment) - unset stays
// uncapped (current, unchanged behavior); this is the paper-execution ramp
// gate for the first real BUYs, a sibling of AUTOPILOT_ALLOW_BUY/SELL, not
// a strategy config.
const AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT =
  resolveRampMaxPositionEquityPercent(
    process.env.AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT,
  );


function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
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

  return fetchAlpacaDailyBarsPaginated({
    ticker,
    startDate,
    endDate,
    feed: ALPACA_DATA_FEED,
    keyId: APCA_API_KEY_ID,
    secretKey: APCA_API_SECRET_KEY,
    errorLabel: "Alpaca bars",
  });
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
      options.testDataFilePaths?.lockFilePath,
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
        options.testDataFilePaths?.circuitBreakerStateFilePath,
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

        await appendCircuitBreakerAuditEvent(
          {
            type: "CIRCUIT_BREAKER_TRIPPED",
            timestamp: circuitBreakerUpdate.state.trippedAt ?? new Date().toISOString(),
            equity: portfolio.equity,
            peakEquity: circuitBreakerUpdate.state.peakEquity,
            drawdownPercent: circuitBreakerDrawdownPercent,
            thresholdPercent: getMaxDrawdownFromPeakPercent() * 100,
          },
          options.testDataFilePaths?.circuitBreakerAuditLogFilePath,
        );
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
        decisions = await runEtfRotationCycle({
          portfolio,
          config: ETF_ROTATION_ACTIVE_CONFIG,
          configVariantKey: ETF_ROTATION_CONFIG_VARIANT_KEY,
          barsDays: AUTOPILOT_ETF_ROTATION_BARS_DAYS,
          warmupTradingDays: ETF_ROTATION_WARMUP_TRADING_DAYS,
          executionGates: {
            executeTradesEnabled: AUTOPILOT_EXECUTE_TRADES,
            allowBuy: AUTOPILOT_ALLOW_BUY,
            allowSell: AUTOPILOT_ALLOW_SELL,
            rampMaxPositionEquityPercent: AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT,
          },
          fetchBars: fetchAlpacaBars,
          broadcastSSE: options.broadcastSSE,
          sendTelegramAlert: options.sendTelegramAlert,
          executeSafeTrade: options.executeSafeTrade,
          getPortfolioSnapshot: options.getPortfolioSnapshot,
          etfRotationStateFilePath: options.testDataFilePaths?.etfRotationStateFilePath,
          etfRotationOrderAuditLogFilePath:
            options.testDataFilePaths?.etfRotationOrderAuditLogFilePath,
        });

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
              const decision = await analyzeTicker({
                ticker,
                portfolio,
                circuitBreakerState: circuitBreakerUpdate.state,
                regimeByBucketByDate,
                tradeMode: options.tradeMode,
                minConfidence: AUTOPILOT_MIN_CONFIDENCE,
                cooldownMinutes: AUTOPILOT_COOLDOWN_MINUTES,
                allowFractionalShares: AUTOPILOT_ALLOW_FRACTIONAL_SHARES_ENABLED,
                blockSellBelowAverageEntry: AUTOPILOT_BLOCK_SELL_BELOW_AVG,
                regimeFilterEnabled: AUTOPILOT_REGIME_FILTER_ENABLED,
                regimeBuckets: REGIME_BUCKETS,
                tickerToBucket: TICKER_TO_BUCKET,
                maxBucketEquityFraction: AUTOPILOT_MAX_BUCKET_EQUITY_FRACTION,
                bucketEquityFractionOverrides: BUCKET_EQUITY_FRACTION_OVERRIDES,
                sentimentFilterEnabled: AUTOPILOT_SENTIMENT_FILTER_ENABLED,
                insiderFilterEnabled: AUTOPILOT_INSIDER_FILTER_ENABLED,
                executionGates: {
                  executeTradesEnabled: AUTOPILOT_EXECUTE_TRADES,
                  allowBuy: AUTOPILOT_ALLOW_BUY,
                  allowSell: AUTOPILOT_ALLOW_SELL,
                },
                barsDays: AUTOPILOT_BARS_DAYS,
                fetchBars: fetchAlpacaBars,
                executeSafeTrade: options.executeSafeTrade,
                lastBuyAtByTicker,
                entryAtrPercentByTicker,
              });

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

        await appendCircuitBreakerAuditEvent(
          {
            type: "CIRCUIT_BREAKER_REMINDER_SENT",
            timestamp: lastRunAt,
            equity: portfolio.equity,
            peakEquity: circuitBreakerUpdate.state.peakEquity,
            drawdownPercent: circuitBreakerDrawdownPercent,
            thresholdPercent: getMaxDrawdownFromPeakPercent() * 100,
          },
          options.testDataFilePaths?.circuitBreakerAuditLogFilePath,
        );

        await recordReminderSent(
          todayDateKey,
          options.testDataFilePaths?.circuitBreakerStateFilePath,
        );
      }

      try {
        const journalRun = await appendAutopilotRun(
          {
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
          },
          options.testDataFilePaths?.journalFilePath,
        );

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

  // Graceful-shutdown-only lock release (server.ts's SIGTERM/SIGINT
  // handler) - deliberately not folded into stop() above, since stop()
  // pausing the scheduler doesn't mean the process itself is dying (e.g. a
  // future "fully halt the worker" admin action); releasing the lock while
  // the process stays alive would let a different process claim it out
  // from under this one. Uses a bounded poll rather than a single
  // instantaneous check: with real cycles observed taking ~1.6-2s, a
  // one-shot check-and-exit would cut an in-flight cycle off sooner than
  // Render's own SIGKILL-after-grace-period would have - actually worse
  // than doing nothing. Waiting out a short in-flight cycle first, then
  // releasing, converts the common "redeploy lands mid-cycle" case into a
  // clean release instead of a 3-hour-stale-lock wait for the next
  // process. Falls back to leaving the lock for the staleness window
  // (autopilotWorkerLock.ts) only if the cycle is still running once the
  // bound elapses.
  async function releaseLockOnShutdown(): Promise<void> {
    if (running) {
      const pollIntervalMs = 250;
      const deadline = Date.now() + 8000;
      while (running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    }

    if (running) {
      console.warn(
        "[AUTOPILOT] Shutdown: cycle still in flight after the wait window - leaving the lock for the staleness fallback.",
      );
      return;
    }

    await releaseWorkerLock(WORKER_OWNER_ID, options.testDataFilePaths?.lockFilePath);
    console.log("[AUTOPILOT] Shutdown: worker lock released.");
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
    releaseLockOnShutdown,
  };
}
