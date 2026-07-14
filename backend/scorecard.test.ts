import { describe, expect, it } from "vitest";

import {
  buildBenchmarkMetrics,
  buildScorecardMetrics,
  computeCagrPercent,
  computeCalmarRatio,
  formatBenchmarkCsvRow,
  formatScorecardCsvRow,
  formatScorecardMarkdown,
  SCORECARD_CSV_HEADER,
} from "./scorecard.js";

describe("computeCagrPercent", () => {
  it("returns the same value for an exact one-year window", () => {
    expect(computeCagrPercent(10, 365)).toBeCloseTo(10, 5);
  });

  it("annualizes a two-year compounding return correctly", () => {
    // 1.10^2 = 1.21 -> +21% over 2 years should annualize back to +10%/yr.
    expect(computeCagrPercent(21, 730)).toBeCloseTo(10, 1);
  });

  it("handles negative returns without crashing", () => {
    expect(computeCagrPercent(-20, 365)).toBeCloseTo(-20, 5);
  });

  it("caps a total loss (-100% or worse) at -100 instead of NaN", () => {
    expect(computeCagrPercent(-100, 365)).toBe(-100);
    expect(computeCagrPercent(-150, 365)).toBe(-100);
  });

  it("does not produce NaN/Infinity for a very short window", () => {
    const result = computeCagrPercent(1, 1);
    expect(Number.isFinite(result)).toBe(true);
  });

  it("throws for a non-positive simDays", () => {
    expect(() => computeCagrPercent(10, 0)).toThrow();
    expect(() => computeCagrPercent(10, -5)).toThrow();
  });
});

describe("computeCalmarRatio", () => {
  it("divides CAGR by the absolute max drawdown", () => {
    expect(computeCalmarRatio(10, -20)).toBeCloseTo(0.5, 5);
    expect(computeCalmarRatio(-10, -20)).toBeCloseTo(-0.5, 5);
  });

  it("returns null when max drawdown is exactly 0, not Infinity", () => {
    expect(computeCalmarRatio(10, 0)).toBeNull();
  });
});

describe("buildScorecardMetrics", () => {
  it("assembles CAGR and Calmar alongside the passthrough fields", () => {
    const metrics = buildScorecardMetrics({
      totalReturnPercent: 10,
      maxDrawdownPercent: -20,
      avgExposurePercent: 55.5,
      totalTrades: 42,
      simDays: 365,
    });

    expect(metrics.cagrPercent).toBeCloseTo(10, 5);
    expect(metrics.calmarRatio).toBeCloseTo(0.5, 5);
    expect(metrics.avgExposurePercent).toBe(55.5);
    expect(metrics.totalTrades).toBe(42);
    expect(metrics.simDays).toBe(365);
  });
});

describe("buildBenchmarkMetrics", () => {
  it("computes CAGR for a benchmark the same way as the strategy", () => {
    const benchmark = buildBenchmarkMetrics("SPY buy & hold", 21, 730);

    expect(benchmark.label).toBe("SPY buy & hold");
    expect(benchmark.cagrPercent).toBeCloseTo(10, 1);
  });
});

describe("formatScorecardMarkdown / formatScorecardCsvRow", () => {
  const metrics = buildScorecardMetrics({
    totalReturnPercent: 10,
    maxDrawdownPercent: -20,
    avgExposurePercent: 55.5,
    totalTrades: 42,
    simDays: 365,
  });
  const benchmark = buildBenchmarkMetrics("SPY buy & hold", 15, 365);

  it("renders n/a for benchmark exposure/trades/Calmar cells, not undefined or NaN", () => {
    const markdown = formatScorecardMarkdown("Strategy", metrics, [benchmark]);

    expect(markdown).toContain("SPY buy & hold");
    expect(markdown).not.toContain("undefined");
    expect(markdown).not.toContain("NaN");
    // The benchmark row should have n/a in its last three columns.
    const benchmarkRow = markdown
      .split("\n")
      .find((line) => line.includes("SPY buy & hold"));
    expect(benchmarkRow).toBeDefined();
    expect(benchmarkRow!.match(/n\/a/g)).toHaveLength(4);
  });

  it("formats a CSV row with n/a for a null Calmar ratio", () => {
    const zeroDrawdownMetrics = buildScorecardMetrics({
      totalReturnPercent: 5,
      maxDrawdownPercent: 0,
      avgExposurePercent: 10,
      totalTrades: 1,
      simDays: 365,
    });

    const row = formatScorecardCsvRow("Strategy", zeroDrawdownMetrics);

    expect(row).toContain("n/a");
    expect(row).not.toContain("NaN");
  });

  it("keeps formatScorecardCsvRow and formatBenchmarkCsvRow column counts equal to SCORECARD_CSV_HEADER (columns must not shift between strategy and benchmark rows in the same CSV)", () => {
    const strategyRow = formatScorecardCsvRow("Strategy", metrics);
    const benchmarkRow = formatBenchmarkCsvRow(benchmark);

    expect(strategyRow).toHaveLength(SCORECARD_CSV_HEADER.length);
    expect(benchmarkRow).toHaveLength(SCORECARD_CSV_HEADER.length);
  });

  it("adds a short-window caveat when simDays is below the threshold, and omits it for a full-length window", () => {
    const shortWindowMetrics = buildScorecardMetrics({
      totalReturnPercent: 4,
      maxDrawdownPercent: -4,
      avgExposurePercent: 70,
      totalTrades: 10,
      simDays: 41,
    });

    const shortMarkdown = formatScorecardMarkdown(
      "Strategy",
      shortWindowMetrics,
      [],
    );
    const longMarkdown = formatScorecardMarkdown("Strategy", metrics, []);

    expect(shortMarkdown).toContain("Window is only 41 days");
    expect(longMarkdown).not.toContain("Window is only");
  });
});
