import { useCallback, useState } from "react";

import type { InsiderActivityResult } from "../types";
import { getErrorMessage } from "../utils";

type FetchWithAdminSession = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;

export function useInsiderActivity(
  fetchWithAdminSession: FetchWithAdminSession,
) {
  const [insiderActivity, setInsiderActivity] =
    useState<InsiderActivityResult | null>(null);
  const [isLoadingInsiderActivity, setIsLoadingInsiderActivity] =
    useState(false);
  const [insiderActivityError, setInsiderActivityError] = useState<
    string | null
  >(null);

  const fetchInsiderActivity = useCallback(
    async (ticker: string) => {
      if (!ticker) return;

      setIsLoadingInsiderActivity(true);
      setInsiderActivityError(null);

      try {
        const response = await fetchWithAdminSession(
          `/api/insider-activity/${encodeURIComponent(ticker)}`,
        );

        if (!response.ok) {
          throw new Error(`Insider activity failed: ${response.status}`);
        }

        const data = (await response.json()) as InsiderActivityResult;
        setInsiderActivity(data);
      } catch (error) {
        setInsiderActivityError(getErrorMessage(error));
      } finally {
        setIsLoadingInsiderActivity(false);
      }
    },
    [fetchWithAdminSession],
  );

  return {
    insiderActivity,
    isLoadingInsiderActivity,
    insiderActivityError,
    fetchInsiderActivity,
  };
}
