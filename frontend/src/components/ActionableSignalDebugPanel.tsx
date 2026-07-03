import { useMemo, useState } from "react";
import type {
  AutopilotDecision,
  BlockReasonCategory,
  ExecutionBlockReasonCategory,
  JournalRun,
} from "../types";
import {
  isBuySellSignal,
  isSignalReadyDecision,
} from "../utils/signalReadiness";

interface ActionableSignalDebugPanelProps {
  journalRuns: JournalRun[];
  minConfidence: number;
  liveStrategyVersion?: string;
  liveStrategyConfigHash?: string;
}

type DebugScope = "live" | "all";

interface CandidateSignal {
  runId: string;
  timestamp: string;
  strategyVersion: string;
  strategyConfigHash: string;
  ticker: string;
  action: "BUY" | "SELL";
  confidence: number;
  skippedReason?: string;
  isSignalReady: boolean;
  signalBlockReason: BlockReasonCategory | null;
  executionStatus: string;
  executionBlockReason: ExecutionBlockReasonCategory | null;
  signalDetail?: string;
  executionDetail?: string;
}

function versionOf(run: JournalRun): string {
  return run.strategyVersion ?? "legacy";
}

function hashOf(run: JournalRun): string {
  return run.strategyConfigHash ?? "no-hash";
}

function shortHash(hash: string): string {
  if (hash === "no-hash") return "no hash";
  return hash.length > 12 ? hash.slice(0, 12) : hash;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}

function formatPercent(numerator: number, denominator: number): string {
  if (denominator <= 0) return "N/A";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function fallbackSignalBlockReason(
  decision: AutopilotDecision,
  minConfidence: number,
): BlockReasonCategory | null {
  if (decision.confidence < minConfidence) return "confidence";
  if (!decision.skippedReason) return null;

  const reason = decision.skippedReason.toLowerCase();

  if (
    reason.includes("position") ||
    reason.includes("below average") ||
    reason.includes("average entry") ||
    reason.includes("entry price")
  ) {
    return "position_guard";
  }

  if (
    reason.includes("quantity") ||
    reason.includes("share quantity") ||
    reason.includes("safe share")
  ) {
    return "quantity";
  }

  return null;
}

function fallbackExecutionReason(
  decision: AutopilotDecision,
): ExecutionBlockReasonCategory | null {
  if (!decision.skippedReason) return null;

  const reason = decision.skippedReason.toLowerCase();

  if (reason.includes("dry-run") || reason.includes("dry run")) {
    return "dry_run";
  }

  if (reason.includes("outside paper") || reason.includes("trade mode")) {
    return "trade_mode";
  }

  if (
    reason.includes("allow") ||
    reason.includes("disabled") ||
    reason.includes("execution blocked")
  ) {
    return "permission";
  }

  if (
    reason.includes("broker") ||
    reason.includes("execution did not succeed")
  ) {
    return "broker";
  }

  return null;
}

function signalLabel(reason: BlockReasonCategory): string {
  if (reason === "confidence") return "Confidence";
  if (reason === "position_guard") return "Position guard";
  if (reason === "safety_cap") return "Safety cap";
  if (reason === "quantity") return "Quantity";
  if (reason === "error") return "Error";
  return "Other";
}

function executionLabel(reason: ExecutionBlockReasonCategory): string {
  if (reason === "dry_run") return "Dry-run";
  if (reason === "trade_mode") return "Trade mode";
  if (reason === "permission") return "Permission";
  if (reason === "broker") return "Broker";
  return "Other";
}

function toneForSignal(reason: BlockReasonCategory | null): string {
  if (reason === "confidence") return "text-amber-300";
  if (reason === "position_guard") return "text-rose-300";
  if (reason === "safety_cap") return "text-orange-300";
  if (reason === "quantity") return "text-blue-300";
  if (reason === "error") return "text-rose-300";
  return "text-slate-300";
}

function toneForExecution(reason: ExecutionBlockReasonCategory | null): string {
  if (reason === "dry_run") return "text-blue-300";
  if (reason === "trade_mode") return "text-orange-300";
  if (reason === "permission") return "text-amber-300";
  if (reason === "broker") return "text-rose-300";
  return "text-slate-300";
}

function buildCandidates(
  journalRuns: JournalRun[],
  minConfidence: number,
  scope: DebugScope,
  liveStrategyVersion?: string,
  liveStrategyConfigHash?: string,
): CandidateSignal[] {
  return journalRuns
    .filter((run) => {
      if (scope === "all") return true;

      return (
        run.strategyVersion === liveStrategyVersion &&
        run.strategyConfigHash === liveStrategyConfigHash
      );
    })
    .flatMap((run) => {
      const strategyVersion = versionOf(run);
      const strategyConfigHash = hashOf(run);

      return run.decisions
        .filter((decision) => isBuySellSignal(decision.action))
        .map((decision) => {
          const ready = isSignalReadyDecision(decision, minConfidence);
          const signalBlockReason =
            decision.blockReasonCategory ??
            fallbackSignalBlockReason(decision, minConfidence);
          const executionBlockReason =
            decision.executionBlockReasonCategory ??
            fallbackExecutionReason(decision);
          const executionStatus =
            decision.executionStatus ?? executionBlockReason ?? "legacy";

          return {
            runId: run.id,
            timestamp: run.timestamp,
            strategyVersion,
            strategyConfigHash,
            ticker: decision.ticker,
            action: decision.action as "BUY" | "SELL",
            confidence: decision.confidence,
            skippedReason: decision.skippedReason,
            isSignalReady: ready,
            signalBlockReason: ready ? null : signalBlockReason,
            executionStatus,
            executionBlockReason,
            signalDetail: decision.blockReasonDetail,
            executionDetail: decision.executionBlockReasonDetail,
          };
        });
    })
    .sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
}

function countBy<T extends string>(
  items: T[],
): Array<{ key: T; count: number }> {
  const counts = new Map<T, number>();

  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }

  return Array.from(counts.entries()).map(([key, count]) => ({ key, count }));
}

