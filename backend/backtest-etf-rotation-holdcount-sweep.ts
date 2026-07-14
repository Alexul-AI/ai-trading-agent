import { promises as fs } from "fs";
import path from "path";
import dotenv from "dotenv";

import { runEtfRotationWindowAnalysis } from "./backtest-etf-rotation.js";
import { ETF_ROTATION_MVP_BASELINE_CONFIG } from "./etfRotationStrategy.js";
import {
  buildBenchmarkMetrics,
  buildScorecardMetrics,
  calendarDaysInclusive,
} from "./scorecard.js";

dotenv.config();

const REPORT_DIR = path.resolve(process.cwd(), "data", "backtest-reports");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Same helper/convention as backtest-etf-rotation-multiwindow.ts.
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

// Identical windows to backtest-etf-rotation-multiwindow.ts, so this sweep's
// holdCount=2 row is directly comparable to that PR's already-published
// numbers (a regression check as much as new data).
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

// The roadmap's full allowed range (docs/product/ROADMAP.md Phase 2:
// "2-4 сильнейших"). 2 is the current shipped default, included as the
// baseline this sweep is measured against.
const HOLD_COUNTS = [2, 3, 4];

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

interface SweepRow {
  window: string;
  holdCount: number;
  returnPercent: number;
  cagrPercent: number;
  maxDrawdownPercent: number;
  calmarRatio: number | null;
  trades: number;
}

async function main() {
  console.log(
    `ETF rotation hold-count sweep: holdCount ${HOLD_COUNTS.join("/")} across ${WINDOWS.length} windows`,
  );
  console.log(
    "NEXT_OPEN only (this strategy's execution-model drag is ~1pt per PR #26 - a diagnostic sweep doesn't need both models).",
  );
  console.log("");

  const rows: SweepRow[] = [];

  for (const window of WINDOWS) {
    for (const holdCount of HOLD_COUNTS) {
      console.log(
        `=== ${window.label}, holdCount=${holdCount} (requested days=${window.days}, endDaysAgo=${window.endDaysAgo}) ===`,
      );
      const analysis = await runEtfRotationWindowAnalysis({
        label: `${window.label} (holdCount=${holdCount})`,
        days: window.days,
        endDaysAgo: window.endDaysAgo,
        config: { ...ETF_ROTATION_MVP_BASELINE_CONFIG, holdCount },
      });
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

      rows.push({
        window: window.label,
        holdCount,
        returnPercent: nextOpenD.totalPnlPercent,
        cagrPercent: metrics.cagrPercent,
        maxDrawdownPercent: nextOpenD.maxDrawdownPercent,
        calmarRatio: metrics.calmarRatio,
        trades: nextOpenD.totalTrades,
      });
      console.log("");
    }
  }

  console.log("=== Hold-count sweep (NEXT_OPEN) ===");
  console.log(
    "window".padEnd(28) +
      pad("holdCount", 11) +
      pad("return%", 10) +
      pad("CAGR%", 9) +
      pad("maxDD%", 9) +
      pad("Calmar", 9) +
      pad("trades", 8),
  );
  const csvRows: (string | number)[][] = [
    ["window", "hold_count", "return_pct", "cagr_pct", "max_dd_pct", "calmar_ratio", "trades"],
  ];
  for (const row of rows) {
    console.log(
      row.window.padEnd(28) +
        pad(String(row.holdCount), 11) +
        pad(row.returnPercent.toFixed(2), 10) +
        pad(row.cagrPercent.toFixed(2), 9) +
        pad(row.maxDrawdownPercent.toFixed(2), 9) +
        pad(row.calmarRatio === null ? "n/a" : row.calmarRatio.toFixed(2), 9) +
        pad(String(row.trades), 8),
    );
    csvRows.push([
      row.window,
      row.holdCount,
      row.returnPercent.toFixed(2),
      row.cagrPercent.toFixed(2),
      row.maxDrawdownPercent.toFixed(2),
      row.calmarRatio === null ? "n/a" : row.calmarRatio.toFixed(2),
      row.trades,
    ]);
  }
  console.log("");

  // The actual question this script exists to answer, isolated from the
  // wider table above rather than left for the reader to hunt for.
  console.log("=== 2022 bear-heavy: does a higher holdCount soften this window's drawdown? ===");
  const bearRows = rows.filter((r) => r.window === "2022 bear-heavy");
  for (const row of bearRows) {
    console.log(
      `holdCount=${row.holdCount}: return ${row.returnPercent.toFixed(2)}%, max drawdown ${row.maxDrawdownPercent.toFixed(2)}%`,
    );
  }
  console.log("");
  console.log(
    "Compare against the other windows' rows above too - a holdCount that helps 2022 bear-heavy",
  );
  console.log(
    "but costs meaningful return in the windows where holdCount=2 already won is not a clean win.",
  );

  await fs.mkdir(REPORT_DIR, { recursive: true });
  const csvPath = path.join(REPORT_DIR, "etf-rotation-holdcount-sweep.csv");
  await fs.writeFile(csvPath, toCsv(csvRows), "utf-8");
  console.log(`\nSummary written to ${csvPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
