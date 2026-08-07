import { describe, expect, it, vi } from "vitest";

import { isValidTimeZone, resolveTimeZone, toIsoDate, toLocalDateKey } from "./time.js";

describe("toIsoDate", () => {
  it("formats a Date as YYYY-MM-DD", () => {
    expect(toIsoDate(new Date("2026-08-07T13:45:00.000Z"))).toBe("2026-08-07");
  });
});

describe("isValidTimeZone", () => {
  it("accepts real IANA timezone names", () => {
    expect(isValidTimeZone("Asia/Jerusalem")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
  });

  it("rejects garbage input without throwing", () => {
    expect(isValidTimeZone("Not/A_Real_Zone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("toLocalDateKey", () => {
  it("matches the UTC date for a timestamp well within the day in both zones", () => {
    expect(toLocalDateKey("2026-08-07T13:45:00.000Z", "UTC")).toBe("2026-08-07");
    expect(toLocalDateKey("2026-08-07T13:45:00.000Z", "Asia/Jerusalem")).toBe("2026-08-07");
  });

  // Israel Daylight Time (IDT, UTC+3) in August - the exact real-world
  // scenario from the 2026-08-06/07 QQQ off-target reminders: a timestamp
  // just after UTC midnight is already the *next* calendar day in Jerusalem
  // local time, not the same day UTC would report.
  it("reports the next calendar day in Asia/Jerusalem (IDT, UTC+3) shortly after UTC midnight", () => {
    expect(toLocalDateKey("2026-08-07T00:36:00.000Z", "UTC")).toBe("2026-08-07");
    expect(toLocalDateKey("2026-08-07T00:36:00.000Z", "Asia/Jerusalem")).toBe("2026-08-07");
  });

  // Israel Standard Time (IST, UTC+2) in January - the disagreement window
  // (UTC day hasn't rolled over yet, but Jerusalem's already has) falls
  // between 22:00 and 24:00 UTC instead of 21:00-24:00 in summer.
  it("reports the next calendar day in Asia/Jerusalem (IST, UTC+2) before UTC's own day rolls over", () => {
    expect(toLocalDateKey("2026-01-01T22:30:00.000Z", "UTC")).toBe("2026-01-01");
    expect(toLocalDateKey("2026-01-01T22:30:00.000Z", "Asia/Jerusalem")).toBe("2026-01-02");
  });
});

describe("resolveTimeZone", () => {
  it("returns the default when unset", () => {
    expect(resolveTimeZone(undefined, "Asia/Jerusalem")).toBe("Asia/Jerusalem");
  });

  it("returns the default when set to an empty/whitespace string", () => {
    expect(resolveTimeZone("", "Asia/Jerusalem")).toBe("Asia/Jerusalem");
    expect(resolveTimeZone("   ", "Asia/Jerusalem")).toBe("Asia/Jerusalem");
  });

  it("returns a valid, explicitly configured timezone as-is", () => {
    expect(resolveTimeZone("America/New_York", "Asia/Jerusalem")).toBe("America/New_York");
  });

  it("falls back to UTC (not the default, not a throw) on an invalid value, and logs a warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(resolveTimeZone("Not/A_Real_Zone", "Asia/Jerusalem")).toBe("UTC");
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });
});
