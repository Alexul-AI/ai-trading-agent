import type {
  AutopilotDecision,
  JournalSummary,
  SignalAction,
} from "./types";

export function formatMoney(value: number | undefined): string {
  const safeValue = Number.isFinite(value) ? (value ?? 0) : 0;

  return safeValue.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatPercent(value: number | undefined): string {
  const safeValue = Number.isFinite(value) ? (value ?? 0) : 0;
  return `${safeValue >= 0 ? "+" : ""}${safeValue.toFixed(2)}%`;
}

export function formatTimestamp(value: string | null): string {
  if (!value) return "Never";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleTimeString();
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

export function actionPillClass(action: SignalAction): string {
  if (action === "BUY") {
    return "bg-emerald-500/10 text-emerald-300 border-emerald-500/30";
  }

  if (action === "SELL") {
    return "bg-rose-500/10 text-rose-300 border-rose-500/30";
  }

  return "bg-slate-800 text-slate-400 border-slate-700";
}

export function confidenceClass(confidence: number): string {
  if (confidence >= 0.75) return "text-emerald-300";
  if (confidence >= 0.55) return "text-amber-300";
  return "text-slate-400";
}

export function getDecisionForTicker(
  decisions: AutopilotDecision[],
  ticker: string,
): AutopilotDecision | undefined {
  return decisions.find((decision) => decision.ticker === ticker);
}

export function getActionCount(
  summary: JournalSummary | null,
  action: SignalAction,
): number {
  return summary?.byAction?.[action] ?? 0;
}

export function getTopTicker(summary: JournalSummary | null): string {
  if (!summary || Object.keys(summary.byTicker).length === 0) return "—";

  return (
    Object.entries(summary.byTicker).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—"
  );
}
