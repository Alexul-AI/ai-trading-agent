import type { useCircuitBreakerReview } from "../hooks/useCircuitBreakerReview";
import { formatMoney, formatPercent } from "../utils";
import { formatSignalTimestamp } from "../utils/dateTime";

type CircuitBreakerReviewState = ReturnType<typeof useCircuitBreakerReview>;

interface CircuitBreakerReviewPanelProps {
  reviewState: CircuitBreakerReviewState;
  onClose: () => void;
}

export function CircuitBreakerReviewPanel({
  reviewState,
  onClose,
}: CircuitBreakerReviewPanelProps) {
  const {
    review,
    isLoadingReview,
    reviewError,
    reason,
    setReason,
    isResetting,
    resetError,
    resetSuccessMessage,
    submitReset,
  } = reviewState;

  return (
    <div className="mx-6 mb-6 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold tracking-wider text-slate-400">
          CIRCUIT BREAKER REVIEW
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-slate-800 px-2 py-1 text-[10px] font-black uppercase text-slate-400 hover:bg-slate-800"
        >
          Close
        </button>
      </div>

      {isLoadingReview && (
        <div className="text-xs text-slate-500">Loading review data...</div>
      )}

      {reviewError && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {reviewError}
        </div>
      )}

      {review && !isLoadingReview && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-3">
            <ReviewStat
              label="Halted since"
              value={
                review.trippedAt
                  ? formatSignalTimestamp(review.trippedAt)
                  : "-"
              }
            />
            <ReviewStat
              label="Days halted"
              value={review.daysHalted?.toString() ?? "-"}
            />
            <ReviewStat
              label="Peak equity"
              value={formatMoney(review.peakEquity)}
            />
            <ReviewStat
              label="Current equity"
              value={formatMoney(review.currentEquity)}
            />
            <ReviewStat
              label="Drawdown from peak"
              value={formatPercent(review.drawdownFromPeakPercent)}
            />
            <ReviewStat
              label="Threshold"
              value={formatPercent(review.thresholdPercent)}
            />
            <ReviewStat label="Cash" value={formatMoney(review.cash)} />
            <ReviewStat
              label="Blocked BUYs since halt"
              value={review.blockedBuyCountSinceHalt.toString()}
            />
          </div>

          {review.haltReason && (
            <div className="text-xs text-slate-400">{review.haltReason}</div>
          )}

          {!review.blockedSignalDataCoversFullHalt && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
              This halt has run longer than the loaded history window - the
              blocked-BUY count and recent signals below may be a partial
              lower bound, not the true total since halt.
            </div>
          )}

          {review.recentBlockedSignals.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-black uppercase tracking-wider text-slate-500">
                Recently blocked BUY signals
              </div>
              <div className="space-y-1">
                {review.recentBlockedSignals.map((signal, index) => (
                  <div
                    key={`${signal.ticker}-${signal.timestamp}-${index}`}
                    className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-[11px] text-slate-300"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-bold">{signal.ticker}</span>
                      <span className="text-slate-500">
                        {formatSignalTimestamp(signal.timestamp)}
                      </span>
                      <span>{formatMoney(signal.price)}</span>
                    </div>
                    <div className="mt-1 text-slate-500">{signal.reason}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {Object.keys(review.positions).length > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-black uppercase tracking-wider text-slate-500">
                Current positions
              </div>
              <div className="space-y-1">
                {Object.entries(review.positions).map(([ticker, position]) => (
                  <div
                    key={ticker}
                    className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-[11px] text-slate-300"
                  >
                    <span className="font-bold">{ticker}</span>
                    <span>{position.shares} shares</span>
                    <span>{formatMoney(position.currentPrice)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <form onSubmit={submitReset} className="space-y-2 border-t border-slate-800 pt-3">
            <div className="text-[10px] font-black uppercase tracking-wider text-slate-500">
              Manual reset (not automatic - a reason is required)
            </div>

            <textarea
              required
              placeholder="Reason for reset, e.g. reviewed positions and market conditions, safe to resume"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-white focus:border-slate-600 focus:outline-none"
              rows={2}
            />

            {resetError && (
              <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                {resetError}
              </div>
            )}

            {resetSuccessMessage && (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
                {resetSuccessMessage}
              </div>
            )}

            <button
              type="submit"
              disabled={isResetting || !reason.trim()}
              className="w-full rounded-xl bg-rose-700 py-2 text-xs font-bold tracking-wider text-white transition-all hover:bg-rose-600 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
            >
              {isResetting ? "RESETTING..." : "RESET CIRCUIT BREAKER"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

function ReviewStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
      <div className="text-[9px] font-black uppercase tracking-wider text-slate-500">
        {label}
      </div>
      <div className="mt-0.5 text-slate-200">{value}</div>
    </div>
  );
}
