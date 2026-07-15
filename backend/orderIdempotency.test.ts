import { promises as fs } from "fs";
import os from "os";
import path from "path";

import { describe, expect, it } from "vitest";

import {
  classifyOrderError,
  createClientOrderIdTracker,
  createPersistedClientOrderIdTracker,
} from "./orderIdempotency.js";

describe("classifyOrderError", () => {
  it("classifies a 422 mentioning client_order_id as a duplicate", () => {
    const result = classifyOrderError({
      response: {
        status: 422,
        data: { message: "client_order_id must be unique" },
      },
    });

    expect(result).toBe("duplicate_client_order_id");
  });

  it("is case-insensitive and handles a string response body", () => {
    const result = classifyOrderError({
      response: {
        status: 422,
        data: "Duplicate CLIENT_ORDER_ID submitted",
      },
    });

    expect(result).toBe("duplicate_client_order_id");
  });

  it("classifies a 422 that isn't about client_order_id as a definitive rejection", () => {
    const result = classifyOrderError({
      response: {
        status: 422,
        data: { message: "insufficient buying power" },
      },
    });

    expect(result).toBe("definitive_rejection");
  });

  it("classifies any other 4xx/5xx as a definitive rejection", () => {
    const result = classifyOrderError({
      response: { status: 403, data: { message: "forbidden" } },
    });

    expect(result).toBe("definitive_rejection");
  });

  it("classifies an error with no response at all as ambiguous", () => {
    const result = classifyOrderError({});

    expect(result).toBe("ambiguous_network_error");
  });

  it("classifies a response with no status as ambiguous", () => {
    const result = classifyOrderError({ response: {} });

    expect(result).toBe("ambiguous_network_error");
  });
});

describe("createClientOrderIdTracker", () => {
  it("returns the same id across calls for the same ticker+action", () => {
    const tracker = createClientOrderIdTracker();

    const first = tracker.getOrCreate("AAPL", "BUY");
    const second = tracker.getOrCreate("AAPL", "BUY");

    expect(first).toBe(second);
  });

  it("is case-insensitive on ticker and action", () => {
    const tracker = createClientOrderIdTracker();

    const first = tracker.getOrCreate("AAPL", "BUY");
    const second = tracker.getOrCreate("aapl", "buy");

    expect(first).toBe(second);
  });

  it("returns a different id for a different ticker", () => {
    const tracker = createClientOrderIdTracker();

    const aapl = tracker.getOrCreate("AAPL", "BUY");
    const msft = tracker.getOrCreate("MSFT", "BUY");

    expect(aapl).not.toBe(msft);
  });

  it("returns a different id for a different action on the same ticker", () => {
    const tracker = createClientOrderIdTracker();

    const buy = tracker.getOrCreate("AAPL", "BUY");
    const sell = tracker.getOrCreate("AAPL", "SELL");

    expect(buy).not.toBe(sell);
  });

  it("issues a fresh id after clearing", () => {
    const tracker = createClientOrderIdTracker();

    const first = tracker.getOrCreate("AAPL", "BUY");
    tracker.clear("AAPL", "BUY");
    const second = tracker.getOrCreate("AAPL", "BUY");

    expect(first).not.toBe(second);
  });

  it("clearing one ticker+action does not affect another", () => {
    const tracker = createClientOrderIdTracker();

    const aapl = tracker.getOrCreate("AAPL", "BUY");
    tracker.getOrCreate("MSFT", "BUY");
    tracker.clear("MSFT", "BUY");

    expect(tracker.getOrCreate("AAPL", "BUY")).toBe(aapl);
  });

  it("hydrates from an initial state instead of starting empty", () => {
    const tracker = createClientOrderIdTracker({ "AAPL:BUY": "existing-id" });

    expect(tracker.getOrCreate("AAPL", "BUY")).toBe("existing-id");
  });

  it("snapshot reflects current pending entries and omits cleared ones", () => {
    const tracker = createClientOrderIdTracker();

    const aapl = tracker.getOrCreate("AAPL", "BUY");
    tracker.getOrCreate("MSFT", "SELL");
    tracker.clear("MSFT", "SELL");

    expect(tracker.snapshot()).toEqual({ "AAPL:BUY": aapl });
  });
});

describe("createPersistedClientOrderIdTracker", () => {
  async function withTempStateFile(
    run: (filePath: string) => Promise<void>,
  ): Promise<void> {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "order-idempotency-test-"),
    );
    const filePath = path.join(dir, "order-idempotency-state.json");
    try {
      await run(filePath);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  it("starts clean when the state file does not exist yet", async () => {
    await withTempStateFile(async (filePath) => {
      const tracker = await createPersistedClientOrderIdTracker(filePath);
      expect(tracker.snapshot()).toEqual({});
    });
  });

  it("starts clean rather than throwing when the state file is corrupt", async () => {
    await withTempStateFile(async (filePath) => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "{not valid json", "utf-8");

      const tracker = await createPersistedClientOrderIdTracker(filePath);
      expect(tracker.snapshot()).toEqual({});
    });
  });

  it("the restart scenario: a pending ambiguous entry left by a previous process is honored, not replaced with a fresh id", async () => {
    await withTempStateFile(async (filePath) => {
      // Simulate a previous process crashing right after an ambiguous
      // network error, having already persisted the pending entry.
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(
        filePath,
        JSON.stringify({ "AAPL:BUY": "autopilot-aapl-buy-previous-attempt" }),
        "utf-8",
      );

      // A fresh process ("after restart") creates its own tracker instance.
      const tracker = await createPersistedClientOrderIdTracker(filePath);

      // The same ticker+action must resolve to the SAME id as before the
      // restart - not a fresh one - so a retry lands in Alpaca's duplicate
      // branch instead of risking a second real order.
      const id = await tracker.getOrCreate("AAPL", "BUY");
      expect(id).toBe("autopilot-aapl-buy-previous-attempt");
    });
  });

  it("persists a new pending entry to disk before getOrCreate resolves", async () => {
    await withTempStateFile(async (filePath) => {
      const tracker = await createPersistedClientOrderIdTracker(filePath);
      const id = await tracker.getOrCreate("MSFT", "SELL");

      const onDisk = JSON.parse(await fs.readFile(filePath, "utf-8"));
      expect(onDisk).toEqual({ "MSFT:SELL": id });
    });
  });

  it("clear removes the entry from disk, so a subsequent restart starts clean for that key", async () => {
    await withTempStateFile(async (filePath) => {
      const tracker = await createPersistedClientOrderIdTracker(filePath);
      await tracker.getOrCreate("TSLA", "BUY");
      await tracker.clear("TSLA", "BUY");

      const onDisk = JSON.parse(await fs.readFile(filePath, "utf-8"));
      expect(onDisk).toEqual({});

      const afterRestart = await createPersistedClientOrderIdTracker(filePath);
      expect(afterRestart.snapshot()).toEqual({});
    });
  });
});
