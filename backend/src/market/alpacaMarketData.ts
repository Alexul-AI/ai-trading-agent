// Alpaca market data service.
// Keeps market clock, bars, watchlist quotes, and estimated-price logic out of server.ts.

import type {
  AlpacaBar,
  AlpacaBarsResponse,
  AlpacaClockResponse,
  AlpacaLike,
  MarketClockResponse,
  PositionSnapshot,
  WatchlistItem,
} from "../types/serverTypes.js";
import { extractAlpacaPrice } from "../alpaca/price.js";
import { toIsoDate } from "../utils/time.js";
import { calculateDailyChangePercent } from "./dailyChange.js";
import {
  formatCountdownDuration,
  formatIsraelMarketTime,
} from "./clockTime.js";

export interface AlpacaMarketDataConfig {
  alpaca: AlpacaLike;
  isLiveMode: boolean;
  alpacaDataFeed: string;
  paperKeyId: string;
  paperSecretKey: string;
  liveKeyId?: string;
  liveSecretKey?: string;
}

export function createAlpacaMarketData(config: AlpacaMarketDataConfig) {
  const {
    alpaca,
    isLiveMode,
    alpacaDataFeed,
    paperKeyId,
    paperSecretKey,
    liveKeyId,
    liveSecretKey,
  } = config;

  function getApiKeyId(): string {
    return isLiveMode ? (liveKeyId ?? "") : paperKeyId;
  }

  function getApiSecretKey(): string {
    return isLiveMode ? (liveSecretKey ?? "") : paperSecretKey;
  }

  function getAlpacaTradingBaseUrl(): string {
    return isLiveMode
      ? "https://api.alpaca.markets"
      : "https://paper-api.alpaca.markets";
  }

  async function fetchAlpacaMarketClock(): Promise<MarketClockResponse> {
    const response = await fetch(`${getAlpacaTradingBaseUrl()}/v2/clock`, {
      headers: {
        "APCA-API-KEY-ID": getApiKeyId(),
        "APCA-API-SECRET-KEY": getApiSecretKey(),
      },
    });

    if (!response.ok) {
      const body = await response.text();

      throw new Error(
        `Alpaca market clock failed: HTTP ${response.status} ${body}`,
      );
    }

    const clock = (await response.json()) as AlpacaClockResponse;
    const marketTimestamp = new Date(clock.timestamp);
    const nextEventTimestamp = new Date(
      clock.is_open ? clock.next_close : clock.next_open,
    );
    const countdownMs = Math.max(
      0,
      nextEventTimestamp.getTime() - marketTimestamp.getTime(),
    );

    return {
      isOpen: clock.is_open,
      timestamp: clock.timestamp,
      nextOpen: clock.next_open,
      nextClose: clock.next_close,
      nextOpenIsrael: formatIsraelMarketTime(clock.next_open),
      nextCloseIsrael: formatIsraelMarketTime(clock.next_close),
      countdownMs,
      countdownLabel: formatCountdownDuration(countdownMs),
      statusLabel: clock.is_open ? "MARKET OPEN" : "MARKET CLOSED",
      nextEventLabel: clock.is_open ? "Closes in" : "Opens in",
      timezone: "Asia/Jerusalem",
      source: "alpaca",
    };
  }

  async function getPreviousCloseFromAlpaca(ticker: string): Promise<number> {
    const endDate = new Date();
    const startDate = new Date();

    // Wider window handles weekends and market holidays.
    startDate.setDate(endDate.getDate() - 14);

    const url = new URL(`https://data.alpaca.markets/v2/stocks/${ticker}/bars`);

    url.searchParams.set("timeframe", "1Day");
    url.searchParams.set("start", toIsoDate(startDate));
    url.searchParams.set("end", toIsoDate(endDate));
    url.searchParams.set("adjustment", "raw");
    url.searchParams.set("feed", alpacaDataFeed);
    url.searchParams.set("limit", "10");

    const response = await fetch(url.toString(), {
      headers: {
        "APCA-API-KEY-ID": getApiKeyId(),
        "APCA-API-SECRET-KEY": getApiSecretKey(),
      },
    });

    if (!response.ok) {
      const body = await response.text();

      throw new Error(
        `Alpaca previous close request failed for ${ticker}: HTTP ${response.status} ${body}`,
      );
    }

    const data = (await response.json()) as AlpacaBarsResponse;
    const bars = data.bars ?? [];

    if (bars.length === 0) return 0;

    const sortedBars = bars.sort(
      (a, b) => new Date(a.t).getTime() - new Date(b.t).getTime(),
    );

    // Prefer previous completed daily bar. Fallback to latest available bar.
    const previousBar =
      sortedBars.length >= 2
        ? sortedBars[sortedBars.length - 2]
        : sortedBars[sortedBars.length - 1];

    return previousBar?.c ?? 0;
  }

  async function getWatchlistQuotesFromAlpaca(
    tickers: string[],
    positions: Record<string, PositionSnapshot>,
  ): Promise<WatchlistItem[]> {
    const uniqueTickers = Array.from(
      new Set(
        tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean),
      ),
    );

    const items = await Promise.all(
      uniqueTickers.map(async (ticker): Promise<WatchlistItem> => {
        const position = positions[ticker];

        try {
          let price = 0;

          if (position && position.currentPrice > 0) {
            price = position.currentPrice;
          } else {
            const latestTrade = await alpaca.getLatestTrade(ticker);
            price = extractAlpacaPrice(latestTrade);
          }

          if (price <= 0) {
            console.warn(`[WATCHLIST] Alpaca returned no price for ${ticker}`);
          }

          let change = 0;

          try {
            const previousClose = await getPreviousCloseFromAlpaca(ticker);
            change = calculateDailyChangePercent(price, previousClose);
          } catch (error) {
            console.warn(
              `[WATCHLIST] Failed to fetch previous close for ${ticker}:`,
              error,
            );
          }

          return {
            ticker,
            name: ticker,
            price,
            change,
            isUp: change >= 0,
          };
        } catch (error) {
          console.warn(
            `[WATCHLIST] Failed to fetch ${ticker} from Alpaca:`,
            error,
          );

          return {
            ticker,
            name: `${ticker} (unavailable)`,
            price: 0,
            change: 0,
            isUp: true,
          };
        }
      }),
    );

    return items;
  }

  // RSI and MACD use recursive/exponential smoothing seeded from the
  // first bar in the series and only converge to accurate values after
  // ~100+ bars of runway (same root cause as the backtest warm-up bug
  // fixed earlier). Fetching extra history and trimming the *computed
  // points* afterward (see buildMarketChartPoints) instead of trimming
  // the raw bars first keeps the displayed indicator values accurate
  // even for short chart windows like 60D.
  const CHART_WARMUP_TRADING_DAYS = 150;

  async function fetchDailyBarsForChart(
    ticker: string,
    days: number,
  ): Promise<AlpacaBar[]> {
    if (!ticker) {
      throw new Error("Ticker is required.");
    }

    const safeDays = Math.max(30, Math.min(365, days));
    const totalTradingDaysNeeded = safeDays + CHART_WARMUP_TRADING_DAYS;
    const endDate = new Date();
    const startDate = new Date();

    // Add buffer for weekends and market holidays.
    startDate.setDate(
      endDate.getDate() - Math.ceil(totalTradingDaysNeeded * 1.6),
    );

    const allBars: AlpacaBar[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL(
        `https://data.alpaca.markets/v2/stocks/${ticker}/bars`,
      );

      url.searchParams.set("timeframe", "1Day");
      url.searchParams.set("start", toIsoDate(startDate));
      url.searchParams.set("end", toIsoDate(endDate));
      url.searchParams.set("adjustment", "raw");
      url.searchParams.set("feed", alpacaDataFeed);
      url.searchParams.set("limit", "1000");

      if (pageToken) {
        url.searchParams.set("page_token", pageToken);
      }

      const response = await fetch(url.toString(), {
        headers: {
          "APCA-API-KEY-ID": getApiKeyId(),
          "APCA-API-SECRET-KEY": getApiSecretKey(),
        },
      });

      if (!response.ok) {
        const body = await response.text();

        throw new Error(
          `Alpaca chart bars request failed for ${ticker}: HTTP ${response.status} ${body}`,
        );
      }

      const data = (await response.json()) as AlpacaBarsResponse;

      if (data.bars) {
        allBars.push(...data.bars);
      }

      pageToken = data.next_page_token || undefined;
    } while (pageToken);

    return allBars
      .sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime())
      .slice(-totalTradingDaysNeeded);
  }

  async function getEstimatedPrice(ticker: string, fallbackPrice?: number) {
    if (fallbackPrice && fallbackPrice > 0) return fallbackPrice;

    const latestTrade = await alpaca.getLatestTrade(ticker);
    const numericPrice = extractAlpacaPrice(latestTrade);

    return numericPrice > 0 ? numericPrice : 1;
  }

  return {
    fetchAlpacaMarketClock,
    getPreviousCloseFromAlpaca,
    getWatchlistQuotesFromAlpaca,
    fetchDailyBarsForChart,
    getEstimatedPrice,
  };
}
