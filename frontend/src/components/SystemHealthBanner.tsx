import type { DashboardHealthSummary } from "../types";

interface SystemHealthBannerProps {
  health: DashboardHealthSummary | null;
}

function toneClass(status: string): string {
  if (status === "error" || status === "missing") {
    return "border-rose-500/30 bg-rose-500/10 text-rose-100";
  }

  return "border-amber-500/30 bg-amber-500/10 text-amber-100";
}

function titleForStatus(status: string): string {
  if (status === "error" || status === "missing") {
    return "System degraded";
  }

  return "System warning";
}

export function SystemHealthBanner({ health }: SystemHealthBannerProps) {
  const warnings = health?.warnings ?? [];

  if (warnings.length === 0) {
    return null;
  }

  const hasHardProblem = warnings.some(
    (warning) => warning.status === "error" || warning.status === "missing",
  );

  const title = hasHardProblem ? "System degraded" : "System warning";
  const wrapperClass = hasHardProblem
    ? "border-rose-500/30 bg-rose-500/10 text-rose-100"
    : "border-amber-500/30 bg-amber-500/10 text-amber-100";

  return (
    <div className={`mx-6 mb-6 rounded-2xl border p-4 ${wrapperClass}`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-black">
            ⚠️ {title}
          </div>
          <div className="mt-1 text-xs opacity-80">
            Some services are not fully available. The dashboard may show fallback data.
          </div>
        </div>

        <div className="text-[10px] font-black uppercase opacity-70">
          {warnings.length} issue{warnings.length === 1 ? "" : "s"}
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {warnings.map((warning) => (
          <div
            key={`${warning.service}-${warning.status}-${warning.message}`}
            className={`rounded-xl border px-3 py-2 text-xs ${toneClass(
              warning.status,
            )}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-black uppercase">{warning.service}</span>
              <span className="rounded-full bg-slate-950/40 px-2 py-0.5 text-[9px] font-black uppercase">
                {warning.status}
              </span>
              <span>{warning.message}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
