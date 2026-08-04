import { describe, expect, it } from "vitest";

import {
  calculateATR,
  calculateBollingerBands,
  calculateEMA,
  calculateMACD,
  calculateRSI,
  calculateSMA,
  type AtrBar,
} from "./indicators.js";

// This file existed with zero direct test coverage until now - every other
// test that touches RSI/MACD/etc (strategyEngine.test.ts) feeds the
// decision logic pre-computed indicator *values* by hand, never exercises
// this module's own math. Given this project's own history of a real,
// subtle "warm-up bug" in this exact recursive-smoothing style of
// calculation (see CLAUDE.md), the math contract itself is worth locking
// in directly, not just the decisions built on top of it.

describe("calculateRSI", () => {
  it("is exactly 100 on a strictly increasing series (avgLoss stays 0 throughout)", () => {
    const prices = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(calculateRSI(prices)).toBe(100);
  });

  it("is exactly 0 on a strictly decreasing series (avgGain stays 0 throughout)", () => {
    const prices = Array.from({ length: 30 }, (_, i) => 130 - i);
    expect(calculateRSI(prices)).toBe(0);
  });

  it("is 100 on a flat (no-movement) series - a real, if slightly surprising, contract worth locking in", () => {
    // Every diff is 0, so both avgGain and avgLoss stay 0 - the code's
    // `if (avgLoss === 0) return 100` branch fires the same as it would
    // for a genuine all-gains series. Not "50 (neutral)", which might be
    // the more intuitive guess - this is what the function actually does.
    const prices = Array.from({ length: 30 }, () => 100);
    expect(calculateRSI(prices)).toBe(100);
  });

  it("returns the insufficient-data default (50) at prices.length <= periods, regardless of trend", () => {
    // The guard is `<=`, not `<` - exactly `periods` prices still hits it,
    // even though the series is a clean, unambiguous uptrend that would
    // otherwise compute to 100. periods+1 is the real minimum.
    const periods = 14;
    const trendingUp = Array.from({ length: periods }, (_, i) => 100 + i);
    expect(calculateRSI(trendingUp, periods)).toBe(50);
    expect(calculateRSI([...trendingUp, 200], periods)).not.toBe(50);
  });

  it("carries the Wilder-smoothed avgGain/avgLoss forward from history - identical recent bars produce a different RSI depending on what preceded them", () => {
    // This is the actual mechanism behind the project's documented
    // warm-up bug: the recursive average is seeded from the start of
    // whatever series it's given, so a short series computes RSI fresh
    // from its own first bar, while a longer series carries forward
    // smoothing history from everything before the shared tail. This
    // does NOT test whether the live pipeline supplies enough warm-up
    // bars in practice - that contract is already covered where it's
    // actually enforced (src/market/chartPoints.test.ts's "computes
    // using the full bar history, not just the trimmed window").
    function mixedTail(len: number, start: number): number[] {
      const out: number[] = [];
      let price = start;
      for (let i = 0; i < len; i += 1) {
        price += i % 3 === 0 ? -2 : 1;
        out.push(price);
      }
      return out;
    }

    const bareTail = mixedTail(15, 100);
    const bareRsi = calculateRSI(bareTail);

    const risingPrefix = Array.from({ length: 200 }, (_, i) => 50 + i * 0.5);
    const tailAfterRising = mixedTail(15, risingPrefix[risingPrefix.length - 1]!);
    const rsiAfterRisingPrefix = calculateRSI([...risingPrefix, ...tailAfterRising]);

    const fallingPrefix = Array.from({ length: 200 }, (_, i) => 250 - i * 0.5);
    const tailAfterFalling = mixedTail(15, fallingPrefix[fallingPrefix.length - 1]!);
    const rsiAfterFallingPrefix = calculateRSI([...fallingPrefix, ...tailAfterFalling]);

    expect(bareRsi).toBeCloseTo(55.56, 1);
    // A long rising prefix pulls the same tail's RSI up; a long falling
    // prefix pulls it down - neither matches the bare-minimum computation.
    expect(rsiAfterRisingPrefix).toBeGreaterThan(bareRsi);
    expect(rsiAfterFallingPrefix).toBeLessThan(bareRsi);
    expect(rsiAfterRisingPrefix).not.toBeCloseTo(rsiAfterFallingPrefix, 0);
  });
});

