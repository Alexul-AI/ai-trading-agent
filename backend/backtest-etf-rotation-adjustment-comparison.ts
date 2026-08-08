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
// on "raw", unchanged. The only production-code change this line of work
// made (PR #76) is one optional, additive parameter on
// backtest-etf-rotation.ts's runEtfRotationWindowAnalysis (defaults to
// "raw", every existing caller unaffected). Whether to ever change the live
// default is a separate decision, made after reading this script's output,
// not part of this script.
//
// UPDATE (2026-08-08, deep-dive follow-up to PR #76): PR #76 established a
// real, material effect (13.1% of rebalance dates flipped top-2 picks,
// baseline-2 config only). This follow-up goes deeper along 3 axes the
// first pass didn't cover:
// 1. Which tickers gain/lose a slot, broken down by window (this project's
//    established market-regime proxy).
// 2. Full momentum-delta table across EVERY rebalance date (not just flip
//    dates) - quantifies the bias per ticker directly, rather than only
//    inferring it from which dates happened to flip.
// 3. Both config variants (baseline-2, candidate-hold3), not just the
//    production default.
// Concludes with an explicit, PRE-DECLARED verdict ("raw acceptable for
// now" / "adjusted likely better" / "inconclusive") computed mechanically
// from the aggregates - the criteria were fixed before this run, not fitted
// to the result, same discipline as backtest-etf-rotation-forward-validation.ts's
// pre-declared read criteria.
//
// Efficiency note: momentum/trend-filter values do not depend on
// holdCount (ETF_ROTATION_HOLD3_CANDIDATE_CONFIG only changes holdCount,
// universe/momentumLookbackDays/trendFilterSmaPeriod are identical to
// baseline-2 - verified below via assertSharedMomentumInputs) - so bars are
// fetched and momentum is computed ONCE per window, shared across both
// config variants; only decideRotationTargets (cheap, pure, no I/O) runs
// once per variant. Only the full return/drawdown simulation
// (runEtfRotationWindowAnalysis, which does its own internal fetch)
// genuinely doubles per variant.
import { promises as fs } from "fs";
import path from "path";
import dotenv from "dotenv";

