import { promises as fs } from "fs";
import path from "path";
import dotenv from "dotenv";

import {
  calculateATR,
  calculateBollingerBands,
  calculateMACD,
  calculateRSI,
} from "./indicators.js";
import {
  DEFAULT_STRATEGY_CONFIG,
  decideTradeSignal,
  type StrategyReasonType,
} from "./strategyEngine.js";
import {
  getRemainingBucketCapacity,
  getSafeBuySharesForBucketCap,
  getSafeSellShares,
  type PortfolioSnapshot,
} from "./src/strategy/portfolioSafety.js";
import {
  applyStickyTrip,
  evaluatePortfolioDrawdown,
  getMaxDrawdownFromPeakPercent,
} from "./portfolioCircuitBreaker.js";
import { evaluateTrade, type AccountState, type RiskProfile } from "./riskManager.js";
import { createStrategyConfigHash } from "./decisionJournal.js";

dotenv.config();

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

const APCA_API_KEY_ID = process.env.APCA_API_KEY_ID ?? "";
const APCA_API_SECRET_KEY = process.env.APCA_API_SECRET_KEY ?? "";

if (!APCA_API_KEY_ID || !APCA_API_SECRET_KEY) {
  console.error(
    "Missing APCA_API_KEY_ID or APCA_API_SECRET_KEY in backend/.env",
  );
  process.exit(1);
}

const TICKERS = (
  process.env.BACKTEST_TICKERS ||
  "AMD,NVDA,AAPL,MSFT,TSLA,JPM,JNJ,XOM,PG,SPY,GLD,TLT,EFA"
)
  .split(",")
  .map((t) => t.trim().toUpperCase())
  .filter(Boolean);

// Must stay identical to autopilotWorker.ts's TICKER_TO_BUCKET /
// BUCKET_EQUITY_FRACTION_OVERRIDES - data duplicated here (not imported),
// same convention as TICKER_TO_REGIME_BUCKET in backtest-sweep.ts. The
// *logic* that uses this data (getSafeBuySharesForBucketCap) is imported
// for real, not duplicated - only this flat mapping is copied.
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

const AUTOPILOT_MAX_BUCKET_EQUITY_FRACTION = Number.parseFloat(
  process.env.AUTOPILOT_MAX_BUCKET_EQUITY_FRACTION || "0.4",
);
const BUCKET_EQUITY_FRACTION_OVERRIDES: Record<string, number> = {
  high_beta_growth: Number.parseFloat(
    process.env.AUTOPILOT_HIGH_BETA_BUCKET_EQUITY_FRACTION || "0.2",
  ),
};

const DAYS = Number.parseInt(process.env.BACKTEST_DAYS || "365", 10);
const STARTING_CAPITAL = Number.parseFloat(
  process.env.BACKTEST_STARTING_CAPITAL || "10000",
);
const FEED = process.env.ALPACA_DATA_FEED || "iex";
const SLIPPAGE_PERCENT = 0.0005;
const COMMISSION_PER_TRADE = 0;

// RSI (Wilder smoothing) and MACD (EMA) are seeded from bars[0] and only
// converge to accurate values after ~100+ bars - matches backtest-sweep.ts.
const WARMUP_BARS = 210;

// Lets a run end on a historical date instead of always "today" - same
// convention as backtest-sweep.ts.
const END_DAYS_AGO = Number.parseInt(
  process.env.BACKTEST_END_DAYS_AGO || "0",
  10,
);

// Full-system config, matching what's actually shipped live today
// (default RiskProfile in riskManager.ts). Variants B/C swap in a version
// of this with maxDailyDrawdownPercent forced to -1 (never triggers) to
// isolate the effect of the -5% daily kill switch specifically, while
// still keeping the cash-sufficiency/position-cap checks evaluateTrade
// also performs (skipping it entirely could let the sim spend more cash
// than it has).
const FULL_RISK_PROFILE: RiskProfile = {
  maxDailyDrawdownPercent: -0.05,
  maxPositionSizePercent: 0.2,
  allowMargin: false,
};
const NO_DAILY_KILL_RISK_PROFILE: RiskProfile = {
  ...FULL_RISK_PROFILE,
  maxDailyDrawdownPercent: -1,
};

const REPORT_DIR = path.resolve(process.cwd(), "data", "backtest-reports");

type ExecutionModel = "close_to_close" | "next_open";

function toIsoDate(date: Date): string {
  return date.toISOString().split("T")[0] ?? date.toISOString();
}

function dateKeyOf(bar: AlpacaBar): string {
  return bar.t.split("T")[0] ?? bar.t;
}

async function fetchAlpacaBars(
  ticker: string,
  days: number,
): Promise<AlpacaBar[]> {
  const endDate = new Date();
  endDate.setDate(endDate.getDate() - END_DAYS_AGO);
  const startDate = new Date(endDate);
  startDate.setDate(endDate.getDate() - days);

  const allBars: AlpacaBar[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`https://data.alpaca.markets/v2/stocks/${ticker}/bars`);
    url.searchParams.set("timeframe", "1Day");
    url.searchParams.set("start", toIsoDate(startDate));
    url.searchParams.set("end", toIsoDate(endDate));
    url.searchParams.set("adjustment", "raw");
    url.searchParams.set("feed", FEED);
    url.searchParams.set("limit", "1000");
    if (pageToken) url.searchParams.set("page_token", pageToken);

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
    if (data.bars) allBars.push(...data.bars);
    pageToken = data.next_page_token || undefined;
  } while (pageToken);

  return allBars.sort(
    (a, b) => new Date(a.t).getTime() - new Date(b.t).getTime(),
  );
}

// --- Date alignment: intersection of trading dates, per-ticker index lookup ---
//
// Each ticker's own bars[] array is kept untouched - indicators are always
// computed from a ticker's own full history, sliced by that ticker's own
// index. The intersection is only used to pick which dates the day-loop
// below visits. Slicing/rebuilding a shared array to the intersection
// would silently corrupt Wilder-smoothed indicators for tickers that had
// no gap of their own, by feeding them a gapped series. Since every date
// visited is in the intersection, every ticker is guaranteed to have a
// bar (hence both a valid open and close) on every date the loop visits.

interface Alignment {
  commonDates: string[];
  indexByTickerByDate: Map<string, Map<string, number>>;
}

function alignByIntersection(
  barsByTicker: Map<string, AlpacaBar[]>,
  tickers: string[],
): Alignment {
  const indexByTickerByDate = new Map<string, Map<string, number>>();

  for (const ticker of tickers) {
    const bars = barsByTicker.get(ticker) ?? [];
    const indexByDate = new Map<string, number>();
    bars.forEach((bar, i) => indexByDate.set(dateKeyOf(bar), i));
    indexByTickerByDate.set(ticker, indexByDate);
  }

  const unionDates = new Set<string>();
  for (const indexByDate of indexByTickerByDate.values()) {
    for (const date of indexByDate.keys()) unionDates.add(date);
  }

  const missingCountByTicker = new Map<string, number>(
    tickers.map((t) => [t, 0]),
  );
  const commonDates: string[] = [];

  for (const date of unionDates) {
    const missingTickers = tickers.filter(
      (t) => !indexByTickerByDate.get(t)!.has(date),
    );

    if (missingTickers.length === 0) {
      commonDates.push(date);
    } else {
      for (const ticker of missingTickers) {
        missingCountByTicker.set(
          ticker,
          (missingCountByTicker.get(ticker) ?? 0) + 1,
        );
      }
    }
  }

  commonDates.sort();

  const totalDropped = unionDates.size - commonDates.length;
  if (totalDropped > 0) {
    console.log(
      `Date alignment: ${totalDropped} of ${unionDates.size} union dates dropped (not present for every ticker).`,
    );
    for (const [ticker, count] of missingCountByTicker) {
      if (count > 0) console.log(`  ${ticker}: missing on ${count} dates`);
    }
    console.log("");
  }

  return { commonDates, indexByTickerByDate };
}

