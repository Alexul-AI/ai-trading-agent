import type { StrategyDecision } from "../../strategyEngine.js";

export interface PortfolioPositionSnapshot {
  shares: number;
  avgPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
}

export interface PortfolioSnapshot {
  balance: number;
  equity: number;
  currency: string;
  positions: Record<string, PortfolioPositionSnapshot>;
}

export const AUTOPILOT_MAX_SELL_FRACTION = Number.parseFloat(
  process.env.AUTOPILOT_MAX_SELL_FRACTION || "0.25",
);

export function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0.25;
  return Math.max(0.01, Math.min(1, value));
}

export function getSafeSellShares(
  reasonType: StrategyDecision["reasonType"],
  suggestedShares: number,
  sharesOwned: number,
): { shares: number; safetyNote?: string } {
  if (suggestedShares <= 0 || sharesOwned <= 0) {
    return { shares: 0 };
  }

  if (reasonType === "STOP_LOSS") {
    return {
      shares: Math.min(suggestedShares, sharesOwned),
      safetyNote: "STOP_LOSS can sell the full position.",
    };
  }

  const maxFraction = clampFraction(AUTOPILOT_MAX_SELL_FRACTION);
  // Math.max(1, ...) assumes a whole-share position: it forces a minimum
  // sell of 1 full share, which is correct when sharesOwned >= 1 but wrong
  // for a fractional position (e.g. sharesOwned=0.35 would force a
  // "minimum" sell larger than the entire position). Below 1 share, use
  // the fraction directly instead of flooring/forcing a whole-share floor.
  const cappedShares =
    sharesOwned >= 1
      ? Math.max(1, Math.floor(sharesOwned * maxFraction))
      : sharesOwned * maxFraction;
  const safeShares = Math.min(suggestedShares, cappedShares, sharesOwned);

  if (safeShares < suggestedShares) {
    return {
      shares: safeShares,
      safetyNote: `Safety cap: reduced SELL from ${suggestedShares} to ${safeShares} shares (${Math.round(
        maxFraction * 100,
      )}% max sell fraction).`,
    };
  }

  return { shares: safeShares };
}

// Reduce-don't-just-reject, same shape as getSafeSellShares above - the
// existing 20% single-ticker cap (maxPositionEquityFraction in
// strategyEngine.ts) doesn't stop AMD+NVDA+TSLA each sitting at 20%
// simultaneously (60% in one correlated bucket). This is a portfolio
// construction safety rule, not a return hypothesis - always on, no opt-in
// flag, same as the circuit breaker.
export function getRemainingBucketCapacity(
  ticker: string,
  portfolio: PortfolioSnapshot,
  tickerToBucket: Record<string, string>,
  defaultMaxBucketEquityFraction: number,
  bucketEquityFractionOverrides: Record<string, number>,
): {
  bucketId: string | undefined;
  bucketExposure: number;
  bucketCapValue: number;
  remainingBucketCapacity: number;
} {
  const bucketId = tickerToBucket[ticker.toUpperCase()];
  if (!bucketId) {
    return {
      bucketId: undefined,
      bucketExposure: 0,
      bucketCapValue: 0,
      remainingBucketCapacity: Infinity,
    };
  }

  let bucketExposure = 0;
  for (const [positionTicker, position] of Object.entries(
    portfolio.positions,
  )) {
    if (tickerToBucket[positionTicker.toUpperCase()] === bucketId) {
      bucketExposure += position.shares * position.currentPrice;
    }
  }

  const maxBucketEquityFraction =
    bucketEquityFractionOverrides[bucketId] ?? defaultMaxBucketEquityFraction;
  const bucketCapValue = portfolio.equity * maxBucketEquityFraction;
  const remainingBucketCapacity = Math.max(0, bucketCapValue - bucketExposure);

  return { bucketId, bucketExposure, bucketCapValue, remainingBucketCapacity };
}

export function getSafeBuySharesForBucketCap(
  ticker: string,
  requestedShares: number,
  price: number,
  portfolio: PortfolioSnapshot,
  tickerToBucket: Record<string, string>,
  defaultMaxBucketEquityFraction: number,
  bucketEquityFractionOverrides: Record<string, number> = {},
): { shares: number; safetyNote?: string } {
  if (requestedShares <= 0 || price <= 0) {
    return { shares: Math.max(0, requestedShares) };
  }

  const { bucketId, bucketExposure, bucketCapValue, remainingBucketCapacity } =
    getRemainingBucketCapacity(
      ticker,
      portfolio,
      tickerToBucket,
      defaultMaxBucketEquityFraction,
      bucketEquityFractionOverrides,
    );

  if (!bucketId) {
    return { shares: requestedShares };
  }

  const maxSharesForBucket = Math.floor(remainingBucketCapacity / price);
  const safeShares = Math.min(requestedShares, Math.max(0, maxSharesForBucket));

  if (safeShares < requestedShares) {
    return {
      shares: safeShares,
      safetyNote: `Bucket cap: reduced BUY from ${requestedShares} to ${safeShares} shares (${bucketId} bucket at ${bucketExposure.toFixed(
        2,
      )} of ${bucketCapValue.toFixed(2)} cap).`,
    };
  }

  return { shares: safeShares };
}

// Notional counterpart for the fractional-fallback BUY path (see
// strategyEngine.ts's allowFractionalShares) - same bucket-capacity rule
// as getSafeBuySharesForBucketCap above, but capping a dollar amount
// directly instead of a share count, so there's no price-division/floor
// step to lose precision on.
export function getSafeBuyNotionalForBucketCap(
  ticker: string,
  requestedNotional: number,
  portfolio: PortfolioSnapshot,
  tickerToBucket: Record<string, string>,
  defaultMaxBucketEquityFraction: number,
  bucketEquityFractionOverrides: Record<string, number> = {},
): { notional: number; safetyNote?: string } {
  if (requestedNotional <= 0) {
    return { notional: Math.max(0, requestedNotional) };
  }

  const { bucketId, bucketExposure, bucketCapValue, remainingBucketCapacity } =
    getRemainingBucketCapacity(
      ticker,
      portfolio,
      tickerToBucket,
      defaultMaxBucketEquityFraction,
      bucketEquityFractionOverrides,
    );

  if (!bucketId) {
    return { notional: requestedNotional };
  }

  const safeNotional = Number(
    Math.min(requestedNotional, Math.max(0, remainingBucketCapacity)).toFixed(
      2,
    ),
  );

  if (safeNotional < requestedNotional) {
    return {
      notional: safeNotional,
      safetyNote: `Bucket cap: reduced BUY from $${requestedNotional.toFixed(2)} to $${safeNotional.toFixed(2)} (${bucketId} bucket at ${bucketExposure.toFixed(
        2,
      )} of ${bucketCapValue.toFixed(2)} cap).`,
    };
  }

  return { notional: safeNotional };
}
