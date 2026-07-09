export type TradeMode = "paper" | "live";
export type SignalAction = "BUY" | "SELL" | "HOLD";
export type ReasonType =
  | "BUY_SIGNAL"
  | "SELL_SIGNAL"
  | "STOP_LOSS"
  | "TAKE_PROFIT"
  | "NO_SIGNAL"
  | "RISK_LIMIT";

export interface Position {
  shares: number;
  avgPrice: number;
  currentPrice?: number;
  pnl?: number;
  pnlPercent?: number;
}

export interface Portfolio {
  balance: number;
  equity?: number;
  currency: string;
  positions: Record<string, Position>;
}

export interface Order {
  id: string;
  ticker: string;
  action: string;
  qty: number;
  orderType: string;
  limitPrice: number | null;
  status: string;
}

export interface WatchlistItem {
  ticker: string;
  name: string;
  price: number;
  change: number;
  isUp: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "agent";
  content: string;
  timestamp: string;
}

export type SignalStatus = "hold" | "blocked" | "ready";
export type ExecutionStatus =
  | "not_attempted"
  | "dry_run"
  | "blocked"
  | "executed"
  | "failed";

export type DecisionFinalStatus =
  | "hold"
  | "blocked"
  | "signal_ready"
  | "executed"
  | "execution_failed"
  | "error";

export type BlockReasonCategory =
  | "confidence"
  | "position_guard"
  | "safety_cap"
  | "quantity"
  | "sentiment_filter"
  | "insider_filter"
  | "error"
  | "other";

export type ExecutionBlockReasonCategory =
  | "dry_run"
  | "trade_mode"
  | "permission"
  | "broker"
  | "other";

export interface AutopilotDecision {
  ticker: string;
  timestamp: string;
  price: number;
  rsi: number;
  macdHistogram: number;
  previousMacdHistogram: number;
  bollingerLower: number;
  bollingerUpper: number;
  action: SignalAction;
  confidence: number;
  suggestedShares: number;
  originalSuggestedShares?: number;
  reasonType: ReasonType;
  reason: string;
  safetyNote?: string;
  finalStatus?: DecisionFinalStatus;
  signalStatus?: SignalStatus;
  executionStatus?: ExecutionStatus;
  isSignalReady?: boolean;
  blockReasonCategory?: BlockReasonCategory;
  blockReasonCode?: string;
  blockReasonDetail?: string;
  executionBlockReasonCategory?: ExecutionBlockReasonCategory;
  executionBlockReasonCode?: string;
  executionBlockReasonDetail?: string;
  executed: boolean;
  skippedReason?: string;
}

export interface AutopilotStatus {
  enabled: boolean;
  executeTrades: boolean;
  allowBuy: boolean;
  allowSell: boolean;
  tradeMode: TradeMode;
  strategyVersion?: string;
  strategyConfigHash?: string;
  strategyConfig?: Record<string, unknown>;
  running: boolean;
  intervalMs: number;
  tickers: string[];
  minConfidence: number;
  maxSellFraction: number;
  telegramCooldownMinutes: number;
  lastJournalRunId?: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  lastDecisions: AutopilotDecision[];
}

export interface JournalRun {
  id: string;
  timestamp: string;
  trigger: "manual" | "scheduled";
  executeTrades: boolean;
  tradeMode: TradeMode;
  enabled: boolean;
  tickers: string[];
  signalReadyCount?: number;
  signalBlockedCount?: number;
  dryRunCount?: number;
  executedCount?: number;
  strategyVersion?: string;
  strategyConfigHash?: string;
  strategyConfig?: Record<string, unknown>;
  decisions: AutopilotDecision[];
}

export interface JournalResponse {
  file: string;
  runs: JournalRun[];
}

export interface JournalSummary {
  totalRuns: number;
  totalDecisions: number;
  signalReadySignals?: number;
  signalBlockedSignals?: number;
  dryRunSignals?: number;
  executedSignals: number;
  byAction: Record<string, number>;
  byTicker: Record<string, number>;
  byReasonType: Record<string, number>;
  lastRunAt: string | null;
}

export interface DashboardResponse {
  tradeMode?: TradeMode;
  autopilotEnabled?: boolean;
  autopilot?: AutopilotStatus;
  portfolio?: Portfolio;
  orders?: Order[];
  watchlist?: WatchlistItem[];
  health?: DashboardHealthSummary;
}

export interface AutopilotRunResponse {
  skipped: boolean;
  reason?: string;
  decisions?: AutopilotDecision[];
  signalReadyCount?: number;
  signalBlockedCount?: number;
  dryRunCount?: number;
  executedCount?: number;
  status: AutopilotStatus;
  error?: string;
}

export interface AutopilotToggleResponse {
  success: boolean;
  enabled: boolean;
  autopilot: AutopilotStatus;
}

export interface ChatResponse {
  reply?: string;
}

export interface NewsArticle {
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
  articles: NewsArticle[];
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

export interface InsiderTransaction {
  reportingOwnerName: string;
  title: string;
  transactionDate: string;
  transactionCode: string;
  transactionCodeLabel: string;
  isOpenMarket: boolean;
  shares: number;
  pricePerShare: number | null;
  acquiredOrDisposed: "A" | "D";
  sharesOwnedAfter: number | null;
  filingUrl: string;
}

export interface PersonnelFiling {
  filingDate: string;
  itemCodes: string;
  summary: string;
  filingUrl: string;
}

export interface InsiderActivityResult {
  ticker: string;
  transactions: InsiderTransaction[];
  personnelFilings: PersonnelFiling[];
}

export interface TradeResponse {
  success?: boolean;
  error?: string;
  result?: unknown;
}

export interface SseEvent {
  type?: string;
  tradeMode?: TradeMode;
  autopilot?: AutopilotStatus;
  enabled?: boolean;
  executeTrades?: boolean;
  message?: string;
  data?: AutopilotDecision;
  decisions?: AutopilotDecision[];
  signalReadyCount?: number;
  signalBlockedCount?: number;
  dryRunCount?: number;
  executedCount?: number;
  timestamp?: string;
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

export interface DashboardHealthWarning {
  service: string;
  status: "ok" | "missing" | "warning" | "error";
  message: string;
}

export interface DashboardHealthSummary {
  ok: boolean;
  warnings: DashboardHealthWarning[];
}
