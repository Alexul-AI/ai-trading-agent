// ETF Rotation delta-only rebalance feasibility (2026-08-10, research-only)
// - direct follow-up to PR #82's turnover finding (~1500-2400% annualized,
// traced to computeRebalanceOrders' full-liquidate-then-rebuy design).
// Compares full-liquidate (today's live/backtest default) against
// delta-only rebalancing (computeDeltaRebalanceOrders,
// etfRotationStrategy.ts - trades only the difference to target weights)
// at 4 tolerance-band thresholds: 0% (pure delta-only baseline), 1%, 2%,
// 5%.
//
// Key analytical point this script exists to verify empirically, not just
// argue: at threshold=0%, delta-only should reach the exact same
// resulting share count per ticker as full-liquidate for identical
// inputs - both compute Math.floor(targetDollars/price) from the same
// weightPercent x currentEquity, the only difference is how you get
// there. See the "Target-state sanity check" section below and its
// explicit two-tier verification (etfRotationStrategy.test.ts's strict
// algebraic-invariant tests are the real hard gate; this script's
// simulation-level comparison is explanatory diagnostic only, since a
// full multi-rebalance simulation can legitimately diverge slightly after
// the first rebalance from delta-only's own slippage savings compounding
// - not a violation of the delta-only logic).
//
// Grid: 5 standard windows x 2 config variants x 5 rebalance-mode variants
// (full-liquidate baseline + delta-only at [0,1,2,5]%) = 50 combinations,
// NEXT_OPEN only (execution-model drag is not the question here),
// adjustment=raw only (orthogonal to the already-parked raw-vs-adjusted
// methodology question).
//
// No live/execution/config change - read-only against Alpaca's historical
// bars, same as every sibling backtest script. Does not touch
// etfRotationCycle.ts, autopilotConfig.ts, or any env var.
import { promises as fs } from "fs";
import path from "path";
import dotenv from "dotenv";

import {
  runEtfRotationWindowAnalysis,
  type EtfRotationSimResult,
  type RebalanceMode,
} from "./backtest-etf-rotation.js";
import {
  ETF_ROTATION_CONFIG_VARIANTS,
  type EtfRotationConfigVariantKey,
} from "./etfRotationStrategy.js";
import { calendarDaysInclusive, computeCagrPercent, computeCalmarRatio } from "./scorecard.js";
import {
  computeDailyReturnStats,
  computeRealizedGainLoss,
  computeTaxDragScenarios,
  computeTurnoverStats,
} from "./riskTaxMetrics.js";

dotenv.config();

const REPORT_DIR = path.resolve(process.cwd(), "data", "backtest-reports", "etf-rotation");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Illustrative sensitivity only, same convention/rates as PR #82 - not a
// claim about anyone's actual effective rate.
const TAX_RATE_PERCENTAGES = [0, 15, 25, 35];

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

// Identical windows to every other multi-window ETF Rotation script in
// this repo, for direct comparability.
const WINDOWS: WindowConfig[] = [
  { label: "Current (~900d)", days: 900, endDaysAgo: 0 },
  { label: "Prior (~900d)", days: 900, endDaysAgo: 900 },
  { label: "2022 bear-heavy", days: 900, endDaysAgo: daysAgoFromTarget("2023-06-30") },
  { label: "2023-2024 bull-heavy", days: 750, endDaysAgo: daysAgoFromTarget("2024-12-31") },
  { label: "COVID crash + recovery", days: 900, endDaysAgo: daysAgoFromTarget("2021-12-31") },
];

interface RebalanceModeVariant {
  label: string;
  mode: RebalanceMode;
  thresholdPercent: number;
}

