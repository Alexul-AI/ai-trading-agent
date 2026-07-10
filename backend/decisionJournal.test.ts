import { promises as fs } from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getJournalTruncationInfo,
  readAutopilotRuns,
  summarizeAutopilotRuns,
  type BlockReasonCategory,
  type JournalDecision,
  type JournalRun,
} from "./decisionJournal.js";

function makeRun(
  index: number,
  decisionOverrides: Partial<JournalDecision> = {},
): JournalRun {
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
        ...decisionOverrides,
      },
    ],
  };
}

function makeBlockedRun(
  index: number,
  category: BlockReasonCategory,
): JournalRun {
  return makeRun(index, {
    action: "BUY",
    confidence: 0.9,
    suggestedShares: 10,
    reasonType: "BUY_CONFLUENCE",
    signalStatus: "blocked",
    isSignalReady: false,
    blockReasonCategory: category,
  });
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

describe("getJournalTruncationInfo", () => {
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

  it("reports not truncated and zero size when the file doesn't exist yet", async () => {
    const info = await getJournalTruncationInfo(tmpFile, 1024);

    expect(info).toEqual({ truncated: false, fileSizeBytes: 0 });
  });

  it("reports not truncated when the file fits inside the tail window", async () => {
    await fs.writeFile(tmpFile, JSON.stringify(makeRun(0)), "utf-8");

    const fileSize = (await fs.stat(tmpFile)).size;
    const info = await getJournalTruncationInfo(tmpFile, fileSize + 1);

    expect(info.truncated).toBe(false);
    expect(info.fileSizeBytes).toBe(fileSize);
  });

  it("reports truncated when the file is larger than the tail window", async () => {
    await fs.writeFile(tmpFile, JSON.stringify(makeRun(0)), "utf-8");

    const fileSize = (await fs.stat(tmpFile)).size;
    const info = await getJournalTruncationInfo(tmpFile, fileSize - 1);

    expect(info.truncated).toBe(true);
    expect(info.fileSizeBytes).toBe(fileSize);
  });
});

describe("summarizeAutopilotRuns", () => {
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

  it("breaks blocked signals out by blockReasonCategory", async () => {
    const lines = [
      JSON.stringify(makeBlockedRun(0, "sentiment_filter")),
      JSON.stringify(makeBlockedRun(1, "sentiment_filter")),
      JSON.stringify(makeBlockedRun(2, "insider_filter")),
      JSON.stringify(makeBlockedRun(3, "confidence")),
      JSON.stringify(makeRun(4)), // HOLD, not a buy/sell signal at all
    ];

    await fs.writeFile(tmpFile, `${lines.join("\n")}\n`, "utf-8");

    const summary = await summarizeAutopilotRuns(200, tmpFile);

    expect(summary.signalBlockedSignals).toBe(4);
    expect(summary.byBlockReasonCategory).toEqual({
      sentiment_filter: 2,
      insider_filter: 1,
      confidence: 1,
    });
  });

  it("reports oldestRunAt/lastRunAt in chronological order", async () => {
    const lines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify(makeRun(i)),
    );

    await fs.writeFile(tmpFile, `${lines.join("\n")}\n`, "utf-8");

    const summary = await summarizeAutopilotRuns(200, tmpFile);

    expect(summary.oldestRunAt).toBe(makeRun(0).timestamp);
    expect(summary.lastRunAt).toBe(makeRun(4).timestamp);
  });

  it("surfaces truncated/fileSizeBytes from the underlying file, independent of the run limit", async () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify(makeRun(i)),
    );

    await fs.writeFile(tmpFile, `${lines.join("\n")}\n`, "utf-8");

    const fileSize = (await fs.stat(tmpFile)).size;

    // Small limit doesn't affect the file-level truncation signal - that
    // reflects the tail-read window (JOURNAL_TAIL_READ_BYTES), not `limit`.
    const summary = await summarizeAutopilotRuns(2, tmpFile);

    expect(summary.totalRuns).toBe(2);
    expect(summary.truncated).toBe(false);
    expect(summary.fileSizeBytes).toBe(fileSize);
  });

  it("returns zeroed-out fields for a missing journal file", async () => {
    const summary = await summarizeAutopilotRuns(200, tmpFile);

    expect(summary.totalRuns).toBe(0);
    expect(summary.oldestRunAt).toBeNull();
    expect(summary.lastRunAt).toBeNull();
    expect(summary.truncated).toBe(false);
    expect(summary.fileSizeBytes).toBe(0);
  });
});
