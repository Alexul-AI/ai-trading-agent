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
  actionableCount: number;
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
  actionableSignals: number;
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
  actionableCount?: number;
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
