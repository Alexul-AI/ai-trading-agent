// Shared fixtures for autopilotWorker.characterization.*.test.ts. Not itself
// a test file (no describe/it) - vitest's default glob won't pick this up
// unless imported.
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { vi } from "vitest";

import type { AlpacaBar } from "./src/types/autopilotTypes.js";
import type { PortfolioSnapshot } from "./src/strategy/portfolioSafety.js";
import type { ExecuteSafeTradeResult } from "./src/types/autopilotTypes.js";

export async function makeTempDataDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** One daily bar per calendar day (weekends included - fine for numeric-only fixtures), ending at `endDateKey`, close price trending mildly upward from `startClose` at `dailyGrowth` per day. */
export function makeDailyBarsSeries(
  count: number,
  endDateKey: string,
  startClose = 100,
  dailyGrowth = 0.0005,
): AlpacaBar[] {
  const end = new Date(`${endDateKey}T00:00:00Z`);
  const bars: AlpacaBar[] = [];

  for (let i = count - 1; i >= 0; i--) {
    const date = new Date(end);
    date.setUTCDate(date.getUTCDate() - i);
    const close = startClose * (1 + (count - i) * dailyGrowth);

    bars.push({
      t: `${date.toISOString().slice(0, 10)}T00:00:00Z`,
      o: close,
      h: close * 1.01,
      l: close * 0.99,
      c: Number(close.toFixed(2)),
      v: 1_000_000,
    });
  }

  return bars;
}

export function todayDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function currentMonthKey(): string {
  return todayDateKey().slice(0, 7);
}

/**
 * Stubs the ambient global `fetch` (fetchAlpacaBarsUncached calls it
 * directly, not via an injected reference - this is lower-risk than a new
 * DI seam, see docs/ops/AUTOPILOT_WORKER_MAP.md). Parses the ticker out of
 * the request URL's path and returns the matching canned bars as a single,
 * unpaginated page.
 */
export function stubFetchForBarsByTicker(
  barsByTicker: Record<string, AlpacaBar[]>,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const parsed = new URL(String(url));
      const match = parsed.pathname.match(/\/v2\/stocks\/([^/]+)\/bars/);
      const ticker = match?.[1] ?? "";
      const bars = barsByTicker[ticker] ?? [];

      return {
        ok: true,
        status: 200,
        json: async () => ({ bars, next_page_token: null }),
        text: async () => "",
      } as unknown as Response;
    }),
  );
}

export function makePortfolioSnapshot(
  overrides: Partial<PortfolioSnapshot> = {},
): PortfolioSnapshot {
  return {
    balance: 10_000,
    equity: 10_000,
    currency: "USD",
    positions: {},
    ...overrides,
  };
}

/** Throws if ever invoked - proves the broker path is genuinely unreached, not just "didn't happen to fire" (this project's established verification convention). */
export function makeThrowingExecuteSafeTrade() {
  return vi.fn(async (): Promise<ExecuteSafeTradeResult> => {
    throw new Error(
      "executeSafeTrade should never be called in this scenario.",
    );
  });
}

const REAL_DATA_FILES = [
  "autopilot-decisions.jsonl",
  "autopilot-worker.lock",
  "circuit-breaker-state.json",
  "etf-rotation-worker-state.json",
].map((name) => path.resolve(process.cwd(), "data", name));

export interface RealDataFileSnapshot {
  filePath: string;
  existed: boolean;
  mtimeMs: number | null;
  size: number | null;
}

/** Regression guard: snapshot mtime+size of the real production data files before a suite runs. */
export async function snapshotRealDataFiles(): Promise<RealDataFileSnapshot[]> {
  return Promise.all(
    REAL_DATA_FILES.map(async (filePath) => {
      try {
        const stat = await fs.stat(filePath);
        return { filePath, existed: true, mtimeMs: stat.mtimeMs, size: stat.size };
      } catch {
        return { filePath, existed: false, mtimeMs: null, size: null };
      }
    }),
  );
}

/** Asserts the real production data files are byte-for-byte unchanged since `snapshotRealDataFiles()` was called - turns a missed `testDataFilePaths` seam into a loud failure instead of silent corruption. */
export async function assertRealDataFilesUnchanged(
  before: RealDataFileSnapshot[],
): Promise<void> {
  const after = await snapshotRealDataFiles();

  for (let i = 0; i < before.length; i++) {
    const prev = before[i];
    const now = after[i];
    if (!prev || !now) continue;

    if (prev.existed !== now.existed || prev.mtimeMs !== now.mtimeMs || prev.size !== now.size) {
      throw new Error(
        `Real production data file changed during the test suite: ${prev.filePath} ` +
          `(before: existed=${prev.existed} mtimeMs=${prev.mtimeMs} size=${prev.size}, ` +
          `after: existed=${now.existed} mtimeMs=${now.mtimeMs} size=${now.size}). ` +
          `A characterization test is missing a testDataFilePaths override.`,
      );
    }
  }
}
