import { describe, expect, it } from "vitest";

import {
  buildSignalKey,
  evaluateInsiderVeto,
  evaluateSentimentVeto,
  getSafeBuyNotionalForBucketCap,
  getSafeBuySharesForBucketCap,
  getSafeSellShares,
  isSignalReadyDecision,
  mapEtfRotationExecutionStatusToRebalanceStatus,
  mapExecuteSafeTradeResultToLegOutcome,
  type AutopilotDecisionLog,
  type ExecuteSafeTradeResult,
  type PortfolioSnapshot,
} from "./autopilotWorker.js";
import type { EtfRotationExecutionStatus } from "./etfRotationExecution.js";

function makePortfolio(
  equity: number,
  positions: Record<string, { shares: number; currentPrice: number }> = {},
): PortfolioSnapshot {
  return {
    balance: equity,
    equity,
    currency: "USD",
    positions: Object.fromEntries(
      Object.entries(positions).map(([ticker, position]) => [
        ticker,
        {
          shares: position.shares,
          avgPrice: position.currentPrice,
          currentPrice: position.currentPrice,
          pnl: 0,
          pnlPercent: 0,
        },
      ]),
    ),
  };
}

const TICKER_TO_BUCKET = { AAA: "b1", BBB: "b1", CCC: "b2" };

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

describe("getSafeBuySharesForBucketCap", () => {
  it("does not reduce when the bucket has plenty of room", () => {
    const portfolio = makePortfolio(10000);

    const result = getSafeBuySharesForBucketCap(
      "AAA",
      10,
      100,
      portfolio,
      TICKER_TO_BUCKET,
      0.4,
    );

    expect(result.shares).toBe(10);
    expect(result.safetyNote).toBeUndefined();
  });

  it("clamps to the remaining bucket capacity when another ticker in the same bucket already has exposure", () => {
    // Bucket b1 cap = 10000 * 0.4 = 4000. BBB already holds 3500 of it,
    // leaving 500 -> 5 shares at price 100.
    const portfolio = makePortfolio(10000, {
      BBB: { shares: 35, currentPrice: 100 },
    });

    const result = getSafeBuySharesForBucketCap(
      "AAA",
      10,
      100,
      portfolio,
      TICKER_TO_BUCKET,
      0.4,
    );

    expect(result.shares).toBe(5);
    expect(result.safetyNote).toContain("Bucket cap");
  });

  it("returns 0 when the bucket is already at or over its cap", () => {
    const portfolio = makePortfolio(10000, {
      BBB: { shares: 50, currentPrice: 100 }, // 5000 > 4000 cap
    });

    const result = getSafeBuySharesForBucketCap(
      "AAA",
      10,
      100,
      portfolio,
      TICKER_TO_BUCKET,
      0.4,
    );

    expect(result.shares).toBe(0);
  });

  it("ignores exposure from a different bucket", () => {
    const portfolio = makePortfolio(10000, {
      CCC: { shares: 100, currentPrice: 100 }, // bucket b2, fully maxed
    });

    const result = getSafeBuySharesForBucketCap(
      "AAA",
      10,
      100,
      portfolio,
      TICKER_TO_BUCKET,
      0.4,
    );

    expect(result.shares).toBe(10);
  });

  it("is a no-op for a ticker with no bucket mapping", () => {
    const portfolio = makePortfolio(10000, {
      BBB: { shares: 100, currentPrice: 100 },
    });

    const result = getSafeBuySharesForBucketCap(
      "ZZZ",
      10,
      100,
      portfolio,
      TICKER_TO_BUCKET,
      0.4,
    );

    expect(result.shares).toBe(10);
  });

  it("uses a per-bucket override instead of the default fraction when one is set", () => {
    // b1 override cap = 10000 * 0.1 = 1000, tighter than the 0.4 default.
    const portfolio = makePortfolio(10000);

    const result = getSafeBuySharesForBucketCap(
      "AAA",
      20,
      100,
      portfolio,
      TICKER_TO_BUCKET,
      0.4,
      { b1: 0.1 },
    );

    expect(result.shares).toBe(10); // 1000 / 100
    expect(result.safetyNote).toContain("Bucket cap");
  });

  it("falls back to the default fraction for a bucket with no override", () => {
    const portfolio = makePortfolio(10000);

    const result = getSafeBuySharesForBucketCap(
      "CCC", // bucket b2, no override
      20,
      100,
      portfolio,
      TICKER_TO_BUCKET,
      0.4,
      { b1: 0.1 },
    );

    expect(result.shares).toBe(20); // 4000 / 100 cap, well above requested
  });
});

