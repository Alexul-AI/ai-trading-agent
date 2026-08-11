// ETF Rotation methodology metrics (2026-08-10, research-only) - answers
// "does this strategy have a hidden turnover/risk/tax drag," not "should
// we change anything live." Direct response to an external review that
// raised turnover/tax-drag/Sharpe-Sortino as unaddressed gaps - verified
// against the real code first (Sharpe/Sortino genuinely missing but
// deliberately deferred in scorecard.ts's Phase 1 scope, max
// drawdown/Calmar already present everywhere, no backtest anywhere
// computes a net-of-tax return). Deliberately a NEW module
// (riskTaxMetrics.ts) rather than an extension of scorecard.ts, so every
// existing report stays byte-stable.
//
// Grid: the same 5 standard windows used throughout this project's ETF
// Rotation research x both config variants (baseline-2/candidate-hold3) x
// both adjustment methodologies (raw/all) - adjusted is explicitly
// shadow/evidence here, matching PR #76-81's established framing, not a
// live methodology decision. NEXT_OPEN execution model only, matching the
// established convention in backtest-etf-rotation-holdcount-sweep.ts and
// the small-tranche simulation script - execution-model drag is not the
// question this script answers.
//
// Tax rates ([0, 15, 25, 35]) and friction bps ([0, 5, 10, 20]) are
// module-level constants in THIS SCRIPT ONLY, not env vars and not part of
// riskTaxMetrics.ts's own defaults - per explicit instruction, so this
// never looks like production config or an asserted "correct" rate.
// Tax-drag numbers are illustrative sensitivity analysis, NOT tax advice.
//
// No live/execution/config change of any kind - read-only against
// Alpaca's historical bars, same as every sibling backtest script. Does
// not touch etfRotationCycle.ts, autopilotConfig.ts, or any env var.
import { promises as fs } from "fs";
import path from "path";
import dotenv from "dotenv";

import { runEtfRotationWindowAnalysis } from "./backtest-etf-rotation.js";
import {
  ETF_ROTATION_CONFIG_VARIANTS,
  type EtfRotationConfigVariantKey,
} from "./etfRotationStrategy.js";
import { calendarDaysInclusive } from "./scorecard.js";
import {
  computeDailyReturnStats,
  computeFrictionSensitivity,
  computeRealizedGainLoss,
  computeTaxDragScenarios,
  computeTurnoverStats,
} from "./riskTaxMetrics.js";

dotenv.config();

const REPORT_DIR = path.resolve(process.cwd(), "data", "backtest-reports", "etf-rotation");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Illustrative sensitivity only - not a claim about anyone's actual
// effective rate. 0% is the pre-tax baseline every other backtest in this
// project already reports.
const TAX_RATE_PERCENTAGES = [0, 15, 25, 35];

// Additional friction ON TOP OF the simulation's own already-modeled
// slippage (backtest-etf-rotation.ts's SLIPPAGE_PERCENT) - 0 means "no
// extra friction beyond what was already simulated," not "frictionless."
const FRICTION_BPS_LIST = [0, 5, 10, 20];

const ADJUSTMENTS = ["raw", "all"] as const;

// Same helper/convention as backtest-etf-rotation-holdcount-sweep.ts /
// backtest-etf-rotation-multiwindow.ts.
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

function averageEquity(equityCurve: { equity: number }[]): number {
  if (equityCurve.length === 0) return 0;
  return equityCurve.reduce((sum, point) => sum + point.equity, 0) / equityCurve.length;
}

function fmtPct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function fmtRatio(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(2);
}

function fmtDays(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(1);
}

interface MetricsRow {
  window: string;
  configVariant: string;
  adjustment: "raw" | "all";
  annualizedVolatilityPercent: number;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  grossTurnoverUsd: number;
  annualizedTurnoverPercent: number;
  averageHoldingPeriodDays: number | null;
  totalRealizedGainLossUsd: number;
  taxScenarioReturns: number[]; // aligned with TAX_RATE_PERCENTAGES
  frictionScenarioReturns: number[]; // aligned with FRICTION_BPS_LIST
}

