import type { JournalRun } from "../types";

interface StrategyQualityPanelProps {
  journalRuns: JournalRun[];
  minConfidence: number;
}

type PrimaryOutcome =
  | "ACTIONABLE"
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

  actionableSignals: number;
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

function isBuySellSignal(action: string): boolean {
  return action === "BUY" || action === "SELL";
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
  decision: {
    action: string;
    confidence: number;
    suggestedShares: number;
    skippedReason?: string;
    safetyNote?: string;
    reason?: string;
  },
  minConfidence: number,
): PrimaryOutcome {
  const hasSkippedReason = Boolean(decision.skippedReason);

  if (
    isBuySellSignal(decision.action) &&
    decision.suggestedShares > 0 &&
    decision.confidence >= minConfidence &&
    !hasSkippedReason
  ) {
    return "ACTIONABLE";
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

  const actionableSignals = outcomes.filter(
    (outcome) => outcome === "ACTIONABLE",
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
    buySignals: decisions.filter((decision) => decision.action === "BUY").length,
    sellSignals: decisions.filter((decision) => decision.action === "SELL")
      .length,
    holdSignals: decisions.filter((decision) => decision.action === "HOLD")
      .length,
    buySellTotal: buySellDecisions.length,

    actionableSignals,
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
      actionableSignals +
      blockedByConfidence +
      blockedByPositionGuard +
      blockedByExecutionPolicy +
      otherBlocked,
  };
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

export function StrategyQualityPanel({
  journalRuns,
  minConfidence,
}: StrategyQualityPanelProps) {
  const stats = calculateStats(journalRuns, minConfidence);
  const actionableRatio = qualityRatio(
    stats.actionableSignals,
    stats.buySellTotal,
  );
  const confidenceBlockedRatio = qualityRatio(
    stats.blockedByConfidence,
    stats.buySellTotal,
  );
  const waterfallMatchesTotal = stats.waterfallTotal === stats.buySellTotal;

  const verdict =
    stats.buySellTotal === 0
      ? "No BUY/SELL signal history yet."
      : stats.actionableSignals === 0
        ? "Strategy is still observational: signals exist, but none are actionable."
        : actionableRatio < 20
          ? "Strategy is conservative: most signals are filtered before execution."
          : "Strategy is producing actionable candidates. Review them carefully before execution.";

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

      <div className="grid grid-cols-4 gap-2 mb-4">
        <StatCard label="Runs" value={stats.totalRuns} />
        <StatCard label="BUY" value={stats.buySignals} tone="good" />
        <StatCard label="SELL" value={stats.sellSignals} tone="bad" />
        <StatCard label="HOLD" value={stats.holdSignals} />
      </div>

      <div className="grid grid-cols-4 gap-2 mb-4">
        <StatCard label="BUY/SELL" value={stats.buySellTotal} tone="info" />
        <StatCard
          label="Actionable"
          value={stats.actionableSignals}
          tone={stats.actionableSignals > 0 ? "good" : "neutral"}
        />
        <StatCard
          label="Blocked"
          value={stats.buySellTotal - stats.actionableSignals}
          tone={stats.buySellTotal > stats.actionableSignals ? "warn" : "neutral"}
        />
        <StatCard
          label="Avg conf"
          value={stats.averageConfidence.toFixed(2)}
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
              Mutually exclusive. These rows should sum to total BUY/SELL.
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

        <div className="space-y-3">
          <BarRow
            label="Actionable"
            value={stats.actionableSignals}
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
