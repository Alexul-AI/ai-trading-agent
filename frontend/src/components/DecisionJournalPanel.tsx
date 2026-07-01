import type { JournalRun, JournalSummary } from "../types";
import {
  actionPillClass,
  confidenceClass,
  formatTimestamp,
  getActionCount,
  getTopTicker,
} from "../utils";

interface DecisionJournalPanelProps {
  journalFile: string;
  journalRuns: JournalRun[];
  journalSummary: JournalSummary | null;
  isLoadingJournal: boolean;
  onRefresh: () => void;
}

export function DecisionJournalPanel({
  journalFile,
  journalRuns,
  journalSummary,
  isLoadingJournal,
  onRefresh,
}: DecisionJournalPanelProps) {
  return (
    <div className="bg-slate-900/60 rounded-2xl border border-slate-800 p-4">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-sm font-bold tracking-wider text-slate-300">
            DECISION JOURNAL
          </h2>
          <p className="text-[10px] text-slate-500 truncate max-w-[300px]">
            {journalFile || "backend/data/autopilot-decisions.jsonl"}
          </p>
        </div>

        <button
          onClick={onRefresh}
          disabled={isLoadingJournal}
          className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:text-slate-600 text-[10px] font-black text-slate-300"
        >
          {isLoadingJournal ? "LOADING" : "REFRESH"}
        </button>
      </div>

      <div className="grid grid-cols-4 gap-2 mb-4">
        <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-2">
          <div className="text-[9px] text-slate-500 font-black uppercase">
            Runs
          </div>
          <div className="text-lg font-black text-white">
            {journalSummary?.totalRuns ?? 0}
          </div>
        </div>

        <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-2">
          <div className="text-[9px] text-slate-500 font-black uppercase">
            Signals
          </div>
          <div className="text-lg font-black text-amber-300">
            {journalSummary?.actionableSignals ?? 0}
          </div>
        </div>

        <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-2">
          <div className="text-[9px] text-slate-500 font-black uppercase">
            Executed
          </div>
          <div className="text-lg font-black text-emerald-300">
            {journalSummary?.executedSignals ?? 0}
          </div>
        </div>

        <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-2">
          <div className="text-[9px] text-slate-500 font-black uppercase">
            Top
          </div>
          <div className="text-lg font-black text-blue-300">
            {getTopTicker(journalSummary)}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-4 text-[10px]">
        <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-2">
          <span className="text-emerald-300 font-black">BUY</span>
          <span className="float-right font-mono">
            {getActionCount(journalSummary, "BUY")}
          </span>
        </div>

        <div className="rounded-lg bg-rose-500/10 border border-rose-500/20 p-2">
          <span className="text-rose-300 font-black">SELL</span>
          <span className="float-right font-mono">
            {getActionCount(journalSummary, "SELL")}
          </span>
        </div>

        <div className="rounded-lg bg-slate-950/60 border border-slate-800 p-2">
          <span className="text-slate-400 font-black">HOLD</span>
          <span className="float-right font-mono">
            {getActionCount(journalSummary, "HOLD")}
          </span>
        </div>
      </div>

      <div className="space-y-2 max-h-[240px] overflow-y-auto pr-1">
        {journalRuns.length === 0 ? (
          <div className="text-center text-slate-600 py-8 text-xs">
            No journal runs yet. Press RUN ONCE.
          </div>
        ) : (
          journalRuns.map((run) => {
            const buyCount = run.decisions.filter(
              (decision) => decision.action === "BUY",
            ).length;
            const sellCount = run.decisions.filter(
              (decision) => decision.action === "SELL",
            ).length;
            const holdCount = run.decisions.filter(
              (decision) => decision.action === "HOLD",
            ).length;
            const strongestDecision = [...run.decisions].sort(
              (a, b) => b.confidence - a.confidence,
            )[0];

            return (
              <div
                key={run.id}
                className="rounded-xl border border-slate-800 bg-slate-950/50 p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-black text-white">
                        {formatTimestamp(run.timestamp)}
                      </span>
                      <span className="px-1.5 py-0.5 rounded bg-slate-800 text-[9px] font-black text-slate-400 uppercase">
                        {run.trigger}
                      </span>
                      <span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-[9px] font-black text-blue-300 uppercase">
                        {run.executeTrades ? "execution" : "dry-run"}
                      </span>
                    </div>
                    <div className="mt-1 text-[10px] text-slate-500">
                      BUY {buyCount} · SELL {sellCount} · HOLD {holdCount}
                    </div>
                  </div>

                  <div className="text-right">
                    <div className="text-xs font-black text-amber-300">
                      {run.actionableCount}
                    </div>
                    <div className="text-[9px] text-slate-500 uppercase">
                      actionable
                    </div>
                  </div>
                </div>

                {strongestDecision && (
                  <div className="mt-2 rounded-lg bg-slate-900/60 border border-slate-800 p-2 text-[10px]">
                    <span
                      className={`px-1.5 py-0.5 rounded-full border font-black mr-2 ${actionPillClass(
                        strongestDecision.action,
                      )}`}
                    >
                      {strongestDecision.ticker} {strongestDecision.action}
                    </span>
                    <span className={confidenceClass(strongestDecision.confidence)}>
                      conf {strongestDecision.confidence}
                    </span>
                    {strongestDecision.originalSuggestedShares && (
                      <span className="text-amber-300 ml-2">
                        {strongestDecision.suggestedShares}/
                        {strongestDecision.originalSuggestedShares}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
