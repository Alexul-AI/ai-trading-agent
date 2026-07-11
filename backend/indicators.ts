export interface MacdResult {
  macd: number;
  signal: number;
  histogram: number;
}

export interface BollingerBandsResult {
  upper: number;
  lower: number;
  sma: number;
}

export interface AtrBar {
  h: number;
  l: number;
  c: number;
}

// Wilder smoothing, same recursive-average style as calculateRSI below -
// seed from a simple average over the first `periods` true ranges, then
// smooth. Returns ATR in absolute price units, not a percent.
export function calculateATR(bars: AtrBar[], periods = 14): number {
  if (bars.length <= periods) return 0;

  const trueRanges: number[] = [];

  for (let i = 1; i < bars.length; i += 1) {
    const current = bars[i];
    const previous = bars[i - 1];
    if (!current || !previous) continue;

    const highLow = current.h - current.l;
    const highPrevClose = Math.abs(current.h - previous.c);
    const lowPrevClose = Math.abs(current.l - previous.c);

    trueRanges.push(Math.max(highLow, highPrevClose, lowPrevClose));
  }

  if (trueRanges.length <= periods) return 0;

  let atr =
    trueRanges.slice(0, periods).reduce((sum, tr) => sum + tr, 0) / periods;

  for (let i = periods; i < trueRanges.length; i += 1) {
    const tr = trueRanges[i] ?? 0;
    atr = (atr * (periods - 1) + tr) / periods;
  }

  return Number(atr.toFixed(4));
}

export function calculateRSI(prices: number[], periods = 14): number {
  if (prices.length <= periods) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= periods; i += 1) {
    const diff = (prices[i] ?? 0) - (prices[i - 1] ?? 0);

    if (diff > 0) {
      gains += diff;
    } else {
      losses -= diff;
    }
  }

  let avgGain = gains / periods;
  let avgLoss = losses / periods;

  for (let i = periods + 1; i < prices.length; i += 1) {
    const diff = (prices[i] ?? 0) - (prices[i - 1] ?? 0);

    avgGain = (avgGain * (periods - 1) + (diff > 0 ? diff : 0)) / periods;
    avgLoss = (avgLoss * (periods - 1) + (diff < 0 ? -diff : 0)) / periods;
  }

  if (avgLoss === 0) return 100;

  return Number((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
}

export function calculateEMA(prices: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [];

  if (prices.length === 0) return ema;

  ema.push(prices[0] ?? 0);

  for (let i = 1; i < prices.length; i += 1) {
    ema.push((prices[i] ?? 0) * k + (ema[i - 1] ?? 0) * (1 - k));
  }

  return ema;
}

export function calculateMACD(prices: number[]): MacdResult {
  if (prices.length < 26) {
    return { macd: 0, signal: 0, histogram: 0 };
  }

  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  const macdLine = prices.map((_, i) => (ema12[i] ?? 0) - (ema26[i] ?? 0));
  const signalLine = calculateEMA(macdLine.slice(25), 9);

  const currentMacd = macdLine[macdLine.length - 1] ?? 0;
  const currentSignal = signalLine[signalLine.length - 1] ?? 0;

  return {
    macd: Number(currentMacd.toFixed(4)),
    signal: Number(currentSignal.toFixed(4)),
    histogram: Number((currentMacd - currentSignal).toFixed(4)),
  };
}

export function calculateSMA(prices: number[], period: number): number {
  if (prices.length < period) return 0;

  const slice = prices.slice(-period);
  return slice.reduce((sum, price) => sum + price, 0) / slice.length;
}

export function calculateBollingerBands(
  prices: number[],
  period = 20,
  multiplier = 2,
): BollingerBandsResult {
  if (prices.length < period) {
    return { upper: 0, lower: 0, sma: 0 };
  }

  const slice = prices.slice(-period);
  const sma = slice.reduce((sum, price) => sum + price, 0) / period;
  const variance =
    slice.reduce((sum, price) => sum + Math.pow(price - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  return {
    sma: Number(sma.toFixed(2)),
    upper: Number((sma + stdDev * multiplier).toFixed(2)),
    lower: Number((sma - stdDev * multiplier).toFixed(2)),
  };
}
