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

  /**
   * Off by default (see DEFAULT_STRATEGY_CONFIG): when true, the stop-loss
   * and take-profit distances scale with each position's own entry-time
   * volatility (entryAtrPercent * multiplier) instead of the flat
   * stopLossPercent/takeProfitPercent above. Falls back to the flat
   * percentages when entryAtrPercent is unavailable.
   */
  useAtrStops: boolean;
  atrStopMultiplier: number;
  atrTakeProfitMultiplier: number;

  /**
   * Off by default: whole-share sizing (Math.floor(cash / price)) yields 0
   * shares for most/all tickers below roughly $1,000-3,000 of capital, so
   * the bot silently can't act on a BUY signal at low account sizes. When
   * enabled, a BUY that would otherwise size to 0 whole shares falls back
   * to a fractional/notional order instead - but that order does NOT get
   * Alpaca's broker-side bracket stop_loss/take_profit (unconfirmed
   * whether brackets work with fractional/notional sizing), so it relies
   * solely on decideTradeSignal's own cycle-based STOP_LOSS/TAKE_PROFIT
   * re-evaluation. A real, knowingly-accepted reduction in protection for
   * these specific positions - opt-in, not a pure risk reduction.
   */
  allowFractionalShares: boolean;
  minFractionalNotionalUsd: number;
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
  entryAtrPercent?: number;
  config?: Partial<StrategyConfig>;
}

export interface StrategyDecision {
  action: StrategyAction;
  suggestedShares: number;
  /**
   * Set only for the fractional-fallback BUY case (allowFractionalShares
   * on, whole-share sizing yields 0, cash room clears the minimum). Dollar
   * amount to buy via a notional order, not a share count.
   */
  suggestedNotional?: number;
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
  useAtrStops: false,
  // Backtest-validated (900-day/13-ticker sweep): 2.5x/4.5x was a clear net
  // negative on average (avg return +1.64% vs +3.05% baseline). 3.5x/6x
  // roughly matches baseline (+3.10% avg return, -3.95% avg maxDD) while
  // meaningfully improving win-rate consistency on the most volatile
  // tickers (AMD 50%->83%, NVDA 87.5%->100%, TSLA 50%->67%). Still off by
  // default - "roughly matches baseline" isn't yet strong enough evidence
  // to flip the default, per this project's history of tweaks that looked
  // promising on one backtest window and didn't hold up.
  atrStopMultiplier: 3.5,
  atrTakeProfitMultiplier: 6,

  allowFractionalShares: false,
  // Alpaca's own minimum fractional order is $1 notional; $5 avoids
  // dust-sized orders that aren't worth the order-management overhead.
  minFractionalNotionalUsd: 5,

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

  const suggestedNotionalForFractionalBuy =
    config.allowFractionalShares &&
    maxSharesToBuy === 0 &&
    cashAllowedForBuy >= config.minFractionalNotionalUsd
      ? Number(cashAllowedForBuy.toFixed(2))
      : undefined;

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
    const useAtr = config.useAtrStops && (input.entryAtrPercent ?? 0) > 0;
    const effectiveStopLossPercent = useAtr
      ? (input.entryAtrPercent as number) * config.atrStopMultiplier
      : config.stopLossPercent;
    const effectiveTakeProfitPercent = useAtr
      ? (input.entryAtrPercent as number) * config.atrTakeProfitMultiplier
      : config.takeProfitPercent;

    if (positionReturn <= -effectiveStopLossPercent) {
      return {
        action: "SELL",
        suggestedShares: input.sharesOwned,
        confidence: 1,
        reasonType: "STOP_LOSS",
        reason: `Stop-loss triggered for ${input.ticker}: positionReturn=${formatPercent(
          positionReturn * 100,
        )}${useAtr ? ` (ATR-based, threshold=${formatPercent(-effectiveStopLossPercent * 100)})` : ""}`,
        diagnostics,
      };
    }

    if (positionReturn >= effectiveTakeProfitPercent) {
      return {
        action: "SELL",
        suggestedShares: input.sharesOwned,
        confidence: 0.95,
        reasonType: "TAKE_PROFIT",
        reason: `Take-profit triggered for ${input.ticker}: positionReturn=${formatPercent(
          positionReturn * 100,
        )}${useAtr ? ` (ATR-based, threshold=${formatPercent(effectiveTakeProfitPercent * 100)})` : ""}`,
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

  if (maxSharesToBuy <= 0 && suggestedNotionalForFractionalBuy === undefined) {
    const positionCapValue =
      input.portfolioValue * config.maxPositionEquityFraction;

    return buildHoldDecision(
      `Risk limit: no capacity to buy ${input.ticker}: maxSharesToBuy=${maxSharesToBuy}, sharesOwned=${input.sharesOwned}, currentPositionValue=${currentPositionValue.toFixed(
        2,
      )}, positionCapValue=${positionCapValue.toFixed(
        2,
      )}, remainingPositionCapacity=${remainingPositionCapacity.toFixed(
        2,
      )}, cashAllowedForBuy=${cashAllowedForBuy.toFixed(
        2,
      )}, cash=${input.cash.toFixed(2)}, price=${input.price.toFixed(
        2,
      )}, maxPositionEquityFraction=${config.maxPositionEquityFraction}, maxBuyCashFraction=${config.maxBuyCashFraction}`,
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
      suggestedNotional: suggestedNotionalForFractionalBuy,
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
