import { describe, expect, it, vi } from "vitest";

import {
  analyzeTicker,
  shouldBlockNormalSellBelowAverageEntry,
} from "./analyzeTicker.js";
import { makePortfolioSnapshot, todayDateKey } from "./autopilotWorker.characterization.helpers.js";
import type { AlpacaBar } from "./src/types/autopilotTypes.js";
import type { ExecuteSafeTradeResult } from "./src/types/autopilotTypes.js";

// analyzeTicker takes everything as an explicit parameter (config, DI
// functions, cross-cycle Maps) rather than reading process.env/closure
// state directly - that's the whole point of the extraction (PR #54, see
// docs/ops/AUTOPILOT_WORKER_MAP.md) - so unlike autopilotWorker.characterization.
// *.test.ts, these tests need no vi.stubEnv/dynamic-import gymnastics.

function makeBar(dateKey: string, close: number): AlpacaBar {
  return {
    t: `${dateKey}T00:00:00Z`,
    o: close,
    h: close * 1.01,
    l: close * 0.99,
    c: Number(close.toFixed(2)),
    v: 1_000_000,
  };
}

/** 155 flat bars, then 18 days trending at 2%/day in `direction`, then 2 small reversal days - verified (by running the real indicators.ts code) to produce a clean BUY_SIGNAL (direction=-1) or SELL_SIGNAL (direction=+1). */
function buildTrendReversalBars(endDateKey: string, direction: 1 | -1): AlpacaBar[] {
  const end = new Date(`${endDateKey}T00:00:00Z`);
  const closes: number[] = [];
  for (let day = 0; day < 155; day++) closes.push(100);
  for (let day = 0; day < 18; day++) {
    closes.push(closes[closes.length - 1]! * (1 + direction * 0.02));
  }
  closes.push(closes[closes.length - 1]! * (1 + -direction * 0.01));
  closes.push(closes[closes.length - 1]! * (1 + -direction * 0.005));

  const n = closes.length;
  const bars: AlpacaBar[] = [];
  for (let i = 0; i < n; i++) {
    const daysAgo = n - 1 - i;
    const date = new Date(end);
    date.setUTCDate(date.getUTCDate() - daysAgo);
    bars.push(makeBar(date.toISOString().slice(0, 10), closes[i]!));
  }
  return bars;
}

function makeFlatBars(count: number, endDateKey: string, close: number): AlpacaBar[] {
  const end = new Date(`${endDateKey}T00:00:00Z`);
  const bars: AlpacaBar[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const date = new Date(end);
    date.setUTCDate(date.getUTCDate() - i);
    bars.push(makeBar(date.toISOString().slice(0, 10), close));
  }
  return bars;
}

function baseParams(overrides: Partial<Parameters<typeof analyzeTicker>[0]> = {}) {
  return {
    ticker: "TEST",
    portfolio: makePortfolioSnapshot(),
    circuitBreakerState: null,
    regimeByBucketByDate: new Map(),
    tradeMode: "paper" as const,
    minConfidence: 0.75,
    cooldownMinutes: 60,
    allowFractionalShares: false,
    blockSellBelowAverageEntry: true,
    regimeFilterEnabled: false,
    regimeBuckets: [],
    tickerToBucket: {},
    maxBucketEquityFraction: 0.4,
    bucketEquityFractionOverrides: {},
    sentimentFilterEnabled: false,
    insiderFilterEnabled: false,
    executionGates: { executeTradesEnabled: true, allowBuy: true, allowSell: true },
    barsDays: 180,
    fetchBars: async () => [] as AlpacaBar[],
    executeSafeTrade: vi.fn(
      async (): Promise<ExecuteSafeTradeResult> => ({
        status: "success",
        order: { id: "test-order" },
      }),
    ),
    lastBuyAtByTicker: new Map<string, number>(),
    entryAtrPercentByTicker: new Map<string, number>(),
    ...overrides,
  };
}

// Golden values captured from the CURRENT (pre-extraction) code via a real
// createAutopilotWorker(...).runOnce() call, before this PR touched
// anything - see docs/ops/AUTOPILOT_WORKER_MAP.md for how these were
// derived. Fields that are inherently fresh-per-call (timestamp) are
// asserted separately, not compared byte-for-byte.
const GOLDEN_BUY = {
  ticker: "BUYTEST",
  price: 70.56,
  rsi: 6.46,
  macdHistogram: -0.8885,
  previousMacdHistogram: -1.1638,
  bollingerLower: 63.59,
  bollingerUpper: 99.87,
  action: "BUY",
  confidence: 0.8,
  suggestedShares: 28,
  reasonType: "BUY_SIGNAL",
  finalStatus: "executed",
  signalStatus: "ready",
  executionStatus: "executed",
  isSignalReady: true,
  executed: true,
};

