import { promises as fs } from "fs";
import path from "path";
import dotenv from "dotenv";

import {
  decideRotationTargets,
  DEFAULT_ETF_ROTATION_CONFIG,
  isMonthlyRebalanceDate,
  type EtfRotationConfig,
  type RotationTarget,
} from "./etfRotationStrategy.js";
import {
  buildBenchmarkMetrics,
  buildScorecardMetrics,
  calendarDaysInclusive,
  formatScorecardMarkdown,
} from "./scorecard.js";

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
const FEED = process.env.ALPACA_DATA_FEED || "iex";

// Same generic BACKTEST_* env vars every other backtest script in this repo
// shares (backtest.ts/backtest-sweep.ts/backtest-portfolio.ts) - BACKTEST_TICKERS
// is deliberately NOT reused here, since this strategy's 5-ETF universe is a
// fixed, different thing from those scripts' stock universe (see
// docs/product/ROADMAP.md Phase 2 / the plan this shipped from).
const DAYS = Number.parseInt(process.env.BACKTEST_DAYS || "900", 10);
const END_DAYS_AGO = Number.parseInt(process.env.BACKTEST_END_DAYS_AGO || "0", 10);
const STARTING_CAPITAL = Number.parseFloat(
  process.env.BACKTEST_STARTING_CAPITAL || "10000",
);
const SLIPPAGE_PERCENT = Number.parseFloat(
  process.env.BACKTEST_SLIPPAGE_PERCENT || "0.0005",
);

// Needs to cover both the momentum lookback (126) and the trend-filter SMA
// (200) with room to spare - matches this repo's existing WARMUP_BARS=210
// convention (backtest-portfolio.ts and others) almost exactly.
const WARMUP_BARS = 210;

const REPORT_DIR = path.resolve(process.cwd(), "data", "backtest-reports", "etf-rotation");

export type ExecutionModel = "close_to_close" | "next_open";

function toIsoDate(date: Date): string {
  return date.toISOString().split("T")[0] ?? date.toISOString();
}

function dateKeyOf(bar: AlpacaBar): string {
  return bar.t.split("T")[0] ?? bar.t;
}

// Duplicated per-script, not shared - same convention as every other
// backtest script in this repo (each keeps its own private fetch function).
async function fetchAlpacaBars(
  ticker: string,
  days: number,
  endDaysAgo: number,
): Promise<AlpacaBar[]> {
  const endDate = new Date();
  endDate.setDate(endDate.getDate() - endDaysAgo);
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

  return allBars.sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
}

interface Alignment {
  commonDates: string[];
  indexByTickerByDate: Map<string, Map<string, number>>;
}

// Same intersection-of-trading-dates approach as backtest-portfolio.ts - a
// ticker's own bars[] array stays untouched (momentum/SMA read a ticker's
// own full history via its own index), only the day-loop's visited dates
// are intersected across the universe.
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

  const commonDates: string[] = [];
  for (const date of unionDates) {
    const allPresent = tickers.every((t) => indexByTickerByDate.get(t)!.has(date));
    if (allPresent) commonDates.push(date);
  }

  commonDates.sort();

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

interface TradeLogEntry {
  date: string;
  ticker: string;
  action: "BUY" | "SELL";
  shares: number;
  price: number;
}

interface EquityCurvePoint {
  date: string;
  equity: number;
  cash: number;
  exposurePercent: number;
  drawdownPercent: number;
}

export interface EtfRotationSimResult {
  finalEquity: number;
  totalPnlPercent: number;
  maxDrawdownPercent: number;
  avgExposurePercent: number;
  totalTrades: number;
  rebalanceCount: number;
  trades: TradeLogEntry[];
  equityCurve: EquityCurvePoint[];
  /** True if a rebalance decided on the last simulated day never got a following day to execute on (next_open only) - a window-edge effect, not dropped silently. */
  finalRebalanceUnexecuted: boolean;
  totalSimDays: number;
}

function priceHistoryUpTo(
  barsByTicker: Map<string, AlpacaBar[]>,
  indexByTickerByDate: Map<string, Map<string, number>>,
  tickers: string[],
  date: string,
): Map<string, number[]> {
  const result = new Map<string, number[]>();

  for (const ticker of tickers) {
    const bars = barsByTicker.get(ticker) ?? [];
    const idx = indexByTickerByDate.get(ticker)?.get(date);
    result.set(ticker, idx === undefined ? [] : bars.slice(0, idx + 1).map((b) => b.c));
  }

  return result;
}

