import { promises as fs } from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readAutopilotRuns, type JournalRun } from "./decisionJournal.js";

function makeRun(index: number): JournalRun {
  return {
    id: `run_${index}`,
    timestamp: new Date(2026, 0, 1, 0, index).toISOString(),
    trigger: "scheduled",
    executeTrades: false,
    tradeMode: "paper",
    enabled: true,
    tickers: ["AMD"],
    decisions: [
      {
        ticker: "AMD",
        timestamp: new Date().toISOString(),
        price: 500,
        rsi: 50,
        macdHistogram: 0,
        previousMacdHistogram: 0,
        bollingerLower: 480,
        bollingerUpper: 520,
        action: "HOLD",
        confidence: 0,
        suggestedShares: 0,
        reasonType: "NO_SIGNAL",
        reason: `filler run ${index} to pad file size`.repeat(10),
        executed: false,
      },
    ],
  };
}

describe("readAutopilotRuns (tail read)", () => {
  let tmpFile: string;

  beforeEach(async () => {
    tmpFile = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "journal-test-")),
      "journal.jsonl",
    );
  });

  afterEach(async () => {
    await fs.rm(path.dirname(tmpFile), { recursive: true, force: true });
  });

  it("returns an empty array when the file doesn't exist yet", async () => {
    const runs = await readAutopilotRuns(10, tmpFile);

    expect(runs).toEqual([]);
  });

  it("returns runs most-recent-first, respecting the limit", async () => {
    const lines = Array.from({ length: 20 }, (_, i) =>
      JSON.stringify(makeRun(i)),
    );

    await fs.writeFile(tmpFile, `${lines.join("\n")}\n`, "utf-8");

    const runs = await readAutopilotRuns(5, tmpFile);

    expect(runs).toHaveLength(5);
    expect(runs.map((r) => r.id)).toEqual([
      "run_19",
      "run_18",
      "run_17",
      "run_16",
      "run_15",
    ]);
  });

  it("safely drops a partial first line when a small tail window cuts mid-record", async () => {
    const lines = Array.from({ length: 50 }, (_, i) =>
      JSON.stringify(makeRun(i)),
    );

    await fs.writeFile(tmpFile, `${lines.join("\n")}\n`, "utf-8");

    const fileSize = (await fs.stat(tmpFile)).size;
    // Force a window that starts partway through the file - guaranteed to
    // land mid-line somewhere, not on a clean line boundary.
    const smallTailWindow = Math.floor(fileSize / 3);

    const runs = await readAutopilotRuns(3, tmpFile, smallTailWindow);

    // Whatever fragment the window starts on is dropped as unparseable,
    // but the last 3 entries are always fully inside the tail and must
    // come back intact and correctly ordered.
    expect(runs.map((r) => r.id)).toEqual(["run_49", "run_48", "run_47"]);
  });
});
