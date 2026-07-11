import { describe, expect, it } from "vitest";

import { decideTradeSignal, type StrategyInput } from "./strategyEngine.js";

function baseInput(overrides: Partial<StrategyInput> = {}): StrategyInput {
  return {
    ticker: "TEST",
    price: 100,
    cash: 10000,
    portfolioValue: 10000,
    sharesOwned: 0,
    averageEntryPrice: 0,
    rsi: 50,
    macdHistogram: 0,
    previousMacdHistogram: 0,
    bollingerLower: 95,
    bollingerUpper: 105,
    barsSinceLastBuy: 999,
    ...overrides,
  };
}

describe("decideTradeSignal - BUY confluence", () => {
  it("buys when deeply oversold and near the lower Bollinger band (strong confluence)", () => {
    const decision = decideTradeSignal(
      baseInput({ rsi: 30, price: 95, bollingerLower: 95 }),
    );

    expect(decision.action).toBe("BUY");
    expect(decision.reasonType).toBe("BUY_SIGNAL");
    expect(decision.diagnostics.buyScore).toBeGreaterThanOrEqual(4);
    expect(decision.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("holds on a single weak signal (momentum only) - confluence requires 2+", () => {
    const decision = decideTradeSignal(
      baseInput({
        rsi: 45, // below momentum threshold (46) but not deep oversold (38)
        macdHistogram: 1,
        previousMacdHistogram: 0, // rising
        price: 100,
        bollingerLower: 95, // not near lower band
      }),
    );

    expect(decision.action).toBe("HOLD");
    expect(decision.diagnostics.buyScore).toBe(1);
  });

  it("sizes the buy from cash/position caps, not just confidence", () => {
    const decision = decideTradeSignal(
      baseInput({
        rsi: 30,
        price: 100,
        bollingerLower: 100,
        cash: 10000,
        portfolioValue: 10000,
      }),
    );

    // maxBuyCashFraction 0.2 * 10000 cash = 2000, capped by remaining
    // position capacity (maxPositionEquityFraction 0.2 * 10000 = 2000).
    // 2000 / price(100) = 20 shares.
    expect(decision.action).toBe("BUY");
    expect(decision.suggestedShares).toBe(20);
  });

  it("blocks BUY when the position is already at its equity cap", () => {
    const decision = decideTradeSignal(
      baseInput({
        rsi: 30,
        price: 100,
        bollingerLower: 100,
        sharesOwned: 20, // already 20*100=2000 = 20% of 10000 portfolioValue
        averageEntryPrice: 100,
      }),
    );

    expect(decision.action).toBe("HOLD");
    expect(decision.diagnostics.maxSharesToBuy).toBe(0);
    expect(decision.reason).toContain("Risk limit");
  });

  it("blocks BUY during cooldown even with a strong signal", () => {
    const decision = decideTradeSignal(
      baseInput({
        rsi: 30,
        price: 95,
        bollingerLower: 95,
        barsSinceLastBuy: 1, // cooldownBars default is 3
      }),
    );

    expect(decision.action).toBe("HOLD");
    expect(decision.reason).toContain("Cooldown");
  });
});

describe("decideTradeSignal - fractional/notional fallback", () => {
  it("stays HOLD (risk limit) with no suggestedNotional when allowFractionalShares is off (default)", () => {
    const decision = decideTradeSignal(
      baseInput({
        rsi: 30,
        price: 1000,
        bollingerLower: 1000,
        cash: 100,
        portfolioValue: 100,
      }),
    );

    expect(decision.action).toBe("HOLD");
    expect(decision.suggestedNotional).toBeUndefined();
  });

  it("falls back to a notional BUY when allowFractionalShares is on and whole-share sizing is 0 but cash clears the minimum", () => {
    const decision = decideTradeSignal(
      baseInput({
        rsi: 30,
        price: 1000,
        bollingerLower: 1000,
        cash: 100,
        portfolioValue: 100,
        config: { allowFractionalShares: true },
      }),
    );

    // cashAllowedForBuy = min(100*0.2=20, 100*0.2=20) = 20, >= $5 minimum.
    expect(decision.action).toBe("BUY");
    expect(decision.suggestedShares).toBe(0);
    expect(decision.suggestedNotional).toBe(20);
  });

  it("does not fall back when cash room is below the minimum notional floor, even with allowFractionalShares on", () => {
    const decision = decideTradeSignal(
      baseInput({
        rsi: 30,
        price: 1000,
        bollingerLower: 1000,
        cash: 10,
        portfolioValue: 10,
        config: { allowFractionalShares: true },
      }),
    );

    // cashAllowedForBuy = min(10*0.2=2, 10*0.2=2) = 2, below the $5 minimum.
    expect(decision.action).toBe("HOLD");
    expect(decision.suggestedNotional).toBeUndefined();
  });

  it("does not fall back when whole-share sizing already yields shares, even with allowFractionalShares on", () => {
    const decision = decideTradeSignal(
      baseInput({
        rsi: 30,
        price: 100,
        bollingerLower: 100,
        cash: 10000,
        portfolioValue: 10000,
        config: { allowFractionalShares: true },
      }),
    );

    expect(decision.action).toBe("BUY");
    expect(decision.suggestedShares).toBe(20);
    expect(decision.suggestedNotional).toBeUndefined();
  });
});

describe("decideTradeSignal - exits", () => {
  it("triggers STOP_LOSS at the configured loss threshold regardless of other signals", () => {
    const decision = decideTradeSignal(
      baseInput({
        sharesOwned: 10,
        averageEntryPrice: 100,
        price: 91, // -9%, past the 8% stop-loss
        rsi: 50, // neutral - no other sell signal
      }),
    );

    expect(decision.action).toBe("SELL");
    expect(decision.reasonType).toBe("STOP_LOSS");
    expect(decision.suggestedShares).toBe(10);
    expect(decision.confidence).toBe(1);
  });

  it("triggers TAKE_PROFIT at the configured gain threshold", () => {
    const decision = decideTradeSignal(
      baseInput({
        sharesOwned: 10,
        averageEntryPrice: 100,
        price: 116, // +16%, past the 15% take-profit
        rsi: 50,
      }),
    );

    expect(decision.action).toBe("SELL");
    expect(decision.reasonType).toBe("TAKE_PROFIT");
  });

  it("triggers STOP_LOSS at the ATR-derived threshold, not the flat percent", () => {
    // entryAtrPercent 1% * atrStopMultiplier 2.5 = 2.5% effective stop -
    // well inside the flat 8% stopLossPercent, which would NOT have fired
    // at this -3% move. Multiplier passed explicitly so this test doesn't
    // depend on whatever DEFAULT_STRATEGY_CONFIG's multiplier happens to be.
    const decision = decideTradeSignal(
      baseInput({
        sharesOwned: 10,
        averageEntryPrice: 100,
        price: 97, // -3%
        rsi: 50,
        entryAtrPercent: 0.01,
        config: { useAtrStops: true, atrStopMultiplier: 2.5 },
      }),
    );

    expect(decision.action).toBe("SELL");
    expect(decision.reasonType).toBe("STOP_LOSS");
    expect(decision.reason).toContain("ATR-based");
  });

  it("does not trigger STOP_LOSS below the ATR-derived threshold", () => {
    const decision = decideTradeSignal(
      baseInput({
        sharesOwned: 10,
        averageEntryPrice: 100,
        price: 98.5, // -1.5%, inside the 2.5% ATR-derived stop
        rsi: 50,
        entryAtrPercent: 0.01,
        config: { useAtrStops: true, atrStopMultiplier: 2.5 },
      }),
    );

    expect(decision.reasonType).not.toBe("STOP_LOSS");
  });

  it("triggers TAKE_PROFIT at the ATR-derived threshold, not the flat percent", () => {
    // entryAtrPercent 1% * atrTakeProfitMultiplier 4.5 = 4.5% effective
    // take-profit - well inside the flat 15% takeProfitPercent, which would
    // NOT have fired at this +5% move.
    const decision = decideTradeSignal(
      baseInput({
        sharesOwned: 10,
        averageEntryPrice: 100,
        price: 105, // +5%
        rsi: 50,
        entryAtrPercent: 0.01,
        config: { useAtrStops: true, atrTakeProfitMultiplier: 4.5 },
      }),
    );

    expect(decision.action).toBe("SELL");
    expect(decision.reasonType).toBe("TAKE_PROFIT");
    expect(decision.reason).toContain("ATR-based");
  });

  it("falls back to the flat percent when entryAtrPercent is unavailable", () => {
    const decision = decideTradeSignal(
      baseInput({
        sharesOwned: 10,
        averageEntryPrice: 100,
        price: 97, // -3%, would trigger the ATR-derived 2.5% stop above,
        // but should NOT trigger the flat 8% stop-loss.
        rsi: 50,
        config: { useAtrStops: true, atrStopMultiplier: 2.5 },
      }),
    );

    expect(decision.reasonType).not.toBe("STOP_LOSS");
  });

  it("downgrades a normal SELL_SIGNAL to HOLD when the position is underwater", () => {
    const decision = decideTradeSignal(
      baseInput({
        sharesOwned: 10,
        averageEntryPrice: 100,
        price: 98, // -2%, not a stop-loss, but still a loss
        rsi: 70, // overbought
        bollingerUpper: 90, // near upper band too
      }),
    );

    expect(decision.action).toBe("HOLD");
    expect(decision.reason).toContain("downgraded to HOLD");
  });

  it("executes a normal SELL_SIGNAL when the position is profitable", () => {
    const decision = decideTradeSignal(
      baseInput({
        sharesOwned: 10,
        averageEntryPrice: 100,
        price: 105, // +5%, profitable but below take-profit
        rsi: 70,
        bollingerUpper: 95,
      }),
    );

    expect(decision.action).toBe("SELL");
    expect(decision.reasonType).toBe("SELL_SIGNAL");
  });
});

describe("decideTradeSignal - HOLD is the safe default", () => {
  it("holds when nothing lines up", () => {
    const decision = decideTradeSignal(baseInput());

    expect(decision.action).toBe("HOLD");
    expect(decision.reasonType).toBe("NO_SIGNAL");
  });
});
