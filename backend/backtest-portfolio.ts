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
// no gap of their own, by feeding them a gapped series.

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

interface TickerState {
  shares: number;
  averageEntryPrice: number;
  entryAtrPercent: number;
  lastBuyOwnIndex: number;
  lastStopLossOwnIndex: number;
}

interface TradeLogEntry {
  date: string;
  ticker: string;
  action: "BUY" | "SELL";
  shares: number;
  price: number;
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

interface PortfolioSimResult {
  finalEquity: number;
  totalPnlPercent: number;
  maxDrawdownPercent: number;
  avgExposurePercent: number;
  circuitBreakerTrippedAt: string | null;
  daysTrippedCount: number;
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
}

interface StagedDecision {
  ticker: string;
  action: "BUY" | "SELL";
  shares: number;
  reasonType: StrategyReasonType;
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
  let bucketCapReductionCount = 0;
  let circuitBreakerBlockedBuyCount = 0;
  let executionTimeReductionCount = 0;
  let executionTimeRejectionCount = 0;
  let finalEquity = STARTING_CAPITAL;
  let maxDrawdown = 0;
  let runningPeakForDrawdown = 0;
  let exposureSum = 0;

  const maxDrawdownFromPeakPercent = getMaxDrawdownFromPeakPercent();
  const riskProfile = variant.useDailyKillAndSellThrottle
    ? FULL_RISK_PROFILE
    : NO_DAILY_KILL_RISK_PROFILE;

  function priceOf(ticker: string, date: string): number | null {
    const idx = indexByTickerByDate.get(ticker)!.get(date);
    if (idx === undefined) return null;
    const bar = barsByTicker.get(ticker)![idx];
    return bar ? Number(bar.c.toFixed(2)) : null;
  }

  function computeEquity(pricesToday: Map<string, number>): number {
    let total = cash;
    for (const ticker of tickers) {
      const state = stateByTicker.get(ticker)!;
      if (state.shares <= 0) continue;
      const price = pricesToday.get(ticker) ?? state.averageEntryPrice;
      total += state.shares * price;
    }
    return total;
  }

