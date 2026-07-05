// Market chart point construction helpers.
// Keeps technical indicator calculation out of server.ts.

import {
  calculateBollingerBands,
  calculateMACD,
  calculateRSI,
} from "../../indicators.js";
import type { AlpacaBar, MarketChartPoint } from "../types/serverTypes.js";
import { roundOrNull } from "../utils/values.js";

export function buildMarketChartPoints(bars: AlpacaBar[]): MarketChartPoint[] {
  return bars.map((bar, index) => {
    const closesUpToPoint = bars.slice(0, index + 1).map((item) => item.c);

    const hasRsi = closesUpToPoint.length >= 15;
    const hasMacd = closesUpToPoint.length >= 35;
    const hasBollinger = closesUpToPoint.length >= 20;

    const rsi = hasRsi ? calculateRSI(closesUpToPoint, 14) : null;
    const macd = hasMacd ? calculateMACD(closesUpToPoint) : null;
    const bb = hasBollinger
      ? calculateBollingerBands(closesUpToPoint, 20, 2)
      : null;

    return {
      date: bar.t.split("T")[0] ?? bar.t,
      open: Number(bar.o.toFixed(2)),
      high: Number(bar.h.toFixed(2)),
      low: Number(bar.l.toFixed(2)),
      close: Number(bar.c.toFixed(2)),
      volume: bar.v,
      rsi: roundOrNull(rsi, 2),
      macdHistogram: roundOrNull(macd?.histogram, 4),
      bollingerLower: roundOrNull(bb?.lower, 2),
      bollingerMiddle: bb ? roundOrNull((bb.upper + bb.lower) / 2, 2) : null,
      bollingerUpper: roundOrNull(bb?.upper, 2),
    };
  });
}
