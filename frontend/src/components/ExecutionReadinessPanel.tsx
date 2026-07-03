import type {
  AutopilotDecision,
  AutopilotStatus,
  DashboardHealthSummary,
} from "../types";

interface ExecutionReadinessPanelProps {
  autopilotStatus: AutopilotStatus;
  dashboardHealth: DashboardHealthSummary | null;
  latestDecisions: AutopilotDecision[];
}

type ReadinessTone = "ok" | "safe" | "warn" | "blocked" | "info" | "unknown";

interface ReadinessItem {
  label: string;
  value: string;
  detail: string;
  tone: ReadinessTone;
}

type ExtendedAutopilotStatus = AutopilotStatus & {
  blockSellBelowAverageEntry?: boolean;
};

function toneClass(tone: ReadinessTone): string {
  switch (tone) {
    case "ok":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
    case "safe":
      return "border-blue-500/30 bg-blue-500/10 text-blue-200";
    case "warn":
      return "border-amber-500/30 bg-amber-500/10 text-amber-200";
    case "blocked":
      return "border-rose-500/30 bg-rose-500/10 text-rose-200";
    case "info":
      return "border-slate-600/40 bg-slate-800/50 text-slate-200";
    case "unknown":
      return "border-slate-700 bg-slate-950/60 text-slate-400";
  }
}

function badgeClass(tone: ReadinessTone): string {
  switch (tone) {
    case "ok":
      return "bg-emerald-500/20 text-emerald-200 border-emerald-400/30";
    case "safe":
      return "bg-blue-500/20 text-blue-200 border-blue-400/30";
    case "warn":
      return "bg-amber-500/20 text-amber-200 border-amber-400/30";
    case "blocked":
      return "bg-rose-500/20 text-rose-200 border-rose-400/30";
    case "info":
      return "bg-slate-700/60 text-slate-200 border-slate-600";
    case "unknown":
      return "bg-slate-900 text-slate-400 border-slate-700";
  }
}

