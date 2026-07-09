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

export interface JournalRun {
  id: string;
  timestamp: string;
  trigger: "manual" | "scheduled";
  executeTrades: boolean;
  tradeMode: "paper" | "live";
  enabled: boolean;
  tickers: string[];
  signalReadyCount?: number;
  signalBlockedCount?: number;
  dryRunCount?: number;
  executedCount?: number;

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
  signalReadySignals: number;
  signalBlockedSignals: number;
  dryRunSignals: number;
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

function isBuySellSignal(action: string): boolean {
  return action === "BUY" || action === "SELL";
}

function isExecutionOnlySkippedReason(
  skippedReason: string | undefined,
): boolean {
  if (!skippedReason) return false;
  const reason = skippedReason.toLowerCase();

  return (
    reason.includes("dry-run") ||
    reason.includes("dry run") ||
    reason.includes("execution blocked") ||
    reason.includes("allow_autopilot") ||
    reason.includes("allow_buy") ||
    reason.includes("allow_sell") ||
    reason.includes("outside paper mode")
  );
}

function isDryRunDecision(decision: JournalDecision): boolean {
  if (decision.executionStatus === "dry_run") return true;
  const reason = decision.skippedReason?.toLowerCase() ?? "";
  return reason.includes("dry-run") || reason.includes("dry run");
}

function isSignalReadyDecision(decision: JournalDecision): boolean {
  const legacyDecision = decision as JournalDecision & {
    isActionable?: boolean;
  };

  if (
    decision.signalStatus === "ready" ||
    decision.isSignalReady === true ||
    legacyDecision.isActionable === true
  ) {
    return true;
  }

  if (
    decision.signalStatus === "blocked" ||
    decision.isSignalReady === false ||
    legacyDecision.isActionable === false
  ) {
    return false;
  }

  return (
    isBuySellSignal(decision.action) &&
    decision.suggestedShares > 0 &&
    decision.confidence >= 0.75 &&
    (!decision.skippedReason ||
      isExecutionOnlySkippedReason(decision.skippedReason))
  );
}

function calculateRunSignalCounts(decisions: JournalDecision[]) {
  const candidates = decisions.filter((decision) =>
    isBuySellSignal(decision.action),
  );
  const signalReady = candidates.filter(isSignalReadyDecision);
  const executed = candidates.filter(
    (decision) => decision.executed || decision.executionStatus === "executed",
  );
  const dryRun = signalReady.filter(isDryRunDecision);

  return {
    signalReadyCount: signalReady.length,
    signalBlockedCount: candidates.length - signalReady.length,
    dryRunCount: dryRun.length,
    executedCount: executed.length,
  };
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

  const calculatedCounts = calculateRunSignalCounts(run.decisions);
  const signalReadyCount =
    run.signalReadyCount ?? calculatedCounts.signalReadyCount;
  const signalBlockedCount =
    run.signalBlockedCount ?? calculatedCounts.signalBlockedCount;
  const dryRunCount = run.dryRunCount ?? calculatedCounts.dryRunCount;
  const executedCount = run.executedCount ?? calculatedCounts.executedCount;

  const runWithId: JournalRun = {
    ...run,
    id: createRunId(run.timestamp),
    strategyConfigHash,
    signalReadyCount,
    signalBlockedCount,
    dryRunCount,
    executedCount,
  };

  await fs.appendFile(JOURNAL_FILE, `${JSON.stringify(runWithId)}\n`, "utf-8");

  return runWithId;
}

// After weeks of continuous scheduled runs (one append per tick), the
// journal file can grow to tens of MB. Reading a bounded tail instead of
// the whole file keeps this fast and memory-stable no matter how long the
// bot has been running - readAutopilotRuns is polled by the dashboard
// every ~15s.
const JOURNAL_TAIL_READ_BYTES = 5 * 1024 * 1024; // ~1700+ runs at typical row size, far more than any `limit` used today

export async function readJournalTail(
  maxBytes: number,
  filePath: string = JOURNAL_FILE,
): Promise<string> {
  const stat = await fs.stat(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;

  if (length <= 0) return "";

  const fileHandle = await fs.open(filePath, "r");

  try {
    const buffer = Buffer.alloc(length);
    await fileHandle.read(buffer, 0, length, start);

    return buffer.toString("utf-8");
  } finally {
    await fileHandle.close();
  }
}

export async function readAutopilotRuns(
  limit = 50,
  filePath: string = JOURNAL_FILE,
  tailBytes: number = JOURNAL_TAIL_READ_BYTES,
): Promise<JournalRun[]> {
  try {
    const raw = await readJournalTail(tailBytes, filePath);
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const runs = lines
      .map((line) => {
        try {
          return JSON.parse(line) as JournalRun;
        } catch {
          // A tail read may start mid-line - the first fragment is
          // expected to fail to parse and is safely dropped.
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
    signalReadySignals: 0,
    signalBlockedSignals: 0,
    dryRunSignals: 0,
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

      if (isBuySellSignal(decision.action)) {
        if (isSignalReadyDecision(decision)) {
          summary.signalReadySignals += 1;
        } else {
          summary.signalBlockedSignals += 1;
        }

        if (isDryRunDecision(decision)) {
          summary.dryRunSignals += 1;
        }

        if (decision.executed || decision.executionStatus === "executed") {
          summary.executedSignals += 1;
        }
      }
    }
  }

  return summary;
}

export function getAutopilotJournalPath(): string {
  return JOURNAL_FILE;
}
