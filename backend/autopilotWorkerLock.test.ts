import { describe, expect, it } from "vitest";

import { evaluateLockClaim } from "./autopilotWorkerLock.js";

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
