import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

import {
  runEtfRotationWindowAnalysis,
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

// The date candidate-hold3 was formally named as an explicit candidate
// (PR #28/#29) and historical out-of-sample validation was declared
// exhausted (PR #30) - a fixed historical fact anchoring what counts as
// genuinely new/forward data, not a tunable knob. Deliberately NOT an env
// var for that reason.
const FORWARD_VALIDATION_ANCHOR_DATE = "2026-07-14";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const REPORT_DIR = path.resolve(process.cwd(), "data", "backtest-reports", "etf-rotation");
const REPORT_PATH = path.join(REPORT_DIR, "etf-rotation-forward-validation-report.md");
const LOG_CSV_PATH = path.join(REPORT_DIR, "etf-rotation-forward-validation-log.csv");

const LOG_CSV_HEADER = [
  "run_timestamp",
  "anchor_date",
  "actual_window_start",
  "actual_window_end",
  "forward_trading_days",
  "forward_rebalance_count",
  "baseline2_forward_return_pct",
  "baseline2_forward_maxdd_pct",
  "candidate3_forward_return_pct",
  "candidate3_forward_maxdd_pct",
  "spy_forward_return_pct",
  "equalweight_forward_return_pct",
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
// copy only ever needs a small window (anchor to today), not the full
// 900-day fetch the main analysis below uses.
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

function priceReturnPercentSinceAnchor(bars: AlpacaBar[], anchorDate: string): number | null {
  const fromBar = bars.find((b) => dateKeyOf(b) >= anchorDate);
  const toBar = bars[bars.length - 1];
  if (!fromBar || !toBar || fromBar.c <= 0) return null;
  return ((toBar.c - fromBar.c) / fromBar.c) * 100;
}

interface ForwardTrade {
  date: string;
  ticker: string;
  action: "BUY" | "SELL";
  shares: number;
  price: number;
  weightPercentOfEquity: number | null;
}

interface ForwardSlice {
  forwardReturnPercent: number;
  forwardMaxDrawdownPercent: number;
  forwardTradingDays: number;
  forwardRebalanceCount: number;
  forwardTrades: ForwardTrade[];
}

// Derives forward-only, anchor-rebased metrics from an already-computed
// whole-window analysis, rather than trying to pin runEtfRotationWindowAnalysis's
// own simulated start date exactly to the anchor (its warmup-clearing logic
// always starts as early as the fetched data allows, so forcing an exact
// start date would mean fragile fetch-window buffer sizing). Peak/drawdown
// tracking is reset at the anchor point - this is NOT comparable to the
// whole-window max drawdown numbers published elsewhere for this strategy.
function computeForwardSlice(
  analysis: EtfRotationWindowAnalysisResult,
  anchorDate: string,
): ForwardSlice | null {
  const result = analysis.resultsByModel.get("next_open")!;
  const anchorIndex = result.equityCurve.findIndex((p) => p.date >= anchorDate);
  if (anchorIndex === -1) return null;

  const slice = result.equityCurve.slice(anchorIndex);
  const equityAtAnchor = slice[0]!.equity;
  const equityAtEnd = slice[slice.length - 1]!.equity;
  const forwardReturnPercent =
    equityAtAnchor > 0 ? ((equityAtEnd - equityAtAnchor) / equityAtAnchor) * 100 : 0;

  const equityByDate = new Map(slice.map((p) => [p.date, p.equity]));
  let peak = equityAtAnchor;
  let maxDrawdown = 0;
  for (const point of slice) {
    if (point.equity > peak) peak = point.equity;
    const dd = peak > 0 ? ((point.equity - peak) / peak) * 100 : 0;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  const forwardTrades: ForwardTrade[] = result.trades
    .filter((t) => t.date >= anchorDate)
    .map((t) => {
      const equityThatDay = equityByDate.get(t.date);
      const dollarAmount = t.shares * t.price;
      const weightPercentOfEquity =
        equityThatDay && equityThatDay > 0 ? (dollarAmount / equityThatDay) * 100 : null;
      return { ...t, weightPercentOfEquity };
    });

  const forwardRebalanceCount = new Set(forwardTrades.map((t) => t.date)).size;

  return {
    forwardReturnPercent,
    forwardMaxDrawdownPercent: maxDrawdown,
    forwardTradingDays: slice.length,
    forwardRebalanceCount,
    forwardTrades,
  };
}

function pad(value: string, width: number): string {
  return value.padStart(width);
}

function formatTrades(trades: ForwardTrade[]): string {
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
  anchorDate: string,
  baselineAnalysis: EtfRotationWindowAnalysisResult,
  candidateAnalysis: EtfRotationWindowAnalysisResult,
  baselineForward: ForwardSlice,
  candidateForward: ForwardSlice,
  spyForwardReturnPercent: number | null,
  equalWeightForwardReturnPercent: number | null,
  readText: string,
) {
  const md = `# ETF rotation forward validation report

Generated: ${new Date().toISOString()}
Anchor date (candidate-hold3 named, historical out-of-sample declared exhausted): ${anchorDate}

## Actual window ranges
- baseline-2: ${baselineAnalysis.startDate} to ${baselineAnalysis.endDate}
- candidate-hold3: ${candidateAnalysis.startDate} to ${candidateAnalysis.endDate}

## Forward slice (since anchor) - NEXT_OPEN
| series | return% | maxDD% | trading days | rebalances |
|---|---|---|---|---|
| baseline-2 | ${baselineForward.forwardReturnPercent.toFixed(2)} | ${baselineForward.forwardMaxDrawdownPercent.toFixed(2)} | ${baselineForward.forwardTradingDays} | ${baselineForward.forwardRebalanceCount} |
| candidate-hold3 | ${candidateForward.forwardReturnPercent.toFixed(2)} | ${candidateForward.forwardMaxDrawdownPercent.toFixed(2)} | ${candidateForward.forwardTradingDays} | ${candidateForward.forwardRebalanceCount} |

## Benchmarks (forward-only, context - not a rebased simulation)
- SPY: ${spyForwardReturnPercent !== null ? `${spyForwardReturnPercent.toFixed(2)}%` : "n/a"}
- Equal-weight 5-ETF (approx. - simple average of individual price returns since anchor, not a whole-share rebalanced sim): ${equalWeightForwardReturnPercent !== null ? `${equalWeightForwardReturnPercent.toFixed(2)}%` : "n/a"}

## Decisions since anchor - baseline-2
${formatTrades(baselineForward.forwardTrades)}

## Decisions since anchor - candidate-hold3
${formatTrades(candidateForward.forwardTrades)}

## Pre-declared read criteria (written before any forward data existed)
- 0 rebalances since anchor: nothing to read yet.
- 1-2 rebalances since anchor (~1-2 months): report the numbers, informational only - too early for a promotion decision.
- 3+ rebalances since anchor (~3 months, matching the original estimate): candidate-hold3 is read as "holding up so far" only if BOTH (a) its forward max drawdown is not worse than baseline-2's, and (b) its forward return is not worse than baseline-2's by more than 5 percentage points. Either condition failing is a flagged concern worth more data/discussion, not an automatic rejection.
- Regardless of the read at any sample size: this is supplementary color on top of the already-completed historical multi-window validation (PR #27/#28), not a replacement for it. It does not by itself trigger promoting candidate-hold3 to DEFAULT_ETF_ROTATION_CONFIG - that stays a separate, explicit, user-approved step.

## Current read
${readText}

## Caveats
- Raw Alpaca bars (adjustment=raw) - no dividends/distributions, same caveat as every other ETF rotation report in this repo.
- The equal-weight forward benchmark above is an approximation (simple average of five individual price returns since anchor), not a whole-share rebalanced simulation like the main analysis' whole-window benchmark.
- Forward max drawdown is measured only within the post-anchor slice (peak reset at the anchor date) - it is not comparable to the whole-window max drawdown numbers published elsewhere for this strategy.
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
  console.log(`ETF rotation forward validation - anchor date: ${FORWARD_VALIDATION_ANCHOR_DATE}`);
  console.log(
    "Compares baseline-2 vs candidate-hold3 (both run unconditionally) on the slice of data " +
      "dated on/after the anchor - data that did not exist when candidate-hold3 was named " +
      "(PR #28/#29) or when historical out-of-sample validation was declared exhausted (PR #30).",
  );
  console.log("");

  const baselineAnalysis = await runEtfRotationWindowAnalysis({
    label: "Forward (baseline-2)",
    days: 900,
    endDaysAgo: 0,
    config: ETF_ROTATION_MVP_BASELINE_CONFIG,
  });
  const candidateAnalysis = await runEtfRotationWindowAnalysis({
    label: "Forward (candidate-hold3)",
    days: 900,
    endDaysAgo: 0,
    config: ETF_ROTATION_HOLD3_CANDIDATE_CONFIG,
  });

  console.log(`Baseline-2 actual range: ${baselineAnalysis.startDate} to ${baselineAnalysis.endDate}`);
  console.log(`Candidate-hold3 actual range: ${candidateAnalysis.startDate} to ${candidateAnalysis.endDate}`);
  console.log("");

  const baselineForward = computeForwardSlice(baselineAnalysis, FORWARD_VALIDATION_ANCHOR_DATE);
  const candidateForward = computeForwardSlice(candidateAnalysis, FORWARD_VALIDATION_ANCHOR_DATE);

  if (!baselineForward || !candidateForward) {
    console.log(
      `No trading days at/after the anchor date (${FORWARD_VALIDATION_ANCHOR_DATE}) yet - re-run this script after some time has passed.`,
    );
    return;
  }

  // Small separate fetch, just for the SPY/equal-weight forward-only
  // benchmarks - see the module comment on computeForwardSlice for why this
  // isn't derived from the main analysis above.
  const universe = ETF_ROTATION_MVP_BASELINE_CONFIG.universe;
  const smallFetchDays = daysAgoFromTarget(FORWARD_VALIDATION_ANCHOR_DATE) + 5;
  const barsByTicker = new Map<string, AlpacaBar[]>();
  for (const ticker of universe) {
    barsByTicker.set(ticker, await fetchAlpacaBars(ticker, smallFetchDays, 0));
  }
  const spyForwardReturnPercent = priceReturnPercentSinceAnchor(
    barsByTicker.get("SPY") ?? [],
    FORWARD_VALIDATION_ANCHOR_DATE,
  );
  const perTickerForwardReturns = universe
    .map((t) => priceReturnPercentSinceAnchor(barsByTicker.get(t) ?? [], FORWARD_VALIDATION_ANCHOR_DATE))
    .filter((r): r is number => r !== null);
  const equalWeightForwardReturnPercent =
    perTickerForwardReturns.length > 0
      ? perTickerForwardReturns.reduce((a, b) => a + b, 0) / perTickerForwardReturns.length
      : null;

  console.log("=== Forward slice (since anchor), NEXT_OPEN ===");
  console.log(
    "series".padEnd(24) + pad("return%", 10) + pad("maxDD%", 10) + pad("trading days", 14) + pad("rebalances", 12),
  );
  console.log(
    "baseline-2".padEnd(24) +
      pad(baselineForward.forwardReturnPercent.toFixed(2), 10) +
      pad(baselineForward.forwardMaxDrawdownPercent.toFixed(2), 10) +
      pad(String(baselineForward.forwardTradingDays), 14) +
      pad(String(baselineForward.forwardRebalanceCount), 12),
  );
  console.log(
    "candidate-hold3".padEnd(24) +
      pad(candidateForward.forwardReturnPercent.toFixed(2), 10) +
      pad(candidateForward.forwardMaxDrawdownPercent.toFixed(2), 10) +
      pad(String(candidateForward.forwardTradingDays), 14) +
      pad(String(candidateForward.forwardRebalanceCount), 12),
  );
  console.log("");
  console.log(
    `SPY forward-only (context, not rebased sim): ${spyForwardReturnPercent !== null ? `${spyForwardReturnPercent.toFixed(2)}%` : "n/a"}`,
  );
  console.log(
    `Equal-weight 5-ETF forward-only (context, approx.): ${equalWeightForwardReturnPercent !== null ? `${equalWeightForwardReturnPercent.toFixed(2)}%` : "n/a"}`,
  );
  console.log("");

  // Rebalance dates depend only on the calendar (isMonthlyRebalanceDate),
  // not on holdCount, so this count is expected to match between the two
  // configs for the same window - using baseline-2's as the single count.
  const rebalanceCount = baselineForward.forwardRebalanceCount;
  console.log("=== Read (pre-declared criteria - see docs/product/ROADMAP.md Phase 2) ===");
  let readText: string;
  if (rebalanceCount === 0) {
    readText = "0 rebalances since anchor - nothing to read yet.";
  } else if (rebalanceCount < 3) {
    readText = `${rebalanceCount} rebalance(s) since anchor - too early for a promotion decision, informational only.`;
  } else {
    const ddOk = candidateForward.forwardMaxDrawdownPercent >= baselineForward.forwardMaxDrawdownPercent;
    const returnGap = candidateForward.forwardReturnPercent - baselineForward.forwardReturnPercent;
    const returnOk = returnGap >= -5;
    readText =
      ddOk && returnOk
        ? `${rebalanceCount} rebalances since anchor - candidate-hold3 holding up so far (maxDD not worse, return within 5pt tolerance of baseline-2).`
        : `${rebalanceCount} rebalances since anchor - concern flagged (${ddOk ? "" : "maxDD worse than baseline-2. "}${returnOk ? "" : "return more than 5pt worse than baseline-2."}) - worth more data/discussion, not an automatic rejection.`;
  }
  console.log(readText);
  console.log(
    "This is supplementary color on top of the already-completed historical multi-window validation (PR #27/#28), " +
      "not a replacement for it, and does not by itself trigger promoting candidate-hold3 to DEFAULT_ETF_ROTATION_CONFIG.",
  );
  console.log("");

  await writeForwardReport(
    FORWARD_VALIDATION_ANCHOR_DATE,
    baselineAnalysis,
    candidateAnalysis,
    baselineForward,
    candidateForward,
    spyForwardReturnPercent,
    equalWeightForwardReturnPercent,
    readText,
  );

  await appendForwardLogRow([
    new Date().toISOString(),
    FORWARD_VALIDATION_ANCHOR_DATE,
    baselineAnalysis.startDate,
    baselineAnalysis.endDate,
    baselineForward.forwardTradingDays,
    rebalanceCount,
    baselineForward.forwardReturnPercent.toFixed(2),
    baselineForward.forwardMaxDrawdownPercent.toFixed(2),
    candidateForward.forwardReturnPercent.toFixed(2),
    candidateForward.forwardMaxDrawdownPercent.toFixed(2),
    spyForwardReturnPercent !== null ? spyForwardReturnPercent.toFixed(2) : "n/a",
    equalWeightForwardReturnPercent !== null ? equalWeightForwardReturnPercent.toFixed(2) : "n/a",
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
