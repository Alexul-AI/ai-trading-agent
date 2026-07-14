// ETF Rotation strategy (docs/product/ROADMAP.md Phase 2) - pure decision
// logic, no I/O. Ranks a small ETF universe by trailing momentum, keeps
// only the top picks that also pass a long-term trend filter, and
// equal-weights those - a pick that fails the trend filter is replaced by
// cash for that slot, not by the next-ranked ETF (stays defensive in a
// real downtrend rather than "always fully invested in something").
//
// Same pure/adapter split as decideTradeSignal (strategyEngine.ts) and
// applyStickyTrip (portfolioCircuitBreaker.ts) - this file never touches
// the filesystem or knows about Alpaca; backtest-etf-rotation.ts is the
// I/O-and-orchestration layer that calls into this.

import { calculateSMA } from "./indicators.js";

export interface EtfRotationConfig {
  universe: string[];
  momentumLookbackDays: number;
  trendFilterSmaPeriod: number;
  holdCount: number;
}

// Universe: SPY (US broad), QQQ (growth/Nasdaq proxy), EFA (international),
// TLT (bonds), GLD (commodities/gold) - matches the roadmap's Phase 2
// universe description. Momentum lookback (126 trading days, ~6 months) and
// trend filter (SMA200, matching the Trend Participation section's own
// convention) are single-value MVP choices, not a multi-lookback blend -
// documented simplifications, not limitations discovered late. Hold count
// of 2 is the low end of the roadmap's "2-4," chosen for fewest trades.
export const DEFAULT_ETF_ROTATION_CONFIG: EtfRotationConfig = {
  universe: ["SPY", "QQQ", "EFA", "TLT", "GLD"],
  momentumLookbackDays: 126,
  trendFilterSmaPeriod: 200,
  holdCount: 2,
};

/**
 * Trailing return over lookbackDays, as a percent. Null (not 0) when there
 * isn't enough history - a momentum score of 0 would be indistinguishable
 * from "flat over the period," which is a real, meaningful value, not a
 * stand-in for "unknown."
 */
export function computeMomentumReturnPercent(
  pricesUpToDate: number[],
  lookbackDays: number,
): number | null {
  if (pricesUpToDate.length <= lookbackDays) {
    return null;
  }

  const current = pricesUpToDate[pricesUpToDate.length - 1]!;
  const past = pricesUpToDate[pricesUpToDate.length - 1 - lookbackDays]!;

  if (past <= 0) {
    return null;
  }

  return ((current - past) / past) * 100;
}

/**
 * True when the current price is above its trailing SMA. Fails closed
 * (false) when there isn't enough history to compute a real SMA -
 * calculateSMA (indicators.ts) returns 0 for insufficient data, and
 * "price > 0" would otherwise trivially and silently pass.
 */
export function passesTrendFilter(
  pricesUpToDate: number[],
  smaPeriod: number,
): boolean {
  if (pricesUpToDate.length < smaPeriod) {
    return false;
  }

  const currentPrice = pricesUpToDate[pricesUpToDate.length - 1]!;
  const sma = calculateSMA(pricesUpToDate, smaPeriod);

  return currentPrice > sma;
}

/**
 * True on the first day ever simulated (previousDateKey === null) or when
 * dateKey's calendar month differs from previousDateKey's - a monthly
 * rebalance cadence anchored to calendar-month boundaries rather than a
 * fixed trading-day counter, so it doesn't drift as holidays/weekends shift
 * the exact count of trading days per month.
 */
export function isMonthlyRebalanceDate(
  dateKey: string,
  previousDateKey: string | null,
): boolean {
  if (previousDateKey === null) {
    return true;
  }

  return dateKey.slice(0, 7) !== previousDateKey.slice(0, 7);
}

export interface RotationTarget {
  ticker: string;
  weightPercent: number;
}

/**
 * Ranks config.universe by trailing momentum (tickers with insufficient
 * history for a momentum score are excluded entirely, not treated as 0),
 * takes the top config.holdCount, keeps only the ones that also
 * passesTrendFilter. Each of the holdCount slots is worth a fixed
 * 100/holdCount% - a pick that fails the trend filter simply isn't
 * replaced and its slot's weight goes to cash, it is never redistributed
 * to the surviving picks (the caller treats "not in the returned array,
 * or 100% minus the returned weights" as cash). Returns [] (all cash) when
 * nothing qualifies.
 */
export function decideRotationTargets(
  priceHistoryByTicker: Map<string, number[]>,
  config: EtfRotationConfig,
): RotationTarget[] {
  const candidates = config.universe
    .map((ticker) => {
      const prices = priceHistoryByTicker.get(ticker) ?? [];
      const momentum = computeMomentumReturnPercent(
        prices,
        config.momentumLookbackDays,
      );

      return momentum === null ? null : { ticker, momentum, prices };
    })
    .filter((c): c is { ticker: string; momentum: number; prices: number[] } => c !== null)
    .sort((a, b) => b.momentum - a.momentum);

  const topPicks = candidates.slice(0, config.holdCount);
  const qualifying = topPicks.filter((pick) =>
    passesTrendFilter(pick.prices, config.trendFilterSmaPeriod),
  );

  // Each of the holdCount slots is worth a fixed 100/holdCount% - a slot
  // whose pick fails the trend filter is dropped, not redistributed to the
  // survivors. Redistributing would mean a surviving pick's weight grows
  // when a stablemate fails its trend filter, which is the opposite of
  // "get more defensive" - the freed weight must go to cash instead.
  const weightPercentPerSlot = 100 / config.holdCount;

  return qualifying.map((pick) => ({
    ticker: pick.ticker,
    weightPercent: weightPercentPerSlot,
  }));
}
