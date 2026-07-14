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
  // Recomputed fresh each cycle (not sticky like `tripped`): true when the
  // most recent equity-history fetch failed, so peakEquity/drawdown for
  // this cycle could not be confirmed. New BUYs are blocked while this is
  // true - a hard safety layer should fail closed on new risk, not fail
  // open just because a data fetch had a bad moment. SELL/STOP_LOSS are
  // never affected by this, same as `tripped`.
  dataStale: boolean;
  // Calendar date ("YYYY-MM-DD") the last daily halted-reminder was sent,
  // or null if none has been sent since the current trip (or ever). Reset
  // alongside trippedAt so a fresh trip gets its own fresh reminder cadence.
  lastReminderSentDate: string | null;
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
// Sticky by design: once tripped, stays tripped regardless of what a
// fresh evaluation says (e.g. equity recovering to a new post-trip high
// would make evaluatePortfolioDrawdown report tripped=false again - this
// function is what prevents that from silently un-tripping the breaker).
// Shared by updatePortfolioCircuitBreaker below and backtest-portfolio.ts,
// so live and backtest can't silently diverge on this rule.
export function applyStickyTrip(
  evaluationTripped: boolean,
  wasTripped: boolean,
): boolean {
  return evaluationTripped || wasTripped;
}

// Pure - same reasoning as applyStickyTrip: keep the "should we act" decision
// testable without I/O. Reminders are calendar-day-scoped (not cycle-scoped,
// since the autopilot cycle runs roughly hourly) - true at most once per
// distinct todayDateKey while tripped, never while not tripped.
export function shouldSendDailyReminder(
  tripped: boolean,
  lastReminderSentDate: string | null,
  todayDateKey: string,
): boolean {
  return tripped && lastReminderSentDate !== todayDateKey;
}

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
// tick by up to a day. `cachedPeak` (the last successfully-recorded peak,
// if any) is also a candidate - without it, a history-fetch failure would
// silently recompute peakEquity from currentEquity alone, potentially
// *lowering* the recorded peak below a real, previously-confirmed high and
// masking how deep the actual drawdown is.
export function findPeakSinceTracking(
  history: EquityHistoryPoint[],
  currentEquity: number,
  now: string,
  cachedPeak?: { equity: number; at: string },
): { peakEquity: number; peakEquityAt: string } {
  let peakEquity = currentEquity;
  let peakEquityAt = now;

  if (cachedPeak && cachedPeak.equity > peakEquity) {
    peakEquity = cachedPeak.equity;
    peakEquityAt = cachedPeak.at;
  }

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

  // A fetch failure never crashes the whole autopilot cycle - a crash here
  // would block SELL/STOP_LOSS evaluation too, not just this breaker's own
  // check. But it also must not fail *open* for new risk: dataStale below
  // blocks new BUYs for this cycle when we can't confirm the real drawdown,
  // the same way a hard safety layer should fail closed on uncertainty
  // rather than assume the best case. SELL/STOP_LOSS are never affected.
  let history: EquityHistoryPoint[] = [];
  let dataStale = false;
  try {
    history = await fetchEquityHistory(trackingStartDate);
  } catch (error) {
    dataStale = true;
    console.warn(
      "[CIRCUIT BREAKER] Failed to fetch equity history - new BUYs blocked for this cycle until it succeeds again:",
      error instanceof Error ? error.message : error,
    );
  }

  const cachedPeak = existing
    ? { equity: existing.peakEquity, at: existing.peakEquityAt }
    : undefined;

  const { peakEquity, peakEquityAt } = findPeakSinceTracking(
    history,
    currentEquity,
    now,
    cachedPeak,
  );

  const evaluation = evaluatePortfolioDrawdown(currentEquity, peakEquity);
  const wasTripped = existing?.tripped ?? false;
  const justTripped = evaluation.tripped && !wasTripped;

  const state: CircuitBreakerState = {
    trackingStartDate,
    peakEquity,
    peakEquityAt,
    tripped: applyStickyTrip(evaluation.tripped, wasTripped),
    trippedAt: justTripped ? now : (existing?.trippedAt ?? null),
    dataStale,
    lastReminderSentDate: existing?.lastReminderSentDate ?? null,
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
    dataStale: false,
    lastReminderSentDate: null,
  };
  await writeState(state);
  return state;
}

export async function getPortfolioCircuitBreakerState(): Promise<CircuitBreakerState | null> {
  return readState();
}

// Called at most once per calendar day while tripped, right after
// shouldSendDailyReminder confirms a reminder should go out - see
// autopilotWorker.ts's single per-cycle circuit-breaker update call site.
export async function recordReminderSent(todayDateKey: string): Promise<void> {
  const existing = await readState();
  if (!existing) return;

  await writeState({ ...existing, lastReminderSentDate: todayDateKey });
}
