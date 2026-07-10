// Alpaca news service.
// Fetches recent headlines for a ticker so the AI agent can reason over
// real, sourced data instead of relying on the model's own knowledge.

import type { AlpacaNewsArticle } from "../types/serverTypes.js";

interface AlpacaNewsApiArticle {
  id: number;
  headline: string;
  summary?: string;
  source: string;
  url: string;
  created_at: string;
  symbols?: string[];
}

interface AlpacaNewsApiResponse {
  news?: AlpacaNewsApiArticle[];
}

export interface AlpacaNewsConfig {
  keyId: string;
  secretKey: string;
}

// Without a timeout, a hung (not failed) request here never resolves,
// which means Promise.all over tickers in autopilotWorker.ts never
// settles either - running never gets reset to false, and every future
// scheduled tick silently no-ops forever with no error logged.
const FETCH_TIMEOUT_MS = 15_000;

export function createAlpacaNews(config: AlpacaNewsConfig) {
  async function fetchRecentNews(
    ticker: string,
    limit = 8,
  ): Promise<AlpacaNewsArticle[]> {
    const url = new URL("https://data.alpaca.markets/v1beta1/news");

    url.searchParams.set("symbols", ticker.toUpperCase());
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("sort", "desc");

    const response = await fetch(url.toString(), {
      headers: {
        "APCA-API-KEY-ID": config.keyId,
        "APCA-API-SECRET-KEY": config.secretKey,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text();

      throw new Error(
        `Alpaca news request failed for ${ticker}: HTTP ${response.status} ${body}`,
      );
    }

    const data = (await response.json()) as AlpacaNewsApiResponse;

    return (data.news ?? []).map((article) => ({
      id: article.id,
      headline: article.headline,
      summary: article.summary ?? "",
      source: article.source,
      url: article.url,
      createdAt: article.created_at,
    }));
  }

  return { fetchRecentNews };
}
