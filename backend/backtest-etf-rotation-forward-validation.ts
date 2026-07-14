import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

import {
  runEtfRotationWindowAnalysis,
  type EtfRotationSimResult,
  type EtfRotationWindowAnalysisResult,
} from "./backtest-etf-rotation.js";
import {
  ETF_ROTATION_MVP_BASELINE_CONFIG,
  ETF_ROTATION_HOLD3_CANDIDATE_CONFIG,
} from "./etfRotationStrategy.js";

dotenv.config();

const APCA_API_KEY_ID = process.env.APCA_API_KEY_ID ?? "";
const APCA_API_SECRET_KEY = process.env.APCA_API_SECRET_KEY ?? "";
const FEED = process.env.ALPACA_DATA_FEED || "iex";

// The target date candidate-hold3 was formally named as an explicit
// candidate (PR #28/#29) and historical out-of-sample validation was
// declared exhausted (PR #30) - a fixed historical fact, not a tunable knob,
// so this is deliberately not an env var. Passed as runEtfRotationWindowAnalysis's
// simStartDateOverride, which pins the simulation's first trading day to the
// first common date >= this value - pre-anchor history is fetched (below)
// purely to give indicators (momentum/SMA) their warmup runway, but it is
// never simulated, traded, or reflected in trades/equityCurve/return/
// drawdown. Without the override, the simulation would start as soon as
// warmup clears - which drifted 26 calendar days *before* this anchor in an
// earlier version of this script (caught in review before merge), including
// pre-anchor performance in what was supposed to be a forward-only read.
const FORWARD_VALIDATION_ANCHOR_DATE = "2026-07-14";

// Comfortably above the ~304-calendar-day equivalent of WARMUP_BARS=210
// trading days (backtest-etf-rotation.ts), so warmup reliably clears before
// reaching the anchor. Overshooting this is harmless now (simStartDateOverride
// pins the actual sim start regardless of how much slack the buffer leaves) -
// unlike before the override existed, there is no longer a precision
// tradeoff in sizing this generously.
const FORWARD_FETCH_WARMUP_BUFFER_DAYS = 330;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const REPORT_DIR = path.resolve(process.cwd(), "data", "backtest-reports", "etf-rotation");
const REPORT_PATH = path.join(REPORT_DIR, "etf-rotation-forward-validation-report.md");
const LOG_CSV_PATH = path.join(REPORT_DIR, "etf-rotation-forward-validation-log.csv");

const LOG_CSV_HEADER = [
  "run_timestamp",
  "anchor_date_target",
  "actual_window_start",
  "actual_window_end",
  "sim_trading_days",
  "rebalance_count",
  "baseline2_return_pct",
  "baseline2_maxdd_pct",
  "candidate3_return_pct",
  "candidate3_maxdd_pct",
  "spy_return_pct",
  "equalweight_return_pct",
].join(",");

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

function toIsoDate(date: Date): string {
  return date.toISOString().split("T")[0] ?? date.toISOString();
}

function dateKeyOf(bar: AlpacaBar): string {
  return bar.t.split("T")[0] ?? bar.t;
}

function daysAgoFromTarget(targetIso: string): number {
  const target = new Date(`${targetIso}T00:00:00Z`);
  const now = new Date();
  return Math.round((now.getTime() - target.getTime()) / MS_PER_DAY);
}

// Same per-script-copy convention as every other backtest script in this
// repo (see backtest-etf-rotation.ts's identical function/comment) - this
// copy only ever needs a small window (the achieved start to today), not the
// main analysis's own fetch.
async function fetchAlpacaBars(ticker: string, days: number, endDaysAgo: number): Promise<AlpacaBar[]> {
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
      throw new Error(`Alpaca bars request failed for ${ticker}: HTTP ${response.status} ${body}`);
    }

    const data = (await response.json()) as AlpacaBarsResponse;
    if (data.bars) allBars.push(...data.bars);
    pageToken = data.next_page_token || undefined;
  } while (pageToken);

  return allBars.sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
}

function priceReturnPercentSince(bars: AlpacaBar[], sinceDate: string): number | null {
  const fromBar = bars.find((b) => dateKeyOf(b) >= sinceDate);
  const toBar = bars[bars.length - 1];
  if (!fromBar || !toBar || fromBar.c <= 0) return null;
  return ((toBar.c - fromBar.c) / fromBar.c) * 100;
}

