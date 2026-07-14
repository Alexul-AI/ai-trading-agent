import { promises as fs } from "fs";
import path from "path";
import dotenv from "dotenv";

import {
  runEtfRotationWindowAnalysis,
  type EtfRotationWindowAnalysisResult,
} from "./backtest-etf-rotation.js";
import {
  ETF_ROTATION_CONFIG_VARIANTS,
  resolveEtfRotationConfigVariant,
} from "./etfRotationStrategy.js";
import {
  buildBenchmarkMetrics,
  buildScorecardMetrics,
  calendarDaysInclusive,
  formatScorecardCsvRow,
  formatBenchmarkCsvRow,
  SCORECARD_CSV_HEADER,
} from "./scorecard.js";

dotenv.config();

const REPORT_DIR = path.resolve(process.cwd(), "data", "backtest-reports");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Same helper, same convention as backtest-portfolio-multiwindow.ts - each
// backtest script keeps its own small copy rather than sharing one.
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

// Identical windows (not just labels) to backtest-portfolio-multiwindow.ts -
// this is what makes the two strategies' multi-window numbers comparable to
// each other, not just internally consistent.
const WINDOWS: WindowConfig[] = [
  { label: "Current (~900d)", days: 900, endDaysAgo: 0 },
  { label: "Prior (~900d)", days: 900, endDaysAgo: 900 },
  {
    label: "2022 bear-heavy",
    days: 900,
    endDaysAgo: daysAgoFromTarget("2023-06-30"),
  },
  {
    label: "2023-2024 bull-heavy",
    days: 750,
    endDaysAgo: daysAgoFromTarget("2024-12-31"),
  },
  {
    label: "COVID crash + recovery",
    days: 900,
    endDaysAgo: daysAgoFromTarget("2021-12-31"),
  },
];

function pad(value: string, width: number): string {
  return value.padStart(width);
}

