import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";

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
  | "error"
  | "other";

export type ExecutionBlockReasonCategory =
  | "dry_run"
  | "trade_mode"
  | "permission"
  | "broker"
  | "other";

export interface JournalDecision {
  ticker: string;
  timestamp: string;
  price: number;
  rsi: number;
  macdHistogram: number;
  previousMacdHistogram: number;
  bollingerLower: number;
  bollingerUpper: number;
  action: "BUY" | "SELL" | "HOLD";
  confidence: number;
  suggestedShares: number;
  originalSuggestedShares?: number;
  reasonType: string;
  reason: string;
  safetyNote?: string;

  /**
   * Structured decision state.
   *
   * Signal status answers: "Was this a real strategy/safety-ready signal?"
   * Execution status answers: "Was it executed, dry-run skipped, or blocked?"
   *
   * This avoids treating DRY-RUN as a bad strategy signal.
   */
  finalStatus?: DecisionFinalStatus;
  signalStatus?: SignalStatus;
  executionStatus?: ExecutionStatus;
  isActionable?: boolean;
  blockReasonCategory?: BlockReasonCategory;
  blockReasonCode?: string;
  blockReasonDetail?: string;
  executionBlockReasonCategory?: ExecutionBlockReasonCategory;
  executionBlockReasonCode?: string;
  executionBlockReasonDetail?: string;

  executed: boolean;
  skippedReason?: string;
}

export interface JournalRun {
  id: string;
  timestamp: string;
  trigger: "manual" | "scheduled";
  executeTrades: boolean;
  tradeMode: "paper" | "live";
  enabled: boolean;
  tickers: string[];
  actionableCount: number;

  /**
   * Strategy metadata enables clean comparisons after algorithm changes.
   * Old journal rows will not have these fields and should be treated as legacy.
   */
  strategyVersion?: string;
  strategyConfigHash?: string;
  strategyConfig?: Record<string, unknown>;

  decisions: JournalDecision[];
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

const DATA_DIR = path.resolve(process.cwd(), "data");
const JOURNAL_FILE = path.join(DATA_DIR, "autopilot-decisions.jsonl");

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const objectValue = value as Record<string, unknown>;
  const keys = Object.keys(objectValue).sort();

  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`)
    .join(",")}}`;
}

export function createStrategyConfigHash(config: unknown): string {
  return createHash("sha256")
    .update(stableStringify(config))
    .digest("hex")
    .slice(0, 12);
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function createRunId(timestamp: string): string {
  return `run_${timestamp.replace(/[:.]/g, "-")}`;
}

export async function appendAutopilotRun(
  run: Omit<JournalRun, "id">,
): Promise<JournalRun> {
  await ensureDataDir();

  const strategyConfigHash =
    run.strategyConfigHash ??
    (run.strategyConfig
      ? createStrategyConfigHash(run.strategyConfig)
      : undefined);

  const runWithId: JournalRun = {
    ...run,
    id: createRunId(run.timestamp),
    strategyConfigHash,
  };

  await fs.appendFile(JOURNAL_FILE, `${JSON.stringify(runWithId)}\n`, "utf-8");

  return runWithId;
}

export async function readAutopilotRuns(limit = 50): Promise<JournalRun[]> {
  try {
    const raw = await fs.readFile(JOURNAL_FILE, "utf-8");
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const runs = lines
      .map((line) => {
        try {
          return JSON.parse(line) as JournalRun;
        } catch {
          return null;
        }
      })
      .filter((run): run is JournalRun => run !== null);

    return runs.slice(-limit).reverse();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export async function summarizeAutopilotRuns(
  limit = 200,
): Promise<JournalSummary> {
  const runs = await readAutopilotRuns(limit);
  const chronologicalRuns = [...runs].reverse();

  const summary: JournalSummary = {
    totalRuns: chronologicalRuns.length,
    totalDecisions: 0,
    actionableSignals: 0,
    executedSignals: 0,
    byAction: {},
    byTicker: {},
    byReasonType: {},
    lastRunAt: chronologicalRuns.at(-1)?.timestamp ?? null,
  };

  for (const run of chronologicalRuns) {
    for (const decision of run.decisions) {
      summary.totalDecisions += 1;

      summary.byAction[decision.action] =
        (summary.byAction[decision.action] ?? 0) + 1;

      summary.byTicker[decision.ticker] =
        (summary.byTicker[decision.ticker] ?? 0) + 1;

      summary.byReasonType[decision.reasonType] =
        (summary.byReasonType[decision.reasonType] ?? 0) + 1;

      if (decision.action !== "HOLD" && decision.confidence >= 0.75) {
        summary.actionableSignals += 1;
      }

      if (decision.executed) {
        summary.executedSignals += 1;
      }
    }
  }

  return summary;
}

export function getAutopilotJournalPath(): string {
  return JOURNAL_FILE;
}
