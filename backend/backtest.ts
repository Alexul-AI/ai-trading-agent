import dotenv from "dotenv";

dotenv.config();

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface AlpacaBarsResponse {
  bars?: AlpacaBar[];
  next_page_token?: string | null;
}

interface BacktestConfig {
  tickers: string[];
  days: number;
  startingCapital: number;
  feed: string;
  maxBuyCashFraction: number;
  maxPositionEquityFraction: number;
  cooldownBars: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  slippagePercent: number;
  commissionPerTrade: number;
}

interface Trade {
  ticker: string;
  date: string;
  action: "BUY" | "SELL";
  shares: number;
  marketPrice: number;
  executionPrice: number;
  cashAfter: number;
  positionSharesAfter: number;
  portfolioValueAfter: number;
  realizedPnl?: number;
  reason: string;
}

interface EquityPoint {
  date: string;
  value: number;
  cash: number;
  shares: number;
  price: number;
}

interface BacktestResult {
  ticker: string;
  startingCapital: number;
  finalPrice: number;
  finalCash: number;
  finalShares: number;
  finalPortfolioValue: number;
  pnl: number;
  pnlPercent: number;
  buyAndHoldValue: number;
  buyAndHoldPnl: number;
  buyAndHoldPnlPercent: number;
  maxDrawdownPercent: number;
  exposurePercent: number;
  trades: Trade[];
  closedTrades: Trade[];
  winRatePercent: number;
  averageClosedTradePnl: number;
  bestTradePnl: number;
  worstTradePnl: number;
  totalEstimatedSlippageCost: number;
}

const config: BacktestConfig = {
  tickers: (process.env.BACKTEST_TICKERS || process.env.BACKTEST_TICKER || "TSLA")
    .split(",")
    .map((ticker) => ticker.trim().toUpperCase())
    .filter(Boolean),
  days: Number.parseInt(process.env.BACKTEST_DAYS || "180", 10),
  startingCapital: Number.parseFloat(
    process.env.BACKTEST_STARTING_CAPITAL || "10000",
  ),
  feed: process.env.ALPACA_DATA_FEED || "iex",
  maxBuyCashFraction: Number.parseFloat(
    process.env.BACKTEST_MAX_BUY_CASH_FRACTION || "0.20",
  ),
  maxPositionEquityFraction: Number.parseFloat(
    process.env.BACKTEST_MAX_POSITION_EQUITY_FRACTION || "0.20",
  ),
  cooldownBars: Number.parseInt(process.env.BACKTEST_COOLDOWN_BARS || "3", 10),
  stopLossPercent: Number.parseFloat(
    process.env.BACKTEST_STOP_LOSS_PERCENT || "0.08",
  ),
  takeProfitPercent: Number.parseFloat(
    process.env.BACKTEST_TAKE_PROFIT_PERCENT || "0.15",
  ),
  slippagePercent: Number.parseFloat(
    process.env.BACKTEST_SLIPPAGE_PERCENT || "0.0005",
  ),
  commissionPerTrade: Number.parseFloat(
    process.env.BACKTEST_COMMISSION_PER_TRADE || "0",
  ),
};

const APCA_API_KEY_ID = process.env.APCA_API_KEY_ID;
const APCA_API_SECRET_KEY = process.env.APCA_API_SECRET_KEY;

if (!APCA_API_KEY_ID || !APCA_API_SECRET_KEY) {
  console.error("Missing APCA_API_KEY_ID or APCA_API_SECRET_KEY in backend/.env");
  process.exit(1);
}

function toIsoDate(date: Date): string {
  return date.toISOString().split("T")[0] ?? date.toISOString();
}

