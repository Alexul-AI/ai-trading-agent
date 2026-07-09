import { useEffect, useState } from "react";
import type {
  FundamentalResult,
  NewsSentimentResult,
  WatchlistItem,
} from "../types";

interface MarketIntelPanelProps {
  watchlist: WatchlistItem[];
  sentiment: NewsSentimentResult | null;
  isLoadingSentiment: boolean;
  sentimentError: string | null;
  onFetchSentiment: (ticker: string) => void;
  fundamentals: FundamentalResult | null;
  isLoadingFundamentals: boolean;
  fundamentalsError: string | null;
  onFetchFundamentals: (ticker: string) => void;
}

function sentimentPillClass(
  sentimentValue: NewsSentimentResult["sentiment"] | undefined,
): string {
  if (sentimentValue === "BULLISH") {
    return "bg-emerald-500/10 text-emerald-300 border-emerald-500/30";
  }

  if (sentimentValue === "BEARISH") {
    return "bg-rose-500/10 text-rose-300 border-rose-500/30";
  }

  return "bg-slate-800 text-slate-400 border-slate-700";
}

export function MarketIntelPanel({
  watchlist,
  sentiment,
  isLoadingSentiment,
  sentimentError,
  onFetchSentiment,
  fundamentals,
  isLoadingFundamentals,
  fundamentalsError,
  onFetchFundamentals,
}: MarketIntelPanelProps) {
  const [selectedTicker, setSelectedTicker] = useState<string>("");
  const activeTicker = selectedTicker || watchlist[0]?.ticker || "";
  const isLoading = isLoadingSentiment || isLoadingFundamentals;

  useEffect(() => {
    if (activeTicker) {
      onFetchSentiment(activeTicker);
      onFetchFundamentals(activeTicker);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTicker]);

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
      <div className="flex items-center justify-between">
        <div className="text-slate-500 font-black uppercase text-xs">
          Market intel
        </div>

        <div className="flex items-center gap-2">
          <select
            value={activeTicker}
            onChange={(event) => setSelectedTicker(event.target.value)}
            className="bg-slate-900 border border-slate-800 rounded px-1.5 py-0.5 text-[11px] text-slate-200"
          >
            {watchlist.map((item) => (
              <option key={item.ticker} value={item.ticker}>
                {item.ticker}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => {
              if (!activeTicker) return;
              onFetchSentiment(activeTicker);
              onFetchFundamentals(activeTicker);
            }}
            disabled={isLoading || !activeTicker}
            className="text-[11px] font-bold text-slate-300 border border-slate-800 rounded px-2 py-0.5 hover:bg-slate-900 disabled:opacity-50"
          >
            {isLoading ? "..." : "Refresh"}
          </button>
        </div>
      </div>

      <div className="mt-2">
        <div className="text-[10px] text-slate-600 font-black uppercase mb-1">
          Sentiment
        </div>

        {sentimentError ? (
          <div className="text-rose-300 font-bold text-xs">
            SENTIMENT ERROR: {sentimentError}
          </div>
        ) : isLoadingSentiment && !sentiment ? (
          <div className="text-slate-400 font-bold text-xs">LOADING</div>
        ) : !sentiment ? (
          <div className="text-slate-500 text-xs">No data yet.</div>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] font-extrabold border ${sentimentPillClass(sentiment.sentiment)}`}
              >
                {sentiment.sentiment}
              </span>
              <span className="text-[10px] text-slate-500">
                {sentiment.ticker} - {sentiment.articleCount} articles
              </span>
            </div>

            <p className="mt-1.5 text-[11px] text-slate-300 leading-snug">
              {sentiment.summary}
            </p>

            {sentiment.notableEvents.length > 0 && (
              <ul className="mt-1.5 space-y-0.5">
                {sentiment.notableEvents.map((event) => (
                  <li
                    key={event}
                    className="text-[10px] text-slate-400 before:content-['-_'] before:text-slate-600"
                  >
                    {event}
                  </li>
                ))}
              </ul>
            )}

            {sentiment.articles.length > 0 && (
              <div className="mt-2 space-y-1">
                {sentiment.articles.slice(0, 3).map((article) => (
                  <a
                    key={article.id}
                    href={article.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block text-[10px] text-slate-500 hover:text-slate-300 truncate"
                  >
                    {article.headline}
                  </a>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div className="mt-3 border-t border-slate-800 pt-2">
        <div className="text-[10px] text-slate-600 font-black uppercase mb-1">
          Fundamentals
        </div>

        {fundamentalsError ? (
          <div className="text-rose-300 font-bold text-xs">
            FUNDAMENTALS ERROR: {fundamentalsError}
          </div>
        ) : isLoadingFundamentals && !fundamentals ? (
          <div className="text-slate-400 font-bold text-xs">LOADING</div>
        ) : !fundamentals ? (
          <div className="text-slate-500 text-xs">No data yet.</div>
        ) : (
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            <div className="flex justify-between">
              <span className="text-slate-500">Market cap</span>
              <span className="text-slate-200 font-mono">
                {fundamentals.marketCap}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">P/E</span>
              <span className="text-slate-200 font-mono">
                {fundamentals.peRatio}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Forward P/E</span>
              <span className="text-slate-200 font-mono">
                {fundamentals.forwardPE}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Div yield</span>
              <span className="text-slate-200 font-mono">
                {fundamentals.dividendYield}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">52w high</span>
              <span className="text-slate-200 font-mono">
                {fundamentals.fiftyTwoWeekHigh}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">52w low</span>
              <span className="text-slate-200 font-mono">
                {fundamentals.fiftyTwoWeekLow}
              </span>
            </div>
            <div className="col-span-2 flex justify-between">
              <span className="text-slate-500">Analysts</span>
              <span className="text-slate-200 font-mono">
                {fundamentals.analystRating}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