function StatCard({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  tone?: "neutral" | "good" | "warn" | "info";
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-300"
      : tone === "warn"
        ? "text-amber-300"
        : tone === "info"
          ? "text-blue-300"
          : "text-slate-300";

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
      <div className="text-[9px] font-black uppercase text-slate-500">
        {label}
      </div>
      <div className={`text-lg font-black ${toneClass}`}>{value}</div>
    </div>
  );
}

function ScopeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-3 py-2 text-xs font-black ${
        active
          ? "bg-blue-600 text-white"
          : "bg-slate-800/80 text-slate-300 hover:bg-slate-700"
      }`}
    >
      {children}
    </button>
  );
}

function CandidateRow({ candidate }: { candidate: CandidateSignal }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-black text-slate-200">
              {candidate.ticker}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-[8px] font-black uppercase ${
                candidate.action === "BUY"
                  ? "bg-emerald-500/20 text-emerald-200"
                  : "bg-rose-500/20 text-rose-200"
              }`}
            >
              {candidate.action}
            </span>
            {candidate.isSignalReady ? (
              <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[8px] font-black uppercase text-emerald-200">
                signal ready
              </span>
            ) : (
              <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[8px] font-black uppercase text-amber-200">
                signal blocked
              </span>
            )}
            <span className="rounded-full bg-slate-700/60 px-2 py-0.5 text-[8px] font-black uppercase text-slate-200">
              exec: {candidate.executionStatus}
            </span>
          </div>

          <div className="mt-1 text-[10px] text-slate-500">
            {candidate.strategyVersion} ·{" "}
            {shortHash(candidate.strategyConfigHash)}
          </div>
        </div>

        <div className="text-right">
          <div className="text-[10px] text-slate-500">
            {formatTime(candidate.timestamp)}
          </div>
          <div className="text-sm font-black text-blue-300">
            {candidate.confidence.toFixed(2)}
          </div>
        </div>
      </div>

      {!candidate.isSignalReady && candidate.signalBlockReason && (
        <div className="mt-3 rounded-lg border border-slate-800 bg-slate-900/60 p-2 text-xs">
          <div
            className={`font-black ${toneForSignal(candidate.signalBlockReason)}`}
          >
            Signal blocked: {signalLabel(candidate.signalBlockReason)}
          </div>
          <div className="mt-1 text-[10px] text-slate-400">
            {candidate.signalDetail ??
              candidate.skippedReason ??
              "Signal failed a strategy or safety check."}
          </div>
        </div>
      )}

      {candidate.isSignalReady && candidate.executionBlockReason && (
        <div className="mt-3 rounded-lg border border-slate-800 bg-slate-900/60 p-2 text-xs">
          <div
            className={`font-black ${toneForExecution(
              candidate.executionBlockReason,
            )}`}
          >
            Execution stopped: {executionLabel(candidate.executionBlockReason)}
          </div>
          <div className="mt-1 text-[10px] text-slate-400">
            {candidate.executionDetail ??
              candidate.skippedReason ??
              "Signal was ready, but execution did not happen."}
          </div>
        </div>
      )}
    </div>
  );
}

