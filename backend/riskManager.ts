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
  // 1. GLOBAL KILL SWITCH: Daily Drawdown Check
  if (account.dailyDrawdownPercent <= profile.maxDailyDrawdownPercent) {
    return {
      approved: false,
      adjustedShares: 0,
      reason: `FATAL RISK: Daily drawdown (${(account.dailyDrawdownPercent * 100).toFixed(2)}%) has exceeded the safety limit of ${(profile.maxDailyDrawdownPercent * 100).toFixed(2)}%. Trading suspended.`,
    };
  }

  // 2. SELL LOGIC: Always allow reducing exposure (if shares are owned)
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