function findSimStartIndex(
  commonDates: string[],
  indexByTickerByDate: Map<string, Map<string, number>>,
  tickers: string[],
): number {
  for (let d = 0; d < commonDates.length; d += 1) {
    const date = commonDates[d]!;
    const allWarm = tickers.every(
      (t) => (indexByTickerByDate.get(t)!.get(date) ?? -1) >= WARMUP_BARS,
    );
    if (allWarm) return d;
  }
  return commonDates.length;
}

// --- Portfolio-level day-loop simulation ---

interface SimVariantConfig {
  label: string;
  useBucketCap: boolean;
  useCircuitBreaker: boolean;
  useDailyKillAndSellThrottle: boolean;
}

const VARIANTS: SimVariantConfig[] = [
  {
    label: "A: no bucket cap, no circuit breaker, no daily kill/sell throttle",
    useBucketCap: false,
    useCircuitBreaker: false,
    useDailyKillAndSellThrottle: false,
  },
  {
    label: "B: bucket cap only",
    useBucketCap: true,
    useCircuitBreaker: false,
    useDailyKillAndSellThrottle: false,
  },
  {
    label: "C: bucket cap + circuit breaker",
    useBucketCap: true,
    useCircuitBreaker: true,
    useDailyKillAndSellThrottle: false,
  },
  {
    label: "D: full system (+ daily kill switch + sell throttle) - matches live",
    useBucketCap: true,
    useCircuitBreaker: true,
    useDailyKillAndSellThrottle: true,
  },
];

// Only matters for variant D under next_open - C never trips in any
// observed run (it matches B exactly in every result so far), and
// close_to_close's breaker never trips either. Running these against a
// breaker that never fires would just reproduce D0's number five times.
interface CircuitBreakerPolicy {
  label: string;
  /** D2: reset N trading days after the trip, regardless of recovery. */
  resetAfterTradingDays?: number;
  /** D3: reset once drawdown-from-peak improves above this (less negative) threshold, e.g. -0.10. */
  resetOnRecoveryFromPeakPercent?: number;
}

const DEFAULT_CIRCUIT_BREAKER_POLICY: CircuitBreakerPolicy = {
  label: "D0: sticky, no reset (current)",
};

const CIRCUIT_BREAKER_POLICIES: CircuitBreakerPolicy[] = [
  DEFAULT_CIRCUIT_BREAKER_POLICY,
  { label: "D2: reset 1 trading day after trip", resetAfterTradingDays: 1 },
  { label: "D2: reset 3 trading days after trip", resetAfterTradingDays: 3 },
  { label: "D2: reset 5 trading days after trip", resetAfterTradingDays: 5 },
  { label: "D2: reset 10 trading days after trip", resetAfterTradingDays: 10 },
  {
    label: "D3: reset once drawdown recovers above -10% from peak",
    resetOnRecoveryFromPeakPercent: -0.1,
  },
];

interface TickerState {
  shares: number;
  averageEntryPrice: number;
  entryAtrPercent: number;
  lastBuyOwnIndex: number;
  lastStopLossOwnIndex: number;
}

interface TradeLogEntry {
  date: string;
  signalDate: string;
  ticker: string;
  action: "BUY" | "SELL";
  shares: number;
  price: number;
  signalPrice: number;
  notional: number;
  reasonType: StrategyReasonType;
  equityAfter: number;
  cashAfter: number;
  realizedPnl?: number;
}

interface BlockedSignalEntry {
  date: string;
  ticker: string;
  action: "BUY";
  blockReason: "bucket_cap" | "circuit_breaker" | "execution_time";
  bucket: string | undefined;
  currentBucketExposure: number;
  price: number;
}

interface EquityCurvePoint {
  date: string;
  equity: number;
  cash: number;
  exposurePercent: number;
  drawdownPercent: number;
}

interface PerTickerSummary {
  trades: number;
  finalShares: number;
  realizedPnl: number;
}

interface UnexecutedPendingOrder {
  ticker: string;
  action: "BUY" | "SELL";
  shares: number;
  reasonType: StrategyReasonType;
  signalDate: string;
}

interface PortfolioSimResult {
  finalEquity: number;
  totalPnlPercent: number;
  maxDrawdownPercent: number;
  avgExposurePercent: number;
  circuitBreakerTrippedAt: string | null;
  daysTrippedCount: number;
  /** Times the circuit breaker was reset (D0's policy never resets, so this stays 0 there). */
  resetCount: number;
  resetEvents: { date: string; reason: "recovery" | "day_limit" }[];
  totalSimDays: number;
  /** Times the bucket cap reduced a BUY request, partially OR all the way to 0 shares. */
  bucketCapReductionCount: number;
  /** Subset of bucketCapReductionCount that was reduced all the way to 0 shares (fully blocked, not just shrunk). */
  bucketCapFullyBlockedCount: number;
  circuitBreakerBlockedBuyCount: number;
  executionTimeReductionCount: number;
  executionTimeRejectionCount: number;
  /** BUY signals that executed literally 0 shares, for ANY reason (bucket cap, circuit breaker, or execution-time rejection) - not the same number as bucketCapReductionCount, which also counts partial reductions. */
  blockedBuyCount: number;
  totalTrades: number;
  trades: TradeLogEntry[];
  perTicker: Map<string, PerTickerSummary>;
  equityCurve: EquityCurvePoint[];
  blockedSignals: BlockedSignalEntry[];
  /** Orders staged on the last simulated day (next_open only) that never got a following day to execute on - logged, not silently dropped. */
  unexecutedPendingOrders: UnexecutedPendingOrder[];
}

interface StagedDecision {
  ticker: string;
  action: "BUY" | "SELL";
  shares: number;
  reasonType: StrategyReasonType;
  /** The day the signal was generated - always the execution day under close_to_close, may be one day earlier under next_open. */
  signalDate: string;
  /** Signal-day close price - diagnostic/ATR-weighting basis only. NOT the fill basis (see executeStagedOrders, which looks up a fresh execution-day price). */
  price: number;
  atrPercent: number;
}

