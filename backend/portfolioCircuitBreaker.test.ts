import { promises as fs } from "fs";
import os from "os";
import path from "path";

import { describe, expect, it } from "vitest";

import {
  applyStickyTrip,
  evaluatePortfolioDrawdown,
  findPeakSinceTracking,
  getPortfolioCircuitBreakerState,
  resetPortfolioCircuitBreaker,
  shouldSendDailyReminder,
  updatePortfolioCircuitBreaker,
  type CircuitBreakerState,
} from "./portfolioCircuitBreaker.js";

describe("applyStickyTrip", () => {
  it("stays tripped even when a fresh evaluation says recovered", () => {
    // Equity climbed to a new post-trip high, so evaluatePortfolioDrawdown
    // would report tripped=false again - the sticky rule must override
    // that and keep the breaker tripped, matching live's no-auto-recovery
    // behavior (only a manual reset clears it).
    expect(applyStickyTrip(false, true)).toBe(true);
  });

  it("trips fresh when the evaluation trips and nothing was tripped before", () => {
    expect(applyStickyTrip(true, false)).toBe(true);
  });

  it("stays tripped when both the evaluation and prior state are tripped", () => {
    expect(applyStickyTrip(true, true)).toBe(true);
  });

  it("stays untripped when neither the evaluation nor prior state is tripped", () => {
    expect(applyStickyTrip(false, false)).toBe(false);
  });
});

describe("evaluatePortfolioDrawdown", () => {
  it("does not trip when equity is at a new peak", () => {
    const result = evaluatePortfolioDrawdown(10000, 10000, -0.15);

    expect(result.tripped).toBe(false);
    expect(result.drawdownPercent).toBe(0);
  });

  it("does not trip when drawdown is smaller than the threshold", () => {
    const result = evaluatePortfolioDrawdown(9200, 10000, -0.15);

    expect(result.tripped).toBe(false);
    expect(result.drawdownPercent).toBeCloseTo(-0.08, 5);
  });

  it("trips exactly at the threshold", () => {
    const result = evaluatePortfolioDrawdown(8500, 10000, -0.15);

    expect(result.tripped).toBe(true);
    expect(result.drawdownPercent).toBeCloseTo(-0.15, 5);
  });

  it("trips when drawdown exceeds the threshold", () => {
    const result = evaluatePortfolioDrawdown(7000, 10000, -0.15);

    expect(result.tripped).toBe(true);
    expect(result.drawdownPercent).toBeCloseTo(-0.3, 5);
  });

  it("respects a custom threshold", () => {
    // 9400/10000 is a fixed -6% drawdown; only the threshold varies.
    const notTripped = evaluatePortfolioDrawdown(9400, 10000, -0.1);
    const tripped = evaluatePortfolioDrawdown(9400, 10000, -0.03);

    expect(notTripped.tripped).toBe(false);
    expect(tripped.tripped).toBe(true);
  });

  it("never trips when peak equity is zero or negative", () => {
    const result = evaluatePortfolioDrawdown(100, 0, -0.15);

    expect(result.tripped).toBe(false);
    expect(result.drawdownPercent).toBe(0);
  });
});

describe("findPeakSinceTracking", () => {
  const now = "2026-07-11T12:00:00.000Z";

  it("uses current equity as the peak when history is empty", () => {
    const result = findPeakSinceTracking([], 10000, now);

    expect(result.peakEquity).toBe(10000);
    expect(result.peakEquityAt).toBe(now);
  });

  it("uses current equity as the peak when history never exceeds it", () => {
    const history = [
      { timestamp: 1, equity: 9000 },
      { timestamp: 2, equity: 9500 },
    ];

    const result = findPeakSinceTracking(history, 10000, now);

    expect(result.peakEquity).toBe(10000);
    expect(result.peakEquityAt).toBe(now);
  });

  it("picks the historical peak when it exceeds current equity", () => {
    const peakTimestampSeconds = 1_700_000_000;
    const history = [
      { timestamp: 1_699_000_000, equity: 9000 },
      { timestamp: peakTimestampSeconds, equity: 12000 },
      { timestamp: 1_701_000_000, equity: 11000 },
    ];

    const result = findPeakSinceTracking(history, 10000, now);

    expect(result.peakEquity).toBe(12000);
    expect(result.peakEquityAt).toBe(
      new Date(peakTimestampSeconds * 1000).toISOString(),
    );
  });

  it("falls back to the cached peak when history is empty (fetch failure)", () => {
    const cachedPeak = { equity: 15000, at: "2026-07-01T00:00:00.000Z" };

    const result = findPeakSinceTracking([], 10000, now, cachedPeak);

    expect(result.peakEquity).toBe(15000);
    expect(result.peakEquityAt).toBe(cachedPeak.at);
  });

  it("does not let a lower cached peak override a higher current equity or history", () => {
    const cachedPeak = { equity: 9000, at: "2026-07-01T00:00:00.000Z" };
    const history = [{ timestamp: 1_700_000_000, equity: 11000 }];

    const result = findPeakSinceTracking(history, 10000, now, cachedPeak);

    expect(result.peakEquity).toBe(11000);
  });
});

