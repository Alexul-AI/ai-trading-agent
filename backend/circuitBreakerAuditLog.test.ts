import { promises as fs } from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendCircuitBreakerAuditEvent,
  readCircuitBreakerAuditLog,
  type CircuitBreakerAuditEvent,
} from "./circuitBreakerAuditLog.js";

function makeEvent(
  overrides: Partial<CircuitBreakerAuditEvent> = {},
): CircuitBreakerAuditEvent {
  return {
    type: "CIRCUIT_BREAKER_TRIPPED",
    timestamp: new Date(2026, 0, 1).toISOString(),
    equity: 9000,
    peakEquity: 10600,
    drawdownPercent: -15.1,
    thresholdPercent: -15,
    ...overrides,
  };
}

describe("circuitBreakerAuditLog", () => {
  let tmpFile: string;

  beforeEach(async () => {
    tmpFile = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "cb-audit-test-")),
      "circuit-breaker-audit.jsonl",
    );
  });

  afterEach(async () => {
    await fs.rm(path.dirname(tmpFile), { recursive: true, force: true });
  });

  it("returns an empty array when the file doesn't exist yet", async () => {
    const events = await readCircuitBreakerAuditLog(50, tmpFile);

    expect(events).toEqual([]);
  });

  it("round-trips appended events, most-recent-first", async () => {
    const tripped = makeEvent({ type: "CIRCUIT_BREAKER_TRIPPED" });
    const reminder = makeEvent({
      type: "CIRCUIT_BREAKER_REMINDER_SENT",
      timestamp: new Date(2026, 0, 2).toISOString(),
    });
    const reset = makeEvent({
      type: "CIRCUIT_BREAKER_RESET",
      timestamp: new Date(2026, 0, 3).toISOString(),
      reason: "Manual review completed",
    });

    await appendCircuitBreakerAuditEvent(tripped, tmpFile);
    await appendCircuitBreakerAuditEvent(reminder, tmpFile);
    await appendCircuitBreakerAuditEvent(reset, tmpFile);

    const events = await readCircuitBreakerAuditLog(50, tmpFile);

    expect(events.map((event) => event.type)).toEqual([
      "CIRCUIT_BREAKER_RESET",
      "CIRCUIT_BREAKER_REMINDER_SENT",
      "CIRCUIT_BREAKER_TRIPPED",
    ]);
    expect(events[0]).toEqual(reset);
  });

  it("respects the limit, keeping the most recent entries", async () => {
    for (let i = 0; i < 5; i += 1) {
      await appendCircuitBreakerAuditEvent(
        makeEvent({ timestamp: new Date(2026, 0, i + 1).toISOString() }),
        tmpFile,
      );
    }

    const events = await readCircuitBreakerAuditLog(2, tmpFile);

    expect(events).toHaveLength(2);
    expect(events[0]!.timestamp).toBe(new Date(2026, 0, 5).toISOString());
    expect(events[1]!.timestamp).toBe(new Date(2026, 0, 4).toISOString());
  });
});