describe("getSafeBuyNotionalForBucketCap", () => {
  it("does not reduce when the bucket has plenty of room", () => {
    const portfolio = makePortfolio(10000);

    const result = getSafeBuyNotionalForBucketCap(
      "AAA",
      20,
      portfolio,
      TICKER_TO_BUCKET,
      0.4,
    );

    expect(result.notional).toBe(20);
    expect(result.safetyNote).toBeUndefined();
  });

  it("clamps to the remaining bucket capacity in dollar terms, no price/floor step needed", () => {
    // Bucket b1 cap = 10000 * 0.4 = 4000. BBB already holds 3990 of it,
    // leaving 10 - a notional order can use that $10 exactly, unlike the
    // share-based cap which would floor away any partial-share remainder.
    const portfolio = makePortfolio(10000, {
      BBB: { shares: 39.9, currentPrice: 100 },
    });

    const result = getSafeBuyNotionalForBucketCap(
      "AAA",
      20,
      portfolio,
      TICKER_TO_BUCKET,
      0.4,
    );

    expect(result.notional).toBe(10);
    expect(result.safetyNote).toContain("Bucket cap");
  });

  it("returns 0 when the bucket is already at or over its cap", () => {
    const portfolio = makePortfolio(10000, {
      BBB: { shares: 50, currentPrice: 100 }, // 5000 > 4000 cap
    });

    const result = getSafeBuyNotionalForBucketCap(
      "AAA",
      20,
      portfolio,
      TICKER_TO_BUCKET,
      0.4,
    );

    expect(result.notional).toBe(0);
  });

  it("is a no-op for a ticker with no bucket mapping", () => {
    const portfolio = makePortfolio(10000, {
      BBB: { shares: 100, currentPrice: 100 },
    });

    const result = getSafeBuyNotionalForBucketCap(
      "ZZZ",
      20,
      portfolio,
      TICKER_TO_BUCKET,
      0.4,
    );

    expect(result.notional).toBe(20);
  });

  it("uses a per-bucket override instead of the default fraction when one is set", () => {
    // b1 override cap = 10000 * 0.1 = 1000, tighter than the 0.4 default
    // (4000) - the $2000 request should clamp to the override, not the
    // looser default.
    const portfolio = makePortfolio(10000);

    const result = getSafeBuyNotionalForBucketCap(
      "AAA",
      2000,
      portfolio,
      TICKER_TO_BUCKET,
      0.4,
      { b1: 0.1 },
    );

    expect(result.notional).toBe(1000);
    expect(result.safetyNote).toContain("Bucket cap");
  });
});

describe("getSafeSellShares", () => {
  it("caps a fractional position's partial sell using the fraction directly, without forcing a minimum of a full share", () => {
    // sharesOwned < 1, so the Math.max(1, ...) whole-share floor must not
    // apply - it would otherwise force a "minimum" sell larger than the
    // 25% default max-sell-fraction actually allows.
    const result = getSafeSellShares("SELL_SIGNAL", 0.35, 0.35);

    expect(result.shares).toBeCloseTo(0.0875); // 0.35 * 0.25 default fraction
    expect(result.shares).toBeLessThan(0.35);
    expect(result.safetyNote).toContain("Safety cap");
  });

  it("still allows STOP_LOSS to sell a full fractional position", () => {
    const result = getSafeSellShares("STOP_LOSS", 0.35, 0.35);

    expect(result.shares).toBe(0.35);
  });

  it("keeps the existing whole-share behavior unchanged (no regression)", () => {
    const result = getSafeSellShares("SELL_SIGNAL", 10, 10);

    // Math.max(1, Math.floor(10 * 0.25)) = 2
    expect(result.shares).toBe(2);
  });
});

