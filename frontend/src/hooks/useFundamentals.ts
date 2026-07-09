import { useCallback, useState } from "react";

import type { FundamentalResult } from "../types";
import { getErrorMessage } from "../utils";

type FetchWithAdminSession = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;

export function useFundamentals(fetchWithAdminSession: FetchWithAdminSession) {
  const [fundamentals, setFundamentals] = useState<FundamentalResult | null>(
    null,
  );
  const [isLoadingFundamentals, setIsLoadingFundamentals] = useState(false);
  const [fundamentalsError, setFundamentalsError] = useState<string | null>(
    null,
  );

  const fetchFundamentals = useCallback(
    async (ticker: string) => {
      if (!ticker) return;

      setIsLoadingFundamentals(true);
      setFundamentalsError(null);

      try {
        const response = await fetchWithAdminSession(
          `/api/fundamentals/${encodeURIComponent(ticker)}`,
        );

        if (!response.ok) {
          throw new Error(`Fundamentals failed: ${response.status}`);
        }

        const data = (await response.json()) as FundamentalResult;
        setFundamentals(data);
      } catch (error) {
        setFundamentalsError(getErrorMessage(error));
      } finally {
        setIsLoadingFundamentals(false);
      }
    },
    [fetchWithAdminSession],
  );

  return {
    fundamentals,
    isLoadingFundamentals,
    fundamentalsError,
    fetchFundamentals,
  };
}