interface WeightedTrade {
  date: string;
  ticker: string;
  action: "BUY" | "SELL";
  shares: number;
  price: number;
  weightPercentOfEquity: number | null;
}

// Attaches an approximate realized weight% to every trade by joining its
// dollar amount against that date's equity-curve point - the "decisions/
// prices/weights per rebalance" record, with no changes to the shared sim
// engine that produced trades/equityCurve in the first place.
function attachWeights(result: EtfRotationSimResult): WeightedTrade[] {
  const equityByDate = new Map(result.equityCurve.map((p) => [p.date, p.equity]));
  return result.trades.map((t) => {
    const equityThatDay = equityByDate.get(t.date);
    const dollarAmount = t.shares * t.price;
    const weightPercentOfEquity =
      equityThatDay && equityThatDay > 0 ? (dollarAmount / equityThatDay) * 100 : null;
    return { ...t, weightPercentOfEquity };
  });
}

function pad(value: string, width: number): string {
  return value.padStart(width);
}

function formatTrades(trades: WeightedTrade[]): string {
  if (trades.length === 0) return "_(none yet)_";
  return trades
    .map(
      (t) =>
        `- ${t.date} ${t.action} ${t.ticker} - ${t.shares} sh @ $${t.price.toFixed(2)}${
          t.weightPercentOfEquity !== null ? ` (~${t.weightPercentOfEquity.toFixed(1)}% of equity)` : ""
        }`,
    )
    .join("\n");
}