describe("isSignalReadyDecision", () => {
  it("treats a fractional-only BUY (0 suggestedShares, positive suggestedNotional) as ready", () => {
    const decision = makeDecision({
      action: "BUY",
      suggestedShares: 0,
      suggestedNotional: 20,
      confidence: 0.8,
    });

    expect(isSignalReadyDecision(decision)).toBe(true);
  });

  it("is not ready when both suggestedShares and suggestedNotional are 0", () => {
    const decision = makeDecision({
      action: "BUY",
      suggestedShares: 0,
      suggestedNotional: undefined,
      confidence: 0.8,
    });

    expect(isSignalReadyDecision(decision)).toBe(false);
  });

  it("respects an explicit isSignalReady flag over the suggestedShares/suggestedNotional fallback", () => {
    const decision = makeDecision({
      suggestedShares: 0,
      suggestedNotional: undefined,
      isSignalReady: true,
    });

    expect(isSignalReadyDecision(decision)).toBe(true);
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

describe("mapExecuteSafeTradeResultToLegOutcome", () => {
  function makeResult(
    overrides: Partial<ExecuteSafeTradeResult> = {},
  ): ExecuteSafeTradeResult {
    return { status: "success", ...overrides };
  }

  it("maps a success result to accepted, extracting the broker order id", () => {
    const result = makeResult({ status: "success", order: { id: "broker-123" } });

    expect(mapExecuteSafeTradeResultToLegOutcome(result)).toEqual({
      outcome: "accepted",
      brokerOrderId: "broker-123",
    });
  });

  it("maps a success result with no order id to accepted with brokerOrderId undefined", () => {
    const result = makeResult({ status: "success" });

    expect(mapExecuteSafeTradeResultToLegOutcome(result)).toEqual({
      outcome: "accepted",
      brokerOrderId: undefined,
    });
  });

  it("maps an error result classified as ambiguous_network_error to ambiguous", () => {
    const result = makeResult({
      status: "error",
      reason: "socket hang up",
      classification: "ambiguous_network_error",
    });

    expect(mapExecuteSafeTradeResultToLegOutcome(result)).toEqual({
      outcome: "ambiguous",
      reason: "socket hang up",
    });
  });

  it("maps an error result classified as definitive_rejection to rejected", () => {
    const result = makeResult({
      status: "error",
      reason: "insufficient buying power",
      classification: "definitive_rejection",
    });

    expect(mapExecuteSafeTradeResultToLegOutcome(result)).toEqual({
      outcome: "rejected",
      reason: "insufficient buying power",
    });
  });

  it("maps an early gate-check rejected result (no classification at all) to rejected", () => {
    const result = makeResult({
      status: "rejected",
      reason: "Portfolio circuit breaker tripped",
    });

    expect(mapExecuteSafeTradeResultToLegOutcome(result)).toEqual({
      outcome: "rejected",
      reason: "Portfolio circuit breaker tripped",
    });
  });

  it("maps an error result with no classification (unclassified failure) to rejected, never ambiguous by default", () => {
    const result = makeResult({ status: "error", reason: "Unknown trade error" });

    expect(mapExecuteSafeTradeResultToLegOutcome(result)).toEqual({
      outcome: "rejected",
      reason: "Unknown trade error",
    });
  });
});

describe("mapEtfRotationExecutionStatusToRebalanceStatus", () => {
  const cases: Array<[EtfRotationExecutionStatus, string]> = [
    ["accepted", "executed"],
    ["partial", "partial"],
    ["failed", "failed"],
    ["ambiguous", "failed_needs_review"],
    ["blocked", "cancelled"],
    ["not_attempted", "cancelled"],
  ];

  for (const [input, expected] of cases) {
    it(`maps "${input}" to "${expected}"`, () => {
      expect(mapEtfRotationExecutionStatusToRebalanceStatus(input)).toBe(expected);
    });
  }
});
