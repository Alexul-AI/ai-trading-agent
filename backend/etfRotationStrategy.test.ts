import { describe, expect, it } from "vitest";

import {
  computeMomentumReturnPercent,
  decideRotationTargets,
  isMonthlyRebalanceDate,
  passesTrendFilter,
  type EtfRotationConfig,
} from "./etfRotationStrategy.js";

describe("computeMomentumReturnPercent", () => {
  it("computes the trailing return over the lookback window", () => {
    const prices = Array.from({ length: 130 }, (_, i) => 100 + i); // 100..229
    // current = 229 (index 129), lookback 126 -> price at index 3 = 103.
    expect(computeMomentumReturnPercent(prices, 126)).toBeCloseTo(
      ((229 - 103) / 103) * 100,
      5,
    );
  });

  it("returns null when there isn't enough history", () => {
    const prices = Array.from({ length: 100 }, (_, i) => 100 + i);
    expect(computeMomentumReturnPercent(prices, 126)).toBeNull();
  });

  it("returns null instead of 0 for a flat-vs-missing distinction (not enough history is unknown, not neutral)", () => {
    const prices = Array.from({ length: 126 }, () => 100); // exactly at the boundary, still not > lookbackDays
    expect(computeMomentumReturnPercent(prices, 126)).toBeNull();
  });
});

describe("passesTrendFilter", () => {
  it("passes when price is above its trailing SMA", () => {
    const prices = [
      ...Array.from({ length: 199 }, () => 100),
      120, // current price, well above the SMA of the trailing window
    ];
    expect(passesTrendFilter(prices, 200)).toBe(true);
  });

  it("fails when price is below its trailing SMA", () => {
    const prices = [...Array.from({ length: 199 }, () => 100), 80];
    expect(passesTrendFilter(prices, 200)).toBe(false);
  });

  it("fails closed when there isn't enough history, rather than trivially passing against calculateSMA's 0 fallback", () => {
    const prices = Array.from({ length: 50 }, () => 100);
    expect(passesTrendFilter(prices, 200)).toBe(false);
  });
});

describe("isMonthlyRebalanceDate", () => {
  it("is always true on the first simulated day", () => {
    expect(isMonthlyRebalanceDate("2026-01-15", null)).toBe(true);
  });

  it("is true when the calendar month changes", () => {
    expect(isMonthlyRebalanceDate("2026-02-01", "2026-01-31")).toBe(true);
  });

  it("is false within the same calendar month", () => {
    expect(isMonthlyRebalanceDate("2026-01-20", "2026-01-15")).toBe(false);
  });

  it("is true across a year boundary", () => {
    expect(isMonthlyRebalanceDate("2027-01-02", "2026-12-30")).toBe(true);
  });
});

describe("decideRotationTargets", () => {
  const config: EtfRotationConfig = {
    universe: ["SPY", "QQQ", "EFA", "TLT", "GLD"],
    momentumLookbackDays: 5,
    trendFilterSmaPeriod: 5,
    holdCount: 2,
  };

  function risingSeries(totalReturnPercent: number, length = 10): number[] {
    // Monotonically rising from a fixed start of 100 to
    // 100*(1+totalReturnPercent/100) - passes the trend filter by
    // construction (the series max is always the last value), and, unlike
    // scaling the increment by an arbitrary "final price," totalReturnPercent
    // directly and unambiguously controls momentum ranking across tickers
    // regardless of any absolute price level.
    const start = 100;
    const end = start * (1 + totalReturnPercent / 100);

    return Array.from(
      { length },
      (_, i) => start + ((end - start) * i) / (length - 1),
    );
  }

  function fallingBelowSma(length = 10): number[] {
    // Sits below its own trailing SMA at the end - fails the trend filter
    // even though it may still rank well on raw momentum.
    return [
      ...Array.from({ length: length - 1 }, () => 100),
      80,
    ];
  }

  it("picks the top holdCount by momentum and equal-weights them", () => {
    const history = new Map<string, number[]>([
      ["SPY", risingSeries(10)],
      ["QQQ", risingSeries(30)], // strongest momentum
      ["EFA", risingSeries(5)],
      ["TLT", risingSeries(2)],
      ["GLD", risingSeries(20)], // second strongest
    ]);

    const targets = decideRotationTargets(history, config);

    expect(targets.map((t) => t.ticker).sort()).toEqual(["GLD", "QQQ"]);
    expect(targets.every((t) => t.weightPercent === 50)).toBe(true);
  });

  it("excludes tickers with insufficient history from ranking entirely", () => {
    const history = new Map<string, number[]>([
      ["SPY", risingSeries(10)],
      ["QQQ", risingSeries(30)],
      ["EFA", [100, 101]], // too short for momentumLookbackDays=5
      ["TLT", risingSeries(2)],
      ["GLD", risingSeries(20)],
    ]);

    const targets = decideRotationTargets(history, config);

    expect(targets.some((t) => t.ticker === "EFA")).toBe(false);
  });

  it("replaces a trend-filter failure with cash instead of promoting the next-ranked ticker", () => {
    // QQQ: ran up hard (50 -> 150) then crashed just before "now" (150 ->
    // 90) - momentum over the lookback is still a huge +80% (90 vs the
    // starting 50), ranking it #1, but 90 sits well below the trailing
    // SMA(5) of [150,150,150,150,90]=138, so it fails the trend filter.
    const qqqHighMomentumBelowSma = [50, 150, 150, 150, 150, 90];

    const history = new Map<string, number[]>([
      ["SPY", risingSeries(10)],
      ["QQQ", qqqHighMomentumBelowSma], // +80% momentum, but fails the trend filter
      ["EFA", risingSeries(5)],
      ["TLT", risingSeries(2)],
      ["GLD", risingSeries(20)], // second strongest among the legitimate picks
    ]);

    const targets = decideRotationTargets(history, config);

    expect(targets.some((t) => t.ticker === "QQQ")).toBe(false);
    // Only GLD (the #2-ranked, trend-filter-passing ticker) is held - QQQ's
    // slot went to cash, it was not backfilled by a #3-ranked ticker.
    expect(targets).toHaveLength(1);
    expect(targets[0]!.ticker).toBe("GLD");
    const totalWeight = targets.reduce((sum, t) => sum + t.weightPercent, 0);
    expect(totalWeight).toBeLessThan(100);
  });

  it("returns an empty array (all cash) when nothing qualifies", () => {
    const history = new Map<string, number[]>(
      config.universe.map((ticker) => [ticker, fallingBelowSma()]),
    );

    const targets = decideRotationTargets(history, config);

    expect(targets).toEqual([]);
  });
});
