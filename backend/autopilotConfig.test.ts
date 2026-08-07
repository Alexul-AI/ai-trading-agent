import { describe, expect, it, vi } from "vitest";

import {
  parseIntWithFallbackWarning,
  parseStrictFractionWithDefault,
  parseStrictPositiveIntWithDefault,
  resolveAutopilotStrategy,
  resolveAutopilotTickers,
} from "./autopilotConfig.js";

// Pure functions - no vi.stubEnv/dynamic-import choreography needed, unlike
// the module's own top-level "wiring" consts (see autopilotConfig.ts's file
// header and docs/ops/AUTOPILOT_WORKER_MAP.md's Slice 2 entry for why).

describe("parseStrictPositiveIntWithDefault", () => {
  it("returns the default when unset", () => {
    expect(parseStrictPositiveIntWithDefault("X", undefined, 180)).toBe(180);
  });

  it("parses a valid explicit value", () => {
    expect(parseStrictPositiveIntWithDefault("X", "60", 180)).toBe(60);
  });

  it("throws on zero - the exact NaN-equivalent danger for setInterval/lock-staleness fields", () => {
    expect(() => parseStrictPositiveIntWithDefault("X", "0", 180)).toThrow(
      /Invalid X \("0"\)/,
    );
  });

  it("throws on a negative value", () => {
    expect(() => parseStrictPositiveIntWithDefault("X", "-5", 180)).toThrow(
      /Invalid X \("-5"\)/,
    );
  });

  it("throws on a non-numeric value, naming the env var in the message", () => {
    expect(() => parseStrictPositiveIntWithDefault("AUTOPILOT_INTERVAL_MS", "garbage", 180)).toThrow(
      /Invalid AUTOPILOT_INTERVAL_MS \("garbage"\)/,
    );
  });

  it("throws on a decimal value - stricter than Number.parseInt's silent truncation", () => {
    expect(() => parseStrictPositiveIntWithDefault("X", "60.9", 180)).toThrow(
      /Invalid X \("60.9"\)/,
    );
  });

  it("throws on trailing garbage that Number.parseInt would have silently ignored", () => {
    expect(() => parseStrictPositiveIntWithDefault("X", "60abc", 180)).toThrow();
  });
});

describe("parseStrictFractionWithDefault", () => {
  it("returns the default when unset", () => {
    expect(parseStrictFractionWithDefault("X", undefined, 0.75)).toBe(0.75);
  });

  it("parses a valid explicit value", () => {
    expect(parseStrictFractionWithDefault("X", "0.5", 0.75)).toBe(0.5);
  });

  it("accepts 1 as a legitimate inclusive upper boundary", () => {
    expect(parseStrictFractionWithDefault("X", "1", 0.75)).toBe(1);
  });

  it("throws on zero", () => {
    expect(() => parseStrictFractionWithDefault("X", "0", 0.75)).toThrow(
      /Invalid X \("0"\)/,
    );
  });

  it("throws on a negative value", () => {
    expect(() => parseStrictFractionWithDefault("X", "-0.1", 0.75)).toThrow();
  });

  it("throws above the inclusive upper bound of 1", () => {
    expect(() => parseStrictFractionWithDefault("X", "1.5", 0.75)).toThrow();
  });

  it("throws on a non-numeric value, naming the env var in the message", () => {
    expect(() =>
      parseStrictFractionWithDefault("AUTOPILOT_MIN_CONFIDENCE", "garbage", 0.75),
    ).toThrow(/Invalid AUTOPILOT_MIN_CONFIDENCE \("garbage"\)/);
  });
});

describe("parseIntWithFallbackWarning", () => {
  it("returns the default when unset, without warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseIntWithFallbackWarning("X", undefined, 180)).toBe(180);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("parses a valid explicit value, without warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseIntWithFallbackWarning("X", "60", 180)).toBe(60);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("falls back to the default and warns on zero, rather than throwing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseIntWithFallbackWarning("X", "0", 180)).toBe(180);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("falls back to the default and warns on a negative value - closes the cooldown-defeating direction, not just NaN", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseIntWithFallbackWarning("X", "-5", 180)).toBe(180);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("falls back to the default and warns, naming the env var, on a non-numeric value", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseIntWithFallbackWarning("AUTOPILOT_BARS_DAYS", "garbage", 180)).toBe(180);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("AUTOPILOT_BARS_DAYS"),
    );
    warnSpy.mockRestore();
  });
});

// Concrete, field-by-field proof that every real production default value -
// plus the one confirmed real Render override, AUTOPILOT_LOCK_STALE_AFTER_MS
// =600000 (see CLAUDE.md) - still parses successfully under the new strict
// validation, not just an assertion that "defaults are preserved."
describe("real production values parse cleanly under the new strict validation", () => {
  it("every fail-loud integer field's real default, and the one confirmed Render override, parse without throwing", () => {
    expect(parseStrictPositiveIntWithDefault("AUTOPILOT_INTERVAL_MS", undefined, 3600000)).toBe(
      3600000,
    );
    expect(
      parseStrictPositiveIntWithDefault("AUTOPILOT_LOCK_STALE_AFTER_MS", "600000", 10800000),
    ).toBe(600000);
  });

  it("every fail-loud fraction field's real default parses without throwing", () => {
    expect(parseStrictFractionWithDefault("AUTOPILOT_MIN_CONFIDENCE", undefined, 0.75)).toBe(
      0.75,
    );
    expect(
      parseStrictFractionWithDefault("AUTOPILOT_MAX_BUCKET_EQUITY_FRACTION", undefined, 0.4),
    ).toBe(0.4);
    expect(
      parseStrictFractionWithDefault(
        "AUTOPILOT_HIGH_BETA_BUCKET_EQUITY_FRACTION",
        undefined,
        0.2,
      ),
    ).toBe(0.2);
  });

  it("every bounded-fallback field's real default parses without a warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseIntWithFallbackWarning("AUTOPILOT_BARS_DAYS", undefined, 180)).toBe(180);
    expect(parseIntWithFallbackWarning("AUTOPILOT_ETF_ROTATION_BARS_DAYS", undefined, 400)).toBe(
      400,
    );
    expect(parseIntWithFallbackWarning("AUTOPILOT_COOLDOWN_MINUTES", undefined, 60)).toBe(60);
    expect(
      parseIntWithFallbackWarning("AUTOPILOT_TELEGRAM_COOLDOWN_MINUTES", undefined, 30),
    ).toBe(30);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
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