const GOLDEN_SELL = {
  ticker: "SELLTEST",
  price: 140.69,
  rsi: 91.55,
  macdHistogram: 1.6671,
  previousMacdHistogram: 2.0714,
  bollingerLower: 96.89,
  bollingerUpper: 149.73,
  action: "SELL",
  confidence: 0.9,
  suggestedShares: 2,
  originalSuggestedShares: 10,
  reasonType: "SELL_SIGNAL",
  finalStatus: "executed",
  signalStatus: "ready",
  executionStatus: "executed",
  isSignalReady: true,
  executed: true,
};

const GOLDEN_STOP = {
  ticker: "STOPTEST",
  price: 100,
  rsi: 100,
  macdHistogram: 0,
  previousMacdHistogram: 0,
  bollingerLower: 100,
  bollingerUpper: 100,
  action: "SELL",
  confidence: 1,
  suggestedShares: 10,
  reasonType: "STOP_LOSS",
  finalStatus: "executed",
  signalStatus: "ready",
  executionStatus: "executed",
  isSignalReady: true,
  executed: true,
};

describe("analyzeTicker: golden-snapshot comparison against the pre-extraction code", () => {
  it("BUY_SIGNAL matches the captured golden values", async () => {
    const today = todayDateKey();
    const bars = buildTrendReversalBars(today, -1);
    const params = baseParams({
      ticker: "BUYTEST",
      portfolio: makePortfolioSnapshot(),
      fetchBars: async () => bars,
    });

    const result = await analyzeTicker(params);

    for (const [key, value] of Object.entries(GOLDEN_BUY)) {
      expect(result[key as keyof typeof result]).toEqual(value);
    }
    expect(typeof result.timestamp).toBe("string");

    // executeSafeTrade argument check (QA follow-up): DEFAULT_STRATEGY_CONFIG
    // is stopLossPercent=0.08/takeProfitPercent=0.15/useAtrStops=false, so a
    // non-fractional BUY at price=70.56 gets a flat-percent bracket:
    // stopLoss = 70.56*0.92 = 64.9152 -> 64.92, takeProfit = 70.56*1.15 =
    // 81.144 -> 81.14. Not fractional (allowFractionalShares=false), so
    // notional stays undefined.
    expect(params.executeSafeTrade).toHaveBeenCalledTimes(1);
    expect(params.executeSafeTrade).toHaveBeenCalledWith(
      "BUYTEST",
      "BUY",
      28,
      "market",
      undefined,
      64.92,
      81.14,
      undefined,
    );
  });

  it("SELL_SIGNAL (non-losing) matches the captured golden values", async () => {
    const today = todayDateKey();
    const bars = buildTrendReversalBars(today, 1);
    const sellClose = bars[bars.length - 1]!.c;

    const portfolio = makePortfolioSnapshot({
      positions: {
        SELLTEST: {
          shares: 10,
          avgPrice: 130,
          currentPrice: sellClose,
          pnl: (sellClose - 130) * 10,
          pnlPercent: ((sellClose - 130) / 130) * 100,
        },
      },
    });

    const params = baseParams({
      ticker: "SELLTEST",
      portfolio,
      fetchBars: async () => bars,
    });

    const result = await analyzeTicker(params);

    for (const [key, value] of Object.entries(GOLDEN_SELL)) {
      expect(result[key as keyof typeof result]).toEqual(value);
    }
    expect(typeof result.timestamp).toBe("string");

    // SELL orders never get a stopLoss/takeProfit bracket or notional -
    // those are BUY-only (see analyzeTicker.ts). Quantity is the
    // safety-capped 2 shares (golden's suggestedShares), not the original 10.
    expect(params.executeSafeTrade).toHaveBeenCalledTimes(1);
    expect(params.executeSafeTrade).toHaveBeenCalledWith(
      "SELLTEST",
      "SELL",
      2,
      "market",
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it("STOP_LOSS matches the captured golden values", async () => {
    const today = todayDateKey();
    const bars = makeFlatBars(175, today, 100);

    const portfolio = makePortfolioSnapshot({
      positions: {
        STOPTEST: { shares: 10, avgPrice: 110, currentPrice: 100, pnl: -100, pnlPercent: -9.09 },
      },
    });

    const params = baseParams({
      ticker: "STOPTEST",
      portfolio,
      fetchBars: async () => bars,
    });

    const result = await analyzeTicker(params);

    for (const [key, value] of Object.entries(GOLDEN_STOP)) {
      expect(result[key as keyof typeof result]).toEqual(value);
    }
    expect(typeof result.timestamp).toBe("string");

    // STOP_LOSS sells the full 10-share position (no safety-cap reduction,
    // matching "STOP_LOSS can sell the full position" in the golden's
    // safetyNote) with no bracket/notional, same as the plain SELL case.
    expect(params.executeSafeTrade).toHaveBeenCalledTimes(1);
    expect(params.executeSafeTrade).toHaveBeenCalledWith(
      "STOPTEST",
      "SELL",
      10,
      "market",
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });
});

describe("analyzeTicker: SELL execution-permission gate (real SELL-specific logic)", () => {
  it("blocks a STOP_LOSS from reaching the broker when allowSell=false", async () => {
    const today = todayDateKey();
    const bars = makeFlatBars(175, today, 100);
    const portfolio = makePortfolioSnapshot({
      positions: {
        STOPTEST: { shares: 10, avgPrice: 110, currentPrice: 100, pnl: -100, pnlPercent: -9.09 },
      },
    });
    const executeSafeTrade = vi.fn(
      async (): Promise<ExecuteSafeTradeResult> => ({ status: "success" }),
    );

    const result = await analyzeTicker(
      baseParams({
        ticker: "STOPTEST",
        portfolio,
        fetchBars: async () => bars,
        executionGates: { executeTradesEnabled: true, allowBuy: true, allowSell: false },
        executeSafeTrade,
      }),
    );

    expect(result.action).toBe("SELL");
    expect(result.reasonType).toBe("STOP_LOSS");
    expect(result.executionStatus).toBe("blocked");
    expect(result.executed).toBe(false);
    expect(executeSafeTrade).not.toHaveBeenCalled();
  });
});

describe("shouldBlockNormalSellBelowAverageEntry (direct unit test of the pure predicate)", () => {
  // Real finding (see docs/ops/AUTOPILOT_WORKER_MAP.md): this guard's
  // blocking branch is currently unreachable through the real
  // decideTradeSignal pipeline, since strategyEngine.ts's own
  // downgradeNormalSellBelowAverageEntry already turns any losing
  // SELL_SIGNAL into HOLD one layer up. Verified directly here instead,
  // with hand-crafted inputs, matching evaluateSentimentVeto/
  // evaluateInsiderVeto's own direct-unit-test style.
  it("blocks a normal SELL_SIGNAL priced below average entry when enabled", () => {
    const blocked = shouldBlockNormalSellBelowAverageEntry({
      action: "SELL",
      reasonType: "SELL_SIGNAL",
      sharesOwned: 10,
      price: 90,
      averageEntryPrice: 100,
      blockSellBelowAverageEntry: true,
    });
    expect(blocked).toBe(true);
  });

  it("does not block when the flag is disabled", () => {
    const blocked = shouldBlockNormalSellBelowAverageEntry({
      action: "SELL",
      reasonType: "SELL_SIGNAL",
      sharesOwned: 10,
      price: 90,
      averageEntryPrice: 100,
      blockSellBelowAverageEntry: false,
    });
    expect(blocked).toBe(false);
  });

  it("does not block STOP_LOSS even below average entry", () => {
    const blocked = shouldBlockNormalSellBelowAverageEntry({
      action: "SELL",
      reasonType: "STOP_LOSS",
      sharesOwned: 10,
      price: 90,
      averageEntryPrice: 100,
      blockSellBelowAverageEntry: true,
    });
    expect(blocked).toBe(false);
  });

  it("does not block a SELL at or above average entry", () => {
    const blocked = shouldBlockNormalSellBelowAverageEntry({
      action: "SELL",
      reasonType: "SELL_SIGNAL",
      sharesOwned: 10,
      price: 110,
      averageEntryPrice: 100,
      blockSellBelowAverageEntry: true,
    });
    expect(blocked).toBe(false);
  });

  it("does not block BUY actions", () => {
    const blocked = shouldBlockNormalSellBelowAverageEntry({
      action: "BUY",
      reasonType: "SELL_SIGNAL",
      sharesOwned: 10,
      price: 90,
      averageEntryPrice: 100,
      blockSellBelowAverageEntry: true,
    });
    expect(blocked).toBe(false);
  });
});
