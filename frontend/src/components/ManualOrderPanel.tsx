import type { TradeMode } from "../types";
import type { useManualOrder } from "../hooks/useManualOrder";

type ManualOrderState = ReturnType<typeof useManualOrder>;

type ManualOrderPanelProps = {
  tradeMode: TradeMode;
  manualOrder: ManualOrderState;
};

export function ManualOrderPanel({
  tradeMode,
  manualOrder,
}: ManualOrderPanelProps) {
  const {
    manualTradingEnabled,
    tradeTicker,
    setTradeTicker,
    tradeAction,
    setTradeAction,
    tradeQty,
    setTradeQty,
    tradeType,
    setTradeType,
    tradeLimitPrice,
    setTradeLimitPrice,
    tradeSL,
    setTradeSL,
    tradeTP,
    setTradeTP,
    executeManualTrade,
  } = manualOrder;

  return (
    <div className="bg-slate-900/60 rounded-2xl border border-slate-800 p-4">
      <h2 className="text-sm font-bold tracking-wider text-slate-400 mb-3 flex items-center justify-between">
        MANUAL ORDER
        <span
          className={`w-2 h-2 rounded-full ${
            tradeMode === "live" ? "bg-red-500" : "bg-emerald-500"
          }`}
        />
      </h2>

      {!manualTradingEnabled && (
        <div className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
          Manual order entry is disabled by default. RUN ONCE and journal
          analysis stay enabled.
        </div>
      )}

      <form onSubmit={executeManualTrade} className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setTradeAction("BUY")}
            className={`py-1.5 rounded-lg text-xs font-bold transition-all ${
              tradeAction === "BUY"
                ? "bg-emerald-600/20 text-emerald-300 border border-emerald-500/40"
                : "bg-slate-950 text-slate-500 border border-transparent"
            }`}
          >
            BUY
          </button>
          <button
            type="button"
            onClick={() => setTradeAction("SELL")}
            className={`py-1.5 rounded-lg text-xs font-bold transition-all ${
              tradeAction === "SELL"
                ? "bg-rose-600/20 text-rose-300 border border-rose-500/40"
                : "bg-slate-950 text-slate-500 border border-transparent"
            }`}
          >
            SELL
          </button>
        </div>

        <input
          type="text"
          required
          placeholder="Ticker, e.g. AMD"
          value={tradeTicker}
          onChange={(event) => setTradeTicker(event.target.value.toUpperCase())}
          className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-slate-600"
        />

        <div className="grid grid-cols-2 gap-2">
          <input
            type="number"
            min="1"
            required
            value={tradeQty}
            onChange={(event) =>
              setTradeQty(Math.max(1, Number.parseInt(event.target.value) || 1))
            }
            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-slate-600"
          />
          <select
            value={tradeType}
            onChange={(event) => setTradeType(event.target.value)}
            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-2 text-xs text-white focus:outline-none focus:border-slate-600"
          >
            <option value="market">Market</option>
            <option value="limit">Limit</option>
          </select>
        </div>

        {tradeType === "limit" && (
          <input
            type="number"
            step="0.01"
            placeholder="Limit price"
            value={tradeLimitPrice}
            onChange={(event) => setTradeLimitPrice(event.target.value)}
            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none"
          />
        )}

        {tradeAction === "BUY" && (
          <div className="grid grid-cols-2 gap-2">
            <input
              type="number"
              step="0.01"
              placeholder="Stop loss"
              value={tradeSL}
              onChange={(event) => setTradeSL(event.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none"
            />
            <input
              type="number"
              step="0.01"
              placeholder="Take profit"
              value={tradeTP}
              onChange={(event) => setTradeTP(event.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none"
            />
          </div>
        )}

        <button
          type="submit"
          disabled={!manualTradingEnabled}
          className={`w-full py-2 rounded-xl font-bold text-xs tracking-wider transition-all disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500 ${
            tradeMode === "live"
              ? "bg-red-700 hover:bg-red-600 text-white"
              : "bg-blue-600 hover:bg-blue-500 text-white"
          }`}
        >
          {manualTradingEnabled
            ? `SUBMIT ${tradeAction}`
            : "MANUAL TRADING DISABLED"}
        </button>
      </form>
    </div>
  );
}
