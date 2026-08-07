import { promises as fs } from "fs";
import path from "path";

import { appendCircuitBreakerAuditEvent } from "./circuitBreakerAuditLog.js";

// Small, stateless, deliberately duplicated rather than shared via a new
// module - same precedent as autopilotWorker.ts/analyzeTicker.ts (see
// docs/ops/AUTOPILOT_WORKER_MAP.md).
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

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

// `filePath` defaults to the real state file; every production call site
// omits it. The override exists solely so tests can point this at a real
// temp file directly instead of mocking fs or mutating global
// process.cwd() - same convention as orderIdempotency.ts's persisted
// tracker.
async function readState(
  filePath: string = STATE_FILE,
): Promise<CircuitBreakerState | null> {
  let raw: string;

  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  try {
    return JSON.parse(raw) as CircuitBreakerState;
  } catch (error) {
    // A corrupted/partially-written file (e.g. the process died mid-write
    // before the atomic-rename fix below existed) is treated the same as a
    // missing one - see the comment above CircuitBreakerState: tracking
    // just restarts from now, rather than this throwing and crashing every
    // future autopilot cycle that tries to re-parse it.
    console.warn(
      `[CIRCUIT BREAKER] State file at ${filePath} is corrupted and could not be parsed - treating as absent:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

async function writeState(
  state: CircuitBreakerState,
  filePath: string = STATE_FILE,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  // Atomic write: write to a temp file first, then rename over the real
  // path. fs.rename is atomic at the OS level, so a process killed mid-write
  // (e.g. SIGTERM during a Render redeploy - confirmed to actually happen,
  // see CLAUDE.md) can never leave a half-written/corrupted state file at
  // the real path - the old file stays intact until the new one is fully
  // written.
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  await fs.rename(tmpPath, filePath);
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
  filePath: string = STATE_FILE,
): Promise<CircuitBreakerUpdateResult> {
  const now = new Date().toISOString();
  const existing = await readState(filePath);
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

  await writeState(state, filePath);
  return { state, justTripped };
}

export async function resetPortfolioCircuitBreaker(
  currentEquity: number,
  filePath: string = STATE_FILE,
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
  await writeState(state, filePath);
  return state;
}

export async function getPortfolioCircuitBreakerState(
  filePath: string = STATE_FILE,
): Promise<CircuitBreakerState | null> {
  return readState(filePath);
}

// Called at most once per calendar day while tripped, right after
// shouldSendDailyReminder confirms a reminder should go out - see
// autopilotWorker.ts's single per-cycle circuit-breaker update call site.
export async function recordReminderSent(
  todayDateKey: string,
  filePath: string = STATE_FILE,
): Promise<void> {
  const existing = await readState(filePath);
  if (!existing) return;

  await writeState({ ...existing, lastReminderSentDate: todayDateKey }, filePath);
}

// Extracted from autopilotWorker.ts's runOnce() (2026-08-07, autopilotWorker
// refactor Slice 1 - see docs/ops/AUTOPILOT_WORKER_MAP.md) - a pure move, no
// behavior change. The call site in runOnce() must stay unwrapped (no
// try/catch around the call) and this function must not swallow errors -
// today, a sendTelegramAlert failure here aborts the rest of that cycle
// (regime prefetch, strategy dispatch, journal write) via runOnce()'s own
// outer catch. That's pre-existing behavior this move must not change, not
// something to "fix" as a drive-by - see the daily reminder function below
// for the deliberately different (isolated, try/catch-wrapped) treatment.
export async function runCircuitBreakerTripAlert(params: {
  justTripped: boolean;
  state: CircuitBreakerState;
  portfolioEquity: number;
  drawdownPercent: number;
  broadcastSSE: (payload: unknown) => void;
  sendTelegramAlert?: (message: string) => Promise<void>;
  auditLogFilePath?: string;
}): Promise<void> {
  if (!params.justTripped) return;

  const alertMessage = `PORTFOLIO CIRCUIT BREAKER TRIPPED: equity ${params.portfolioEquity.toFixed(
    2,
  )} is down ${params.drawdownPercent.toFixed(
    1,
  )}% from peak ${params.state.peakEquity.toFixed(
    2,
  )}. New BUYs are blocked until manually reset.`;

  params.broadcastSSE({
    type: "notification",
    level: "error",
    message: alertMessage,
  });

  if (params.sendTelegramAlert) {
    await params.sendTelegramAlert(alertMessage);
  }

  await appendCircuitBreakerAuditEvent(
    {
      type: "CIRCUIT_BREAKER_TRIPPED",
      timestamp: params.state.trippedAt ?? new Date().toISOString(),
      equity: params.portfolioEquity,
      peakEquity: params.state.peakEquity,
      drawdownPercent: params.drawdownPercent,
      thresholdPercent: getMaxDrawdownFromPeakPercent() * 100,
    },
    params.auditLogFilePath,
  );
}

// Extracted from autopilotWorker.ts's runOnce() (2026-08-07, autopilotWorker
// refactor Slice 1) - a pure move, no behavior change. Once-per-calendar-day
// nudge while the breaker stays tripped - the trip alert above only fires
// once, ever, on the transition; this is what stops a long halt (see
// CLAUDE.md's next-open finding: 315 of 406 simulated days) from going
// unnoticed in between. Idempotency ordering (2026-08-07, PR #65): the audit
// event + lastReminderSentDate are recorded BEFORE the SSE/Telegram send,
// not after - see recordReminderSent's own call site below. Isolated in its
// own try/catch (PR #65) so a Telegram failure here can never abort the rest
// of the calling cycle, unlike the trip alert above.
export async function runCircuitBreakerDailyReminder(params: {
  state: CircuitBreakerState;
  portfolioEquity: number;
  drawdownPercent: number;
  decisions: Array<{ blockReasonCode?: string }>;
  todayDateKey: string;
  lastRunAt: string;
  broadcastSSE: (payload: unknown) => void;
  sendTelegramAlert?: (message: string) => Promise<void>;
  auditLogFilePath?: string;
  stateFilePath?: string;
}): Promise<void> {
  if (
    !shouldSendDailyReminder(
      params.state.tripped,
      params.state.lastReminderSentDate,
      params.todayDateKey,
    )
  ) {
    return;
  }

  try {
    const daysHalted = params.state.trippedAt
      ? Math.max(
          1,
          Math.round(
            (Date.parse(params.lastRunAt) - Date.parse(params.state.trippedAt)) /
              (24 * 60 * 60 * 1000),
          ),
        )
      : null;
    const blockedBuyCountToday = params.decisions.filter(
      (decision) => decision.blockReasonCode === "PORTFOLIO_CIRCUIT_BREAKER",
    ).length;

    const reminderMessage = `Trading still halted by circuit breaker.\nHalted since: ${
      params.state.trippedAt ?? "unknown"
    }\nHalt days: ${daysHalted ?? "unknown"}\nCurrent equity: ${params.portfolioEquity.toFixed(
      2,
    )}\nCurrent drawdown: ${params.drawdownPercent.toFixed(
      1,
    )}%\nBUY blocked today: ${blockedBuyCountToday}\nSELL still allowed.`;

    await appendCircuitBreakerAuditEvent(
      {
        type: "CIRCUIT_BREAKER_REMINDER_SENT",
        timestamp: params.lastRunAt,
        equity: params.portfolioEquity,
        peakEquity: params.state.peakEquity,
        drawdownPercent: params.drawdownPercent,
        thresholdPercent: getMaxDrawdownFromPeakPercent() * 100,
      },
      params.auditLogFilePath,
    );

    await recordReminderSent(params.todayDateKey, params.stateFilePath);

    params.broadcastSSE({
      type: "notification",
      level: "error",
      message: reminderMessage,
    });

    if (params.sendTelegramAlert) {
      await params.sendTelegramAlert(reminderMessage);
    }
  } catch (error) {
    console.warn(
      `[CIRCUIT_BREAKER] Daily reminder check failed: ${getErrorMessage(error)}`,
    );
  }
}
