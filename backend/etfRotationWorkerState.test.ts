import { promises as fs } from "fs";
import os from "os";
import path from "path";

import { describe, expect, it } from "vitest";

import {
  decideEtfRotationGateAction,
  getLastRebalanceDateKey,
  getRebalanceState,
  isRebalanceMonthDone,
  readRebalanceStateStrict,
  recordRebalanceDateKey,
  recordRebalanceExecuting,
  recordRebalancePlanned,
  recordRebalanceTerminal,
  type EtfRotationWorkerState,
  type RebalanceStateReadResult,
} from "./etfRotationWorkerState.js";
import type { RebalanceOrder, RotationTarget } from "./etfRotationStrategy.js";

async function withTempStateFile(
  run: (filePath: string) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "etf-rotation-worker-state-test-"),
  );
  const filePath = path.join(dir, "etf-rotation-worker-state.json");
  try {
    await run(filePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("etfRotationWorkerState", () => {
  it("returns null when no state file exists yet", async () => {
    await withTempStateFile(async (filePath) => {
      expect(await getLastRebalanceDateKey(filePath)).toBeNull();
    });
  });

  it("returns null rather than throwing when the state file is corrupt", async () => {
    await withTempStateFile(async (filePath) => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "{not valid json", "utf-8");

      expect(await getLastRebalanceDateKey(filePath)).toBeNull();
    });
  });

  it("persists and reads back the last rebalance date, surviving a simulated restart", async () => {
    await withTempStateFile(async (filePath) => {
      await recordRebalanceDateKey("2026-07-01", filePath);

      // A fresh read (as if from a new process after a restart).
      expect(await getLastRebalanceDateKey(filePath)).toBe("2026-07-01");
    });
  });

  it("overwrites the previous value on a later rebalance", async () => {
    await withTempStateFile(async (filePath) => {
      await recordRebalanceDateKey("2026-07-01", filePath);
      await recordRebalanceDateKey("2026-08-03", filePath);

      expect(await getLastRebalanceDateKey(filePath)).toBe("2026-08-03");
    });
  });

  it("reads an old Stage-1-shaped file (lastRebalanceDateKey only) without the newer fields throwing or being required", async () => {
    await withTempStateFile(async (filePath) => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(
        filePath,
        JSON.stringify({ lastRebalanceDateKey: "2026-06-01" }),
        "utf-8",
      );

      const state = await getRebalanceState(filePath);

      expect(state.lastRebalanceDateKey).toBe("2026-06-01");
      expect(state.status).toBeUndefined();
      expect(state.rebalanceMonthKey).toBeUndefined();
    });
  });

  it("recordRebalanceDateKey merges onto existing state rather than clobbering richer fields", async () => {
    await withTempStateFile(async (filePath) => {
      const targets: RotationTarget[] = [{ ticker: "SPY", weightPercent: 50 }];
      const plannedOrders: RebalanceOrder[] = [
        { ticker: "SPY", action: "BUY", shares: 58, targetWeightPercent: 50 },
      ];

      await recordRebalancePlanned(
        {
          dateKey: "2026-07-14",
          rebalanceMonthKey: "2026-07",
          configVariantKey: "baseline-2",
          targets,
          plannedOrders,
        },
        filePath,
      );

      // A caller using only the old Stage 1 function afterwards must not
      // silently wipe out the richer fields set above.
      await recordRebalanceDateKey("2026-07-14", filePath);

      const state = await getRebalanceState(filePath);
      expect(state.status).toBe("planned");
      expect(state.targets).toEqual(targets);
      expect(state.plannedOrders).toEqual(plannedOrders);
    });
  });

  it("recordRebalancePlanned sets status=planned with startedAt and the computed targets/orders", async () => {
    await withTempStateFile(async (filePath) => {
      const targets: RotationTarget[] = [{ ticker: "QQQ", weightPercent: 50 }];
      const plannedOrders: RebalanceOrder[] = [
        { ticker: "QQQ", action: "BUY", shares: 61, targetWeightPercent: 50 },
      ];

      await recordRebalancePlanned(
        {
          dateKey: "2026-07-14",
          rebalanceMonthKey: "2026-07",
          configVariantKey: "baseline-2",
          targets,
          plannedOrders,
        },
        filePath,
      );

      const state = await getRebalanceState(filePath);
      expect(state.status).toBe("planned");
      expect(state.rebalanceMonthKey).toBe("2026-07");
      expect(state.configVariantKey).toBe("baseline-2");
      expect(state.lastRebalanceDateKey).toBe("2026-07-14");
      expect(state.startedAt).toBeDefined();
      expect(state.completedAt).toBeUndefined();
      expect(state.targets).toEqual(targets);
      expect(state.plannedOrders).toEqual(plannedOrders);
    });
  });

  it("recordRebalanceExecuting transitions status without losing other fields", async () => {
    await withTempStateFile(async (filePath) => {
      await recordRebalancePlanned(
        {
          dateKey: "2026-07-14",
          rebalanceMonthKey: "2026-07",
          configVariantKey: "baseline-2",
          targets: [],
          plannedOrders: [],
        },
        filePath,
      );

      await recordRebalanceExecuting(filePath);

      const state = await getRebalanceState(filePath);
      expect(state.status).toBe("executing");
      expect(state.rebalanceMonthKey).toBe("2026-07");
    });
  });

  it("recordRebalanceTerminal sets the terminal status and completedAt", async () => {
    await withTempStateFile(async (filePath) => {
      await recordRebalancePlanned(
        {
          dateKey: "2026-07-14",
          rebalanceMonthKey: "2026-07",
          configVariantKey: "baseline-2",
          targets: [],
          plannedOrders: [],
        },
        filePath,
      );
      await recordRebalanceExecuting(filePath);
      await recordRebalanceTerminal("executed", filePath);

      const state = await getRebalanceState(filePath);
      expect(state.status).toBe("executed");
      expect(state.completedAt).toBeDefined();
    });
  });

  it("a restart found mid-executing lands in failed_needs_review, not resumed automatically", async () => {
    await withTempStateFile(async (filePath) => {
      await recordRebalancePlanned(
        {
          dateKey: "2026-07-14",
          rebalanceMonthKey: "2026-07",
          configVariantKey: "baseline-2",
          targets: [],
          plannedOrders: [],
        },
        filePath,
      );
      await recordRebalanceExecuting(filePath);

      // Simulate a restart discovering the leftover "executing" state.
      const stateAfterCrash = await getRebalanceState(filePath);
      expect(stateAfterCrash.status).toBe("executing");

      await recordRebalanceTerminal("failed_needs_review", filePath);

      const state = await getRebalanceState(filePath);
      expect(state.status).toBe("failed_needs_review");
    });
  });
});