function runPortfolioSimulation(
  barsByTicker: Map<string, AlpacaBar[]>,
  tickers: string[],
  commonDates: string[],
  indexByTickerByDate: Map<string, Map<string, number>>,
  simStartIndex: number,
  variant: SimVariantConfig,
  executionModel: ExecutionModel,
  circuitBreakerPolicy: CircuitBreakerPolicy = DEFAULT_CIRCUIT_BREAKER_POLICY,
): PortfolioSimResult {
  let cash = STARTING_CAPITAL;
  const stateByTicker = new Map<string, TickerState>(
    tickers.map((t) => [
      t,
      {
        shares: 0,
        averageEntryPrice: 0,
        entryAtrPercent: 0,
        lastBuyOwnIndex: -999,
        lastStopLossOwnIndex: -999,
      },
    ]),
  );

  const trades: TradeLogEntry[] = [];
  const blockedSignals: BlockedSignalEntry[] = [];
  const equityCurve: EquityCurvePoint[] = [];
  const perTicker = new Map<string, PerTickerSummary>(
    tickers.map((t) => [t, { trades: 0, finalShares: 0, realizedPnl: 0 }]),
  );

  let peakEquity = 0;
  let previousDayEquity = 0;
  let circuitBreakerTripped = false;
  let circuitBreakerTrippedAt: string | null = null;
  let daysTrippedCount = 0;
  let daysSinceTripped = 0;
  let resetCount = 0;
  const resetEvents: { date: string; reason: "recovery" | "day_limit" }[] = [];
  let bucketCapReductionCount = 0;
  let circuitBreakerBlockedBuyCount = 0;
  let executionTimeReductionCount = 0;
  let executionTimeRejectionCount = 0;
  let finalEquity = STARTING_CAPITAL;
  let maxDrawdown = 0;
  let runningPeakForDrawdown = 0;
  let exposureSum = 0;
  let pendingOrders: StagedDecision[] = [];

  const maxDrawdownFromPeakPercent = getMaxDrawdownFromPeakPercent();
  const riskProfile = variant.useDailyKillAndSellThrottle
    ? FULL_RISK_PROFILE
    : NO_DAILY_KILL_RISK_PROFILE;

  function priceOf(
    ticker: string,
    date: string,
    field: "o" | "c" = "c",
  ): number | null {
    const idx = indexByTickerByDate.get(ticker)!.get(date);
    if (idx === undefined) return null;
    const bar = barsByTicker.get(ticker)![idx];
    return bar ? Number(bar[field].toFixed(2)) : null;
  }

  function computeEquity(prices: Map<string, number>): number {
    let total = cash;
    for (const ticker of tickers) {
      const state = stateByTicker.get(ticker)!;
      if (state.shares <= 0) continue;
      const price = prices.get(ticker) ?? state.averageEntryPrice;
      total += state.shares * price;
    }
    return total;
  }

  // Executes a batch of staged orders against a price map built fresh from
  // executionDate + priceSource - NEVER the day-loop's outer close-price
  // map. This is what actually removes the look-ahead: under next_open,
  // this runs at the top of the FOLLOWING iteration using that day's open,
  // so every equity mark computed in here (position values, the daily
  // drawdown check, equityAfter logging) reflects only prices knowable at
  // that moment, not the eventual close of the day the order fills on.
  // Does its own sells-before-buys partition internally so every caller
  // gets the same ordering guarantee for free.
  function executeStagedOrders(
    items: StagedDecision[],
    executionDate: string,
    priceSource: "open" | "close",
  ): void {
    if (items.length === 0) return;

    const execPrices = new Map<string, number>();
    for (const ticker of tickers) {
      const p = priceOf(ticker, executionDate, priceSource === "open" ? "o" : "c");
      if (p !== null) execPrices.set(ticker, p);
    }

    const orderedItems = [
      ...items.filter((s) => s.action === "SELL"),
      ...items.filter((s) => s.action === "BUY"),
    ];

    for (const item of orderedItems) {
      const state = stateByTicker.get(item.ticker)!;
      const basisPrice = execPrices.get(item.ticker);
      if (basisPrice === undefined) continue; // defensive - shouldn't happen, commonDates is an intersection

      const currentPositions = tickers
        .filter((t) => stateByTicker.get(t)!.shares > 0)
        .map((t) => {
          const s = stateByTicker.get(t)!;
          const p = execPrices.get(t) ?? s.averageEntryPrice;
          return { ticker: t, shares: s.shares, marketValue: s.shares * p };
        });
      const currentEquityNow =
        cash + currentPositions.reduce((sum, p) => sum + p.marketValue, 0);
      const dailyDrawdownNow =
        previousDayEquity > 0
          ? (currentEquityNow - previousDayEquity) / previousDayEquity
          : 0;

      const accountState: AccountState = {
        equity: currentEquityNow,
        cash,
        dailyDrawdownPercent: dailyDrawdownNow,
        currentPositions,
      };

      const executionPrice =
        item.action === "BUY"
          ? Number((basisPrice * (1 + SLIPPAGE_PERCENT)).toFixed(4))
          : Number((basisPrice * (1 - SLIPPAGE_PERCENT)).toFixed(4));

      const riskResult = evaluateTrade(
        {
          ticker: item.ticker,
          action: item.action,
          requestedShares: item.shares,
          estimatedPrice: executionPrice,
        },
        accountState,
        riskProfile,
      );

      if (!riskResult.approved) {
        executionTimeRejectionCount += 1;
        if (item.action === "BUY") {
          const bucketId = TICKER_TO_BUCKET[item.ticker.toUpperCase()];
          blockedSignals.push({
            date: item.signalDate,
            ticker: item.ticker,
            action: "BUY",
            blockReason: "execution_time",
            bucket: bucketId,
            currentBucketExposure: 0,
            price: item.price,
          });
        }
        continue;
      }

      const finalShares = riskResult.adjustedShares;
      if (finalShares < item.shares) executionTimeReductionCount += 1;
      if (finalShares <= 0) continue;

      if (item.action === "BUY") {
        const cost = executionPrice * finalShares + COMMISSION_PER_TRADE;
        const previousPositionCost = state.averageEntryPrice * state.shares;
        const previousAtrWeight = state.entryAtrPercent * previousPositionCost;
        const newBuyCost = executionPrice * finalShares;

        cash -= cost;
        state.shares += finalShares;
        state.averageEntryPrice =
          state.shares > 0
            ? (previousPositionCost + newBuyCost) / state.shares
            : 0;
        state.entryAtrPercent =
          state.shares > 0
            ? (previousAtrWeight + item.atrPercent * newBuyCost) /
              (previousPositionCost + newBuyCost)
            : 0;
        state.lastBuyOwnIndex = indexByTickerByDate
          .get(item.ticker)!
          .get(executionDate)!;

        perTicker.get(item.ticker)!.trades += 1;
        trades.push({
          date: executionDate,
          signalDate: item.signalDate,
          ticker: item.ticker,
          action: "BUY",
          shares: finalShares,
          price: executionPrice,
          signalPrice: item.price,
          notional: newBuyCost,
          reasonType: item.reasonType,
          equityAfter: computeEquity(execPrices),
          cashAfter: cash,
        });
      } else {
        const sharesToSell = Math.min(finalShares, state.shares);
        const revenue = executionPrice * sharesToSell - COMMISSION_PER_TRADE;
        const realizedPnl =
          (executionPrice - state.averageEntryPrice) * sharesToSell -
          COMMISSION_PER_TRADE;

        cash += revenue;
        state.shares -= sharesToSell;
        perTicker.get(item.ticker)!.realizedPnl += realizedPnl;
        perTicker.get(item.ticker)!.trades += 1;

        if (state.shares === 0) {
          state.averageEntryPrice = 0;
          state.entryAtrPercent = 0;
        }
        if (item.reasonType === "STOP_LOSS") {
          state.lastStopLossOwnIndex = indexByTickerByDate
            .get(item.ticker)!
            .get(executionDate)!;
        }

        trades.push({
          date: executionDate,
          signalDate: item.signalDate,
          ticker: item.ticker,
          action: "SELL",
          shares: sharesToSell,
          price: executionPrice,
          signalPrice: item.price,
          notional: sharesToSell * executionPrice,
          reasonType: item.reasonType,
          equityAfter: computeEquity(execPrices),
          cashAfter: cash,
          realizedPnl,
        });
      }
    }
  }

  for (let d = simStartIndex; d < commonDates.length; d += 1) {
    const date = commonDates[d]!;

    // Under next_open, this morning's fill of yesterday's signals happens
    // FIRST, at today's open - before today's own circuit-breaker check
    // and sizing pass, so sizing reflects cash/positions as they actually
    // are by the time today's close is observed (not stale pre-fill state).
    if (executionModel === "next_open" && pendingOrders.length > 0) {
      executeStagedOrders(pendingOrders, date, "open");
      pendingOrders = [];
    }

    const closePricesToday = new Map<string, number>();
    for (const ticker of tickers) {
      const p = priceOf(ticker, date, "c");
      if (p !== null) closePricesToday.set(ticker, p);
    }

    // Mark-to-market at today's close, reflecting this morning's fill (if
    // any). Under next_open this is "start of sizing, after this
    // morning's lagged fill" rather than pristine pre-market state.
    const preSizingEquity = computeEquity(closePricesToday);
    if (preSizingEquity > peakEquity) peakEquity = preSizingEquity;

    // Intervention research only (default policy never resets, matching
    // live's actual sticky/no-auto-recovery design exactly). When a reset
    // condition fires, rebase peakEquity to *now* - matching live's real
    // resetPortfolioCircuitBreaker(currentEquity), which rebases to the
    // equity at reset time, not the original pre-trip peak. A naive
    // "just clear the tripped flag" without rebasing would immediately
    // re-trip on the very next evaluation in most realistic cases.
    if (variant.useCircuitBreaker && circuitBreakerTripped) {
      daysSinceTripped += 1;

      const recovered =
        circuitBreakerPolicy.resetOnRecoveryFromPeakPercent !== undefined &&
        !evaluatePortfolioDrawdown(
          preSizingEquity,
          peakEquity,
          circuitBreakerPolicy.resetOnRecoveryFromPeakPercent,
        ).tripped;
      const dayLimitReached =
        circuitBreakerPolicy.resetAfterTradingDays !== undefined &&
        daysSinceTripped >= circuitBreakerPolicy.resetAfterTradingDays;

      if (recovered || dayLimitReached) {
        circuitBreakerTripped = false;
        peakEquity = preSizingEquity;
        daysSinceTripped = 0;
        resetCount += 1;
        resetEvents.push({
          date,
          reason: recovered ? "recovery" : "day_limit",
        });
      }
    }

    // Sticky - mirrors updatePortfolioCircuitBreaker's applyStickyTrip
    // (never auto-recovers without a human reset in live, i.e. without a
    // reset condition firing above). Skipped entirely when this variant
    // doesn't model the circuit breaker. Reading circuitBreakerTripped's
    // carried-over value here (before this iteration updates it) is
    // already the correct "most recently known" gate for this morning's
    // pending BUYs too - no separate re-check needed for the trip flag
    // itself. A reset above doesn't grant immunity - this evaluation can
    // re-trip immediately if still warranted, which is useful information
    // (resetCount captures how often that happens).
    if (variant.useCircuitBreaker && !circuitBreakerTripped) {
      const evaluation = evaluatePortfolioDrawdown(
        preSizingEquity,
        peakEquity,
        maxDrawdownFromPeakPercent,
      );
      circuitBreakerTripped = applyStickyTrip(
        evaluation.tripped,
        circuitBreakerTripped,
      );
      if (circuitBreakerTripped) circuitBreakerTrippedAt = date;
    }
    if (circuitBreakerTripped) daysTrippedCount += 1;

    // --- SIZING pass: every ticker reads the same frozen snapshot ---
    const sizingSnapshot: PortfolioSnapshot = {
      balance: cash,
      equity: preSizingEquity,
      currency: "USD",
      positions: Object.fromEntries(
        tickers
          .filter((t) => stateByTicker.get(t)!.shares > 0)
          .map((t) => {
            const state = stateByTicker.get(t)!;
            const price = closePricesToday.get(t) ?? state.averageEntryPrice;
            return [
              t,
              {
                shares: state.shares,
                avgPrice: state.averageEntryPrice,
                currentPrice: price,
                pnl: 0,
                pnlPercent: 0,
              },
            ];
          }),
      ),
    };

    const staged: StagedDecision[] = [];

    for (const ticker of tickers) {
      const price = closePricesToday.get(ticker);
      if (price === undefined) continue;

      const ownIndex = indexByTickerByDate.get(ticker)!.get(date)!;
      const bars = barsByTicker.get(ticker)!;
      const state = stateByTicker.get(ticker)!;

      const priceSeries = bars.slice(0, ownIndex + 1).map((b) => b.c);
      const previousPriceSeries = bars.slice(0, ownIndex).map((b) => b.c);
      const rsi = calculateRSI(priceSeries, 14);
      const macd = calculateMACD(priceSeries);
      const previousMacd = calculateMACD(previousPriceSeries);
      const bb = calculateBollingerBands(priceSeries, 20, 2);
      const atr = calculateATR(bars.slice(0, ownIndex + 1), 14);
      const atrPercent = price > 0 ? atr / price : 0;

      const decision = decideTradeSignal({
        ticker,
        price,
        cash: sizingSnapshot.balance,
        portfolioValue: sizingSnapshot.equity,
        sharesOwned: state.shares,
        averageEntryPrice: state.averageEntryPrice,
        rsi,
        macdHistogram: macd.histogram,
        previousMacdHistogram: previousMacd.histogram,
        bollingerLower: bb.lower,
        bollingerUpper: bb.upper,
        barsSinceLastBuy: ownIndex - state.lastBuyOwnIndex,
        entryAtrPercent: state.entryAtrPercent,
        config: DEFAULT_STRATEGY_CONFIG,
      });

      if (decision.action === "SELL" && decision.suggestedShares > 0) {
        const safeShares = variant.useDailyKillAndSellThrottle
          ? getSafeSellShares(decision.reasonType, decision.suggestedShares, state.shares).shares
          : Math.min(decision.suggestedShares, state.shares);

        if (safeShares > 0) {
          staged.push({
            ticker,
            action: "SELL",
            shares: safeShares,
            reasonType: decision.reasonType,
            signalDate: date,
            price,
            atrPercent,
          });
        }
      } else if (decision.action === "BUY" && decision.suggestedShares > 0) {
        const bucketId = TICKER_TO_BUCKET[ticker.toUpperCase()];
        const bucketInfo = getRemainingBucketCapacity(
          ticker,
          sizingSnapshot,
          TICKER_TO_BUCKET,
          AUTOPILOT_MAX_BUCKET_EQUITY_FRACTION,
          BUCKET_EQUITY_FRACTION_OVERRIDES,
        );

        if (variant.useCircuitBreaker && circuitBreakerTripped) {
          circuitBreakerBlockedBuyCount += 1;
          blockedSignals.push({
            date,
            ticker,
            action: "BUY",
            blockReason: "circuit_breaker",
            bucket: bucketId,
            currentBucketExposure: bucketInfo.bucketExposure,
            price,
          });
          continue;
        }

        let sharesToStage = decision.suggestedShares;

        if (variant.useBucketCap) {
          const bucketCap = getSafeBuySharesForBucketCap(
            ticker,
            decision.suggestedShares,
            price,
            sizingSnapshot,
            TICKER_TO_BUCKET,
            AUTOPILOT_MAX_BUCKET_EQUITY_FRACTION,
            BUCKET_EQUITY_FRACTION_OVERRIDES,
          );

          if (bucketCap.shares < decision.suggestedShares) {
            bucketCapReductionCount += 1;
          }
          sharesToStage = bucketCap.shares;

          if (sharesToStage <= 0) {
            blockedSignals.push({
              date,
              ticker,
              action: "BUY",
              blockReason: "bucket_cap",
              bucket: bucketId,
              currentBucketExposure: bucketInfo.bucketExposure,
              price,
            });
          }
        }

        if (sharesToStage > 0) {
          staged.push({
            ticker,
            action: "BUY",
            shares: sharesToStage,
            reasonType: decision.reasonType,
            signalDate: date,
            price,
            atrPercent,
          });
        }
      }
    }

    if (executionModel === "close_to_close") {
      executeStagedOrders(staged, date, "close");
    } else {
      pendingOrders = staged;
    }

    const postTradeEquity = computeEquity(closePricesToday);
    if (postTradeEquity > runningPeakForDrawdown) {
      runningPeakForDrawdown = postTradeEquity;
    }
    const dayDrawdownPercent =
      runningPeakForDrawdown > 0
        ? (postTradeEquity - runningPeakForDrawdown) / runningPeakForDrawdown
        : 0;
    if (dayDrawdownPercent < maxDrawdown) maxDrawdown = dayDrawdownPercent;

    const exposurePercent =
      postTradeEquity > 0 ? ((postTradeEquity - cash) / postTradeEquity) * 100 : 0;
    exposureSum += exposurePercent;

    equityCurve.push({
      date,
      equity: postTradeEquity,
      cash,
      exposurePercent,
      drawdownPercent: dayDrawdownPercent * 100,
    });

    previousDayEquity = postTradeEquity;
    finalEquity = postTradeEquity;
  }

  // Whatever's left in pendingOrders after the loop exits never got a
  // following day to execute on (next_open only - close_to_close never
  // populates this). Logged, not silently dropped - a stranded SELL
  // (e.g. an unexecuted STOP_LOSS) changes finalShares/realizedPnl purely
  // from window-edge timing and matters more than a stranded BUY.
  const unexecutedPendingOrders: UnexecutedPendingOrder[] = pendingOrders.map(
    (o) => ({
      ticker: o.ticker,
      action: o.action,
      shares: o.shares,
      reasonType: o.reasonType,
      signalDate: o.signalDate,
    }),
  );

  for (const ticker of tickers) {
    perTicker.get(ticker)!.finalShares = stateByTicker.get(ticker)!.shares;
  }

  const totalSimDays = commonDates.length - simStartIndex;
  const totalTrades = trades.length;
  const blockedBuyCount = blockedSignals.length;
  const bucketCapFullyBlockedCount = blockedSignals.filter(
    (s) => s.blockReason === "bucket_cap",
  ).length;

  return {
    finalEquity,
    totalPnlPercent: ((finalEquity - STARTING_CAPITAL) / STARTING_CAPITAL) * 100,
    maxDrawdownPercent: maxDrawdown * 100,
    avgExposurePercent: totalSimDays > 0 ? exposureSum / totalSimDays : 0,
    circuitBreakerTrippedAt,
    daysTrippedCount,
    resetCount,
    resetEvents,
    totalSimDays,
    bucketCapReductionCount,
    bucketCapFullyBlockedCount,
    circuitBreakerBlockedBuyCount,
    executionTimeReductionCount,
    executionTimeRejectionCount,
    blockedBuyCount,
    totalTrades,
    trades,
    perTicker,
    equityCurve,
    blockedSignals,
    unexecutedPendingOrders,
  };
}

