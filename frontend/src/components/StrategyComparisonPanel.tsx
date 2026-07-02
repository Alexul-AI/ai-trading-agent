import { useMemo, useState } from "react";
import type { JournalRun } from "../types";

interface StrategyComparisonPanelProps {
  journalRuns: JournalRun[];
  minConfidence: number;
  liveStrategyVersion?: string;
  liveStrategyConfigHash?: string;
}

interface StrategyVariantStats {
  key: string;
  version: string;
  hash: string;
  runs: number;
  decisions: number;
  buy: number;
  sell: number;
  hold: number;
  buySell: number;
  actionable: number;
  blocked: number;
  confidenceSum: number;
  confidenceCount: number;
  firstRunAt: string;
  lastRunAt: string;
}

const WINNER_MIN_RUNS = 10;
const LOW_RUN_THRESHOLD = 5;

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

function formatPercent(numerator: number, denominator: number): string {
  if (denominator <= 0) return "N/A";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return -1;
  return numerator / denominator;
}

function avgConfidenceValue(stats: StrategyVariantStats): number {
  if (stats.confidenceCount <= 0) return -1;
  return stats.confidenceSum / stats.confidenceCount;
}

function formatConfidence(value: number, count: number): string {
  if (count <= 0) return "N/A";
  return (value / count).toFixed(2);
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}

function isLegacy(stats: StrategyVariantStats): boolean {
  return stats.version === "legacy" || stats.hash === "no-hash";
}

function isActionableDecision(
  decision: JournalRun["decisions"][number],
  minConfidence: number,
): boolean {
  return (
    decision.action !== "HOLD" &&
    decision.confidence >= minConfidence &&
    !decision.skippedReason
  );
}

function createVariantStats(run: JournalRun): StrategyVariantStats {
  const version = versionOf(run);
  const hash = hashOf(run);

  return {
    key: `${version}::${hash}`,
    version,
    hash,
    runs: 0,
    decisions: 0,
    buy: 0,
    sell: 0,
    hold: 0,
    buySell: 0,
    actionable: 0,
    blocked: 0,
    confidenceSum: 0,
    confidenceCount: 0,
    firstRunAt: run.timestamp,
    lastRunAt: run.timestamp,
  };
}

function buildStats(
  journalRuns: JournalRun[],
  minConfidence: number,
): StrategyVariantStats[] {
  const byVariant = new Map<string, StrategyVariantStats>();

  for (const run of journalRuns) {
    const version = versionOf(run);
    const hash = hashOf(run);
    const key = `${version}::${hash}`;
    const stats = byVariant.get(key) ?? createVariantStats(run);

    stats.runs += 1;
    stats.decisions += run.decisions.length;
    stats.actionable += run.actionableCount ?? 0;

    if (
      new Date(run.timestamp).getTime() < new Date(stats.firstRunAt).getTime()
    ) {
      stats.firstRunAt = run.timestamp;
    }

    if (
      new Date(run.timestamp).getTime() > new Date(stats.lastRunAt).getTime()
    ) {
      stats.lastRunAt = run.timestamp;
    }

    for (const decision of run.decisions) {
      if (decision.action === "BUY") {
        stats.buy += 1;
        stats.buySell += 1;
      } else if (decision.action === "SELL") {
        stats.sell += 1;
        stats.buySell += 1;
      } else {
        stats.hold += 1;
      }

      if (decision.action !== "HOLD") {
        stats.confidenceSum += decision.confidence;
        stats.confidenceCount += 1;

        if (!isActionableDecision(decision, minConfidence)) {
          stats.blocked += 1;
        }
      }
    }

    byVariant.set(key, stats);
  }

  return Array.from(byVariant.values()).sort((a, b) => {
    const lastRunDiff =
      new Date(b.lastRunAt).getTime() - new Date(a.lastRunAt).getTime();

    if (lastRunDiff !== 0) return lastRunDiff;
    return b.runs - a.runs;
  });
}

function chooseWinner(
  stats: StrategyVariantStats[],
): StrategyVariantStats | null {
  const eligible = stats.filter(
    (variant) => variant.runs >= WINNER_MIN_RUNS && variant.buySell > 0,
  );

  if (eligible.length === 0) return null;

  return [...eligible].sort((a, b) => {
    const actionableDiff =
      ratio(b.actionable, b.buySell) - ratio(a.actionable, a.buySell);

    if (actionableDiff !== 0) return actionableDiff;

    const confidenceDiff = avgConfidenceValue(b) - avgConfidenceValue(a);

    if (confidenceDiff !== 0) return confidenceDiff;

    return b.runs - a.runs;
  })[0];
}

function StatPill({
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
    <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-2">
      <div className="text-[9px] font-black uppercase text-slate-500">
        {label}
      </div>
      <div className={`text-sm font-black ${toneClass}`}>{value}</div>
    </div>
  );
}

function FilterToggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2 text-xs text-slate-300 hover:border-slate-700">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-3 w-3 accent-blue-500"
      />
      <span>{label}</span>
    </label>
  );
}