describe("isRebalanceMonthDone", () => {
  function stateWith(
    overrides: Partial<EtfRotationWorkerState>,
  ): EtfRotationWorkerState {
    return { lastRebalanceDateKey: null, ...overrides };
  }

  it("is false when no rebalance has ever been recorded", () => {
    expect(isRebalanceMonthDone(stateWith({}), "2026-07")).toBe(false);
  });

  it("is false when the recorded month doesn't match", () => {
    const state = stateWith({ rebalanceMonthKey: "2026-06", status: "executed" });
    expect(isRebalanceMonthDone(state, "2026-07")).toBe(false);
  });

  it("is true for a matching month with status executed", () => {
    const state = stateWith({ rebalanceMonthKey: "2026-07", status: "executed" });
    expect(isRebalanceMonthDone(state, "2026-07")).toBe(true);
  });

  it("is true for a matching month with an accepted partial", () => {
    const state = stateWith({ rebalanceMonthKey: "2026-07", status: "partial" });
    expect(isRebalanceMonthDone(state, "2026-07")).toBe(true);
  });

  it("is false for a matching month still planned (nothing executed yet)", () => {
    const state = stateWith({ rebalanceMonthKey: "2026-07", status: "planned" });
    expect(isRebalanceMonthDone(state, "2026-07")).toBe(false);
  });

  it("is false for a matching month left executing (interrupted mid-run)", () => {
    const state = stateWith({ rebalanceMonthKey: "2026-07", status: "executing" });
    expect(isRebalanceMonthDone(state, "2026-07")).toBe(false);
  });

  it("is false for failed_needs_review - never treated as a successful rebalance", () => {
    const state = stateWith({
      rebalanceMonthKey: "2026-07",
      status: "failed_needs_review",
    });
    expect(isRebalanceMonthDone(state, "2026-07")).toBe(false);
  });

  it("is false for failed", () => {
    const state = stateWith({ rebalanceMonthKey: "2026-07", status: "failed" });
    expect(isRebalanceMonthDone(state, "2026-07")).toBe(false);
  });

  it("is false for cancelled", () => {
    const state = stateWith({ rebalanceMonthKey: "2026-07", status: "cancelled" });
    expect(isRebalanceMonthDone(state, "2026-07")).toBe(false);
  });
});

