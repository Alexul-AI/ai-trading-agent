import { describe, expect, it } from "vitest";

import {
  buildSignalKey,
  evaluateInsiderVeto,
  evaluateSentimentVeto,
  type AutopilotDecisionLog,
} from "./autopilotWorker.js";

function makeDecision(
  overrides: Partial<AutopilotDecisionLog> = {},
): AutopilotDecisionLog {
  return {
    ticker: "AAPL",
    timestamp: new Date().toISOString(),
    price: 200,
    rsi: 40,
    macdHistogram: 1,
    previousMacdHistogram: 0,
    bollingerLower: 190,
    bollingerUpper: 210,
    action: "BUY",
    confidence: 0.8,
    suggestedShares: 10,
    reasonType: "BUY_SIGNAL",
    reason: "Buy signal for AAPL: RSI=40.12",
    executed: false,
    ...overrides,
  };
}

describe("evaluateSentimentVeto", () => {
  it("blocks on BEARISH sentiment", () => {
    const result = evaluateSentimentVeto("AAPL", "BEARISH", "bad earnings");

    expect(result.blocked).toBe(true);
    expect(result.note).toContain("BEARISH");
    expect(result.note).toContain("bad earnings");
  });

  it("does not block on BULLISH sentiment", () => {
    const result = evaluateSentimentVeto("AAPL", "BULLISH", "good news");

    expect(result.blocked).toBe(false);
  });

  it("does not block on NEUTRAL sentiment", () => {
    const result = evaluateSentimentVeto("AAPL", "NEUTRAL", "no strong news");

    expect(result.blocked).toBe(false);
  });
});

describe("evaluateInsiderVeto", () => {
  it("blocks on a sell cluster (2+) with zero offsetting buys", () => {
    const result = evaluateInsiderVeto("AAPL", 0, 2);

    expect(result.blocked).toBe(true);
    expect(result.note).toContain("2 open-market insider sells");
  });

  it("does not block on a single sale (weak/noisy signal)", () => {
    const result = evaluateInsiderVeto("AAPL", 0, 1);

    expect(result.blocked).toBe(false);
  });

  it("does not block when there is at least one offsetting buy", () => {
    const result = evaluateInsiderVeto("AAPL", 1, 3);

    expect(result.blocked).toBe(false);
  });

  it("does not block when there are no insider transactions at all", () => {
    const result = evaluateInsiderVeto("AAPL", 0, 0);

    expect(result.blocked).toBe(false);
  });
});

describe("buildSignalKey", () => {
  it("stays stable across ticks where only the live RSI/price-derived reason text changes", () => {
    // This is the actual failure mode from production: the same ongoing
    // signal gets a slightly different `reason` string every tick because
    // RSI/price drift. If the key included that text, the Telegram
    // cooldown dedup would never match two ticks of "the same" signal,
    // spamming alerts and leaking an unbounded number of map entries.
    const tick1 = makeDecision({ reason: "Buy signal for AAPL: RSI=40.12" });
    const tick2 = makeDecision({ reason: "Buy signal for AAPL: RSI=40.87" });

    expect(buildSignalKey(tick1)).toBe(buildSignalKey(tick2));
  });

  it("stays stable across ticks where only suggestedShares changes", () => {
    const tick1 = makeDecision({ suggestedShares: 10 });
    const tick2 = makeDecision({ suggestedShares: 12 });

    expect(buildSignalKey(tick1)).toBe(buildSignalKey(tick2));
  });

  it("differs by ticker, action, or reasonType", () => {
    const base = makeDecision();

    expect(buildSignalKey(base)).not.toBe(
      buildSignalKey(makeDecision({ ticker: "MSFT" })),
    );
    expect(buildSignalKey(base)).not.toBe(
      buildSignalKey(makeDecision({ action: "SELL" })),
    );
    expect(buildSignalKey(base)).not.toBe(
      buildSignalKey(makeDecision({ reasonType: "STOP_LOSS" })),
    );
  });
});
