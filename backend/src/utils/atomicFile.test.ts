import { promises as fs } from "fs";
import os from "os";
import path from "path";

import { describe, expect, it } from "vitest";

import { writeJsonFileAtomic } from "./atomicFile.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-file-test-"));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("writeJsonFileAtomic", () => {
  it("writes the exact expected JSON content", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "state.json");

      await writeJsonFileAtomic(filePath, { a: 1, b: "two" });

      const raw = await fs.readFile(filePath, "utf-8");
      expect(JSON.parse(raw)).toEqual({ a: 1, b: "two" });
    });
  });

  it("leaves no leftover temp file behind after a successful write", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "state.json");

      await writeJsonFileAtomic(filePath, { ok: true });

      const entries = await fs.readdir(dir);
      expect(entries).toEqual(["state.json"]);
    });
  });

  it("creates the parent directory if it doesn't exist yet", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "nested", "state.json");

      await writeJsonFileAtomic(filePath, { ok: true });

      const raw = await fs.readFile(filePath, "utf-8");
      expect(JSON.parse(raw)).toEqual({ ok: true });
    });
  });

  it("fully overwrites an existing file's content, not merges", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "state.json");

      await writeJsonFileAtomic(filePath, { a: 1, b: 2 });
      await writeJsonFileAtomic(filePath, { c: 3 });

      const raw = await fs.readFile(filePath, "utf-8");
      expect(JSON.parse(raw)).toEqual({ c: 3 });
    });
  });
});
