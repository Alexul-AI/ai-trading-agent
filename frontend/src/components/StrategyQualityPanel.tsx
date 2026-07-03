import { useMemo, useState } from "react";
import type { AutopilotDecision, JournalRun } from "../types";
import {
  isBuySellSignal,
  isSignalReadyDecision,
} from "../utils/signalReadiness";

interface StrategyQualityPanelProps {
  journalRuns: JournalRun[];
  minConfidence: number;
}

type QualityWindow = "LAST_RUN" | "LAST_5" | "LAST_10" | "ALL";
type StrategyFilter = "LATEST" | "ALL" | string;

type PrimaryOutcome =
  | "SIGNAL_READY"
  | "CONFIDENCE"
  | "POSITION_GUARD"
  | "EXECUTION_POLICY"
  | "OTHER_BLOCKED";

interface StrategyQualityStats {
  totalRuns: number;
  totalDecisions: number;
  buySignals: number;
  sellSignals: number;
  holdSignals: number;
  buySellTotal: number;

  signalReadySignals: number;
  blockedByConfidence: number;
  blockedByPositionGuard: number;
  blockedByExecutionPolicy: number;
  otherBlocked: number;

  safetyCapReduced: number;
  positionGuardFlags: number;
  executionPolicyFlags: number;
  stopLossSignals: number;
  takeProfitSignals: number;
  executedSignals: number;
  averageConfidence: number;
  waterfallTotal: number;
}

interface TickerQualityStats {
  ticker: string;
  total: number;
  buy: number;
  sell: number;
  hold: number;
  buySellTotal: number;
  signalReady: number;
  blockedByConfidence: number;
  blockedByPositionGuard: number;
  blockedByExecutionPolicy: number;
  otherBlocked: number;
  safetyCapReduced: number;
  averageConfidence: number;
  lastDecision: AutopilotDecision | null;
  lastRunAt: string | null;
}

function includesAny(text: string, patterns: string[]): boolean {
  const normalized = text.toLowerCase();
  return patterns.some((pattern) => normalized.includes(pattern));
}

function getDecisionText(decision: {
  skippedReason?: string;
  safetyNote?: string;
  reason?: string;
}): string {
  return `${decision.skippedReason ?? ""} ${decision.safetyNote ?? ""} ${
    decision.reason ?? ""
  }`;
}

function hasPositionGuard(decision: {
  skippedReason?: string;
  safetyNote?: string;
  reason?: string;
}): boolean {
  return includesAny(getDecisionText(decision), ["position guard"]);
}

function hasExecutionPolicy(decision: {
  skippedReason?: string;
  safetyNote?: string;
  reason?: string;
}): boolean {
  return includesAny(getDecisionText(decision), [
    "dry-run",
    "execution disabled",
    "execute_trades=false",
    "not allowed",
    "buy is disabled",
    "sell is disabled",
    "trade_mode",
    "live trading",
  ]);
}

function hasSafetyCapReduced(decision: {
  skippedReason?: string;
  safetyNote?: string;
  reason?: string;
}): boolean {
  return includesAny(getDecisionText(decision), [
    "safety cap",
    "reduced sell",
    "reduced from",
  ]);
}

function hasConfidenceBlock(
  decision: {
    confidence: number;
    skippedReason?: string;
    safetyNote?: string;
    reason?: string;
  },
  minConfidence: number,
): boolean {
  if (decision.confidence < minConfidence) return true;

  return includesAny(getDecisionText(decision), [
    "confidence",
    "below min",
    "below threshold",
  ]);
}

function classifyPrimaryOutcome(
  decision: AutopilotDecision,
  minConfidence: number,
): PrimaryOutcome {
  if (isSignalReadyDecision(decision, minConfidence)) {
    return "SIGNAL_READY";
  }

  // Waterfall rule:
  // final skippedReason wins over secondary flags.
  // Position guard is checked before confidence because in the backend it is
  // the final reason for blocking a normal SELL below average entry.
  if (hasPositionGuard(decision)) {
    return "POSITION_GUARD";
  }

  if (hasConfidenceBlock(decision, minConfidence)) {
    return "CONFIDENCE";
  }

  if (hasExecutionPolicy(decision)) {
    return "EXECUTION_POLICY";
  }

  return "OTHER_BLOCKED";
}