function WinnerSummary({ winner }: { winner: StrategyVariantStats | null }) {
  if (!winner) {
    return (
      <div className="mb-4 rounded-xl border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-400">
        🏆 No winner yet. A variant needs at least {WINNER_MIN_RUNS} runs and at
        least one BUY/SELL candidate to be ranked.
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
      <div className="text-xs font-black text-amber-200">
        🏆 Current winner: {winner.version}
      </div>
      <div className="mt-1 text-[10px] text-amber-100">
        hash {shortHash(winner.hash)} · actionable ratio{" "}
        <span className="font-black">
          {formatPercent(winner.actionable, winner.buySell)}
        </span>{" "}
        · avg confidence{" "}
        <span className="font-black">
          {formatConfidence(winner.confidenceSum, winner.confidenceCount)}
        </span>{" "}
        · runs <span className="font-black">{winner.runs}</span>
      </div>
    </div>
  );
}

function VariantRow({
  stats,
  isLive,
  isWinner,
}: {
  stats: StrategyVariantStats;
  isLive: boolean;
  isWinner: boolean;
}) {
  const holdRatio = formatPercent(stats.hold, stats.decisions);
  const actionableRatio = formatPercent(stats.actionable, stats.buySell);
  const avgConfidence = formatConfidence(
    stats.confidenceSum,
    stats.confidenceCount,
  );

  return (
    <div
      className={`rounded-2xl border p-3 ${
        isWinner
          ? "border-amber-500/40 bg-amber-500/10"
          : isLive
            ? "border-emerald-500/30 bg-emerald-500/10"
            : "border-slate-800 bg-slate-950/40"
      }`}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="truncate text-sm font-black text-slate-200">
              {isWinner ? "🏆 " : ""}
              {stats.version}
            </div>
            {isLive && (
              <div className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[8px] font-black uppercase text-emerald-200">
                live
              </div>
            )}
            {isWinner && (
              <div className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[8px] font-black uppercase text-amber-200">
                winner
              </div>
            )}
          </div>
          <div className="mt-1 font-mono text-[10px] text-slate-500">
            hash: {shortHash(stats.hash)}
          </div>
        </div>

        <div className="text-right text-[10px] text-slate-500">
          <div>last run</div>
          <div className="font-mono text-slate-300">
            {formatTime(stats.lastRunAt)}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <StatPill label="Runs" value={stats.runs} tone="info" />
        <StatPill label="Decisions" value={stats.decisions} />
        <StatPill label="HOLD ratio" value={holdRatio} tone="warn" />
        <StatPill label="BUY" value={stats.buy} tone="good" />
        <StatPill label="SELL" value={stats.sell} tone="warn" />
        <StatPill label="BUY/SELL" value={stats.buySell} tone="info" />
        <StatPill label="Actionable" value={stats.actionable} tone="good" />
        <StatPill label="Blocked" value={stats.blocked} tone="warn" />
        <StatPill label="Avg conf" value={avgConfidence} tone="info" />
      </div>

      <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/40 p-2 text-[10px] text-slate-400">
        Actionable ratio among BUY/SELL candidates:{" "}
        <span className="font-black text-slate-200">{actionableRatio}</span>
      </div>
    </div>
  );
}

export function StrategyComparisonPanel({
  journalRuns,
  minConfidence,
  liveStrategyVersion,
  liveStrategyConfigHash,
}: StrategyComparisonPanelProps) {
  const [hideLegacy, setHideLegacy] = useState(false);
  const [hideLowRunVariants, setHideLowRunVariants] = useState(false);

  const allStats = useMemo(
    () => buildStats(journalRuns, minConfidence),
    [journalRuns, minConfidence],
  );

  const visibleStats = useMemo(
    () =>
      allStats.filter((variant) => {
        if (hideLegacy && isLegacy(variant)) return false;
        if (hideLowRunVariants && variant.runs < LOW_RUN_THRESHOLD)
          return false;
        return true;
      }),
    [allStats, hideLegacy, hideLowRunVariants],
  );

  const winner = useMemo(() => chooseWinner(visibleStats), [visibleStats]);

  if (journalRuns.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="text-sm font-bold tracking-wider text-slate-300">
          STRATEGY COMPARISON
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          No journal runs yet. Run Autopilot once to start collecting comparison
          data.
        </p>
      </div>
    );
  }

  const liveKey =
    liveStrategyVersion && liveStrategyConfigHash
      ? `${liveStrategyVersion}::${liveStrategyConfigHash}`
      : null;

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-bold tracking-wider text-slate-300">
            STRATEGY COMPARISON
          </h2>
          <p className="text-[10px] text-slate-500">
            Compare journal results by strategy version and config hash
          </p>
        </div>

        <div className="text-right">
          <div className="text-[9px] font-black uppercase text-slate-500">
            Variants
          </div>
          <div className="text-xs font-black text-blue-300">
            {visibleStats.length} / {allStats.length}
          </div>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <FilterToggle
          checked={hideLegacy}
          onChange={setHideLegacy}
          label="Hide legacy"
        />
        <FilterToggle
          checked={hideLowRunVariants}
          onChange={setHideLowRunVariants}
          label={`Hide variants with < ${LOW_RUN_THRESHOLD} runs`}
        />
      </div>

      <WinnerSummary winner={winner} />

      {allStats.length === 1 && (
        <div className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200">
          Only one strategy/config variant exists in the journal. Change config
          or run another strategy version to compare.
        </div>
      )}

      {visibleStats.length === 0 && (
        <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-400">
          No variants match the current filters.
        </div>
      )}

      <div className="space-y-3">
        {visibleStats.map((variant) => (
          <VariantRow
            key={variant.key}
            stats={variant}
            isLive={liveKey === variant.key}
            isWinner={winner?.key === variant.key}
          />
        ))}
      </div>
    </div>
  );
}
