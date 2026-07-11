export interface RiskProfile {
  maxDailyDrawdownPercent: number;
  maxPositionSizePercent: number;
  allowMargin: boolean;
}

export interface OrderRequest {
  ticker: string;
  action: "BUY" | "SELL";
  requestedShares: number;
  estimatedPrice: number;
  /**
   * Set only for the fractional-fallback BUY case (see
   * strategyEngine.ts's allowFractionalShares) - a dollar amount to buy
   * via a notional order instead of a whole-share quantity. When set,
   * requestedShares is ignored for BUY sizing.
   */
  requestedNotional?: number;
}

export interface AccountState {
  equity: number;
  cash: number;
  dailyDrawdownPercent: number;
  currentPositions: { ticker: string; shares: number; marketValue: number }[];
}

export interface RiskResult {
  approved: boolean;
  adjustedShares: number;
  /** Set only when the approved BUY is a fractional/notional order. */
  adjustedNotional?: number;
  reason: string;
}

// STRICT DEFAULT SAFETY RULES
const DEFAULT_PROFILE: RiskProfile = {
  maxDailyDrawdownPercent: -0.05, // Halt ALL trading if daily loss hits 5%
  maxPositionSizePercent: 0.2, // Never put more than 20% of total equity into ONE single stock
  allowMargin: false, // STRICTLY block borrowing money from the broker
};

export function evaluateTrade(
  order: OrderRequest,
  account: AccountState,
  profile: RiskProfile = DEFAULT_PROFILE,
): RiskResult {
  // 1. SELL LOGIC: Always allow reducing exposure (if shares are owned),
  // checked before the kill switch below - the kill switch exists to stop
  // the bot from taking on MORE risk, not to trap it in a losing position
  // when cutting losses is exactly what's needed.
  if (order.action === "SELL") {
    const existingPosition = account.currentPositions.find(
      (p) => p.ticker === order.ticker,
    );
    const ownedShares = existingPosition ? existingPosition.shares : 0;

    if (ownedShares === 0) {
      return {
        approved: false,
        adjustedShares: 0,
        reason: `REJECTED: Cannot sell ${order.ticker}. No shares currently owned in portfolio.`,
      };
    }

    const safeSharesToSell = Math.min(order.requestedShares, ownedShares);
    return {
      approved: true,
      adjustedShares: safeSharesToSell,
      reason: `APPROVED: Sell order verified for ${safeSharesToSell} shares of ${order.ticker}.`,
    };
  }

  // 2. GLOBAL KILL SWITCH: Daily Drawdown Check (blocks new BUYs only)
  if (account.dailyDrawdownPercent <= profile.maxDailyDrawdownPercent) {
    return {
      approved: false,
      adjustedShares: 0,
      reason: `FATAL RISK: Daily drawdown (${(account.dailyDrawdownPercent * 100).toFixed(2)}%) has exceeded the safety limit of ${(profile.maxDailyDrawdownPercent * 100).toFixed(2)}%. New buys suspended.`,
    };
  }

  // 3. BUY LOGIC: Strict Position Sizing and Anti-Margin Guard
  if (order.action === "BUY") {
    const maxAllowedValueForTicker =
      account.equity * profile.maxPositionSizePercent;

    const existingPosition = account.currentPositions.find(
      (p) => p.ticker === order.ticker,
    );
    const currentPositionValue = existingPosition
      ? existingPosition.marketValue
      : 0;

    // How much MORE money can we put into this stock?
    const remainingAllowedValue =
      maxAllowedValueForTicker - currentPositionValue;

    if (remainingAllowedValue <= 0) {
      return {
        approved: false,
        adjustedShares: 0,
        reason: `REJECTED: Maximum portfolio allocation (20%) already reached for ${order.ticker}. Diversification required.`,
      };
    }

    // Determine safe cash usage (preventing margin debt)
    const availableCashToUse = profile.allowMargin
      ? remainingAllowedValue
      : Math.min(account.cash, remainingAllowedValue);

    if (order.requestedNotional !== undefined) {
      const safeNotionalToBuy = Number(
        Math.min(availableCashToUse, order.requestedNotional).toFixed(2),
      );

      if (safeNotionalToBuy <= 0) {
        return {
          approved: false,
          adjustedShares: 0,
          reason: `REJECTED: Insufficient safe capital to buy ${order.ticker}. Order exceeds cash limits or portfolio concentration rules.`,
        };
      }

      if (safeNotionalToBuy < order.requestedNotional) {
        return {
          approved: true,
          adjustedShares: 0,
          adjustedNotional: safeNotionalToBuy,
          reason: `MODIFIED: Buy order reduced from $${order.requestedNotional.toFixed(2)} to $${safeNotionalToBuy.toFixed(2)} to respect the 20% portfolio limit and prevent margin debt.`,
        };
      }

      return {
        approved: true,
        adjustedShares: 0,
        adjustedNotional: safeNotionalToBuy,
        reason: `APPROVED: Buy order for $${safeNotionalToBuy.toFixed(2)} of ${order.ticker} fits within all risk parameters.`,
      };
    }

    // Calculate how many shares we can ACTUALLY buy safely
    let safeSharesToBuy = Math.floor(availableCashToUse / order.estimatedPrice);

    // Cap at what the AI originally requested
    safeSharesToBuy = Math.min(safeSharesToBuy, order.requestedShares);

    if (safeSharesToBuy <= 0) {
      return {
        approved: false,
        adjustedShares: 0,
        reason: `REJECTED: Insufficient safe capital to buy ${order.ticker}. Order exceeds cash limits or portfolio concentration rules.`,
      };
    }

    if (safeSharesToBuy < order.requestedShares) {
      return {
        approved: true,
        adjustedShares: safeSharesToBuy,
        reason: `MODIFIED: Buy order reduced from ${order.requestedShares} to ${safeSharesToBuy} shares to respect the 20% portfolio limit and prevent margin debt.`,
      };
    }

    return {
      approved: true,
      adjustedShares: safeSharesToBuy,
      reason: `APPROVED: Buy order for ${safeSharesToBuy} shares fits within all risk parameters.`,
    };
  }

  return {
    approved: false,
    adjustedShares: 0,
    reason: "REJECTED: Unknown action type.",
  };
}