export function runEtfRotationSimulation(
  barsByTicker: Map<string, AlpacaBar[]>,
  tickers: string[],
  commonDates: string[],
  indexByTickerByDate: Map<string, Map<string, number>>,
  simStartIndex: number,
  executionModel: ExecutionModel,
  config: EtfRotationConfig,
): EtfRotationSimResult {
  let cash = STARTING_CAPITAL;
  const holdings = new Map<string, number>();
  const trades: TradeLogEntry[] = [];
  const equityCurve: EquityCurvePoint[] = [];

  let runningPeak = STARTING_CAPITAL;
  let maxDrawdown = 0;
  let exposureSum = 0;
  let rebalanceCount = 0;
  let previousDateKey: string | null = null;
  let pendingTargets: RotationTarget[] | null = null;
  let finalRebalanceUnexecuted = false;

  function priceAt(ticker: string, date: string, field: "o" | "c"): number {
    const idx = indexByTickerByDate.get(ticker)?.get(date);
    const bars = barsByTicker.get(ticker) ?? [];
    return idx === undefined ? 0 : (bars[idx]?.[field] ?? 0);
  }

  function computeEquity(date: string, field: "o" | "c"): number {
    let total = cash;
    for (const [ticker, shares] of holdings) {
      total += shares * priceAt(ticker, date, field);
    }
    return total;
  }

  // Full liquidation + rebuy each rebalance - simpler and easier to reason
  // about than delta-only trading, at the cost of some extra round-trip
  // trades for a ticker that happens to stay in both the old and new
  // target set. Documented simplification (see report caveats), not a
  // hidden one - revisit if trade count matters more than this MVP assumes.
  function executeRebalance(
    targets: RotationTarget[],
    date: string,
    field: "o" | "c",
  ) {
    const equityBeforeTrade = computeEquity(date, field);

    for (const [ticker, shares] of Array.from(holdings.entries())) {
      if (shares <= 0) continue;
      const sellPrice = priceAt(ticker, date, field) * (1 - SLIPPAGE_PERCENT);
      cash += shares * sellPrice;
      trades.push({ date, ticker, action: "SELL", shares, price: sellPrice });
    }
    holdings.clear();

    for (const target of targets) {
      const buyPrice = priceAt(target.ticker, date, field) * (1 + SLIPPAGE_PERCENT);
      if (buyPrice <= 0) continue;
      const targetDollars = (target.weightPercent / 100) * equityBeforeTrade;
      const shares = Math.floor(targetDollars / buyPrice);
      if (shares <= 0) continue;
      cash -= shares * buyPrice;
      holdings.set(target.ticker, shares);
      trades.push({ date, ticker: target.ticker, action: "BUY", shares, price: buyPrice });
    }
  }

  for (let i = simStartIndex; i < commonDates.length; i += 1) {
    const date = commonDates[i]!;

    if (executionModel === "next_open" && pendingTargets !== null) {
      executeRebalance(pendingTargets, date, "o");
      pendingTargets = null;
    }

    if (isMonthlyRebalanceDate(date, previousDateKey)) {
      rebalanceCount += 1;
      const priceHistoryByTicker = priceHistoryUpTo(
        barsByTicker,
        indexByTickerByDate,
        tickers,
        date,
      );
      const targets = decideRotationTargets(priceHistoryByTicker, config);

      if (executionModel === "close_to_close") {
        executeRebalance(targets, date, "c");
      } else {
        pendingTargets = targets;
        if (i === commonDates.length - 1) {
          finalRebalanceUnexecuted = true;
        }
      }
    }

    const equity = computeEquity(date, "c");
    if (equity > runningPeak) runningPeak = equity;
    const drawdownPercent =
      runningPeak > 0 ? ((equity - runningPeak) / runningPeak) * 100 : 0;
    if (drawdownPercent < maxDrawdown) maxDrawdown = drawdownPercent;

    const exposurePercent = equity > 0 ? ((equity - cash) / equity) * 100 : 0;
    exposureSum += exposurePercent;

    equityCurve.push({ date, equity, cash, exposurePercent, drawdownPercent });
    previousDateKey = date;
  }

  const totalSimDays = commonDates.length - simStartIndex;
  const finalEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1]!.equity : STARTING_CAPITAL;

  return {
    finalEquity,
    totalPnlPercent: ((finalEquity - STARTING_CAPITAL) / STARTING_CAPITAL) * 100,
    maxDrawdownPercent: maxDrawdown,
    avgExposurePercent: totalSimDays > 0 ? exposureSum / totalSimDays : 0,
    totalTrades: trades.length,
    rebalanceCount,
    trades,
    equityCurve,
    finalRebalanceUnexecuted,
    totalSimDays,
  };
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
    const leftover = perTickerCapital - shares * startPrice;
    totalFinalValue += shares * endPrice + leftover;
  }

  return ((totalFinalValue - STARTING_CAPITAL) / STARTING_CAPITAL) * 100;
}

