import { describe, expect, it } from "vitest";

import { evaluateTrade, type AccountState, type OrderRequest } from "./riskManager.js";

function baseAccount(overrides: Partial<AccountState> = {}): AccountState {
  return {
    equity: 10000,
    cash: 10000,
    dailyDrawdownPercent: 0,
    currentPositions: [],
    ...overrides,
  };
}

function baseOrder(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    ticker: "AAPL",
    action: "BUY",
    requestedShares: 10,
    estimatedPrice: 100,
    ...overrides,
  };
}

describe("evaluateTrade - kill switch", () => {
  it("blocks a BUY when daily drawdown exceeds the limit", () => {
    const result = evaluateTrade(
      baseOrder({ action: "BUY" }),
      baseAccount({ dailyDrawdownPercent: -0.06 }), // past -5% default limit
    );

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("FATAL RISK");
  });

  it("still allows a SELL when daily drawdown exceeds the limit", () => {
    const result = evaluateTrade(
      baseOrder({ action: "SELL", requestedShares: 5 }),
      baseAccount({
        dailyDrawdownPercent: -0.06,
        currentPositions: [{ ticker: "AAPL", shares: 5, marketValue: 500 }],
      }),
    );

    expect(result.approved).toBe(true);
    expect(result.adjustedShares).toBe(5);
  });

  it("allows a BUY when drawdown is within the limit", () => {
    const result = evaluateTrade(
      baseOrder({ action: "BUY" }),
      baseAccount({ dailyDrawdownPercent: -0.03 }),
    );

    expect(result.approved).toBe(true);
  });
});

describe("evaluateTrade - SELL", () => {
  it("rejects selling a ticker with no owned shares", () => {
    const result = evaluateTrade(baseOrder({ action: "SELL" }), baseAccount());

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("No shares currently owned");
  });

  it("caps the sell at owned shares even if more is requested", () => {
    const result = evaluateTrade(
      baseOrder({ action: "SELL", requestedShares: 100 }),
      baseAccount({
        currentPositions: [{ ticker: "AAPL", shares: 10, marketValue: 1000 }],
      }),
    );

    expect(result.approved).toBe(true);
    expect(result.adjustedShares).toBe(10);
  });
});

describe("evaluateTrade - BUY position sizing", () => {
  it("rejects a BUY when the position is already at the 20% cap", () => {
    const result = evaluateTrade(
      baseOrder({ action: "BUY" }),
      baseAccount({
        equity: 10000,
        currentPositions: [{ ticker: "AAPL", shares: 20, marketValue: 2000 }], // exactly 20%
      }),
    );

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Maximum portfolio allocation");
  });

  it("reduces the order to fit within the remaining position cap", () => {
    const result = evaluateTrade(
      baseOrder({ action: "BUY", requestedShares: 50, estimatedPrice: 100 }),
      baseAccount({
        equity: 10000, // cap = 2000
        cash: 10000,
        currentPositions: [{ ticker: "AAPL", shares: 10, marketValue: 1000 }], // 1000 used, 1000 left
      }),
    );

    expect(result.approved).toBe(true);
    expect(result.adjustedShares).toBe(10); // 1000 remaining / 100 price
    expect(result.reason).toContain("MODIFIED");
  });

  it("never spends more cash than is available, even with room under the position cap", () => {
    const result = evaluateTrade(
      baseOrder({ action: "BUY", requestedShares: 50, estimatedPrice: 100 }),
      baseAccount({ equity: 10000, cash: 300 }), // plenty of position-cap room, but little cash
    );

    expect(result.approved).toBe(true);
    expect(result.adjustedShares).toBe(3); // floor(300 / 100)
  });

  it("rejects when there isn't enough cash to buy even one share", () => {
    const result = evaluateTrade(
      baseOrder({ action: "BUY", estimatedPrice: 100 }),
      baseAccount({ equity: 10000, cash: 50 }),
    );

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Insufficient safe capital");
  });

  it("approves the full requested amount when it fits comfortably", () => {
    const result = evaluateTrade(
      baseOrder({ action: "BUY", requestedShares: 5, estimatedPrice: 100 }),
      baseAccount({ equity: 10000, cash: 10000 }),
    );

    expect(result.approved).toBe(true);
    expect(result.adjustedShares).toBe(5);
    expect(result.reason).toContain("APPROVED");
  });

  it("never uses margin even when allowMargin would permit exceeding cash", () => {
    const result = evaluateTrade(
      baseOrder({ action: "BUY", requestedShares: 50, estimatedPrice: 100 }),
      baseAccount({ equity: 10000, cash: 300 }),
      { maxDailyDrawdownPercent: -0.05, maxPositionSizePercent: 0.2, allowMargin: false },
    );

    expect(result.adjustedShares).toBe(3);
  });
});

describe("evaluateTrade - BUY notional (fractional-fallback) sizing", () => {
  it("approves the full requested notional when it fits comfortably", () => {
    const result = evaluateTrade(
      baseOrder({ action: "BUY", requestedShares: 0, requestedNotional: 20 }),
      baseAccount({ equity: 10000, cash: 10000 }),
    );

    expect(result.approved).toBe(true);
    expect(result.adjustedShares).toBe(0);
    expect(result.adjustedNotional).toBe(20);
    expect(result.reason).toContain("APPROVED");
  });

  it("reduces the notional to fit within available cash", () => {
    const result = evaluateTrade(
      baseOrder({ action: "BUY", requestedShares: 0, requestedNotional: 50 }),
      baseAccount({ equity: 10000, cash: 15 }),
    );

    expect(result.approved).toBe(true);
    expect(result.adjustedNotional).toBe(15);
    expect(result.reason).toContain("MODIFIED");
  });

  it("reduces the notional to fit within the remaining position cap", () => {
    const result = evaluateTrade(
      baseOrder({ action: "BUY", requestedShares: 0, requestedNotional: 50 }),
      baseAccount({
        equity: 10000, // cap = 2000
        cash: 10000,
        currentPositions: [{ ticker: "AAPL", shares: 1, marketValue: 1990 }], // 10 left
      }),
    );

    expect(result.approved).toBe(true);
    expect(result.adjustedNotional).toBe(10);
  });

  it("rejects a notional BUY when there's no cash room", () => {
    const result = evaluateTrade(
      baseOrder({ action: "BUY", requestedShares: 0, requestedNotional: 20 }),
      baseAccount({ equity: 10000, cash: 0 }),
    );

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Insufficient safe capital");
  });

  it("still blocks a notional BUY when daily drawdown exceeds the limit", () => {
    const result = evaluateTrade(
      baseOrder({ action: "BUY", requestedShares: 0, requestedNotional: 20 }),
      baseAccount({ dailyDrawdownPercent: -0.06 }),
    );

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("FATAL RISK");
  });
});
