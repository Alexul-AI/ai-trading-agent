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

// PR #64 - direct response to the 2026-08-03 QQQ incident (see PR #63):
// exercises the real runOnce() call site's off-target reminder wiring, not
// just deriveEtfRotationOffTargetState/shouldSendEtfRotationOffTargetReminder
// in isolation (those are covered directly in etfRotationReview.test.ts).
// Seeds the state/audit-log files to reproduce the real incident shape
// (QQQ's rebuild BUY rejected, SPY's succeeded) rather than driving a live
// rebalance through the strategy, since the reminder check re-reads
// persisted state independently of what (if anything) happens this cycle.
vi.stubEnv("AUTOPILOT_STRATEGY", "etf_rotation");
vi.stubEnv("AUTOPILOT_EXECUTE_TRADES", "false");
vi.stubEnv("APCA_API_KEY_ID", "test-key-id");
vi.stubEnv("APCA_API_SECRET_KEY", "test-secret-key");
// Pinned to UTC (2026-08-07) - this file tests reminder mechanics, not the
// Jerusalem-local day-boundary itself (see
// autopilotWorker.characterization.reminderLocalDayCadence.test.ts for
// that), and every `today`/`month` value below is computed via the
// UTC-based todayDateKey()/currentMonthKey() helpers.
vi.stubEnv("AUTOPILOT_REMINDER_TIMEZONE", "UTC");

const { createAutopilotWorker } = await import("./autopilotWorker.js");

