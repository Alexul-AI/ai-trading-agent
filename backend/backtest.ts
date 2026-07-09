import dotenv from "dotenv";

import {
  calculateBollingerBands,
  calculateMACD,
  calculateRSI,
} from "./indicators.js";
import {
  DEFAULT_STRATEGY_CONFIG,
  decideTradeSignal,
  type StrategyConfig,
} from "./strategyEngine.js";

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
  strategy: StrategyConfig;
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
  averageEntryPrice: number;
  finalPortfolioValue: number;
  realizedPnl: number;
  openUnrealizedPnl: number;
  totalPnl: number;
  totalPnlPercent: number;
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

const APCA_API_KEY_ID = process.env.APCA_API_KEY_ID ?? "";
const APCA_API_SECRET_KEY = process.env.APCA_API_SECRET_KEY ?? "";

if (!APCA_API_KEY_ID || !APCA_API_SECRET_KEY) {
  console.error(
    "Missing APCA_API_KEY_ID or APCA_API_SECRET_KEY in backend/.env",
  );
  process.exit(1);
}

const config: BacktestConfig = {
  tickers: (
    process.env.BACKTEST_TICKERS ||
    process.env.BACKTEST_TICKER ||
    "TSLA"
  )
    .split(",")
    .map((ticker) => ticker.trim().toUpperCase())
    .filter(Boolean),
  days: Number.parseInt(process.env.BACKTEST_DAYS || "180", 10),
  startingCapital: Number.parseFloat(
    process.env.BACKTEST_STARTING_CAPITAL || "10000",
  ),
  feed: process.env.ALPACA_DATA_FEED || "iex",
  strategy: {
    ...DEFAULT_STRATEGY_CONFIG,
    maxBuyCashFraction: Number.parseFloat(
      process.env.BACKTEST_MAX_BUY_CASH_FRACTION ||
        String(DEFAULT_STRATEGY_CONFIG.maxBuyCashFraction),
    ),
    maxPositionEquityFraction: Number.parseFloat(
      process.env.BACKTEST_MAX_POSITION_EQUITY_FRACTION ||
        String(DEFAULT_STRATEGY_CONFIG.maxPositionEquityFraction),
    ),
    cooldownBars: Number.parseInt(
      process.env.BACKTEST_COOLDOWN_BARS ||
        String(DEFAULT_STRATEGY_CONFIG.cooldownBars),
      10,
    ),
    stopLossPercent: Number.parseFloat(
      process.env.BACKTEST_STOP_LOSS_PERCENT ||
        String(DEFAULT_STRATEGY_CONFIG.stopLossPercent),
    ),
    takeProfitPercent: Number.parseFloat(
      process.env.BACKTEST_TAKE_PROFIT_PERCENT ||
        String(DEFAULT_STRATEGY_CONFIG.takeProfitPercent),
    ),
  },
  slippagePercent: Number.parseFloat(
    process.env.BACKTEST_SLIPPAGE_PERCENT || "0.0005",
  ),
  commissionPerTrade: Number.parseFloat(
    process.env.BACKTEST_COMMISSION_PER_TRADE || "0",
  ),
};

function toIsoDate(date: Date): string {
  return date.toISOString().split("T")[0] ?? date.toISOString();
}

function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
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
        "APCA-API-KEY-ID": APCA_API_KEY_ID,
        "APCA-API-SECRET-KEY": APCA_API_SECRET_KEY,
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