function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function calculateRSI(prices: number[], periods = 14): number {
  if (prices.length <= periods) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= periods; i += 1) {
    const diff = (prices[i] ?? 0) - (prices[i - 1] ?? 0);
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / periods;
  let avgLoss = losses / periods;

  for (let i = periods + 1; i < prices.length; i += 1) {
    const diff = (prices[i] ?? 0) - (prices[i - 1] ?? 0);

    avgGain = (avgGain * (periods - 1) + (diff > 0 ? diff : 0)) / periods;
    avgLoss = (avgLoss * (periods - 1) + (diff < 0 ? -diff : 0)) / periods;
  }

  if (avgLoss === 0) return 100;

  return Number((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
}

function calculateEMA(prices: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [];

  if (prices.length === 0) return ema;

  ema.push(prices[0] ?? 0);

  for (let i = 1; i < prices.length; i += 1) {
    ema.push((prices[i] ?? 0) * k + (ema[i - 1] ?? 0) * (1 - k));
  }

  return ema;
}

function calculateMACD(prices: number[]) {
  if (prices.length < 26) return { macd: 0, signal: 0, histogram: 0 };

  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  const macdLine = prices.map((_, i) => (ema12[i] ?? 0) - (ema26[i] ?? 0));
  const signalLine = calculateEMA(macdLine.slice(25), 9);

  const currentMacd = macdLine[macdLine.length - 1] ?? 0;
  const currentSignal = signalLine[signalLine.length - 1] ?? 0;

  return {
    macd: Number(currentMacd.toFixed(4)),
    signal: Number(currentSignal.toFixed(4)),
    histogram: Number((currentMacd - currentSignal).toFixed(4)),
  };
}

function calculateBollingerBands(
  prices: number[],
  period = 20,
  multiplier = 2,
) {
  if (prices.length < period) return { upper: 0, lower: 0, sma: 0 };

  const slice = prices.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  return {
    sma: Number(sma.toFixed(2)),
    upper: Number((sma + stdDev * multiplier).toFixed(2)),
    lower: Number((sma - stdDev * multiplier).toFixed(2)),
  };
}

async function fetchAlpacaBars(
  ticker: string,
  days: number,
  feed: string,
): Promise<AlpacaBar[]> {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - days);

  const allBars: AlpacaBar[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`https://data.alpaca.markets/v2/stocks/${ticker}/bars`);

    url.searchParams.set("timeframe", "1Day");
    url.searchParams.set("start", toIsoDate(startDate));
    url.searchParams.set("end", toIsoDate(endDate));
    url.searchParams.set("adjustment", "raw");
    url.searchParams.set("feed", feed);
    url.searchParams.set("limit", "1000");

    if (pageToken) {
      url.searchParams.set("page_token", pageToken);
    }

    const response = await fetch(url.toString(), {
      headers: {
        "APCA-API-KEY-ID": APCA_API_KEY_ID!,
        "APCA-API-SECRET-KEY": APCA_API_SECRET_KEY!,
      },
    });

    if (!response.ok) {
      const body = await response.text();

      throw new Error(
        `Alpaca bars request failed for ${ticker}: HTTP ${response.status} ${body}`,
      );
    }

    const data = (await response.json()) as AlpacaBarsResponse;

    if (data.bars) {
      allBars.push(...data.bars);
    }

    pageToken = data.next_page_token || undefined;
  } while (pageToken);

  return allBars.sort(
    (a, b) => new Date(a.t).getTime() - new Date(b.t).getTime(),
  );
}

