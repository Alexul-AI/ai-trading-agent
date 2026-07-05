export interface MarketClockData {
  isOpen: boolean;
  timestamp: string;
  nextOpen: string;
  nextClose: string;
  nextOpenIsrael: string;
  nextCloseIsrael: string;
  countdownMs: number;
  countdownLabel: string;
  statusLabel: string;
  nextEventLabel: string;
  timezone: "Asia/Jerusalem";
  source: "alpaca";
}

interface MarketClockPanelProps {
  clock: MarketClockData | null;
  error: string | null;
}

export function MarketClockPanel({ clock, error }: MarketClockPanelProps) {
  const statusClass = clock?.isOpen ? "text-emerald-300" : "text-amber-300";

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2">
      <div className="text-slate-500 font-black uppercase">Market</div>

      {error ? (
        <div className="text-rose-300 font-bold">CLOCK ERROR</div>
      ) : !clock ? (
        <div className="text-slate-400 font-bold">LOADING</div>
      ) : (
        <>
          <div className={`font-bold ${statusClass}`}>{clock.statusLabel}</div>
          <div className="mt-1 text-[10px] text-slate-400">
            {clock.nextEventLabel}:{" "}
            <span className="font-mono text-slate-200">
              {clock.countdownLabel}
            </span>
          </div>
          <div className="text-[10px] text-slate-500">
            Open: {clock.nextOpenIsrael}
          </div>
        </>
      )}
    </div>
  );
}