import {
  ETF_ROTATION_CONFIG_VARIANTS,
  decideRotationTargets,
  computeMomentumReturnPercent,
  isMonthlyRebalanceDate,
  type EtfRotationConfig,
  type EtfRotationConfigVariantKey,
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
  type ScorecardMetrics,
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

// Fails loud rather than silently sharing bars/momentum across variants
// that turn out to differ in universe/lookback/SMA period - the "compute
// momentum once per window" efficiency below is only correct because these
// are currently identical across every ETF_ROTATION_CONFIG_VARIANTS entry
// (only holdCount differs). If that ever stops being true, this must be
// caught here, not produce silently-wrong shared data.
function assertSharedMomentumInputs(
  variants: [EtfRotationConfigVariantKey, EtfRotationConfig][],
): void {
  const [, first] = variants[0]!;
  for (const [key, config] of variants) {
    const sameUniverse =
      config.universe.length === first.universe.length &&
      config.universe.every((t, i) => t === first.universe[i]);
    if (
      !sameUniverse ||
      config.momentumLookbackDays !== first.momentumLookbackDays ||
      config.trendFilterSmaPeriod !== first.trendFilterSmaPeriod
    ) {
      throw new Error(
        `Config variant "${key}" has a different universe/momentumLookbackDays/trendFilterSmaPeriod than the others - this script's "compute momentum once, shared across variants" optimization is no longer valid. Fix required, not just this assertion.`,
      );
    }
  }
}

interface RebalanceComparisonRow {
  window: string;
  configVariant: string;
  date: string;
  rawPicks: string[];
  adjustedPicks: string[];
  picksDiffer: boolean;
  rawRanking: string;
  adjustedRanking: string;
}

interface MomentumObservation {
  ticker: string;
  window: string;
  date: string;
  rawMomentum: number | null;
  adjustedMomentum: number | null;
}

function computeMomentumByTicker(
  priceHistoryByTicker: Map<string, number[]>,
  config: EtfRotationConfig,
): Map<string, number | null> {
  const result = new Map<string, number | null>();
  for (const ticker of config.universe) {
    result.set(
      ticker,
      computeMomentumReturnPercent(
        priceHistoryByTicker.get(ticker) ?? [],
        config.momentumLookbackDays,
      ),
    );
  }
  return result;
}

function formatRankingFromMomentum(momentumByTicker: Map<string, number | null>): string {
  const ranked = Array.from(momentumByTicker.entries())
    .filter((entry): entry is [string, number] => entry[1] !== null)
    .sort((a, b) => b[1] - a[1]);

  return ranked.map(([ticker, momentum]) => `${ticker}:${momentum.toFixed(2)}%`).join(";");
}

interface WindowComparisonResult {
  picksRowsByVariant: Map<EtfRotationConfigVariantKey, RebalanceComparisonRow[]>;
  momentumObservations: MomentumObservation[];
}

async function compareWindow(
  window: WindowConfig,
  variants: [EtfRotationConfigVariantKey, EtfRotationConfig][],
): Promise<WindowComparisonResult> {
  assertSharedMomentumInputs(variants);
  const sharedConfig = variants[0]![1]; // universe/lookback/SMA identical across variants, asserted above

  const rawBarsByTicker = new Map<string, AlpacaBar[]>();
  const allBarsByTicker = new Map<string, AlpacaBar[]>();

  for (const ticker of sharedConfig.universe) {
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

  const rawAlignment = alignByIntersection(rawBarsByTicker, sharedConfig.universe);
  const simStartIndex = findSimStartIndex(
    rawAlignment.commonDates,
    rawAlignment.indexByTickerByDate,
    sharedConfig.universe,
  );

  if (simStartIndex >= rawAlignment.commonDates.length) {
    throw new Error(
      `[${window.label}] Not enough shared history to clear the warmup window - try a larger days value.`,
    );
  }

  const picksRowsByVariant = new Map<EtfRotationConfigVariantKey, RebalanceComparisonRow[]>();
  for (const [key] of variants) picksRowsByVariant.set(key, []);
  const momentumObservations: MomentumObservation[] = [];

  let previousDateKey: string | null = null;

  for (let i = simStartIndex; i < rawAlignment.commonDates.length; i += 1) {
    const date = rawAlignment.commonDates[i]!;

    if (isMonthlyRebalanceDate(date, previousDateKey)) {
      const rawPriceHistory = priceHistoryUpTo(
        rawBarsByTicker,
        rawAlignment.indexByTickerByDate,
        sharedConfig.universe,
        date,
      );
      const adjustedPriceHistory = priceHistoryUpTo(
        allBarsByTicker,
        rawAlignment.indexByTickerByDate,
        sharedConfig.universe,
        date,
      );

      // Momentum doesn't depend on holdCount - computed once per date,
      // shared across every config variant below.
      const rawMomentumByTicker = computeMomentumByTicker(rawPriceHistory, sharedConfig);
      const adjustedMomentumByTicker = computeMomentumByTicker(adjustedPriceHistory, sharedConfig);

      for (const ticker of sharedConfig.universe) {
        momentumObservations.push({
          ticker,
          window: window.label,
          date,
          rawMomentum: rawMomentumByTicker.get(ticker) ?? null,
          adjustedMomentum: adjustedMomentumByTicker.get(ticker) ?? null,
        });
      }

      const rawRanking = formatRankingFromMomentum(rawMomentumByTicker);
      const adjustedRanking = formatRankingFromMomentum(adjustedMomentumByTicker);

      for (const [variantKey, variantConfig] of variants) {
        const rawTargets = decideRotationTargets(rawPriceHistory, variantConfig);
        const adjustedTargets = decideRotationTargets(adjustedPriceHistory, variantConfig);

        const rawPicks = rawTargets.map((t) => t.ticker).sort();
        const adjustedPicks = adjustedTargets.map((t) => t.ticker).sort();
        const picksDiffer =
          rawPicks.length !== adjustedPicks.length ||
          rawPicks.some((t, idx) => t !== adjustedPicks[idx]);

        picksRowsByVariant.get(variantKey)!.push({
          window: window.label,
          configVariant: variantKey,
          date,
          rawPicks,
          adjustedPicks,
          picksDiffer,
          rawRanking,
          adjustedRanking,
        });
      }
    }

    previousDateKey = date;
  }

  return { picksRowsByVariant, momentumObservations };
}

function csvEscape(value: string | number): string {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCsv(rows: (string | number)[][]): string {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n") + "\n";
}

interface CalmarComparison {
  window: string;
  configVariant: string;
  executionModel: string;
  rawCalmar: number | null;
  allCalmar: number | null;
}

async function buildScorecardRows(
  analysis: EtfRotationWindowAnalysisResult,
  configVariant: string,
  adjustmentLabel: string,
  calmarByModel: Map<string, number | null>,
): Promise<(string | number)[][]> {
  const rows: (string | number)[][] = [];
  const annualizationDays = calendarDaysInclusive(analysis.startDate, analysis.endDate);

  for (const executionModel of ["close_to_close", "next_open"] as const) {
    const result = analysis.resultsByModel.get(executionModel)!;

    const metrics: ScorecardMetrics = buildScorecardMetrics({
      totalReturnPercent: result.totalPnlPercent,
      maxDrawdownPercent: result.maxDrawdownPercent,
      avgExposurePercent: result.avgExposurePercent,
      totalTrades: result.totalTrades,
      simTradingDays: result.totalSimDays,
      annualizationDays,
    });
    calmarByModel.set(executionModel, metrics.calmarRatio);

    rows.push([
      analysis.label,
      configVariant,
      adjustmentLabel,
      ...formatScorecardCsvRow(`ETF rotation (${executionModel})`, metrics),
    ]);
  }

  // Buy-and-hold doesn't depend on execution model (no signal-then-execute
  // lag to model) - one row per window+variant+adjustment, not duplicated
  // per model.
  const benchmark = buildBenchmarkMetrics(
    "Equal-weight buy & hold",
    analysis.buyAndHoldPercent,
    annualizationDays,
  );
  rows.push([analysis.label, configVariant, adjustmentLabel, ...formatBenchmarkCsvRow(benchmark)]);

  return rows;
}

interface TickerFlipTally {
  ticker: string;
  window: string;
  configVariant: string;
  timesGained: number;
  timesLost: number;
}

function aggregateTickerFlips(rows: RebalanceComparisonRow[]): TickerFlipTally[] {
  const tallyByKey = new Map<string, TickerFlipTally>();

  function bump(ticker: string, window: string, configVariant: string, field: "timesGained" | "timesLost") {
    const key = `${ticker}|${window}|${configVariant}`;
    let entry = tallyByKey.get(key);
    if (!entry) {
      entry = { ticker, window, configVariant, timesGained: 0, timesLost: 0 };
      tallyByKey.set(key, entry);
    }
    entry[field] += 1;
  }

  for (const row of rows) {
    if (!row.picksDiffer) continue;

    const gained = row.adjustedPicks.filter((t) => !row.rawPicks.includes(t));
    const lost = row.rawPicks.filter((t) => !row.adjustedPicks.includes(t));

    for (const ticker of gained) bump(ticker, row.window, row.configVariant, "timesGained");
    for (const ticker of lost) bump(ticker, row.window, row.configVariant, "timesLost");
  }

  return Array.from(tallyByKey.values()).sort(
    (a, b) =>
      b.timesGained + b.timesLost - (a.timesGained + a.timesLost) ||
      a.ticker.localeCompare(b.ticker),
  );
}

interface MomentumDeltaSummary {
  ticker: string;
  observations: number;
  meanDeltaPercent: number;
  meanAbsDeltaPercent: number;
}

function aggregateMomentumDeltas(observations: MomentumObservation[]): MomentumDeltaSummary[] {
  const byTicker = new Map<string, { deltas: number[] }>();

  for (const obs of observations) {
    if (obs.rawMomentum === null || obs.adjustedMomentum === null) continue;
    const delta = obs.adjustedMomentum - obs.rawMomentum;
    const entry = byTicker.get(obs.ticker) ?? { deltas: [] };
    entry.deltas.push(delta);
    byTicker.set(obs.ticker, entry);
  }

  const summaries: MomentumDeltaSummary[] = [];
  for (const [ticker, { deltas }] of byTicker) {
    const meanDelta = deltas.reduce((sum, d) => sum + d, 0) / deltas.length;
    const meanAbsDelta = deltas.reduce((sum, d) => sum + Math.abs(d), 0) / deltas.length;
    summaries.push({
      ticker,
      observations: deltas.length,
      meanDeltaPercent: meanDelta,
      meanAbsDeltaPercent: meanAbsDelta,
    });
  }

  return summaries.sort((a, b) => b.meanAbsDeltaPercent - a.meanAbsDeltaPercent);
}

// Distribution-paying tickers in this universe (SPY/QQQ/EFA/TLT/GLD) per
// this project's own documented understanding (CLAUDE.md: "SPY/EFA/TLT all
// pay meaningful yields, GLD does not") - QQQ's yield is negligible enough
// to group with GLD as an effective non-payer for this comparison. Used
// only to state the mechanism criterion below, not to filter any data.
const DISTRIBUTION_PAYERS = ["SPY", "EFA", "TLT"];
const NON_PAYERS = ["QQQ", "GLD"];

interface VerdictResult {
  materialityPercent: number;
  mechanismConfirmed: boolean;
  payerMaxAbsDelta: number;
  nonPayerMaxAbsDelta: number;
  calmarFavorableFraction: number;
  calmarComparisonCount: number;
  verdict: "raw acceptable for now" | "adjusted likely better" | "inconclusive";
  reasoning: string[];
}

// Pre-declared criteria (see the plan this shipped from) - fixed before
// this script's real numbers existed, applied mechanically below, not
// fitted to the result after the fact.
function computeVerdict(
  materialityPercent: number,
  momentumDeltaSummaries: MomentumDeltaSummary[],
  calmarComparisons: CalmarComparison[],
): VerdictResult {
  const reasoning: string[] = [];

  const deltaByTicker = new Map(momentumDeltaSummaries.map((s) => [s.ticker, s.meanAbsDeltaPercent]));
  const payerMaxAbsDelta = Math.max(...DISTRIBUTION_PAYERS.map((t) => deltaByTicker.get(t) ?? 0));
  const nonPayerMaxAbsDelta = Math.max(...NON_PAYERS.map((t) => deltaByTicker.get(t) ?? 0));
  const mechanismConfirmed = payerMaxAbsDelta >= 2 * nonPayerMaxAbsDelta;

  const validComparisons = calmarComparisons.filter(
    (c): c is CalmarComparison & { rawCalmar: number; allCalmar: number } =>
      c.rawCalmar !== null && c.allCalmar !== null,
  );
  const calmarComparisonCount = validComparisons.length;
  const favorableCount = validComparisons.filter((c) => c.allCalmar >= c.rawCalmar).length;
  const calmarFavorableFraction = calmarComparisonCount > 0 ? favorableCount / calmarComparisonCount : 0;

  reasoning.push(
    `Materiality: ${materialityPercent.toFixed(1)}% of rebalance dates had differing picks (threshold: 5%).`,
  );
  reasoning.push(
    `Mechanism: max mean |momentum delta| among distribution-payers (SPY/EFA/TLT) is ${payerMaxAbsDelta.toFixed(3)}pp vs ${nonPayerMaxAbsDelta.toFixed(3)}pp among non-payers (QQQ/GLD) - ${mechanismConfirmed ? "confirmed (payers >= 2x non-payers)" : "not confirmed (payers < 2x non-payers)"}.`,
  );
  reasoning.push(
    `Risk-adjusted consistency: adjustment=all's Calmar ratio was >= raw's in ${favorableCount}/${calmarComparisonCount} window/variant/model combinations (${(calmarFavorableFraction * 100).toFixed(1)}%).`,
  );

  let verdict: VerdictResult["verdict"];
  if (materialityPercent < 5) {
    verdict = "raw acceptable for now";
    reasoning.push("Verdict floor: materiality below 5% - not material enough to justify the operational cost of changing a live data source, regardless of the other two criteria.");
  } else if (mechanismConfirmed && calmarFavorableFraction >= 0.6) {
    verdict = "adjusted likely better";
    reasoning.push("Materiality is above threshold, the mechanism is confirmed as dividend-driven (not noise), and adjustment=all shows better-or-equal risk-adjusted performance in a clear majority of cases.");
  } else if (!mechanismConfirmed || (calmarFavorableFraction > 0.4 && calmarFavorableFraction < 0.6)) {
    verdict = "inconclusive";
    reasoning.push("Materiality is above threshold, but the mechanism and/or risk-adjusted evidence is not clean enough to call a direction confidently - more validation needed before any live change.");
  } else {
    verdict = "raw acceptable for now";
    reasoning.push("Materiality is above threshold, but adjustment=all's risk-adjusted performance was worse in a clear majority of cases - raw is not clearly the inferior choice operationally, despite the confirmed mechanical bias.");
  }

  return {
    materialityPercent,
    mechanismConfirmed,
    payerMaxAbsDelta,
    nonPayerMaxAbsDelta,
    calmarFavorableFraction,
    calmarComparisonCount,
    verdict,
    reasoning,
  };
}

async function main() {
  const variantEntries = Object.entries(ETF_ROTATION_CONFIG_VARIANTS) as [
    EtfRotationConfigVariantKey,
    (typeof ETF_ROTATION_CONFIG_VARIANTS)[EtfRotationConfigVariantKey],
  ][];
  const variantConfigs: [EtfRotationConfigVariantKey, EtfRotationConfig][] = variantEntries.map(
    ([key, variant]) => [key, variant.config],
  );

  console.log(
    `ETF Rotation adjustment deep-dive: ${variantEntries.length} config variants, ${WINDOWS.length} windows`,
  );
  console.log(
    "Research only - does not change alpacaBarsFetch.ts's live adjustment=raw default, or any other backtest script's own default.",
  );
  console.log("");

  await fs.mkdir(REPORT_DIR, { recursive: true });

  const allPicksRows: RebalanceComparisonRow[] = [];
  const allMomentumObservations: MomentumObservation[] = [];
  const allScorecardRows: (string | number)[][] = [];
  const calmarComparisons: CalmarComparison[] = [];

  for (const window of WINDOWS) {
    console.log(`=== ${window.label} ===`);
    const { picksRowsByVariant, momentumObservations } = await compareWindow(window, variantConfigs);
    allMomentumObservations.push(...momentumObservations);

    for (const [variantKey, variant] of variantEntries) {
      const picksRows = picksRowsByVariant.get(variantKey)!;
      allPicksRows.push(...picksRows);

      const differingCount = picksRows.filter((r) => r.picksDiffer).length;
      console.log(
        `  [${variant.label}] ${differingCount} of ${picksRows.length} rebalance dates had different picks.`,
      );

      console.log(`  [${variant.label}] Running full return/drawdown simulation (raw)...`);
      const rawAnalysis = await runEtfRotationWindowAnalysis({
        ...window,
        config: variant.config,
        adjustment: "raw",
      });
      console.log(`  [${variant.label}] Running full return/drawdown simulation (all)...`);
      const allAnalysis = await runEtfRotationWindowAnalysis({
        ...window,
        config: variant.config,
        adjustment: "all",
      });

      const rawCalmarByModel = new Map<string, number | null>();
      const allCalmarByModel = new Map<string, number | null>();
      allScorecardRows.push(
        ...(await buildScorecardRows(rawAnalysis, variantKey, "raw", rawCalmarByModel)),
      );
      allScorecardRows.push(
        ...(await buildScorecardRows(allAnalysis, variantKey, "all", allCalmarByModel)),
      );

      for (const executionModel of ["close_to_close", "next_open"]) {
        calmarComparisons.push({
          window: window.label,
          configVariant: variantKey,
          executionModel,
          rawCalmar: rawCalmarByModel.get(executionModel) ?? null,
          allCalmar: allCalmarByModel.get(executionModel) ?? null,
        });
      }
    }
    console.log("");
  }

  // --- CSV 1: per-rebalance-date picks comparison (now with config_variant) ---
  const picksCsvHeader = [
    "window",
    "config_variant",
    "date",
    "raw_picks",
    "adjusted_picks",
    "picks_differ",
    "raw_ranking",
    "adjusted_ranking",
  ];
  const picksCsvRows = allPicksRows.map((r) => [
    r.window,
    r.configVariant,
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

  // --- CSV 2: return/drawdown scorecard (now with config_variant) ---
  const scorecardCsvHeader = ["window", "config_variant", "adjustment", ...SCORECARD_CSV_HEADER];
  const scorecardCsvPath = path.join(REPORT_DIR, "etf-rotation-adjustment-comparison-scorecard.csv");
  await fs.writeFile(
    scorecardCsvPath,
    toCsv([scorecardCsvHeader, ...allScorecardRows]),
    "utf-8",
  );
  console.log(`Scorecard comparison CSV written to ${scorecardCsvPath}`);

  // --- CSV 3: per-ticker flip tally by window+variant (deep-dive ask 1) ---
  const tickerFlipTally = aggregateTickerFlips(allPicksRows);
  const flipCsvHeader = ["ticker", "window", "config_variant", "times_gained", "times_lost"];
  const flipCsvRows = tickerFlipTally.map((t) => [
    t.ticker,
    t.window,
    t.configVariant,
    t.timesGained,
    t.timesLost,
  ]);
  const flipCsvPath = path.join(REPORT_DIR, "etf-rotation-adjustment-ticker-flip-tally.csv");
  await fs.writeFile(flipCsvPath, toCsv([flipCsvHeader, ...flipCsvRows]), "utf-8");
  console.log(`Ticker flip tally CSV written to ${flipCsvPath}`);

  // --- CSV 4: full momentum-delta table (deep-dive ask 2) ---
  const momentumDeltaSummaries = aggregateMomentumDeltas(allMomentumObservations);
  const deltaCsvHeader = ["ticker", "observations", "mean_delta_pct", "mean_abs_delta_pct"];
  const deltaCsvRows = momentumDeltaSummaries.map((s) => [
    s.ticker,
    s.observations,
    s.meanDeltaPercent.toFixed(4),
    s.meanAbsDeltaPercent.toFixed(4),
  ]);
  const deltaCsvPath = path.join(REPORT_DIR, "etf-rotation-adjustment-momentum-deltas.csv");
  await fs.writeFile(deltaCsvPath, toCsv([deltaCsvHeader, ...deltaCsvRows]), "utf-8");
  console.log(`Momentum delta CSV written to ${deltaCsvPath}`);

  // --- Verdict (deep-dive ask 4) ---
  const totalDates = allPicksRows.length;
  const totalDiffering = allPicksRows.filter((r) => r.picksDiffer).length;
  const materialityPercent = totalDates > 0 ? (totalDiffering / totalDates) * 100 : 0;
  const verdictResult = computeVerdict(materialityPercent, momentumDeltaSummaries, calmarComparisons);

  // --- Markdown report ---
  const perVariantSummary: string[] = [];
  for (const [variantKey, variant] of variantEntries) {
    const variantRows = allPicksRows.filter((r) => r.configVariant === variantKey);
    const variantDiffering = variantRows.filter((r) => r.picksDiffer).length;
    perVariantSummary.push(
      `| ${variant.label} | ${variantRows.length} | ${variantDiffering} | ${variantRows.length > 0 ? ((variantDiffering / variantRows.length) * 100).toFixed(1) : "0.0"}% |`,
    );
  }

  const windowByVariantRows: string[] = [];
  for (const window of WINDOWS) {
    for (const [variantKey, variant] of variantEntries) {
      const rows = allPicksRows.filter((r) => r.window === window.label && r.configVariant === variantKey);
      const differing = rows.filter((r) => r.picksDiffer).length;
      windowByVariantRows.push(
        `| ${window.label} | ${variant.label} | ${rows.length} | ${differing} | ${rows.length > 0 ? ((differing / rows.length) * 100).toFixed(1) : "0.0"}% |`,
      );
    }
  }

  const flipTableRows = tickerFlipTally
    .filter((t) => t.timesGained > 0 || t.timesLost > 0)
    .map((t) => `| ${t.ticker} | ${t.window} | ${t.configVariant} | ${t.timesGained} | ${t.timesLost} |`);

  const deltaTableRows = momentumDeltaSummaries.map(
    (s) =>
      `| ${s.ticker} | ${s.observations} | ${s.meanDeltaPercent >= 0 ? "+" : ""}${s.meanDeltaPercent.toFixed(3)}pp | ${s.meanAbsDeltaPercent.toFixed(3)}pp |`,
  );

  const reportMd = `# ETF Rotation: raw vs adjustment=all - deep dive (tickers, momentum deltas, both config variants)

Generated: ${new Date().toISOString()}

Research only - see the file-level comment in \`backtest-etf-rotation-adjustment-comparison.ts\` for scope. Does not change alpacaBarsFetch.ts's live \`adjustment=raw\` default, or any other backtest script's own default. Follow-up to the first comparison pass (baseline-2 only) - this run covers both config variants: ${variantEntries.map(([, v]) => v.label).join(", ")}.

## Materiality by config variant

| Config variant | Rebalance dates checked | Differing picks | % differing |
| --- | ---: | ---: | ---: |
${perVariantSummary.join("\n")}

## Materiality by window x config variant

| Window | Config variant | Dates checked | Differing | % differing |
| --- | --- | ---: | ---: | ---: |
${windowByVariantRows.join("\n")}

## Which tickers flip (deep-dive ask 1)

Only rows where a ticker actually gained or lost a slot at least once are shown. Full data (including zero rows) in \`etf-rotation-adjustment-ticker-flip-tally.csv\`.

| Ticker | Window | Config variant | Times gained | Times lost |
| --- | --- | --- | ---: | ---: |
${flipTableRows.join("\n")}

## Full momentum-delta table (deep-dive ask 2)

Mean and mean-absolute (\`adjustedMomentum% - rawMomentum%\`) across **every** rebalance date checked (not only the ones where picks flipped), pooled across all windows and both config variants (momentum doesn't depend on holdCount). Full data in \`etf-rotation-adjustment-momentum-deltas.csv\`.

| Ticker | Observations | Mean delta | Mean \\|delta\\| |
| --- | ---: | ---: | ---: |
${deltaTableRows.join("\n")}

Distribution-payers in this universe (SPY/EFA/TLT) vs effective non-payers (QQQ/GLD) - see \`DISTRIBUTION_PAYERS\`/\`NON_PAYERS\` in the script.

## Verdict (deep-dive ask 4) - pre-declared criteria, computed mechanically

**${verdictResult.verdict.toUpperCase()}**

${verdictResult.reasoning.map((r) => `- ${r}`).join("\n")}

Criteria were fixed before this run (see the plan this shipped from), not fitted to the result. This is one research pass, not a production decision - whether (and how) to act on this, including whether to ever change the live \`adjustment=raw\` default, remains a separate decision.

## Full numbers

Return/drawdown/Calmar comparison (both execution models, both adjustments, both config variants, per window) is in \`etf-rotation-adjustment-comparison-scorecard.csv\`. Reuses the existing, already-validated \`runEtfRotationWindowAnalysis\` simulation - not a second, parallel one.
`;

  const reportPath = path.join(REPORT_DIR, "etf-rotation-adjustment-comparison-report.md");
  await fs.writeFile(reportPath, reportMd, "utf-8");
  console.log(`Report written to ${reportPath}`);

  console.log("");
  console.log(`TOTAL: ${totalDiffering} of ${totalDates} rebalance dates (${materialityPercent.toFixed(1)}%) had different picks between raw and adjusted bars, across both config variants.`);
  console.log(`VERDICT: ${verdictResult.verdict}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
