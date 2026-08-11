// ETF Rotation methodology metrics (2026-08-10, research-only) - turnover,
// risk-adjusted return (volatility/Sharpe/Sortino), realized gain/loss, and
// illustrative tax-drag/friction sensitivity, on top of the existing
// scorecard.ts (CAGR/Calmar/max-drawdown). Deliberately a separate module,
// not an extension of scorecard.ts - every existing report stays
// byte-stable, and these metrics never silently get pulled into
// comparisons that predate them. Pure, generic functions (take primitives,
// not EtfRotationSimResult) so any future strategy/backtest can reuse
// them, same pure/adapter split as scorecard.ts's own functions.
//
// Tax-drag scenarios are illustrative sensitivity analysis, NOT tax advice
// - a single flat rate applied to net realized gain at the end of the
// simulated window, no wash-sale rule, no per-lot complexity, no
// jurisdiction handling, no dividend tax, no exact after-tax truth. The
// goal is answering "does this strategy have a hidden turnover/tax drag
// worth knowing about," not producing a real tax bill.

import type { EquityCurvePoint, TradeLogEntry } from "./backtest-etf-rotation.js";

const TRADING_DAYS_PER_YEAR = 252;
const DAYS_PER_YEAR = 365;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface DailyReturnStats {
  observationCount: number;
  meanDailyReturnPercent: number;
  annualizedVolatilityPercent: number;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
}

/**
 * Daily-return-based volatility/Sharpe/Sortino from a daily equity curve.
 * Annualizes by sqrt(252) (trading days per year), NOT calendar days -
 * the opposite convention from scorecard.ts's CAGR, deliberately: CAGR
 * annualizes over elapsed calendar time (a compounding-return question),
 * while the sqrt(N) volatility-scaling law is about the COUNT of sampled
 * return periods (an IID-daily-sample question) - using calendar days
 * here would be a different, new bug, not a fix.
 *
 * annualRiskFreeRatePercent defaults to 0 (no risk-free benchmark wired up
 * - a standard, disclosed simplification for a research sensitivity check,
 * not a claim that the true risk-free rate is zero).
 *
 * Sharpe/Sortino are null (not NaN/Infinity) when their denominator is
 * exactly 0 - same "null over garbage" convention as scorecard.ts's
 * computeCalmarRatio. Sortino's downside deviation is measured against the
 * same daily risk-free rate used as MAR (minimum acceptable return), not
 * hardcoded to 0, so it stays consistent with a non-zero rate if one is
 * ever supplied.
 */
export function computeDailyReturnStats(
  equityCurve: Pick<EquityCurvePoint, "equity">[],
  annualRiskFreeRatePercent = 0,
): DailyReturnStats {
  const dailyReturnsPercent: number[] = [];
  for (let i = 1; i < equityCurve.length; i += 1) {
    const prev = equityCurve[i - 1]!.equity;
    const curr = equityCurve[i]!.equity;
    if (prev > 0) {
      dailyReturnsPercent.push(((curr - prev) / prev) * 100);
    }
  }

  const n = dailyReturnsPercent.length;
  if (n === 0) {
    return {
      observationCount: 0,
      meanDailyReturnPercent: 0,
      annualizedVolatilityPercent: 0,
      sharpeRatio: null,
      sortinoRatio: null,
    };
  }

  const meanDailyReturnPercent =
    dailyReturnsPercent.reduce((sum, r) => sum + r, 0) / n;

  const variance =
    dailyReturnsPercent.reduce(
      (sum, r) => sum + (r - meanDailyReturnPercent) ** 2,
      0,
    ) / n;
  const dailyStdev = Math.sqrt(variance);
  const annualizedVolatilityPercent = dailyStdev * Math.sqrt(TRADING_DAYS_PER_YEAR);

  const dailyRiskFreeRatePercent = annualRiskFreeRatePercent / TRADING_DAYS_PER_YEAR;
  const meanDailyExcessReturnPercent = meanDailyReturnPercent - dailyRiskFreeRatePercent;

  const sharpeRatio =
    dailyStdev === 0
      ? null
      : (meanDailyExcessReturnPercent / dailyStdev) * Math.sqrt(TRADING_DAYS_PER_YEAR);

  const downsideShortfalls = dailyReturnsPercent
    .filter((r) => r < dailyRiskFreeRatePercent)
    .map((r) => r - dailyRiskFreeRatePercent);
  const downsideVariance =
    downsideShortfalls.length > 0
      ? downsideShortfalls.reduce((sum, d) => sum + d ** 2, 0) / downsideShortfalls.length
      : 0;
  const downsideDeviation = Math.sqrt(downsideVariance);

  const sortinoRatio =
    downsideDeviation === 0
      ? null
      : (meanDailyExcessReturnPercent / downsideDeviation) * Math.sqrt(TRADING_DAYS_PER_YEAR);

  return {
    observationCount: n,
    meanDailyReturnPercent,
    annualizedVolatilityPercent,
    sharpeRatio,
    sortinoRatio,
  };
}