describe("calculateATR", () => {
  function makeFlatBars(count: number): AtrBar[] {
    // Constant H/L/C every bar - true range is the same fixed value
    // (max(h-l, |h-prevClose|, |l-prevClose|) = max(2,1,1) = 2) on every
    // bar after the first, so both the seed average and every Wilder-
    // smoothed step land on exactly 2, regardless of how many bars.
    return Array.from({ length: count }, () => ({ h: 101, l: 99, c: 100 }));
  }

  it("computes the exact expected ATR on a simple, hand-verifiable true-range series", () => {
    expect(calculateATR(makeFlatBars(20))).toBeCloseTo(2, 4);
    expect(calculateATR(makeFlatBars(50))).toBeCloseTo(2, 4);
  });

  it("returns the insufficient-data default (0) until there are enough bars for a full true-range window", () => {
    const periods = 14;
    // bars.length <= periods hits the first guard directly.
    expect(calculateATR(makeFlatBars(periods))).toBe(0);
    // trueRanges.length is bars.length-1, so periods+1 bars still only
    // yields `periods` true ranges - the second guard (trueRanges.length
    // <= periods) still fires. periods+2 is the real minimum.
    expect(calculateATR(makeFlatBars(periods + 1))).toBe(0);
    expect(calculateATR(makeFlatBars(periods + 2))).not.toBe(0);
  });
});

describe("calculateEMA", () => {
  it("seeds from the raw first price, then applies the standard smoothing constant", () => {
    // period=2 -> k=2/3. ema[0]=10 (raw seed). ema[1]=20*(2/3)+10*(1/3).
    const result = calculateEMA([10, 20], 2);
    expect(result[0]).toBe(10);
    expect(result[1]).toBeCloseTo(16.6667, 4);
  });

  it("returns an empty array for an empty input, never throws", () => {
    expect(calculateEMA([], 12)).toEqual([]);
  });
});

describe("calculateSMA", () => {
  it("computes the exact arithmetic mean of the trailing window", () => {
    expect(calculateSMA([1, 2, 3, 4, 5], 5)).toBe(3);
    expect(calculateSMA([10, 20, 30], 2)).toBe(25);
  });

  it("returns the insufficient-data default (0) when there are fewer prices than the period", () => {
    expect(calculateSMA([1, 2], 5)).toBe(0);
  });

  it("guards on strictly-less-than, not less-than-or-equal (unlike calculateRSI's <=)", () => {
    // Exactly `period` prices is enough - a real, testable asymmetry
    // against calculateRSI's boundary above, worth pinning down so a
    // future edit doesn't accidentally "align" the two guards.
    expect(calculateSMA([1, 2, 3], 3)).toBe(2);
  });
});

describe("calculateBollingerBands", () => {
  it("collapses to a single flat band (upper = lower = sma = the value) when every price is identical", () => {
    const flat = Array.from({ length: 5 }, () => 50);
    expect(calculateBollingerBands(flat, 5, 2)).toEqual({
      sma: 50,
      upper: 50,
      lower: 50,
    });
  });

  it("computes the exact expected sma/upper/lower on a simple, hand-verifiable series", () => {
    // sma=20; variance=((10-20)^2+(20-20)^2+(30-20)^2)/3=66.6667;
    // stdDev=8.1650; upper=20+2*8.1650=36.33; lower=20-2*8.1650=3.67.
    expect(calculateBollingerBands([10, 20, 30], 3, 2)).toEqual({
      sma: 20,
      upper: 36.33,
      lower: 3.67,
    });
  });

  it("returns the insufficient-data default ({0,0,0}) when there are fewer prices than the period", () => {
    expect(calculateBollingerBands([10, 20], 5)).toEqual({
      upper: 0,
      lower: 0,
      sma: 0,
    });
  });
});

describe("calculateMACD", () => {
  it("returns the insufficient-data default ({0,0,0}) below the 26-price minimum", () => {
    const prices = Array.from({ length: 25 }, (_, i) => 100 + i);
    expect(calculateMACD(prices)).toEqual({ macd: 0, signal: 0, histogram: 0 });
  });

  it("is positive (fast EMA above slow EMA) on a sustained, clean uptrend, within a tolerance rather than an exact float match", () => {
    const prices = Array.from({ length: 40 }, (_, i) => 100 + i * 0.5);
    const result = calculateMACD(prices);

    expect(result.macd).toBeCloseTo(3.19, 1);
    expect(result.signal).toBeCloseTo(3.07, 1);
    expect(result.histogram).toBeCloseTo(0.12, 1);
    expect(result.macd).toBeGreaterThan(0);
  });
});
