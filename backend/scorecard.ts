// Minimal research scorecard (docs/product/ROADMAP.md, Phase 1) - a single
// standard for comparing any strategy backtest against a benchmark, so
// "1-3% vs 20%" arguments have a shared yardstick instead of raw,
// non-annualized total-return percentages that aren't comparable across
// windows of different lengths. Deliberately minimal: CAGR, max drawdown,
// Calmar, exposure, trades, benchmark comparison. Sharpe/Sortino/profit
// factor/expectancy are explicitly deferred, not part of this module yet.
//
// Pure, generic functions (take primitives, not PortfolioSimResult) so this
// is reusable by any future strategy backtest (e.g. ETF Rotation, Phase 2)
// without depending on backtest-portfolio.ts's specific result shape - same
// pure/adapter split already used by applyStickyTrip (portfolioCircuitBreaker.ts).

const DAYS_PER_YEAR = 365;

/**
 * Annualizes a total return over simDays into a CAGR percent.
 * (1 + totalReturnPercent/100) ^ (365/simDays) - 1, as a percent.
 */
export function computeCagrPercent(
  totalReturnPercent: number,
  simDays: number,
): number {
  if (simDays <= 0) {
    throw new Error(`computeCagrPercent: simDays must be > 0, got ${simDays}`);
  }

  const growthFactor = 1 + totalReturnPercent / 100;

  // A total return of -100% or worse means the growth factor is <= 0,
  // which has no real-valued exponentiation - report -100% (total loss)
  // rather than NaN.
  if (growthFactor <= 0) {
    return -100;
  }

  const annualizedGrowth = Math.pow(growthFactor, DAYS_PER_YEAR / simDays);

  return (annualizedGrowth - 1) * 100;
}

/**
 * Calmar ratio: CAGR / |max drawdown|. Null when maxDrawdownPercent is 0
 * (no drawdown to divide by) - avoids Infinity/NaN leaking into a report.
 */
export function computeCalmarRatio(
  cagrPercent: number,
  maxDrawdownPercent: number,
): number | null {
  if (maxDrawdownPercent === 0) {
    return null;
  }

  return cagrPercent / Math.abs(maxDrawdownPercent);
}

export interface ScorecardMetrics {
  totalReturnPercent: number;
  cagrPercent: number;
  maxDrawdownPercent: number;
  calmarRatio: number | null;
  avgExposurePercent: number;
  totalTrades: number;
  simDays: number;
}

export interface BenchmarkMetrics {
  label: string;
  totalReturnPercent: number;
  cagrPercent: number;
}

export function buildScorecardMetrics(input: {
  totalReturnPercent: number;
  maxDrawdownPercent: number;
  avgExposurePercent: number;
  totalTrades: number;
  simDays: number;
}): ScorecardMetrics {
  const cagrPercent = computeCagrPercent(
    input.totalReturnPercent,
    input.simDays,
  );

  return {
    totalReturnPercent: input.totalReturnPercent,
    cagrPercent,
    maxDrawdownPercent: input.maxDrawdownPercent,
    calmarRatio: computeCalmarRatio(cagrPercent, input.maxDrawdownPercent),
    avgExposurePercent: input.avgExposurePercent,
    totalTrades: input.totalTrades,
    simDays: input.simDays,
  };
}

export function buildBenchmarkMetrics(
  label: string,
  totalReturnPercent: number,
  simDays: number,
): BenchmarkMetrics {
  return {
    label,
    totalReturnPercent,
    cagrPercent: computeCagrPercent(totalReturnPercent, simDays),
  };
}

function pct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function calmarText(calmarRatio: number | null): string {
  return calmarRatio === null ? "n/a" : calmarRatio.toFixed(2);
}

// Below this, annualizing a short-window return produces a CAGR that's
// mathematically correct but not a meaningful expectation (e.g. a 41-day
// +4% return annualizes to +40%+) - observed for real on a short single-
// window run during development of this module, not a hypothetical.
const SHORT_WINDOW_DAYS_THRESHOLD = 180;

export function formatScorecardMarkdown(
  strategyLabel: string,
  strategy: ScorecardMetrics,
  benchmarks: BenchmarkMetrics[],
): string {
  const rows = [
    `| ${strategyLabel} | ${pct(strategy.totalReturnPercent)} | ${pct(strategy.cagrPercent)} | ${pct(strategy.maxDrawdownPercent)} | ${calmarText(strategy.calmarRatio)} | ${strategy.avgExposurePercent.toFixed(1)}% | ${strategy.totalTrades} |`,
    ...benchmarks.map(
      (benchmark) =>
        `| ${benchmark.label} | ${pct(benchmark.totalReturnPercent)} | ${pct(benchmark.cagrPercent)} | n/a | n/a | n/a | n/a |`,
    ),
  ];

  const shortWindowCaveat =
    strategy.simDays < SHORT_WINDOW_DAYS_THRESHOLD
      ? `\n**Window is only ${strategy.simDays} days** - CAGR annualizes the observed return, so the shorter the window, the more extreme (and less meaningful as a forecast) the annualized number becomes. Treat CAGR here as directionally informative only, not a return estimate. Prefer a multi-window run (\`backtest-portfolio-multiwindow.ts\`) with longer windows for anything that informs a real decision.\n`
      : "";

  return `## Scorecard

Over ${strategy.simDays} simulated days. Benchmarks have no drawdown-managed exit or exposure/trade concept, so those columns are n/a for them - they're included for CAGR comparison only.

| Label | Total return | CAGR | Max drawdown | Calmar | Avg exposure | Trades |
| --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}
${shortWindowCaveat}`;
}

export const SCORECARD_CSV_HEADER: string[] = [
  "label",
  "total_return_pct",
  "cagr_pct",
  "max_drawdown_pct",
  "calmar_ratio",
  "avg_exposure_pct",
  "total_trades",
  "sim_days",
];

export function formatScorecardCsvRow(
  label: string,
  metrics: ScorecardMetrics,
): string[] {
  return [
    label,
    metrics.totalReturnPercent.toFixed(2),
    metrics.cagrPercent.toFixed(2),
    metrics.maxDrawdownPercent.toFixed(2),
    metrics.calmarRatio === null ? "n/a" : metrics.calmarRatio.toFixed(2),
    metrics.avgExposurePercent.toFixed(1),
    String(metrics.totalTrades),
    String(metrics.simDays),
  ];
}

// Matches SCORECARD_CSV_HEADER's 8 columns exactly (label, total_return_pct,
// cagr_pct, max_drawdown_pct, calmar_ratio, avg_exposure_pct, total_trades,
// sim_days) - a benchmark has no drawdown-managed exit or exposure/trade/
// sim_days concept of its own, so those 5 columns are "n/a".
export function formatBenchmarkCsvRow(benchmark: BenchmarkMetrics): string[] {
  return [
    benchmark.label,
    benchmark.totalReturnPercent.toFixed(2),
    benchmark.cagrPercent.toFixed(2),
    "n/a",
    "n/a",
    "n/a",
    "n/a",
    "n/a",
  ];
}
