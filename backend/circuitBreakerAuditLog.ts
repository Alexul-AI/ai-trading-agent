import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const AUDIT_LOG_FILE = path.join(DATA_DIR, "circuit-breaker-audit.jsonl");

// Scoped to circuit-breaker lifecycle events only - decisionJournal.ts's
// JournalDecision is per-ticker/per-cycle shaped and a bad fit for these
// (one event per breaker state transition, not one per ticker analyzed).
export type CircuitBreakerAuditEventType =
  | "CIRCUIT_BREAKER_TRIPPED"
  | "CIRCUIT_BREAKER_REMINDER_SENT"
  | "CIRCUIT_BREAKER_RESET";

export interface CircuitBreakerAuditEvent {
  type: CircuitBreakerAuditEventType;
  timestamp: string;
  equity: number;
  peakEquity: number;
  drawdownPercent: number;
  thresholdPercent: number;
  // Only meaningful (and only ever populated) for CIRCUIT_BREAKER_RESET -
  // the whole point of a manual-only reset is that it always has one.
  reason?: string;
}

async function ensureDataDir(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export async function appendCircuitBreakerAuditEvent(
  event: CircuitBreakerAuditEvent,
  filePath: string = AUDIT_LOG_FILE,
): Promise<void> {
  await ensureDataDir(filePath);
  await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf-8");
}

// Same append-only-JSONL, tail-safe-parse pattern as decisionJournal.ts's
// readAutopilotRuns - this log is expected to stay small (one entry per
// trip/reminder/reset, not per cycle), so no tail-byte bound is needed here.
export async function readCircuitBreakerAuditLog(
  limit = 50,
  filePath: string = AUDIT_LOG_FILE,
): Promise<CircuitBreakerAuditEvent[]> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const events = lines
      .map((line) => {
        try {
          return JSON.parse(line) as CircuitBreakerAuditEvent;
        } catch {
          return null;
        }
      })
      .filter((event): event is CircuitBreakerAuditEvent => event !== null);

    return events.slice(-limit).reverse();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}
