import { describe, expect, it } from "vitest";

import { evaluatePortfolioDrawdown } from "./portfolioCircuitBreaker.js";

describe("evaluatePortfolioDrawdown", () => {
  it("does not trip when equity is at a new peak", () => {
    const result = evaluatePortfolioDrawdown(10000, 10000, -0.15);

    expect(result.tripped).toBe(false);
    expect(result.drawdownPercent).toBe(0);
  });

  it("does not trip when drawdown is smaller than the threshold", () => {
    const result = evaluatePortfolioDrawdown(9200, 10000, -0.15);

    expect(result.tripped).toBe(false);
    expect(result.drawdownPercent).toBeCloseTo(-0.08, 5);
  });

  it("trips exactly at the threshold", () => {
    const result = evaluatePortfolioDrawdown(8500, 10000, -0.15);

    expect(result.tripped).toBe(true);
    expect(result.drawdownPercent).toBeCloseTo(-0.15, 5);
  });

  it("trips when drawdown exceeds the threshold", () => {
    const result = evaluatePortfolioDrawdown(7000, 10000, -0.15);

    expect(result.tripped).toBe(true);
    expect(result.drawdownPercent).toBeCloseTo(-0.3, 5);
  });

  it("respects a custom threshold", () => {
    // 9400/10000 is a fixed -6% drawdown; only the threshold varies.
    const notTripped = evaluatePortfolioDrawdown(9400, 10000, -0.1);
    const tripped = evaluatePortfolioDrawdown(9400, 10000, -0.03);

    expect(notTripped.tripped).toBe(false);
    expect(tripped.tripped).toBe(true);
  });

  it("never trips when peak equity is zero or negative", () => {
    const result = evaluatePortfolioDrawdown(100, 0, -0.15);

    expect(result.tripped).toBe(false);
    expect(result.drawdownPercent).toBe(0);
  });
});
