import { promises as fs } from "fs";
import path from "path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  assertRealDataFilesUnchanged,
  currentMonthKey,
  makeDailyBarsSeries,
  makePortfolioSnapshot,
  makeTempDataDir,
  makeThrowingExecuteSafeTrade,
  makeThrowingGetOrderStatus,
  snapshotRealDataFiles,
  stubFetchForBarsByTicker,
  todayDateKey,
  type RealDataFileSnapshot,
} from "./autopilotWorker.characterization.helpers.js";

// Reminder idempotency (2026-08-07), circuit breaker half - direct follow-up
// to PR #64's off-target reminder review. Before this change, the daily
// circuit-breaker reminder block lived inside runOnce()'s single big outer
// try/catch (unlike the ETF off-target block, which already had its own
// isolation since PR #64) - a sendTelegramAlert failure here would have
// propagated to the outer catch, aborting the rest of the cycle (journal
// write, autopilot_worker_finished broadcast, other end-of-cycle Telegram
// sends) entirely. This test proves both halves of the fix: the reminder is
// now isolated in its own try/catch, and the audit event + state date are
// written BEFORE the send attempt, so they're durable even when the send
// itself fails.
vi.stubEnv("AUTOPILOT_STRATEGY", "etf_rotation");
vi.stubEnv("AUTOPILOT_EXECUTE_TRADES", "false");
vi.stubEnv("APCA_API_KEY_ID", "test-key-id");
vi.stubEnv("APCA_API_SECRET_KEY", "test-secret-key");
// Pinned to UTC (2026-08-07) - this file tests reminder isolation/ordering,
// not the Jerusalem-local day-boundary itself (see
// autopilotWorker.characterization.reminderLocalDayCadence.test.ts for
// that), and every `today`/`month` value below is computed via the
// UTC-based todayDateKey()/currentMonthKey() helpers.
vi.stubEnv("AUTOPILOT_REMINDER_TIMEZONE", "UTC");

const { createAutopilotWorker } = await import("./autopilotWorker.js");

describe("autopilotWorker characterization: circuit breaker daily reminder isolation", () => {
  let dataFilesBefore: RealDataFileSnapshot[];

  beforeAll(async () => {
    dataFilesBefore = await snapshotRealDataFiles();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await assertRealDataFilesUnchanged(dataFilesBefore);
  });

  it("records the reminder audit event + lastReminderSentDate, and still completes the journal write, even when sendTelegramAlert throws", async () => {
    const tempDir = await makeTempDataDir("autopilot-cb-reminder-isolation-");
    const today = todayDateKey();
    const month = currentMonthKey();

    const circuitBreakerStateFilePath = path.join(tempDir, "circuit-breaker-state.json");
    const circuitBreakerAuditLogFilePath = path.join(tempDir, "circuit-breaker-audit.jsonl");
    const journalFilePath = path.join(tempDir, "autopilot-decisions.jsonl");

    // Already tripped, from before today - shouldSendDailyReminder should
    // fire this cycle. Sticky (applyStickyTrip), so the exact drawdown
    // evaluated fresh this cycle doesn't matter for whether it stays tripped.
    await fs.writeFile(
      circuitBreakerStateFilePath,
      JSON.stringify({
        trackingStartDate: "2026-08-01T00:00:00.000Z",
        peakEquity: 100_000,
        peakEquityAt: "2026-08-01T00:00:00.000Z",
        tripped: true,
        trippedAt: "2026-08-01T12:00:00.000Z",
        dataStale: false,
        lastReminderSentDate: null,
      }),
      "utf-8",
    );

    // ETF rotation side: already-done-this-month, no targets/plannedOrders
    // seeded, so deriveEtfRotationOffTargetState short-circuits to
    // offTarget: false - keeps this test focused on the circuit breaker
    // path alone.
    await fs.writeFile(
      path.join(tempDir, "etf-rotation-worker-state.json"),
      JSON.stringify({
        lastRebalanceDateKey: today,
        rebalanceMonthKey: month,
        status: "executed",
      }),
      "utf-8",
    );

    const bars = makeDailyBarsSeries(5, today);
    stubFetchForBarsByTicker({ SPY: bars, QQQ: bars, EFA: bars, TLT: bars, GLD: bars });

    const portfolio = makePortfolioSnapshot({ equity: 80_000, balance: 80_000 });

    const sendTelegramAlert = vi.fn(async () => {
      throw new Error("simulated Telegram network failure");
    });

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
        journalFilePath,
      },
    });

    const result = await worker.runOnce("manual");

    // The whole point of the fix: previously this throw would have
    // propagated to runOnce()'s outer catch and set result.error.
    expect(result.error).toBeUndefined();
    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);

    const stateAfterRun = JSON.parse(
      await fs.readFile(circuitBreakerStateFilePath, "utf-8"),
    );
    expect(stateAfterRun.lastReminderSentDate).toBe(today);

    const auditLines = (await fs.readFile(circuitBreakerAuditLogFilePath, "utf-8"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(auditLines.some((event) => event.type === "CIRCUIT_BREAKER_REMINDER_SENT")).toBe(true);

    // The journal write happens after the reminder block - proves the
    // Telegram failure didn't cascade into skipping the rest of the cycle.
    const journalExists = await fs
      .access(journalFilePath)
      .then(() => true)
      .catch(() => false);
    expect(journalExists).toBe(true);
  });

  it("does not re-send the same day even across two cycles, once the audit/state write has succeeded", async () => {
    const tempDir = await makeTempDataDir("autopilot-cb-reminder-cadence-");
    const today = todayDateKey();
    const month = currentMonthKey();

    const circuitBreakerStateFilePath = path.join(tempDir, "circuit-breaker-state.json");
    const circuitBreakerAuditLogFilePath = path.join(tempDir, "circuit-breaker-audit.jsonl");

    await fs.writeFile(
      circuitBreakerStateFilePath,
      JSON.stringify({
        trackingStartDate: "2026-08-01T00:00:00.000Z",
        peakEquity: 100_000,
        peakEquityAt: "2026-08-01T00:00:00.000Z",
        tripped: true,
        trippedAt: "2026-08-01T12:00:00.000Z",
        dataStale: false,
        lastReminderSentDate: null,
      }),
      "utf-8",
    );

    await fs.writeFile(
      path.join(tempDir, "etf-rotation-worker-state.json"),
      JSON.stringify({
        lastRebalanceDateKey: today,
        rebalanceMonthKey: month,
        status: "executed",
      }),
      "utf-8",
    );

    const bars = makeDailyBarsSeries(5, today);
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

    await worker.runOnce("manual");
    await worker.runOnce("manual");

    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);

    const auditLines = (await fs.readFile(circuitBreakerAuditLogFilePath, "utf-8"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(auditLines.filter((event) => event.type === "CIRCUIT_BREAKER_REMINDER_SENT").length).toBe(
      1,
    );
  });
});