async function writeForwardReport(
  baselineAnalysis: EtfRotationWindowAnalysisResult,
  candidateAnalysis: EtfRotationWindowAnalysisResult,
  baselineTrades: WeightedTrade[],
  candidateTrades: WeightedTrade[],
  spyReturnPercent: number | null,
  equalWeightReturnPercent: number | null,
  readText: string,
  startGapCalendarDays: number,
) {
  const baselineResult = baselineAnalysis.resultsByModel.get("next_open")!;
  const candidateResult = candidateAnalysis.resultsByModel.get("next_open")!;
  const gapText =
    startGapCalendarDays < 0
      ? `**WARNING: ${-startGapCalendarDays} day(s) BEFORE the target anchor - simStartDateOverride should have prevented this, treat this run as suspect.**`
      : startGapCalendarDays === 0
        ? `exactly on the target anchor (no pre-anchor data included)`
        : `${startGapCalendarDays} calendar day(s) after the target anchor (the anchor fell on a non-trading day; still no pre-anchor data included)`;

  const md = `# ETF rotation forward validation report

Generated: ${new Date().toISOString()}
Target anchor (candidate-hold3 named, historical out-of-sample declared exhausted): ${FORWARD_VALIDATION_ANCHOR_DATE}

## Simulated window (fresh cash start, pinned to the anchor)
- baseline-2: ${baselineAnalysis.startDate} to ${baselineAnalysis.endDate} (${baselineResult.totalSimDays} trading days)
- candidate-hold3: ${candidateAnalysis.startDate} to ${candidateAnalysis.endDate} (${candidateResult.totalSimDays} trading days)
- Achieved start is ${gapText}.

Both simulations start with pure cash and execute their first rebalance immediately on day one (isMonthlyRebalanceDate's "first simulated day" rule). The simulated window is pinned to never start earlier than the anchor (via runEtfRotationWindowAnalysis's simStartDateOverride) - pre-anchor price history is used only to warm up momentum/SMA indicators, never simulated or traded. This fixes a real bug caught in review before merge: an earlier version of this script let the simulation start wherever warmup happened to clear, which drifted 26 calendar days before the anchor and included pre-anchor performance in what was meant to be a forward-only read (see PR #31 review).

## Result (NEXT_OPEN)
| series | return% | maxDD% | trading days | rebalances |
|---|---|---|---|---|
| baseline-2 | ${baselineResult.totalPnlPercent.toFixed(2)} | ${baselineResult.maxDrawdownPercent.toFixed(2)} | ${baselineResult.totalSimDays} | ${baselineResult.rebalanceCount} |
| candidate-hold3 | ${candidateResult.totalPnlPercent.toFixed(2)} | ${candidateResult.maxDrawdownPercent.toFixed(2)} | ${candidateResult.totalSimDays} | ${candidateResult.rebalanceCount} |
${
  baselineResult.finalRebalanceUnexecuted || candidateResult.finalRebalanceUnexecuted
    ? "\nA rebalance decided on the last simulated day had no following day to execute on yet (NEXT_OPEN window-edge effect) - it will appear in the Decisions section below once this script is re-run after that day has passed, not dropped silently.\n"
    : ""
}

## Benchmarks (same period, context)
- SPY buy & hold: ${spyReturnPercent !== null ? `${spyReturnPercent.toFixed(2)}%` : "n/a"}
- Equal-weight 5-ETF (approx. - simple average of individual price returns, not a whole-share rebalanced sim): ${equalWeightReturnPercent !== null ? `${equalWeightReturnPercent.toFixed(2)}%` : "n/a"}

## Decisions - baseline-2
${formatTrades(baselineTrades)}

## Decisions - candidate-hold3
${formatTrades(candidateTrades)}

## Pre-declared read criteria (written before any forward data existed)
- 0 rebalances: nothing to read yet.
- 1-2 rebalances (~1-2 months): report the numbers, informational only - too early for a promotion decision.
- 3+ rebalances (~3 months, matching the original estimate): candidate-hold3 is read as "holding up so far" only if BOTH (a) its max drawdown is not worse than baseline-2's, and (b) its return is not worse than baseline-2's by more than 5 percentage points. Either condition failing is a flagged concern worth more data/discussion, not an automatic rejection.
- Regardless of the read at any sample size: this is supplementary color on top of the already-completed historical multi-window validation (PR #27/#28), not a replacement for it. It does not by itself trigger promoting candidate-hold3 to DEFAULT_ETF_ROTATION_CONFIG - that stays a separate, explicit, user-approved step.

## Current read
${readText}

## Caveats
- Raw Alpaca bars (adjustment=raw) - no dividends/distributions, same caveat as every other ETF rotation report in this repo.
- The equal-weight benchmark above is an approximation (simple average of five individual price returns), not a whole-share rebalanced simulation like this strategy's own whole-window benchmark elsewhere in this repo.
- The simulated window is intentionally short and grows only by re-running this script later (each run re-fetches from a fresh anchor-sized window, so day counts are not directly comparable run-to-run the way the accumulating CSV log's rebalance_count column is).
- Small sample by construction - this only grows richer over repeated future runs of this script. See the pre-declared criteria above for how to read it at different sample sizes.
- This script performs no trades and touches no live/paper execution path - it only reads Alpaca's historical/current bars, the same as every other backtest script in this repo.
`;

  await fs.mkdir(REPORT_DIR, { recursive: true });
  await fs.writeFile(REPORT_PATH, md, "utf-8");
  console.log(`Report written to ${REPORT_PATH}`);
}

async function appendForwardLogRow(row: (string | number)[]) {
  await fs.mkdir(REPORT_DIR, { recursive: true });
  let needsHeader = true;
  try {
    await fs.access(LOG_CSV_PATH);
    needsHeader = false;
  } catch {
    needsHeader = true;
  }
  const line = `${row.join(",")}\n`;
  await fs.appendFile(LOG_CSV_PATH, needsHeader ? `${LOG_CSV_HEADER}\n${line}` : line, "utf-8");
  console.log(`Log row appended to ${LOG_CSV_PATH}`);
}

