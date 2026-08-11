import { describe, expect, it } from "vitest";

import {
  assertValidEtfRotationConfig,
  computeDeltaRebalanceOrders,
  computeMomentumReturnPercent,
  computeRebalanceOrders,
  decideRotationTargets,
  isMonthlyRebalanceDate,
  passesTrendFilter,
  resolveEtfRotationConfigVariant,
  ETF_ROTATION_MVP_BASELINE_CONFIG,
  ETF_ROTATION_HOLD3_CANDIDATE_CONFIG,
  type EtfRotationConfig,
  type RebalanceOrder,
  type RotationTarget,
} from "./etfRotationStrategy.js";

describe("assertValidEtfRotationConfig", () => {
  it("does not throw for the shipped baseline (holdCount=2)", () => {
    expect(() =>
      assertValidEtfRotationConfig(ETF_ROTATION_MVP_BASELINE_CONFIG),
    ).not.toThrow();
  });

  it("does not throw for the hold3 candidate (holdCount=3)", () => {
    expect(() =>
      assertValidEtfRotationConfig(ETF_ROTATION_HOLD3_CANDIDATE_CONFIG),
    ).not.toThrow();
  });

  it("throws when holdCount is below 2", () => {
    const config: EtfRotationConfig = {
      ...ETF_ROTATION_MVP_BASELINE_CONFIG,
      holdCount: 1,
    };

    expect(() => assertValidEtfRotationConfig(config)).toThrow(/holdCount/);
  });

  it("throws when holdCount is 0", () => {
    const config: EtfRotationConfig = {
      ...ETF_ROTATION_MVP_BASELINE_CONFIG,
      holdCount: 0,
    };

    expect(() => assertValidEtfRotationConfig(config)).toThrow(/holdCount/);
  });

  it("throws when holdCount exceeds universe.length", () => {
    const config: EtfRotationConfig = {
      ...ETF_ROTATION_MVP_BASELINE_CONFIG,
      holdCount: 6, // universe has 5 tickers
    };

    expect(() => assertValidEtfRotationConfig(config)).toThrow(/holdCount/);
  });

  it("does not throw exactly at the universe.length upper bound", () => {
    const config: EtfRotationConfig = {
      ...ETF_ROTATION_MVP_BASELINE_CONFIG,
      holdCount: ETF_ROTATION_MVP_BASELINE_CONFIG.universe.length,
    };

    expect(() => assertValidEtfRotationConfig(config)).not.toThrow();
  });
});

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

  it("sells the exact fractional share quantity currently held, not rounded (proves fractional SELL is already safe end to end - see riskManager.ts's evaluateTrade, which Math.min's without ever flooring)", () => {
    const orders = computeRebalanceOrders(
      [],
      10000,
      new Map([["TLT", 1.5]]),
      new Map(),
      universe,
    );

    expect(orders).toEqual([{ ticker: "TLT", action: "SELL", shares: 1.5 }]);
  });

  describe("fractional-fallback BUY (allowFractionalShares, 2026-08-08 small-capital tranche design)", () => {
    it("skips the slot (does not fall back to notional) when allowFractionalShares is omitted - default behavior unchanged", () => {
      const targets: RotationTarget[] = [{ ticker: "SPY", weightPercent: 50 }];

      // 50% of $100 = $50; SPY at $773/share floors to 0 whole shares.
      const orders = computeRebalanceOrders(
        targets,
        100,
        new Map(),
        new Map([["SPY", 773]]),
        universe,
      );

      expect(orders).toEqual([]);
    });

    it("falls back to a notional order when whole-share sizing floors to 0, fractional mode is on, and the dollar amount clears the floor", () => {
      const targets: RotationTarget[] = [{ ticker: "SPY", weightPercent: 50 }];

      const orders = computeRebalanceOrders(
        targets,
        100,
        new Map(),
        new Map([["SPY", 773]]),
        universe,
        true, // allowFractionalShares
        5, // minFractionalNotionalUsd
      );

      expect(orders).toEqual([
        {
          ticker: "SPY",
          action: "BUY",
          shares: 0,
          notional: 50,
          targetWeightPercent: 50,
        },
      ]);
    });

    it("does not fall back to notional when the dollar amount is below minFractionalNotionalUsd, even with fractional mode on", () => {
      const targets: RotationTarget[] = [{ ticker: "GLD", weightPercent: 1 }];

      // 1% of $100 = $1, below a $5 floor.
      const orders = computeRebalanceOrders(
        targets,
        100,
        new Map(),
        new Map([["GLD", 250]]),
        universe,
        true,
        5,
      );

      expect(orders).toEqual([]);
    });

    it("uses the default $5 notional floor when minFractionalNotionalUsd is omitted", () => {
      const targets: RotationTarget[] = [{ ticker: "GLD", weightPercent: 1 }];

      // 1% of $100 = $1, below the default $5 floor.
      const belowFloor = computeRebalanceOrders(
        targets,
        100,
        new Map(),
        new Map([["GLD", 250]]),
        universe,
        true, // minFractionalNotionalUsd omitted -> defaults to 5
      );
      expect(belowFloor).toEqual([]);

      // 10% of $100 = $10, clears the default $5 floor; GLD still floors to 0 shares.
      const clearsFloor = computeRebalanceOrders(
        [{ ticker: "GLD", weightPercent: 10 }],
        100,
        new Map(),
        new Map([["GLD", 398]]),
        universe,
        true,
      );
      expect(clearsFloor).toEqual([
        {
          ticker: "GLD",
          action: "BUY",
          shares: 0,
          notional: 10,
          targetWeightPercent: 10,
        },
      ]);
    });

    it("still produces a normal whole-share BUY when sizing already yields >= 1 share, even with fractional mode on", () => {
      const targets: RotationTarget[] = [{ ticker: "QQQ", weightPercent: 50 }];

      const orders = computeRebalanceOrders(
        targets,
        10000,
        new Map(),
        new Map([["QQQ", 400]]),
        universe,
        true,
        5,
      );

      expect(orders).toEqual([
        { ticker: "QQQ", action: "BUY", shares: 12, targetWeightPercent: 50 },
      ]);
    });
  });
});

