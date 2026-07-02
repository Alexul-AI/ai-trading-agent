import type { AutopilotStatus, JournalRun } from "../types";

interface StrategyConfigPanelProps {
  autopilotStatus: AutopilotStatus;
  journalRuns: JournalRun[];
}

function getLatestRunForCurrentStrategy(
  journalRuns: JournalRun[],
  strategyVersion?: string,
): JournalRun | null {
  if (!strategyVersion) return journalRuns[0] ?? null;

  return (
    journalRuns.find((run) => run.strategyVersion === strategyVersion) ??
    journalRuns[0] ??
    null
  );
}

function readConfigNumber(
  config: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = config?.[key];

  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : "—";
}

function readConfigBoolean(
  config: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = config?.[key];

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return "—";
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "—";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleTimeString();
}

function ConfigCard({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
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
    <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-2">
      <div className="text-[9px] text-slate-500 font-black uppercase">
        {label}
      </div>
      <div className={`truncate text-sm font-black ${toneClass}`}>{value}</div>
    </div>
  );
}

export function StrategyConfigPanel({
  autopilotStatus,
  journalRuns,
}: StrategyConfigPanelProps) {
  const latestRun = getLatestRunForCurrentStrategy(
    journalRuns,
    autopilotStatus.strategyVersion,
  );

  const liveConfig = autopilotStatus.strategyConfig;
  const journalConfig = latestRun?.strategyConfig;
  const config = liveConfig ?? journalConfig;

  const liveHash = autopilotStatus.strategyConfigHash;
  const journalHash = latestRun?.strategyConfigHash;
  const hashMatches =
    Boolean(liveHash && journalHash) && liveHash === journalHash;

  const hasLiveConfig = Boolean(liveConfig);
  const hasJournalConfig = Boolean(journalConfig);

  return (
    <div className="bg-slate-900/60 rounded-2xl border border-slate-800 p-4">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-sm font-bold tracking-wider text-slate-300">
            STRATEGY CONFIG
          </h2>
          <p className="text-[10px] text-slate-500">
            Current live config and latest journal metadata for A/B checks
          </p>
        </div>

        <div className="text-right">
          <div className="text-[9px] text-slate-500 font-black uppercase">
            Source
          </div>
          <div className="text-xs font-black text-emerald-300">
            {hasLiveConfig ? "live status" : hasJournalConfig ? "journal" : "none"}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-4">
        <ConfigCard
          label="Version"
          value={autopilotStatus.strategyVersion ?? latestRun?.strategyVersion ?? "legacy"}
          tone="good"
        />
        <ConfigCard
          label="Config hash"
          value={liveHash ?? journalHash ?? "—"}
          tone="info"
        />
      </div>

      <div className="grid grid-cols-3 gap-2 mb-4">
        <ConfigCard
          label="Buy score"
          value={readConfigNumber(config, "minBuySignalScore")}
          tone="info"
        />
        <ConfigCard
          label="Sell score"
          value={readConfigNumber(config, "minSellSignalScore")}
          tone="info"
        />
        <ConfigCard
          label="Strong score"
          value={readConfigNumber(config, "strongSignalScore")}
          tone="warn"
        />
      </div>

      <div className="grid grid-cols-2 gap-2 mb-4">
        <ConfigCard
          label="Buy RSI"
          value={readConfigNumber(config, "buyRsiThreshold")}
        />
        <ConfigCard
          label="Buy momentum RSI"
          value={readConfigNumber(config, "buyRsiWithMomentumThreshold")}
        />
        <ConfigCard
          label="Sell RSI"
          value={readConfigNumber(config, "sellRsiThreshold")}
        />
        <ConfigCard
          label="Sell weak RSI"
          value={readConfigNumber(config, "sellRsiWithoutMomentumThreshold")}
        />
      </div>

      <div className="grid grid-cols-2 gap-2 mb-4">
        <ConfigCard
          label="Stop loss"
          value={readConfigNumber(config, "stopLossPercent")}
          tone="warn"
        />
        <ConfigCard
          label="Take profit"
          value={readConfigNumber(config, "takeProfitPercent")}
          tone="good"
        />
        <ConfigCard
          label="Max buy cash"
          value={readConfigNumber(config, "maxBuyCashFraction")}
        />
        <ConfigCard
          label="Max position"
          value={readConfigNumber(config, "maxPositionEquityFraction")}
        />
      </div>

      <div className="grid grid-cols-2 gap-2 mb-4">
        <ConfigCard
          label="Cooldown bars"
          value={readConfigNumber(config, "cooldownBars")}
        />
        <ConfigCard
          label="Block sell below avg"
          value={readConfigBoolean(config, "downgradeNormalSellBelowAverageEntry")}
          tone="good"
        />
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 text-[10px] text-slate-400">
        <div className="flex items-center justify-between gap-3">
          <span>Latest journal run</span>
          <span className="font-mono text-slate-300">
            {formatTimestamp(latestRun?.timestamp)}
          </span>
        </div>

        {liveHash && journalHash && (
          <div
            className={`mt-2 rounded-lg border p-2 ${
              hashMatches
                ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-200"
                : "border-amber-500/20 bg-amber-500/10 text-amber-200"
            }`}
          >
            {hashMatches
              ? "Live config hash matches latest journal run for this strategy."
              : "Live config hash differs from latest journal run. Run Autopilot once to record the current config."}
          </div>
        )}

        {!config && (
          <div className="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/10 p-2 text-amber-200">
            No strategy config metadata yet. Run Autopilot once after Step 18.
          </div>
        )}
      </div>
    </div>
  );
}
