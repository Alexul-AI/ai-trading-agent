// Research-only comparison: does fetching Alpaca bars with adjustment=raw
// (the current default everywhere - live and every backtest script, see
// alpacaBarsFetch.ts/backtest-etf-rotation.ts) vs adjustment=all (dividend/
// distribution-adjusted) actually change which tickers ETF Rotation picks
// each month? Flagged by an external review (2026-08-08) and confirmed real
// via a direct Alpaca API test before this script was written (TLT's raw
// vs all close prices genuinely diverge by ~$0.3-0.7 across a real
// distribution date, adjustment=all is accepted by this account's IEX feed
// with an identical bar count to raw).
//
// This script does NOT change any live behavior - alpacaBarsFetch.ts (live
// worker + dashboard) and every existing backtest script's own default stay
// on "raw", unchanged. The only production-code change this PR makes is one
// optional, additive parameter on backtest-etf-rotation.ts's
// runEtfRotationWindowAnalysis (defaults to "raw", every existing caller
// unaffected - same shape as that function's existing simStartDateOverride
// parameter). Whether to ever change the live default is a separate
// decision, made after reading this script's output, not part of this PR.
//
// Two independent comparisons, matching the user's own priority (picks
// matter more than returns):
// 1. Do the monthly top-picks (and the full momentum ranking behind them)
//    actually differ between raw and adjusted data? Uses the same pure,
//    already-live-and-backtest-shared decideRotationTargets/
//    isMonthlyRebalanceDate (etfRotationStrategy.ts) directly - no new
//    decision logic, just calling the existing one twice per rebalance date.
// 2. How much do returns/max-drawdown/Calmar differ? Reuses the existing,
//    already-validated runEtfRotationWindowAnalysis (not a second, parallel
//    simulation that could subtly diverge from the trusted one).
import { promises as fs } from "fs";
import path from "path";
import dotenv from "dotenv";