function calculateMaxDrawdownPercent(equityCurve: EquityPoint[]): number {
  let peak = 0;
  let maxDrawdown = 0;

  for (const point of equityCurve) {
    if (point.value > peak) {
      peak = point.value;
    }

    if (peak > 0) {
      const drawdown = (point.value - peak) / peak;
      if (drawdown < maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }
  }

  return maxDrawdown * 100;
}

function decideTrade(input: {
  price: number;
  rsi: number;
  macdHistogram: number;
  previousMacdHistogram: number;
  bbLower: number;
  bbUpper: number;
  sharesOwned: number;
  averageEntryPrice: number;
  maxSharesToBuy: number;
  barsSinceLastBuy: number;
  stopLossPercent: number;
  takeProfitPercent: number;
}) {
  const {
    price,
    rsi,
    macdHistogram,
    previousMacdHistogram,
    bbLower,
    bbUpper,
    sharesOwned,
    averageEntryPrice,
    maxSharesToBuy,
    barsSinceLastBuy,
    stopLossPercent,
    takeProfitPercent,
  } = input;

  const macdRising = macdHistogram > previousMacdHistogram;
  const nearLowerBand = bbLower > 0 && price <= bbLower * 1.01;
  const nearUpperBand = bbUpper > 0 && price >= bbUpper * 0.99;

  if (sharesOwned > 0 && averageEntryPrice > 0) {
    const positionReturn = (price - averageEntryPrice) / averageEntryPrice;

    if (positionReturn <= -stopLossPercent) {
      return {
        action: "SELL" as const,
        shares: sharesOwned,
        reason: `Stop-loss triggered: positionReturn=${formatPercent(positionReturn * 100)}`,
      };
    }

    if (positionReturn >= takeProfitPercent) {
      return {
        action: "SELL" as const,
        shares: sharesOwned,
        reason: `Take-profit triggered: positionReturn=${formatPercent(positionReturn * 100)}`,
      };
    }
  }

  if (sharesOwned > 0 && (rsi > 65 || nearUpperBand || (rsi > 55 && !macdRising))) {
    return {
      action: "SELL" as const,
      shares: sharesOwned,
      reason: `Sell signal: RSI=${rsi}, nearUpperBand=${nearUpperBand}, macdRising=${macdRising}`,
    };
  }

  if (
    maxSharesToBuy > 0 &&
    barsSinceLastBuy >= config.cooldownBars &&
    (rsi < 38 || nearLowerBand || (rsi < 46 && macdRising))
  ) {
    return {
      action: "BUY" as const,
      shares: maxSharesToBuy,
      reason: `Buy signal: RSI=${rsi}, nearLowerBand=${nearLowerBand}, macdRising=${macdRising}`,
    };
  }

  return {
    action: "HOLD" as const,
    shares: 0,
    reason: `No clear signal: RSI=${rsi}, nearLowerBand=${nearLowerBand}, nearUpperBand=${nearUpperBand}, macdRising=${macdRising}`,
  };
}

function calculateTradeStats(closedTrades: Trade[]) {
  const pnlValues = closedTrades
    .map((trade) => trade.realizedPnl)
    .filter((value): value is number => typeof value === "number");

  const wins = pnlValues.filter((pnl) => pnl > 0).length;
  const winRatePercent = pnlValues.length > 0 ? (wins / pnlValues.length) * 100 : 0;
  const averageClosedTradePnl =
    pnlValues.length > 0
      ? pnlValues.reduce((sum, pnl) => sum + pnl, 0) / pnlValues.length
      : 0;

  return {
    winRatePercent,
    averageClosedTradePnl,
    bestTradePnl: pnlValues.length > 0 ? Math.max(...pnlValues) : 0,
    worstTradePnl: pnlValues.length > 0 ? Math.min(...pnlValues) : 0,
  };
}

async function runBacktestForTicker(ticker: string): Promise<BacktestResult> {
  console.log("");
  console.log("=========================================");
  console.log(`BACKTEST ${ticker} — Alpaca only`);
  console.log("=========================================");
  console.log(`Days: ${config.days}`);
  console.log(`Feed: ${config.feed}`);
  console.log(`Starting Capital: ${formatMoney(config.startingCapital)}`);
  console.log(`Max position: ${(config.maxPositionEquityFraction * 100).toFixed(0)}% equity`);
  console.log(`Cooldown: ${config.cooldownBars} bars`);
  console.log(`Stop-loss: ${(config.stopLossPercent * 100).toFixed(0)}%`);
  console.log(`Take-profit: ${(config.takeProfitPercent * 100).toFixed(0)}%`);
  console.log(`Slippage: ${(config.slippagePercent * 100).toFixed(3)}%`);
  console.log("");

  const bars = await fetchAlpacaBars(ticker, config.days, config.feed);

  if (bars.length < 35) {
    throw new Error(
      `Not enough bars for ${ticker}. Received ${bars.length}; need at least 35.`,
    );
  }

  let cash = config.startingCapital;
  let sharesOwned = 0;
  let averageEntryPrice = 0;
  let lastBuyIndex = -999;
  let totalEstimatedSlippageCost = 0;

  const trades: Trade[] = [];
  const closedTrades: Trade[] = [];
  const equityCurve: EquityPoint[] = [];

  const firstPrice = bars[0]?.c ?? 0;
  const buyAndHoldShares = firstPrice > 0
    ? Math.floor(config.startingCapital / firstPrice)
    : 0;
  const buyAndHoldCash = config.startingCapital - buyAndHoldShares * firstPrice;

  for (let i = 30; i < bars.length; i += 1) {
    const currentBar = bars[i];
    if (!currentBar) continue;

    const currentPrice = Number(currentBar.c.toFixed(2));
    const dateStr = currentBar.t.split("T")[0] ?? currentBar.t;

    const prices = bars.slice(0, i + 1).map((bar) => bar.c);
    const previousPrices = bars.slice(0, i).map((bar) => bar.c);

    const rsi = calculateRSI(prices, 14);
    const macd = calculateMACD(prices);
    const previousMacd = calculateMACD(previousPrices);
    const bb = calculateBollingerBands(prices, 20, 2);

    const portfolioValueBeforeDecision = cash + sharesOwned * currentPrice;
    const currentPositionValue = sharesOwned * currentPrice;
    const remainingPositionCapacity = Math.max(
      0,
      portfolioValueBeforeDecision * config.maxPositionEquityFraction -
        currentPositionValue,
    );

    const cashAllowedForBuy = Math.min(
      cash * config.maxBuyCashFraction,
      remainingPositionCapacity,
    );

    const maxSharesToBuy = Math.floor(cashAllowedForBuy / currentPrice);
    const barsSinceLastBuy = i - lastBuyIndex;

    const decision = decideTrade({
      price: currentPrice,
      rsi,
      macdHistogram: macd.histogram,
      previousMacdHistogram: previousMacd.histogram,
      bbLower: bb.lower,
      bbUpper: bb.upper,
      sharesOwned,
      averageEntryPrice,
      maxSharesToBuy,
      barsSinceLastBuy,
      stopLossPercent: config.stopLossPercent,
      takeProfitPercent: config.takeProfitPercent,
    });

    if (decision.action === "BUY" && decision.shares > 0) {
      const executionPrice = Number(
        (currentPrice * (1 + config.slippagePercent)).toFixed(4),
      );
      const slippageCost = (executionPrice - currentPrice) * decision.shares;
      const cost = executionPrice * decision.shares + config.commissionPerTrade;

      if (cash >= cost) {
        const previousPositionCost = averageEntryPrice * sharesOwned;

        cash -= cost;
        sharesOwned += decision.shares;
        averageEntryPrice =
          sharesOwned > 0
            ? (previousPositionCost + executionPrice * decision.shares) /
              sharesOwned
            : 0;

        lastBuyIndex = i;
        totalEstimatedSlippageCost += slippageCost;

        const portfolioValueAfter = cash + sharesOwned * currentPrice;

        trades.push({
          ticker,
          date: dateStr,
          action: "BUY",
          shares: decision.shares,
          marketPrice: currentPrice,
          executionPrice,
          cashAfter: cash,
          positionSharesAfter: sharesOwned,
          portfolioValueAfter,
          reason: decision.reason,
        });

        console.log(
          `${dateStr} | BUY ${decision.shares} @ ${formatMoney(executionPrice)} | cash=${formatMoney(cash)} | ${decision.reason}`,
        );
      }
    } else if (decision.action === "SELL" && decision.shares > 0) {
      const sharesToSell = Math.min(decision.shares, sharesOwned);
      const executionPrice = Number(
        (currentPrice * (1 - config.slippagePercent)).toFixed(4),
      );
      const slippageCost = (currentPrice - executionPrice) * sharesToSell;
      const revenue = executionPrice * sharesToSell - config.commissionPerTrade;

      if (sharesToSell > 0) {
        const realizedPnl =
          (executionPrice - averageEntryPrice) * sharesToSell -
          config.commissionPerTrade;

        cash += revenue;
        sharesOwned -= sharesToSell;

        if (sharesOwned === 0) {
          averageEntryPrice = 0;
        }

        totalEstimatedSlippageCost += slippageCost;

        const portfolioValueAfter = cash + sharesOwned * currentPrice;

        const trade: Trade = {
          ticker,
          date: dateStr,
          action: "SELL",
          shares: sharesToSell,
          marketPrice: currentPrice,
          executionPrice,
          cashAfter: cash,
          positionSharesAfter: sharesOwned,
          portfolioValueAfter,
          realizedPnl,
          reason: decision.reason,
        };

        trades.push(trade);
        closedTrades.push(trade);

        console.log(
          `${dateStr} | SELL ${sharesToSell} @ ${formatMoney(executionPrice)} | realized=${formatMoney(realizedPnl)} | cash=${formatMoney(cash)} | ${decision.reason}`,
        );
      }
    }

    equityCurve.push({
      date: dateStr,
      value: cash + sharesOwned * currentPrice,
      cash,
      shares: sharesOwned,
      price: currentPrice,
    });
  }

  const finalPrice = bars[bars.length - 1]?.c ?? 0;
  const finalPortfolioValue = cash + sharesOwned * finalPrice;
  const pnl = finalPortfolioValue - config.startingCapital;
  const pnlPercent = (pnl / config.startingCapital) * 100;

  const buyAndHoldValue = buyAndHoldCash + buyAndHoldShares * finalPrice;
  const buyAndHoldPnl = buyAndHoldValue - config.startingCapital;
  const buyAndHoldPnlPercent = (buyAndHoldPnl / config.startingCapital) * 100;

  const maxDrawdownPercent = calculateMaxDrawdownPercent(equityCurve);

  const exposureBars = equityCurve.filter((point) => point.shares > 0).length;
  const exposurePercent =
    equityCurve.length > 0 ? (exposureBars / equityCurve.length) * 100 : 0;

  const tradeStats = calculateTradeStats(closedTrades);

  return {
    ticker,
    startingCapital: config.startingCapital,
    finalPrice,
    finalCash: cash,
    finalShares: sharesOwned,
    finalPortfolioValue,
    pnl,
    pnlPercent,
    buyAndHoldValue,
    buyAndHoldPnl,
    buyAndHoldPnlPercent,
    maxDrawdownPercent,
    exposurePercent,
    trades,
    closedTrades,
    winRatePercent: tradeStats.winRatePercent,
    averageClosedTradePnl: tradeStats.averageClosedTradePnl,
    bestTradePnl: tradeStats.bestTradePnl,
    worstTradePnl: tradeStats.worstTradePnl,
    totalEstimatedSlippageCost,
  };
}

function printResult(result: BacktestResult) {
  console.log("");
  console.log("=========================================");
  console.log(`FINAL BACKTEST RESULTS (${result.ticker})`);
  console.log("=========================================");
  console.log(`Final price: ${formatMoney(result.finalPrice)}`);
  console.log(`Remaining cash: ${formatMoney(result.finalCash)}`);
  console.log(`Shares owned: ${result.finalShares}`);
  console.log(`Final portfolio value: ${formatMoney(result.finalPortfolioValue)}`);
  console.log(
    `Strategy PnL: ${formatMoney(result.pnl)} (${formatPercent(result.pnlPercent)})`,
  );
  console.log(
    `Buy & Hold PnL: ${formatMoney(result.buyAndHoldPnl)} (${formatPercent(
      result.buyAndHoldPnlPercent,
    )})`,
  );
  console.log(`Max drawdown: ${formatPercent(result.maxDrawdownPercent)}`);
  console.log(`Exposure: ${result.exposurePercent.toFixed(2)}%`);
  console.log(`Trades executed: ${result.trades.length}`);
  console.log(`Closed trades: ${result.closedTrades.length}`);
  console.log(`Win rate: ${result.winRatePercent.toFixed(2)}%`);
  console.log(`Average closed trade PnL: ${formatMoney(result.averageClosedTradePnl)}`);
  console.log(`Best trade PnL: ${formatMoney(result.bestTradePnl)}`);
  console.log(`Worst trade PnL: ${formatMoney(result.worstTradePnl)}`);
  console.log(
    `Estimated slippage cost: ${formatMoney(result.totalEstimatedSlippageCost)}`,
  );
  console.log("=========================================");

  if (result.trades.length > 0) {
    console.log("");
    console.log("Trades:");
    for (const trade of result.trades) {
      const realized =
        typeof trade.realizedPnl === "number"
          ? ` | realized=${formatMoney(trade.realizedPnl)}`
          : "";

      console.log(
        `${trade.date} | ${trade.action} ${trade.shares} @ ${formatMoney(
          trade.executionPrice,
        )}${realized} | cash=${formatMoney(trade.cashAfter)} | shares=${
          trade.positionSharesAfter
        } | ${trade.reason}`,
      );
    }
  }
}

async function main() {
  console.log("");
  console.log("=========================================");
  console.log("AI Trading Agent Backtest v2 — Alpaca only");
  console.log("=========================================");
  console.log(`Tickers: ${config.tickers.join(", ")}`);
  console.log(`Days: ${config.days}`);
  console.log(`Feed: ${config.feed}`);
  console.log("");

  const results: BacktestResult[] = [];

  for (const ticker of config.tickers) {
    const result = await runBacktestForTicker(ticker);
    results.push(result);
    printResult(result);
  }

  if (results.length > 1) {
    console.log("");
    console.log("=========================================");
    console.log("MULTI-TICKER SUMMARY");
    console.log("=========================================");

    for (const result of results) {
      console.log(
        `${result.ticker} | Strategy ${formatPercent(
          result.pnlPercent,
        )} | Buy&Hold ${formatPercent(
          result.buyAndHoldPnlPercent,
        )} | MaxDD ${formatPercent(result.maxDrawdownPercent)} | Trades ${
          result.trades.length
        }`,
      );
    }

    console.log("=========================================");
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown backtest error";
  console.error(`Backtest failed: ${message}`);
  process.exit(1);
});
