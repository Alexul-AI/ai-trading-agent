import { describe, expect, it } from "vitest";

import { calculateSMA } from "../../indicators.js";
import {
  computeBucketRegimeByDate,
  isBuySuppressedByRegime,
  type DailyBar,
  type RegimeBucketConfig,
} from "./portfolioRegimeFilter.js";

function makeBars(
  startPrice: number,
  endPrice: number,
  days: number,
  startDate = "2024-01-01",
): DailyBar[] {
  const bars: DailyBar[] = [];
  const start = new Date(startDate);

  for (let i = 0; i < days; i += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);

    const price = startPrice + ((endPrice - startPrice) * i) / (days - 1);

    bars.push({ t: date.toISOString(), c: Number(price.toFixed(2)) });
  }

  return bars;
}

function lastDateKey(bars: DailyBar[]): string {
  const last = bars[bars.length - 1];
  return (last?.t.split("T")[0] ?? "") as string;
}

const bucketOf = (
  overrides: Partial<RegimeBucketConfig> = {},
): RegimeBucketConfig => ({
  bucketId: "test_bucket",
  label: "Test Bucket",
  tickers: ["AAA"],
  smaWindowDays: 20,
  ...overrides,
});

describe("calculateSMA", () => {
  it("averages the last N prices", () => {
    expect(calculateSMA([1, 2, 3, 4, 5], 5)).toBe(3);
  });

  it("returns 0 when there isn't enough history", () => {
    expect(calculateSMA([1, 2], 5)).toBe(0);
  });
});

describe("computeBucketRegimeByDate", () => {
  it("marks RISK_ON when price is trending up and above its SMA", () => {
    const bars = makeBars(100, 160, 60);
    const barsByTicker = new Map([["AAA", bars]]);
    const bucket = bucketOf({ tickers: ["AAA"] });

    const regime = computeBucketRegimeByDate(barsByTicker, bucket);

    expect(regime.get(lastDateKey(bars))).toBe("RISK_ON");
  });

  it("marks RISK_OFF when price is trending down and below its SMA", () => {
    const bars = makeBars(160, 100, 60);
    const barsByTicker = new Map([["AAA", bars]]);
    const bucket = bucketOf({ tickers: ["AAA"] });

    const regime = computeBucketRegimeByDate(barsByTicker, bucket);

    expect(regime.get(lastDateKey(bars))).toBe("RISK_OFF");
  });

  it("averages deviation across multiple tickers in a composite bucket", () => {
    // AAA alone is a clean uptrend -> RISK_ON on its own. Adding BBB, which
    // is crashing hard, should be able to drag the composite to RISK_OFF -
    // proving the result actually depends on both tickers, not just the
    // first one in the list.
    const barsUp = makeBars(100, 120, 60);
    const barsCrash = makeBars(100, 40, 60);
    const dateKey = lastDateKey(barsUp);

    const aaaAloneRegime = computeBucketRegimeByDate(
      new Map([["AAA", barsUp]]),
      bucketOf({ tickers: ["AAA"] }),
    );
    expect(aaaAloneRegime.get(dateKey)).toBe("RISK_ON");

    const compositeRegime = computeBucketRegimeByDate(
      new Map([
        ["AAA", barsUp],
        ["BBB", barsCrash],
      ]),
      bucketOf({ tickers: ["AAA", "BBB"] }),
    );

    expect(compositeRegime.get(dateKey)).toBe("RISK_OFF");
  });

  it("aligns dates by intersection when a ticker has gaps", () => {
    const barsA = makeBars(100, 160, 60);
    // BBB is missing the last 5 days entirely (e.g. late listing / gap).
    const barsB = makeBars(100, 160, 60).slice(0, 55);
    const barsByTicker = new Map([
      ["AAA", barsA],
      ["BBB", barsB],
    ]);
    const bucket = bucketOf({ tickers: ["AAA", "BBB"] });

    const regime = computeBucketRegimeByDate(barsByTicker, bucket);

    // Should still produce a regime for the last date using AAA alone,
    // not throw or silently drop the date.
    expect(regime.get(lastDateKey(barsA))).toBe("RISK_ON");
  });

  it("produces no entry for dates without enough warmed-up history", () => {
    const bars = makeBars(100, 110, 10); // fewer bars than smaWindowDays
    const barsByTicker = new Map([["AAA", bars]]);
    const bucket = bucketOf({ tickers: ["AAA"], smaWindowDays: 20 });

    const regime = computeBucketRegimeByDate(barsByTicker, bucket);

    expect(regime.size).toBe(0);
  });
});

describe("isBuySuppressedByRegime", () => {
  const buckets = [bucketOf({ bucketId: "b1", label: "Bucket One" })];
  const tickerToBucket = { AAA: "b1" };

  it("suppresses BUY when the bucket is RISK_OFF", () => {
    const regimeByBucketByDate = new Map([
      ["b1", new Map([["2024-06-01", "RISK_OFF" as const]])],
    ]);

    const result = isBuySuppressedByRegime(
      regimeByBucketByDate,
      "AAA",
      "2024-06-01",
      tickerToBucket,
      buckets,
    );

    expect(result.suppressed).toBe(true);
  });

  it("does not suppress BUY when the bucket is RISK_ON", () => {
    const regimeByBucketByDate = new Map([
      ["b1", new Map([["2024-06-01", "RISK_ON" as const]])],
    ]);

    const result = isBuySuppressedByRegime(
      regimeByBucketByDate,
      "AAA",
      "2024-06-01",
      tickerToBucket,
      buckets,
    );

    expect(result.suppressed).toBe(false);
  });

  it("fails open (does not suppress) when there is no regime data for the date", () => {
    const regimeByBucketByDate = new Map([["b1", new Map()]]);

    const result = isBuySuppressedByRegime(
      regimeByBucketByDate,
      "AAA",
      "2024-06-01",
      tickerToBucket,
      buckets,
    );

    expect(result.suppressed).toBe(false);
    expect(result.reason).toContain("failing open");
  });

  it("never suppresses an exempt bucket, even when RISK_OFF", () => {
    const exemptBuckets = [
      bucketOf({ bucketId: "b1", label: "Bucket One", exempt: true }),
    ];
    const regimeByBucketByDate = new Map([
      ["b1", new Map([["2024-06-01", "RISK_OFF" as const]])],
    ]);

    const result = isBuySuppressedByRegime(
      regimeByBucketByDate,
      "AAA",
      "2024-06-01",
      tickerToBucket,
      exemptBuckets,
    );

    expect(result.suppressed).toBe(false);
    expect(result.reason).toContain("exempt");
  });

  it("does not apply to a ticker with no bucket mapping", () => {
    const regimeByBucketByDate = new Map([
      ["b1", new Map([["2024-06-01", "RISK_OFF" as const]])],
    ]);

    const result = isBuySuppressedByRegime(
      regimeByBucketByDate,
      "ZZZ",
      "2024-06-01",
      tickerToBucket,
      buckets,
    );

    expect(result.suppressed).toBe(false);
  });
});

describe("module surface", () => {
  it("has no exported concept of SELL/STOP_LOSS/TAKE_PROFIT - structurally cannot gate an exit", async () => {
    const module = await import("./portfolioRegimeFilter.js");
    const exportedNames = Object.keys(module);

    for (const name of exportedNames) {
      expect(name.toLowerCase()).not.toContain("sell");
      expect(name.toLowerCase()).not.toContain("stoploss");
      expect(name.toLowerCase()).not.toContain("takeprofit");
    }
  });
});