export function ActionableSignalDebugPanel({
  journalRuns,
  minConfidence,
  liveStrategyVersion,
  liveStrategyConfigHash,
}: ActionableSignalDebugPanelProps) {
  const [scope, setScope] = useState<DebugScope>("live");

  const candidates = useMemo(
    () =>
      buildCandidates(
        journalRuns,
        minConfidence,
        scope,
        liveStrategyVersion,
        liveStrategyConfigHash,
      ),
    [
      journalRuns,
      minConfidence,
      scope,
      liveStrategyVersion,
      liveStrategyConfigHash,
    ],
  );

  const signalReadyCount = candidates.filter(
    (candidate) => candidate.isSignalReady,
  ).length;
  const signalBlockedCount = candidates.length - signalReadyCount;

  const signalBlockStats = useMemo(
    () =>
      countBy(
        candidates
          .map((candidate) => candidate.signalBlockReason)
          .filter((reason): reason is BlockReasonCategory => Boolean(reason)),
      ),
    [candidates],
  );

  const executionStopStats = useMemo(
    () =>
      countBy(
        candidates
          .map((candidate) => candidate.executionBlockReason)
          .filter((reason): reason is ExecutionBlockReasonCategory =>
            Boolean(reason),
          ),
      ),
    [candidates],
  );

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-bold tracking-wider text-slate-300">
            ACTIONABLE SIGNAL DEBUG
          </h2>
          <p className="text-[10px] text-slate-500">
            Separates signal readiness from execution status
          </p>
        </div>

        <div className="flex gap-2">
          <ScopeButton
            active={scope === "live"}
            onClick={() => setScope("live")}
          >
            Live config
          </ScopeButton>
          <ScopeButton active={scope === "all"} onClick={() => setScope("all")}>
            All variants
          </ScopeButton>
        </div>
      </div>

      <div className="mb-4 rounded-xl border border-blue-500/20 bg-blue-500/10 p-3 text-xs text-blue-100">
        A signal can be <span className="font-black">ready</span> even when
        execution is stopped by DRY-RUN. This is the correct behavior for
        strategy evaluation.
      </div>

      <div className="mb-4 grid grid-cols-3 gap-2">
        <StatCard label="Candidates" value={candidates.length} tone="info" />
        <StatCard label="Signal ready" value={signalReadyCount} tone="good" />
        <StatCard
          label="Signal blocked"
          value={signalBlockedCount}
          tone="warn"
        />
      </div>

      <div className="mb-4 rounded-xl border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-400">
        Signal-ready ratio:{" "}
        <span className="font-black text-slate-200">
          {formatPercent(signalReadyCount, candidates.length)}
        </span>
      </div>

      {(signalBlockStats.length > 0 || executionStopStats.length > 0) && (
        <div className="mb-4 grid grid-cols-1 gap-3">
          {signalBlockStats.length > 0 && (
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
              <div className="mb-2 text-[10px] font-black uppercase text-slate-500">
                Signal blocked by
              </div>
              <div className="grid grid-cols-2 gap-2">
                {signalBlockStats.map((item) => (
                  <div
                    key={item.key}
                    className="rounded-lg border border-slate-800 bg-slate-900/60 p-2"
                  >
                    <div
                      className={`text-xs font-black ${toneForSignal(item.key)}`}
                    >
                      {signalLabel(item.key)}
                    </div>
                    <div className="text-lg font-black text-slate-200">
                      {item.count}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {executionStopStats.length > 0 && (
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
              <div className="mb-2 text-[10px] font-black uppercase text-slate-500">
                Execution stopped by
              </div>
              <div className="grid grid-cols-2 gap-2">
                {executionStopStats.map((item) => (
                  <div
                    key={item.key}
                    className="rounded-lg border border-slate-800 bg-slate-900/60 p-2"
                  >
                    <div
                      className={`text-xs font-black ${toneForExecution(item.key)}`}
                    >
                      {executionLabel(item.key)}
                    </div>
                    <div className="text-lg font-black text-slate-200">
                      {item.count}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {candidates.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-400">
          No BUY/SELL candidates found for this scope. This usually means the
          strategy is currently producing HOLD-only decisions.
        </div>
      ) : (
        <div className="max-h-96 space-y-2 overflow-y-auto pr-1">
          {candidates.slice(0, 20).map((candidate) => (
            <CandidateRow
              key={`${candidate.runId}-${candidate.ticker}-${candidate.timestamp}-${candidate.action}`}
              candidate={candidate}
            />
          ))}
        </div>
      )}

      {candidates.length > 20 && (
        <div className="mt-3 text-[10px] text-slate-500">
          Showing latest 20 of {candidates.length} candidates.
        </div>
      )}
    </div>
  );
}
