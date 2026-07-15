import { promises as fs } from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendEtfRotationOrderAuditEvent,
  deriveLegType,
  readEtfRotationOrderAuditLog,
  type EtfRotationOrderAuditEvent,
} from "./etfRotationOrderAuditLog.js";

function makeEvent(
  overrides: Partial<EtfRotationOrderAuditEvent> = {},
): EtfRotationOrderAuditEvent {
  return {
    type: "ORDER_SUBMITTED",
    timestamp: new Date(2026, 0, 1).toISOString(),
    rebalanceMonthKey: "2026-01",
    configVariantKey: "baseline-2",
    ticker: "SPY",
    side: "BUY",
    legType: "open_new",
    requestedQty: 58,
    ...overrides,
  };
}

describe("etfRotationOrderAuditLog", () => {
  let tmpFile: string;

  beforeEach(async () => {
    tmpFile = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "etf-rotation-order-audit-test-")),
      "etf-rotation-order-audit.jsonl",
    );
  });

  afterEach(async () => {
    await fs.rm(path.dirname(tmpFile), { recursive: true, force: true });
  });

  it("returns an empty array when the file doesn't exist yet", async () => {
    const events = await readEtfRotationOrderAuditLog(100, tmpFile);

    expect(events).toEqual([]);
  });

  it("round-trips appended events, most-recent-first", async () => {
    const sell = makeEvent({
      type: "ORDER_SUBMITTED",
      ticker: "GLD",
      side: "SELL",
      legType: "exit_removed",
      requestedQty: 12,
    });
    const buyFilled = makeEvent({
      type: "ORDER_FILLED",
      timestamp: new Date(2026, 0, 1, 0, 0, 1).toISOString(),
      ticker: "SPY",
      side: "BUY",
      legType: "open_new",
      requestedQty: 58,
      submittedQty: 58,
      clientOrderId: "autopilot-spy-buy-abc",
      brokerOrderId: "broker-123",
    });
    const rejected = makeEvent({
      type: "ORDER_REJECTED",
      timestamp: new Date(2026, 0, 1, 0, 0, 2).toISOString(),
      ticker: "QQQ",
      side: "BUY",
      legType: "open_new",
      error: "insufficient buying power",
    });

    await appendEtfRotationOrderAuditEvent(sell, tmpFile);
    await appendEtfRotationOrderAuditEvent(buyFilled, tmpFile);
    await appendEtfRotationOrderAuditEvent(rejected, tmpFile);

    const events = await readEtfRotationOrderAuditLog(100, tmpFile);

    expect(events.map((event) => event.type)).toEqual([
      "ORDER_REJECTED",
      "ORDER_FILLED",
      "ORDER_SUBMITTED",
    ]);
    expect(events[1]).toEqual(buyFilled);
  });

  it("respects the limit, keeping the most recent entries", async () => {
    for (let i = 0; i < 5; i += 1) {
      await appendEtfRotationOrderAuditEvent(
        makeEvent({ timestamp: new Date(2026, 0, i + 1).toISOString() }),
        tmpFile,
      );
    }

    const events = await readEtfRotationOrderAuditLog(2, tmpFile);

    expect(events).toHaveLength(2);
    expect(events[0]!.timestamp).toBe(new Date(2026, 0, 5).toISOString());
    expect(events[1]!.timestamp).toBe(new Date(2026, 0, 4).toISOString());
  });

  it("skips a corrupt trailing line rather than failing the whole read", async () => {
    await appendEtfRotationOrderAuditEvent(makeEvent(), tmpFile);
    await fs.appendFile(tmpFile, "{not valid json\n", "utf-8");

    const events = await readEtfRotationOrderAuditLog(100, tmpFile);

    expect(events).toHaveLength(1);
  });

  it("round-trips a REBALANCE_MANUALLY_CLEARED lifecycle event alongside order-leg events", async () => {
    const orderEvent = makeEvent({ ticker: "SPY", side: "BUY" });
    const clearEvent: EtfRotationOrderAuditEvent = {
      type: "REBALANCE_MANUALLY_CLEARED",
      timestamp: new Date(2026, 0, 2).toISOString(),
      rebalanceMonthKey: "2026-01",
      configVariantKey: "baseline-2",
      reason: "Confirmed via Alpaca dashboard that the SELL filled and the BUY never submitted - safe to clear.",
    };

    await appendEtfRotationOrderAuditEvent(orderEvent, tmpFile);
    await appendEtfRotationOrderAuditEvent(clearEvent, tmpFile);

    const events = await readEtfRotationOrderAuditLog(100, tmpFile);

    expect(events[0]).toEqual(clearEvent);
    expect(events[0]!.ticker).toBeUndefined();
    expect(events[0]!.reason).toContain("safe to clear");
  });
});

describe("deriveLegType", () => {
  it("labels a paired BUY as rebuild_target (continuing pick)", () => {
    expect(deriveLegType("BUY", true)).toBe("rebuild_target");
  });

  it("labels an unpaired BUY as open_new (fresh pick)", () => {
    expect(deriveLegType("BUY", false)).toBe("open_new");
  });

  it("labels a paired SELL as liquidate_existing (being rebuilt)", () => {
    expect(deriveLegType("SELL", true)).toBe("liquidate_existing");
  });

  it("labels an unpaired SELL as exit_removed (dropped pick)", () => {
    expect(deriveLegType("SELL", false)).toBe("exit_removed");
  });
});
