// Shared backend API and market data types.
// Extracted from server.ts to keep the Express entrypoint smaller.
export type UnknownRecord = Record<string, unknown>;

export interface AlpacaLike {
  getAccount(): Promise<unknown>;
  getPositions(): Promise<unknown>;
  getOrders(params?: unknown): Promise<unknown>;
  getLatestTrade(symbol: string): Promise<unknown>;
  createOrder(payload: unknown): Promise<unknown>;
}

export interface PositionSnapshot {
  shares: number;
  avgPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
}

export interface WatchlistItem {
  ticker: string;
  name: string;
  price: number;
  change: number;
  isUp: boolean;
}

export interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface AlpacaBarsResponse {
  bars?: AlpacaBar[];
  next_page_token?: string | null;
}

export interface MarketChartPoint {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  rsi: number | null;
  macdHistogram: number | null;
  bollingerLower: number | null;
  bollingerMiddle: number | null;
  bollingerUpper: number | null;
}

export interface MarketChartResponse {
  ticker: string;
  days: number;
  feed: string;
  points: MarketChartPoint[];
}

export interface AlpacaClockResponse {
  timestamp: string;
  is_open: boolean;
  next_open: string;
  next_close: string;
}

export interface MarketClockResponse {
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

export type AlpacaConstructor = new (config: {
  keyId: string;
  secretKey: string;
  paper: boolean;
}) => AlpacaLike;

export interface AlpacaNewsArticle {
  id: number;
  headline: string;
  summary: string;
  source: string;
  url: string;
  createdAt: string;
}

export interface NewsSentimentResult {
  ticker: string;
  sentiment: "BULLISH" | "BEARISH" | "NEUTRAL";
  summary: string;
  notableEvents: string[];
  articleCount: number;
  articles: AlpacaNewsArticle[];
}

export interface FundamentalResult {
  ticker: string;
  marketCap: string;
  peRatio: string;
  forwardPE: string;
  dividendYield: string;
  fiftyTwoWeekHigh: string;
  fiftyTwoWeekLow: string;
  analystRating: string;
}