// --- Post-pass: forward returns for blocked signals (own-index lookup, never a shared array) ---

function forwardReturn(
  barsByTicker: Map<string, AlpacaBar[]>,
  indexByTickerByDate: Map<string, Map<string, number>>,
  ticker: string,
  date: string,
  aheadBars: number,
): number | null {
  const ownIndex = indexByTickerByDate.get(ticker)?.get(date);
  if (ownIndex === undefined) return null;

  const bars = barsByTicker.get(ticker)!;
  const startPrice = bars[ownIndex]?.c;
  const futurePrice = bars[ownIndex + aheadBars]?.c;
  if (!startPrice || !futurePrice) return null;

  return ((futurePrice - startPrice) / startPrice) * 100;
}

// --- Equal-weighted buy & hold benchmark, anchored to the sim's own start
// date. Always close-to-close-anchored regardless of which execution
// model's report this is printed alongside - buy-and-hold has no
// signal-to-execution lag concept. ---

function computeEqualWeightBuyAndHold(
  barsByTicker: Map<string, AlpacaBar[]>,
  tickers: string[],
  commonDates: string[],
  indexByTickerByDate: Map<string, Map<string, number>>,
  simStartIndex: number,
): number {
  const perTickerCapital = STARTING_CAPITAL / tickers.length;
  const startDate = commonDates[simStartIndex];
  const endDate = commonDates[commonDates.length - 1];
  if (!startDate || !endDate) return 0;

  let totalFinalValue = 0;

  for (const ticker of tickers) {
    const bars = barsByTicker.get(ticker)!;
    const startIdx = indexByTickerByDate.get(ticker)!.get(startDate)!;
    const endIdx = indexByTickerByDate.get(ticker)!.get(endDate)!;
    const startPrice = bars[startIdx]?.c ?? 0;
    const endPrice = bars[endIdx]?.c ?? 0;
    const shares = startPrice > 0 ? Math.floor(perTickerCapital / startPrice) : 0;
    const leftoverCash = perTickerCapital - shares * startPrice;
    totalFinalValue += leftoverCash + shares * endPrice;
  }

  return ((totalFinalValue - STARTING_CAPITAL) / STARTING_CAPITAL) * 100;
}