describe("shouldSendDailyReminder", () => {
  it("sends when tripped and no reminder has ever been sent", () => {
    expect(shouldSendDailyReminder(true, null, "2026-07-14")).toBe(true);
  });

  it("sends when tripped and the last reminder was a different calendar day", () => {
    expect(shouldSendDailyReminder(true, "2026-07-13", "2026-07-14")).toBe(
      true,
    );
  });

  it("does not send again on the same calendar day", () => {
    expect(shouldSendDailyReminder(true, "2026-07-14", "2026-07-14")).toBe(
      false,
    );
  });

  it("never sends when not tripped, regardless of last-sent date", () => {
    expect(shouldSendDailyReminder(false, null, "2026-07-14")).toBe(false);
    expect(shouldSendDailyReminder(false, "2026-07-13", "2026-07-14")).toBe(
      false,
    );
  });
});

describe("circuit breaker restart persistence", () => {
  async function withTempStateFile(
    run: (filePath: string) => Promise<void>,
  ): Promise<void> {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "circuit-breaker-test-"),
    );
    const filePath = path.join(dir, "circuit-breaker-state.json");
    try {
      await run(filePath);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  async function writeTrippedFixture(
    filePath: string,
    overrides: Partial<CircuitBreakerState> = {},
  ): Promise<CircuitBreakerState> {
    const fixture: CircuitBreakerState = {
      trackingStartDate: "2026-06-01T00:00:00.000Z",
      peakEquity: 100000,
      peakEquityAt: "2026-07-01T00:00:00.000Z",
      tripped: true,
      trippedAt: "2026-07-10T00:00:00.000Z",
      dataStale: false,
      lastReminderSentDate: "2026-07-14",
      ...overrides,
    };
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(fixture), "utf-8");
    return fixture;
  }

  it("the restart scenario: a tripped state left by a previous process is read back exactly, nothing lost", async () => {
    await withTempStateFile(async (filePath) => {
      const fixture = await writeTrippedFixture(filePath);

      // A fresh process ("after restart") reads the state a prior process left.
      const state = await getPortfolioCircuitBreakerState(filePath);

      expect(state).toEqual(fixture);
    });
  });

  it("a restart does not un-trip the breaker even when a fresh evaluation would say equity has recovered", async () => {
    await withTempStateFile(async (filePath) => {
      await writeTrippedFixture(filePath);

      // Equity is now back above the peak - evaluatePortfolioDrawdown alone
      // would report tripped=false - but the sticky rule must still win
      // after a restart, not just within one process's lifetime.
      const recoveredEquity = 150000;
      const fetchEquityHistoryStub = async () => [];

      const result = await updatePortfolioCircuitBreaker(
        recoveredEquity,
        fetchEquityHistoryStub,
        filePath,
      );

      expect(result.state.tripped).toBe(true);
      expect(result.justTripped).toBe(false);
      // trippedAt must be preserved from before the restart, not overwritten
      // with "now" just because this process re-evaluated it.
      expect(result.state.trippedAt).toBe("2026-07-10T00:00:00.000Z");
    });
  });

  it("reset clears the tripped state left by a previous process, including the reminder cadence", async () => {
    await withTempStateFile(async (filePath) => {
      await writeTrippedFixture(filePath);

      const resetState = await resetPortfolioCircuitBreaker(120000, filePath);

      expect(resetState.tripped).toBe(false);
      expect(resetState.trippedAt).toBeNull();
      expect(resetState.lastReminderSentDate).toBeNull();

      // Confirm the reset actually landed on disk, not just in the
      // in-memory return value.
      const onDisk = await getPortfolioCircuitBreakerState(filePath);
      expect(onDisk).toEqual(resetState);
    });
  });

  it("starts clean (null) when no state file exists yet, same as a brand-new deployment", async () => {
    await withTempStateFile(async (filePath) => {
      const state = await getPortfolioCircuitBreakerState(filePath);
      expect(state).toBeNull();
    });
  });
});
