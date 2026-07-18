import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const LOCK_FILE = path.join(DATA_DIR, "autopilot-worker.lock");

// Honest limitation, not a full distributed lock: this only protects
// against two workers running if they share the same underlying disk. It
// reliably covers the narrow, already-identified risk of an old and new
// process briefly overlapping on the same host during a rolling deploy. It
// provides NO protection against true horizontal scaling (separate hosts
// with separate disks) - that would need a shared coordination service
// (Redis/Postgres), out of proportion for this project's current scale.
//
// A normal graceful shutdown (SIGTERM, e.g. Render killing the old process
// during a redeploy) now releases the lock immediately via
// releaseWorkerLock/autopilotWorker.ts's releaseLockOnShutdown - confirmed
// empirically (2026-07-17) that Render's persistent disk IS shared across
// the old/new process pair during a redeploy on this service, which is
// exactly why an unreleased lock from a routine redeploy was visible to
// (and blocked) the new process for the full staleness window. The
// staleness window below remains the fallback only for a genuine unclean
// crash (OOM, kill -9) where no shutdown code gets a chance to run.
export interface WorkerLockState {
  ownerId: string;
  startedAt: string;
  heartbeatAt: string;
}

export interface LockClaimResult {
  canProceed: boolean;
  reason: string;
}

// Pure, no I/O - kept separate from the read/write orchestration below,
// same pattern as evaluatePortfolioDrawdown in portfolioCircuitBreaker.ts.
export function evaluateLockClaim(
  existing: WorkerLockState | null,
  ownerId: string,
  nowIso: string,
  staleAfterMs: number,
): LockClaimResult {
  if (!existing) {
    return { canProceed: true, reason: "No existing lock." };
  }

  if (existing.ownerId === ownerId) {
    return { canProceed: true, reason: "Renewing this process's own lock." };
  }

  const heartbeatAgeMs =
    new Date(nowIso).getTime() - new Date(existing.heartbeatAt).getTime();

  if (heartbeatAgeMs > staleAfterMs) {
    return {
      canProceed: true,
      reason: `Previous owner's lock is stale (${heartbeatAgeMs}ms since last heartbeat, threshold ${staleAfterMs}ms) - claiming.`,
    };
  }

  return {
    canProceed: false,
    reason: `Lock held by another instance (${existing.ownerId}), last heartbeat ${heartbeatAgeMs}ms ago.`,
  };
}

async function readLock(filePath: string = LOCK_FILE): Promise<WorkerLockState | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as WorkerLockState;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeLock(
  state: WorkerLockState,
  filePath: string = LOCK_FILE,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
}

export async function tryClaimWorkerLock(
  ownerId: string,
  staleAfterMs: number,
  filePath: string = LOCK_FILE,
): Promise<LockClaimResult> {
  const existing = await readLock(filePath);
  const now = new Date().toISOString();
  const evaluation = evaluateLockClaim(existing, ownerId, now, staleAfterMs);

  if (evaluation.canProceed) {
    await writeLock(
      {
        ownerId,
        startedAt: existing?.ownerId === ownerId ? existing.startedAt : now,
        heartbeatAt: now,
      },
      filePath,
    );
  }

  return evaluation;
}

/**
 * Releases this process's own worker lock immediately, for a graceful
 * shutdown (see autopilotWorker.ts's releaseLockOnShutdown) - narrows the
 * exposure window from "every routine redeploy" to "only a genuine unclean
 * crash" (the staleness window above remains that fallback). Never deletes
 * a lock owned by a different process - if `existing.ownerId !== ownerId`,
 * this is a no-op. This does leave one narrow, accepted TOCTOU race: if
 * another process's tryClaimWorkerLock call reads the lock file as already
 * stale (>staleAfterMs, independent of this shutdown) and overwrites it
 * with its own ownerId in the instant between this function's own read and
 * delete, the delete below silently removes that new claim instead of this
 * process's own (now-absent) one. This can only happen if the outgoing
 * lock had already gone stale on its own before this shutdown began - a
 * narrow, compounding edge case, accepted as-is rather than adding real
 * distributed-lock machinery (atomic compare-and-delete, a lock-generation
 * nonce), consistent with this file's existing best-effort, single-host
 * design. Swallows and logs its own errors (e.g. a corrupted lock file)
 * rather than letting them propagate - a shutdown path must never hang on
 * this being anything other than best-effort.
 */
export async function releaseWorkerLock(
  ownerId: string,
  filePath: string = LOCK_FILE,
): Promise<void> {
  try {
    const existing = await readLock(filePath);
    if (!existing) return;
    if (existing.ownerId !== ownerId) return;
    await fs.rm(filePath, { force: true });
  } catch (error) {
    console.warn(
      "[AUTOPILOT LOCK] Failed to release worker lock on shutdown - falling back to the staleness window:",
      error instanceof Error ? error.message : error,
    );
  }
}
