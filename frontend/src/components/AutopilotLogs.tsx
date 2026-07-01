interface AutopilotLogsProps {
  logs: string[];
}

export function AutopilotLogs({ logs }: AutopilotLogsProps) {
  return (
    <div className="bg-slate-900/60 rounded-2xl border border-slate-800 p-4 h-[180px] flex flex-col">
      <h2 className="text-sm font-bold tracking-wider text-slate-400 mb-2">
        AUTOPILOT LOGS
      </h2>

      <div className="flex-1 overflow-y-auto pr-1 font-mono text-[10px] space-y-1.5 text-slate-400">
        {logs.length === 0 ? (
          <div className="text-slate-600 text-center py-10">Logs idle.</div>
        ) : (
          logs.map((log, index) => (
            <div
              key={`${log}-${index}`}
              className="p-1.5 rounded bg-slate-950/40 border border-slate-800/40 leading-normal"
            >
              {log}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
