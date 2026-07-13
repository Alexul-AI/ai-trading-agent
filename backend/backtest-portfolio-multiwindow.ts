import { promises as fs } from "fs";
import path from "path";
import dotenv from "dotenv";

import {
  runWindowAnalysis,
  TICKERS,
  type WindowAnalysisResult,
} from "./backtest-portfolio.js";

dotenv.config();

const REPORT_DIR = path.resolve(process.cwd(), "data", "backtest-reports");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Computed from a target end-date at runtime rather than hand-calculated
// and hardcoded - avoids drift/arithmetic errors as "today" moves between
// when this is written and when it runs.
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

// None of these are guaranteed calendar-precise - WARMUP_BARS (210, in
// backtest-portfolio.ts) eats into whatever's fetched, and IEX free-tier
// coverage that far back is assumed, not confirmed. Each window's *actual*
// resulting date range is printed below - check that before trusting the
// table blind, and adjust the target date here if a window doesn't land
// where intended (e.g. missing early data, more bleed-through than
// expected).
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
  console.log(
    `Multi-window validation: ${TICKERS.length} tickers, ${WINDOWS.length} windows`,
  );
  console.log(
    "Each window runs the full close-to-close/next-open ablation plus the circuit-breaker",
  );
  console.log(
    "policy comparison - see backtest-portfolio.ts for what each of those does.",
  );
  console.log("");

  const analyses: WindowAnalysisResult[] = [];
  for (const window of WINDOWS) {
    console.log(
      `=== Running window: ${window.label} (requested days=${window.days}, endDaysAgo=${window.endDaysAgo}) ===`,
    );
    const analysis = await runWindowAnalysis(window);
    console.log(
      `  Actual range: ${analysis.startDate} to ${analysis.endDate} (${analysis.simDays} simulated days)`,
    );
    console.log("");
    analyses.push(analysis);
  }

  // --- Table 1: execution drag by window ---
  console.log("=== Execution drag by window (variant D, full system) ===");
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
    const closeD = analysis.resultsByModel
      .get("close_to_close")!
      .find((r) => r.variant.useDailyKillAndSellThrottle)!.result;
    const nextOpenD = analysis.resultsByModel
      .get("next_open")!
      .find((r) => r.variant.useDailyKillAndSellThrottle)!.result;
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

  // --- Table 2: circuit-breaker policy comparison by window ---
  console.log(
    "=== Circuit-breaker policy comparison by window (NEXT_OPEN, variant D) ===",
  );
  console.log(
    "window".padEnd(28) +
      "scenario".padEnd(50) +
      pad("return%", 10) +
      pad("maxDD%", 10) +
      pad("halt days", 11) +
      pad("resets", 8),
  );
  const policyRows: (string | number)[][] = [
    ["window", "scenario", "return_pct", "max_dd_pct", "halt_days", "reset_count"],
  ];
  for (const analysis of analyses) {
    for (const { policy, result } of analysis.policyResults) {
      console.log(
        analysis.label.padEnd(28) +
          policy.label.padEnd(50) +
          pad(result.totalPnlPercent.toFixed(2), 10) +
          pad(result.maxDrawdownPercent.toFixed(2), 10) +
          pad(String(result.daysTrippedCount), 11) +
          pad(String(result.resetCount), 8),
      );
      policyRows.push([
        analysis.label,
        policy.label,
        result.totalPnlPercent.toFixed(2),
        result.maxDrawdownPercent.toFixed(2),
        result.daysTrippedCount,
        result.resetCount,
      ]);
    }
  }
  console.log("");

  // --- Verdict per window ---
  // policyResults[0] is always D0 (CIRCUIT_BREAKER_POLICIES's first entry,
  // DEFAULT_CIRCUIT_BREAKER_POLICY, in backtest-portfolio.ts) - relies on
  // that ordering rather than re-deriving it from policy fields.
  console.log(
    "=== Verdict per window: does every non-D0 reset policy beat D0's return with no worse drawdown? ===",
  );
  const verdictRows: (string | number)[][] = [
    ["window", "d0_tripped", "all_beat_d0_return", "all_no_worse_drawdown", "verdict"],
  ];
  for (const analysis of analyses) {
    const d0 = analysis.policyResults[0]!.result;
    const others = analysis.policyResults.slice(1);
    const d0Tripped = d0.circuitBreakerTrippedAt !== null;
    const allBeatD0Return = others.every(
      (p) => p.result.totalPnlPercent > d0.totalPnlPercent,
    );
    const allNoWorseDrawdown = others.every(
      (p) => p.result.maxDrawdownPercent >= d0.maxDrawdownPercent,
    );
    // Distinguish "nothing to compare" from an actual head-to-head result -
    // conflating these would silently hide the 2022-bear-heavy finding
    // (below) inside a generic "NO," which is a materially different and
    // much more important result than "the breaker just never fired here."
    const verdict = !d0Tripped
      ? "N/A - circuit breaker never tripped under D0 in this window, nothing to compare"
      : allBeatD0Return && allNoWorseDrawdown
        ? "YES - every reset policy beat D0 with no worse drawdown"
        : "NO - see numbers above, not consistent in this window";

    console.log(`${analysis.label}: ${verdict}`);
    verdictRows.push([
      analysis.label,
      d0Tripped ? "yes" : "no",
      allBeatD0Return ? "yes" : "no",
      allNoWorseDrawdown ? "yes" : "no",
      verdict,
    ]);
  }
  console.log("");
  console.log(
    "Backtest-only research across multiple windows - still not live behavior. See CLAUDE.md for",
  );
  console.log(
    "how to weigh this before it informs any real product decision (alert + manual review + admin",
  );
  console.log("reset, not auto-reset).");

  await fs.mkdir(REPORT_DIR, { recursive: true });
  const summary = [toCsv(dragRows), "", toCsv(policyRows), "", toCsv(verdictRows)].join(
    "\n",
  );
  await fs.writeFile(
    path.join(REPORT_DIR, "multi-window-summary.csv"),
    summary,
    "utf-8",
  );
  console.log(`\nSummary written to ${path.join(REPORT_DIR, "multi-window-summary.csv")}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
