import { promises as fs } from "fs";
import path from "path";

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

  const runWithId: JournalRun = {
    ...run,
    id: createRunId(run.timestamp),
  };

  await fs.appendFile(
    JOURNAL_FILE,
    `${JSON.stringify(runWithId)}\n`,
    "utf-8",
  );

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

export async function summarizeAutopilotRuns(limit = 200): Promise<JournalSummary> {
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
