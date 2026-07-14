import { describe, expect, it } from "vitest";

import {
  buildBenchmarkMetrics,
  buildScorecardMetrics,
  calendarDaysInclusive,
  computeCagrPercent,
  computeCalmarRatio,
  formatBenchmarkCsvRow,
  formatScorecardCsvRow,
  formatScorecardMarkdown,
  SCORECARD_CSV_HEADER,
} from "./scorecard.js";

describe("calendarDaysInclusive", () => {
  it("returns 1 for the same start and end date", () => {
    expect(calendarDaysInclusive("2026-01-01", "2026-01-01")).toBe(1);
  });

  it("counts a non-leap calendar year as 365 inclusive days plus one", () => {
    // 2025-01-01 -> 2026-01-01 spans exactly 365 days, +1 for inclusivity.
    expect(calendarDaysInclusive("2025-01-01", "2026-01-01")).toBe(366);
  });

  it("matches the real window that motivated this fix: 2024-11-25 to 2026-07-13", () => {
    // This is the exact "Current (~900d)" window from a real multi-window
    // run - 406 trading days (Alpaca daily bars, weekends/holidays absent)
    // but a materially longer calendar span. Locks in the regression this
    // function exists to fix: CAGR must annualize over this number, not 406.
    expect(calendarDaysInclusive("2024-11-25", "2026-07-13")).toBe(596);
  });
});

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

  it("throws for a non-positive annualizationDays", () => {
    expect(() => computeCagrPercent(10, 0)).toThrow();
    expect(() => computeCagrPercent(10, -5)).toThrow();
  });

  it("regression: using trading-day count instead of calendar days overstates CAGR magnitude", () => {
    // The exact bug this module was shipped with: -9.68% total return over
    // 406 Alpaca trading-day bars, spanning 2024-11-25 to 2026-07-13 (596
    // calendar days). The wrong (trading-day) computation gives ~-8.75%;
    // the correct (calendar-day) computation gives a materially smaller
    // magnitude, ~-6.05%.
    const wrongUsingTradingDays = computeCagrPercent(-9.68, 406);
    const correctUsingCalendarDays = computeCagrPercent(-9.68, 596);

    expect(wrongUsingTradingDays).toBeCloseTo(-8.75, 1);
    expect(correctUsingCalendarDays).toBeCloseTo(-6.05, 1);
    expect(Math.abs(correctUsingCalendarDays)).toBeLessThan(
      Math.abs(wrongUsingTradingDays),
    );
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
  it("assembles CAGR and Calmar using annualizationDays, not simTradingDays", () => {
    const metrics = buildScorecardMetrics({
      totalReturnPercent: 10,
      maxDrawdownPercent: -20,
      avgExposurePercent: 55.5,
      totalTrades: 42,
      simTradingDays: 252,
      annualizationDays: 365,
    });

    expect(metrics.cagrPercent).toBeCloseTo(10, 5);
    expect(metrics.calmarRatio).toBeCloseTo(0.5, 5);
    expect(metrics.avgExposurePercent).toBe(55.5);
    expect(metrics.totalTrades).toBe(42);
    expect(metrics.simTradingDays).toBe(252);
    expect(metrics.annualizationDays).toBe(365);
  });

  it("produces a different CAGR when simTradingDays and annualizationDays diverge (the bug this fixes)", () => {
    const usingTradingDaysAsIfCalendar = buildScorecardMetrics({
      totalReturnPercent: -9.68,
      maxDrawdownPercent: -16.17,
      avgExposurePercent: 19.2,
      totalTrades: 177,
      simTradingDays: 406,
      annualizationDays: 406, // wrong on purpose, for comparison
    });
    const usingRealCalendarDays = buildScorecardMetrics({
      totalReturnPercent: -9.68,
      maxDrawdownPercent: -16.17,
      avgExposurePercent: 19.2,
      totalTrades: 177,
      simTradingDays: 406,
      annualizationDays: 596,
    });

    expect(usingRealCalendarDays.cagrPercent).not.toBeCloseTo(
      usingTradingDaysAsIfCalendar.cagrPercent,
      0,
    );
    expect(Math.abs(usingRealCalendarDays.cagrPercent)).toBeLessThan(
      Math.abs(usingTradingDaysAsIfCalendar.cagrPercent),
    );
  });
});

describe("buildBenchmarkMetrics", () => {
  it("computes CAGR for a benchmark the same way as the strategy", () => {
    const benchmark = buildBenchmarkMetrics("SPY buy & hold", 21, 730);

    expect(benchmark.label).toBe("SPY buy & hold");
    expect(benchmark.cagrPercent).toBeCloseTo(10, 1);
    expect(benchmark.annualizationDays).toBe(730);
  });
});

describe("formatScorecardMarkdown / formatScorecardCsvRow", () => {
  const metrics = buildScorecardMetrics({
    totalReturnPercent: 10,
    maxDrawdownPercent: -20,
    avgExposurePercent: 55.5,
    totalTrades: 42,
    simTradingDays: 252,
    annualizationDays: 365,
  });
  const benchmark = buildBenchmarkMetrics("SPY buy & hold", 15, 365);

  it("renders n/a for benchmark exposure/trades/Calmar cells, not undefined or NaN", () => {
    const markdown = formatScorecardMarkdown("Strategy", metrics, [benchmark]);

    expect(markdown).toContain("SPY buy & hold");
    expect(markdown).not.toContain("undefined");
    expect(markdown).not.toContain("NaN");
    // The benchmark row should have n/a in its last four columns.
    const benchmarkRow = markdown
      .split("\n")
      .find((line) => line.includes("SPY buy & hold"));
    expect(benchmarkRow).toBeDefined();
    expect(benchmarkRow!.match(/n\/a/g)).toHaveLength(4);
  });

  it("shows both trading days and calendar days in the prose", () => {
    const markdown = formatScorecardMarkdown("Strategy", metrics, []);

    expect(markdown).toContain("252 trading days");
    expect(markdown).toContain("365 calendar days");
  });

  it("formats a CSV row with n/a for a null Calmar ratio", () => {
    const zeroDrawdownMetrics = buildScorecardMetrics({
      totalReturnPercent: 5,
      maxDrawdownPercent: 0,
      avgExposurePercent: 10,
      totalTrades: 1,
      simTradingDays: 252,
      annualizationDays: 365,
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

  it("uses the benchmark's real annualization_calendar_days, not n/a", () => {
    const benchmarkRow = formatBenchmarkCsvRow(benchmark);
    const annualizationDaysIndex = SCORECARD_CSV_HEADER.indexOf(
      "annualization_calendar_days",
    );

    expect(benchmarkRow[annualizationDaysIndex]).toBe("365");
  });

  it("adds a short-window caveat when annualizationDays is below the threshold, and omits it for a full-length window", () => {
    const shortWindowMetrics = buildScorecardMetrics({
      totalReturnPercent: 4,
      maxDrawdownPercent: -4,
      avgExposurePercent: 70,
      totalTrades: 10,
      simTradingDays: 30,
      annualizationDays: 41,
    });

    const shortMarkdown = formatScorecardMarkdown(
      "Strategy",
      shortWindowMetrics,
      [],
    );
    const longMarkdown = formatScorecardMarkdown("Strategy", metrics, []);

    expect(shortMarkdown).toContain("Window is only 41 calendar days");
    expect(longMarkdown).not.toContain("Window is only");
  });
});
