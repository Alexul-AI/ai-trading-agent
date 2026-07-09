// Alpha Vantage fundamentals service.
// Fetches company overview data (P/E, dividend yield, analyst consensus) so
// the AI agent can reason over real fundamentals instead of guessing.

import type { FundamentalResult } from "../types/serverTypes.js";

interface AlphaVantageOverviewResponse {
  Symbol?: string;
  MarketCapitalization?: string;
  PERatio?: string;
  ForwardPE?: string;
  DividendYield?: string;
  "52WeekHigh"?: string;
  "52WeekLow"?: string;
  AnalystRatingStrongBuy?: string;
  AnalystRatingBuy?: string;
  AnalystRatingHold?: string;
  AnalystRatingSell?: string;
  AnalystRatingStrongSell?: string;
  Note?: string;
  Information?: string;
}

export interface AlphaVantageFundamentalsConfig {
  apiKey: string;
}

function formatMarketCap(raw: string | undefined): string {
  const value = Number(raw);

  if (!Number.isFinite(value) || value <= 0) return "N/A";
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;

  return `$${value.toFixed(0)}`;
}

function formatPrice(raw: string | undefined): string {
  const value = Number(raw);

  return Number.isFinite(value) && value > 0 ? `$${value.toFixed(2)}` : "N/A";
}

function formatRatio(raw: string | undefined): string {
  const value = Number(raw);

  return Number.isFinite(value) && value > 0 ? value.toFixed(2) : "N/A";
}

function formatDividendYield(raw: string | undefined): string {
  const value = Number(raw);

  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "N/A";
}

function formatAnalystRating(data: AlphaVantageOverviewResponse): string {
  const strongBuy = Number(data.AnalystRatingStrongBuy) || 0;
  const buy = Number(data.AnalystRatingBuy) || 0;
  const hold = Number(data.AnalystRatingHold) || 0;
  const sell = Number(data.AnalystRatingSell) || 0;
  const strongSell = Number(data.AnalystRatingStrongSell) || 0;
  const total = strongBuy + buy + hold + sell + strongSell;

  if (total === 0) return "N/A";

  const weightedSum =
    strongBuy * 5 + buy * 4 + hold * 3 + sell * 2 + strongSell * 1;
  const average = weightedSum / total;

  let label = "Hold";

  if (average >= 4.5) label = "Strong Buy";
  else if (average >= 3.5) label = "Buy";
  else if (average >= 2.5) label = "Hold";
  else if (average >= 1.5) label = "Sell";
  else label = "Strong Sell";

  return `${label} (${average.toFixed(1)}/5 from ${total} analysts)`;
}

export function createAlphaVantageFundamentals(
  config: AlphaVantageFundamentalsConfig,
) {
  async function fetchFundamentals(ticker: string): Promise<FundamentalResult> {
    const url = new URL("https://www.alphavantage.co/query");

    url.searchParams.set("function", "OVERVIEW");
    url.searchParams.set("symbol", ticker.toUpperCase());
    url.searchParams.set("apikey", config.apiKey);

    const response = await fetch(url.toString());

    if (!response.ok) {
      throw new Error(
        `Alpha Vantage request failed for ${ticker}: HTTP ${response.status}`,
      );
    }

    const data = (await response.json()) as AlphaVantageOverviewResponse;

    if (data.Note || data.Information) {
      throw new Error(
        data.Note ?? data.Information ?? "Alpha Vantage rate limit reached.",
      );
    }

    if (!data.Symbol) {
      throw new Error(`No fundamentals found for ${ticker}.`);
    }

    return {
      ticker: ticker.toUpperCase(),
      marketCap: formatMarketCap(data.MarketCapitalization),
      peRatio: formatRatio(data.PERatio),
      forwardPE: formatRatio(data.ForwardPE),
      dividendYield: formatDividendYield(data.DividendYield),
      fiftyTwoWeekHigh: formatPrice(data["52WeekHigh"]),
      fiftyTwoWeekLow: formatPrice(data["52WeekLow"]),
      analystRating: formatAnalystRating(data),
    };
  }

  return { fetchFundamentals };
}