// Applies a RebalanceOrder[] to a starting holdings map and returns the
// resulting holdings - lets the invariant tests below compare FINAL STATE
// between computeRebalanceOrders and computeDeltaRebalanceOrders, not the
// (deliberately different) order lists that produce it.
function applyOrders(
  startingShares: Map<string, number>,
  orders: RebalanceOrder[],
): Map<string, number> {
  const holdings = new Map(startingShares);
  for (const order of orders) {
    const current = holdings.get(order.ticker) ?? 0;
    if (order.action === "BUY") {
      holdings.set(order.ticker, current + order.shares);
    } else {
      const remaining = current - order.shares;
      if (remaining <= 0) holdings.delete(order.ticker);
      else holdings.set(order.ticker, remaining);
    }
  }
  return holdings;
}

describe("computeDeltaRebalanceOrders - strict algebraic invariant vs computeRebalanceOrders at threshold=0 (hard merge gate)", () => {
  const universe = ["SPY", "QQQ", "EFA", "TLT", "GLD"];

  it("matches for a fresh-cash rebalance (no prior holdings)", () => {
    const targets: RotationTarget[] = [
      { ticker: "SPY", weightPercent: 50 },
      { ticker: "QQQ", weightPercent: 50 },
    ];
    const currentShares = new Map<string, number>();
    const prices = new Map([["SPY", 500], ["QQQ", 400]]);

    const fullLiquidateFinal = applyOrders(
      currentShares,
      computeRebalanceOrders(targets, 10000, currentShares, prices, universe),
    );
    const deltaOnlyFinal = applyOrders(
      currentShares,
      computeDeltaRebalanceOrders(targets, 10000, currentShares, prices, universe, 0),
    );

    expect(deltaOnlyFinal).toEqual(fullLiquidateFinal);
    expect(deltaOnlyFinal).toEqual(new Map([["SPY", 10], ["QQQ", 12]]));
  });

  it("matches for a continuing pick currently overweight vs. target", () => {
    const targets: RotationTarget[] = [{ ticker: "SPY", weightPercent: 20 }];
    const currentShares = new Map([["SPY", 30]]); // 30% of equity, target is 20%
    const prices = new Map([["SPY", 100]]);

    const fullLiquidateFinal = applyOrders(
      currentShares,
      computeRebalanceOrders(targets, 10000, currentShares, prices, universe),
    );
    const deltaOnlyFinal = applyOrders(
      currentShares,
      computeDeltaRebalanceOrders(targets, 10000, currentShares, prices, universe, 0),
    );

    expect(deltaOnlyFinal).toEqual(fullLiquidateFinal);
    expect(deltaOnlyFinal).toEqual(new Map([["SPY", 20]]));
  });

  it("matches for a continuing pick currently underweight vs. target", () => {
    const targets: RotationTarget[] = [{ ticker: "SPY", weightPercent: 20 }];
    const currentShares = new Map([["SPY", 10]]); // 10% of equity, target is 20%
    const prices = new Map([["SPY", 100]]);

    const fullLiquidateFinal = applyOrders(
      currentShares,
      computeRebalanceOrders(targets, 10000, currentShares, prices, universe),
    );
    const deltaOnlyFinal = applyOrders(
      currentShares,
      computeDeltaRebalanceOrders(targets, 10000, currentShares, prices, universe, 0),
    );

    expect(deltaOnlyFinal).toEqual(fullLiquidateFinal);
    expect(deltaOnlyFinal).toEqual(new Map([["SPY", 20]]));
  });

  it("matches for a continuing pick already exactly at target (full-liquidate round-trips, delta-only trades nothing)", () => {
    const targets: RotationTarget[] = [{ ticker: "SPY", weightPercent: 20 }];
    const currentShares = new Map([["SPY", 20]]); // already exactly at the 20-share target
    const prices = new Map([["SPY", 100]]);

    const deltaOrders = computeDeltaRebalanceOrders(targets, 10000, currentShares, prices, universe, 0);
    expect(deltaOrders).toEqual([]); // no-op, not a same-quantity round trip

    const fullLiquidateFinal = applyOrders(
      currentShares,
      computeRebalanceOrders(targets, 10000, currentShares, prices, universe),
    );
    const deltaOnlyFinal = applyOrders(currentShares, deltaOrders);

    expect(deltaOnlyFinal).toEqual(fullLiquidateFinal);
    expect(deltaOnlyFinal).toEqual(new Map([["SPY", 20]]));
  });

  it("matches for a new pick (not currently held) alongside an unrelated already-at-target position", () => {
    const targets: RotationTarget[] = [
      { ticker: "SPY", weightPercent: 50 },
      { ticker: "QQQ", weightPercent: 50 },
    ];
    const currentShares = new Map([["SPY", 50]]); // already exactly at its own 50-share target
    const prices = new Map([["SPY", 100], ["QQQ", 200]]);

    const fullLiquidateFinal = applyOrders(
      currentShares,
      computeRebalanceOrders(targets, 10000, currentShares, prices, universe),
    );
    const deltaOnlyFinal = applyOrders(
      currentShares,
      computeDeltaRebalanceOrders(targets, 10000, currentShares, prices, universe, 0),
    );

    expect(deltaOnlyFinal).toEqual(fullLiquidateFinal);
    expect(deltaOnlyFinal).toEqual(new Map([["SPY", 50], ["QQQ", 25]]));
  });

  it("matches for a dropped pick (held, no longer a target - full exit either way)", () => {
    const targets: RotationTarget[] = [];
    const currentShares = new Map([["GLD", 15]]);
    const prices = new Map([["GLD", 150]]);

    const fullLiquidateFinal = applyOrders(
      currentShares,
      computeRebalanceOrders(targets, 10000, currentShares, prices, universe),
    );
    const deltaOnlyFinal = applyOrders(
      currentShares,
      computeDeltaRebalanceOrders(targets, 10000, currentShares, prices, universe, 0),
    );

    expect(deltaOnlyFinal).toEqual(fullLiquidateFinal);
    expect(deltaOnlyFinal.has("GLD")).toBe(false);
  });

  it("matches for a mixed scenario combining exit/overweight/underweight/at-target/new-pick across 5 tickers in one call", () => {
    const targets: RotationTarget[] = [
      { ticker: "SPY", weightPercent: 30 }, // continuing, will be overweight (80 held vs 60 target)
      { ticker: "QQQ", weightPercent: 20 }, // continuing, will be underweight (10 held vs 20 target)
      { ticker: "EFA", weightPercent: 10 }, // continuing, exactly at target (40 held == 40 target)
      { ticker: "TLT", weightPercent: 15 }, // new pick, not currently held
      // GLD not a target this rebalance - currently held, must exit
    ];
    const currentShares = new Map([
      ["SPY", 80],
      ["QQQ", 10],
      ["EFA", 40],
      ["GLD", 25],
    ]);
    const prices = new Map([
      ["SPY", 100],
      ["QQQ", 200],
      ["EFA", 50],
      ["TLT", 80],
      ["GLD", 150],
    ]);

    const fullLiquidateFinal = applyOrders(
      currentShares,
      computeRebalanceOrders(targets, 20000, currentShares, prices, universe),
    );
    const deltaOnlyFinal = applyOrders(
      currentShares,
      computeDeltaRebalanceOrders(targets, 20000, currentShares, prices, universe, 0),
    );

    expect(deltaOnlyFinal).toEqual(fullLiquidateFinal);
    expect(deltaOnlyFinal).toEqual(
      new Map([
        ["SPY", 60],
        ["QQQ", 20],
        ["EFA", 40],
        ["TLT", 37],
      ]),
    );
    expect(deltaOnlyFinal.has("GLD")).toBe(false);
  });
});

