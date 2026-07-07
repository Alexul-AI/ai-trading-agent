export type StrategyAction = "BUY" | "SELL" | "HOLD";
export type StrategyReasonType =
  | "BUY_SIGNAL"
  | "SELL_SIGNAL"
  | "STOP_LOSS"
  | "TAKE_PROFIT"
  | "NO_SIGNAL"
  | "RISK_LIMIT";

export interface StrategyConfig {
  maxBuyCashFraction: number;
  maxPositionEquityFraction: number;
  cooldownBars: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  buyRsiThreshold: number;
  buyRsiWithMomentumThreshold: number;
  sellRsiThreshold: number;
  sellRsiWithoutMomentumThreshold: number;
  lowerBandBuffer: number;
  upperBandBuffer: number;

  /**
   * Confluence scoring:
   * A single weak condition should not produce noisy BUY/SELL signals.
   * Require several aligned conditions before emitting BUY_SIGNAL/SELL_SIGNAL.
   */
  minBuySignalScore: number;
  minSellSignalScore: number;
  strongSignalScore: number;

  /**
   * Normal SELL_SIGNAL should usually be profit-taking / risk reduction.
   * STOP_LOSS is handled separately before this rule.
   */
  downgradeNormalSellBelowAverageEntry: boolean;
}

export interface StrategyInput {
  ticker: string;
  price: number;
  cash: number;
  portfolioValue: number;
  sharesOwned: number;
  averageEntryPrice: number;
  rsi: number;
  macdHistogram: number;
  previousMacdHistogram: number;
  bollingerLower: number;
  bollingerUpper: number;
  barsSinceLastBuy: number;
  config?: Partial<StrategyConfig>;
}

export interface StrategyDecision {
  action: StrategyAction;
  suggestedShares: number;
  confidence: number;
  reasonType: StrategyReasonType;
  reason: string;
  diagnostics: {
    macdRising: boolean;
    macdFalling: boolean;
    nearLowerBand: boolean;
    nearUpperBand: boolean;
    deepOversold: boolean;
    momentumBuy: boolean;
    overbought: boolean;
    momentumSell: boolean;
    buyScore: number;
    sellScore: number;
    buyReasons: string[];
    sellReasons: string[];
    positionReturnPercent: number;
    currentPositionValue: number;
    remainingPositionCapacity: number;
    cashAllowedForBuy: number;
    maxSharesToBuy: number;
    barsSinceLastBuy: number;
  };
}

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  maxBuyCashFraction: 0.2,
  maxPositionEquityFraction: 0.2,
  cooldownBars: 3,
  stopLossPercent: 0.08,
  takeProfitPercent: 0.15,
  buyRsiThreshold: 38,
  buyRsiWithMomentumThreshold: 46,
  sellRsiThreshold: 65,
  sellRsiWithoutMomentumThreshold: 55,
  lowerBandBuffer: 1.01,
  upperBandBuffer: 0.99,

  // Step 15: reduce weak repeated signals.
  // NVDA-style "RSI < 46 + MACD rising" alone should become HOLD/watch.
  // AMD-style "RSI > 55 + MACD falling" alone should become HOLD/watch.
  minBuySignalScore: 2,
  minSellSignalScore: 2,
  strongSignalScore: 3,

  downgradeNormalSellBelowAverageEntry: true,
};

function mergeConfig(config?: Partial<StrategyConfig>): StrategyConfig {
  return {
    ...DEFAULT_STRATEGY_CONFIG,
    ...(config ?? {}),
  };
}

function formatPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

function confidenceFromScore(score: number, strongSignalScore: number): number {
  if (score >= strongSignalScore + 1) return 0.9;
  if (score >= strongSignalScore) return 0.8;
  return 0.72;
}

function buildHoldDecision(
  reason: string,
  diagnostics: StrategyDecision["diagnostics"],
): StrategyDecision {
  return {
    action: "HOLD",
    suggestedShares: 0,
    confidence: 0,
    reasonType: "NO_SIGNAL",
    reason,
    diagnostics,
  };
}

function scoreSignal(
  conditions: Array<{ active: boolean; points: number; label: string }>,
): { score: number; reasons: string[] } {
  return conditions.reduce(
    (acc, condition) => {
      if (!condition.active) return acc;

      return {
        score: acc.score + condition.points,
        reasons: [...acc.reasons, condition.label],
      };
    },
    { score: 0, reasons: [] as string[] },
  );
}

