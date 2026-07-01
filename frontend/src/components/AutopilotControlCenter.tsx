import type { AutopilotStatus } from "../types";
import { formatTimestamp } from "../utils";

interface AutopilotControlCenterProps {
  autopilotStatus: AutopilotStatus;
  autopilotEnabled: boolean;
  isRunningAutopilot: boolean;
  onRunOnce: () => void;
  onToggleScheduled: () => void;
}

export function AutopilotControlCenter({
  autopilotStatus,
  autopilotEnabled,
  isRunningAutopilot,
  onRunOnce,
  onToggleScheduled,
}: AutopilotControlCenterProps) {
  return (
    <div className="bg-slate-900/60 rounded-2xl border border-slate-800 p-4">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-sm font-bold tracking-wider text-slate-300">
            AUTOPILOT CONTROL CENTER
          </h2>
          <p className="text-[10px] text-slate-500">
            Shared strategyEngine, Alpaca bars, safety layer active
          </p>
        </div>

        <span
          className={`px-2 py-1 rounded-full border text-[10px] font-black ${
            autopilotStatus.running
              ? "bg-amber-500/10 text-amber-300 border-amber-500/30"
              : "bg-slate-950 text-slate-400 border-slate-800"
          }`}
        >
          {autopilotStatus.running ? "RUNNING" : "IDLE"}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-4 text-[10px]">
        <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-3">
          <div className="text-slate-500 font-black uppercase">Execution</div>
          <div
            className={
              autopilotStatus.executeTrades
                ? "text-rose-300 font-bold"
                : "text-blue-300 font-bold"
            }
          >
            {autopilotStatus.executeTrades ? "CAN EXECUTE" : "DRY-RUN ONLY"}
          </div>
        </div>

        <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-3">
          <div className="text-slate-500 font-black uppercase">Buy / Sell</div>
          <div className="text-slate-300 font-bold">
            BUY {autopilotStatus.allowBuy ? "ON" : "OFF"} · SELL{" "}
            {autopilotStatus.allowSell ? "ON" : "OFF"}
          </div>
        </div>

        <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-3">
          <div className="text-slate-500 font-black uppercase">
            Min Confidence
          </div>
          <div className="text-emerald-300 font-bold">
            {autopilotStatus.minConfidence}
          </div>
        </div>

        <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-3">
          <div className="text-slate-500 font-black uppercase">Max Sell</div>
          <div className="text-amber-300 font-bold">
            {Math.round(autopilotStatus.maxSellFraction * 100)}% per signal
          </div>
        </div>
      </div>

      <div className="flex gap-2 mb-4">
        <button
          onClick={onRunOnce}
          disabled={isRunningAutopilot}
          className="flex-1 px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-500 text-white font-bold text-xs transition-colors"
        >
          {isRunningAutopilot ? "RUNNING..." : "RUN ONCE"}
        </button>

        <button
          onClick={onToggleScheduled}
          className={`flex-1 px-3 py-2 rounded-xl font-bold text-xs transition-colors ${
            autopilotEnabled
              ? "bg-emerald-600 hover:bg-emerald-500 text-white"
              : "bg-slate-800 hover:bg-slate-700 text-slate-300"
          }`}
        >
          {autopilotEnabled ? "SCHEDULED ON" : "SCHEDULED OFF"}
        </button>
      </div>

      <div className="flex items-center justify-between text-[10px] text-slate-500 border-t border-slate-800 pt-3">
        <span>Last run: {formatTimestamp(autopilotStatus.lastRunAt)}</span>
        <span>Telegram cooldown: {autopilotStatus.telegramCooldownMinutes}m</span>
      </div>

      {autopilotStatus.lastError && (
        <div className="mt-3 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
          {autopilotStatus.lastError}
        </div>
      )}
    </div>
  );
}