function toneLabel(tone: ReadinessTone): string {
  switch (tone) {
    case "ok":
      return "OK";
    case "safe":
      return "SAFE";
    case "warn":
      return "WARN";
    case "blocked":
      return "BLOCKED";
    case "info":
      return "INFO";
    case "unknown":
      return "UNKNOWN";
  }
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

function isExecutionOnlySkippedReason(
  skippedReason: string | undefined,
): boolean {
  if (!skippedReason) return false;

  const reason = skippedReason.toLowerCase();

  return (
    reason.includes("dry-run") ||
    reason.includes("dry run") ||
    reason.includes("execution blocked") ||
    reason.includes("allow_autopilot") ||
    reason.includes("allow_buy") ||
    reason.includes("allow_sell") ||
    reason.includes("outside paper mode")
  );
}

function isSignalReadyDecision(
  decision: AutopilotDecision,
  minConfidence: number,
): boolean {
  const legacyDecision = decision as AutopilotDecision & {
    isActionable?: boolean;
  };

  if (
    decision.signalStatus === "ready" ||
    decision.isSignalReady === true ||
    legacyDecision.isActionable === true
  ) {
    return true;
  }

  if (
    decision.signalStatus === "blocked" ||
    decision.isSignalReady === false ||
    legacyDecision.isActionable === false
  ) {
    return false;
  }

  return (
    decision.action !== "HOLD" &&
    decision.suggestedShares > 0 &&
    decision.confidence >= minConfidence &&
    (!decision.skippedReason ||
      isExecutionOnlySkippedReason(decision.skippedReason))
  );
}

function getLatestSignalReadyDecision(
  decisions: AutopilotDecision[],
  minConfidence: number,
): AutopilotDecision | null {
  const candidates = decisions.filter((decision) =>
    isSignalReadyDecision(decision, minConfidence),
  );

  if (candidates.length === 0) return null;

  return [...candidates].sort((a, b) => b.confidence - a.confidence)[0];
}

function getExecutionPreview(
  decision: AutopilotDecision | null,
  status: AutopilotStatus,
): { tone: ReadinessTone; title: string; detail: string } {
  if (!decision) {
    return {
      tone: "info",
      title: "No signal-ready order candidate",
      detail:
        "Latest run has no BUY/SELL signal ready for execution. Nothing would be submitted.",
    };
  }

  if (status.tradeMode !== "paper") {
    return {
      tone: "blocked",
      title: "Order blocked: not paper mode",
      detail: `${decision.action} ${decision.suggestedShares} ${decision.ticker} would not be submitted because tradeMode is ${status.tradeMode}.`,
    };
  }

  if (!status.executeTrades) {
    return {
      tone: "safe",
      title: "Dry-run only",
      detail: `${decision.action} ${decision.suggestedShares} ${decision.ticker} at approx ${formatMoney(
        decision.price,
      )} is signal-ready, but execution is disabled.`,
    };
  }

  if (decision.action === "BUY" && !status.allowBuy) {
    return {
      tone: "blocked",
      title: "BUY blocked by policy",
      detail: `${decision.ticker} is signal-ready, but allowBuy is disabled.`,
    };
  }

  if (decision.action === "SELL" && !status.allowSell) {
    return {
      tone: "blocked",
      title: "SELL blocked by policy",
      detail: `${decision.ticker} is signal-ready, but allowSell is disabled.`,
    };
  }

  return {
    tone: "warn",
    title: "Paper order would be submitted",
    detail: `${decision.action} ${decision.suggestedShares} ${decision.ticker} at approx ${formatMoney(
      decision.price,
    )}. Verify this carefully before enabling execution.`,
  };
}

function ReadinessRow({ item }: { item: ReadinessItem }) {
  return (
    <div className={`rounded-xl border p-3 ${toneClass(item.tone)}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-black uppercase tracking-wider opacity-70">
            {item.label}
          </div>
          <div className="mt-1 text-sm font-black">{item.value}</div>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-black ${badgeClass(
            item.tone,
          )}`}
        >
          {toneLabel(item.tone)}
        </span>
      </div>
      <div className="mt-2 text-[10px] leading-relaxed opacity-80">
        {item.detail}
      </div>
    </div>
  );
}

export function ExecutionReadinessPanel({
  autopilotStatus,
  dashboardHealth,
  latestDecisions,
}: ExecutionReadinessPanelProps) {
  const extendedStatus = autopilotStatus as ExtendedAutopilotStatus;
  const latestSignalReadyDecision = getLatestSignalReadyDecision(
    latestDecisions,
    autopilotStatus.minConfidence,
  );
  const executionPreview = getExecutionPreview(
    latestSignalReadyDecision,
    autopilotStatus,
  );

  const telegramWarnings =
    dashboardHealth?.warnings.filter((warning) =>
      warning.service.toLowerCase().includes("telegram"),
    ) ?? [];

  const blockSellBelowAverageEntry =
    extendedStatus.blockSellBelowAverageEntry ?? null;

  const readinessItems: ReadinessItem[] = [
    {
      label: "Execution mode",
      value: autopilotStatus.executeTrades ? "Execution enabled" : "Dry-run",
      detail: autopilotStatus.executeTrades
        ? "Autopilot is allowed to submit orders if all other policies pass."
        : "Autopilot can generate decisions, but will not submit broker orders.",
      tone: autopilotStatus.executeTrades ? "warn" : "safe",
    },
    {
      label: "Trade mode",
      value: autopilotStatus.tradeMode,
      detail:
        autopilotStatus.tradeMode === "paper"
          ? "Paper mode is the expected safe environment for testing execution."
          : "Not paper mode. Execution should stay blocked until this is reviewed.",
      tone: autopilotStatus.tradeMode === "paper" ? "ok" : "blocked",
    },
    {
      label: "BUY permission",
      value: autopilotStatus.allowBuy ? "Allowed" : "Disabled",
      detail: autopilotStatus.allowBuy
        ? "BUY decisions can pass execution policy."
        : "BUY decisions can be signal-ready, but execution will be blocked.",
      tone: autopilotStatus.allowBuy ? "ok" : "warn",
    },
    {
      label: "SELL permission",
      value: autopilotStatus.allowSell ? "Allowed" : "Disabled",
      detail: autopilotStatus.allowSell
        ? "SELL decisions can pass execution policy."
        : "SELL decisions can be signal-ready, but execution will be blocked.",
      tone: autopilotStatus.allowSell ? "ok" : "warn",
    },
    {
      label: "Sell-below-average guard",
      value:
        blockSellBelowAverageEntry === null
          ? "Unknown"
          : blockSellBelowAverageEntry
            ? "Enabled"
            : "Disabled",
      detail:
        blockSellBelowAverageEntry === null
          ? "Status object did not include this guard. Backend may still enforce it."
          : blockSellBelowAverageEntry
            ? "Normal SELL below average entry is blocked; STOP_LOSS can still pass."
            : "Normal SELL below average entry is not blocked by this guard.",
      tone:
        blockSellBelowAverageEntry === null
          ? "unknown"
          : blockSellBelowAverageEntry
            ? "ok"
            : "warn",
    },
    {
      label: "Max sell fraction",
      value: formatPercent(autopilotStatus.maxSellFraction),
      detail: "Maximum fraction of an existing position allowed in one SELL.",
      tone: autopilotStatus.maxSellFraction <= 0.25 ? "ok" : "warn",
    },
    {
      label: "Min confidence",
      value: autopilotStatus.minConfidence.toFixed(2),
      detail:
        "Signal must pass this confidence threshold before execution checks.",
      tone: autopilotStatus.minConfidence >= 0.75 ? "ok" : "warn",
    },
    {
      label: "Telegram alerts",
      value:
        dashboardHealth === null
          ? "Unknown"
          : telegramWarnings.length > 0
            ? "Warning"
            : "No warning",
      detail:
        dashboardHealth === null
          ? "Dashboard health was not loaded yet."
          : telegramWarnings.length > 0
            ? telegramWarnings.map((warning) => warning.message).join(" ")
            : "No Telegram warning reported by dashboard health.",
      tone:
        dashboardHealth === null
          ? "unknown"
          : telegramWarnings.length > 0
            ? "warn"
            : "ok",
    },
    {
      label: "System health",
      value:
        dashboardHealth === null
          ? "Unknown"
          : dashboardHealth.ok
            ? "OK"
            : "Warnings",
      detail:
        dashboardHealth === null
          ? "Dashboard health was not loaded yet."
          : dashboardHealth.ok
            ? "No dashboard health warnings."
            : `${dashboardHealth.warnings.length} warning(s) reported.`,
      tone:
        dashboardHealth === null
          ? "unknown"
          : dashboardHealth.ok
            ? "ok"
            : "warn",
    },
  ];

  return (
    <div className="bg-slate-900/60 rounded-2xl border border-slate-800 p-4">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-sm font-bold tracking-wider text-slate-300">
            EXECUTION READINESS
          </h2>
          <p className="text-[10px] text-slate-500">
            Safety checklist before allowing paper order submission.
          </p>
        </div>

        <span
          className={`rounded-full border px-2 py-1 text-[10px] font-black ${badgeClass(
            executionPreview.tone,
          )}`}
        >
          {toneLabel(executionPreview.tone)}
        </span>
      </div>

      <div
        className={`rounded-xl border p-3 mb-4 ${toneClass(executionPreview.tone)}`}
      >
        <div className="text-[10px] font-black uppercase tracking-wider opacity-70">
          Order preview
        </div>
        <div className="mt-1 text-sm font-black">{executionPreview.title}</div>
        <div className="mt-2 text-[10px] leading-relaxed opacity-80">
          {executionPreview.detail}
        </div>

        {latestSignalReadyDecision && (
          <div className="mt-3 grid grid-cols-4 gap-2 text-[10px]">
            <div className="rounded-lg bg-slate-950/40 border border-slate-700 p-2">
              <div className="text-slate-500 font-black uppercase">Ticker</div>
              <div className="font-mono font-black text-white">
                {latestSignalReadyDecision.ticker}
              </div>
            </div>
            <div className="rounded-lg bg-slate-950/40 border border-slate-700 p-2">
              <div className="text-slate-500 font-black uppercase">Action</div>
              <div className="font-mono font-black text-white">
                {latestSignalReadyDecision.action}
              </div>
            </div>
            <div className="rounded-lg bg-slate-950/40 border border-slate-700 p-2">
              <div className="text-slate-500 font-black uppercase">Shares</div>
              <div className="font-mono font-black text-white">
                {latestSignalReadyDecision.suggestedShares}
              </div>
            </div>
            <div className="rounded-lg bg-slate-950/40 border border-slate-700 p-2">
              <div className="text-slate-500 font-black uppercase">Conf</div>
              <div className="font-mono font-black text-white">
                {latestSignalReadyDecision.confidence.toFixed(2)}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {readinessItems.map((item) => (
          <ReadinessRow key={item.label} item={item} />
        ))}
      </div>
    </div>
  );
}
