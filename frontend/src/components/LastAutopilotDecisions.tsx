import type { AutopilotDecision } from "../types";
import { actionPillClass, confidenceClass, formatMoney } from "../utils";

interface LastAutopilotDecisionsProps {
  latestDecisions: AutopilotDecision[];
  signalReadyCount: number;
}

export function LastAutopilotDecisions({
  latestDecisions,
  signalReadyCount,
}: LastAutopilotDecisionsProps) {
  return (
    <div className="bg-slate-900/60 rounded-2xl border border-slate-800 p-4 flex flex-col min-h-[360px]">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold tracking-wider text-slate-300">
          LAST AUTOPILOT DECISIONS
        </h2>
        <span className="text-[10px] text-slate-500">
          signal ready {signalReadyCount}
        </span>
      </div>

      <div className="space-y-2 overflow-y-auto pr-1">
        {latestDecisions.length === 0 ? (
          <div className="text-center text-slate-600 py-16 text-xs">
            Run dry-run to see signals.
          </div>
        ) : (
          latestDecisions.map((decision) => (
            <div
              key={`${decision.ticker}-${decision.timestamp}`}
              className="rounded-xl border border-slate-800 bg-slate-950/50 p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-black text-sm">
                      {decision.ticker}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-full border text-[10px] font-black ${actionPillClass(
                        decision.action,
                      )}`}
                    >
                      {decision.action}
                    </span>
                  </div>
                  <div className="text-[10px] text-slate-500 mt-1">
                    {decision.rsi !== undefined
                      ? `RSI ${decision.rsi} · MACD ${decision.macdHistogram} · `
                      : ""}
                    price {formatMoney(decision.price)}
                  </div>
                </div>

                <div className="text-right">
                  <div
                    className={`font-mono text-xs font-black ${confidenceClass(
                      decision.confidence,
                    )}`}
                  >
                    {decision.confidence}
                  </div>
                  <div className="text-[10px] text-slate-500">confidence</div>
                </div>
              </div>

              <div className="mt-2 text-xs text-slate-300 leading-relaxed">
                {decision.reason}
              </div>

              {decision.action !== "HOLD" && (
                <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
                  <div className="rounded-lg bg-slate-900/70 border border-slate-800 p-2">
                    <span className="text-slate-500">Suggested</span>
                    <div className="font-bold text-white">
                      {decision.suggestedNotional
                        ? `${formatMoney(decision.suggestedNotional)} (fractional)`
                        : `${decision.suggestedShares} shares`}
                      {decision.originalSuggestedShares
                        ? ` / original ${decision.originalSuggestedShares}`
                        : ""}
                      {decision.originalSuggestedNotional
                        ? ` / original ${formatMoney(decision.originalSuggestedNotional)}`
                        : ""}
                    </div>
                  </div>

                  <div className="rounded-lg bg-slate-900/70 border border-slate-800 p-2">
                    <span className="text-slate-500">Executed</span>
                    <div
                      className={
                        decision.executed
                          ? "font-bold text-emerald-300"
                          : "font-bold text-blue-300"
                      }
                    >
                      {decision.executed ? "YES" : "NO"}
                    </div>
                  </div>
                </div>
              )}

              {decision.safetyNote && (
                <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] text-amber-200">
                  {decision.safetyNote}
                </div>
              )}

              {decision.skippedReason && (
                <div className="mt-2 text-[10px] text-slate-500">
                  Skipped: {decision.skippedReason}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