type TradeLike = Pick<TradeLogEntry, "date" | "ticker" | "action" | "shares" | "price">;

interface MatchedRoundTrip {
  ticker: string;
  buyDate: string;
  buyPrice: number;
  sellDate: string;
  sellPrice: number;
  shares: number;
  daysHeld: number;
  gainLossUsd: number;
}

function calendarDaysBetween(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  return Math.round((end - start) / MS_PER_DAY);
}

/**
 * Matches each SELL to its immediately-preceding same-ticker BUY - exact,
 * not an approximation, because computeRebalanceOrders (etfRotationStrategy.ts)
 * always fully liquidates a position before rebuying, so there is never a
 * multi-lot position to disambiguate: a SELL's cost basis is always its
 * own last same-ticker BUY. Relies on trades being in chronological order
 * (true for every EtfRotationSimResult.trades - within a single rebalance
 * date, SELLs are pushed before BUYs, so a same-day rebuy of a continuing
 * pick is correctly NOT matched against itself). A SELL with no preceding
 * BUY for that ticker in the log (shouldn't happen from this engine, but
 * this function doesn't assume it can't) is skipped, not thrown - a
 * defensive choice for a research tool, not a correctness guarantee.
 */
function matchSellsToBuys(trades: TradeLike[]): MatchedRoundTrip[] {
  const lastBuyByTicker = new Map<string, { date: string; price: number }>();
  const roundTrips: MatchedRoundTrip[] = [];

  for (const trade of trades) {
    if (trade.action === "BUY") {
      lastBuyByTicker.set(trade.ticker, { date: trade.date, price: trade.price });
      continue;
    }

    const buy = lastBuyByTicker.get(trade.ticker);
    if (!buy) continue;

    roundTrips.push({
      ticker: trade.ticker,
      buyDate: buy.date,
      buyPrice: buy.price,
      sellDate: trade.date,
      sellPrice: trade.price,
      shares: trade.shares,
      daysHeld: calendarDaysBetween(buy.date, trade.date),
      gainLossUsd: (trade.price - buy.price) * trade.shares,
    });
    lastBuyByTicker.delete(trade.ticker);
  }

  return roundTrips;
}

export interface TurnoverStats {
  grossTurnoverUsd: number;
  annualizedTurnoverPercent: number;
  averageHoldingPeriodDays: number | null;
}

/**
 * Portfolio turnover and average per-trade holding period from a trade
 * log. Gross turnover = total dollar volume traded, both directions
 * (BUY + SELL) - the standard "how much of the portfolio's value changed
 * hands" measure. Annualized turnover is expressed per calendar year (the
 * conventional way a "200% annual turnover" figure is read), unlike
 * computeDailyReturnStats above, which annualizes by trading-day count -
 * two different, both individually standard, conventions for two
 * different kinds of quantity.
 *
 * averageHoldingPeriodDays is null when there are no SELLs yet in the
 * trade log (nothing to average).
 */
export function computeTurnoverStats(
  trades: TradeLike[],
  avgEquityUsd: number,
  annualizationCalendarDays: number,
): TurnoverStats {
  const grossTurnoverUsd = trades.reduce(
    (sum, trade) => sum + trade.shares * trade.price,
    0,
  );

  const annualizedTurnoverPercent =
    avgEquityUsd > 0 && annualizationCalendarDays > 0
      ? (grossTurnoverUsd / avgEquityUsd) * (DAYS_PER_YEAR / annualizationCalendarDays) * 100
      : 0;

  const holdingPeriods = matchSellsToBuys(trades).map((trip) => trip.daysHeld);
  const averageHoldingPeriodDays =
    holdingPeriods.length > 0
      ? holdingPeriods.reduce((sum, d) => sum + d, 0) / holdingPeriods.length
      : null;

  return { grossTurnoverUsd, annualizedTurnoverPercent, averageHoldingPeriodDays };
}

