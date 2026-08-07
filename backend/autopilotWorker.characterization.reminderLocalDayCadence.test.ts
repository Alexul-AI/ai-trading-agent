import { promises as fs } from "fs";
import path from "path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  assertRealDataFilesUnchanged,
  makeDailyBarsSeries,
  makePortfolioSnapshot,
  makeTempDataDir,
  makeThrowingExecuteSafeTrade,
  makeThrowingGetOrderStatus,
  snapshotRealDataFiles,
  stubFetchForBarsByTicker,
  type RealDataFileSnapshot,
} from "./autopilotWorker.characterization.helpers.js";

// PR (2026-08-07) - direct follow-up to the reminder idempotency PR (#65):
// proves the real runOnce() call site's "once per calendar day" cadence
// uses AUTOPILOT_REMINDER_TIMEZONE (Asia/Jerusalem here), not a naive UTC
// date slice, via vi.setSystemTime rather than by calling
// toLocalDateKey/shouldSendDailyReminder directly (those are already
// covered in isolation in time.test.ts/portfolioCircuitBreaker.test.ts).
// Uses the circuit-breaker reminder path since it needs no ETF-specific
// incident fixture - the day-boundary behavior under test is identical for
// both reminder paths, since both read the same worker-level todayDateKey.
vi.stubEnv("AUTOPILOT_STRATEGY", "etf_rotation");
vi.stubEnv("AUTOPILOT_EXECUTE_TRADES", "false");
vi.stubEnv("AUTOPILOT_REMINDER_TIMEZONE", "Asia/Jerusalem");
vi.stubEnv("APCA_API_KEY_ID", "test-key-id");
vi.stubEnv("APCA_API_SECRET_KEY", "test-secret-key");

const { createAutopilotWorker } = await import("./autopilotWorker.js");

describe("autopilotWorker characterization: reminder cadence uses Asia/Jerusalem local day, not UTC", () => {
  let dataFilesBefore: RealDataFileSnapshot[];

  beforeAll(async () => {
    dataFilesBefore = await snapshotRealDataFiles();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await assertRealDataFilesUnchanged(dataFilesBefore);
  });

  it("records the reminder under the Jerusalem-local date, and only re-sends once the Jerusalem day genuinely changes", async () => {
    const tempDir = await makeTempDataDir("autopilot-reminder-local-day-");

    const circuitBreakerStateFilePath = path.join(tempDir, "circuit-breaker-state.json");
    const circuitBreakerAuditLogFilePath = path.join(tempDir, "circuit-breaker-audit.jsonl");

    await fs.writeFile(
      circuitBreakerStateFilePath,
      JSON.stringify({
        trackingStartDate: "2025-12-01T00:00:00.000Z",
        peakEquity: 100_000,
        peakEquityAt: "2025-12-01T00:00:00.000Z",
        tripped: true,
        trippedAt: "2025-12-15T12:00:00.000Z",
        dataStale: false,
        lastReminderSentDate: null,
      }),
      "utf-8",
    );

    // "Already done this month" for the whole test - every fake "now" below
    // stays within January 2026, and the static bars' own last-bar date
    // (also January 2026) is what actually derives the gate's monthKey, so
    // this stays a trivial HOLD-only ETF cycle throughout, keeping the test
    // focused on the circuit-breaker reminder path alone.
    await fs.writeFile(
      path.join(tempDir, "etf-rotation-worker-state.json"),
      JSON.stringify({
        lastRebalanceDateKey: "2026-01-01",
        rebalanceMonthKey: "2026-01",
        status: "executed",
      }),
      "utf-8",
    );

    const bars = makeDailyBarsSeries(5, "2026-01-01");
    stubFetchForBarsByTicker({ SPY: bars, QQQ: bars, EFA: bars, TLT: bars, GLD: bars });

    const portfolio = makePortfolioSnapshot({ equity: 80_000, balance: 80_000 });
    const sendTelegramAlert = vi.fn(async () => {});

    const worker = createAutopilotWorker({
      tradeMode: "paper",
      getPortfolioSnapshot: async () => portfolio,
      getEquityHistorySince: async () => [],
      executeSafeTrade: makeThrowingExecuteSafeTrade(),
      getOrderStatus: makeThrowingGetOrderStatus(),
      broadcastSSE: () => {},
      sendTelegramAlert,
      testDataFilePaths: {
        lockFilePath: path.join(tempDir, "autopilot-worker.lock"),
        etfRotationStateFilePath: path.join(tempDir, "etf-rotation-worker-state.json"),
        etfRotationOrderAuditLogFilePath: path.join(tempDir, "etf-rotation-order-audit.jsonl"),
        circuitBreakerStateFilePath,
        circuitBreakerAuditLogFilePath,
        journalFilePath: path.join(tempDir, "autopilot-decisions.jsonl"),
      },
    });

    vi.useFakeTimers({ toFake: ["Date"] });

    // Israel Standard Time (IST, UTC+2) in January - 22:30 UTC on Jan 1 is
    // already 00:30 Jan 2 in Jerusalem. A naive UTC slice would record
    // "2026-01-01"; the fix must record "2026-01-02".
    vi.setSystemTime(new Date("2026-01-01T22:30:00.000Z"));
    await worker.runOnce("manual");

    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
    const stateAfterCycle1 = JSON.parse(await fs.readFile(circuitBreakerStateFilePath, "utf-8"));
    expect(stateAfterCycle1.lastReminderSentDate).toBe("2026-01-02");

    // Still Jan 1 in UTC, still Jan 2 in Jerusalem - must not re-send.
    vi.setSystemTime(new Date("2026-01-01T23:30:00.000Z"));
    await worker.runOnce("manual");
    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);

    // Now Jan 2 in UTC too, but still the same Jerusalem calendar day
    // ("2026-01-02" started at UTC 2026-01-01T22:00:00Z) - still no re-send.
    vi.setSystemTime(new Date("2026-01-02T20:00:00.000Z"));
    await worker.runOnce("manual");
    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);

    // A genuinely new Jerusalem day (00:30 Jan 3 local) - must re-send.
    vi.setSystemTime(new Date("2026-01-02T22:30:00.000Z"));
    await worker.runOnce("manual");
    expect(sendTelegramAlert).toHaveBeenCalledTimes(2);

    const stateAfterCycle4 = JSON.parse(await fs.readFile(circuitBreakerStateFilePath, "utf-8"));
    expect(stateAfterCycle4.lastReminderSentDate).toBe("2026-01-03");

    const auditLines = (await fs.readFile(circuitBreakerAuditLogFilePath, "utf-8"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(auditLines.filter((event) => event.type === "CIRCUIT_BREAKER_REMINDER_SENT").length).toBe(
      2,
    );
  });
});