function computeSingleTickerBuyAndHold(
  barsByTicker: Map<string, AlpacaBar[]>,
  ticker: string,
  commonDates: string[],
  indexByTickerByDate: Map<string, Map<string, number>>,
  simStartIndex: number,
): number | null {
  const startDate = commonDates[simStartIndex];
  const endDate = commonDates[commonDates.length - 1];
  if (!startDate || !endDate) return null;

  const bars = barsByTicker.get(ticker);
  const indexByDate = indexByTickerByDate.get(ticker);
  if (!bars || !indexByDate) return null;

  const startIdx = indexByDate.get(startDate);
  const endIdx = indexByDate.get(endDate);
  if (startIdx === undefined || endIdx === undefined) return null;

  const startPrice = bars[startIdx]?.c ?? 0;
  const endPrice = bars[endIdx]?.c ?? 0;
  if (startPrice <= 0) return null;

  return ((endPrice - startPrice) / startPrice) * 100;
}

function computeEqualWeightBuyAndHoldCurve(
  barsByTicker: Map<string, AlpacaBar[]>,
  tickers: string[],
  commonDates: string[],
  indexByTickerByDate: Map<string, Map<string, number>>,
  simStartIndex: number,
): Map<string, number> {
  const perTickerCapital = STARTING_CAPITAL / tickers.length;
  const startDate = commonDates[simStartIndex];
  const curve = new Map<string, number>();
  if (!startDate) return curve;

  const sharesByTicker = new Map<string, number>();
  const leftoverCashByTicker = new Map<string, number>();

  for (const ticker of tickers) {
    const bars = barsByTicker.get(ticker)!;
    const startIdx = indexByTickerByDate.get(ticker)!.get(startDate)!;
    const startPrice = bars[startIdx]?.c ?? 0;
    const shares = startPrice > 0 ? Math.floor(perTickerCapital / startPrice) : 0;
    sharesByTicker.set(ticker, shares);
    leftoverCashByTicker.set(ticker, perTickerCapital - shares * startPrice);
  }

  for (let d = simStartIndex; d < commonDates.length; d += 1) {
    const date = commonDates[d]!;
    let total = 0;
    for (const ticker of tickers) {
      const bars = barsByTicker.get(ticker)!;
      const idx = indexByTickerByDate.get(ticker)!.get(date);
      const price = idx !== undefined ? bars[idx]?.c ?? 0 : 0;
      total += (leftoverCashByTicker.get(ticker) ?? 0) + (sharesByTicker.get(ticker) ?? 0) * price;
    }
    curve.set(date, total);
  }

  return curve;
}

