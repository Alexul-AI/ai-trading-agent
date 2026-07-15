import { promises as fs } from "fs";
import path from "path";

import type { RebalanceOrder, RotationTarget } from "./etfRotationStrategy.js";

// Same fail-soft, filePath-overridable pattern as portfolioCircuitBreaker.ts/
// orderIdempotency.ts - the override exists solely so tests can point this
// at a real temp file instead of mocking fs or mutating process.cwd().
const DATA_DIR = path.resolve(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "etf-rotation-worker-state.json");

// Per docs/ops/ETF_ROTATION_PAPER_EXECUTION_PLAN.md §4 - a mid-"executing"
// restart lands in "failed_needs_review" rather than being resumed, since
// local state can't safely tell which orders actually reached Alpaca.
export type RebalanceStatus =
  | "planned"
  | "executing"
  | "executed"
  | "partial"
  | "failed"
  | "cancelled"
  | "failed_needs_review";

// Per §4/§11's Stage 2A resolution: only these satisfy the monthly gate's
// "already rebalanced this month" rule - "failed_needs_review" is
// deliberately excluded and must never be treated as a successful rebalance.
export const TERMINAL_SUCCESS_STATUSES: readonly RebalanceStatus[] = [
  "executed",
  "partial",
];

export interface EtfRotationWorkerState {
  /**
   * The date-key ("YYYY-MM-DD") of the last bar the rotation cycle actually
   * rebalanced against - not updated on cycles that skip rebalancing (see
   * isMonthlyRebalanceDate, etfRotationStrategy.ts). Only the year-month
   * portion is ever compared, but the full date is kept for a readable
   * audit trail of exactly when the last rebalance happened.
   */
  lastRebalanceDateKey: string | null;
  /**
   * Calendar year-month ("YYYY-MM") of the most recently attempted rebalance
   * cycle. Added alongside `status` (not yet used by Stage 1's live worker -
   * see recordRebalanceDateKey below) so a future execution-wiring pass can
   * tell "already succeeded this month" apart from "attempted but not yet
   * resolved," which lastRebalanceDateKey alone can't express.
   */
  rebalanceMonthKey?: string;
  status?: RebalanceStatus;
  startedAt?: string;
  completedAt?: string;
  /** The RebalanceOrder[] computed for the in-progress/most recent cycle. */
  plannedOrders?: RebalanceOrder[];
  /** The RotationTarget[] computed for the in-progress/most recent cycle. */
  targets?: RotationTarget[];
}

async function readState(
  filePath: string = STATE_FILE,
): Promise<EtfRotationWorkerState> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    // Backward-compatible with Stage 1's on-disk shape ({ lastRebalanceDateKey
    // } only, no other fields) - every field beyond lastRebalanceDateKey is
    // optional, so an old file still parses cleanly with those fields absent.
    return parsed &&
      typeof parsed === "object" &&
      "lastRebalanceDateKey" in parsed
      ? (parsed as EtfRotationWorkerState)
      : { lastRebalanceDateKey: null };
  } catch {
    return { lastRebalanceDateKey: null };
  }
}

async function writeState(
  state: EtfRotationWorkerState,
  filePath: string = STATE_FILE,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
}

export async function getLastRebalanceDateKey(
  filePath: string = STATE_FILE,
): Promise<string | null> {
  return (await readState(filePath)).lastRebalanceDateKey;
}

// Stage 1's only writer, kept unchanged in behavior for any caller that only
// ever uses this function (still true today - no production code calls the
// richer functions below yet). Now merges onto existing state rather than
// clobbering it, so it can't silently wipe out status/targets/plannedOrders
// if a future caller ever uses both this and the richer functions together;
// with only this function in use, a merge and an overwrite produce identical
// files, so this is not an observable behavior change today.
export async function recordRebalanceDateKey(
  dateKey: string,
  filePath: string = STATE_FILE,
): Promise<void> {
  const current = await readState(filePath);
  await writeState({ ...current, lastRebalanceDateKey: dateKey }, filePath);
}

export async function getRebalanceState(
  filePath: string = STATE_FILE,
): Promise<EtfRotationWorkerState> {
  return readState(filePath);
}

export async function recordRebalancePlanned(
  params: {
    dateKey: string;
    rebalanceMonthKey: string;
    targets: RotationTarget[];
    plannedOrders: RebalanceOrder[];
  },
  filePath: string = STATE_FILE,
): Promise<void> {
  await writeState(
    {
      lastRebalanceDateKey: params.dateKey,
      rebalanceMonthKey: params.rebalanceMonthKey,
      status: "planned",
      startedAt: new Date().toISOString(),
      targets: params.targets,
      plannedOrders: params.plannedOrders,
    },
    filePath,
  );
}

export async function recordRebalanceExecuting(
  filePath: string = STATE_FILE,
): Promise<void> {
  const current = await readState(filePath);
  await writeState({ ...current, status: "executing" }, filePath);
}

export async function recordRebalanceTerminal(
  status: Exclude<RebalanceStatus, "planned" | "executing">,
  filePath: string = STATE_FILE,
): Promise<void> {
  const current = await readState(filePath);
  await writeState(
    { ...current, status, completedAt: new Date().toISOString() },
    filePath,
  );
}

/**
 * Pure gate-check helper (design doc §4): a month only counts as "already
 * rebalanced" when the recorded cycle matches monthKey AND its status is a
 * terminal success. A "failed_needs_review" or "executing" leftover from an
 * interrupted cycle must not satisfy this - see §11's Stage 2A resolution.
 */
export function isRebalanceMonthDone(
  state: EtfRotationWorkerState,
  monthKey: string,
): boolean {
  return (
    state.rebalanceMonthKey === monthKey &&
    state.status !== undefined &&
    TERMINAL_SUCCESS_STATUSES.includes(state.status)
  );
}
