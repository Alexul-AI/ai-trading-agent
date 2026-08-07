import { describe, expect, it } from "vitest";

import {
  parseFloatWithDefault,
  parseIntWithDefault,
  resolveAutopilotStrategy,
  resolveAutopilotTickers,
} from "./autopilotConfig.js";

// Pure functions - no vi.stubEnv/dynamic-import choreography needed, unlike
// the module's own top-level "wiring" consts (see autopilotConfig.ts's file
// header and docs/ops/AUTOPILOT_WORKER_MAP.md's Slice 2 entry for why).

describe("parseIntWithDefault", () => {
  it("returns the default when unset", () => {
    expect(parseIntWithDefault(undefined, 180)).toBe(180);
  });

  it("parses a valid explicit value", () => {
    expect(parseIntWithDefault("60", 180)).toBe(60);
  });

  it("returns the default for an empty string (falsy, same as unset)", () => {
    expect(parseIntWithDefault("", 180)).toBe(180);
  });

  it("silently returns NaN for an invalid value - existing behavior, not new validation", () => {
    // This is a real, pre-existing latent footgun (e.g. a typo'd
    // AUTOPILOT_INTERVAL_MS would make setInterval coerce to a 0ms
    // interval) - deliberately not fixed by this extraction, only moved.
    expect(parseIntWithDefault("garbage", 180)).toBeNaN();
  });

  it("truncates a decimal value the same way Number.parseInt always has", () => {
    expect(parseIntWithDefault("60.9", 180)).toBe(60);
  });
});

describe("parseFloatWithDefault", () => {
  it("returns the default when unset", () => {
    expect(parseFloatWithDefault(undefined, 0.75)).toBe(0.75);
  });

  it("parses a valid explicit value", () => {
    expect(parseFloatWithDefault("0.5", 0.75)).toBe(0.5);
  });

  it("returns the default for an empty string (falsy, same as unset)", () => {
    expect(parseFloatWithDefault("", 0.75)).toBe(0.75);
  });

  it("silently returns NaN for an invalid value - existing behavior, not new validation", () => {
    expect(parseFloatWithDefault("garbage", 0.75)).toBeNaN();
  });
});

describe("resolveAutopilotTickers", () => {
  it("returns the default 13-ticker universe when unset", () => {
    expect(resolveAutopilotTickers(undefined)).toEqual([
      "AMD",
      "NVDA",
      "AAPL",
      "MSFT",
      "TSLA",
      "JPM",
      "JNJ",
      "XOM",
      "PG",
      "SPY",
      "GLD",
      "TLT",
      "EFA",
    ]);
  });

  it("splits, trims, and uppercases a custom CSV list", () => {
    expect(resolveAutopilotTickers(" spy, qqq ,efa")).toEqual([
      "SPY",
      "QQQ",
      "EFA",
    ]);
  });

  it("filters out empty entries from a trailing/double comma", () => {
    expect(resolveAutopilotTickers("SPY,,QQQ,")).toEqual(["SPY", "QQQ"]);
  });

  it("returns the default for an empty string (falsy, same as unset)", () => {
    expect(resolveAutopilotTickers("")).toEqual(resolveAutopilotTickers(undefined));
  });
});

describe("resolveAutopilotStrategy", () => {
  it("resolves to baseline when unset", () => {
    expect(resolveAutopilotStrategy(undefined)).toBe("baseline");
  });

  it("resolves to etf_rotation on an exact match", () => {
    expect(resolveAutopilotStrategy("etf_rotation")).toBe("etf_rotation");
  });

  it("falls back to baseline on any unrecognized value, rather than throwing", () => {
    expect(resolveAutopilotStrategy("garbage")).toBe("baseline");
    expect(resolveAutopilotStrategy("ETF_ROTATION")).toBe("baseline");
  });
});
