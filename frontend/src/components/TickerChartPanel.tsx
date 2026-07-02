import { useEffect, useMemo, useState } from "react";
import type {
  AutopilotDecision,
  JournalRun,
  MarketChartPoint,
  MarketChartResponse,
  Position,
  SignalAction,
  WatchlistItem,
} from "../types";
import {
  actionPillClass,
  confidenceClass,
  formatMoney,
  getErrorMessage,
} from "../utils";

interface TickerChartPanelProps {
  apiBaseUrl: string;
  watchlist: WatchlistItem[];
  positions: Record<string, Position>;
  latestDecisions: AutopilotDecision[];
  journalRuns: JournalRun[];
  minConfidence: number;
}

interface ChartSignalMarker {
  id: string;
  date: string;
  ticker: string;
  action: SignalAction;
  confidence: number;
  suggestedShares: number;
  originalSuggestedShares?: number;
  reasonType: string;
  executed: boolean;
  skippedReason?: string;
  runTimestamp: string;
}

interface ChartSignalCluster {
  date: string;
  markers: ChartSignalMarker[];
  primaryMarker: ChartSignalMarker;
  actionableCount: number;
  skippedCount: number;
  buyCount: number;
  sellCount: number;
}

interface SvgPoint {
  x: number;
  y: number;
}

function getTickerUniverse(
  watchlist: WatchlistItem[],
  positions: Record<string, Position>,
): string[] {
  return Array.from(
    new Set([
      ...Object.keys(positions),
      ...watchlist.map((item) => item.ticker),
    ]),
  ).filter(Boolean);
}

function buildPath(points: SvgPoint[]): string {
  if (points.length === 0) return "";

  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
}

function formatShortDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function latestNonNull<T>(
  points: MarketChartPoint[],
  selector: (point: MarketChartPoint) => T | null,
): T | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const value = selector(points[index]);
    if (value !== null && value !== undefined) return value;
  }

  return null;
}

function dateKey(value: string): string {
  return value.split("T")[0] ?? value;
}

function markerClass(action: SignalAction): string {
  if (action === "BUY") return "fill-emerald-300";
  if (action === "SELL") return "fill-rose-300";
  return "fill-slate-500";
}

function markerStrokeClass(action: SignalAction): string {
  if (action === "BUY") return "stroke-emerald-950";
  if (action === "SELL") return "stroke-rose-950";
  return "stroke-slate-950";
}

function markerLabel(action: SignalAction): string {
  if (action === "BUY") return "B";
  if (action === "SELL") return "S";
  return "H";
}

function isActionableMarker(
  marker: ChartSignalMarker,
  minConfidence: number,
): boolean {
  return (
    marker.action !== "HOLD" &&
    marker.confidence >= minConfidence &&
    !marker.skippedReason
  );
}

function getPrimaryMarker(
  markers: ChartSignalMarker[],
  minConfidence: number,
): ChartSignalMarker {
  return [...markers].sort((a, b) => {
    const aActionable = isActionableMarker(a, minConfidence) ? 1 : 0;
    const bActionable = isActionableMarker(b, minConfidence) ? 1 : 0;

    if (aActionable !== bActionable) return bActionable - aActionable;

    return b.confidence - a.confidence;
  })[0];
}

function summarizeCluster(
  date: string,
  markers: ChartSignalMarker[],
  minConfidence: number,
): ChartSignalCluster {
  const primaryMarker = getPrimaryMarker(markers, minConfidence);

  return {
    date,
    markers,
    primaryMarker,
    actionableCount: markers.filter((marker) =>
      isActionableMarker(marker, minConfidence),
    ).length,
    skippedCount: markers.filter(
      (marker) => !isActionableMarker(marker, minConfidence),
    ).length,
    buyCount: markers.filter((marker) => marker.action === "BUY").length,
    sellCount: markers.filter((marker) => marker.action === "SELL").length,
  };
}

function isDecisionActionable(
  decision: AutopilotDecision,
  minConfidence: number,
): boolean {
  return (
    decision.action !== "HOLD" &&
    decision.confidence >= minConfidence &&
    decision.suggestedShares > 0 &&
    !decision.skippedReason
  );
}