function calculateTradeStats(closedTrades: Trade[]) {
  const pnlValues = closedTrades
    .map((trade) => trade.realizedPnl)
    .filter((value): value is number => typeof value === "number");

  const wins = pnlValues.filter((pnl) => pnl > 0).length;
  const winRatePercent =
    pnlValues.length > 0 ? (wins / pnlValues.length) * 100 : 0;
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
  console.log(`BACKTEST ${ticker} — Alpaca + shared strategyEngine`);
  console.log("=========================================");
  console.log(`Days: ${config.days}`);
  console.log(`Feed: ${config.feed}`);
  console.log(`Starting Capital: ${formatMoney(config.startingCapital)}`);
  console.log(
    `Max position: ${(config.strategy.maxPositionEquityFraction * 100).toFixed(0)}% equity`,
  );
  console.log(`Cooldown: ${config.strategy.cooldownBars} bars`);
  console.log(
    `Stop-loss: ${(config.strategy.stopLossPercent * 100).toFixed(0)}%`,
  );
  console.log(
    `Take-profit: ${(config.strategy.takeProfitPercent * 100).toFixed(0)}%`,
  );
  console.log(`Slippage: ${(config.slippagePercent * 100).toFixed(3)}%`);
  console.log("");

  const bars = await fetchAlpacaBars(ticker, config.days, config.feed);

  // RSI (Wilder smoothing) and MACD (EMA) are seeded from bars[0] and only
  // converge to accurate values after ~100+ bars of recursive smoothing.
  // Starting the simulation too early trades on distorted indicator values
  // and makes results depend on how much history was fetched, not just the
  // strategy itself.
  const WARMUP_BARS = 150;

  if (bars.length < WARMUP_BARS + 5) {
    throw new Error(
      `Not enough bars for ${ticker}. Received ${bars.length}; need at least ${WARMUP_BARS + 5} for indicators to warm up.`,
    );
  }

  let cash = config.startingCapital;
  let sharesOwned = 0;
  let averageEntryPrice = 0;
  let lastBuyIndex = -999;
  let realizedPnlTotal = 0;
  let totalEstimatedSlippageCost = 0;

  const trades: Trade[] = [];
  const closedTrades: Trade[] = [];
  const equityCurve: EquityPoint[] = [];

  const firstPrice = bars[0]?.c ?? 0;
  const buyAndHoldShares =
    firstPrice > 0 ? Math.floor(config.startingCapital / firstPrice) : 0;
  const buyAndHoldCash = config.startingCapital - buyAndHoldShares * firstPrice;

  for (let i = WARMUP_BARS; i < bars.length; i += 1) {
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
    const barsSinceLastBuy = i - lastBuyIndex;

    const decision = decideTradeSignal({
      ticker,
      price: currentPrice,
      cash,
      portfolioValue: portfolioValueBeforeDecision,
      sharesOwned,
      averageEntryPrice,
      rsi,
      macdHistogram: macd.histogram,
      previousMacdHistogram: previousMacd.histogram,
      bollingerLower: bb.lower,
      bollingerUpper: bb.upper,
      barsSinceLastBuy,
      config: config.strategy,
    });

    if (decision.action === "BUY" && decision.suggestedShares > 0) {
      const executionPrice = Number(
        (currentPrice * (1 + config.slippagePercent)).toFixed(4),
      );
      const slippageCost =
        (executionPrice - currentPrice) * decision.suggestedShares;
      const cost =
        executionPrice * decision.suggestedShares + config.commissionPerTrade;

      if (cash >= cost) {
        const previousPositionCost = averageEntryPrice * sharesOwned;

        cash -= cost;
        sharesOwned += decision.suggestedShares;
        averageEntryPrice =
          sharesOwned > 0
            ? (previousPositionCost +
                executionPrice * decision.suggestedShares) /
              sharesOwned
            : 0;

        lastBuyIndex = i;
        totalEstimatedSlippageCost += slippageCost;

        const portfolioValueAfter = cash + sharesOwned * currentPrice;

        trades.push({
          ticker,
          date: dateStr,
          action: "BUY",
          shares: decision.suggestedShares,
          marketPrice: currentPrice,
          executionPrice,
          cashAfter: cash,
          positionSharesAfter: sharesOwned,
          portfolioValueAfter,
          reason: decision.reason,
        });

        console.log(
          `${dateStr} | BUY ${decision.suggestedShares} @ ${formatMoney(
            executionPrice,
          )} | confidence=${decision.confidence} | cash=${formatMoney(
            cash,
          )} | ${decision.reason}`,
        );
      }
    } else if (decision.action === "SELL" && decision.suggestedShares > 0) {
      const sharesToSell = Math.min(decision.suggestedShares, sharesOwned);
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
        realizedPnlTotal += realizedPnl;

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
          `${dateStr} | SELL ${sharesToSell} @ ${formatMoney(
            executionPrice,
          )} | confidence=${decision.confidence} | realized=${formatMoney(
            realizedPnl,
          )} | cash=${formatMoney(cash)} | ${decision.reason}`,
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
  const totalPnl = finalPortfolioValue - config.startingCapital;
  const totalPnlPercent = (totalPnl / config.startingCapital) * 100;
  const openUnrealizedPnl =
    sharesOwned > 0 ? (finalPrice - averageEntryPrice) * sharesOwned : 0;

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
    averageEntryPrice,
    finalPortfolioValue,
    realizedPnl: realizedPnlTotal,
    openUnrealizedPnl,
    totalPnl,
    totalPnlPercent,
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
  console.log(`Average entry price: ${formatMoney(result.averageEntryPrice)}`);
  console.log(
    `Final portfolio value: ${formatMoney(result.finalPortfolioValue)}`,
  );
  console.log(`Realized PnL: ${formatMoney(result.realizedPnl)}`);
  console.log(`Open unrealized PnL: ${formatMoney(result.openUnrealizedPnl)}`);
  console.log(
    `Total Strategy PnL: ${formatMoney(result.totalPnl)} (${formatPercent(
      result.totalPnlPercent,
    )})`,
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
  console.log(
    `Average closed trade PnL: ${formatMoney(result.averageClosedTradePnl)}`,
  );
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
  console.log("AI Trading Agent Backtest v3 — shared strategyEngine");
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
          result.totalPnlPercent,
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
  const message =
    error instanceof Error ? error.message : "Unknown backtest error";
  console.error(`Backtest failed: ${message}`);
  process.exit(1);
});
