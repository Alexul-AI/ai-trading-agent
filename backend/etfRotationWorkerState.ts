import { promises as fs } from "fs";
import path from "path";

// Same fail-soft, filePath-overridable pattern as portfolioCircuitBreaker.ts/
// orderIdempotency.ts - the override exists solely so tests can point this
// at a real temp file instead of mocking fs or mutating process.cwd().
const DATA_DIR = path.resolve(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "etf-rotation-worker-state.json");

export interface EtfRotationWorkerState {
  /**
   * The date-key ("YYYY-MM-DD") of the last bar the rotation cycle actually
   * rebalanced against - not updated on cycles that skip rebalancing (see
   * isMonthlyRebalanceDate, etfRotationStrategy.ts). Only the year-month
   * portion is ever compared, but the full date is kept for a readable
   * audit trail of exactly when the last rebalance happened.
   */
  lastRebalanceDateKey: string | null;
}

async function readState(
  filePath: string = STATE_FILE,
): Promise<EtfRotationWorkerState> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
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

export async function recordRebalanceDateKey(
  dateKey: string,
  filePath: string = STATE_FILE,
): Promise<void> {
  await writeState({ lastRebalanceDateKey: dateKey }, filePath);
}
