import { promises as fs } from "fs";
import os from "os";
import path from "path";

import { describe, expect, it } from "vitest";

import {
  getLastRebalanceDateKey,
  recordRebalanceDateKey,
} from "./etfRotationWorkerState.js";

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
});
