import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "circuit-breaker-state.json");

const AUTOPILOT_MAX_DRAWDOWN_FROM_PEAK_PERCENT = Number.parseFloat(
  process.env.AUTOPILOT_MAX_DRAWDOWN_FROM_PEAK_PERCENT || "-0.15",
);

export function getMaxDrawdownFromPeakPercent(): number {
  return AUTOPILOT_MAX_DRAWDOWN_FROM_PEAK_PERCENT;
}

export interface CircuitBreakerState {
  peakEquity: number;
  peakEquityAt: string;
  tripped: boolean;
  trippedAt: string | null;
}

export interface DrawdownEvaluation {
  tripped: boolean;
  drawdownPercent: number;
}

// Pure decision rule, kept separate from the file read/write orchestration
// below so it's testable without touching disk - same pattern as
// evaluateSentimentVeto/evaluateInsiderVeto in autopilotWorker.ts.
export function evaluatePortfolioDrawdown(
  currentEquity: number,
  peakEquity: number,
  maxDrawdownPercent: number = AUTOPILOT_MAX_DRAWDOWN_FROM_PEAK_PERCENT,
): DrawdownEvaluation {
  if (peakEquity <= 0) {
    return { tripped: false, drawdownPercent: 0 };
  }

  const drawdownPercent = (currentEquity - peakEquity) / peakEquity;

  return {
    tripped: drawdownPercent <= maxDrawdownPercent,
    drawdownPercent,
  };
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readState(): Promise<CircuitBreakerState | null> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf-8");
    return JSON.parse(raw) as CircuitBreakerState;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeState(state: CircuitBreakerState): Promise<void> {
  await ensureDataDir();
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

export interface CircuitBreakerUpdateResult {
  state: CircuitBreakerState;
  justTripped: boolean;
}

// Called exactly once per autopilot cycle (never per-ticker - analyzeTicker
// calls run concurrently via Promise.all, and a read-modify-write here from
// multiple concurrent callers would race). Bootstraps peak equity from
// whatever the current balance is on first run, rather than the account's
// older, already-explained history (see CLAUDE.md on the 2026-06 incident) -
// this breaker is meant to catch a NEW drawdown from here forward.
export async function updatePortfolioCircuitBreaker(
  currentEquity: number,
): Promise<CircuitBreakerUpdateResult> {
  const now = new Date().toISOString();
  const existing = await readState();

  if (!existing) {
    const state: CircuitBreakerState = {
      peakEquity: currentEquity,
      peakEquityAt: now,
      tripped: false,
      trippedAt: null,
    };
    await writeState(state);
    return { state, justTripped: false };
  }

  const peakEquity = Math.max(existing.peakEquity, currentEquity);
  const peakEquityAt =
    currentEquity > existing.peakEquity ? now : existing.peakEquityAt;

  const evaluation = evaluatePortfolioDrawdown(currentEquity, peakEquity);
  const justTripped = evaluation.tripped && !existing.tripped;

  const state: CircuitBreakerState = {
    peakEquity,
    peakEquityAt,
    tripped: evaluation.tripped || existing.tripped,
    trippedAt: justTripped ? now : existing.trippedAt,
  };

  await writeState(state);
  return { state, justTripped };
}

export async function resetPortfolioCircuitBreaker(
  currentEquity: number,
): Promise<CircuitBreakerState> {
  const state: CircuitBreakerState = {
    peakEquity: currentEquity,
    peakEquityAt: new Date().toISOString(),
    tripped: false,
    trippedAt: null,
  };
  await writeState(state);
  return state;
}

export async function getPortfolioCircuitBreakerState(): Promise<CircuitBreakerState | null> {
  return readState();
}
