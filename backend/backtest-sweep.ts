import dotenv from "dotenv";

import {
  calculateATR,
  calculateBollingerBands,
  calculateMACD,
  calculateRSI,
  calculateSMA,
} from "./indicators.js";
import {
  DEFAULT_STRATEGY_CONFIG,
  decideTradeSignal,
  type StrategyConfig,
} from "./strategyEngine.js";
import {
  computeBucketRegimeByDate,
  isBuySuppressedByRegime,
  type RegimeBucketConfig,
  type RegimeState,
} from "./src/strategy/portfolioRegimeFilter.js";

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

// Mirrors autopilotWorker.ts's REGIME_BUCKETS/TICKER_TO_REGIME_BUCKET -
// must stay identical between backtest and live, same as every other piece
// of strategy logic in this file.
function makeRegimeBuckets(exemptHighBeta: boolean): RegimeBucketConfig[] {
  return [
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
      exempt: exemptHighBeta,
    },
  ];
}

const TICKER_TO_REGIME_BUCKET: Record<string, string> = {
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
const DAYS = Number.parseInt(process.env.BACKTEST_DAYS || "365", 10);
const STARTING_CAPITAL = Number.parseFloat(
  process.env.BACKTEST_STARTING_CAPITAL || "10000",
);
const FEED = process.env.ALPACA_DATA_FEED || "iex";
const SLIPPAGE_PERCENT = 0.0005;
const COMMISSION_PER_TRADE = 0;

function toIsoDate(date: Date): string {
  return date.toISOString().split("T")[0] ?? date.toISOString();
}

// Lets a sweep run end on a historical date instead of always "today" - used
// to validate a filter across multiple non-overlapping periods rather than
// just the one window that happens to be convenient right now.
const END_DAYS_AGO = Number.parseInt(
  process.env.BACKTEST_END_DAYS_AGO || "0",
  10,
);

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

interface SimResult {
  totalPnlPercent: number;
  maxDrawdownPercent: number;
  trades: number;
  closedTrades: number;
  winRatePercent: number;
  exposurePercent: number;
  buyAndHoldPnlPercent: number;
}

// RSI (Wilder smoothing) and MACD (EMA) are seeded from bars[0] and only
// converge to accurate values after ~100+ bars. Starting the simulation
// too early trades on distorted indicator values and makes results depend
// on how much history was fetched, not just the strategy itself.
const WARMUP_BARS = 210;

interface SimOptions {
  stopLossCooldownBars?: number;
  trendFilterSmaLength?: number;
  trendSlopeFilter?: { smaLength: number; lookbackBars: number };
  regimeBlockedDates?: Set<string>;
}

function simulate(
  bars: AlpacaBar[],
  strategy: StrategyConfig,
  options: SimOptions = {},
): SimResult {
  const stopLossCooldownBars = options.stopLossCooldownBars ?? 0;
  const trendFilterSmaLength = options.trendFilterSmaLength ?? 0;
  const trendSlopeFilter = options.trendSlopeFilter ?? null;
  let cash = STARTING_CAPITAL;
  let sharesOwned = 0;
  let averageEntryPrice = 0;
  let entryAtrPercent = 0;
  let lastBuyIndex = -999;
  let lastStopLossIndex = -999;
  let realizedPnlTotal = 0;

  const closedPnls: number[] = [];
  let tradesCount = 0;
  const equityCurve: number[] = [];
  let exposureBars = 0;

  const firstPrice = bars[0]?.c ?? 0;
  const buyAndHoldShares =
    firstPrice > 0 ? Math.floor(STARTING_CAPITAL / firstPrice) : 0;
  const buyAndHoldCash = STARTING_CAPITAL - buyAndHoldShares * firstPrice;

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
    const atr = calculateATR(bars.slice(0, i + 1), 14);
    const atrPercent = currentPrice > 0 ? atr / currentPrice : 0;

    const portfolioValueBeforeDecision = cash + sharesOwned * currentPrice;
    const barsSinceLastBuy = i - lastBuyIndex;

    const decision = decideTradeSignal({
      ticker: "SWEEP",
      price: currentPrice,
      cash,
      portfolioValue: portfolioValueBeforeDecision,
      sharesOwned,
      averageEntryPrice,
      rsi,
      macdHistogram: macd.histogram,
      previousMacdHistogram: previousMacd.histogram,
      bollingerLower: bb.lower,
      bollingerUpper: bb.upper,
      barsSinceLastBuy,
      entryAtrPercent,
      config: strategy,
    });

    const blockedByStopLossCooldown =
      decision.action === "BUY" &&
      stopLossCooldownBars > 0 &&
      i - lastStopLossIndex < stopLossCooldownBars;

    const blockedByTrendFilter =
      decision.action === "BUY" &&
      trendFilterSmaLength > 0 &&
      currentPrice < calculateSMA(prices, trendFilterSmaLength);

    let blockedByTrendSlope = false;
    if (decision.action === "BUY" && trendSlopeFilter) {
      const { smaLength, lookbackBars } = trendSlopeFilter;
      if (prices.length >= smaLength + lookbackBars) {
        const currentSma = calculateSMA(prices, smaLength);
        const pastSma = calculateSMA(
          prices.slice(0, prices.length - lookbackBars),
          smaLength,
        );
        blockedByTrendSlope = currentSma < pastSma;
      }
    }

    const currentDateKey = currentBar.t.split("T")[0] ?? currentBar.t;
    const blockedByRegimeFilter =
      decision.action === "BUY" &&
      (options.regimeBlockedDates?.has(currentDateKey) ?? false);

    if (
      decision.action === "BUY" &&
      decision.suggestedShares > 0 &&
      !blockedByStopLossCooldown &&
      !blockedByTrendFilter &&
      !blockedByTrendSlope &&
      !blockedByRegimeFilter
    ) {
      const executionPrice = Number(
        (currentPrice * (1 + SLIPPAGE_PERCENT)).toFixed(4),
      );
      const cost =
        executionPrice * decision.suggestedShares + COMMISSION_PER_TRADE;

      if (cash >= cost) {
        const previousPositionCost = averageEntryPrice * sharesOwned;
        const previousAtrWeight = entryAtrPercent * previousPositionCost;
        const newBuyCost = executionPrice * decision.suggestedShares;

        cash -= cost;
        sharesOwned += decision.suggestedShares;
        averageEntryPrice =
          sharesOwned > 0
            ? (previousPositionCost + newBuyCost) / sharesOwned
            : 0;
        entryAtrPercent =
          sharesOwned > 0
            ? (previousAtrWeight + atrPercent * newBuyCost) /
              (previousPositionCost + newBuyCost)
            : 0;
        lastBuyIndex = i;
        tradesCount += 1;
      }
    } else if (decision.action === "SELL" && decision.suggestedShares > 0) {
      const sharesToSell = Math.min(decision.suggestedShares, sharesOwned);
      const executionPrice = Number(
        (currentPrice * (1 - SLIPPAGE_PERCENT)).toFixed(4),
      );
      const revenue = executionPrice * sharesToSell - COMMISSION_PER_TRADE;

      if (sharesToSell > 0) {
        const realizedPnl =
          (executionPrice - averageEntryPrice) * sharesToSell -
          COMMISSION_PER_TRADE;
        cash += revenue;
        sharesOwned -= sharesToSell;
        realizedPnlTotal += realizedPnl;
        closedPnls.push(realizedPnl);
        tradesCount += 1;
        if (sharesOwned === 0) {
          averageEntryPrice = 0;
          entryAtrPercent = 0;
        }
        if (decision.reasonType === "STOP_LOSS") lastStopLossIndex = i;
      }
    }

    if (sharesOwned > 0) exposureBars += 1;
    equityCurve.push(cash + sharesOwned * currentPrice);
  }

  const finalPrice = bars[bars.length - 1]?.c ?? 0;
  const finalPortfolioValue = cash + sharesOwned * finalPrice;
  const totalPnlPercent =
    ((finalPortfolioValue - STARTING_CAPITAL) / STARTING_CAPITAL) * 100;

  const buyAndHoldValue = buyAndHoldCash + buyAndHoldShares * finalPrice;
  const buyAndHoldPnlPercent =
    ((buyAndHoldValue - STARTING_CAPITAL) / STARTING_CAPITAL) * 100;

  let peak = 0;
  let maxDrawdown = 0;
  for (const value of equityCurve) {
    if (value > peak) peak = value;
    if (peak > 0) {
      const dd = (value - peak) / peak;
      if (dd < maxDrawdown) maxDrawdown = dd;
    }
  }

  const wins = closedPnls.filter((p) => p > 0).length;
  const winRatePercent =
    closedPnls.length > 0 ? (wins / closedPnls.length) * 100 : 0;
  const exposurePercent =
    equityCurve.length > 0 ? (exposureBars / equityCurve.length) * 100 : 0;

  return {
    totalPnlPercent,
    maxDrawdownPercent: maxDrawdown * 100,
    trades: tradesCount,
    closedTrades: closedPnls.length,
    winRatePercent,
    exposurePercent,
    buyAndHoldPnlPercent,
  };
}