describe("readRebalanceStateStrict", () => {
  it("reports corrupt: false when no file exists yet (a normal, safe first-ever run)", async () => {
    await withTempStateFile(async (filePath) => {
      const result = await readRebalanceStateStrict(filePath);

      expect(result.corrupt).toBe(false);
      expect(result.state.lastRebalanceDateKey).toBeNull();
    });
  });

  it("reports corrupt: true when the file exists but is unparseable JSON", async () => {
    await withTempStateFile(async (filePath) => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "{not valid json", "utf-8");

      const result = await readRebalanceStateStrict(filePath);

      expect(result.corrupt).toBe(true);
    });
  });

  it("reports corrupt: true when the file parses but lacks the expected shape", async () => {
    await withTempStateFile(async (filePath) => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify({ somethingElse: true }), "utf-8");

      const result = await readRebalanceStateStrict(filePath);

      expect(result.corrupt).toBe(true);
    });
  });

  it("reports corrupt: false and returns the real state for a valid file", async () => {
    await withTempStateFile(async (filePath) => {
      await recordRebalancePlanned(
        {
          dateKey: "2026-07-14",
          rebalanceMonthKey: "2026-07",
          configVariantKey: "baseline-2",
          targets: [],
          plannedOrders: [],
        },
        filePath,
      );

      const result = await readRebalanceStateStrict(filePath);

      expect(result.corrupt).toBe(false);
      expect(result.state.status).toBe("planned");
      expect(result.state.rebalanceMonthKey).toBe("2026-07");
    });
  });
});

describe("decideEtfRotationGateAction", () => {
  function resultWith(
    overrides: Partial<EtfRotationWorkerState>,
    corrupt = false,
  ): RebalanceStateReadResult {
    return {
      state: { lastRebalanceDateKey: null, ...overrides },
      corrupt,
    };
  }

  it("fails closed on a corrupt state file, regardless of anything else in the (untrusted) state", () => {
    const result = resultWith(
      { rebalanceMonthKey: "2026-07", status: "executing" },
      true,
    );
    expect(decideEtfRotationGateAction(result, "2026-07")).toBe(
      "state_corrupt_fail_closed",
    );
  });

  it("treats a leftover 'executing' status as needing review, not resumable", () => {
    const result = resultWith({
      rebalanceMonthKey: "2026-07",
      status: "executing",
    });
    expect(decideEtfRotationGateAction(result, "2026-07")).toBe(
      "stale_executing_needs_review",
    );
  });

  it("blocks on an existing failed_needs_review, even for an earlier month", () => {
    const result = resultWith({
      rebalanceMonthKey: "2026-06",
      status: "failed_needs_review",
    });
    expect(decideEtfRotationGateAction(result, "2026-07")).toBe(
      "blocked_failed_needs_review",
    );
  });

  it("reports already_done_this_month for a matching month with status executed", () => {
    const result = resultWith({
      rebalanceMonthKey: "2026-07",
      status: "executed",
    });
    expect(decideEtfRotationGateAction(result, "2026-07")).toBe(
      "already_done_this_month",
    );
  });

  it("reports already_done_this_month for a matching month with an accepted partial", () => {
    const result = resultWith({
      rebalanceMonthKey: "2026-07",
      status: "partial",
    });
    expect(decideEtfRotationGateAction(result, "2026-07")).toBe(
      "already_done_this_month",
    );
  });

  it("proceeds to plan when no rebalance has ever been recorded", () => {
    const result = resultWith({});
    expect(decideEtfRotationGateAction(result, "2026-07")).toBe(
      "proceed_to_plan",
    );
  });

  it("proceeds to plan for a new month even if the previous month completed successfully", () => {
    const result = resultWith({
      rebalanceMonthKey: "2026-06",
      status: "executed",
    });
    expect(decideEtfRotationGateAction(result, "2026-07")).toBe(
      "proceed_to_plan",
    );
  });

  it("proceeds to plan when the same month is only 'planned' so far (nothing executed yet)", () => {
    const result = resultWith({
      rebalanceMonthKey: "2026-07",
      status: "planned",
    });
    expect(decideEtfRotationGateAction(result, "2026-07")).toBe(
      "proceed_to_plan",
    );
  });

  it("proceeds to plan after a manual clear (cancelled) for the same month", () => {
    const result = resultWith({
      rebalanceMonthKey: "2026-07",
      status: "cancelled",
    });
    expect(decideEtfRotationGateAction(result, "2026-07")).toBe(
      "proceed_to_plan",
    );
  });

  it("proceeds to plan after a plain failed (not needs-review) for the same month", () => {
    const result = resultWith({
      rebalanceMonthKey: "2026-07",
      status: "failed",
    });
    expect(decideEtfRotationGateAction(result, "2026-07")).toBe(
      "proceed_to_plan",
    );
  });
});