function csvEscape(value: string | number): string {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCsv(rows: (string | number)[][]): string {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n") + "\n";
}

async function main() {
  const variantKey = resolveEtfRotationConfigVariant(process.env.ETF_ROTATION_CONFIG);
  const { config, label: configLabel, validationStatus } = ETF_ROTATION_CONFIG_VARIANTS[variantKey];

  console.log(
    `ETF rotation multi-window validation: ${config.universe.length} tickers, ${WINDOWS.length} windows`,
  );
  console.log(`Config variant: ${configLabel}`);
  console.log(`Validation status: ${validationStatus}`);
  console.log(
    "Each window runs the close-to-close/next-open ablation - see backtest-etf-rotation.ts for what that does.",
  );
  console.log(
    "No circuit-breaker-policy comparison here - that layer doesn't exist in this strategy on purpose (see PR #26's caveats).",
  );
  console.log("");

  const analyses: EtfRotationWindowAnalysisResult[] = [];
  for (const window of WINDOWS) {
    console.log(
      `=== Running window: ${window.label} (requested days=${window.days}, endDaysAgo=${window.endDaysAgo}) ===`,
    );
    const analysis = await runEtfRotationWindowAnalysis({ ...window, config });
    console.log(
      `  Actual range: ${analysis.startDate} to ${analysis.endDate} (${analysis.simDays} simulated days)`,
    );
    console.log("");
    analyses.push(analysis);
  }

  // --- Table 1: execution drag by window ---
  console.log("=== Execution drag by window ===");
  console.log(
    "window".padEnd(28) +
      pad("close ret%", 12) +
      pad("nextopen ret%", 14) +
      pad("drag pts", 10) +
      pad("close DD%", 11) +
      pad("nextopen DD%", 13),
  );
  const dragRows: (string | number)[][] = [
    [
      "window",
      "actual_start",
      "actual_end",
      "sim_days",
      "close_return_pct",
      "next_open_return_pct",
      "drag_pts",
      "close_max_dd_pct",
      "next_open_max_dd_pct",
    ],
  ];
  for (const analysis of analyses) {
    const closeD = analysis.resultsByModel.get("close_to_close")!;
    const nextOpenD = analysis.resultsByModel.get("next_open")!;
    const drag = closeD.totalPnlPercent - nextOpenD.totalPnlPercent;

    console.log(
      analysis.label.padEnd(28) +
        pad(closeD.totalPnlPercent.toFixed(2), 12) +
        pad(nextOpenD.totalPnlPercent.toFixed(2), 14) +
        pad(drag.toFixed(2), 10) +
        pad(closeD.maxDrawdownPercent.toFixed(2), 11) +
        pad(nextOpenD.maxDrawdownPercent.toFixed(2), 13),
    );
    dragRows.push([
      analysis.label,
      analysis.startDate,
      analysis.endDate,
      analysis.simDays,
      closeD.totalPnlPercent.toFixed(2),
      nextOpenD.totalPnlPercent.toFixed(2),
      drag.toFixed(2),
      closeD.maxDrawdownPercent.toFixed(2),
      nextOpenD.maxDrawdownPercent.toFixed(2),
    ]);
  }
  console.log("");

  // --- Table 2: scorecard by window (NEXT_OPEN - Phase 1's primary result) ---
  console.log("=== Scorecard by window (NEXT_OPEN) ===");
  console.log(
    "window".padEnd(28) +
      pad("CAGR%", 10) +
      pad("maxDD%", 10) +
      pad("Calmar", 9) +
      pad("exposure%", 11) +
      pad("trades", 8) +
      pad("SPY CAGR%", 12) +
      pad("EW CAGR%", 11),
  );
  const scorecardRows: (string | number)[][] = [SCORECARD_CSV_HEADER];
  for (const analysis of analyses) {
    const nextOpenD = analysis.resultsByModel.get("next_open")!;
    const annualizationDays = calendarDaysInclusive(analysis.startDate, analysis.endDate);

    const metrics = buildScorecardMetrics({
      totalReturnPercent: nextOpenD.totalPnlPercent,
      maxDrawdownPercent: nextOpenD.maxDrawdownPercent,
      avgExposurePercent: nextOpenD.avgExposurePercent,
      totalTrades: nextOpenD.totalTrades,
      simTradingDays: nextOpenD.totalSimDays,
      annualizationDays,
    });
    const spyBenchmark =
      analysis.spyBuyAndHoldPercent !== null
        ? buildBenchmarkMetrics("SPY buy & hold", analysis.spyBuyAndHoldPercent, annualizationDays)
        : null;
    const equalWeightBenchmark = buildBenchmarkMetrics(
      "Equal-weight buy & hold",
      analysis.buyAndHoldPercent,
      annualizationDays,
    );

    console.log(
      analysis.label.padEnd(28) +
        pad(metrics.cagrPercent.toFixed(2), 10) +
        pad(metrics.maxDrawdownPercent.toFixed(2), 10) +
        pad(metrics.calmarRatio === null ? "n/a" : metrics.calmarRatio.toFixed(2), 9) +
        pad(metrics.avgExposurePercent.toFixed(1), 11) +
        pad(String(metrics.totalTrades), 8) +
        pad(spyBenchmark ? spyBenchmark.cagrPercent.toFixed(2) : "n/a", 12) +
        pad(equalWeightBenchmark.cagrPercent.toFixed(2), 11),
    );

    scorecardRows.push(formatScorecardCsvRow(analysis.label, metrics));
    if (spyBenchmark) {
      scorecardRows.push(
        formatBenchmarkCsvRow({ ...spyBenchmark, label: `${analysis.label} - SPY` }),
      );
    }
    scorecardRows.push(
      formatBenchmarkCsvRow({
        ...equalWeightBenchmark,
        label: `${analysis.label} - Equal-weight`,
      }),
    );
  }
  console.log("");

  // --- Honest plain-text read, not a manufactured pass/fail verdict ---
  // Whether this is "good enough" to advance to Phase 3 is a judgment call
  // for the user, not something to auto-decide in code - this just surfaces
  // the two facts that matter most for that judgment.
  console.log("=== Read ===");
  let beatSpyCount = 0;
  let beatEqualWeightCount = 0;
  for (const analysis of analyses) {
    const nextOpenD = analysis.resultsByModel.get("next_open")!;
    if (
      analysis.spyBuyAndHoldPercent !== null &&
      nextOpenD.totalPnlPercent > analysis.spyBuyAndHoldPercent
    ) {
      beatSpyCount += 1;
    }
    if (nextOpenD.totalPnlPercent > analysis.buyAndHoldPercent) {
      beatEqualWeightCount += 1;
    }
  }
  console.log(
    `Beat SPY buy & hold (next-open, raw price return) in ${beatSpyCount}/${analyses.length} windows.`,
  );
  console.log(
    `Beat equal-weight 5-ETF buy & hold (next-open, raw price return) in ${beatEqualWeightCount}/${analyses.length} windows.`,
  );
  const bearWindow = analyses.find((a) => a.label === "2022 bear-heavy");
  if (bearWindow) {
    const bearNextOpen = bearWindow.resultsByModel.get("next_open")!;
    console.log(
      `2022 bear-heavy: next-open return ${bearNextOpen.totalPnlPercent.toFixed(2)}%, max drawdown ${bearNextOpen.maxDrawdownPercent.toFixed(2)}% (vs SPY ${bearWindow.spyBuyAndHoldPercent?.toFixed(2) ?? "n/a"}%).`,
    );
  }
  console.log("");
  console.log(
    "Reminder: raw-price backtest (no dividends/distributions) - see backtest-etf-rotation.ts's report caveats.",
  );

  await fs.mkdir(REPORT_DIR, { recursive: true });
  // A leading header block so this CSV is still self-describing if it's
  // opened later, out of context, without the console output next to it -
  // a table of numbers with no config label attached is exactly the kind
  // of thing that gets misread as "the" result later.
  const configHeader = toCsv([
    ["config_variant", configLabel],
    ["validation_status", validationStatus],
  ]);
  const summary = [configHeader, "", toCsv(dragRows), "", toCsv(scorecardRows)].join(
    "\n",
  );
  await fs.writeFile(
    path.join(REPORT_DIR, "etf-rotation-multiwindow-summary.csv"),
    summary,
    "utf-8",
  );
  console.log(
    `\nSummary written to ${path.join(REPORT_DIR, "etf-rotation-multiwindow-summary.csv")}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