const VARIANTS: {
  name: string;
  overrides: Partial<StrategyConfig>;
  simOptions?: SimOptions;
  // Set instead of a static simOptions.regimeBlockedDates, since the
  // blocked-dates set depends on which bucket the ticker being simulated
  // belongs to - resolved per-ticker in main() below.
  regimeExemptHighBeta?: boolean;
  // Alternate ticker->bucket mapping where AMD/NVDA/TSLA are gated by
  // us_broad's (SPY's) regime instead of their own composite - see
  // regime-filter-highbeta-via-us-broad below.
  regimeHighBetaViaUsBroad?: boolean;
}[] = [
  { name: "baseline", overrides: {} },
  {
    name: "slope-sma100-lb10",
    overrides: {},
    simOptions: { trendSlopeFilter: { smaLength: 100, lookbackBars: 10 } },
  },
  {
    name: "slope-sma100-lb20",
    overrides: {},
    simOptions: { trendSlopeFilter: { smaLength: 100, lookbackBars: 20 } },
  },
  {
    name: "slope-sma100-lb40",
    overrides: {},
    simOptions: { trendSlopeFilter: { smaLength: 100, lookbackBars: 40 } },
  },
  {
    name: "slope-sma150-lb20",
    overrides: {},
    simOptions: { trendSlopeFilter: { smaLength: 150, lookbackBars: 20 } },
  },
  {
    name: "atr-stops-2.5x-4.5x",
    overrides: {
      useAtrStops: true,
      atrStopMultiplier: 2.5,
      atrTakeProfitMultiplier: 4.5,
    },
  },
  {
    // Matches DEFAULT_STRATEGY_CONFIG's atrStopMultiplier/atrTakeProfitMultiplier -
    // spelled out explicitly so this variant stays meaningful even if those
    // defaults change later.
    name: "atr-stops-3.5x-6x",
    overrides: {
      useAtrStops: true,
      atrStopMultiplier: 3.5,
      atrTakeProfitMultiplier: 6,
    },
  },
  {
    name: "regime-filter-exempt-highbeta",
    overrides: {},
    regimeExemptHighBeta: true,
  },
  {
    name: "regime-filter-no-exempt",
    overrides: {},
    regimeExemptHighBeta: false,
  },
  {
    // Tests the actual academic framing (broad-market regime overlaid on a
    // fast-moving sector) rather than the self-referential composite the
    // other two regime-filter variants use (high-beta gated by its own
    // AMD/NVDA/TSLA trend). Gates AMD/NVDA/TSLA by us_broad's (SPY's) trend
    // instead of a separate high_beta_growth composite.
    name: "regime-filter-highbeta-via-us-broad",
    overrides: {},
    regimeHighBetaViaUsBroad: true,
  },
];