export interface EtfRotationWindowAnalysisResult {
  label: string;
  startDate: string;
  endDate: string;
  simDays: number;
  resultsByModel: Map<ExecutionModel, EtfRotationSimResult>;
  buyAndHoldPercent: number;
  spyBuyAndHoldPercent: number | null;
}

export async function runEtfRotationWindowAnalysis(options: {
  label: string;
  days: number;
  endDaysAgo: number;
  config?: EtfRotationConfig;
}): Promise<EtfRotationWindowAnalysisResult> {
  const config = options.config ?? DEFAULT_ETF_ROTATION_CONFIG;
  const barsByTicker = new Map<string, AlpacaBar[]>();

  for (const ticker of config.universe) {
    console.log(`[${options.label}] Fetching ${ticker}...`);
    barsByTicker.set(ticker, await fetchAlpacaBars(ticker, options.days, options.endDaysAgo));
  }

  const { commonDates, indexByTickerByDate } = alignByIntersection(
    barsByTicker,
    config.universe,
  );
  const simStartIndex = findSimStartIndex(commonDates, indexByTickerByDate, config.universe);

  if (simStartIndex >= commonDates.length) {
    throw new Error(
      `[${options.label}] Not enough shared history to clear the warmup window for all tickers - try a larger days value.`,
    );
  }

  const startDate = commonDates[simStartIndex]!;
  const endDate = commonDates[commonDates.length - 1]!;

  const resultsByModel = new Map<ExecutionModel, EtfRotationSimResult>();
  for (const executionModel of ["close_to_close", "next_open"] as const) {
    resultsByModel.set(
      executionModel,
      runEtfRotationSimulation(
        barsByTicker,
        config.universe,
        commonDates,
        indexByTickerByDate,
        simStartIndex,
        executionModel,
        config,
      ),
    );
  }

  const buyAndHoldPercent = computeEqualWeightBuyAndHold(
    barsByTicker,
    config.universe,
    commonDates,
    indexByTickerByDate,
    simStartIndex,
  );
  const spyBuyAndHoldPercent = config.universe.includes("SPY")
    ? computeSingleTickerBuyAndHold(barsByTicker, "SPY", commonDates, indexByTickerByDate, simStartIndex)
    : null;

  return {
    label: options.label,
    startDate,
    endDate,
    simDays: commonDates.length - simStartIndex,
    resultsByModel,
    buyAndHoldPercent,
    spyBuyAndHoldPercent,
  };
}

function pad(value: string, width: number): string {
  return value.padStart(width);
}

