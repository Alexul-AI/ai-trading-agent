import { useCallback, useState, type SyntheticEvent } from "react";

import { API_BASE_URL } from "../api/client";
import type { CircuitBreakerReview, CircuitBreakerResetResponse } from "../types";
import { getErrorMessage } from "../utils";

type FetchWithAdminSession = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;

type RefreshDashboard = () => Promise<void>;
type RefreshAutopilotStatus = () => Promise<void>;

export function useCircuitBreakerReview(
  fetchWithAdminSession: FetchWithAdminSession,
  refreshDashboard: RefreshDashboard,
  refreshAutopilotStatus: RefreshAutopilotStatus,
) {
  const [isReviewOpen, setIsReviewOpen] = useState(false);
  const [review, setReview] = useState<CircuitBreakerReview | null>(null);
  const [isLoadingReview, setIsLoadingReview] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  const [reason, setReason] = useState("");
  const [isResetting, setIsResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetSuccessMessage, setResetSuccessMessage] = useState<
    string | null
  >(null);

  // Public endpoint (no admin gate, matches /api/dashboard's convention) -
  // a plain fetch, same as refreshAutopilotStatus's /api/autopilot/status
  // call in App.tsx. fetchWithAdminSession's 401-retry-with-password-prompt
  // is only meaningful for admin-gated routes.
  const fetchReview = useCallback(async () => {
    setIsLoadingReview(true);
    setReviewError(null);

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/autopilot/circuit-breaker/review`,
        { cache: "no-store" },
      );

      if (!response.ok) {
        throw new Error(`Circuit breaker review failed: ${response.status}`);
      }

      const data = (await response.json()) as CircuitBreakerReview;
      setReview(data);
    } catch (error) {
      setReviewError(getErrorMessage(error));
    } finally {
      setIsLoadingReview(false);
    }
  }, []);

  const openReview = useCallback(() => {
    setIsReviewOpen(true);
    setResetError(null);
    setResetSuccessMessage(null);
    void fetchReview();
  }, [fetchReview]);

  const closeReview = useCallback(() => {
    setIsReviewOpen(false);
  }, []);

  async function submitReset(event: SyntheticEvent) {
    event.preventDefault();

    // Client-side mirror of the backend's own check - not a replacement
    // for it, just faster feedback than a round-trip 400.
    if (!reason.trim()) {
      setResetError("A reason is required to reset the circuit breaker.");
      return;
    }

    setIsResetting(true);
    setResetError(null);
    setResetSuccessMessage(null);

    try {
      const response = await fetchWithAdminSession(
        "/api/autopilot/circuit-breaker/reset",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        },
      );

      const result = (await response.json()) as CircuitBreakerResetResponse;

      if (!response.ok || result.status !== "reset") {
        throw new Error(result.error || "Reset rejected.");
      }

      setResetSuccessMessage(
        `Circuit breaker reset. New peak equity: ${
          result.state?.peakEquity.toFixed(2) ?? "n/a"
        }.`,
      );
      setReason("");
      await Promise.all([
        fetchReview(),
        refreshDashboard(),
        refreshAutopilotStatus(),
      ]);
    } catch (error) {
      setResetError(getErrorMessage(error));
    } finally {
      setIsResetting(false);
    }
  }

  return {
    isReviewOpen,
    review,
    isLoadingReview,
    reviewError,
    openReview,
    closeReview,
    reason,
    setReason,
    isResetting,
    resetError,
    resetSuccessMessage,
    submitReset,
  };
}