// computeBucketRegimeByDate's output doesn't depend on `exempt` (exempt only
// affects whether the regime is honored, not how it's computed) - so the
// timeline is built once, and exempt is applied here at lookup time.
function deriveRegimeBlockedDates(
  regimeByBucketByDate: Map<string, Map<string, RegimeState>>,
  bucket: RegimeBucketConfig | undefined,
): Set<string> {
  const blocked = new Set<string>();
  if (!bucket || bucket.exempt) return blocked;

  const regimeByDate = regimeByBucketByDate.get(bucket.bucketId);
  if (!regimeByDate) return blocked;

  for (const [dateKey, state] of regimeByDate) {
    if (state === "RISK_OFF") blocked.add(dateKey);
  }

  return blocked;
}

async function main() {
  console.log(
    `Tickers: ${TICKERS.join(", ")} | Days: ${DAYS} | Capital/ticker: $${STARTING_CAPITAL}`,
  );
  console.log("");

  const barsByTicker = new Map<string, AlpacaBar[]>();
  for (const ticker of TICKERS) {
    console.log(`Fetching ${ticker}...`);
    barsByTicker.set(ticker, await fetchAlpacaBars(ticker, DAYS));
  }

  // computeBucketRegimeByDate's output doesn't depend on `exempt`, so the
  // timeline is computed once here; exempt is applied per-variant below via
  // deriveRegimeBlockedDates.
  const regimeByBucketByDate = new Map<string, Map<string, RegimeState>>();
  for (const bucket of makeRegimeBuckets(true)) {
    regimeByBucketByDate.set(
      bucket.bucketId,
      computeBucketRegimeByDate(barsByTicker, bucket),
    );
  }

  const regimeBucketsExempt = makeRegimeBuckets(true);
  const regimeBucketsNotExempt = makeRegimeBuckets(false);
  const regimeBucketsHighBetaViaUsBroad = makeRegimeBuckets(false);
  const TICKER_TO_BUCKET_HIGHBETA_VIA_US_BROAD: Record<string, string> = {
    ...TICKER_TO_REGIME_BUCKET,
    AMD: "us_broad",
    NVDA: "us_broad",
    TSLA: "us_broad",
  };

  const perVariantTotals = new Map<
    string,
    { returnSum: number; ddSum: number; count: number }
  >();

  for (const ticker of TICKERS) {
    const bars = barsByTicker.get(ticker)!;
    console.log("");
    console.log(`=== ${ticker} ===`);
    console.log(
      "variant".padEnd(24) +
        "return%".padStart(10) +
        "maxDD%".padStart(10) +
        "trades".padStart(9) +
        "win%".padStart(8) +
        "exposure%".padStart(11),
    );

    for (const variant of VARIANTS) {
      const strategy: StrategyConfig = {
        ...DEFAULT_STRATEGY_CONFIG,
        ...variant.overrides,
      };

      let simOptions = variant.simOptions ?? {};

      if (variant.regimeExemptHighBeta !== undefined) {
        const buckets = variant.regimeExemptHighBeta
          ? regimeBucketsExempt
          : regimeBucketsNotExempt;
        const bucketId = TICKER_TO_REGIME_BUCKET[ticker];
        const bucket = buckets.find((b) => b.bucketId === bucketId);

        simOptions = {
          ...simOptions,
          regimeBlockedDates: deriveRegimeBlockedDates(
            regimeByBucketByDate,
            bucket,
          ),
        };
      }

      if (variant.regimeHighBetaViaUsBroad) {
        const bucketId = TICKER_TO_BUCKET_HIGHBETA_VIA_US_BROAD[ticker];
        const bucket = regimeBucketsHighBetaViaUsBroad.find(
          (b) => b.bucketId === bucketId,
        );

        simOptions = {
          ...simOptions,
          regimeBlockedDates: deriveRegimeBlockedDates(
            regimeByBucketByDate,
            bucket,
          ),
        };
      }

      const result = simulate(bars, strategy, simOptions);

      console.log(
        variant.name.padEnd(24) +
          result.totalPnlPercent.toFixed(2).padStart(10) +
          result.maxDrawdownPercent.toFixed(2).padStart(10) +
          String(result.trades).padStart(9) +
          result.winRatePercent.toFixed(1).padStart(8) +
          result.exposurePercent.toFixed(1).padStart(11),
      );

      const totals = perVariantTotals.get(variant.name) ?? {
        returnSum: 0,
        ddSum: 0,
        count: 0,
      };
      totals.returnSum += result.totalPnlPercent;
      totals.ddSum += result.maxDrawdownPercent;
      totals.count += 1;
      perVariantTotals.set(variant.name, totals);

      if (variant.name === "baseline") {
        console.log(
          `${"buy&hold".padEnd(24)}${result.buyAndHoldPnlPercent.toFixed(2).padStart(10)}`,
        );
      }
    }
  }

  console.log("");
  console.log("=== AVERAGE ACROSS ALL TICKERS ===");
  console.log(
    "variant".padEnd(24) +
      "avg return%".padStart(14) +
      "avg maxDD%".padStart(13),
  );
  for (const variant of VARIANTS) {
    const totals = perVariantTotals.get(variant.name)!;
    console.log(
      variant.name.padEnd(24) +
        (totals.returnSum / totals.count).toFixed(2).padStart(14) +
        (totals.ddSum / totals.count).toFixed(2).padStart(13),
    );
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Unknown sweep error";
  console.error(`Sweep failed: ${message}`);
  process.exit(1);
});
