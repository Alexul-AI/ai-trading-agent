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

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readLock(): Promise<WorkerLockState | null> {
  try {
    const raw = await fs.readFile(LOCK_FILE, "utf-8");
    return JSON.parse(raw) as WorkerLockState;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeLock(state: WorkerLockState): Promise<void> {
  await ensureDataDir();
  await fs.writeFile(LOCK_FILE, JSON.stringify(state, null, 2), "utf-8");
}

export async function tryClaimWorkerLock(
  ownerId: string,
  staleAfterMs: number,
): Promise<LockClaimResult> {
  const existing = await readLock();
  const now = new Date().toISOString();
  const evaluation = evaluateLockClaim(existing, ownerId, now, staleAfterMs);

  if (evaluation.canProceed) {
    await writeLock({
      ownerId,
      startedAt: existing?.ownerId === ownerId ? existing.startedAt : now,
      heartbeatAt: now,
    });
  }

  return evaluation;
}