describe("computeDeltaRebalanceOrders - tolerance-band threshold behavior", () => {
  const universe = ["SPY"];

  it("skips a trade entirely when the deviation from target is within the threshold", () => {
    // 22% actual vs 20% target = 2pp deviation - within a 5% band, skip.
    const targets: RotationTarget[] = [{ ticker: "SPY", weightPercent: 20 }];
    const currentShares = new Map([["SPY", 22]]); // 22 * 100 / 10000 * 100 = 22%
    const prices = new Map([["SPY", 100]]);

    const orders = computeDeltaRebalanceOrders(targets, 10000, currentShares, prices, universe, 5);

    expect(orders).toEqual([]);
  });

  it("still trades once the deviation reaches/exceeds the threshold", () => {
    // 26% actual vs 20% target = 6pp deviation - at/above a 5% band, trade.
    const targets: RotationTarget[] = [{ ticker: "SPY", weightPercent: 20 }];
    const currentShares = new Map([["SPY", 26]]); // 26 * 100 / 10000 * 100 = 26%
    const prices = new Map([["SPY", 100]]);

    const orders = computeDeltaRebalanceOrders(targets, 10000, currentShares, prices, universe, 5);

    expect(orders).toEqual([{ ticker: "SPY", action: "SELL", shares: 6 }]); // target 20 shares, held 26
  });

  it("an exit (dropped pick) is never gated by the threshold", () => {
    const targets: RotationTarget[] = []; // GLD no longer a target at all
    const currentShares = new Map([["GLD", 1]]); // a tiny position, would be "within tolerance" for any weight-based check
    const prices = new Map([["GLD", 150]]);

    const orders = computeDeltaRebalanceOrders(
      targets,
      10000,
      currentShares,
      prices,
      ["GLD"],
      50, // a very generous threshold - still must not block the exit
    );

    expect(orders).toEqual([{ ticker: "GLD", action: "SELL", shares: 1 }]);
  });
});
