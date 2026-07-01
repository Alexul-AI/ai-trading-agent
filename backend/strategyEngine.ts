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
    nearLowerBand: boolean;
    nearUpperBand: boolean;
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

export function decideTradeSignal(input: StrategyInput): StrategyDecision {
  const config = mergeConfig(input.config);

  const macdRising = input.macdHistogram > input.previousMacdHistogram;
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

  const diagnostics: StrategyDecision["diagnostics"] = {
    macdRising,
    nearLowerBand,
    nearUpperBand,
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

  if (
    input.sharesOwned > 0 &&
    (input.rsi > config.sellRsiThreshold ||
      nearUpperBand ||
      (input.rsi > config.sellRsiWithoutMomentumThreshold && !macdRising))
  ) {
    const confidence =
      input.rsi > config.sellRsiThreshold || nearUpperBand ? 0.8 : 0.6;

    return {
      action: "SELL",
      suggestedShares: input.sharesOwned,
      confidence: clampConfidence(confidence),
      reasonType: "SELL_SIGNAL",
      reason: `Sell signal for ${input.ticker}: RSI=${input.rsi}, nearUpperBand=${nearUpperBand}, macdRising=${macdRising}`,
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

  const deepOversold = input.rsi < config.buyRsiThreshold;
  const momentumBuy = input.rsi < config.buyRsiWithMomentumThreshold && macdRising;

  if (deepOversold || nearLowerBand || momentumBuy) {
    const confidence = deepOversold || nearLowerBand ? 0.75 : 0.55;

    return {
      action: "BUY",
      suggestedShares: maxSharesToBuy,
      confidence: clampConfidence(confidence),
      reasonType: "BUY_SIGNAL",
      reason: `Buy signal for ${input.ticker}: RSI=${input.rsi}, nearLowerBand=${nearLowerBand}, macdRising=${macdRising}`,
      diagnostics,
    };
  }

  return buildHoldDecision(
    `No clear signal for ${input.ticker}: RSI=${input.rsi}, nearLowerBand=${nearLowerBand}, nearUpperBand=${nearUpperBand}, macdRising=${macdRising}`,
    diagnostics,
  );
}