// Exactly the 4 threshold points agreed - deliberately not a wider sweep,
// to avoid turning this into parameter fishing.
const REBALANCE_MODE_VARIANTS: RebalanceModeVariant[] = [
  { label: "full-liquidate (baseline)", mode: "full-liquidate", thresholdPercent: 0 },
  { label: "delta-only (0%)", mode: "delta-only", thresholdPercent: 0 },
  { label: "delta-only (1%)", mode: "delta-only", thresholdPercent: 1 },
  { label: "delta-only (2%)", mode: "delta-only", thresholdPercent: 2 },
  { label: "delta-only (5%)", mode: "delta-only", thresholdPercent: 5 },
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

function fmtPct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function fmtRatio(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(2);
}

interface GridRow {
  window: string;
  configVariant: string;
  modeLabel: string;
  mode: RebalanceMode;
  thresholdPercent: number;
  result: EtfRotationSimResult;
  startingEquity: number;
  /** Calendar days spanned by the simulated window - CAGR/turnover must annualize over this, not totalSimDays (a trading-bar count), matching scorecard.ts's own calendarDaysInclusive convention. */
  annualizationCalendarDays: number;
}

interface MetricsRow {
  window: string;
  configVariant: string;
  modeLabel: string;
  annualizedVolatilityPercent: number;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  grossTurnoverUsd: number;
  annualizedTurnoverPercent: number;
  turnoverReductionPercent: number | null; // vs. this (window, config)'s full-liquidate baseline
  averagePreRebalanceDeviationPercent: number;
  totalTrades: number;
  totalPnlPercent: number;
  maxDrawdownPercent: number;
  calmarRatio: number | null;
  totalRealizedGainLossUsd: number;
  taxScenarioReturns: number[]; // aligned with TAX_RATE_PERCENTAGES
}

interface SanityCheckRow {
  window: string;
  configVariant: string;
  totalComparisons: number;
  mismatchCount: number;
  firstMismatchDate: string | null;
  equityDeltaAtMismatchUsd: number | null;
}

function compareTargetState(
  window: string,
  configVariant: string,
  fullLiquidate: EtfRotationSimResult,
  deltaOnlyZero: EtfRotationSimResult,
): SanityCheckRow {
  let totalComparisons = 0;
  let mismatchCount = 0;
  let firstMismatchDate: string | null = null;
  let equityDeltaAtMismatchUsd: number | null = null;

  const deltaHoldingsByDate = new Map(
    deltaOnlyZero.holdingsAfterEachRebalance.map((row) => [row.date, row.holdings]),
  );

  for (const flRow of fullLiquidate.holdingsAfterEachRebalance) {
    const deltaHoldings = deltaHoldingsByDate.get(flRow.date);
    if (!deltaHoldings) continue; // both sims share the same rebalance dates by construction

    const tickers = new Set([...Object.keys(flRow.holdings), ...Object.keys(deltaHoldings)]);
    for (const ticker of tickers) {
      totalComparisons += 1;
      const flShares = flRow.holdings[ticker] ?? 0;
      const deltaShares = deltaHoldings[ticker] ?? 0;

      if (flShares !== deltaShares) {
        mismatchCount += 1;
        if (firstMismatchDate === null) {
          firstMismatchDate = flRow.date;
          const flEquity = fullLiquidate.equityCurve.find((e) => e.date === flRow.date)?.equity;
          const deltaEquity = deltaOnlyZero.equityCurve.find((e) => e.date === flRow.date)?.equity;
          if (flEquity !== undefined && deltaEquity !== undefined) {
            equityDeltaAtMismatchUsd = deltaEquity - flEquity;
          }
        }
      }
    }
  }

  return { window, configVariant, totalComparisons, mismatchCount, firstMismatchDate, equityDeltaAtMismatchUsd };
}

function averageEquity(equityCurve: { equity: number }[]): number {
  if (equityCurve.length === 0) return 0;
  return equityCurve.reduce((sum, point) => sum + point.equity, 0) / equityCurve.length;
}

async function main() {
  const variantCount = Object.keys(ETF_ROTATION_CONFIG_VARIANTS).length;
  console.log(
    `ETF rotation delta-only rebalance feasibility: ${WINDOWS.length} windows x ${variantCount} config variants x ${REBALANCE_MODE_VARIANTS.length} rebalance-mode variants (NEXT_OPEN only, adjustment=raw).`,
  );
  console.log("");

  const gridRows: GridRow[] = [];

  for (const window of WINDOWS) {
    for (const [, variant] of Object.entries(ETF_ROTATION_CONFIG_VARIANTS) as [
      EtfRotationConfigVariantKey,
      (typeof ETF_ROTATION_CONFIG_VARIANTS)[EtfRotationConfigVariantKey],
    ][]) {
      for (const modeVariant of REBALANCE_MODE_VARIANTS) {
        const label = `${window.label} (${variant.label}, ${modeVariant.label})`;
        console.log(`=== ${label} ===`);

        const analysis = await runEtfRotationWindowAnalysis({
          label,
          days: window.days,
          endDaysAgo: window.endDaysAgo,
          config: variant.config,
          rebalanceMode: modeVariant.mode,
          deltaThresholdPercent: modeVariant.thresholdPercent,
        });

        gridRows.push({
          window: window.label,
          configVariant: variant.label,
          modeLabel: modeVariant.label,
          mode: modeVariant.mode,
          thresholdPercent: modeVariant.thresholdPercent,
          result: analysis.resultsByModel.get("next_open")!,
          startingEquity: analysis.startingEquity,
          annualizationCalendarDays: calendarDaysInclusive(analysis.startDate, analysis.endDate),
        });
      }
    }
    console.log("");
  }

  // === Main metrics table ===
  const metricsRows: MetricsRow[] = [];
  for (const row of gridRows) {
    const { result } = row;

    const baseline = gridRows.find(
      (r) => r.window === row.window && r.configVariant === row.configVariant && r.mode === "full-liquidate",
    )!;

    const avgEquity = averageEquity(result.equityCurve);
    const dailyStats = computeDailyReturnStats(result.equityCurve);
    const turnoverStats = computeTurnoverStats(result.trades, avgEquity, row.annualizationCalendarDays);
    const baselineTurnoverStats = computeTurnoverStats(
      baseline.result.trades,
      averageEquity(baseline.result.equityCurve),
      baseline.annualizationCalendarDays,
    );
    const gainLossEntries = computeRealizedGainLoss(result.trades);
    const totalRealizedGainLossUsd = gainLossEntries.reduce((sum, e) => sum + e.gainLossUsd, 0);
    const taxScenarios = computeTaxDragScenarios(
      totalRealizedGainLossUsd,
      result.finalEquity,
      row.startingEquity,
      TAX_RATE_PERCENTAGES,
    );

    const cagrPercent = computeCagrPercent(result.totalPnlPercent, row.annualizationCalendarDays);
    const calmarRatio = computeCalmarRatio(cagrPercent, result.maxDrawdownPercent);

    const turnoverReductionPercent =
      row.mode === "full-liquidate" || baselineTurnoverStats.grossTurnoverUsd === 0
        ? null
        : ((baselineTurnoverStats.grossTurnoverUsd - turnoverStats.grossTurnoverUsd) /
            baselineTurnoverStats.grossTurnoverUsd) *
          100;

    metricsRows.push({
      window: row.window,
      configVariant: row.configVariant,
      modeLabel: row.modeLabel,
      annualizedVolatilityPercent: dailyStats.annualizedVolatilityPercent,
      sharpeRatio: dailyStats.sharpeRatio,
      sortinoRatio: dailyStats.sortinoRatio,
      grossTurnoverUsd: turnoverStats.grossTurnoverUsd,
      annualizedTurnoverPercent: turnoverStats.annualizedTurnoverPercent,
      turnoverReductionPercent,
      averagePreRebalanceDeviationPercent: result.averagePreRebalanceDeviationPercent,
      totalTrades: result.totalTrades,
      totalPnlPercent: result.totalPnlPercent,
      maxDrawdownPercent: result.maxDrawdownPercent,
      calmarRatio,
      totalRealizedGainLossUsd,
      taxScenarioReturns: taxScenarios.map((s) => s.afterTaxTotalReturnPercent),
    });
  }

  console.log("=== Turnover, drift, trades, return (NEXT_OPEN) ===");
  console.log(
    "window".padEnd(24) +
      "config".padEnd(20) +
      "mode".padEnd(22) +
      pad("ann.turn%", 11) +
      pad("turn.reduc.", 12) +
      pad("drift%", 8) +
      pad("trades", 8) +
      pad("return%", 10) +
      pad("maxDD%", 9) +
      pad("Calmar", 8),
  );
  for (const row of metricsRows) {
    console.log(
      row.window.padEnd(24) +
        row.configVariant.slice(0, 18).padEnd(20) +
        row.modeLabel.padEnd(22) +
        pad(row.annualizedTurnoverPercent.toFixed(0), 11) +
        pad(row.turnoverReductionPercent === null ? "n/a" : fmtPct(row.turnoverReductionPercent), 12) +
        pad(row.averagePreRebalanceDeviationPercent.toFixed(2), 8) +
        pad(String(row.totalTrades), 8) +
        pad(fmtPct(row.totalPnlPercent), 10) +
        pad(row.maxDrawdownPercent.toFixed(2), 9) +
        pad(fmtRatio(row.calmarRatio), 8),
    );
  }
  console.log("");

  console.log("=== Risk-adjusted return + tax drag (illustrative rates: 0/15/25/35%) ===");
  console.log(
    "window".padEnd(24) +
      "config".padEnd(20) +
      "mode".padEnd(22) +
      pad("Sharpe", 8) +
      pad("Sortino", 9) +
      pad("gain/loss$", 12) +
      pad("@25%", 9),
  );
  for (const row of metricsRows) {
    console.log(
      row.window.padEnd(24) +
        row.configVariant.slice(0, 18).padEnd(20) +
        row.modeLabel.padEnd(22) +
        pad(fmtRatio(row.sharpeRatio), 8) +
        pad(fmtRatio(row.sortinoRatio), 9) +
        pad(row.totalRealizedGainLossUsd.toFixed(0), 12) +
        pad(fmtPct(row.taxScenarioReturns[2]!), 9), // index 2 = 25%
    );
  }
  console.log("");

  // === Target-state sanity check (explanatory diagnostic, NOT the hard gate) ===
  const sanityRows: SanityCheckRow[] = [];
  for (const window of WINDOWS) {
    for (const [, variant] of Object.entries(ETF_ROTATION_CONFIG_VARIANTS)) {
      const fullLiquidateRow = gridRows.find(
        (r) => r.window === window.label && r.configVariant === variant.label && r.mode === "full-liquidate",
      )!;
      const deltaZeroRow = gridRows.find(
        (r) =>
          r.window === window.label &&
          r.configVariant === variant.label &&
          r.mode === "delta-only" &&
          r.thresholdPercent === 0,
      )!;
      sanityRows.push(
        compareTargetState(window.label, variant.label, fullLiquidateRow.result, deltaZeroRow.result),
      );
    }
  }

  console.log(
    "=== Target-state sanity check: full-liquidate vs. delta-only(0%) - EXPLANATORY, not the hard merge gate ===",
  );
  console.log(
    "The strict correctness proof is etfRotationStrategy.test.ts's algebraic-invariant unit tests (identical",
  );
  console.log(
    "inputs -> identical resulting holdings). This table instead compares two independently-compounding full",
  );
  console.log(
    "simulations - a nonzero-but-small count here can legitimately reflect delta-only's own slippage savings",
  );
  console.log("shifting a later rebalance's Math.floor(targetDollars/price) at a rounding boundary, not a bug.");
  console.log("");
  console.log(
    "window".padEnd(24) + "config".padEnd(20) + pad("comparisons", 12) + pad("mismatches", 11) + "  first mismatch date / equity delta",
  );
  for (const row of sanityRows) {
    const detail =
      row.firstMismatchDate === null
        ? "n/a"
        : `${row.firstMismatchDate} / ${row.equityDeltaAtMismatchUsd === null ? "n/a" : `$${row.equityDeltaAtMismatchUsd.toFixed(2)}`}`;
    console.log(
      row.window.padEnd(24) +
        row.configVariant.slice(0, 18).padEnd(20) +
        pad(String(row.totalComparisons), 12) +
        pad(String(row.mismatchCount), 11) +
        `  ${detail}`,
    );
  }
  console.log("");

  await fs.mkdir(REPORT_DIR, { recursive: true });

  const metricsCsvRows: (string | number)[][] = [
    [
      "window",
      "config_variant",
      "mode",
      "annualized_volatility_pct",
      "sharpe_ratio",
      "sortino_ratio",
      "gross_turnover_usd",
      "annualized_turnover_pct",
      "turnover_reduction_vs_full_liquidate_pct",
      "avg_pre_rebalance_deviation_pct",
      "total_trades",
      "total_pnl_pct",
      "max_drawdown_pct",
      "calmar_ratio",
      "total_realized_gain_loss_usd",
    ],
  ];
  for (const row of metricsRows) {
    metricsCsvRows.push([
      row.window,
      row.configVariant,
      row.modeLabel,
      row.annualizedVolatilityPercent.toFixed(2),
      row.sharpeRatio === null ? "n/a" : row.sharpeRatio.toFixed(3),
      row.sortinoRatio === null ? "n/a" : row.sortinoRatio.toFixed(3),
      row.grossTurnoverUsd.toFixed(2),
      row.annualizedTurnoverPercent.toFixed(2),
      row.turnoverReductionPercent === null ? "n/a" : row.turnoverReductionPercent.toFixed(2),
      row.averagePreRebalanceDeviationPercent.toFixed(3),
      row.totalTrades,
      row.totalPnlPercent.toFixed(2),
      row.maxDrawdownPercent.toFixed(2),
      row.calmarRatio === null ? "n/a" : row.calmarRatio.toFixed(2),
      row.totalRealizedGainLossUsd.toFixed(2),
    ]);
  }
  const metricsCsvPath = path.join(REPORT_DIR, "etf-rotation-delta-rebalance-metrics.csv");
  await fs.writeFile(metricsCsvPath, toCsv(metricsCsvRows), "utf-8");

  const taxCsvRows: (string | number)[][] = [
    ["window", "config_variant", "mode", "tax_rate_pct", "after_tax_total_return_pct"],
  ];
  for (const row of metricsRows) {
    TAX_RATE_PERCENTAGES.forEach((rate, i) => {
      taxCsvRows.push([row.window, row.configVariant, row.modeLabel, rate, row.taxScenarioReturns[i]!.toFixed(2)]);
    });
  }
  const taxCsvPath = path.join(REPORT_DIR, "etf-rotation-delta-rebalance-tax-drag.csv");
  await fs.writeFile(taxCsvPath, toCsv(taxCsvRows), "utf-8");

  const sanityCsvRows: (string | number)[][] = [
    ["window", "config_variant", "total_comparisons", "mismatch_count", "first_mismatch_date", "equity_delta_at_mismatch_usd"],
  ];
  for (const row of sanityRows) {
    sanityCsvRows.push([
      row.window,
      row.configVariant,
      row.totalComparisons,
      row.mismatchCount,
      row.firstMismatchDate ?? "n/a",
      row.equityDeltaAtMismatchUsd === null ? "n/a" : row.equityDeltaAtMismatchUsd.toFixed(2),
    ]);
  }
  const sanityCsvPath = path.join(REPORT_DIR, "etf-rotation-delta-rebalance-sanity-check.csv");
  await fs.writeFile(sanityCsvPath, toCsv(sanityCsvRows), "utf-8");

  console.log(`Metrics CSV written to ${metricsCsvPath}`);
  console.log(`Tax-drag CSV written to ${taxCsvPath}`);
  console.log(`Sanity-check CSV written to ${sanityCsvPath}`);

  const totalMismatches = sanityRows.reduce((sum, r) => sum + r.mismatchCount, 0);
  const totalComparisons = sanityRows.reduce((sum, r) => sum + r.totalComparisons, 0);

  const reportMd = `# ETF Rotation delta-only rebalance feasibility

Generated: ${new Date().toISOString()}

**Research-only - no live, execution, or config change of any kind.** Direct follow-up to PR #82's turnover finding (~1500-2400% annualized), traced to \`computeRebalanceOrders\`' full-liquidate-then-rebuy design. Compares full-liquidate (today's live/backtest default) against \`computeDeltaRebalanceOrders\` (new, \`etfRotationStrategy.ts\`) at tolerance-band thresholds \`[0%, 1%, 2%, 5%]\`.

## Two-tier correctness verification

1. **Strict algebraic invariant (the hard merge gate)**: \`etfRotationStrategy.test.ts\` proves directly, for 7 hand-constructed scenarios, that \`computeDeltaRebalanceOrders\` at threshold=0% and \`computeRebalanceOrders\` produce identical resulting holdings for identical inputs. This is the real correctness proof - a property of the two pure functions, not inferred from a simulation run.
2. **Simulation-level sanity check (explanatory diagnostic, not a strict-zero gate)**: the table below compares two independently-compounding full end-to-end simulations (full-liquidate vs. delta-only(0%)) over the same window/config. A nonzero-but-small mismatch count here can legitimately reflect delta-only's own slippage savings shifting equity slightly, which can - rarely, at a \`Math.floor\` rounding boundary - flip a later rebalance's target share count. This is a real effect of the mechanism being measured, not a violation of delta-only's logic. Only a large/systematic mismatch count would be a stop-and-investigate signal.

**This run**: ${totalMismatches}/${totalComparisons} total (window, config, ticker, rebalance-date) comparisons mismatched across all 10 (window, config) pairs.

## Grid

- Windows: the same 5 standard windows used throughout this project's ETF Rotation research.
- Config variants: both \`baseline-2\` and \`candidate-hold3\`.
- Rebalance modes: \`full-liquidate\` (baseline) and \`delta-only\` at thresholds \`0%/1%/2%/5%\`.
- Execution model: NEXT_OPEN only. Adjustment: \`raw\` only (orthogonal to the already-parked raw-vs-adjusted question).

## Turnover, drift, trades, return

\`turnover reduction\` is relative to this exact (window, config) pair's own \`full-liquidate\` row - a positive number means delta-only traded less. \`avg pre-rebalance drift%\` is the mean |actual weight − target weight| across all target tickers at all rebalance dates except the first, measured *before* any threshold gating - comparable across every mode, not just the thresholded ones.

| window | config | mode | ann. turnover | turnover reduction | avg drift | trades | return | maxDD | Calmar |
|---|---|---|---|---|---|---|---|---|---|
${metricsRows
  .map(
    (row) =>
      `| ${row.window} | ${row.configVariant} | ${row.modeLabel} | ${row.annualizedTurnoverPercent.toFixed(0)}% | ${row.turnoverReductionPercent === null ? "n/a" : fmtPct(row.turnoverReductionPercent)} | ${row.averagePreRebalanceDeviationPercent.toFixed(2)}% | ${row.totalTrades} | ${fmtPct(row.totalPnlPercent)} | ${row.maxDrawdownPercent.toFixed(2)}% | ${fmtRatio(row.calmarRatio)} |`,
  )
  .join("\n")}

## Risk-adjusted return + illustrative tax drag

Tax-drag numbers are illustrative sensitivity analysis, not tax advice (same framing as PR #82) - full 4-rate breakdown in the accompanying CSV, only the 25% scenario shown here for readability.

| window | config | mode | Sharpe | Sortino | realized gain/loss | @25% |
|---|---|---|---|---|---|---|
${metricsRows
  .map(
    (row) =>
      `| ${row.window} | ${row.configVariant} | ${row.modeLabel} | ${fmtRatio(row.sharpeRatio)} | ${fmtRatio(row.sortinoRatio)} | $${row.totalRealizedGainLossUsd.toFixed(0)} | ${fmtPct(row.taxScenarioReturns[2]!)} |`,
  )
  .join("\n")}

## Target-state sanity check (explanatory, not the hard gate)

| window | config | comparisons | mismatches | first mismatch date | equity delta at mismatch |
|---|---|---|---|---|---|
${sanityRows
  .map(
    (row) =>
      `| ${row.window} | ${row.configVariant} | ${row.totalComparisons} | ${row.mismatchCount} | ${row.firstMismatchDate ?? "n/a"} | ${row.equityDeltaAtMismatchUsd === null ? "n/a" : `$${row.equityDeltaAtMismatchUsd.toFixed(2)}`} |`,
  )
  .join("\n")}

## Caveats

- delta-only has no fractional/notional support in v1 - deliberately, to keep this comparison directly against today's actual whole-share live behavior rather than combining two research questions.
- Exits (a dropped pick, no longer a target) are always a full SELL in both modes, unconditional on threshold - the tolerance band only applies to continuing/new targets.
- Tax-drag rates (${TAX_RATE_PERCENTAGES.join("/")}%) are illustrative sensitivity analysis, not tax advice, same convention as PR #82 - no wash-sale rule, no per-lot complexity, no jurisdiction handling.
- One run, one window set - informative, not yet a validated finding, same standard as every other piece of research in this project.
`;

  const reportPath = path.join(REPORT_DIR, "etf-rotation-delta-rebalance-feasibility-report.md");
  await fs.writeFile(reportPath, reportMd, "utf-8");
  console.log(`Report written to ${reportPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
