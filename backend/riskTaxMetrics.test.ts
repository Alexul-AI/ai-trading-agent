import { describe, expect, it } from "vitest";

import {
  computeDailyReturnStats,
  computeFrictionSensitivity,
  computeRealizedGainLoss,
  computeTaxDragScenarios,
  computeTurnoverStats,
} from "./riskTaxMetrics.js";

describe("computeDailyReturnStats", () => {
  it("returns zeroed/null stats for fewer than 2 equity points", () => {
    expect(computeDailyReturnStats([])).toEqual({
      observationCount: 0,
      meanDailyReturnPercent: 0,
      annualizedVolatilityPercent: 0,
      sharpeRatio: null,
      sortinoRatio: null,
    });
    expect(computeDailyReturnStats([{ equity: 100 }])).toEqual({
      observationCount: 0,
      meanDailyReturnPercent: 0,
      annualizedVolatilityPercent: 0,
      sharpeRatio: null,
      sortinoRatio: null,
    });
  });

  it("is all-zero/null for a perfectly flat equity curve (no volatility to divide by)", () => {
    const stats = computeDailyReturnStats([{ equity: 100 }, { equity: 100 }, { equity: 100 }]);

    expect(stats.observationCount).toBe(2);
    expect(stats.meanDailyReturnPercent).toBe(0);
    expect(stats.annualizedVolatilityPercent).toBe(0);
    expect(stats.sharpeRatio).toBeNull();
    expect(stats.sortinoRatio).toBeNull();
  });

  it("matches a hand-computed example: +10%/-10% daily swing", () => {
    // Day 1: 100 -> 110 = +10%. Day 2: 110 -> 99 = exactly -10%.
    // mean = 0, variance = ((10-0)^2 + (-10-0)^2)/2 = 100, stdev = 10.
    const stats = computeDailyReturnStats([{ equity: 100 }, { equity: 110 }, { equity: 99 }]);

    expect(stats.observationCount).toBe(2);
    expect(stats.meanDailyReturnPercent).toBeCloseTo(0, 10);
    expect(stats.annualizedVolatilityPercent).toBeCloseTo(10 * Math.sqrt(252), 5);
    // mean excess return is 0 (0% risk-free default), so both ratios are exactly 0, not null.
    expect(stats.sharpeRatio).toBeCloseTo(0, 10);
    expect(stats.sortinoRatio).toBeCloseTo(0, 10);
  });

  it("is null for Sortino specifically (not Sharpe) when every daily return is at or above the risk-free rate", () => {
    // Two positive, unequal daily returns - real (nonzero) volatility, but
    // nothing below the 0% MAR, so downside deviation is 0.
    const stats = computeDailyReturnStats([{ equity: 100 }, { equity: 105 }, { equity: 110 }]);

    expect(stats.annualizedVolatilityPercent).toBeGreaterThan(0);
    expect(stats.sharpeRatio).not.toBeNull();
    expect(stats.sortinoRatio).toBeNull();
  });

  it("subtracts a nonzero annual risk-free rate from the mean before computing Sharpe/Sortino", () => {
    const noRiskFree = computeDailyReturnStats(
      [{ equity: 100 }, { equity: 101 }, { equity: 99 }],
      0,
    );
    const withRiskFree = computeDailyReturnStats(
      [{ equity: 100 }, { equity: 101 }, { equity: 99 }],
      10, // 10% annual risk-free rate
    );

    expect(withRiskFree.sharpeRatio!).toBeLessThan(noRiskFree.sharpeRatio!);
  });

  it("skips a division-by-zero day (equity <= 0) rather than producing NaN/Infinity", () => {
    const stats = computeDailyReturnStats([{ equity: 100 }, { equity: 0 }, { equity: 50 }]);

    expect(Number.isFinite(stats.meanDailyReturnPercent)).toBe(true);
    expect(Number.isFinite(stats.annualizedVolatilityPercent)).toBe(true);
  });
});

describe("computeTurnoverStats", () => {
  it("matches a hand-computed round trip: gross turnover, annualized turnover, holding period", () => {
    const trades = [
      { date: "2026-01-01", ticker: "SPY", action: "BUY" as const, shares: 10, price: 100 },
      { date: "2026-02-01", ticker: "SPY", action: "SELL" as const, shares: 10, price: 110 },
    ];

    // Gross turnover: $1,000 (buy) + $1,100 (sell) = $2,100.
    // Annualized over exactly 365 calendar days at $1,000 avg equity:
    // (2100/1000) * (365/365) * 100 = 210%.
    // Holding period: 2026-02-01 - 2026-01-01 = 31 calendar days.
    const stats = computeTurnoverStats(trades, 1000, 365);

    expect(stats.grossTurnoverUsd).toBe(2100);
    expect(stats.annualizedTurnoverPercent).toBeCloseTo(210, 5);
    expect(stats.averageHoldingPeriodDays).toBe(31);
  });

  it("is null for averageHoldingPeriodDays when there are no SELLs yet", () => {
    const trades = [
      { date: "2026-01-01", ticker: "SPY", action: "BUY" as const, shares: 10, price: 100 },
    ];

    const stats = computeTurnoverStats(trades, 1000, 365);

    expect(stats.grossTurnoverUsd).toBe(1000);
    expect(stats.averageHoldingPeriodDays).toBeNull();
  });

  it("is all-zero for an empty trade log", () => {
    const stats = computeTurnoverStats([], 1000, 365);

    expect(stats.grossTurnoverUsd).toBe(0);
    expect(stats.annualizedTurnoverPercent).toBe(0);
    expect(stats.averageHoldingPeriodDays).toBeNull();
  });
});