async function main() {
  console.log(`ETF rotation forward validation - target anchor: ${FORWARD_VALIDATION_ANCHOR_DATE}`);
  console.log(
    "Compares baseline-2 vs candidate-hold3 (both run unconditionally), each simulated fresh " +
      "with pure cash and pinned to never start before the anchor (simStartDateOverride) - not a " +
      "slice of an older, already-running portfolio, and no pre-anchor days leaking into the " +
      "result. Data since the anchor did not exist when candidate-hold3 was named (PR #28/#29) " +
      "or when historical out-of-sample validation was declared exhausted (PR #30).",
  );
  console.log("");

  const fetchDays = daysAgoFromTarget(FORWARD_VALIDATION_ANCHOR_DATE) + FORWARD_FETCH_WARMUP_BUFFER_DAYS;

  const baselineAnalysis = await runEtfRotationWindowAnalysis({
    label: "Forward (baseline-2)",
    days: fetchDays,
    endDaysAgo: 0,
    config: ETF_ROTATION_MVP_BASELINE_CONFIG,
    simStartDateOverride: FORWARD_VALIDATION_ANCHOR_DATE,
  });
  const candidateAnalysis = await runEtfRotationWindowAnalysis({
    label: "Forward (candidate-hold3)",
    days: fetchDays,
    endDaysAgo: 0,
    config: ETF_ROTATION_HOLD3_CANDIDATE_CONFIG,
    simStartDateOverride: FORWARD_VALIDATION_ANCHOR_DATE,
  });

  console.log(`Baseline-2 actual simulated range: ${baselineAnalysis.startDate} to ${baselineAnalysis.endDate}`);
  console.log(`Candidate-hold3 actual simulated range: ${candidateAnalysis.startDate} to ${candidateAnalysis.endDate}`);
  if (baselineAnalysis.startDate !== candidateAnalysis.startDate) {
    console.log(
      `WARNING: baseline-2 and candidate-hold3 achieved different start dates (expected to match since both share the same universe/fetch params) - likely an Alpaca data hiccup between the two sequential fetches.`,
    );
  }
  // simStartDateOverride guarantees simStartIndex >= the first common date
  // >= the anchor, so this gap should only ever be 0 (anchor was a trading
  // day) or positive (anchor fell on a weekend/holiday, so the sim starts on
  // the next trading day after it) - never negative. A negative value here
  // would mean the override failed to take effect and pre-anchor data DID
  // leak into the simulated window (a real bug, not an accepted imprecision)
  // - printed regardless, not hidden.
  const anchorMs = new Date(`${FORWARD_VALIDATION_ANCHOR_DATE}T00:00:00Z`).getTime();
  const startMs = new Date(`${baselineAnalysis.startDate}T00:00:00Z`).getTime();
  const startGapCalendarDays = Math.round((startMs - anchorMs) / MS_PER_DAY);
  if (startGapCalendarDays < 0) {
    console.log(
      `WARNING: achieved start (${baselineAnalysis.startDate}) is BEFORE the target anchor (${FORWARD_VALIDATION_ANCHOR_DATE}) by ${-startGapCalendarDays} day(s) - simStartDateOverride should have prevented this, treat this run's numbers as suspect and investigate.`,
    );
  } else if (startGapCalendarDays === 0) {
    console.log(`Achieved start lands exactly on the target anchor - no pre-anchor data included.`);
  } else {
    console.log(
      `Achieved start is ${startGapCalendarDays} calendar day(s) after the target anchor (the anchor fell on a non-trading day) - still no pre-anchor data included.`,
    );
  }
  console.log("");

  const baselineResult = baselineAnalysis.resultsByModel.get("next_open")!;
  const candidateResult = candidateAnalysis.resultsByModel.get("next_open")!;
  const baselineTrades = attachWeights(baselineResult);
  const candidateTrades = attachWeights(candidateResult);

  // Small separate fetch, just for the SPY/equal-weight benchmarks over the
  // same actual period - see attachWeights/module comments for why this
  // isn't derived from the main analysis above.
  const universe = ETF_ROTATION_MVP_BASELINE_CONFIG.universe;
  const smallFetchDays = daysAgoFromTarget(baselineAnalysis.startDate) + 5;
  const barsByTicker = new Map<string, AlpacaBar[]>();
  for (const ticker of universe) {
    barsByTicker.set(ticker, await fetchAlpacaBars(ticker, smallFetchDays, 0));
  }
  const spyReturnPercent = priceReturnPercentSince(barsByTicker.get("SPY") ?? [], baselineAnalysis.startDate);
  const perTickerReturns = universe
    .map((t) => priceReturnPercentSince(barsByTicker.get(t) ?? [], baselineAnalysis.startDate))
    .filter((r): r is number => r !== null);
  const equalWeightReturnPercent =
    perTickerReturns.length > 0 ? perTickerReturns.reduce((a, b) => a + b, 0) / perTickerReturns.length : null;

  console.log("=== Result, NEXT_OPEN (fresh-cash simulation since the anchor) ===");
  console.log(
    "series".padEnd(24) + pad("return%", 10) + pad("maxDD%", 10) + pad("trading days", 14) + pad("rebalances", 12),
  );
  console.log(
    "baseline-2".padEnd(24) +
      pad(baselineResult.totalPnlPercent.toFixed(2), 10) +
      pad(baselineResult.maxDrawdownPercent.toFixed(2), 10) +
      pad(String(baselineResult.totalSimDays), 14) +
      pad(String(baselineResult.rebalanceCount), 12),
  );
  console.log(
    "candidate-hold3".padEnd(24) +
      pad(candidateResult.totalPnlPercent.toFixed(2), 10) +
      pad(candidateResult.maxDrawdownPercent.toFixed(2), 10) +
      pad(String(candidateResult.totalSimDays), 14) +
      pad(String(candidateResult.rebalanceCount), 12),
  );
  if (baselineResult.finalRebalanceUnexecuted || candidateResult.finalRebalanceUnexecuted) {
    console.log(
      "A rebalance decided on the last simulated day had no following day to execute on yet (NEXT_OPEN window-edge effect) - it'll show up in Decisions once re-run after that day passes, not dropped silently.",
    );
  }
  console.log("");
  console.log(`SPY buy & hold (same period, context): ${spyReturnPercent !== null ? `${spyReturnPercent.toFixed(2)}%` : "n/a"}`);
  console.log(
    `Equal-weight 5-ETF (same period, context, approx.): ${equalWeightReturnPercent !== null ? `${equalWeightReturnPercent.toFixed(2)}%` : "n/a"}`,
  );
  console.log("");

  // Rebalance dates depend only on the calendar (isMonthlyRebalanceDate),
  // not on holdCount, and both configs share the same simulated window, so
  // this count is expected to match between them - using baseline-2's as
  // the single count.
  const rebalanceCount = baselineResult.rebalanceCount;
  console.log("=== Read (pre-declared criteria - see docs/product/ROADMAP.md Phase 2) ===");
  let readText: string;
  if (rebalanceCount === 0) {
    readText = "0 rebalances since the anchor - nothing to read yet.";
  } else if (rebalanceCount < 3) {
    readText = `${rebalanceCount} rebalance(s) since the anchor - too early for a promotion decision, informational only.`;
  } else {
    const ddOk = candidateResult.maxDrawdownPercent >= baselineResult.maxDrawdownPercent;
    const returnGap = candidateResult.totalPnlPercent - baselineResult.totalPnlPercent;
    const returnOk = returnGap >= -5;
    readText =
      ddOk && returnOk
        ? `${rebalanceCount} rebalances since the anchor - candidate-hold3 holding up so far (maxDD not worse, return within 5pt tolerance of baseline-2).`
        : `${rebalanceCount} rebalances since the anchor - concern flagged (${ddOk ? "" : "maxDD worse than baseline-2. "}${returnOk ? "" : "return more than 5pt worse than baseline-2."}) - worth more data/discussion, not an automatic rejection.`;
  }
  console.log(readText);
  console.log(
    "This is supplementary color on top of the already-completed historical multi-window validation (PR #27/#28), " +
      "not a replacement for it, and does not by itself trigger promoting candidate-hold3 to DEFAULT_ETF_ROTATION_CONFIG.",
  );
  console.log("");

  await writeForwardReport(
    baselineAnalysis,
    candidateAnalysis,
    baselineTrades,
    candidateTrades,
    spyReturnPercent,
    equalWeightReturnPercent,
    readText,
    startGapCalendarDays,
  );

  await appendForwardLogRow([
    new Date().toISOString(),
    FORWARD_VALIDATION_ANCHOR_DATE,
    baselineAnalysis.startDate,
    baselineAnalysis.endDate,
    baselineResult.totalSimDays,
    rebalanceCount,
    baselineResult.totalPnlPercent.toFixed(2),
    baselineResult.maxDrawdownPercent.toFixed(2),
    candidateResult.totalPnlPercent.toFixed(2),
    candidateResult.maxDrawdownPercent.toFixed(2),
    spyReturnPercent !== null ? spyReturnPercent.toFixed(2) : "n/a",
    equalWeightReturnPercent !== null ? equalWeightReturnPercent.toFixed(2) : "n/a",
  ]);
}

// Same guard as backtest-portfolio.ts/backtest-etf-rotation.ts - without
// this, importing this file's exports (none currently, but kept consistent
// with the sibling scripts) would also silently re-run main().
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
