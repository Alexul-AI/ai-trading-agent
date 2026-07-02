import type { AutopilotStatus, JournalRun } from "../types";

interface StrategyConfigPanelProps {
  autopilotStatus: AutopilotStatus;
  journalRuns: JournalRun[];
}

type ConfigDiffType = "add" | "remove" | "modify";

interface ConfigDiffItem {
  key: string;
  oldValue: unknown;
  newValue: unknown;
  type: ConfigDiffType;
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

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const record = value as Record<string, unknown>;

  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function formatConfigValue(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "—";
  }

  if (typeof value === "string") {
    return value.length > 0 ? value : "empty";
  }

  return stableStringify(value);
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

function getConfigDiffType(
  oldValue: unknown,
  newValue: unknown,
): ConfigDiffType {
  if (oldValue === undefined && newValue !== undefined) {
    return "add";
  }

  if (oldValue !== undefined && newValue === undefined) {
    return "remove";
  }

  return "modify";
}

function getDiffTone(type: ConfigDiffType) {
  if (type === "add") {
    return {
      card: "rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-2",
      badge: "bg-emerald-500/20 text-emerald-200",
      text: "text-emerald-200",
      section: "border-emerald-500/20 bg-emerald-500/10",
      arrow: "text-emerald-300",
    };
  }

  if (type === "remove") {
    return {
      card: "rounded-xl border border-rose-500/30 bg-rose-500/10 p-2",
      badge: "bg-rose-500/20 text-rose-200",
      text: "text-rose-200",
      section: "border-rose-500/20 bg-rose-500/10",
      arrow: "text-rose-300",
    };
  }

  return {
    card: "rounded-xl border border-amber-500/30 bg-amber-500/10 p-2",
    badge: "bg-amber-500/20 text-amber-200",
    text: "text-amber-200",
    section: "border-amber-500/20 bg-amber-500/10",
    arrow: "text-amber-300",
  };
}

function buildConfigDiff(
  journalConfig: Record<string, unknown> | undefined,
  liveConfig: Record<string, unknown> | undefined,
): ConfigDiffItem[] {
  if (!journalConfig || !liveConfig) {
    return [];
  }

  const keys = Array.from(
    new Set([...Object.keys(journalConfig), ...Object.keys(liveConfig)]),
  ).sort();

  return keys
    .filter(
      (key) =>
        stableStringify(journalConfig[key]) !==
        stableStringify(liveConfig[key]),
    )
    .map((key) => {
      const oldValue = journalConfig[key];
      const newValue = liveConfig[key];

      return {
        key,
        oldValue,
        newValue,
        type: getConfigDiffType(oldValue, newValue),
      };
    });
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
  fieldKey,
  diffByKey,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn" | "info";
  fieldKey?: string;
  diffByKey?: Map<string, ConfigDiffItem>;
}) {
  const diff = fieldKey ? diffByKey?.get(fieldKey) : undefined;

  const toneClass =
    tone === "good"
      ? "text-emerald-300"
      : tone === "warn"
        ? "text-amber-300"
        : tone === "info"
          ? "text-blue-300"
          : "text-slate-300";

  const diffTone = diff ? getDiffTone(diff.type) : null;

  const cardClass = diff
    ? diffTone!.card
    : "rounded-xl bg-slate-950/60 border border-slate-800 p-2";

  return (
    <div className={cardClass}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[9px] text-slate-500 font-black uppercase">
          {label}
        </div>

        {diff && diffTone && (
          <div
            className={`rounded-full px-2 py-0.5 text-[8px] font-black uppercase ${diffTone.badge}`}
          >
            {diff.type}
          </div>
        )}
      </div>

      {diff ? (
        <div className="mt-1 min-w-0">
          <div className="truncate text-xs font-black text-slate-400">
            {formatConfigValue(diff.oldValue)}
          </div>
          <div
            className={`truncate text-sm font-black ${diffTone?.text ?? "text-amber-200"}`}
          >
            → {formatConfigValue(diff.newValue)}
          </div>
        </div>
      ) : (
        <div className={`truncate text-sm font-black ${toneClass}`}>
          {value}
        </div>
      )}
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

  const configDiff = buildConfigDiff(journalConfig, liveConfig);
  const diffByKey = new Map(configDiff.map((diff) => [diff.key, diff]));

  const shouldShowDiff =
    Boolean(liveHash && journalHash && !hashMatches) && configDiff.length > 0;

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
            {hasLiveConfig
              ? "live status"
              : hasJournalConfig
                ? "journal"
                : "none"}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-4">
        <ConfigCard
          label="Version"
          value={
            autopilotStatus.strategyVersion ??
            latestRun?.strategyVersion ??
            "legacy"
          }
          tone="good"
        />
        <ConfigCard
          label="Config hash"
          value={liveHash ?? journalHash ?? "—"}
          tone={hashMatches ? "good" : "info"}
        />
      </div>

      <div className="grid grid-cols-3 gap-2 mb-4">
        <ConfigCard
          label="Buy score"
          value={readConfigNumber(config, "minBuySignalScore")}
          tone="info"
          fieldKey="minBuySignalScore"
          diffByKey={diffByKey}
        />
        <ConfigCard
          label="Sell score"
          value={readConfigNumber(config, "minSellSignalScore")}
          tone="info"
          fieldKey="minSellSignalScore"
          diffByKey={diffByKey}
        />
        <ConfigCard
          label="Strong score"
          value={readConfigNumber(config, "strongSignalScore")}
          tone="warn"
          fieldKey="strongSignalScore"
          diffByKey={diffByKey}
        />
      </div>

      <div className="grid grid-cols-2 gap-2 mb-4">
        <ConfigCard
          label="Buy RSI"
          value={readConfigNumber(config, "buyRsiThreshold")}
          fieldKey="buyRsiThreshold"
          diffByKey={diffByKey}
        />
        <ConfigCard
          label="Buy momentum RSI"
          value={readConfigNumber(config, "buyRsiWithMomentumThreshold")}
          fieldKey="buyRsiWithMomentumThreshold"
          diffByKey={diffByKey}
        />
        <ConfigCard
          label="Sell RSI"
          value={readConfigNumber(config, "sellRsiThreshold")}
          fieldKey="sellRsiThreshold"
          diffByKey={diffByKey}
        />
        <ConfigCard
          label="Sell weak RSI"
          value={readConfigNumber(config, "sellRsiWithoutMomentumThreshold")}
          fieldKey="sellRsiWithoutMomentumThreshold"
          diffByKey={diffByKey}
        />
      </div>

      <div className="grid grid-cols-2 gap-2 mb-4">
        <ConfigCard
          label="Stop loss"
          value={readConfigNumber(config, "stopLossPercent")}
          tone="warn"
          fieldKey="stopLossPercent"
          diffByKey={diffByKey}
        />
        <ConfigCard
          label="Take profit"
          value={readConfigNumber(config, "takeProfitPercent")}
          tone="good"
          fieldKey="takeProfitPercent"
          diffByKey={diffByKey}
        />
        <ConfigCard
          label="Max buy cash"
          value={readConfigNumber(config, "maxBuyCashFraction")}
          fieldKey="maxBuyCashFraction"
          diffByKey={diffByKey}
        />
        <ConfigCard
          label="Max position"
          value={readConfigNumber(config, "maxPositionEquityFraction")}
          fieldKey="maxPositionEquityFraction"
          diffByKey={diffByKey}
        />
      </div>

      <div className="grid grid-cols-2 gap-2 mb-4">
        <ConfigCard
          label="Cooldown bars"
          value={readConfigNumber(config, "cooldownBars")}
          fieldKey="cooldownBars"
          diffByKey={diffByKey}
        />
        <ConfigCard
          label="Block sell below avg"
          value={readConfigBoolean(
            config,
            "downgradeNormalSellBelowAverageEntry",
          )}
          tone="good"
          fieldKey="downgradeNormalSellBelowAverageEntry"
          diffByKey={diffByKey}
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
              : "Live config hash differs from latest journal run. Review the diff below or run Autopilot once to record the current config."}
          </div>
        )}

        {shouldShowDiff && (
          <div className="mt-3 rounded-xl border border-slate-700 bg-slate-950/40 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[10px] font-black uppercase text-slate-300">
                Config diff
              </div>
              <div className="text-[9px] font-black uppercase text-slate-500">
                journal → live
              </div>
            </div>

            <div className="mt-2 space-y-2">
              {configDiff.map((diff) => {
                const tone = getDiffTone(diff.type);

                return (
                  <div
                    key={diff.key}
                    className={`rounded-lg border p-2 ${tone.section}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-[9px] font-black uppercase text-slate-300">
                        {diff.key}
                      </div>
                      <div
                        className={`rounded-full px-2 py-0.5 text-[8px] font-black uppercase ${tone.badge}`}
                      >
                        {diff.type}
                      </div>
                    </div>

                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-mono text-slate-400">
                        {formatConfigValue(diff.oldValue)}
                      </span>
                      <span className={tone.arrow}>→</span>
                      <span className={`font-mono font-black ${tone.text}`}>
                        {formatConfigValue(diff.newValue)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {liveHash && journalHash && !hashMatches && configDiff.length === 0 && (
          <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-amber-200">
            Config hashes differ, but the visible config fields look identical.
            This can happen if serialization changed or hidden fields were
            added.
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
