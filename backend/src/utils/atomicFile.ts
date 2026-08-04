import { promises as fs } from "fs";
import path from "path";

/**
 * Writes JSON to disk atomically: write to a temp file, then rename over
 * the real path. fs.rename is atomic at the OS level, so a process killed
 * mid-write (e.g. SIGTERM during a Render redeploy - confirmed to actually
 * happen, see CLAUDE.md) can never leave a half-written/corrupted file at
 * the real path - the old file (if any) stays intact until the new one is
 * fully written. Established in portfolioCircuitBreaker.ts (2026-07-19)
 * and extracted here for reuse across every other on-disk state file with
 * the same exposure (orderIdempotency.ts, etfRotationWorkerState.ts,
 * autopilotWorkerLock.ts) - portfolioCircuitBreaker.ts itself keeps its
 * own already-shipped inline copy rather than being retrofitted, to keep
 * this change scoped to the files that still needed the fix.
 */
export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(value, null, 2), "utf-8");
  await fs.rename(tmpPath, filePath);
}