export function TickerChartPanel({
  apiBaseUrl,
  watchlist,
  positions,
  latestDecisions,
  journalRuns,
  minConfidence,
}: TickerChartPanelProps) {
  const tickers = useMemo(
    () => getTickerUniverse(watchlist, positions),
    [watchlist, positions],
  );

  const [userSelectedTicker, setUserSelectedTicker] = useState<string>("");
  const selectedTicker = tickers.includes(userSelectedTicker)
    ? userSelectedTicker
    : (tickers[0] ?? "");
  const [days, setDays] = useState(120);
  const [chartData, setChartData] = useState<MarketChartResponse | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [hoveredCluster, setHoveredCluster] =
    useState<ChartSignalCluster | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedTicker) return;

    const controller = new AbortController();

    async function loadChart() {
      setIsLoading(true);
      setErrorMessage(null);

      try {
        const response = await fetch(
          `${apiBaseUrl}/api/market/chart/${selectedTicker}?days=${days}`,
          {
            cache: "no-store",
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          throw new Error(`Chart request failed: ${response.status}`);
        }

        const data = (await response.json()) as MarketChartResponse;
        setChartData(data);
        setHoverIndex(null);
        setHoveredCluster(null);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        setErrorMessage(getErrorMessage(error));
      } finally {
        setIsLoading(false);
      }
    }

    void loadChart();

    return () => {
      controller.abort();
    };
  }, [apiBaseUrl, selectedTicker, days]);

  const points = useMemo(() => chartData?.points ?? [], [chartData?.points]);
  const selectedDecision = latestDecisions.find(
    (decision) => decision.ticker === selectedTicker,
  );
  const selectedDecisionActionable = selectedDecision
    ? isDecisionActionable(selectedDecision, minConfidence)
    : false;
  const selectedPosition = positions[selectedTicker];
  const activePoint =
    hoverIndex !== null ? points[hoverIndex] : points[points.length - 1];

  const chartSignalMarkers = useMemo<ChartSignalMarker[]>(() => {
    if (!selectedTicker) return [];

    const chartDates = new Set(points.map((point) => point.date));

    return journalRuns
      .flatMap((run) =>
        run.decisions.map((decision) => ({
          id: `${run.id}-${decision.ticker}-${decision.timestamp}`,
          date: dateKey(decision.timestamp),
          ticker: decision.ticker,
          action: decision.action,
          confidence: decision.confidence,
          suggestedShares: decision.suggestedShares,
          originalSuggestedShares: decision.originalSuggestedShares,
          reasonType: decision.reasonType,
          executed: decision.executed,
          skippedReason: decision.skippedReason,
          runTimestamp: run.timestamp,
        })),
      )
      .filter(
        (marker) =>
          marker.ticker === selectedTicker &&
          marker.action !== "HOLD" &&
          chartDates.has(marker.date),
      )
      .sort(
        (a, b) =>
          new Date(a.runTimestamp).getTime() -
          new Date(b.runTimestamp).getTime(),
      );
  }, [journalRuns, points, selectedTicker]);

  const markerClusterByDate = useMemo(() => {
    const markersByDate = new Map<string, ChartSignalMarker[]>();

    for (const marker of chartSignalMarkers) {
      markersByDate.set(marker.date, [
        ...(markersByDate.get(marker.date) ?? []),
        marker,
      ]);
    }

    const clusters = new Map<string, ChartSignalCluster>();

    for (const [date, markers] of markersByDate.entries()) {
      clusters.set(date, summarizeCluster(date, markers, minConfidence));
    }

    return clusters;
  }, [chartSignalMarkers, minConfidence]);

  const totalActionableMarkers = useMemo(
    () =>
      chartSignalMarkers.filter((marker) =>
        isActionableMarker(marker, minConfidence),
      ).length,
    [chartSignalMarkers, minConfidence],
  );

  const chartWidth = 720;
  const chartHeight = 260;
  const padding = { top: 18, right: 18, bottom: 28, left: 48 };
  const innerWidth = chartWidth - padding.left - padding.right;
  const innerHeight = chartHeight - padding.top - padding.bottom;

  const priceValues = points.flatMap((point) =>
    [
      point.close,
      point.bollingerLower,
      point.bollingerMiddle,
      point.bollingerUpper,
      selectedPosition?.avgPrice ?? null,
    ].filter((value): value is number => value !== null && value !== undefined),
  );

  const minValue = priceValues.length ? Math.min(...priceValues) : 0;
  const maxValue = priceValues.length ? Math.max(...priceValues) : 1;
  const range = maxValue - minValue || 1;
  const yMin = minValue - range * 0.08;
  const yMax = maxValue + range * 0.08;
  const yRange = yMax - yMin || 1;

  function xForIndex(index: number): number {
    if (points.length <= 1) return padding.left;
    return padding.left + (index / (points.length - 1)) * innerWidth;
  }

  function yForValue(value: number): number {
    return padding.top + ((yMax - value) / yRange) * innerHeight;
  }

  function toSvgPoints(
    selector: (point: MarketChartPoint) => number | null,
  ): SvgPoint[] {
    return points
      .map((point, index) => {
        const value = selector(point);
        if (value === null || value === undefined) return null;

        return {
          x: xForIndex(index),
          y: yForValue(value),
        };
      })
      .filter((point): point is SvgPoint => point !== null);
  }

  const closePath = buildPath(toSvgPoints((point) => point.close));
  const upperPath = buildPath(toSvgPoints((point) => point.bollingerUpper));
  const middlePath = buildPath(toSvgPoints((point) => point.bollingerMiddle));
  const lowerPath = buildPath(toSvgPoints((point) => point.bollingerLower));

  const latestClose =
    activePoint?.close ?? latestNonNull(points, (point) => point.close);
  const latestRsi =
    activePoint?.rsi ?? latestNonNull(points, (point) => point.rsi);
  const latestMacd =
    activePoint?.macdHistogram ??
    latestNonNull(points, (point) => point.macdHistogram);
  const latestUpper =
    activePoint?.bollingerUpper ??
    latestNonNull(points, (point) => point.bollingerUpper);
  const latestLower =
    activePoint?.bollingerLower ??
    latestNonNull(points, (point) => point.bollingerLower);

  function handlePointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (points.length === 0) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(
      0,
      Math.min(1, (event.clientX - rect.left - padding.left) / innerWidth),
    );
    const index = Math.round(ratio * (points.length - 1));
    setHoverIndex(index);
  }

  return (
    <div className="bg-slate-900/60 rounded-2xl border border-slate-800 p-4 flex flex-col min-h-[420px]">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between mb-4">
        <div>
          <h2 className="text-sm font-bold tracking-wider text-slate-300">
            TICKER CHART
          </h2>
          <p className="text-[10px] text-slate-500">
            Price, Bollinger bands, RSI/MACD context from Alpaca daily bars
          </p>
        </div>

        <div className="flex gap-2">
          <select
            value={selectedTicker}
            onChange={(event) => setUserSelectedTicker(event.target.value)}
            className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-slate-600"
          >
            {tickers.map((ticker) => (
              <option key={ticker} value={ticker}>
                {ticker}
              </option>
            ))}
          </select>

          <select
            value={days}
            onChange={(event) =>
              setDays(Number.parseInt(event.target.value, 10))
            }
            className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-slate-600"
          >
            <option value={60}>60D</option>
            <option value={120}>120D</option>
            <option value={180}>180D</option>
            <option value={365}>365D</option>
          </select>
        </div>
      </div>

      {selectedDecision && (
        <div className="mb-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`px-2 py-0.5 rounded-full border text-[10px] font-black ${actionPillClass(
                  selectedDecision.action,
                )}`}
              >
                {selectedDecision.action}
              </span>
              <span
                className={`text-xs font-black ${confidenceClass(
                  selectedDecision.confidence,
                )}`}
              >
                confidence {selectedDecision.confidence}
              </span>
              <span
                className={`px-2 py-0.5 rounded-full border text-[10px] font-black ${
                  selectedDecisionActionable
                    ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
                    : "bg-slate-800 text-slate-400 border-slate-700"
                }`}
              >
                {selectedDecisionActionable ? "ACTIONABLE" : "NOT ACTIONABLE"}
              </span>
            </div>

            <div className="text-[10px] text-slate-500">
              {selectedDecision.suggestedShares} shares
              {selectedDecision.originalSuggestedShares
                ? ` / original ${selectedDecision.originalSuggestedShares}`
                : ""}
            </div>
          </div>

          <div className="mt-2 text-[10px] text-slate-400 leading-relaxed">
            {selectedDecision.reason}
          </div>

          {selectedDecision.safetyNote && (
            <div className="mt-2 text-[10px] text-amber-300">
              {selectedDecision.safetyNote}
            </div>
          )}

          {selectedDecision.skippedReason && (
            <div className="mt-2 rounded-lg border border-slate-800 bg-slate-900/70 p-2 text-[10px] text-slate-400">
              Skipped: {selectedDecision.skippedReason}
            </div>
          )}
        </div>
      )}

      {errorMessage && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
          {errorMessage}
        </div>
      )}

      {!errorMessage && (
        <div className="relative flex-1">
          {isLoading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-slate-950/60 text-xs text-slate-400">
              Loading chart...
            </div>
          )}

          {points.length === 0 && !isLoading ? (
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 h-[260px] flex items-center justify-center text-xs text-slate-500">
              No chart data yet.
            </div>
          ) : (
            <svg
              viewBox={`0 0 ${chartWidth} ${chartHeight}`}
              className="w-full h-[260px] rounded-xl border border-slate-800 bg-slate-950/40"
              onPointerMove={handlePointerMove}
              onPointerLeave={() => setHoverIndex(null)}
              role="img"
              aria-label={`${selectedTicker} chart`}
            >
              <line
                x1={padding.left}
                y1={padding.top}
                x2={padding.left}
                y2={padding.top + innerHeight}
                stroke="currentColor"
                className="text-slate-800"
              />
              <line
                x1={padding.left}
                y1={padding.top + innerHeight}
                x2={padding.left + innerWidth}
                y2={padding.top + innerHeight}
                stroke="currentColor"
                className="text-slate-800"
              />

              {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
                const y = padding.top + ratio * innerHeight;
                const value = yMax - ratio * yRange;

                return (
                  <g key={ratio}>
                    <line
                      x1={padding.left}
                      y1={y}
                      x2={padding.left + innerWidth}
                      y2={y}
                      stroke="currentColor"
                      className="text-slate-900"
                    />
                    <text
                      x={padding.left - 8}
                      y={y + 4}
                      textAnchor="end"
                      className="fill-slate-500 text-[10px]"
                    >
                      {value.toFixed(0)}
                    </text>
                  </g>
                );
              })}

              {points.length > 0 && (
                <>
                  <text
                    x={padding.left}
                    y={chartHeight - 8}
                    className="fill-slate-500 text-[10px]"
                  >
                    {formatShortDate(points[0]?.date ?? "")}
                  </text>
                  <text
                    x={padding.left + innerWidth}
                    y={chartHeight - 8}
                    textAnchor="end"
                    className="fill-slate-500 text-[10px]"
                  >
                    {formatShortDate(points[points.length - 1]?.date ?? "")}
                  </text>
                </>
              )}

              {selectedPosition && selectedPosition.avgPrice > 0 && (
                <>
                  <line
                    x1={padding.left}
                    y1={yForValue(selectedPosition.avgPrice)}
                    x2={padding.left + innerWidth}
                    y2={yForValue(selectedPosition.avgPrice)}
                    stroke="currentColor"
                    strokeDasharray="6 6"
                    className="text-amber-500"
                  />
                  <text
                    x={padding.left + innerWidth - 6}
                    y={yForValue(selectedPosition.avgPrice) - 6}
                    textAnchor="end"
                    className="fill-amber-300 text-[10px]"
                  >
                    avg {selectedPosition.avgPrice.toFixed(2)}
                  </text>
                </>
              )}

              {upperPath && (
                <path
                  d={upperPath}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeDasharray="4 4"
                  className="text-slate-500"
                />
              )}
              {middlePath && (
                <path
                  d={middlePath}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1"
                  strokeDasharray="2 6"
                  className="text-slate-600"
                />
              )}
              {lowerPath && (
                <path
                  d={lowerPath}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeDasharray="4 4"
                  className="text-slate-500"
                />
              )}
              {closePath && (
                <path
                  d={closePath}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  className="text-blue-400"
                />
              )}

              {points.map((point, index) => {
                const cluster = markerClusterByDate.get(point.date);

                if (!cluster) return null;

                const marker = cluster.primaryMarker;
                const x = xForIndex(index);
                const y = yForValue(point.close);
                const actionable = cluster.actionableCount > 0;
                const radius = actionable ? 9 : 7;

                return (
                  <g
                    key={`${cluster.date}-${cluster.markers.length}`}
                    onPointerEnter={() => setHoveredCluster(cluster)}
                    onPointerLeave={() => setHoveredCluster(null)}
                    className="cursor-pointer"
                  >
                    <circle
                      cx={x}
                      cy={y}
                      r={radius}
                      strokeWidth={actionable ? 3 : 2}
                      strokeDasharray={actionable ? undefined : "3 3"}
                      className={`${markerClass(marker.action)} ${markerStrokeClass(
                        marker.action,
                      )}`}
                    />
                    <text
                      x={x}
                      y={y + 3.5}
                      textAnchor="middle"
                      className="fill-slate-950 text-[9px] font-black pointer-events-none"
                    >
                      {cluster.buyCount > 0 && cluster.sellCount > 0
                        ? "M"
                        : markerLabel(marker.action)}
                    </text>
                    {cluster.markers.length > 1 && (
                      <>
                        <circle
                          cx={x + 10}
                          cy={y - 10}
                          r="7"
                          className="fill-slate-950 stroke-slate-600"
                          strokeWidth="1"
                        />
                        <text
                          x={x + 10}
                          y={y - 6.5}
                          textAnchor="middle"
                          className="fill-slate-200 text-[8px] font-black pointer-events-none"
                        >
                          {cluster.markers.length}
                        </text>
                      </>
                    )}
                  </g>
                );
              })}

              {hoverIndex !== null && points[hoverIndex] && (
                <>
                  <line
                    x1={xForIndex(hoverIndex)}
                    y1={padding.top}
                    x2={xForIndex(hoverIndex)}
                    y2={padding.top + innerHeight}
                    stroke="currentColor"
                    strokeDasharray="4 4"
                    className="text-slate-600"
                  />
                  <circle
                    cx={xForIndex(hoverIndex)}
                    cy={yForValue(points[hoverIndex]?.close ?? 0)}
                    r="4"
                    className="fill-blue-300"
                  />
                </>
              )}
            </svg>
          )}
        </div>
      )}

      <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
        <div className="flex items-center justify-between gap-3 text-[10px]">
          <div className="text-slate-500 font-black uppercase">
            Journal markers
          </div>
          <div className="text-slate-300 font-mono">
            {chartSignalMarkers.length} BUY/SELL · {totalActionableMarkers}{" "}
            actionable
          </div>
        </div>

        {hoveredCluster ? (
          <div className="mt-2 space-y-2 text-[10px]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-slate-400">{hoveredCluster.date}</span>
              <span className="text-slate-500">
                {hoveredCluster.markers.length} signal
                {hoveredCluster.markers.length === 1 ? "" : "s"}
              </span>
              <span className="text-emerald-300">
                {hoveredCluster.actionableCount} actionable
              </span>
              <span className="text-slate-500">
                {hoveredCluster.skippedCount} skipped
              </span>
            </div>

            <div className="space-y-1.5">
              {hoveredCluster.markers.map((marker) => {
                const actionable = isActionableMarker(marker, minConfidence);

                return (
                  <div
                    key={marker.id}
                    className={`rounded-lg border p-2 ${
                      actionable
                        ? "border-emerald-500/30 bg-emerald-500/10"
                        : "border-slate-800 bg-slate-900/70"
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`px-2 py-0.5 rounded-full border font-black ${actionPillClass(
                          marker.action,
                        )}`}
                      >
                        {marker.action}
                      </span>
                      <span className={confidenceClass(marker.confidence)}>
                        conf {marker.confidence}
                      </span>
                      <span className="text-slate-400">
                        {marker.suggestedShares} shares
                        {marker.originalSuggestedShares
                          ? ` / original ${marker.originalSuggestedShares}`
                          : ""}
                      </span>
                      <span
                        className={
                          actionable ? "text-emerald-300" : "text-slate-500"
                        }
                      >
                        {actionable ? "actionable" : "skipped"}
                      </span>
                    </div>
                    {marker.skippedReason && (
                      <div className="mt-1 text-slate-500">
                        skipped: {marker.skippedReason}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="mt-2 text-[10px] text-slate-500">
            Hover over B/S markers to inspect clustered Autopilot decisions from
            journal. Dashed markers are skipped / non-actionable signals.
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mt-3 text-[10px]">
        <div className="rounded-lg bg-slate-950/60 border border-slate-800 p-2">
          <div className="text-slate-500 font-black uppercase">Close</div>
          <div className="font-mono font-bold text-white">
            {latestClose ? formatMoney(latestClose) : "—"}
          </div>
        </div>
        <div className="rounded-lg bg-slate-950/60 border border-slate-800 p-2">
          <div className="text-slate-500 font-black uppercase">RSI</div>
          <div className="font-mono font-bold text-amber-300">
            {latestRsi ?? "—"}
          </div>
        </div>
        <div className="rounded-lg bg-slate-950/60 border border-slate-800 p-2">
          <div className="text-slate-500 font-black uppercase">MACD Hist</div>
          <div className="font-mono font-bold text-slate-300">
            {latestMacd ?? "—"}
          </div>
        </div>
        <div className="rounded-lg bg-slate-950/60 border border-slate-800 p-2">
          <div className="text-slate-500 font-black uppercase">Upper</div>
          <div className="font-mono font-bold text-slate-300">
            {latestUpper ? formatMoney(latestUpper) : "—"}
          </div>
        </div>
        <div className="rounded-lg bg-slate-950/60 border border-slate-800 p-2">
          <div className="text-slate-500 font-black uppercase">Lower</div>
          <div className="font-mono font-bold text-slate-300">
            {latestLower ? formatMoney(latestLower) : "—"}
          </div>
        </div>
      </div>
    </div>
  );
}
