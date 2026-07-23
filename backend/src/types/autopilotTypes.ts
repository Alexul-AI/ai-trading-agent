// Autopilot worker types.
// Extracted from autopilotWorker.ts to keep the orchestration file smaller -
// same "pure move, re-exported so existing imports are untouched" pattern as
// src/strategy/portfolioSafety.ts's earlier extraction. Purely declarative:
// no runtime logic, matches src/types/serverTypes.ts's convention.

import type { OrderErrorClassification } from "../../orderIdempotency.js";
import type { StrategyDecision } from "../../strategyEngine.js";
import type {
  CircuitBreakerState,
  FetchEquityHistory,
} from "../../portfolioCircuitBreaker.js";
import type { PortfolioSnapshot } from "../strategy/portfolioSafety.js";

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

export interface ExecuteSafeTradeResult {
  status: string;
  reason?: string;
  /**
   * Only ever populated for a status: "error" result whose underlying
   * failure was classified by orderIdempotency.ts's classifyOrderError
   * (server.ts's ClassifiedOrderError) - distinguishes "definitely
   * rejected" from "ambiguous, might have actually gone through" for a
   * caller that needs that distinction (the ETF Rotation execution
   * adapter, etfRotationExecution.ts - see mapExecuteSafeTradeResultToLegOutcome
   * below). Absent for a "rejected" early-gate-check result (circuit
   * breaker, risk manager) - those are always definitively rejected,
   * there's no ambiguity to classify.
   */
  classification?: OrderErrorClassification;
  [key: string]: unknown;
}

export type ExecuteSafeTrade = (
  ticker: string,
  action: "BUY" | "SELL",
  requestedShares: number,
  orderType?: string,
  limitPrice?: number,
  stopLoss?: number,
  takeProfit?: number,
  requestedNotional?: number,
) => Promise<ExecuteSafeTradeResult>;

export interface AutopilotWorkerOptions {
  tradeMode: "paper" | "live";
  getPortfolioSnapshot: () => Promise<PortfolioSnapshot>;
  getEquityHistorySince: FetchEquityHistory;
  executeSafeTrade: ExecuteSafeTrade;
  broadcastSSE: (payload: unknown) => void;
  sendTelegramAlert?: (message: string) => Promise<void>;
  /**
   * Test-only file-path overrides for this worker's real, on-disk side
   * effects (worker lock, circuit-breaker state/audit log, ETF-rotation
   * state, decision journal). server.ts's real construction never
   * populates this - every field defaults to undefined, which every
   * underlying function already treats as "use the real /data file," so
   * production behavior is unchanged. Exists so characterization tests can
   * point a real createAutopilotWorker() instance at temp files instead of
   * touching live paper-trading state - see docs/ops/AUTOPILOT_WORKER_MAP.md.
   */
  testDataFilePaths?: {
    lockFilePath?: string;
    etfRotationStateFilePath?: string;
    etfRotationOrderAuditLogFilePath?: string;
    circuitBreakerStateFilePath?: string;
    circuitBreakerAuditLogFilePath?: string;
    journalFilePath?: string;
  };
}

export type SignalStatus = "hold" | "blocked" | "ready";
export type ExecutionStatus =
  | "not_attempted"
  | "dry_run"
  | "blocked"
  | "executed"
  | "failed"
  // Only reachable via the ETF Rotation execution path (PR #47b) - the
  // baseline path's executeSafeTrade call never distinguishes this from
  // "failed" (see analyzeTicker's own success/failure branch). An
  // ambiguous leg's outcome genuinely isn't known - never treated as a
  // silent success or a confident rejection (design doc §8).
  | "ambiguous";

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
  | "regime_filter"
  | "error"
  | "other";

export type ExecutionBlockReasonCategory =
  | "dry_run"
  | "trade_mode"
  | "permission"
  | "broker"
  | "other";

export interface AutopilotDecisionLog {
  ticker: string;
  timestamp: string;
  price: number;
  /**
   * Optional - single-ticker confluence-scoring indicators (strategyEngine.ts)
   * with no equivalent for an ETF Rotation rebalance decision (see
   * etfRotationStrategy.ts). Omitted for rotation decisions rather than
   * populated with misleading placeholder values.
   */
  rsi?: number;
  macdHistogram?: number;
  previousMacdHistogram?: number;
  bollingerLower?: number;
  bollingerUpper?: number;
  action: StrategyDecision["action"];
  confidence: number;
  suggestedShares: number;
  originalSuggestedShares?: number;
  /** Fractional-fallback dollar amount, set only when using notional sizing. */
  suggestedNotional?: number;
  originalSuggestedNotional?: number;
  /** A plain string, not restricted to StrategyDecision's own reasonType union - the ETF Rotation path uses its own vocabulary (REBALANCE_BUY/REBALANCE_SELL/etc), matching decisionJournal.ts's JournalDecision.reasonType (also an unrestricted string). */
  reasonType: string;
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
  result?: ExecuteSafeTradeResult;
}

export interface AutopilotStatus {
  enabled: boolean;
  executeTrades: boolean;
  allowBuy: boolean;
  allowSell: boolean;
  /** Only meaningful when strategyVersion is an etf-rotation variant - see EtfRotationExecutionGates.allowRebalanceSells. */
  allowRebalanceSells: boolean;
  tradeMode: "paper" | "live";
  strategyVersion: string;
  strategyConfigHash: string;
  strategyConfig: Record<string, unknown>;
  running: boolean;
  intervalMs: number;
  tickers: string[];
  minConfidence: number;
  maxSellFraction: number;
  blockSellBelowAverageEntry: boolean;
  telegramCooldownMinutes: number;
  lastJournalRunId: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  lastDecisions: AutopilotDecisionLog[];
  circuitBreaker: CircuitBreakerState | null;
  circuitBreakerMaxDrawdownFromPeakPercent: number;
}

export type AutopilotStrategyKind = "baseline" | "etf_rotation";

export interface SentimentCacheEntry {
  sentiment: string;
  summary: string;
  fetchedAt: number;
}

export interface SentimentVetoResult {
  blocked: boolean;
  note: string;
}

export interface InsiderCacheEntry {
  buyCount: number;
  sellCount: number;
  fetchedAt: number;
}