// --- Independent per-ticker baseline (backtest-sweep.ts's model: each
// ticker gets its own $STARTING_CAPITAL, no portfolio-level caps at all,
// no shared cash pool) - a stripped-down local reimplementation rather
// than importing backtest-sweep.ts, which runs its own main()/network
// fetch as a side effect of being imported and isn't safe to pull in as a
// library. Always close-to-close, unconditionally - its entire purpose is
// "what would the old script's methodology have said," so it doesn't get
// a next_open variant. ---

function simulateIndependent(bars: AlpacaBar[]): number {
  let cash = STARTING_CAPITAL;
  let sharesOwned = 0;
  let averageEntryPrice = 0;
  let lastBuyIndex = -999;

  for (let i = WARMUP_BARS; i < bars.length; i += 1) {
    const currentBar = bars[i];
    if (!currentBar) continue;

    const currentPrice = Number(currentBar.c.toFixed(2));
    const prices = bars.slice(0, i + 1).map((b) => b.c);
    const previousPrices = bars.slice(0, i).map((b) => b.c);

    const rsi = calculateRSI(prices, 14);
    const macd = calculateMACD(prices);
    const previousMacd = calculateMACD(previousPrices);
    const bb = calculateBollingerBands(prices, 20, 2);

    const portfolioValue = cash + sharesOwned * currentPrice;

    const decision = decideTradeSignal({
      ticker: "INDEPENDENT",
      price: currentPrice,
      cash,
      portfolioValue,
      sharesOwned,
      averageEntryPrice,
      rsi,
      macdHistogram: macd.histogram,
      previousMacdHistogram: previousMacd.histogram,
      bollingerLower: bb.lower,
      bollingerUpper: bb.upper,
      barsSinceLastBuy: i - lastBuyIndex,
      config: DEFAULT_STRATEGY_CONFIG,
    });

    if (decision.action === "BUY" && decision.suggestedShares > 0) {
      const executionPrice = Number((currentPrice * (1 + SLIPPAGE_PERCENT)).toFixed(4));
      const cost = executionPrice * decision.suggestedShares + COMMISSION_PER_TRADE;

      if (cash >= cost) {
        const previousPositionCost = averageEntryPrice * sharesOwned;
        const newBuyCost = executionPrice * decision.suggestedShares;

        cash -= cost;
        sharesOwned += decision.suggestedShares;
        averageEntryPrice =
          sharesOwned > 0 ? (previousPositionCost + newBuyCost) / sharesOwned : 0;
        lastBuyIndex = i;
      }
    } else if (decision.action === "SELL" && decision.suggestedShares > 0) {
      const sharesToSell = Math.min(decision.suggestedShares, sharesOwned);
      const executionPrice = Number((currentPrice * (1 - SLIPPAGE_PERCENT)).toFixed(4));
      const revenue = executionPrice * sharesToSell - COMMISSION_PER_TRADE;

      if (sharesToSell > 0) {
        cash += revenue;
        sharesOwned -= sharesToSell;
        if (sharesOwned === 0) averageEntryPrice = 0;
      }
    }
  }

  const finalPrice = bars[bars.length - 1]?.c ?? 0;
  const finalValue = cash + sharesOwned * finalPrice;
  return ((finalValue - STARTING_CAPITAL) / STARTING_CAPITAL) * 100;
}

function pad(value: string, width: number): string {
  return value.padStart(width);
}

function printAblationTable(
  title: string,
  resultsByVariant: { variant: SimVariantConfig; result: PortfolioSimResult }[],
) {
  console.log(title);
  console.log(
    "variant".padEnd(56) +
      pad("return%", 10) +
      pad("maxDD%", 10) +
      pad("trades", 9) +
      pad("exposure%", 11) +
      pad("0-share buys", 14),
  );
  for (const { variant, result } of resultsByVariant) {
    console.log(
      variant.label.padEnd(56) +
        pad(result.totalPnlPercent.toFixed(2), 10) +
        pad(result.maxDrawdownPercent.toFixed(2), 10) +
        pad(String(result.totalTrades), 9) +
        pad(result.avgExposurePercent.toFixed(1), 11) +
        pad(String(result.blockedBuyCount), 14),
    );
  }
  console.log("");
}

// --- Report/CSV generation (variant D only, per execution model) ---

