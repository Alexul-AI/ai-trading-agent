import { useCallback, useState } from "react";

import { API_BASE_URL } from "../api/client";
import type { MarketClockData } from "../components/MarketClockPanel";
import { getErrorMessage } from "../utils";

export function useMarketClock() {
  const [marketClock, setMarketClock] = useState<MarketClockData | null>(null);
  const [marketClockError, setMarketClockError] = useState<string | null>(null);

  const refreshMarketClock = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/market/clock`, {
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error(`Market clock failed: ${response.status}`);
      }

      const data = (await response.json()) as MarketClockData;
      setMarketClock(data);
      setMarketClockError(null);
    } catch (error) {
      setMarketClockError(getErrorMessage(error));
      console.warn("Market clock refresh failed:", error);
    }
  }, []);

  return {
    marketClock,
    marketClockError,
    refreshMarketClock,
  };
}
