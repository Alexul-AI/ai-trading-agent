import { useCallback, useState } from "react";

import type { NewsSentimentResult } from "../types";
import { getErrorMessage } from "../utils";

type FetchWithAdminSession = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;

export function useNewsSentiment(fetchWithAdminSession: FetchWithAdminSession) {
  const [sentiment, setSentiment] = useState<NewsSentimentResult | null>(null);
  const [isLoadingSentiment, setIsLoadingSentiment] = useState(false);
  const [sentimentError, setSentimentError] = useState<string | null>(null);

  const fetchSentiment = useCallback(
    async (ticker: string) => {
      if (!ticker) return;

      setIsLoadingSentiment(true);
      setSentimentError(null);

      try {
        const response = await fetchWithAdminSession(
          `/api/news-sentiment/${encodeURIComponent(ticker)}`,
        );

        if (!response.ok) {
          throw new Error(`News sentiment failed: ${response.status}`);
        }

        const data = (await response.json()) as NewsSentimentResult;
        setSentiment(data);
      } catch (error) {
        setSentimentError(getErrorMessage(error));
      } finally {
        setIsLoadingSentiment(false);
      }
    },
    [fetchWithAdminSession],
  );

  return {
    sentiment,
    isLoadingSentiment,
    sentimentError,
    fetchSentiment,
  };
}