function csvEscape(value: string | number): string {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCsv(rows: (string | number)[][]): string {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n") + "\n";
}

function executionModelReportText(executionModel: ExecutionModel): string {
  if (executionModel === "close_to_close") {
    return `Execution model: CLOSE_TO_CLOSE

Signal on close[t], executed at close[t] with slippage - a same-bar assumption. This matches backtest.ts/backtest-sweep.ts's existing convention in this repo. This script also runs a NEXT_OPEN companion model in the same invocation (see the next_open/ report) specifically to check whether this assumption is inflating the numbers below.

**Because of this, none of the return numbers below should be read as a realistic live return forecast** - they're only valid for comparing variants against each other (and against the next_open companion run), since every close_to_close variant shares the identical execution-timing assumption.`;
  }

  return `Execution model: NEXT_OPEN

Signals are generated using close[d] data and staged for execution at open[d+1]. Execution price, cash availability, and daily kill switch are evaluated at open[d+1].

Bucket cap and portfolio circuit breaker are evaluated at signal time, not rechecked at execution time. This intentionally isolates the execution-price change from additional risk-policy changes. A future research variant may add execution-time revalidation for pending BUY orders.

No intraday bracket fills are modeled - STOP_LOSS/TAKE_PROFIT decisions only ever compare close[d] to average entry price (same as close_to_close), they simply execute a day later at open[d+1] like every other order.`;
}

async function writeReportsForFullSystem(
  result: PortfolioSimResult,
  barsByTicker: Map<string, AlpacaBar[]>,
  indexByTickerByDate: Map<string, Map<string, number>>,
  commonDates: string[],
  simStartIndex: number,
  buyAndHoldPercent: number,
  spyBuyAndHoldPercent: number | null,
  buyAndHoldCurve: Map<string, number>,
  executionModel: ExecutionModel,
) {
  const reportDir = path.join(REPORT_DIR, executionModel);
  await fs.mkdir(reportDir, { recursive: true });

  const configHash = createStrategyConfigHash(DEFAULT_STRATEGY_CONFIG);

  const reportMd = `# Portfolio backtest report

Generated: ${new Date().toISOString()}

## Run configuration
- Window: ${result.totalSimDays} simulated days (${commonDates[simStartIndex]} to ${commonDates[commonDates.length - 1]})
- Tickers: ${TICKERS.length} (${TICKERS.join(", ")})
- Starting capital: $${STARTING_CAPITAL} (shared, not per-ticker)
- ${executionModelReportText(executionModel)}
- Slippage: ${(SLIPPAGE_PERCENT * 100).toFixed(2)}%
- Fractional/notional shares: off - not supported by this script (whole shares only, same as backtest.ts/backtest-sweep.ts)
- Strategy config hash: ${configHash}

## Result (full system: bucket cap + circuit breaker + daily kill switch + sell throttle)
- Total return: ${result.totalPnlPercent.toFixed(2)}%
- Max drawdown: ${result.maxDrawdownPercent.toFixed(2)}%
- Average exposure: ${result.avgExposurePercent.toFixed(1)}%
- Total trades: ${result.totalTrades}
- Bucket cap reduced a BUY request (partially or fully) ${result.bucketCapReductionCount} times; of those, ${result.bucketCapFullyBlockedCount} were cut all the way to 0 shares (fully blocked)
- BUY signals that executed 0 shares for any reason (bucket cap, circuit breaker, or execution-time rejection): ${result.blockedBuyCount}
- Circuit breaker trips: ${result.circuitBreakerTrippedAt ? `1 (on ${result.circuitBreakerTrippedAt}, stayed tripped ${result.daysTrippedCount}/${result.totalSimDays} days - sticky, no auto-recovery modeled)` : 0}${
    result.circuitBreakerTrippedAt
      ? `\n- This is the baseline "nobody noticed the halt" scenario (D0) - see \`circuit-breaker-policy-comparison.csv\` (next_open only) for what several reset/recovery intervention policies would have produced instead, and \`blocked-signals.csv\`'s forward-return columns for what those ${result.circuitBreakerBlockedBuyCount} blocked BUYs would have returned had a human noticed the alert and reset sooner`
      : ""
  }
- Daily kill switch / execution-time rejections: ${result.executionTimeRejectionCount}
- Execution-time reductions (same-day cash/position competition): ${result.executionTimeReductionCount}
- Orders staged on the last simulated day with no following day to execute on (window-edge effect, not a strategy signal): ${result.unexecutedPendingOrders.length}${
    result.unexecutedPendingOrders.length > 0
      ? `\n${result.unexecutedPendingOrders.map((o) => `  - ${o.signalDate}: ${o.action} ${o.shares} ${o.ticker} (${o.reasonType})`).join("\n")}`
      : ""
  }

## Benchmarks
(Always close-to-close-anchored, regardless of which execution model this report is for - buy-and-hold
and the independent-per-ticker baseline have no signal-to-execution lag concept.)
- Equal-weighted buy & hold (all ${TICKERS.length} tickers): ${buyAndHoldPercent.toFixed(2)}%
- SPY buy & hold: ${spyBuyAndHoldPercent !== null ? `${spyBuyAndHoldPercent.toFixed(2)}%` : "n/a (SPY not in ticker list)"}

## Caveats
- The full-system variant (D) is not the most conservative variant in the ablation table - it has more
  trades and a higher return than bucket-cap-only (B) or +circuit-breaker (C), because the sell-fraction
  throttle changes exit dynamics (partial exits instead of one full exit let this window's winners keep
  running). This is an observed result in this specific window, not a validated edge.
- These return numbers are for comparing variants (and the two execution models) against each other, not
  for forecasting live returns.
`;

  await fs.writeFile(path.join(reportDir, "portfolio-backtest-report.md"), reportMd, "utf-8");

  const blockedRows: (string | number)[][] = [
    [
      "date",
      "ticker",
      "action",
      "block_reason",
      "bucket",
      "current_bucket_exposure",
      "price",
      "next_5d_return",
      "next_20d_return",
    ],
  ];
  for (const signal of result.blockedSignals) {
    const next5d = forwardReturn(barsByTicker, indexByTickerByDate, signal.ticker, signal.date, 5);
    const next20d = forwardReturn(barsByTicker, indexByTickerByDate, signal.ticker, signal.date, 20);
    blockedRows.push([
      signal.date,
      signal.ticker,
      signal.action,
      signal.blockReason,
      signal.bucket ?? "",
      signal.currentBucketExposure.toFixed(2),
      signal.price.toFixed(2),
      next5d !== null ? next5d.toFixed(2) : "",
      next20d !== null ? next20d.toFixed(2) : "",
    ]);
  }
  await fs.writeFile(
    path.join(reportDir, "blocked-signals.csv"),
    toCsv(blockedRows),
    "utf-8",
  );

  const tradeRows: (string | number)[][] = [
    [
      "date",
      "signal_date",
      "ticker",
      "side",
      "shares",
      "price",
      "signal_price",
      "notional",
      "reason",
      "equity_after",
      "cash_after",
    ],
  ];
  for (const trade of result.trades) {
    tradeRows.push([
      trade.date,
      trade.signalDate,
      trade.ticker,
      trade.action,
      trade.shares,
      trade.price.toFixed(4),
      trade.signalPrice.toFixed(4),
      trade.notional.toFixed(2),
      trade.reasonType,
      trade.equityAfter.toFixed(2),
      trade.cashAfter.toFixed(2),
    ]);
  }
  await fs.writeFile(path.join(reportDir, "trades.csv"), toCsv(tradeRows), "utf-8");

  const equityRows: (string | number)[][] = [
    ["date", "equity", "cash", "exposure", "drawdown", "buy_and_hold_equity"],
  ];
  for (const point of result.equityCurve) {
    equityRows.push([
      point.date,
      point.equity.toFixed(2),
      point.cash.toFixed(2),
      point.exposurePercent.toFixed(2),
      point.drawdownPercent.toFixed(2),
      (buyAndHoldCurve.get(point.date) ?? 0).toFixed(2),
    ]);
  }
  await fs.writeFile(path.join(reportDir, "equity-curve.csv"), toCsv(equityRows), "utf-8");

  console.log(`Reports written to ${reportDir}`);
}

async function main() {
  console.log(
    `Portfolio backtest: ${TICKERS.length} tickers | Days: ${DAYS} | Starting capital: $${STARTING_CAPITAL} (shared, not per-ticker)`,
  );
  console.log(`Tickers: ${TICKERS.join(", ")}`);
  console.log("");

  const barsByTicker = new Map<string, AlpacaBar[]>();
  for (const ticker of TICKERS) {
    console.log(`Fetching ${ticker}...`);
    barsByTicker.set(ticker, await fetchAlpacaBars(ticker, DAYS));
  }
  console.log("");

  const { commonDates, indexByTickerByDate } = alignByIntersection(
    barsByTicker,
    TICKERS,
  );
  const simStartIndex = findSimStartIndex(
    commonDates,
    indexByTickerByDate,
    TICKERS,
  );

  if (simStartIndex >= commonDates.length) {
    console.error(
      "Not enough shared history to clear the warmup window for all tickers - try a larger BACKTEST_DAYS.",
    );
    process.exit(1);
  }

  console.log(
    `Simulated window: ${commonDates.length - simStartIndex} days (${commonDates[simStartIndex]} to ${commonDates[commonDates.length - 1]})`,
  );
  console.log("");

  const executionModels: ExecutionModel[] = ["close_to_close", "next_open"];
  const resultsByModel = new Map<
    ExecutionModel,
    { variant: SimVariantConfig; result: PortfolioSimResult }[]
  >();

  for (const executionModel of executionModels) {
    const resultsByVariant = VARIANTS.map((variant) => ({
      variant,
      result: runPortfolioSimulation(
        barsByTicker,
        TICKERS,
        commonDates,
        indexByTickerByDate,
        simStartIndex,
        variant,
        executionModel,
      ),
    }));
    resultsByModel.set(executionModel, resultsByVariant);

    printAblationTable(
      `=== Variant ablation - ${executionModel.toUpperCase()} ===`,
      resultsByVariant,
    );
  }

  console.log(
    '"0-share buys" = BUY signals that executed literally 0 shares, for any reason (bucket cap, circuit',
  );
  console.log(
    "breaker, or execution-time rejection). Not the same as \"reduced by bucket cap\" in the full report,",
  );
  console.log(
    "which also counts requests that were shrunk but still executed with a positive share count.",
  );
  console.log("");
  console.log(
    "Caveat: full-system (D) isn't the most conservative variant - it has more trades and a higher return",
  );
  console.log(
    "than B/C because the sell-fraction throttle changes exit dynamics (partial exits instead of one full",
  );
  console.log(
    "exit let this window's winners keep running). That's an observed result in this specific window,",
  );
  console.log("not yet a validated edge - see CLAUDE.md.");
  console.log("");

  const closeToCloseD = resultsByModel
    .get("close_to_close")!
    .find((r) => r.variant.useDailyKillAndSellThrottle)!.result;
  const nextOpenD = resultsByModel
    .get("next_open")!
    .find((r) => r.variant.useDailyKillAndSellThrottle)!.result;

  console.log("=== Execution drag (variant D, full system) ===");
  console.log(
    `Close-to-close return: ${closeToCloseD.totalPnlPercent.toFixed(2)}%  |  Next-open return: ${nextOpenD.totalPnlPercent.toFixed(2)}%  |  Drag: ${(closeToCloseD.totalPnlPercent - nextOpenD.totalPnlPercent).toFixed(2)} pts`,
  );
  console.log(
    `Close-to-close max drawdown: ${closeToCloseD.maxDrawdownPercent.toFixed(2)}%  |  Next-open max drawdown: ${nextOpenD.maxDrawdownPercent.toFixed(2)}%`,
  );
  console.log("");

  // --- Circuit-breaker intervention scenarios (next_open, variant D only -
  // C never trips in any observed run and close_to_close's breaker never
  // trips either, so this axis is only informative there). ---
  const variantD = VARIANTS.find((v) => v.useDailyKillAndSellThrottle)!;
  const policyResults = CIRCUIT_BREAKER_POLICIES.map((policy) => ({
    policy,
    result: runPortfolioSimulation(
      barsByTicker,
      TICKERS,
      commonDates,
      indexByTickerByDate,
      simStartIndex,
      variantD,
      "next_open",
      policy,
    ),
  }));

  function avgBlockedBuyForward20d(result: PortfolioSimResult): number | null {
    const returns = result.blockedSignals
      .filter((s) => s.blockReason === "circuit_breaker")
      .map((s) => forwardReturn(barsByTicker, indexByTickerByDate, s.ticker, s.date, 20))
      .filter((r): r is number => r !== null);
    if (returns.length === 0) return null;
    return returns.reduce((sum, r) => sum + r, 0) / returns.length;
  }

  console.log("=== Circuit-breaker intervention scenarios (NEXT_OPEN, variant D) ===");
  console.log(
    "scenario".padEnd(56) +
      pad("return%", 10) +
      pad("maxDD%", 10) +
      pad("halt days", 11) +
      pad("blocked", 9) +
      pad("resets", 8) +
      pad("avg fwd20d%", 13),
  );
  for (const { policy, result } of policyResults) {
    const avgFwd = avgBlockedBuyForward20d(result);
    console.log(
      policy.label.padEnd(56) +
        pad(result.totalPnlPercent.toFixed(2), 10) +
        pad(result.maxDrawdownPercent.toFixed(2), 10) +
        pad(String(result.daysTrippedCount), 11) +
        pad(String(result.circuitBreakerBlockedBuyCount), 9) +
        pad(String(result.resetCount), 8) +
        pad(avgFwd !== null ? avgFwd.toFixed(2) : "n/a", 13),
    );
  }
  console.log(
    "Backtest-only research - none of these reset policies exist live. D0 is the current, unchanged",
  );
  console.log(
    "live behavior (sticky, no auto-recovery) and must stay reproducible at the number reported above.",
  );
  console.log("");

  await fs.mkdir(path.join(REPORT_DIR, "next_open"), { recursive: true });
  const policyRows: (string | number)[][] = [
    ["scenario", "return_pct", "max_dd_pct", "halt_days", "buys_blocked_by_breaker", "reset_count", "avg_blocked_buy_fwd_20d_return_pct"],
  ];
  for (const { policy, result } of policyResults) {
    const avgFwd = avgBlockedBuyForward20d(result);
    policyRows.push([
      policy.label,
      result.totalPnlPercent.toFixed(2),
      result.maxDrawdownPercent.toFixed(2),
      result.daysTrippedCount,
      result.circuitBreakerBlockedBuyCount,
      result.resetCount,
      avgFwd !== null ? avgFwd.toFixed(2) : "",
    ]);
  }
  await fs.writeFile(
    path.join(REPORT_DIR, "next_open", "circuit-breaker-policy-comparison.csv"),
    toCsv(policyRows),
    "utf-8",
  );

  const buyAndHoldPercent = computeEqualWeightBuyAndHold(
    barsByTicker,
    TICKERS,
    commonDates,
    indexByTickerByDate,
    simStartIndex,
  );
  const spyBuyAndHoldPercent = TICKERS.includes("SPY")
    ? computeSingleTickerBuyAndHold(barsByTicker, "SPY", commonDates, indexByTickerByDate, simStartIndex)
    : null;
  const buyAndHoldCurve = computeEqualWeightBuyAndHoldCurve(
    barsByTicker,
    TICKERS,
    commonDates,
    indexByTickerByDate,
    simStartIndex,
  );

  const independentAverages = TICKERS.map((ticker) =>
    simulateIndependent(barsByTicker.get(ticker)!),
  );
  const independentAveragePercent =
    independentAverages.reduce((sum, v) => sum + v, 0) / independentAverages.length;

  console.log("=== Benchmarks (always close-to-close-anchored) ===");
  console.log(`Equal-weighted buy & hold (all ${TICKERS.length} tickers, $${(STARTING_CAPITAL / TICKERS.length).toFixed(0)} each): ${buyAndHoldPercent.toFixed(2)}%`);
  if (spyBuyAndHoldPercent !== null) {
    console.log(`SPY buy & hold: ${spyBuyAndHoldPercent.toFixed(2)}%`);
  }
  console.log(
    `Independent per-ticker average (backtest-sweep.ts-style, $${STARTING_CAPITAL} EACH, no portfolio caps): ${independentAveragePercent.toFixed(2)}%`,
  );
  console.log("");

  for (const executionModel of executionModels) {
    const result = resultsByModel
      .get(executionModel)!
      .find((r) => r.variant.useDailyKillAndSellThrottle)!.result;

    console.log(`=== Full-system per-ticker breakdown - ${executionModel.toUpperCase()} ===`);
    console.log(
      "ticker".padEnd(8) +
        pad("trades", 8) +
        pad("final shares", 14) +
        pad("realized PnL", 14) +
        pad("independent %", 16),
    );
    TICKERS.forEach((ticker, i) => {
      const summary = result.perTicker.get(ticker)!;
      console.log(
        ticker.padEnd(8) +
          pad(String(summary.trades), 8) +
          pad(String(summary.finalShares), 14) +
          pad(summary.realizedPnl.toFixed(2), 14) +
          pad(independentAverages[i]!.toFixed(2), 16),
      );
    });
    console.log("");

    await writeReportsForFullSystem(
      result,
      barsByTicker,
      indexByTickerByDate,
      commonDates,
      simStartIndex,
      buyAndHoldPercent,
      spyBuyAndHoldPercent,
      buyAndHoldCurve,
      executionModel,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