async function writeReport(
  analysis: EtfRotationWindowAnalysisResult,
  executionModel: ExecutionModel,
) {
  const result = analysis.resultsByModel.get(executionModel)!;
  const annualizationDays = calendarDaysInclusive(analysis.startDate, analysis.endDate);

  const scorecardMd = formatScorecardMarkdown(
    `ETF rotation (${executionModel})`,
    buildScorecardMetrics({
      totalReturnPercent: result.totalPnlPercent,
      maxDrawdownPercent: result.maxDrawdownPercent,
      avgExposurePercent: result.avgExposurePercent,
      totalTrades: result.totalTrades,
      simTradingDays: result.totalSimDays,
      annualizationDays,
    }),
    [
      buildBenchmarkMetrics("Equal-weight buy & hold (5-ETF universe)", analysis.buyAndHoldPercent, annualizationDays),
      ...(analysis.spyBuyAndHoldPercent !== null
        ? [buildBenchmarkMetrics("SPY buy & hold", analysis.spyBuyAndHoldPercent, annualizationDays)]
        : []),
    ],
  );

  const reportMd = `# ETF rotation backtest report

Generated: ${new Date().toISOString()}

## Run configuration
- Window: ${result.totalSimDays} simulated trading days (${analysis.startDate} to ${analysis.endDate}, ${annualizationDays} calendar days)
- Universe: ${DEFAULT_ETF_ROTATION_CONFIG.universe.join(", ")}
- Starting capital: $${STARTING_CAPITAL}
- Execution model: ${executionModel === "close_to_close" ? "CLOSE_TO_CLOSE (signal and execution both at day's close - a same-bar assumption)" : "NEXT_OPEN (signal at close[d], executed at open[d+1])"}
- Rebalance cadence: monthly (first trading day of each new calendar month)
- Momentum lookback: ${DEFAULT_ETF_ROTATION_CONFIG.momentumLookbackDays} trading days
- Trend filter: price > SMA(${DEFAULT_ETF_ROTATION_CONFIG.trendFilterSmaPeriod})
- Hold count: top ${DEFAULT_ETF_ROTATION_CONFIG.holdCount} by momentum, equal-weighted at 100/holdCount% per slot
- Slippage: ${(SLIPPAGE_PERCENT * 100).toFixed(2)}%

## Result
- Total return: ${result.totalPnlPercent.toFixed(2)}%
- Max drawdown: ${result.maxDrawdownPercent.toFixed(2)}%
- Average exposure: ${result.avgExposurePercent.toFixed(1)}%
- Rebalances: ${result.rebalanceCount}
- Total trades: ${result.totalTrades}
${result.finalRebalanceUnexecuted ? "- A rebalance decided on the last simulated day had no following day to execute on (next_open window-edge effect, not dropped silently).\n" : ""}

## Benchmarks
- Equal-weighted buy & hold (5-ETF universe): ${analysis.buyAndHoldPercent.toFixed(2)}%
- SPY buy & hold: ${analysis.spyBuyAndHoldPercent !== null ? `${analysis.spyBuyAndHoldPercent.toFixed(2)}%` : "n/a"}

${scorecardMd}
## Caveats
- Each rebalance fully liquidates current holdings and rebuys the new target set, rather than trading only the delta - simpler to reason about, but inflates trade count somewhat versus a smarter delta-only rebalancer for any ticker that happens to stay in both the old and new target set. Read "Total trades" with that in mind.
- This backtest does not model bucket cap / circuit breaker / daily kill switch, because the first goal is to measure the clean rotation strategy on diversified ETFs. This does not mean these platform-level protections are disabled or considered unnecessary for future paper/live execution - even an ETF portfolio can hit a prolonged bear market, and the portfolio-level circuit breaker should stay a platform-level safety net regardless of which strategy is running on top of it. Max drawdown is measured here, not actively defended against mid-simulation.
- Uses raw Alpaca daily bars (adjustment=raw). ETF dividends/distributions (SPY/EFA/TLT all pay meaningful yields; GLD does not) are not included, so both the strategy's and the benchmarks' returns are price-return, not total-return. The relative comparison between strategy and benchmark is still apples-to-apples (both miss dividends the same way), but the absolute return numbers above are not real total-return figures, and "beats SPY" should be read as "beats SPY's raw price return," not necessarily its total return. A future research PR should switch to adjusted/total-return data before treating ETF rotation as a real income candidate.
- Single momentum lookback (${DEFAULT_ETF_ROTATION_CONFIG.momentumLookbackDays} trading days) and a single trend filter (SMA${DEFAULT_ETF_ROTATION_CONFIG.trendFilterSmaPeriod}) - not a multi-timeframe blend. A documented MVP simplification, not a limitation discovered late.
- One window, one run - not yet multi-window validated (docs/product/ROADMAP.md Phase 1's own standard). A multi-window companion is the natural next step before treating any result here as a real finding, same phased approach as backtest-portfolio.ts (single-window first, multi-window later).
`;

  const reportDir = path.join(REPORT_DIR, executionModel);
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, "etf-rotation-report.md"), reportMd, "utf-8");
  console.log(`Report written to ${path.join(reportDir, "etf-rotation-report.md")}`);
}

async function main() {
  console.log(
    `ETF rotation backtest: ${DEFAULT_ETF_ROTATION_CONFIG.universe.length} tickers (${DEFAULT_ETF_ROTATION_CONFIG.universe.join(", ")}) | Days: ${DAYS} | Starting capital: $${STARTING_CAPITAL}`,
  );
  console.log("");

  const analysis = await runEtfRotationWindowAnalysis({
    label: "current",
    days: DAYS,
    endDaysAgo: END_DAYS_AGO,
  });

  console.log(
    `Simulated window: ${analysis.simDays} trading days (${analysis.startDate} to ${analysis.endDate})`,
  );
  console.log("");

  console.log("=== Execution model comparison ===");
  console.log(
    "model".padEnd(16) +
      pad("return%", 10) +
      pad("maxDD%", 10) +
      pad("rebalances", 12) +
      pad("trades", 8),
  );
  for (const executionModel of ["close_to_close", "next_open"] as const) {
    const result = analysis.resultsByModel.get(executionModel)!;
    console.log(
      executionModel.padEnd(16) +
        pad(result.totalPnlPercent.toFixed(2), 10) +
        pad(result.maxDrawdownPercent.toFixed(2), 10) +
        pad(String(result.rebalanceCount), 12) +
        pad(String(result.totalTrades), 8),
    );
  }
  console.log("");
  console.log(`Equal-weight buy & hold (5-ETF universe): ${analysis.buyAndHoldPercent.toFixed(2)}%`);
  console.log(
    `SPY buy & hold: ${analysis.spyBuyAndHoldPercent !== null ? `${analysis.spyBuyAndHoldPercent.toFixed(2)}%` : "n/a"}`,
  );
  console.log("");

  await writeReport(analysis, "close_to_close");
  await writeReport(analysis, "next_open");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