  for (let d = simStartIndex; d < commonDates.length; d += 1) {
    const date = commonDates[d]!;
    const pricesToday = new Map<string, number>();
    for (const ticker of tickers) {
      const p = priceOf(ticker, date);
      if (p !== null) pricesToday.set(ticker, p);
    }

    const preTradeEquity = computeEquity(pricesToday);
    if (preTradeEquity > peakEquity) peakEquity = preTradeEquity;

    // Sticky - mirrors updatePortfolioCircuitBreaker's applyStickyTrip
    // (never auto-recovers without a human reset in live). Skipped
    // entirely when this variant doesn't model the circuit breaker.
    if (variant.useCircuitBreaker && !circuitBreakerTripped) {
      const evaluation = evaluatePortfolioDrawdown(
        preTradeEquity,
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

    // --- SIZING pass: every ticker reads the same frozen start-of-day snapshot ---
    const sizingSnapshot: PortfolioSnapshot = {
      balance: cash,
      equity: preTradeEquity,
      currency: "USD",
      positions: Object.fromEntries(
        tickers
          .filter((t) => stateByTicker.get(t)!.shares > 0)
          .map((t) => {
            const state = stateByTicker.get(t)!;
            const price = pricesToday.get(t) ?? state.averageEntryPrice;
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
      const price = pricesToday.get(ticker);
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
            price,
            atrPercent,
          });
        }
      }
    }

    // --- EXECUTION pass: SELLs before BUYs, sequential real cash/position re-check per order ---
    const orderedStaged = [
      ...staged.filter((s) => s.action === "SELL"),
      ...staged.filter((s) => s.action === "BUY"),
    ];

    for (const item of orderedStaged) {
      const state = stateByTicker.get(item.ticker)!;
      const currentPositions = tickers
        .filter((t) => stateByTicker.get(t)!.shares > 0)
        .map((t) => {
          const s = stateByTicker.get(t)!;
          const p = pricesToday.get(t) ?? s.averageEntryPrice;
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
          ? Number((item.price * (1 + SLIPPAGE_PERCENT)).toFixed(4))
          : Number((item.price * (1 - SLIPPAGE_PERCENT)).toFixed(4));

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
            date,
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
          .get(date)!;

        perTicker.get(item.ticker)!.trades += 1;
        trades.push({
          date,
          ticker: item.ticker,
          action: "BUY",
          shares: finalShares,
          price: executionPrice,
          notional: newBuyCost,
          reasonType: item.reasonType,
          equityAfter: computeEquity(pricesToday),
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
            .get(date)!;
        }

        trades.push({
          date,
          ticker: item.ticker,
          action: "SELL",
          shares: sharesToSell,
          price: executionPrice,
          notional: sharesToSell * executionPrice,
          reasonType: item.reasonType,
          equityAfter: computeEquity(pricesToday),
          cashAfter: cash,
          realizedPnl,
        });
      }
    }

    const postTradeEquity = computeEquity(pricesToday);
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

// --- Equal-weighted buy & hold benchmark, anchored to the sim's own start date ---

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
// library. ---

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

// --- Report/CSV generation (variant D only) ---

function csvEscape(value: string | number): string {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCsv(rows: (string | number)[][]): string {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n") + "\n";
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
) {
  await fs.mkdir(REPORT_DIR, { recursive: true });

  const configHash = createStrategyConfigHash(DEFAULT_STRATEGY_CONFIG);

  const reportMd = `# Portfolio backtest report

Generated: ${new Date().toISOString()}

## Run configuration
- Window: ${result.totalSimDays} simulated days (${commonDates[simStartIndex]} to ${commonDates[commonDates.length - 1]})
- Tickers: ${TICKERS.length} (${TICKERS.join(", ")})
- Starting capital: $${STARTING_CAPITAL} (shared, not per-ticker)
- Execution model: signal on close[t], executed at close[t] with slippage - a same-bar assumption, not open[t+1]. This matches backtest.ts/backtest-sweep.ts's existing convention in this repo, it is not unique to this script. A structural fix (execute at open[t+1]) would need to touch all three backtest scripts and would shift every historical number already referenced in CLAUDE.md/GOLIVE_CRITERIA.md - tracked as a separate follow-up, not done here. **Because of this, none of the return numbers below should be read as a realistic live return forecast** - they're only valid for comparing variants against each other, since every variant shares the identical close-to-close assumption and its bias should apply roughly equally to all of them.
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
- Circuit breaker trips: ${result.circuitBreakerTrippedAt ? `1 (on ${result.circuitBreakerTrippedAt}, stayed tripped ${result.daysTrippedCount}/${result.totalSimDays} days - sticky, no auto-recovery modeled)` : 0}
- Daily kill switch / execution-time rejections: ${result.executionTimeRejectionCount}
- Execution-time reductions (same-day cash/position competition): ${result.executionTimeReductionCount}

## Benchmarks
- Equal-weighted buy & hold (all ${TICKERS.length} tickers): ${buyAndHoldPercent.toFixed(2)}%
- SPY buy & hold: ${spyBuyAndHoldPercent !== null ? `${spyBuyAndHoldPercent.toFixed(2)}%` : "n/a (SPY not in ticker list)"}

## Caveats
- The full-system variant (D) is not the most conservative variant in the ablation table - it has more
  trades and a higher return than bucket-cap-only (B) or +circuit-breaker (C), because the sell-fraction
  throttle changes exit dynamics (partial exits instead of one full exit let this window's winners keep
  running). This is an observed result in this specific window, not a validated edge.
- See "Execution model" above: these return numbers are for comparing variants against each other, not
  for forecasting live returns.
`;

  await fs.writeFile(path.join(REPORT_DIR, "portfolio-backtest-report.md"), reportMd, "utf-8");

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
    path.join(REPORT_DIR, "blocked-signals.csv"),
    toCsv(blockedRows),
    "utf-8",
  );

  const tradeRows: (string | number)[][] = [
    ["date", "ticker", "side", "shares", "price", "notional", "reason", "equity_after", "cash_after"],
  ];
  for (const trade of result.trades) {
    tradeRows.push([
      trade.date,
      trade.ticker,
      trade.action,
      trade.shares,
      trade.price.toFixed(4),
      trade.notional.toFixed(2),
      trade.reasonType,
      trade.equityAfter.toFixed(2),
      trade.cashAfter.toFixed(2),
    ]);
  }
  await fs.writeFile(path.join(REPORT_DIR, "trades.csv"), toCsv(tradeRows), "utf-8");

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
  await fs.writeFile(path.join(REPORT_DIR, "equity-curve.csv"), toCsv(equityRows), "utf-8");

  console.log(`Reports written to ${REPORT_DIR}`);
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

  console.log("=== Variant ablation (isolating each safety layer's effect) ===");
  console.log(
    "variant".padEnd(56) +
      pad("return%", 10) +
      pad("maxDD%", 10) +
      pad("trades", 9) +
      pad("exposure%", 11) +
      pad("0-share buys", 14),
  );

  let fullSystemResult: PortfolioSimResult | null = null;

  for (const variant of VARIANTS) {
    const result = runPortfolioSimulation(
      barsByTicker,
      TICKERS,
      commonDates,
      indexByTickerByDate,
      simStartIndex,
      variant,
    );

    console.log(
      variant.label.padEnd(56) +
        pad(result.totalPnlPercent.toFixed(2), 10) +
        pad(result.maxDrawdownPercent.toFixed(2), 10) +
        pad(String(result.totalTrades), 9) +
        pad(result.avgExposurePercent.toFixed(1), 11) +
        pad(String(result.blockedBuyCount), 14),
    );

    if (variant.useBucketCap && variant.useCircuitBreaker && variant.useDailyKillAndSellThrottle) {
      fullSystemResult = result;
    }
  }
  console.log(
    '"0-share buys" = BUY signals that executed literally 0 shares, for any reason (bucket cap, circuit',
  );
  console.log(
    "breaker, or execution-time rejection). Not the same as \"reduced by bucket cap\" below, which also",
  );
  console.log(
    "counts requests that were shrunk but still executed with a positive share count.",
  );
  console.log("");
  console.log(
    "Caveat: D isn't the most conservative variant here - it has more trades and a higher return than",
  );
  console.log(
    "B/C because the sell-fraction throttle changes exit dynamics (partial exits instead of one full",
  );
  console.log(
    "exit let this window's winners keep running). That's an observed result in this specific window,",
  );
  console.log("not yet a validated edge - see CLAUDE.md.");
  console.log("");

  const result = fullSystemResult!;

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

  console.log("=== Full-system result (variant D - matches live) ===");
  console.log(`Total return: ${result.totalPnlPercent.toFixed(2)}%`);
  console.log(`Max drawdown: ${result.maxDrawdownPercent.toFixed(2)}%`);
  console.log(`Average exposure: ${result.avgExposurePercent.toFixed(1)}%`);
  console.log(
    `Circuit breaker: ${
      result.circuitBreakerTrippedAt
        ? `tripped on ${result.circuitBreakerTrippedAt}, stayed tripped for ${result.daysTrippedCount}/${result.totalSimDays} days (${((result.daysTrippedCount / result.totalSimDays) * 100).toFixed(1)}%) - sticky, no auto-recovery modeled, matching live`
        : "never tripped"
    }`,
  );
  console.log(`BUYs blocked by tripped circuit breaker: ${result.circuitBreakerBlockedBuyCount}`);
  console.log(
    `BUYs reduced by bucket cap: ${result.bucketCapReductionCount} (partial or full reduction; of these, ${result.bucketCapFullyBlockedCount} were cut all the way to 0 shares)`,
  );
  console.log(`Orders reduced at execution time (same-day cash/position competition): ${result.executionTimeReductionCount}`);
  console.log(`Orders rejected at execution time (daily -5% kill switch or no cash left): ${result.executionTimeRejectionCount}`);
  console.log("");

  console.log("=== Benchmarks ===");
  console.log(`Equal-weighted buy & hold (all ${TICKERS.length} tickers, $${(STARTING_CAPITAL / TICKERS.length).toFixed(0)} each): ${buyAndHoldPercent.toFixed(2)}%`);
  if (spyBuyAndHoldPercent !== null) {
    console.log(`SPY buy & hold: ${spyBuyAndHoldPercent.toFixed(2)}%`);
  }
  console.log(
    `Independent per-ticker average (backtest-sweep.ts-style, $${STARTING_CAPITAL} EACH, no portfolio caps): ${independentAveragePercent.toFixed(2)}%`,
  );
  console.log(
    "  Note: this compares average %% return, not dollar totals. Some of the gap vs. the portfolio result",
  );
  console.log(
    "  above is whole-share rounding being worse at 1/13th the capital, not purely caps/competition.",
  );
  console.log("");

  console.log("=== Per-ticker breakdown (full system) ===");
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
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
