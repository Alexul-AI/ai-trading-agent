import { promises as fs } from "fs";
import os from "os";
import path from "path";

import { describe, expect, it } from "vitest";

import {
  evaluateLockClaim,
  releaseWorkerLock,
  tryClaimWorkerLock,
  type WorkerLockState,
} from "./autopilotWorkerLock.js";

async function withTempLockFile(
  run: (filePath: string) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autopilot-lock-test-"));
  const filePath = path.join(dir, "autopilot-worker.lock");
  try {
    await run(filePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function readLockFixture(filePath: string): Promise<WorkerLockState> {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw) as WorkerLockState;
}

const now = "2026-07-11T12:00:00.000Z";
const staleAfterMs = 180_000; // 3 minutes

describe("evaluateLockClaim", () => {
  it("claims when there is no existing lock", () => {
    const result = evaluateLockClaim(null, "owner-a", now, staleAfterMs);

    expect(result.canProceed).toBe(true);
    expect(result.reason).toContain("No existing lock");
  });

  it("renews when the existing lock is already owned by this process", () => {
    const existing = {
      ownerId: "owner-a",
      startedAt: "2026-07-11T11:00:00.000Z",
      heartbeatAt: "2026-07-11T11:59:30.000Z",
    };

    const result = evaluateLockClaim(existing, "owner-a", now, staleAfterMs);

    expect(result.canProceed).toBe(true);
    expect(result.reason).toContain("Renewing");
  });

  it("refuses when a foreign lock's heartbeat is still fresh", () => {
    const existing = {
      ownerId: "owner-b",
      startedAt: "2026-07-11T11:59:00.000Z",
      heartbeatAt: "2026-07-11T11:59:30.000Z", // 30s ago, well under staleAfterMs
    };

    const result = evaluateLockClaim(existing, "owner-a", now, staleAfterMs);

    expect(result.canProceed).toBe(false);
    expect(result.reason).toContain("owner-b");
  });

  it("claims when a foreign lock's heartbeat is stale (previous owner likely crashed)", () => {
    const existing = {
      ownerId: "owner-b",
      startedAt: "2026-07-11T11:00:00.000Z",
      heartbeatAt: "2026-07-11T11:55:00.000Z", // 5 minutes ago, past the 3-minute threshold
    };

    const result = evaluateLockClaim(existing, "owner-a", now, staleAfterMs);

    expect(result.canProceed).toBe(true);
    expect(result.reason).toContain("stale");
  });

  it("refuses exactly at the staleness boundary (not yet stale)", () => {
    const heartbeatAt = new Date(
      new Date(now).getTime() - staleAfterMs,
    ).toISOString();
    const existing = {
      ownerId: "owner-b",
      startedAt: "2026-07-11T11:00:00.000Z",
      heartbeatAt,
    };

    const result = evaluateLockClaim(existing, "owner-a", now, staleAfterMs);

    expect(result.canProceed).toBe(false);
  });
});

describe("tryClaimWorkerLock (I/O)", () => {
  it("claims and persists a lock file when none exists", async () => {
    await withTempLockFile(async (filePath) => {
      const result = await tryClaimWorkerLock("owner-a", staleAfterMs, filePath);

      expect(result.canProceed).toBe(true);
      const written = await readLockFixture(filePath);
      expect(written.ownerId).toBe("owner-a");
    });
  });

  it("renews its own lock, preserving startedAt and refreshing heartbeatAt", async () => {
    await withTempLockFile(async (filePath) => {
      const first = await tryClaimWorkerLock("owner-a", staleAfterMs, filePath);
      expect(first.canProceed).toBe(true);
      const firstState = await readLockFixture(filePath);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const second = await tryClaimWorkerLock("owner-a", staleAfterMs, filePath);
      expect(second.canProceed).toBe(true);
      const secondState = await readLockFixture(filePath);

      expect(secondState.startedAt).toBe(firstState.startedAt);
      expect(secondState.heartbeatAt).not.toBe(firstState.heartbeatAt);
    });
  });

  it("refuses a fresh foreign lock and leaves the file untouched", async () => {
    await withTempLockFile(async (filePath) => {
      await tryClaimWorkerLock("owner-b", staleAfterMs, filePath);
      const before = await readLockFixture(filePath);

      const result = await tryClaimWorkerLock("owner-a", staleAfterMs, filePath);

      expect(result.canProceed).toBe(false);
      const after = await readLockFixture(filePath);
      expect(after).toEqual(before);
    });
  });

  it("claims and overwrites a stale foreign lock", async () => {
    await withTempLockFile(async (filePath) => {
      // A very short staleness window so the foreign lock is already stale
      // by the time the second call happens.
      const shortStaleAfterMs = 1;
      await tryClaimWorkerLock("owner-b", shortStaleAfterMs, filePath);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const result = await tryClaimWorkerLock("owner-a", shortStaleAfterMs, filePath);

      expect(result.canProceed).toBe(true);
      const after = await readLockFixture(filePath);
      expect(after.ownerId).toBe("owner-a");
    });
  });
});

describe("releaseWorkerLock", () => {
  it("deletes the file when it exists and is owned by this process", async () => {
    await withTempLockFile(async (filePath) => {
      await tryClaimWorkerLock("owner-a", staleAfterMs, filePath);

      await releaseWorkerLock("owner-a", filePath);

      await expect(fs.readFile(filePath, "utf-8")).rejects.toThrow();
    });
  });

  it("does not throw when no lock file exists", async () => {
    await withTempLockFile(async (filePath) => {
      await expect(releaseWorkerLock("owner-a", filePath)).resolves.toBeUndefined();
    });
  });

  it("no-ops and leaves the file untouched when the lock belongs to a different owner", async () => {
    await withTempLockFile(async (filePath) => {
      await tryClaimWorkerLock("owner-b", staleAfterMs, filePath);
      const before = await readLockFixture(filePath);

      await releaseWorkerLock("owner-a", filePath);

      const after = await readLockFixture(filePath);
      expect(after).toEqual(before);
    });
  });

  it("does not throw when the lock file contains unparseable JSON", async () => {
    await withTempLockFile(async (filePath) => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "{ not valid json", "utf-8");

      await expect(releaseWorkerLock("owner-a", filePath)).resolves.toBeUndefined();
      // Corrupted file is left in place, not silently "fixed" by deletion -
      // matches this file's existing fail-closed convention elsewhere.
      const raw = await fs.readFile(filePath, "utf-8");
      expect(raw).toBe("{ not valid json");
    });
  });
});