describe("autopilotWorker characterization: ETF Rotation off-target reminder", () => {
  let dataFilesBefore: RealDataFileSnapshot[];

  beforeAll(async () => {
    dataFilesBefore = await snapshotRealDataFiles();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await assertRealDataFilesUnchanged(dataFilesBefore);
  });

  it("sends exactly one Telegram/SSE reminder per calendar day while off-target, and records it in state + the audit log", async () => {
    const tempDir = await makeTempDataDir("autopilot-etf-off-target-reminder-");
    const today = todayDateKey();
    const month = currentMonthKey();

    const stateFilePath = path.join(tempDir, "etf-rotation-worker-state.json");
    const auditLogFilePath = path.join(tempDir, "etf-rotation-order-audit.jsonl");

    await fs.writeFile(
      stateFilePath,
      JSON.stringify({
        lastRebalanceDateKey: today,
        rebalanceMonthKey: month,
        configVariantKey: "baseline-2",
        status: "partial",
        completedAt: `${today}T13:52:26.897Z`,
        targets: [
          { ticker: "QQQ", weightPercent: 50 },
          { ticker: "SPY", weightPercent: 50 },
        ],
        plannedOrders: [
          { ticker: "SPY", action: "SELL", shares: 2 },
          { ticker: "QQQ", action: "SELL", shares: 2 },
          { ticker: "QQQ", action: "BUY", shares: 63, targetWeightPercent: 50 },
          { ticker: "SPY", action: "BUY", shares: 58, targetWeightPercent: 50 },
        ],
      }),
      "utf-8",
    );

    await fs.writeFile(
      auditLogFilePath,
      `${JSON.stringify({
        type: "ORDER_REJECTED",
        timestamp: `${today}T13:52:26.373Z`,
        rebalanceMonthKey: month,
        configVariantKey: "baseline-2",
        ticker: "QQQ",
        side: "BUY",
        legType: "rebuild_target",
        requestedQty: 63,
        submittedQty: 2,
        error: "Request failed with status code 403",
      })}\n`,
      "utf-8",
    );

    // Already-done-this-month (status: "partial" is a terminal success) -
    // the gate short-circuits before the warmup check, so 5 bars is enough,
    // same as the etfRotationAlreadyDone characterization test.
    const bars = makeDailyBarsSeries(5, today);
    stubFetchForBarsByTicker({ SPY: bars, QQQ: bars, EFA: bars, TLT: bars, GLD: bars });

    // Matches the real incident: SPY's rebuild succeeded (2 shares held),
    // QQQ's did not (absent from positions entirely).
    const portfolio = makePortfolioSnapshot({
      positions: {
        SPY: { shares: 2, avgPrice: 752.53, currentPrice: 769.8, pnl: 34.54, pnlPercent: 2.3 },
      },
    });

    const executeSafeTrade = makeThrowingExecuteSafeTrade();
    const sendTelegramAlert = vi.fn(async () => {});
    const broadcastSSE = vi.fn();

    const worker = createAutopilotWorker({
      tradeMode: "paper",
      getPortfolioSnapshot: async () => portfolio,
      getEquityHistorySince: async () => [],
      executeSafeTrade,
      getOrderStatus: makeThrowingGetOrderStatus(),
      broadcastSSE,
      sendTelegramAlert,
      testDataFilePaths: {
        lockFilePath: path.join(tempDir, "autopilot-worker.lock"),
        etfRotationStateFilePath: stateFilePath,
        etfRotationOrderAuditLogFilePath: auditLogFilePath,
        circuitBreakerStateFilePath: path.join(tempDir, "circuit-breaker-state.json"),
        circuitBreakerAuditLogFilePath: path.join(tempDir, "circuit-breaker-audit.jsonl"),
        journalFilePath: path.join(tempDir, "autopilot-decisions.jsonl"),
      },
    });

    await worker.runOnce("manual");

    expect(executeSafeTrade).not.toHaveBeenCalled();
    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
    const [telegramMessage] = sendTelegramAlert.mock.calls[0]!;
    expect(telegramMessage).toContain("off-target");
    expect(telegramMessage).toContain("QQQ");
    expect(telegramMessage).toContain("403");

    const notificationCalls = broadcastSSE.mock.calls
      .map((call) => call[0] as { type?: string; message?: string })
      .filter((payload) => payload.type === "notification" && payload.message?.includes("off-target"));
    expect(notificationCalls.length).toBe(1);

    const stateAfterFirstRun = JSON.parse(await fs.readFile(stateFilePath, "utf-8"));
    expect(stateAfterFirstRun.lastOffTargetReminderSentDate).toBe(today);

    const auditLinesAfterFirstRun = (await fs.readFile(auditLogFilePath, "utf-8"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const reminderEventsAfterFirstRun = auditLinesAfterFirstRun.filter(
      (event) => event.type === "OFF_TARGET_REMINDER_SENT",
    );
    expect(reminderEventsAfterFirstRun.length).toBe(1);
    expect(reminderEventsAfterFirstRun[0].reason).toContain("QQQ");

    // Second cycle, same calendar day - must not re-send.
    await worker.runOnce("manual");

    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
    const auditLinesAfterSecondRun = (await fs.readFile(auditLogFilePath, "utf-8"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const reminderEventsAfterSecondRun = auditLinesAfterSecondRun.filter(
      (event) => event.type === "OFF_TARGET_REMINDER_SENT",
    );
    expect(reminderEventsAfterSecondRun.length).toBe(1);
  });

  it("records the audit event + reminder date even when sendTelegramAlert throws, and the cycle still completes without a top-level error", async () => {
    const tempDir = await makeTempDataDir("autopilot-etf-off-target-reminder-tg-fail-");
    const today = todayDateKey();
    const month = currentMonthKey();

    const stateFilePath = path.join(tempDir, "etf-rotation-worker-state.json");
    const auditLogFilePath = path.join(tempDir, "etf-rotation-order-audit.jsonl");
    const journalFilePath = path.join(tempDir, "autopilot-decisions.jsonl");

    await fs.writeFile(
      stateFilePath,
      JSON.stringify({
        lastRebalanceDateKey: today,
        rebalanceMonthKey: month,
        configVariantKey: "baseline-2",
        status: "partial",
        targets: [
          { ticker: "QQQ", weightPercent: 50 },
          { ticker: "SPY", weightPercent: 50 },
        ],
        plannedOrders: [
          { ticker: "QQQ", action: "BUY", shares: 63, targetWeightPercent: 50 },
          { ticker: "SPY", action: "BUY", shares: 58, targetWeightPercent: 50 },
        ],
      }),
      "utf-8",
    );

    await fs.writeFile(
      auditLogFilePath,
      `${JSON.stringify({
        type: "ORDER_REJECTED",
        timestamp: `${today}T13:52:26.373Z`,
        rebalanceMonthKey: month,
        configVariantKey: "baseline-2",
        ticker: "QQQ",
        side: "BUY",
        legType: "rebuild_target",
        requestedQty: 63,
        submittedQty: 2,
        error: "Request failed with status code 403",
      })}\n`,
      "utf-8",
    );

    const bars = makeDailyBarsSeries(5, today);
    stubFetchForBarsByTicker({ SPY: bars, QQQ: bars, EFA: bars, TLT: bars, GLD: bars });

    const portfolio = makePortfolioSnapshot({
      positions: {
        SPY: { shares: 2, avgPrice: 752.53, currentPrice: 769.8, pnl: 34.54, pnlPercent: 2.3 },
      },
    });

    // Real ETF rotation module import - only sendTelegramAlert is made to
    // fail, proving the audit/state write (which now happens first) is
    // durable independent of whether the notification itself goes out.
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
        etfRotationStateFilePath: stateFilePath,
        etfRotationOrderAuditLogFilePath: auditLogFilePath,
        circuitBreakerStateFilePath: path.join(tempDir, "circuit-breaker-state.json"),
        circuitBreakerAuditLogFilePath: path.join(tempDir, "circuit-breaker-audit.jsonl"),
        journalFilePath,
      },
    });

    const result = await worker.runOnce("manual");

    // The throw is swallowed by the block's own try/catch (already present
    // since PR #64) - the cycle as a whole must not report an error.
    expect(result.error).toBeUndefined();
    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);

    const stateAfterRun = JSON.parse(await fs.readFile(stateFilePath, "utf-8"));
    expect(stateAfterRun.lastOffTargetReminderSentDate).toBe(today);

    const auditLines = (await fs.readFile(auditLogFilePath, "utf-8"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(auditLines.some((event) => event.type === "OFF_TARGET_REMINDER_SENT")).toBe(true);

    // The journal write happens after this block - proves a Telegram
    // failure here doesn't cascade into skipping the rest of the cycle.
    const journalExists = await fs
      .access(journalFilePath)
      .then(() => true)
      .catch(() => false);
    expect(journalExists).toBe(true);
  });

  it("does not send a reminder when the rebuild BUY actually succeeded, even at a far-below-target ramp-capped size", async () => {
    const tempDir = await makeTempDataDir("autopilot-etf-off-target-reminder-ok-");
    const today = todayDateKey();
    const month = currentMonthKey();

    const stateFilePath = path.join(tempDir, "etf-rotation-worker-state.json");
    const auditLogFilePath = path.join(tempDir, "etf-rotation-order-audit.jsonl");

    await fs.writeFile(
      stateFilePath,
      JSON.stringify({
        lastRebalanceDateKey: today,
        rebalanceMonthKey: month,
        configVariantKey: "baseline-2",
        status: "executed",
        targets: [
          { ticker: "QQQ", weightPercent: 50 },
          { ticker: "SPY", weightPercent: 50 },
        ],
        plannedOrders: [
          { ticker: "QQQ", action: "BUY", shares: 63, targetWeightPercent: 50 },
          { ticker: "SPY", action: "BUY", shares: 58, targetWeightPercent: 50 },
        ],
      }),
      "utf-8",
    );

    const bars = makeDailyBarsSeries(5, today);
    stubFetchForBarsByTicker({ SPY: bars, QQQ: bars, EFA: bars, TLT: bars, GLD: bars });

    // Both legs actually hold shares - a real, successful (if ramp-capped)
    // rebuild, not the incident scenario.
    const portfolio = makePortfolioSnapshot({
      positions: {
        SPY: { shares: 2, avgPrice: 752.53, currentPrice: 769.8, pnl: 34.54, pnlPercent: 2.3 },
        QQQ: { shares: 2, avgPrice: 700, currentPrice: 709, pnl: 18, pnlPercent: 1.3 },
      },
    });

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
        etfRotationStateFilePath: stateFilePath,
        etfRotationOrderAuditLogFilePath: auditLogFilePath,
        circuitBreakerStateFilePath: path.join(tempDir, "circuit-breaker-state.json"),
        circuitBreakerAuditLogFilePath: path.join(tempDir, "circuit-breaker-audit.jsonl"),
        journalFilePath: path.join(tempDir, "autopilot-decisions.jsonl"),
      },
    });

    await worker.runOnce("manual");

    expect(sendTelegramAlert).not.toHaveBeenCalled();

    const stateAfterRun = JSON.parse(await fs.readFile(stateFilePath, "utf-8"));
    expect(stateAfterRun.lastOffTargetReminderSentDate).toBeUndefined();
  });
});
