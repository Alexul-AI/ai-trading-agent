import { calculateSMA } from "../../indicators.js";

export type RegimeState = "RISK_ON" | "RISK_OFF";

export interface RegimeBucketConfig {
  bucketId: string;
  label: string;
  tickers: string[];
  smaWindowDays: number;
  /**
   * When true, this bucket's tickers are never suppressed by the regime
   * filter regardless of computed state - a config knob to test, not a
   * preset assumption (see PORTFOLIO_REGIME_FILTER.md's own caution about
   * the high-beta-growth exemption being an unvalidated hypothesis).
   */
  exempt?: boolean;
}

export interface DailyBar {
  t: string;
  c: number;
}

export interface RegimeSuppressionResult {
  suppressed: boolean;
  reason: string;
}

function toDateKey(timestamp: string): string {
  return timestamp.split("T")[0] ?? timestamp;
}

// Pure, no I/O. Computes RISK_ON/RISK_OFF per date for one bucket. Buckets
// with more than one ticker (e.g. high_beta_growth) get a composite: average
// (price - sma)/sma deviation across whichever of the bucket's tickers have
// a bar on that date - date-aligned by intersection, not by array index,
// since different tickers can have different gaps (holidays, listing date).
// Dates without enough warmed-up data for any ticker simply have no entry -
// the caller (isBuySuppressedByRegime) treats a missing date as fail-open
// (RISK_ON), same philosophy as the sentiment/insider filters failing open
// on fetch errors rather than blocking a trade over a data problem.
export function computeBucketRegimeByDate(
  barsByTicker: Map<string, DailyBar[]>,
  bucket: RegimeBucketConfig,
): Map<string, RegimeState> {
  const deviationsByDate = new Map<string, number[]>();

  for (const ticker of bucket.tickers) {
    const bars = barsByTicker.get(ticker);
    if (!bars || bars.length <= bucket.smaWindowDays) continue;

    const closes = bars.map((bar) => bar.c);

    for (let i = bucket.smaWindowDays; i < bars.length; i += 1) {
      const bar = bars[i];
      if (!bar) continue;

      const sma = calculateSMA(closes.slice(0, i + 1), bucket.smaWindowDays);
      if (sma <= 0) continue;

      const deviation = (bar.c - sma) / sma;
      const dateKey = toDateKey(bar.t);

      const existing = deviationsByDate.get(dateKey);
      if (existing) {
        existing.push(deviation);
      } else {
        deviationsByDate.set(dateKey, [deviation]);
      }
    }
  }

  const regimeByDate = new Map<string, RegimeState>();

  for (const [dateKey, deviations] of deviationsByDate) {
    const average =
      deviations.reduce((sum, value) => sum + value, 0) / deviations.length;

    regimeByDate.set(dateKey, average >= 0 ? "RISK_ON" : "RISK_OFF");
  }

  return regimeByDate;
}

// Pure decision rule - deliberately has no concept of SELL/STOP_LOSS/
// TAKE_PROFIT at all, so it is structurally impossible for this function to
// gate an exit. Callers are expected to only invoke this from a BUY branch.
export function isBuySuppressedByRegime(
  regimeByBucketByDate: Map<string, Map<string, RegimeState>>,
  ticker: string,
  dateKey: string,
  tickerToBucket: Record<string, string>,
  buckets: RegimeBucketConfig[],
): RegimeSuppressionResult {
  const bucketId = tickerToBucket[ticker];

  if (!bucketId) {
    return {
      suppressed: false,
      reason: `No regime bucket mapped for ${ticker} - filter does not apply.`,
    };
  }

  const bucket = buckets.find((candidate) => candidate.bucketId === bucketId);

  if (!bucket) {
    return {
      suppressed: false,
      reason: `Unknown regime bucket ${bucketId} - filter does not apply.`,
    };
  }

  if (bucket.exempt) {
    return {
      suppressed: false,
      reason: `Bucket ${bucket.label} is exempt from the regime filter.`,
    };
  }

  const regime = regimeByBucketByDate.get(bucketId)?.get(dateKey);

  if (!regime) {
    return {
      suppressed: false,
      reason: `No regime data for ${bucket.label} on ${dateKey} - failing open.`,
    };
  }

  if (regime === "RISK_OFF") {
    return {
      suppressed: true,
      reason: `Bucket ${bucket.label} is RISK_OFF (below its ${bucket.smaWindowDays}-day trend) on ${dateKey}.`,
    };
  }

  return {
    suppressed: false,
    reason: `Bucket ${bucket.label} is RISK_ON on ${dateKey}.`,
  };
}
