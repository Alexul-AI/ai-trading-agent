import type { JournalRun, JournalSummary } from "../types";
import {
  actionPillClass,
  confidenceClass,
  formatTimestamp,
  getActionCount,
  getTopTicker,
} from "../utils";
import {
  isBuySellSignal,
  isExecutionOnlySkippedReason,
  isSignalReadyDecision,
} from "../utils/signalReadiness";

interface DecisionJournalPanelProps {
  journalFile: string;
  journalRuns: JournalRun[];
  journalSummary: JournalSummary | null;
  isLoadingJournal: boolean;
  onRefresh: () => void;
  minConfidence?: number;
}

interface JournalSignalStats {
  candidates: number;
  signalReady: number;
  signalBlocked: number;
  executed: number;
  dryRun: number;
}

const DEFAULT_MIN_CONFIDENCE = 0.75;

function isDryRunDecision(decision: JournalRun["decisions"][number]): boolean {
  if (decision.executionStatus === "dry_run") return true;

  return isExecutionOnlySkippedReason(decision.skippedReason);
}

function buildRunSignalStats(
  run: JournalRun,
  minConfidence: number,
): JournalSignalStats {
  const candidates = run.decisions.filter((decision) =>
    isBuySellSignal(decision.action),
  );

  const signalReady = candidates.filter((decision) =>
    isSignalReadyDecision(decision, minConfidence),
  );

  const executed = candidates.filter(
    (decision) => decision.executed || decision.executionStatus === "executed",
  );

  const dryRun = signalReady.filter(isDryRunDecision);

  return {
    candidates: candidates.length,
    signalReady: signalReady.length,
    signalBlocked: candidates.length - signalReady.length,
    executed: executed.length,
    dryRun: dryRun.length,
  };
}

function buildJournalSignalStats(
  runs: JournalRun[],
  minConfidence: number,
): JournalSignalStats {
  return runs.reduce<JournalSignalStats>(
    (acc, run) => {
      const runStats = buildRunSignalStats(run, minConfidence);

      acc.candidates += runStats.candidates;
      acc.signalReady += runStats.signalReady;
      acc.signalBlocked += runStats.signalBlocked;
      acc.executed += runStats.executed;
      acc.dryRun += runStats.dryRun;

      return acc;
    },
    {
      candidates: 0,
      signalReady: 0,
      signalBlocked: 0,
      executed: 0,
      dryRun: 0,
    },
  );
}

function getMostRelevantDecision(
  run: JournalRun,
): JournalRun["decisions"][number] | undefined {
  const buySellCandidates = run.decisions.filter((decision) =>
    isBuySellSignal(decision.action),
  );

  if (buySellCandidates.length > 0) {
    return [...buySellCandidates].sort(
      (a, b) => b.confidence - a.confidence,
    )[0];
  }

  return [...run.decisions].sort((a, b) => b.confidence - a.confidence)[0];
}

function SmallMetricCard({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number | string;
  tone?: "neutral" | "good" | "warn" | "info";
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-300"
      : tone === "warn"
        ? "text-amber-300"
        : tone === "info"
          ? "text-blue-300"
          : "text-white";

  return (
    <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-2">
      <div className="text-[9px] text-slate-500 font-black uppercase">
        {label}
      </div>
      <div className={`text-lg font-black ${toneClass}`}>{value}</div>
    </div>
  );
}

export function DecisionJournalPanel({
  journalFile,
  journalRuns,
  journalSummary,
  isLoadingJournal,
  onRefresh,
  minConfidence = DEFAULT_MIN_CONFIDENCE,
}: DecisionJournalPanelProps) {
  const loadedSignalStats = buildJournalSignalStats(journalRuns, minConfidence);

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
        <SmallMetricCard
          label="Runs"
          value={journalSummary?.totalRuns ?? journalRuns.length}
        />
        <SmallMetricCard
          label="Signal ready"
          value={loadedSignalStats.signalReady}
          tone="good"
        />
        <SmallMetricCard
          label="Executed"
          value={loadedSignalStats.executed}
          tone="good"
        />
        <SmallMetricCard
          label="Dry-run"
          value={loadedSignalStats.dryRun}
          tone="info"
        />
      </div>

      <div className="grid grid-cols-4 gap-2 mb-4 text-[10px]">
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

        <div className="rounded-lg bg-blue-500/10 border border-blue-500/20 p-2">
          <span className="text-blue-300 font-black">TOP</span>
          <span className="float-right font-mono">
            {getTopTicker(journalSummary)}
          </span>
        </div>
      </div>

      <div className="mb-4 rounded-xl border border-slate-800 bg-slate-950/40 p-2 text-[10px] text-slate-400">
        Signal-ready metrics are calculated from loaded journal runs. Dry-run
        execution does not make a strategy signal blocked.
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
            const runSignalStats = buildRunSignalStats(run, minConfidence);
            const strongestDecision = getMostRelevantDecision(run);

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
                    <div className="mt-1 text-[10px] text-slate-500">
                      candidates {runSignalStats.candidates} · signal-ready{" "}
                      {runSignalStats.signalReady} · dry-run{" "}
                      {runSignalStats.dryRun}
                    </div>
                  </div>

                  <div className="text-right">
                    <div className="text-xs font-black text-emerald-300">
                      {runSignalStats.signalReady}
                    </div>
                    <div className="text-[9px] text-slate-500 uppercase">
                      signal ready
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
                    <span
                      className={confidenceClass(strongestDecision.confidence)}
                    >
                      conf {strongestDecision.confidence}
                    </span>
                    {isBuySellSignal(strongestDecision.action) &&
                      isSignalReadyDecision(
                        strongestDecision,
                        minConfidence,
                      ) && (
                        <span className="ml-2 rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-black uppercase text-emerald-200">
                          signal ready
                        </span>
                      )}
                    {isDryRunDecision(strongestDecision) && (
                      <span className="ml-2 rounded-full bg-blue-500/20 px-1.5 py-0.5 text-[9px] font-black uppercase text-blue-200">
                        dry-run
                      </span>
                    )}
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
