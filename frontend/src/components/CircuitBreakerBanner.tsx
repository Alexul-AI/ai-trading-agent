import type { CircuitBreakerState } from "../types";
import { formatSignalTimestamp } from "../utils/dateTime";

interface CircuitBreakerBannerProps {
  circuitBreaker: CircuitBreakerState | null;
  thresholdPercent: number;
  onReviewClick: () => void;
}

export function CircuitBreakerBanner({
  circuitBreaker,
  thresholdPercent,
  onReviewClick,
}: CircuitBreakerBannerProps) {
  if (!circuitBreaker?.tripped) {
    return null;
  }

  return (
    <div className="mx-6 mb-6 rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4 text-rose-100">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-sm font-black">
            🚨 TRADING HALTED — Portfolio Circuit Breaker Active
          </div>
          <div className="mt-1 text-xs opacity-80">
            New BUY orders are blocked. SELL orders remain allowed.
          </div>
          <div className="mt-2 text-xs opacity-80">
            Halted since:{" "}
            {circuitBreaker.trippedAt
              ? formatSignalTimestamp(circuitBreaker.trippedAt)
              : "unknown"}
          </div>
          <div className="text-xs opacity-80">
            Reason: drawdown exceeded {Math.abs(thresholdPercent).toFixed(0)}%
            from peak
          </div>
        </div>

        <button
          type="button"
          onClick={onReviewClick}
          className="rounded-xl border border-rose-500/30 bg-slate-950/40 px-3 py-2 text-[10px] font-black uppercase text-rose-100 hover:bg-slate-950/60"
        >
          Review circuit breaker
        </button>
      </div>
    </div>
  );
}