export function decideTradeSignal(input: StrategyInput): StrategyDecision {
  const config = mergeConfig(input.config);

  const macdRising = input.macdHistogram > input.previousMacdHistogram;
  const macdFalling = input.macdHistogram < input.previousMacdHistogram;

  const nearLowerBand =
    input.bollingerLower > 0 &&
    input.price <= input.bollingerLower * config.lowerBandBuffer;
  const nearUpperBand =
    input.bollingerUpper > 0 &&
    input.price >= input.bollingerUpper * config.upperBandBuffer;

  const currentPositionValue = input.sharesOwned * input.price;
  const remainingPositionCapacity = Math.max(
    0,
    input.portfolioValue * config.maxPositionEquityFraction -
      currentPositionValue,
  );

  const cashAllowedForBuy = Math.min(
    input.cash * config.maxBuyCashFraction,
    remainingPositionCapacity,
  );

  const maxSharesToBuy =
    input.price > 0 ? Math.floor(cashAllowedForBuy / input.price) : 0;

  const positionReturn =
    input.sharesOwned > 0 && input.averageEntryPrice > 0
      ? (input.price - input.averageEntryPrice) / input.averageEntryPrice
      : 0;

  const deepOversold = input.rsi < config.buyRsiThreshold;
  const momentumBuy =
    input.rsi < config.buyRsiWithMomentumThreshold && macdRising;
  const overbought = input.rsi > config.sellRsiThreshold;
  const momentumSell =
    input.rsi > config.sellRsiWithoutMomentumThreshold && macdFalling;

  const buySignal = scoreSignal([
    {
      active: deepOversold,
      points: 2,
      label: `deepOversold(RSI ${input.rsi} < ${config.buyRsiThreshold})`,
    },
    {
      active: nearLowerBand,
      points: 2,
      label: "nearLowerBollingerBand",
    },
    {
      active: momentumBuy,
      points: 1,
      label: "momentumBuy(RSI below momentum threshold + MACD rising)",
    },
  ]);

  const sellSignal = scoreSignal([
    {
      active: overbought,
      points: 2,
      label: `overbought(RSI ${input.rsi} > ${config.sellRsiThreshold})`,
    },
    {
      active: nearUpperBand,
      points: 2,
      label: "nearUpperBollingerBand",
    },
    {
      active: momentumSell,
      points: 1,
      label: "momentumSell(RSI above weak sell threshold + MACD falling)",
    },
    {
      active: positionReturn > 0.03,
      points: 1,
      label: `positionProfitable(${formatPercent(positionReturn * 100)})`,
    },
  ]);

  const diagnostics: StrategyDecision["diagnostics"] = {
    macdRising,
    macdFalling,
    nearLowerBand,
    nearUpperBand,
    deepOversold,
    momentumBuy,
    overbought,
    momentumSell,
    buyScore: buySignal.score,
    sellScore: sellSignal.score,
    buyReasons: buySignal.reasons,
    sellReasons: sellSignal.reasons,
    positionReturnPercent: positionReturn * 100,
    currentPositionValue,
    remainingPositionCapacity,
    cashAllowedForBuy,
    maxSharesToBuy,
    barsSinceLastBuy: input.barsSinceLastBuy,
  };

  if (input.sharesOwned > 0 && input.averageEntryPrice > 0) {
    if (positionReturn <= -config.stopLossPercent) {
      return {
        action: "SELL",
        suggestedShares: input.sharesOwned,
        confidence: 1,
        reasonType: "STOP_LOSS",
        reason: `Stop-loss triggered for ${input.ticker}: positionReturn=${formatPercent(
          positionReturn * 100,
        )}`,
        diagnostics,
      };
    }

    if (positionReturn >= config.takeProfitPercent) {
      return {
        action: "SELL",
        suggestedShares: input.sharesOwned,
        confidence: 0.95,
        reasonType: "TAKE_PROFIT",
        reason: `Take-profit triggered for ${input.ticker}: positionReturn=${formatPercent(
          positionReturn * 100,
        )}`,
        diagnostics,
      };
    }
  }

  if (input.sharesOwned > 0 && sellSignal.score >= config.minSellSignalScore) {
    if (
      config.downgradeNormalSellBelowAverageEntry &&
      input.averageEntryPrice > 0 &&
      positionReturn < 0
    ) {
      return buildHoldDecision(
        `Normal SELL downgraded to HOLD for ${input.ticker}: price is below average entry, positionReturn=${formatPercent(
          positionReturn * 100,
        )}, sellScore=${sellSignal.score}, sellReasons=${sellSignal.reasons.join(
          ", ",
        )}`,
        diagnostics,
      );
    }

    const confidence = confidenceFromScore(
      sellSignal.score,
      config.strongSignalScore,
    );

    return {
      action: "SELL",
      suggestedShares: input.sharesOwned,
      confidence: clampConfidence(confidence),
      reasonType: "SELL_SIGNAL",
      reason: `Sell signal for ${input.ticker}: sellScore=${sellSignal.score}, sellReasons=${sellSignal.reasons.join(
        ", ",
      )}, RSI=${input.rsi}, nearUpperBand=${nearUpperBand}, macdFalling=${macdFalling}, positionReturn=${formatPercent(
        positionReturn * 100,
      )}`,
      diagnostics,
    };
  }

  if (maxSharesToBuy <= 0) {
    return buildHoldDecision(
      `Risk limit: no capacity to buy ${input.ticker}. Position cap or cash limit reached.`,
      diagnostics,
    );
  }

  if (input.barsSinceLastBuy < config.cooldownBars) {
    return buildHoldDecision(
      `Cooldown active for ${input.ticker}: barsSinceLastBuy=${input.barsSinceLastBuy}, required=${config.cooldownBars}`,
      diagnostics,
    );
  }

  if (buySignal.score >= config.minBuySignalScore) {
    const confidence = confidenceFromScore(
      buySignal.score,
      config.strongSignalScore,
    );

    return {
      action: "BUY",
      suggestedShares: maxSharesToBuy,
      confidence: clampConfidence(confidence),
      reasonType: "BUY_SIGNAL",
      reason: `Buy signal for ${input.ticker}: buyScore=${buySignal.score}, buyReasons=${buySignal.reasons.join(
        ", ",
      )}, RSI=${input.rsi}, nearLowerBand=${nearLowerBand}, macdRising=${macdRising}`,
      diagnostics,
    };
  }

  const closestSetup = sellSignal.score > buySignal.score ? "SELL" : "BUY";

  const buyMissingReasons: string[] = [];
  if (buySignal.score < config.minBuySignalScore) {
    buyMissingReasons.push(
      `buyScore ${buySignal.score}/${config.minBuySignalScore}`,
    );
  }
  if (!nearLowerBand) {
    buyMissingReasons.push("price is not near lower Bollinger band");
  }
  if (!macdRising) {
    buyMissingReasons.push("MACD is not rising");
  }

  const sellMissingReasons: string[] = [];
  if (input.sharesOwned <= 0) {
    sellMissingReasons.push("no shares owned");
  }
  if (sellSignal.score < config.minSellSignalScore) {
    sellMissingReasons.push(
      `sellScore ${sellSignal.score}/${config.minSellSignalScore}`,
    );
  }
  if (input.rsi < config.sellRsiThreshold) {
    sellMissingReasons.push(
      `RSI ${input.rsi} is below sell threshold ${config.sellRsiThreshold}`,
    );
  }
  if (!macdFalling) {
    sellMissingReasons.push("MACD is not falling");
  }

  const closestSetupReason =
    closestSetup === "SELL"
      ? `closest SELL setup is not actionable: ${sellMissingReasons.join("; ")}`
      : `closest BUY setup is not actionable: ${buyMissingReasons.join("; ")}`;

  return buildHoldDecision(
    `No confluence signal for ${input.ticker}: ${closestSetupReason}. buyScore=${buySignal.score}/${config.minBuySignalScore}, buyReasons=[${buySignal.reasons.join(
      ", ",
    )}], sellScore=${sellSignal.score}/${config.minSellSignalScore}, sellReasons=[${sellSignal.reasons.join(
      ", ",
    )}], RSI=${input.rsi}, nearLowerBand=${nearLowerBand}, nearUpperBand=${nearUpperBand}, macdRising=${macdRising}, macdFalling=${macdFalling}, sharesOwned=${input.sharesOwned}`,
    diagnostics,
  );
}
