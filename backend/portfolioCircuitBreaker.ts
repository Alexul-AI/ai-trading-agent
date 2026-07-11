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

// Only trackingStartDate/tripped/trippedAt are authoritative on disk.
// peakEquity/peakEquityAt are recomputed every call from Alpaca's own
// portfolio history (see findPeakSinceTracking + fetchEquityHistory below)
// and just cached here for convenience/debugging - the broker already
// keeps this data durably, so we don't need to be the source of truth for
// it ourselves. This shrinks what a lost/corrupted local file can actually
// cost us: worst case, trackingStartDate resets to "now" (same graceful
// bootstrap as before), not a silently wrong peak.
export interface CircuitBreakerState {
  trackingStartDate: string;
  peakEquity: number;
  peakEquityAt: string;
  tripped: boolean;
  trippedAt: string | null;
}

export interface DrawdownEvaluation {
  tripped: boolean;
  drawdownPercent: number;
}

export interface EquityHistoryPoint {
  timestamp: number; // unix seconds, matches Alpaca's portfolio history response
  equity: number;
}

export type FetchEquityHistory = (
  startDate: string,
) => Promise<EquityHistoryPoint[]>;

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

// Pure - also testable without I/O. currentEquity is included as a
// candidate (not just history) since Alpaca's history may lag the live
// tick by up to a day.
export function findPeakSinceTracking(
  history: EquityHistoryPoint[],
  currentEquity: number,
  now: string,
): { peakEquity: number; peakEquityAt: string } {
  let peakEquity = currentEquity;
  let peakEquityAt = now;

  for (const point of history) {
    if (point.equity > peakEquity) {
      peakEquity = point.equity;
      peakEquityAt = new Date(point.timestamp * 1000).toISOString();
    }
  }

  return { peakEquity, peakEquityAt };
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
// multiple concurrent callers would race). Bootstraps trackingStartDate
// from now on first run, rather than the account's older, already-explained
// history (see CLAUDE.md on the 2026-06 incident) - this breaker is meant
// to catch a NEW drawdown from here forward.
export async function updatePortfolioCircuitBreaker(
  currentEquity: number,
  fetchEquityHistory: FetchEquityHistory,
): Promise<CircuitBreakerUpdateResult> {
  const now = new Date().toISOString();
  const existing = await readState();
  const trackingStartDate = existing?.trackingStartDate ?? now;

  // Fails open to an empty history (peak falls back to currentEquity for
  // this cycle only) rather than letting a fetch error crash the whole
  // autopilot cycle - a crash here would block SELL/STOP_LOSS evaluation
  // too, not just this breaker's own check, which is worse than missing one
  // cycle's peak update. Critically, this can never un-trip an already-
  // tripped breaker: `tripped` below is carried forward from the persisted
  // state regardless of what happens to the history fetch.
  let history: EquityHistoryPoint[] = [];
  try {
    history = await fetchEquityHistory(trackingStartDate);
  } catch (error) {
    console.warn(
      "[CIRCUIT BREAKER] Failed to fetch equity history, falling back to current equity as peak for this cycle:",
      error instanceof Error ? error.message : error,
    );
  }

  const { peakEquity, peakEquityAt } = findPeakSinceTracking(
    history,
    currentEquity,
    now,
  );

  const evaluation = evaluatePortfolioDrawdown(currentEquity, peakEquity);
  const wasTripped = existing?.tripped ?? false;
  const justTripped = evaluation.tripped && !wasTripped;

  const state: CircuitBreakerState = {
    trackingStartDate,
    peakEquity,
    peakEquityAt,
    tripped: evaluation.tripped || wasTripped,
    trippedAt: justTripped ? now : (existing?.trippedAt ?? null),
  };

  await writeState(state);
  return { state, justTripped };
}

export async function resetPortfolioCircuitBreaker(
  currentEquity: number,
): Promise<CircuitBreakerState> {
  const now = new Date().toISOString();
  const state: CircuitBreakerState = {
    trackingStartDate: now,
    peakEquity: currentEquity,
    peakEquityAt: now,
    tripped: false,
    trippedAt: null,
  };
  await writeState(state);
  return state;
}

export async function getPortfolioCircuitBreakerState(): Promise<CircuitBreakerState | null> {
  return readState();
}