function calculateStats(
  journalRuns: JournalRun[],
  minConfidence: number,
): StrategyQualityStats {
  const decisions = journalRuns.flatMap((run) => run.decisions);
  const buySellDecisions = decisions.filter((decision) =>
    isBuySellSignal(decision.action),
  );

  const outcomes = buySellDecisions.map((decision) =>
    classifyPrimaryOutcome(decision, minConfidence),
  );

  const confidenceValues = buySellDecisions.map(
    (decision) => decision.confidence,
  );
  const averageConfidence =
    confidenceValues.length === 0
      ? 0
      : confidenceValues.reduce((sum, value) => sum + value, 0) /
        confidenceValues.length;

  const signalReadySignals = outcomes.filter(
    (outcome) => outcome === "SIGNAL_READY",
  ).length;
  const blockedByConfidence = outcomes.filter(
    (outcome) => outcome === "CONFIDENCE",
  ).length;
  const blockedByPositionGuard = outcomes.filter(
    (outcome) => outcome === "POSITION_GUARD",
  ).length;
  const blockedByExecutionPolicy = outcomes.filter(
    (outcome) => outcome === "EXECUTION_POLICY",
  ).length;
  const otherBlocked = outcomes.filter(
    (outcome) => outcome === "OTHER_BLOCKED",
  ).length;

  return {
    totalRuns: journalRuns.length,
    totalDecisions: decisions.length,
    buySignals: decisions.filter((decision) => decision.action === "BUY")
      .length,
    sellSignals: decisions.filter((decision) => decision.action === "SELL")
      .length,
    holdSignals: decisions.filter((decision) => decision.action === "HOLD")
      .length,
    buySellTotal: buySellDecisions.length,

    signalReadySignals,
    blockedByConfidence,
    blockedByPositionGuard,
    blockedByExecutionPolicy,
    otherBlocked,

    safetyCapReduced: buySellDecisions.filter(hasSafetyCapReduced).length,
    positionGuardFlags: buySellDecisions.filter(hasPositionGuard).length,
    executionPolicyFlags: buySellDecisions.filter(hasExecutionPolicy).length,
    stopLossSignals: decisions.filter(
      (decision) => decision.reasonType === "STOP_LOSS",
    ).length,
    takeProfitSignals: decisions.filter(
      (decision) => decision.reasonType === "TAKE_PROFIT",
    ).length,
    executedSignals: decisions.filter((decision) => decision.executed).length,
    averageConfidence,
    waterfallTotal:
      signalReadySignals +
      blockedByConfidence +
      blockedByPositionGuard +
      blockedByExecutionPolicy +
      otherBlocked,
  };
}

function calculateTickerStats(
  journalRuns: JournalRun[],
  minConfidence: number,
): TickerQualityStats[] {
  const byTicker = new Map<
    string,
    Array<{ decision: AutopilotDecision; runTimestamp: string }>
  >();

  for (const run of journalRuns) {
    for (const decision of run.decisions) {
      byTicker.set(decision.ticker, [
        ...(byTicker.get(decision.ticker) ?? []),
        {
          decision,
          runTimestamp: run.timestamp,
        },
      ]);
    }
  }

  return Array.from(byTicker.entries())
    .map(([ticker, entries]) => {
      const decisions = entries.map((entry) => entry.decision);
      const buySellDecisions = decisions.filter((decision) =>
        isBuySellSignal(decision.action),
      );
      const outcomes = buySellDecisions.map((decision) =>
        classifyPrimaryOutcome(decision, minConfidence),
      );
      const confidenceValues = buySellDecisions.map(
        (decision) => decision.confidence,
      );
      const averageConfidence =
        confidenceValues.length === 0
          ? 0
          : confidenceValues.reduce((sum, value) => sum + value, 0) /
            confidenceValues.length;

      const sortedEntries = [...entries].sort(
        (a, b) =>
          new Date(b.runTimestamp).getTime() -
          new Date(a.runTimestamp).getTime(),
      );

      return {
        ticker,
        total: decisions.length,
        buy: decisions.filter((decision) => decision.action === "BUY").length,
        sell: decisions.filter((decision) => decision.action === "SELL").length,
        hold: decisions.filter((decision) => decision.action === "HOLD").length,
        buySellTotal: buySellDecisions.length,
        signalReady: outcomes.filter((outcome) => outcome === "SIGNAL_READY")
          .length,
        blockedByConfidence: outcomes.filter(
          (outcome) => outcome === "CONFIDENCE",
        ).length,
        blockedByPositionGuard: outcomes.filter(
          (outcome) => outcome === "POSITION_GUARD",
        ).length,
        blockedByExecutionPolicy: outcomes.filter(
          (outcome) => outcome === "EXECUTION_POLICY",
        ).length,
        otherBlocked: outcomes.filter((outcome) => outcome === "OTHER_BLOCKED")
          .length,
        safetyCapReduced: buySellDecisions.filter(hasSafetyCapReduced).length,
        averageConfidence,
        lastDecision: sortedEntries[0]?.decision ?? null,
        lastRunAt: sortedEntries[0]?.runTimestamp ?? null,
      };
    })
    .sort((a, b) => {
      if (b.buySellTotal !== a.buySellTotal) {
        return b.buySellTotal - a.buySellTotal;
      }

      if (b.total !== a.total) {
        return b.total - a.total;
      }

      return a.ticker.localeCompare(b.ticker);
    });
}

function qualityRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 100);
}

function StatCard({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  tone?: "neutral" | "good" | "warn" | "bad" | "info";
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-300"
      : tone === "warn"
        ? "text-amber-300"
        : tone === "bad"
          ? "text-rose-300"
          : tone === "info"
            ? "text-blue-300"
            : "text-slate-300";

  return (
    <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-2">
      <div className="text-[9px] text-slate-500 font-black uppercase">
        {label}
      </div>
      <div className={`text-lg font-black ${toneClass}`}>{value}</div>
    </div>
  );
}

function BarRow({
  label,
  value,
  total,
  tone = "neutral",
}: {
  label: string;
  value: number;
  total: number;
  tone?: "neutral" | "good" | "warn" | "bad" | "info";
}) {
  const percent = qualityRatio(value, total);
  const barClass =
    tone === "good"
      ? "bg-emerald-400"
      : tone === "warn"
        ? "bg-amber-400"
        : tone === "bad"
          ? "bg-rose-400"
          : tone === "info"
            ? "bg-blue-400"
            : "bg-slate-500";

  return (
    <div>
      <div className="flex items-center justify-between text-[10px] mb-1">
        <span className="text-slate-400">{label}</span>
        <span className="text-slate-500 font-mono">
          {value} / {total} · {percent}%
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
        <div
          className={`h-full rounded-full ${barClass}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function FlagRow({
  label,
  value,
  total,
}: {
  label: string;
  value: number;
  total: number;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-[10px]">
      <span className="text-slate-400">{label}</span>
      <span className="font-mono text-slate-300">
        {value} / {total}
      </span>
    </div>
  );
}

function actionTone(action: string): string {
  if (action === "BUY") return "text-emerald-300";
  if (action === "SELL") return "text-rose-300";
  return "text-slate-400";
}

function formatLastRun(value: string | null): string {
  if (!value) return "—";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleTimeString();
}

function getWindowLabel(window: QualityWindow): string {
  if (window === "LAST_RUN") return "Last run";
  if (window === "LAST_5") return "Last 5";
  if (window === "LAST_10") return "Last 10";
  return "All";
}

function getRunStrategyVersion(run: JournalRun): string {
  return run.strategyVersion ?? "legacy";
}

function getStrategyFilterLabel(
  filter: StrategyFilter,
  latestVersion: string | null,
): string {
  if (filter === "ALL") return "All strategies";
  if (filter === "LATEST")
    return latestVersion ? `Latest: ${latestVersion}` : "Latest";
  return filter;
}

function getUniqueStrategyVersions(journalRuns: JournalRun[]): string[] {
  return Array.from(new Set(journalRuns.map(getRunStrategyVersion))).sort();
}

function filterRunsByStrategy(
  journalRuns: JournalRun[],
  filter: StrategyFilter,
  latestVersion: string | null,
): JournalRun[] {
  if (filter === "ALL") return journalRuns;

  const versionToUse = filter === "LATEST" ? latestVersion : filter;

  if (!versionToUse) return journalRuns;

  return journalRuns.filter(
    (run) => getRunStrategyVersion(run) === versionToUse,
  );
}

function formatCoverageDuration(journalRuns: JournalRun[]): string {
  if (journalRuns.length === 0) return "No runs";
  if (journalRuns.length === 1) return "Single run";

  const latest = new Date(journalRuns[0]?.timestamp ?? "").getTime();
  const oldest = new Date(
    journalRuns[journalRuns.length - 1]?.timestamp ?? "",
  ).getTime();

  if (!Number.isFinite(latest) || !Number.isFinite(oldest)) {
    return "Coverage unavailable";
  }

  const diffMs = Math.abs(latest - oldest);
  const diffMinutes = Math.round(diffMs / 60000);

  if (diffMinutes < 1) return "Covers <1 minute";
  if (diffMinutes < 60)
    return `Covers ${diffMinutes} minute${diffMinutes === 1 ? "" : "s"}`;

  const diffHours = Math.round(diffMinutes / 60);

  if (diffHours < 48)
    return `Covers ${diffHours} hour${diffHours === 1 ? "" : "s"}`;

  const diffDays = Math.round(diffHours / 24);
  return `Covers ${diffDays} day${diffDays === 1 ? "" : "s"}`;
}

function getRequestedWindowCount(window: QualityWindow): number | null {
  if (window === "LAST_RUN") return 1;
  if (window === "LAST_5") return 5;
  if (window === "LAST_10") return 10;
  return null;
}

function filterRunsByWindow(
  journalRuns: JournalRun[],
  window: QualityWindow,
): JournalRun[] {
  if (window === "ALL") return journalRuns;

  const count = getRequestedWindowCount(window) ?? journalRuns.length;

  return journalRuns.slice(0, count);
}

export function StrategyQualityPanel({
  journalRuns,
  minConfidence,
}: StrategyQualityPanelProps) {
  const [qualityWindow, setQualityWindow] = useState<QualityWindow>("LAST_10");
  const [strategyFilter, setStrategyFilter] =
    useState<StrategyFilter>("LATEST");

  const latestStrategyVersion = journalRuns[0]
    ? getRunStrategyVersion(journalRuns[0])
    : null;

  const strategyVersions = useMemo(
    () => getUniqueStrategyVersions(journalRuns),
    [journalRuns],
  );

  const strategyFilteredRuns = useMemo(
    () =>
      filterRunsByStrategy(journalRuns, strategyFilter, latestStrategyVersion),
    [journalRuns, latestStrategyVersion, strategyFilter],
  );

  const filteredJournalRuns = useMemo(
    () => filterRunsByWindow(strategyFilteredRuns, qualityWindow),
    [qualityWindow, strategyFilteredRuns],
  );

  const coverageLabel = useMemo(
    () => formatCoverageDuration(filteredJournalRuns),
    [filteredJournalRuns],
  );

  const requestedWindowCount = getRequestedWindowCount(qualityWindow);
  const isWindowUndersupplied =
    requestedWindowCount !== null &&
    strategyFilteredRuns.length > 0 &&
    strategyFilteredRuns.length < requestedWindowCount;

  const stats = calculateStats(filteredJournalRuns, minConfidence);
  const tickerStats = calculateTickerStats(filteredJournalRuns, minConfidence);
  const signalReadyRatio = qualityRatio(
    stats.signalReadySignals,
    stats.buySellTotal,
  );
  const confidenceBlockedRatio = qualityRatio(
    stats.blockedByConfidence,
    stats.buySellTotal,
  );
  const waterfallMatchesTotal = stats.waterfallTotal === stats.buySellTotal;
  const isHoldOnlyWindow =
    stats.totalDecisions > 0 &&
    stats.buySellTotal === 0 &&
    stats.holdSignals > 0;

  const verdict = isHoldOnlyWindow
    ? "Latest analysis window is HOLD-only: the strategy filtered out weak BUY/SELL setups."
    : stats.buySellTotal === 0
      ? "No BUY/SELL signal history yet."
      : stats.signalReadySignals === 0
        ? "Strategy is still observational: signals exist, but none are signal-ready."
        : signalReadyRatio < 20
          ? "Strategy is conservative: most signals are filtered before execution."
          : "Strategy is producing signal-ready candidates. Review them carefully before execution.";

  return (
    <div className="bg-slate-900/60 rounded-2xl border border-slate-800 p-4">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-sm font-bold tracking-wider text-slate-300">
            STRATEGY QUALITY
          </h2>
          <p className="text-[10px] text-slate-500">
            Waterfall outcome + overlapping safety flags from Autopilot journal
          </p>
        </div>

        <div className="text-right">
          <div className="text-[9px] text-slate-500 font-black uppercase">
            Min confidence
          </div>
          <div className="text-xs font-black text-emerald-300">
            {minConfidence}
          </div>
        </div>
      </div>

      <div className="mb-4 rounded-xl border border-slate-800 bg-slate-950/40 p-2">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-[10px] text-slate-400 font-black uppercase">
                Strategy filter
              </div>
              <div className="text-[9px] text-slate-500">
                {getStrategyFilterLabel(strategyFilter, latestStrategyVersion)}
                {latestStrategyVersion && (
                  <>
                    {" "}
                    · latest version:{" "}
                    <span className="text-blue-300">
                      {latestStrategyVersion}
                    </span>
                  </>
                )}
              </div>
            </div>

            <select
              value={strategyFilter}
              onChange={(event) => setStrategyFilter(event.target.value)}
              className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-slate-600"
            >
              <option value="LATEST">Latest strategy</option>
              <option value="ALL">All strategies</option>
              {strategyVersions.map((version) => (
                <option key={version} value={version}>
                  {version}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-[10px] text-slate-400 font-black uppercase">
                Analysis window
              </div>
              <div className="text-[9px] text-slate-500">
                Showing {getWindowLabel(qualityWindow)} · {stats.totalRuns} of{" "}
                {strategyFilteredRuns.length} filtered runs
              </div>
            </div>

            <div className="grid grid-cols-4 gap-1">
              {(
                ["LAST_RUN", "LAST_5", "LAST_10", "ALL"] as QualityWindow[]
              ).map((window) => (
                <button
                  key={window}
                  onClick={() => setQualityWindow(window)}
                  className={`rounded-lg px-2 py-1 text-[10px] font-black transition-colors ${
                    qualityWindow === window
                      ? "bg-blue-600 text-white"
                      : "bg-slate-900 text-slate-400 hover:bg-slate-800"
                  }`}
                >
                  {getWindowLabel(window)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-3">
        <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
          <div className="text-[9px] text-slate-500 font-black uppercase">
            Coverage
          </div>
          <div className="text-xs font-black text-blue-300">
            {coverageLabel}
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
          <div className="text-[9px] text-slate-500 font-black uppercase">
            Filtered runs
          </div>
          <div className="text-xs font-black text-slate-200">
            {stats.totalRuns} / {strategyFilteredRuns.length}
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
          <div className="text-[9px] text-slate-500 font-black uppercase">
            Strategy
          </div>
          <div className="truncate text-xs font-black text-emerald-300">
            {getStrategyFilterLabel(strategyFilter, latestStrategyVersion)}
          </div>
        </div>
      </div>

      {isWindowUndersupplied && (
        <div className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-[10px] text-amber-200">
          You selected {getWindowLabel(qualityWindow)}, but this strategy filter
          currently has only {strategyFilteredRuns.length} run
          {strategyFilteredRuns.length === 1 ? "" : "s"}. Run Autopilot more
          times to build a larger comparison window.
        </div>
      )}

      {isHoldOnlyWindow && (
        <div className="mb-4 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3">
          <div className="text-[10px] font-black uppercase text-emerald-300">
            HOLD-only window
          </div>
          <div className="mt-1 text-xs leading-relaxed text-emerald-100">
            This window has {stats.holdSignals} HOLD decisions and no BUY/SELL
            candidates. That usually means the confluence filter is doing its
            job: weak setups are watched, not traded.
          </div>
        </div>
      )}

      <div className="grid grid-cols-4 gap-2 mb-4">
        <StatCard label="Runs" value={stats.totalRuns} />
        <StatCard label="BUY" value={stats.buySignals} tone="good" />
        <StatCard label="SELL" value={stats.sellSignals} tone="bad" />
        <StatCard label="HOLD" value={stats.holdSignals} />
      </div>

      <div className="grid grid-cols-4 gap-2 mb-4">
        <StatCard label="BUY/SELL" value={stats.buySellTotal} tone="info" />
        <StatCard
          label="Signal Ready"
          value={stats.signalReadySignals}
          tone={stats.signalReadySignals > 0 ? "good" : "neutral"}
        />
        <StatCard
          label="Blocked"
          value={stats.buySellTotal - stats.signalReadySignals}
          tone={
            stats.buySellTotal > stats.signalReadySignals ? "warn" : "neutral"
          }
        />
        <StatCard
          label="Avg conf"
          value={
            stats.buySellTotal > 0 ? stats.averageConfidence.toFixed(2) : "N/A"
          }
          tone="info"
        />
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 mb-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-[10px] text-slate-400 font-black uppercase">
              Primary outcome waterfall
            </div>
            <div className="text-[9px] text-slate-500">
              Mutually exclusive. Signal Ready means the strategy signal passed;
              dry-run execution does not make it blocked.
            </div>
          </div>
          <div
            className={`text-[10px] font-mono ${
              waterfallMatchesTotal ? "text-emerald-300" : "text-rose-300"
            }`}
          >
            {stats.waterfallTotal} / {stats.buySellTotal}
          </div>
        </div>

        {stats.buySellTotal === 0 ? (
          <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-xs text-slate-400">
            No BUY/SELL candidates in this window. The waterfall is empty
            because every ticker ended as HOLD.
          </div>
        ) : (
          <div className="space-y-3">
            <BarRow
              label="Signal Ready"
              value={stats.signalReadySignals}
              total={stats.buySellTotal}
              tone="good"
            />
            <BarRow
              label="Blocked by confidence"
              value={stats.blockedByConfidence}
              total={stats.buySellTotal}
              tone="warn"
            />
            <BarRow
              label="Blocked by position guard"
              value={stats.blockedByPositionGuard}
              total={stats.buySellTotal}
              tone="bad"
            />
            <BarRow
              label="Blocked by execution policy"
              value={stats.blockedByExecutionPolicy}
              total={stats.buySellTotal}
              tone="info"
            />
            <BarRow
              label="Other blocked"
              value={stats.otherBlocked}
              total={stats.buySellTotal}
            />
          </div>
        )}
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 mb-4">
        <div className="mb-3">
          <div className="text-[10px] text-slate-400 font-black uppercase">
            Safety / modifier flags
          </div>
          <div className="text-[9px] text-slate-500">
            These can overlap and do not need to sum to total BUY/SELL.
          </div>
        </div>

        {stats.buySellTotal === 0 ? (
          <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-xs text-slate-400">
            No safety modifier flags in this window because there were no
            BUY/SELL candidates.
          </div>
        ) : (
          <div className="space-y-2">
            <FlagRow
              label="Reduced by safety cap"
              value={stats.safetyCapReduced}
              total={stats.buySellTotal}
            />
            <FlagRow
              label="Has position guard note"
              value={stats.positionGuardFlags}
              total={stats.buySellTotal}
            />
            <FlagRow
              label="Dry-run / execution policy flag"
              value={stats.executionPolicyFlags}
              total={stats.buySellTotal}
            />
          </div>
        )}
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 mb-4">
        <div className="mb-3">
          <div className="text-[10px] text-slate-400 font-black uppercase">
            Per-ticker breakdown
          </div>
          <div className="text-[9px] text-slate-500">
            Which tickers produce BUY/SELL signals and why they are blocked.
          </div>
        </div>

        <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
          {tickerStats.length === 0 ? (
            <div className="text-center text-slate-600 py-6 text-xs">
              No ticker history yet.
            </div>
          ) : (
            tickerStats.map((ticker) => {
              const signalReadyPercent = qualityRatio(
                ticker.signalReady,
                ticker.buySellTotal,
              );

              return (
                <div
                  key={ticker.ticker}
                  className="rounded-xl border border-slate-800 bg-slate-950/50 p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-black text-white">
                        {ticker.ticker}
                      </div>
                      <div className="mt-1 text-[10px] text-slate-500">
                        BUY {ticker.buy} · SELL {ticker.sell} · HOLD{" "}
                        {ticker.hold}
                      </div>
                    </div>

                    <div className="text-right">
                      <div className="text-xs font-black text-blue-300">
                        {ticker.buySellTotal > 0
                          ? ticker.averageConfidence.toFixed(2)
                          : "N/A"}
                      </div>
                      <div className="text-[9px] text-slate-500 uppercase">
                        avg conf
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-4 gap-2 mt-3 text-[10px]">
                    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-2">
                      <div className="text-slate-500 font-black uppercase">
                        Signals
                      </div>
                      <div className="font-mono text-slate-300">
                        {ticker.buySellTotal}
                      </div>
                    </div>
                    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-2">
                      <div className="text-slate-500 font-black uppercase">
                        Action
                      </div>
                      <div className="font-mono text-emerald-300">
                        {ticker.signalReady}
                      </div>
                    </div>
                    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-2">
                      <div className="text-slate-500 font-black uppercase">
                        Conf
                      </div>
                      <div className="font-mono text-amber-300">
                        {ticker.blockedByConfidence}
                      </div>
                    </div>
                    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-2">
                      <div className="text-slate-500 font-black uppercase">
                        Guard
                      </div>
                      <div className="font-mono text-rose-300">
                        {ticker.blockedByPositionGuard}
                      </div>
                    </div>
                  </div>

                  <div className="mt-3">
                    <div className="flex items-center justify-between text-[10px] mb-1">
                      <span className="text-slate-500">Signal-ready ratio</span>
                      <span className="text-slate-500 font-mono">
                        {ticker.signalReady} / {ticker.buySellTotal} ·{" "}
                        {signalReadyPercent}%
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-emerald-400"
                        style={{ width: `${signalReadyPercent}%` }}
                      />
                    </div>
                  </div>

                  {ticker.buySellTotal === 0 && ticker.hold > 0 && (
                    <div className="mt-2 text-[10px] text-emerald-300">
                      HOLD-only in this window. No BUY/SELL candidate was
                      emitted.
                    </div>
                  )}

                  {ticker.safetyCapReduced > 0 && (
                    <div className="mt-2 text-[10px] text-amber-300">
                      Safety cap reduced {ticker.safetyCapReduced} signal
                      {ticker.safetyCapReduced === 1 ? "" : "s"}.
                    </div>
                  )}

                  {ticker.lastDecision && (
                    <div className="mt-2 rounded-lg border border-slate-800 bg-slate-900/70 p-2 text-[10px]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-500">
                          Last:{" "}
                          <span
                            className={`font-black ${actionTone(
                              ticker.lastDecision.action,
                            )}`}
                          >
                            {ticker.lastDecision.action}
                          </span>{" "}
                          conf {ticker.lastDecision.confidence}
                        </span>
                        <span className="text-slate-600">
                          {formatLastRun(ticker.lastRunAt)}
                        </span>
                      </div>
                      {ticker.lastDecision.skippedReason && (
                        <div className="mt-1 text-slate-500">
                          {ticker.lastDecision.skippedReason}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-4">
        <StatCard label="STOP LOSS" value={stats.stopLossSignals} tone="bad" />
        <StatCard
          label="TAKE PROFIT"
          value={stats.takeProfitSignals}
          tone="good"
        />
        <StatCard
          label="Executed"
          value={stats.executedSignals}
          tone={stats.executedSignals > 0 ? "bad" : "neutral"}
        />
      </div>

      {qualityWindow !== "ALL" &&
        strategyFilteredRuns.length > filteredJournalRuns.length && (
          <div className="mb-4 rounded-xl border border-blue-500/20 bg-blue-500/10 p-3 text-[10px] text-blue-200">
            Older journal runs for this strategy filter are hidden in this view.
            Use ALL only when you want long-term history, not quick validation
            after a strategy change.
          </div>
        )}

      <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-xs text-slate-300 leading-relaxed">
        <span className="font-black text-slate-200">Verdict: </span>
        {verdict}
        {confidenceBlockedRatio >= 60 && (
          <div className="mt-2 text-[10px] text-amber-300">
            Most BUY/SELL signals are below confidence threshold. Tune strategy
            only after collecting more journal runs.
          </div>
        )}
        {!waterfallMatchesTotal && (
          <div className="mt-2 text-[10px] text-rose-300">
            Waterfall mismatch detected. Review decision classification rules.
          </div>
        )}
      </div>
    </div>
  );
}