export interface RealizedGainLossEntry {
  ticker: string;
  buyDate: string;
  sellDate: string;
  daysHeld: number;
  gainLossUsd: number;
}

/** One entry per SELL, matched to its cost-basis BUY via matchSellsToBuys - see that function's doc comment for why this is exact, not approximate, in this engine. */
export function computeRealizedGainLoss(trades: TradeLike[]): RealizedGainLossEntry[] {
  return matchSellsToBuys(trades).map((trip) => ({
    ticker: trip.ticker,
    buyDate: trip.buyDate,
    sellDate: trip.sellDate,
    daysHeld: trip.daysHeld,
    gainLossUsd: trip.gainLossUsd,
  }));
}

export interface TaxDragScenario {
  taxRatePercent: number;
  taxOwedUsd: number;
  afterTaxFinalEquityUsd: number;
  afterTaxTotalReturnPercent: number;
}

/**
 * Illustrative tax-drag sensitivity, NOT tax advice and not an exact
 * after-tax figure - deliberately simplified (see this module's file
 * header): net realized gain/loss across the whole window (losses offset
 * gains, no per-lot wash-sale disallowance), taxed once at the end of the
 * window at a flat rate, not on a real periodic tax timeline. A net loss
 * owes 0 tax (no refund/carryforward modeled either). Rates are supplied
 * entirely by the caller - this function has no default/"correct" rate
 * baked in, so it can never be mistaken for an assertion about the right
 * rate to use.
 */
export function computeTaxDragScenarios(
  totalRealizedGainLossUsd: number,
  finalEquityUsd: number,
  startingEquityUsd: number,
  taxRatePercentages: number[],
): TaxDragScenario[] {
  return taxRatePercentages.map((taxRatePercent) => {
    const taxOwedUsd = Math.max(0, totalRealizedGainLossUsd) * (taxRatePercent / 100);
    const afterTaxFinalEquityUsd = finalEquityUsd - taxOwedUsd;
    const afterTaxTotalReturnPercent =
      startingEquityUsd > 0
        ? ((afterTaxFinalEquityUsd - startingEquityUsd) / startingEquityUsd) * 100
        : 0;

    return { taxRatePercent, taxOwedUsd, afterTaxFinalEquityUsd, afterTaxTotalReturnPercent };
  });
}

export interface FrictionSensitivityScenario {
  additionalFrictionBps: number;
  estimatedExtraCostUsd: number;
  adjustedFinalEquityUsd: number;
  adjustedTotalReturnPercent: number;
}

/**
 * Post-hoc, linear friction-cost sensitivity - deliberately NOT a
 * re-simulation. Approximates the extra cost of a higher effective
 * spread/slippage as additionalFrictionBps applied once to the
 * already-simulated gross turnover, subtracted from final equity. Cheap
 * and approximate on purpose (doesn't compound through re-invested
 * capital the way a real re-simulation would) - a sensitivity check, not
 * a second pricing engine. additionalFrictionBps is ON TOP OF whatever
 * slippage the simulation already modeled (backtest-etf-rotation.ts's own
 * SLIPPAGE_PERCENT), not a replacement for it - 0 in the list means
 * "no additional friction beyond what was already simulated," not
 * "frictionless."
 */
export function computeFrictionSensitivity(
  grossTurnoverUsd: number,
  finalEquityUsd: number,
  startingEquityUsd: number,
  additionalFrictionBpsList: number[],
): FrictionSensitivityScenario[] {
  return additionalFrictionBpsList.map((additionalFrictionBps) => {
    const estimatedExtraCostUsd = (additionalFrictionBps / 10000) * grossTurnoverUsd;
    const adjustedFinalEquityUsd = finalEquityUsd - estimatedExtraCostUsd;
    const adjustedTotalReturnPercent =
      startingEquityUsd > 0
        ? ((adjustedFinalEquityUsd - startingEquityUsd) / startingEquityUsd) * 100
        : 0;

    return {
      additionalFrictionBps,
      estimatedExtraCostUsd,
      adjustedFinalEquityUsd,
      adjustedTotalReturnPercent,
    };
  });
}