async function main() {
  const variantCount = Object.keys(ETF_ROTATION_CONFIG_VARIANTS).length;
  console.log(
    `ETF rotation methodology metrics: ${WINDOWS.length} windows x ${variantCount} config variants x ${ADJUSTMENTS.length} adjustment methodologies (NEXT_OPEN only).`,
  );
  console.log(
    "Tax-drag scenarios are illustrative sensitivity analysis, NOT tax advice - see report caveats.",
  );
  console.log("");

  const rows: MetricsRow[] = [];

  for (const window of WINDOWS) {
    for (const [, variant] of Object.entries(ETF_ROTATION_CONFIG_VARIANTS) as [
      EtfRotationConfigVariantKey,
      (typeof ETF_ROTATION_CONFIG_VARIANTS)[EtfRotationConfigVariantKey],
    ][]) {
      for (const adjustment of ADJUSTMENTS) {
        const label = `${window.label} (${variant.label}, ${adjustment})`;
        console.log(`=== ${label} ===`);

        const analysis = await runEtfRotationWindowAnalysis({
          label,
          days: window.days,
          endDaysAgo: window.endDaysAgo,
          config: variant.config,
          adjustment,
        });

        const result = analysis.resultsByModel.get("next_open")!;
        const annualizationDays = calendarDaysInclusive(analysis.startDate, analysis.endDate);
        const avgEquity = averageEquity(result.equityCurve);

        const dailyStats = computeDailyReturnStats(result.equityCurve);
        const turnoverStats = computeTurnoverStats(result.trades, avgEquity, annualizationDays);
        const gainLossEntries = computeRealizedGainLoss(result.trades);
        const totalRealizedGainLossUsd = gainLossEntries.reduce(
          (sum, entry) => sum + entry.gainLossUsd,
          0,
        );

        const taxScenarios = computeTaxDragScenarios(
          totalRealizedGainLossUsd,
          result.finalEquity,
          analysis.startingEquity,
          TAX_RATE_PERCENTAGES,
        );
        const frictionScenarios = computeFrictionSensitivity(
          turnoverStats.grossTurnoverUsd,
          result.finalEquity,
          analysis.startingEquity,
          FRICTION_BPS_LIST,
        );

        rows.push({
          window: window.label,
          configVariant: variant.label,
          adjustment,
          annualizedVolatilityPercent: dailyStats.annualizedVolatilityPercent,
          sharpeRatio: dailyStats.sharpeRatio,
          sortinoRatio: dailyStats.sortinoRatio,
          grossTurnoverUsd: turnoverStats.grossTurnoverUsd,
          annualizedTurnoverPercent: turnoverStats.annualizedTurnoverPercent,
          averageHoldingPeriodDays: turnoverStats.averageHoldingPeriodDays,
          totalRealizedGainLossUsd,
          taxScenarioReturns: taxScenarios.map((s) => s.afterTaxTotalReturnPercent),
          frictionScenarioReturns: frictionScenarios.map((s) => s.adjustedTotalReturnPercent),
        });
      }
    }
    console.log("");
  }

  // === Table 1: risk-adjusted return + turnover ===
  console.log("=== Risk-adjusted return + turnover (NEXT_OPEN) ===");
  console.log(
    "window".padEnd(24) +
      "config".padEnd(20) +
      pad("adj", 5) +
      pad("ann.vol%", 10) +
      pad("Sharpe", 9) +
      pad("Sortino", 9) +
      pad("turnover$", 12) +
      pad("ann.turn%", 11) +
      pad("holdDays", 10),
  );
  for (const row of rows) {
    console.log(
      row.window.padEnd(24) +
        row.configVariant.slice(0, 18).padEnd(20) +
        pad(row.adjustment, 5) +
        pad(row.annualizedVolatilityPercent.toFixed(1), 10) +
        pad(fmtRatio(row.sharpeRatio), 9) +
        pad(fmtRatio(row.sortinoRatio), 9) +
        pad(row.grossTurnoverUsd.toFixed(0), 12) +
        pad(row.annualizedTurnoverPercent.toFixed(0), 11) +
        pad(fmtDays(row.averageHoldingPeriodDays), 10),
    );
  }
  console.log("");

  // === Table 2: realized gain/loss + tax drag ===
  console.log(
    `=== Realized gain/loss + illustrative tax-drag return (rates: ${TAX_RATE_PERCENTAGES.join("/")}%) ===`,
  );
  console.log(
    "window".padEnd(24) +
      "config".padEnd(20) +
      pad("adj", 5) +
      pad("gain/loss$", 12) +
      TAX_RATE_PERCENTAGES.map((r) => pad(`@${r}%`, 9)).join(""),
  );
  for (const row of rows) {
    console.log(
      row.window.padEnd(24) +
        row.configVariant.slice(0, 18).padEnd(20) +
        pad(row.adjustment, 5) +
        pad(row.totalRealizedGainLossUsd.toFixed(0), 12) +
        row.taxScenarioReturns.map((r) => pad(fmtPct(r), 9)).join(""),
    );
  }
  console.log("");

  await fs.mkdir(REPORT_DIR, { recursive: true });

  const metricsCsvRows: (string | number)[][] = [
    [
      "window",
      "config_variant",
      "adjustment",
      "annualized_volatility_pct",
      "sharpe_ratio",
      "sortino_ratio",
      "gross_turnover_usd",
      "annualized_turnover_pct",
      "average_holding_period_days",
      "total_realized_gain_loss_usd",
    ],
  ];
  for (const row of rows) {
    metricsCsvRows.push([
      row.window,
      row.configVariant,
      row.adjustment,
      row.annualizedVolatilityPercent.toFixed(2),
      row.sharpeRatio === null ? "n/a" : row.sharpeRatio.toFixed(3),
      row.sortinoRatio === null ? "n/a" : row.sortinoRatio.toFixed(3),
      row.grossTurnoverUsd.toFixed(2),
      row.annualizedTurnoverPercent.toFixed(2),
      row.averageHoldingPeriodDays === null ? "n/a" : row.averageHoldingPeriodDays.toFixed(1),
      row.totalRealizedGainLossUsd.toFixed(2),
    ]);
  }
  const metricsCsvPath = path.join(REPORT_DIR, "etf-rotation-methodology-metrics.csv");
  await fs.writeFile(metricsCsvPath, toCsv(metricsCsvRows), "utf-8");

  const taxCsvRows: (string | number)[][] = [
    ["window", "config_variant", "adjustment", "tax_rate_pct", "after_tax_total_return_pct"],
  ];
  for (const row of rows) {
    TAX_RATE_PERCENTAGES.forEach((rate, i) => {
      taxCsvRows.push([
        row.window,
        row.configVariant,
        row.adjustment,
        rate,
        row.taxScenarioReturns[i]!.toFixed(2),
      ]);
    });
  }
  const taxCsvPath = path.join(REPORT_DIR, "etf-rotation-tax-drag-scenarios.csv");
  await fs.writeFile(taxCsvPath, toCsv(taxCsvRows), "utf-8");

  const frictionCsvRows: (string | number)[][] = [
    ["window", "config_variant", "adjustment", "additional_friction_bps", "adjusted_total_return_pct"],
  ];
  for (const row of rows) {
    FRICTION_BPS_LIST.forEach((bps, i) => {
      frictionCsvRows.push([
        row.window,
        row.configVariant,
        row.adjustment,
        bps,
        row.frictionScenarioReturns[i]!.toFixed(2),
      ]);
    });
  }
  const frictionCsvPath = path.join(REPORT_DIR, "etf-rotation-friction-sensitivity.csv");
  await fs.writeFile(frictionCsvPath, toCsv(frictionCsvRows), "utf-8");

  console.log(`Metrics CSV written to ${metricsCsvPath}`);
  console.log(`Tax-drag CSV written to ${taxCsvPath}`);
  console.log(`Friction-sensitivity CSV written to ${frictionCsvPath}`);

  const reportMd = `# ETF Rotation methodology metrics: turnover, risk-adjusted return, illustrative tax drag

Generated: ${new Date().toISOString()}

**Research-only - no live, execution, or config change of any kind.** Direct response to an external review that raised turnover/tax-drag/Sharpe-Sortino as unaddressed methodology gaps. Verified first against the real code (not assumed): max drawdown/Calmar are already in every backtest report (\`scorecard.ts\`) - Sharpe/Sortino specifically were deliberately deferred in Phase 1's scope, not forgotten. No backtest anywhere in this project computed a net-of-tax return before this script. \`raw\` is the live production methodology; \`all\` (dividend/distribution-adjusted bars) is shadow/evidence only here, matching the framing already established in PRs #76-81 - this script does not make or imply any adjustment-methodology decision.

**Tax-drag numbers below are illustrative sensitivity analysis, not tax advice.** A single flat rate applied to net realized gain/loss at the end of the simulated window - no wash-sale rule, no per-lot complexity, no jurisdiction handling, no dividend tax, no exact after-tax truth. The goal is answering "does this strategy have a hidden turnover/tax drag worth knowing about," not producing a real tax bill. Friction-sensitivity numbers are a cheap, linear post-hoc approximation (extra bps x already-simulated turnover), not a re-simulation.

## Grid

- Windows: the same 5 standard windows used throughout this project's ETF Rotation research.
- Config variants: both \`baseline-2\` (production default) and \`candidate-hold3\`.
- Adjustment methodologies: \`raw\` (live) and \`all\` (shadow/evidence).
- Execution model: NEXT_OPEN only (matches this project's other diagnostic sweeps - execution-model drag is not the question here).

## Risk-adjusted return + turnover

Volatility/Sharpe/Sortino annualize by trading-day count (sqrt(252)) - the standard convention for return-volatility scaling, and deliberately different from CAGR's calendar-day annualization (\`scorecard.ts\`) used for turnover below, since the two measure different things (sampled-return-period count vs. elapsed real time). 0% annual risk-free rate assumed (a disclosed simplification, not a claim about the true rate).

| window | config | adjustment | ann. volatility | Sharpe | Sortino | gross turnover | ann. turnover | avg holding (days) |
|---|---|---|---|---|---|---|---|---|
${rows
  .map(
    (row) =>
      `| ${row.window} | ${row.configVariant} | ${row.adjustment} | ${row.annualizedVolatilityPercent.toFixed(1)}% | ${fmtRatio(row.sharpeRatio)} | ${fmtRatio(row.sortinoRatio)} | $${row.grossTurnoverUsd.toFixed(0)} | ${row.annualizedTurnoverPercent.toFixed(0)}% | ${fmtDays(row.averageHoldingPeriodDays)} |`,
  )
  .join("\n")}

## Realized gain/loss + illustrative tax-drag return

Realized gain/loss: sum of every SELL's (sell price − its own immediately-preceding same-ticker BUY price) x shares - exact, not approximate, because \`computeRebalanceOrders\`'s full-liquidate-then-rebuy design means a SELL's cost basis is always its own last same-ticker BUY, never a multi-lot situation. After-tax return applies each rate to net realized gain (losses offset gains, taxed once at window end).

| window | config | adjustment | realized gain/loss | ${TAX_RATE_PERCENTAGES.map((r) => `@${r}%`).join(" | ")} |
|---|---|---|---|${TAX_RATE_PERCENTAGES.map(() => "---").join("|")}|
${rows
  .map(
    (row) =>
      `| ${row.window} | ${row.configVariant} | ${row.adjustment} | $${row.totalRealizedGainLossUsd.toFixed(0)} | ${row.taxScenarioReturns.map(fmtPct).join(" | ")} |`,
  )
  .join("\n")}

## Friction sensitivity (additional bps on top of already-simulated slippage)

| window | config | adjustment | ${FRICTION_BPS_LIST.map((b) => `+${b}bps`).join(" | ")} |
|---|---|---|${FRICTION_BPS_LIST.map(() => "---").join("|")}|
${rows
  .map(
    (row) =>
      `| ${row.window} | ${row.configVariant} | ${row.adjustment} | ${row.frictionScenarioReturns.map(fmtPct).join(" | ")} |`,
  )
  .join("\n")}

## Caveats

- v1 deliberately excludes: lot-level tax modeling, wash-sale rules, jurisdiction-specific tax handling, dividend tax, and any claim of exact after-tax truth. This is a drag-signal tool, not a tax calculator.
- Tax rates (${TAX_RATE_PERCENTAGES.join("/")}%) and friction bps (${FRICTION_BPS_LIST.join("/")}) are constants in this script only - not env vars, not production config, not an assertion about anyone's real effective rate.
- Friction sensitivity is a linear post-hoc approximation applied to already-simulated turnover, not a second re-simulation - it does not compound through re-invested capital the way a real re-run would.
- \`adjustment=all\` rows are shadow/evidence only, per the same framing established in PRs #76-81 - this script does not by itself validate, invalidate, or recommend any live methodology change.
- One run, one window set - informative, not yet a validated finding, same standard as every other piece of research in this project.
`;

  const reportPath = path.join(REPORT_DIR, "etf-rotation-methodology-metrics-report.md");
  await fs.writeFile(reportPath, reportMd, "utf-8");
  console.log(`Report written to ${reportPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