describe("computeRealizedGainLoss", () => {
  it("matches each SELL to its own immediately-preceding same-ticker BUY", () => {
    const trades = [
      { date: "2026-01-01", ticker: "SPY", action: "BUY" as const, shares: 10, price: 100 },
      { date: "2026-02-01", ticker: "SPY", action: "SELL" as const, shares: 10, price: 110 },
      { date: "2026-02-01", ticker: "QQQ", action: "BUY" as const, shares: 5, price: 200 },
      { date: "2026-03-01", ticker: "QQQ", action: "SELL" as const, shares: 5, price: 190 },
    ];

    const entries = computeRealizedGainLoss(trades);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      ticker: "SPY",
      buyDate: "2026-01-01",
      sellDate: "2026-02-01",
      daysHeld: 31,
      gainLossUsd: 100, // (110-100)*10
    });
    expect(entries[1]).toEqual({
      ticker: "QQQ",
      buyDate: "2026-02-01",
      sellDate: "2026-03-01",
      daysHeld: 28,
      gainLossUsd: -50, // (190-200)*5
    });
  });

  it("does not confuse a same-day SELL+rebuy of a continuing pick with itself (full liquidate-then-rebuy)", () => {
    // Ticker stays a top pick across 3 rebalances: sold and immediately
    // rebought at rebalances 2 and 3 (computeRebalanceOrders' actual
    // behavior) - the SELL at each rebalance must match the PRIOR buy,
    // not the same-day rebuy that appears later in the array.
    const trades = [
      { date: "2026-01-01", ticker: "SPY", action: "BUY" as const, shares: 10, price: 100 },
      { date: "2026-02-01", ticker: "SPY", action: "SELL" as const, shares: 10, price: 105 },
      { date: "2026-02-01", ticker: "SPY", action: "BUY" as const, shares: 10, price: 105 },
      { date: "2026-03-01", ticker: "SPY", action: "SELL" as const, shares: 10, price: 115 },
    ];

    const entries = computeRealizedGainLoss(trades);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      ticker: "SPY",
      buyDate: "2026-01-01",
      sellDate: "2026-02-01",
      daysHeld: 31,
      gainLossUsd: 50, // (105-100)*10
    });
    expect(entries[1]).toEqual({
      ticker: "SPY",
      buyDate: "2026-02-01",
      sellDate: "2026-03-01",
      daysHeld: 28,
      gainLossUsd: 100, // (115-105)*10
    });
  });

  it("skips a SELL with no matching preceding BUY rather than throwing", () => {
    const trades = [
      { date: "2026-01-01", ticker: "SPY", action: "SELL" as const, shares: 10, price: 100 },
    ];

    expect(computeRealizedGainLoss(trades)).toEqual([]);
  });
});

describe("computeTaxDragScenarios", () => {
  it("matches hand-computed after-tax figures for a net gain across 4 rates", () => {
    const scenarios = computeTaxDragScenarios(1000, 11000, 10000, [0, 15, 25, 35]);

    expect(scenarios).toEqual([
      { taxRatePercent: 0, taxOwedUsd: 0, afterTaxFinalEquityUsd: 11000, afterTaxTotalReturnPercent: 10 },
      { taxRatePercent: 15, taxOwedUsd: 150, afterTaxFinalEquityUsd: 10850, afterTaxTotalReturnPercent: 8.5 },
      { taxRatePercent: 25, taxOwedUsd: 250, afterTaxFinalEquityUsd: 10750, afterTaxTotalReturnPercent: 7.5 },
      { taxRatePercent: 35, taxOwedUsd: 350, afterTaxFinalEquityUsd: 10650, afterTaxTotalReturnPercent: 6.5 },
    ]);
  });

  it("owes 0 tax at every rate for a net realized loss (no negative tax/refund modeled)", () => {
    const scenarios = computeTaxDragScenarios(-500, 9500, 10000, [0, 25]);

    for (const scenario of scenarios) {
      expect(scenario.taxOwedUsd).toBe(0);
      expect(scenario.afterTaxFinalEquityUsd).toBe(9500);
      expect(scenario.afterTaxTotalReturnPercent).toBeCloseTo(-5, 10);
    }
  });
});

describe("computeFrictionSensitivity", () => {
  it("matches hand-computed adjusted returns across 4 friction levels", () => {
    const scenarios = computeFrictionSensitivity(100000, 11000, 10000, [0, 5, 10, 20]);

    expect(scenarios).toEqual([
      { additionalFrictionBps: 0, estimatedExtraCostUsd: 0, adjustedFinalEquityUsd: 11000, adjustedTotalReturnPercent: 10 },
      { additionalFrictionBps: 5, estimatedExtraCostUsd: 50, adjustedFinalEquityUsd: 10950, adjustedTotalReturnPercent: 9.5 },
      { additionalFrictionBps: 10, estimatedExtraCostUsd: 100, adjustedFinalEquityUsd: 10900, adjustedTotalReturnPercent: 9 },
      { additionalFrictionBps: 20, estimatedExtraCostUsd: 200, adjustedFinalEquityUsd: 10800, adjustedTotalReturnPercent: 8 },
    ]);
  });

  it("is a no-op at 0 additional bps (returns the unadjusted final equity)", () => {
    const [scenario] = computeFrictionSensitivity(50000, 12345, 10000, [0]);

    expect(scenario!.adjustedFinalEquityUsd).toBe(12345);
  });
});