import {
  DEFAULT_ETF_ROTATION_CONFIG,
  decideRotationTargets,
  computeMomentumReturnPercent,
  isMonthlyRebalanceDate,
  type EtfRotationConfig,
} from "./etfRotationStrategy.js";
import {
  runEtfRotationWindowAnalysis,
  type EtfRotationWindowAnalysisResult,
} from "./backtest-etf-rotation.js";
import {
  buildBenchmarkMetrics,
  buildScorecardMetrics,
  calendarDaysInclusive,
  formatBenchmarkCsvRow,
  formatScorecardCsvRow,
  SCORECARD_CSV_HEADER,
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

// Same as backtest-etf-rotation.ts's own WARMUP_BARS - momentum(126) +
// SMA(200) need ~210 trading days of runway before decideRotationTargets'
// output is numerically meaningful.
const WARMUP_BARS = 210;

const REPORT_DIR = path.resolve(process.cwd(), "data", "backtest-reports", "etf-rotation");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toIsoDate(date: Date): string {
  return date.toISOString().split("T")[0] ?? date.toISOString();
}

function dateKeyOf(bar: AlpacaBar): string {
  return bar.t.split("T")[0] ?? bar.t;
}

// Duplicated per-script, not shared - same convention as every sibling
// backtest script in this repo.
async function fetchAlpacaBars(
  ticker: string,
  days: number,
  endDaysAgo: number,
  adjustment: "raw" | "all",
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
    url.searchParams.set("adjustment", adjustment);
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
        `Alpaca bars request failed for ${ticker} (adjustment=${adjustment}): HTTP ${response.status} ${body}`,
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

// Duplicated from backtest-etf-rotation.ts's private alignByIntersection -
// same per-script convention, not shared.
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

function daysAgoFromTarget(targetIso: string): number {
  const target = new Date(`${targetIso}T00:00:00Z`);
  const now = new Date();
  return Math.round((now.getTime() - target.getTime()) / MS_PER_DAY);
}

interface WindowConfig {
  label: string;
  days: number;
  endDaysAgo: number;
}

// Identical to backtest-etf-rotation-multiwindow.ts's WINDOWS - so this
// script's findings are directly comparable to the already-published
// multi-window results, not a new, incomparable set.
const WINDOWS: WindowConfig[] = [
  { label: "Current (~900d)", days: 900, endDaysAgo: 0 },
  { label: "Prior (~900d)", days: 900, endDaysAgo: 900 },
  { label: "2022 bear-heavy", days: 900, endDaysAgo: daysAgoFromTarget("2023-06-30") },
  { label: "2023-2024 bull-heavy", days: 750, endDaysAgo: daysAgoFromTarget("2024-12-31") },
  { label: "COVID crash + recovery", days: 900, endDaysAgo: daysAgoFromTarget("2021-12-31") },
];

interface RebalanceComparisonRow {
  window: string;
  date: string;
  rawPicks: string[];
  adjustedPicks: string[];
  picksDiffer: boolean;
  rawRanking: string;
  adjustedRanking: string;
}

function formatRanking(
  priceHistoryByTicker: Map<string, number[]>,
  config: EtfRotationConfig,
): string {
  const ranked = config.universe
    .map((ticker) => {
      const momentum = computeMomentumReturnPercent(
        priceHistoryByTicker.get(ticker) ?? [],
        config.momentumLookbackDays,
      );
      return momentum === null ? null : { ticker, momentum };
    })
    .filter((c): c is { ticker: string; momentum: number } => c !== null)
    .sort((a, b) => b.momentum - a.momentum);

  return ranked.map((c) => `${c.ticker}:${c.momentum.toFixed(2)}%`).join(";");
}

async function comparePicksForWindow(
  window: WindowConfig,
  config: EtfRotationConfig,
): Promise<RebalanceComparisonRow[]> {
  const rawBarsByTicker = new Map<string, AlpacaBar[]>();
  const allBarsByTicker = new Map<string, AlpacaBar[]>();

  for (const ticker of config.universe) {
    console.log(`[${window.label}] Fetching ${ticker} (raw + all)...`);
    rawBarsByTicker.set(
      ticker,
      await fetchAlpacaBars(ticker, window.days, window.endDaysAgo, "raw"),
    );
    allBarsByTicker.set(
      ticker,
      await fetchAlpacaBars(ticker, window.days, window.endDaysAgo, "all"),
    );

    // Defensive check: adjustment changes prices, never which trading days
    // have a bar - if this ever isn't true, the two bar sets can't be
    // compared date-for-date and something is wrong with the assumption
    // this whole script is built on, not just a stray inconsistency.
    const rawCount = rawBarsByTicker.get(ticker)!.length;
    const allCount = allBarsByTicker.get(ticker)!.length;
    if (rawCount !== allCount) {
      throw new Error(
        `[${window.label}] ${ticker}: raw returned ${rawCount} bars but all returned ${allCount} - adjustment changed the trading-day set, cannot align date-for-date.`,
      );
    }
  }

  const rawAlignment = alignByIntersection(rawBarsByTicker, config.universe);
  const simStartIndex = findSimStartIndex(
    rawAlignment.commonDates,
    rawAlignment.indexByTickerByDate,
    config.universe,
  );

  if (simStartIndex >= rawAlignment.commonDates.length) {
    throw new Error(
      `[${window.label}] Not enough shared history to clear the warmup window - try a larger days value.`,
    );
  }

  const rows: RebalanceComparisonRow[] = [];
  let previousDateKey: string | null = null;

  for (let i = simStartIndex; i < rawAlignment.commonDates.length; i += 1) {
    const date = rawAlignment.commonDates[i]!;

    if (isMonthlyRebalanceDate(date, previousDateKey)) {
      const rawPriceHistory = priceHistoryUpTo(
        rawBarsByTicker,
        rawAlignment.indexByTickerByDate,
        config.universe,
        date,
      );
      const adjustedPriceHistory = priceHistoryUpTo(
        allBarsByTicker,
        rawAlignment.indexByTickerByDate,
        config.universe,
        date,
      );

      const rawTargets = decideRotationTargets(rawPriceHistory, config);
      const adjustedTargets = decideRotationTargets(adjustedPriceHistory, config);

      const rawPicks = rawTargets.map((t) => t.ticker).sort();
      const adjustedPicks = adjustedTargets.map((t) => t.ticker).sort();
      const picksDiffer =
        rawPicks.length !== adjustedPicks.length ||
        rawPicks.some((t, idx) => t !== adjustedPicks[idx]);

      rows.push({
        window: window.label,
        date,
        rawPicks,
        adjustedPicks,
        picksDiffer,
        rawRanking: formatRanking(rawPriceHistory, config),
        adjustedRanking: formatRanking(adjustedPriceHistory, config),
      });
    }

    previousDateKey = date;
  }

  return rows;
}

function csvEscape(value: string | number): string {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCsv(rows: (string | number)[][]): string {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n") + "\n";
}

async function buildScorecardRows(
  analysis: EtfRotationWindowAnalysisResult,
  adjustmentLabel: string,
): Promise<(string | number)[][]> {
  const rows: (string | number)[][] = [];
  const annualizationDays = calendarDaysInclusive(analysis.startDate, analysis.endDate);

  for (const executionModel of ["close_to_close", "next_open"] as const) {
    const result = analysis.resultsByModel.get(executionModel)!;

    const metrics = buildScorecardMetrics({
      totalReturnPercent: result.totalPnlPercent,
      maxDrawdownPercent: result.maxDrawdownPercent,
      avgExposurePercent: result.avgExposurePercent,
      totalTrades: result.totalTrades,
      simTradingDays: result.totalSimDays,
      annualizationDays,
    });

    rows.push([
      analysis.label,
      adjustmentLabel,
      ...formatScorecardCsvRow(`ETF rotation (${executionModel})`, metrics),
    ]);
  }

  // Buy-and-hold doesn't depend on execution model (no signal-then-execute
  // lag to model) - one row per window+adjustment, not duplicated per model.
  const benchmark = buildBenchmarkMetrics(
    "Equal-weight buy & hold",
    analysis.buyAndHoldPercent,
    annualizationDays,
  );
  rows.push([analysis.label, adjustmentLabel, ...formatBenchmarkCsvRow(benchmark)]);

  return rows;
}

async function main() {
  const config = DEFAULT_ETF_ROTATION_CONFIG;

  console.log(
    `ETF Rotation raw vs adjustment=all comparison: ${config.universe.length} tickers, ${WINDOWS.length} windows`,
  );
  console.log(
    "Research only - does not change alpacaBarsFetch.ts's live adjustment=raw default, or any other backtest script's own default.",
  );
  console.log("");

  await fs.mkdir(REPORT_DIR, { recursive: true });

  const allPicksRows: RebalanceComparisonRow[] = [];
  const allScorecardRows: (string | number)[][] = [];
  const windowSummaries: {
    label: string;
    totalDates: number;
    differingDates: number;
  }[] = [];

  for (const window of WINDOWS) {
    console.log(`=== ${window.label} ===`);
    const picksRows = await comparePicksForWindow(window, config);
    allPicksRows.push(...picksRows);

    const differingCount = picksRows.filter((r) => r.picksDiffer).length;
    windowSummaries.push({
      label: window.label,
      totalDates: picksRows.length,
      differingDates: differingCount,
    });
    console.log(
      `  ${differingCount} of ${picksRows.length} rebalance dates had different picks between raw and adjusted.`,
    );

    console.log(`  Running full return/drawdown simulation (raw)...`);
    const rawAnalysis = await runEtfRotationWindowAnalysis({ ...window, config, adjustment: "raw" });
    console.log(`  Running full return/drawdown simulation (all)...`);
    const allAnalysis = await runEtfRotationWindowAnalysis({ ...window, config, adjustment: "all" });

    allScorecardRows.push(...(await buildScorecardRows(rawAnalysis, "raw")));
    allScorecardRows.push(...(await buildScorecardRows(allAnalysis, "all")));
    console.log("");
  }

  // --- CSV 1: per-rebalance-date picks comparison ---
  const picksCsvHeader = [
    "window",
    "date",
    "raw_picks",
    "adjusted_picks",
    "picks_differ",
    "raw_ranking",
    "adjusted_ranking",
  ];
  const picksCsvRows = allPicksRows.map((r) => [
    r.window,
    r.date,
    r.rawPicks.join(";"),
    r.adjustedPicks.join(";"),
    r.picksDiffer ? "yes" : "no",
    r.rawRanking,
    r.adjustedRanking,
  ]);
  const picksCsvPath = path.join(REPORT_DIR, "etf-rotation-adjustment-comparison-picks.csv");
  await fs.writeFile(picksCsvPath, toCsv([picksCsvHeader, ...picksCsvRows]), "utf-8");
  console.log(`Picks comparison CSV written to ${picksCsvPath}`);

  // --- CSV 2: return/drawdown scorecard, raw vs all, per window ---
  const scorecardCsvHeader = ["window", "adjustment", ...SCORECARD_CSV_HEADER];
  const scorecardCsvPath = path.join(REPORT_DIR, "etf-rotation-adjustment-comparison-scorecard.csv");
  await fs.writeFile(
    scorecardCsvPath,
    toCsv([scorecardCsvHeader, ...allScorecardRows]),
    "utf-8",
  );
  console.log(`Scorecard comparison CSV written to ${scorecardCsvPath}`);

  // --- Markdown report ---
  const totalDates = windowSummaries.reduce((sum, w) => sum + w.totalDates, 0);
  const totalDiffering = windowSummaries.reduce((sum, w) => sum + w.differingDates, 0);

  const summaryTable = [
    "| Window | Rebalance dates checked | Differing picks | % differing |",
    "| --- | ---: | ---: | ---: |",
    ...windowSummaries.map(
      (w) =>
        `| ${w.label} | ${w.totalDates} | ${w.differingDates} | ${w.totalDates > 0 ? ((w.differingDates / w.totalDates) * 100).toFixed(1) : "0.0"}% |`,
    ),
    `| **Overall** | **${totalDates}** | **${totalDiffering}** | **${totalDates > 0 ? ((totalDiffering / totalDates) * 100).toFixed(1) : "0.0"}%** |`,
  ].join("\n");

  const differingRows = allPicksRows.filter((r) => r.picksDiffer);
  const differingTable =
    differingRows.length === 0
      ? "_None - every checked rebalance date picked the same top tickers under both raw and adjusted data._"
      : [
          "| Window | Date | Raw picks | Adjusted picks |",
          "| --- | --- | --- | --- |",
          ...differingRows.map(
            (r) =>
              `| ${r.window} | ${r.date} | ${r.rawPicks.join(", ") || "(none - cash)"} | ${r.adjustedPicks.join(", ") || "(none - cash)"} |`,
          ),
        ].join("\n");

  const reportMd = `# ETF Rotation: raw vs adjustment=all bars comparison

Generated: ${new Date().toISOString()}

Research only - see the file-level comment in \`backtest-etf-rotation-adjustment-comparison.ts\` for scope. Does not change alpacaBarsFetch.ts's live \`adjustment=raw\` default, or any other backtest script's own default. Config: ${config.universe.join(", ")}, momentum lookback ${config.momentumLookbackDays}d, trend filter SMA(${config.trendFilterSmaPeriod}), holdCount=${config.holdCount}.

## Question 1: do monthly picks/ranking actually change?

${summaryTable}

### Every rebalance date where picks differed

${differingTable}

Full per-date detail (including the full momentum-ranked candidate list for both raw and adjusted, not just the top picks) is in \`etf-rotation-adjustment-comparison-picks.csv\`.

## Question 2: how much do returns/drawdown/Calmar differ?

Full numbers (both execution models, both adjustments, per window) are in \`etf-rotation-adjustment-comparison-scorecard.csv\`. Reuses the existing, already-validated \`runEtfRotationWindowAnalysis\` simulation - not a second, parallel one.

## Reading this report

This is one research pass, not a decision. Whether (and how) to act on any finding here - including whether to ever change the live \`adjustment=raw\` default - is a separate decision to make after reading these numbers, not something this script concludes on its own.
`;

  const reportPath = path.join(REPORT_DIR, "etf-rotation-adjustment-comparison-report.md");
  await fs.writeFile(reportPath, reportMd, "utf-8");
  console.log(`Report written to ${reportPath}`);

  console.log("");
  console.log(
    `TOTAL: ${totalDiffering} of ${totalDates} rebalance dates (${totalDates > 0 ? ((totalDiffering / totalDates) * 100).toFixed(1) : "0.0"}%) had different picks between raw and adjusted bars.`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
