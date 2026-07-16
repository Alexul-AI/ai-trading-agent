import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const AUDIT_LOG_FILE = path.join(DATA_DIR, "etf-rotation-order-audit.jsonl");

// Per docs/ops/ETF_ROTATION_PAPER_EXECUTION_PLAN.md §7 - a new schema, not a
// reuse of circuitBreakerAuditLog.ts's event types (which are breaker-
// lifecycle-specific: tripped/reminder/reset). Primarily order-execution-leg
// scoped: one event per BUY/SELL leg submitted for a rebalance, so a case
// like "SELL succeeded, BUY failed" is visible after the fact. The per-ticker
// decisionJournal.ts row stays a decision-level summary, unchanged - this is
// a new, separate, execution-level layer underneath it.
//
// REBALANCE_MANUALLY_CLEARED is the one exception - a rebalance-cycle
// lifecycle event (a human clearing a failed_needs_review cycle, design doc
// §11's Stage 2A resolution), not an order leg. Kept in this same log/reader
// rather than a separate file so a review UI can show one merged timeline
// instead of stitching two JSONL files together by timestamp.
//
// ORDER_ACCEPTED, not ORDER_FILLED (renamed in PR #46 review, before this
// was ever wired to anything real): the broker accepting an order request
// (executeSafeTrade returns right after alpaca.createOrder(...) resolves,
// with no fill-confirmation poll) is not the same claim as the order
// having actually filled. Naming it "filled" would have overclaimed
// certainty this log doesn't have.
export type EtfRotationOrderAuditEventType =
  | "ORDER_SUBMITTED"
  | "ORDER_ACCEPTED"
  | "ORDER_REJECTED"
  | "ORDER_AMBIGUOUS"
  | "REBALANCE_MANUALLY_CLEARED";

// Audit-only classification of why a leg exists - never drives any
// execution decision (design doc §11's Stage 2A resolution). Derived at
// write time from whether the ticker has a paired opposite-action order in
// the same cycle, not from any new decision logic.
export type EtfRotationOrderLegType =
  | "liquidate_existing"
  | "rebuild_target"
  | "open_new"
  | "exit_removed";

export interface EtfRotationOrderAuditEvent {
  type: EtfRotationOrderAuditEventType;
  timestamp: string;
  rebalanceMonthKey: string;
  configVariantKey: string;
  // Order-leg fields - present for ORDER_* events, absent for
  // REBALANCE_MANUALLY_CLEARED (which isn't about one specific ticker/leg).
  ticker?: string;
  side?: "BUY" | "SELL";
  legType?: EtfRotationOrderLegType;
  requestedQty?: number;
  submittedQty?: number;
  clientOrderId?: string;
  brokerOrderId?: string;
  error?: string;
  // Only meaningful (and only ever populated) for REBALANCE_MANUALLY_CLEARED
  // - the whole point of a manual-only clear is that it always has one,
  // mirroring circuitBreakerAuditLog.ts's CIRCUIT_BREAKER_RESET convention.
  reason?: string;
}

/**
 * Pure derivation (design doc §11's Stage 2A resolution): audit-log
 * readability only, never a behavioral input. A BUY paired with a SELL for
 * the same ticker this cycle is "rebuild_target" (continuing pick, full
 * liquidate-then-rebuy); unpaired it's "open_new". A SELL paired with a BUY
 * is "liquidate_existing"; unpaired it's "exit_removed" (dropped pick).
 */
export function deriveLegType(
  side: "BUY" | "SELL",
  hasPairedOppositeOrder: boolean,
): EtfRotationOrderLegType {
  if (side === "BUY") {
    return hasPairedOppositeOrder ? "rebuild_target" : "open_new";
  }

  return hasPairedOppositeOrder ? "liquidate_existing" : "exit_removed";
}

async function ensureDataDir(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export async function appendEtfRotationOrderAuditEvent(
  event: EtfRotationOrderAuditEvent,
  filePath: string = AUDIT_LOG_FILE,
): Promise<void> {
  await ensureDataDir(filePath);
  await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf-8");
}

// Same append-only-JSONL, tail-safe-parse pattern as circuitBreakerAuditLog.ts
// - a corrupt/partial trailing line is skipped rather than failing the whole
// read, since this log is only ever appended to, never rewritten in place.
export async function readEtfRotationOrderAuditLog(
  limit = 100,
  filePath: string = AUDIT_LOG_FILE,
): Promise<EtfRotationOrderAuditEvent[]> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const events = lines
      .map((line) => {
        try {
          return JSON.parse(line) as EtfRotationOrderAuditEvent;
        } catch {
          return null;
        }
      })
      .filter((event): event is EtfRotationOrderAuditEvent => event !== null);

    return events.slice(-limit).reverse();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}
