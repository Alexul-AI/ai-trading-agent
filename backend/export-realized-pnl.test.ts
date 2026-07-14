import { describe, expect, it } from "vitest";

import { computeFifoRealizedPnl, type Fill } from "./export-realized-pnl.js";

function fill(overrides: Partial<Fill>): Fill {
  return {
    timestamp: "2026-01-01T00:00:00Z",
    ticker: "SPY",
    action: "BUY",
    shares: 1,
    price: 100,
    ...overrides,
  };
}

describe("computeFifoRealizedPnl", () => {
  it("matches a single buy lot fully consumed by one sell", () => {
    const fills: Fill[] = [
      fill({ timestamp: "2026-01-01T00:00:00Z", action: "BUY", shares: 10, price: 100 }),
      fill({ timestamp: "2026-01-05T00:00:00Z", action: "SELL", shares: 10, price: 120 }),
    ];

    const { rows, warnings, openLotsByTicker } = computeFifoRealizedPnl(fills);

    expect(warnings).toEqual([]);
    expect(rows).toHaveLength(2);
    const sellRow = rows[1]!;
    expect(sellRow.action).toBe("SELL");
    expect(sellRow.shares).toBe(10);
    expect(sellRow.realizedPnlUsd).toBeCloseTo(200, 5);
    expect(sellRow.matchedBuyPriceUsd).toBe(100);
    expect(openLotsByTicker.get("SPY")).toEqual([]);
  });

  it("partially consumes a buy lot, leaving the remainder open", () => {
    const fills: Fill[] = [
      fill({ timestamp: "2026-01-01T00:00:00Z", action: "BUY", shares: 10, price: 100 }),
      fill({ timestamp: "2026-01-05T00:00:00Z", action: "SELL", shares: 4, price: 120 }),
    ];

    const { rows, warnings, openLotsByTicker } = computeFifoRealizedPnl(fills);

    expect(warnings).toEqual([]);
    const sellRow = rows[1]!;
    expect(sellRow.shares).toBe(4);
    expect(sellRow.realizedPnlUsd).toBeCloseTo(80, 5);
    expect(openLotsByTicker.get("SPY")).toEqual([{ date: "2026-01-01", shares: 6, price: 100 }]);
  });

  it("matches a sell spanning two buy lots at different prices, FIFO order", () => {
    const fills: Fill[] = [
      fill({ timestamp: "2026-01-01T00:00:00Z", action: "BUY", shares: 5, price: 100 }),
      fill({ timestamp: "2026-01-02T00:00:00Z", action: "BUY", shares: 5, price: 110 }),
      fill({ timestamp: "2026-01-10T00:00:00Z", action: "SELL", shares: 8, price: 130 }),
    ];

    const { rows, warnings, openLotsByTicker } = computeFifoRealizedPnl(fills);

    expect(warnings).toEqual([]);
    const sellRows = rows.filter((r) => r.action === "SELL");
    expect(sellRows).toHaveLength(2);

    expect(sellRows[0]!.shares).toBe(5);
    expect(sellRows[0]!.matchedBuyPriceUsd).toBe(100);
    expect(sellRows[0]!.realizedPnlUsd).toBeCloseTo(150, 5);

    expect(sellRows[1]!.shares).toBe(3);
    expect(sellRows[1]!.matchedBuyPriceUsd).toBe(110);
    expect(sellRows[1]!.realizedPnlUsd).toBeCloseTo(60, 5);

    expect(openLotsByTicker.get("SPY")).toEqual([{ date: "2026-01-02", shares: 2, price: 110 }]);
  });

  it("flags a sell that exceeds tracked open lots without crashing", () => {
    const fills: Fill[] = [fill({ timestamp: "2026-01-10T00:00:00Z", action: "SELL", shares: 10, price: 130 })];

    const { rows, warnings } = computeFifoRealizedPnl(fills);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.realizedPnlUsd).toBeNull();
    expect(rows[0]!.shares).toBe(10);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("no tracked open lots");
  });

  it("flags only the excess portion when a sell partially exceeds tracked lots", () => {
    const fills: Fill[] = [
      fill({ timestamp: "2026-01-01T00:00:00Z", action: "BUY", shares: 3, price: 100 }),
      fill({ timestamp: "2026-01-10T00:00:00Z", action: "SELL", shares: 10, price: 130 }),
    ];

    const { rows, warnings } = computeFifoRealizedPnl(fills);

    const sellRows = rows.filter((r) => r.action === "SELL");
    expect(sellRows).toHaveLength(2);
    expect(sellRows[0]!.shares).toBe(3);
    expect(sellRows[0]!.realizedPnlUsd).toBeCloseTo(90, 5);
    expect(sellRows[1]!.shares).toBe(7);
    expect(sellRows[1]!.realizedPnlUsd).toBeNull();
    expect(warnings.some((w) => w.includes("exceeded tracked open lots"))).toBe(true);
  });

  it("sorts fills by timestamp regardless of input order", () => {
    const fills: Fill[] = [
      fill({ timestamp: "2026-01-05T00:00:00Z", action: "SELL", shares: 10, price: 120 }),
      fill({ timestamp: "2026-01-01T00:00:00Z", action: "BUY", shares: 10, price: 100 }),
    ];

    const { warnings, rows } = computeFifoRealizedPnl(fills);

    expect(warnings).toEqual([]);
    expect(rows[0]!.action).toBe("BUY");
    expect(rows[1]!.action).toBe("SELL");
    expect(rows[1]!.realizedPnlUsd).toBeCloseTo(200, 5);
  });
});
