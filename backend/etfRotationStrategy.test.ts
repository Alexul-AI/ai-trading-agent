import { describe, expect, it } from "vitest";

import {
  computeMomentumReturnPercent,
  computeRebalanceOrders,
  decideRotationTargets,
  isMonthlyRebalanceDate,
  passesTrendFilter,
  resolveEtfRotationConfigVariant,
  ETF_ROTATION_MVP_BASELINE_CONFIG,
  ETF_ROTATION_HOLD3_CANDIDATE_CONFIG,
  type EtfRotationConfig,
  type RotationTarget,
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

describe("resolveEtfRotationConfigVariant", () => {
  it("resolves the exact candidate string to candidate-hold3", () => {
    expect(resolveEtfRotationConfigVariant("candidate-hold3")).toBe(
      "candidate-hold3",
    );
  });

  it("fails safe to baseline-2 when unset, empty, or unrecognized - never silently runs the unvalidated candidate", () => {
    expect(resolveEtfRotationConfigVariant(undefined)).toBe("baseline-2");
    expect(resolveEtfRotationConfigVariant("")).toBe("baseline-2");
    expect(resolveEtfRotationConfigVariant("candidate-hold4")).toBe(
      "baseline-2",
    );
    expect(resolveEtfRotationConfigVariant("Candidate-Hold3")).toBe(
      "baseline-2",
    );
  });
});

describe("ETF_ROTATION_HOLD3_CANDIDATE_CONFIG", () => {
  it("only changes holdCount, inheriting everything else from the baseline unchanged", () => {
    expect(ETF_ROTATION_HOLD3_CANDIDATE_CONFIG.holdCount).toBe(3);
    expect(ETF_ROTATION_HOLD3_CANDIDATE_CONFIG.universe).toEqual(
      ETF_ROTATION_MVP_BASELINE_CONFIG.universe,
    );
    expect(ETF_ROTATION_HOLD3_CANDIDATE_CONFIG.momentumLookbackDays).toBe(
      ETF_ROTATION_MVP_BASELINE_CONFIG.momentumLookbackDays,
    );
    expect(ETF_ROTATION_HOLD3_CANDIDATE_CONFIG.trendFilterSmaPeriod).toBe(
      ETF_ROTATION_MVP_BASELINE_CONFIG.trendFilterSmaPeriod,
    );
  });
});

describe("computeRebalanceOrders", () => {
  const universe = ["SPY", "QQQ", "EFA", "TLT", "GLD"];

  it("sells everything currently held in the universe, before buying targets", () => {
    const targets: RotationTarget[] = [{ ticker: "QQQ", weightPercent: 50 }];
    const currentShares = new Map([
      ["SPY", 10],
      ["TLT", 5],
    ]);
    const prices = new Map([
      ["SPY", 500],
      ["TLT", 90],
      ["QQQ", 400],
    ]);

    const orders = computeRebalanceOrders(
      targets,
      10000,
      currentShares,
      prices,
      universe,
    );

    // Sells come first, in universe order.
    expect(orders[0]).toEqual({ ticker: "SPY", action: "SELL", shares: 10 });
    expect(orders[1]).toEqual({ ticker: "TLT", action: "SELL", shares: 5 });
    // Then the buy, sized from equity * weightPercent / price, floored.
    expect(orders[2]).toEqual({
      ticker: "QQQ",
      action: "BUY",
      shares: 12, // floor(10000 * 0.5 / 400) = 12
      targetWeightPercent: 50,
    });
  });

  it("does not sell a ticker with zero current shares", () => {
    const orders = computeRebalanceOrders(
      [],
      10000,
      new Map([["SPY", 0]]),
      new Map(),
      universe,
    );

    expect(orders).toEqual([]);
  });

  it("skips a buy target with no known price rather than dividing by zero", () => {
    const targets: RotationTarget[] = [{ ticker: "GLD", weightPercent: 100 }];

    const orders = computeRebalanceOrders(
      targets,
      10000,
      new Map(),
      new Map(), // no price for GLD
      universe,
    );

    expect(orders).toEqual([]);
  });

  it("skips a buy target that would floor to 0 shares", () => {
    const targets: RotationTarget[] = [{ ticker: "GLD", weightPercent: 1 }];

    const orders = computeRebalanceOrders(
      targets,
      100, // 1% of 100 = $1, GLD costs way more than that
      new Map(),
      new Map([["GLD", 250]]),
      universe,
    );

    expect(orders).toEqual([]);
  });

  it("returns an empty array when there is nothing to sell and no targets", () => {
    expect(computeRebalanceOrders([], 10000, new Map(), new Map(), universe)).toEqual(
      [],
    );
  });
});
