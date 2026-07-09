import { describe, expect, it } from "vitest";

import { buildMarketChartPoints } from "./chartPoints.js";
import type { AlpacaBar } from "../types/serverTypes.js";

function makeBars(count: number): AlpacaBar[] {
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(2026, 0, 1 + i);
    const price = 100 + i;

    return {
      t: `${date.toISOString().split("T")[0]}T00:00:00Z`,
      o: price,
      h: price + 1,
      l: price - 1,
      c: price,
      v: 1000,
    };
  });
}

describe("buildMarketChartPoints", () => {
  it("returns one point per bar when no outputCount is given", () => {
    const points = buildMarketChartPoints(makeBars(50));

    expect(points).toHaveLength(50);
  });

  it("trims to only the last outputCount points when given", () => {
    const points = buildMarketChartPoints(makeBars(200), 30);

    expect(points).toHaveLength(30);
    // The last returned point must be the actual last bar (200th day),
    // not the 30th - trimming must happen after computing, not before.
    expect(points.at(-1)?.close).toBe(299);
  });

  it("computes indicators using the full bar history, not just the trimmed window", () => {
    // With 200 bars of warm-up + trimming to the last 10, every returned
    // point has 190+ bars of history behind it and should have non-null
    // indicators (RSI needs 15, MACD needs 35, Bollinger needs 20).
    const points = buildMarketChartPoints(makeBars(200), 10);

    expect(points).toHaveLength(10);
    expect(points.every((p) => p.rsi !== null)).toBe(true);
    expect(points.every((p) => p.macdHistogram !== null)).toBe(true);
    expect(points.every((p) => p.bollingerLower !== null)).toBe(true);
  });

  it("returns nulls for indicators before enough bars have accumulated", () => {
    const points = buildMarketChartPoints(makeBars(10));

    // With only 10 bars total, none of RSI(15)/MACD(35)/Bollinger(20)
    // thresholds are met yet.
    expect(points.every((p) => p.rsi === null)).toBe(true);
    expect(points.every((p) => p.macdHistogram === null)).toBe(true);
  });
});
