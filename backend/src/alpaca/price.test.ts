import { describe, expect, it } from "vitest";

import { extractAlpacaPrice } from "./price.js";

describe("extractAlpacaPrice", () => {
  it("tries fields in priority order: Price, price, p, P, close, c", () => {
    expect(extractAlpacaPrice({ Price: 1, price: 2, p: 3, P: 4, close: 5, c: 6 })).toBe(1);
    expect(extractAlpacaPrice({ price: 2, p: 3, P: 4, close: 5, c: 6 })).toBe(2);
    expect(extractAlpacaPrice({ p: 3, P: 4, close: 5, c: 6 })).toBe(3);
    expect(extractAlpacaPrice({ P: 4, close: 5, c: 6 })).toBe(4);
    expect(extractAlpacaPrice({ close: 5, c: 6 })).toBe(5);
    expect(extractAlpacaPrice({ c: 6 })).toBe(6);
  });

  it("falls through a zero or negative higher-priority field to the next one", () => {
    expect(extractAlpacaPrice({ Price: 0, price: 150.25 })).toBe(150.25);
    expect(extractAlpacaPrice({ Price: -10, price: 150.25 })).toBe(150.25);
  });

  it("falls through a missing/non-numeric higher-priority field to the next one", () => {
    expect(extractAlpacaPrice({ Price: "not a number", price: 150.25 })).toBe(150.25);
    expect(extractAlpacaPrice({ Price: null, price: 150.25 })).toBe(150.25);
  });

  it("accepts a numeric string, matching toNumber's contract", () => {
    expect(extractAlpacaPrice({ p: "742.50" })).toBe(742.5);
  });

  it("returns 0 when every field is missing, zero, negative, or unparseable", () => {
    expect(extractAlpacaPrice({})).toBe(0);
    expect(extractAlpacaPrice({ Price: 0, price: -1, p: "nope" })).toBe(0);
  });

  it("returns 0 for non-object input instead of throwing", () => {
    expect(extractAlpacaPrice(null)).toBe(0);
    expect(extractAlpacaPrice(undefined)).toBe(0);
    expect(extractAlpacaPrice("not an object")).toBe(0);
    expect(extractAlpacaPrice(42)).toBe(0);
  });

  it("matches Alpaca's real latest-trade shape (lowercase p) and bar shape (lowercase c)", () => {
    expect(extractAlpacaPrice({ t: "2026-08-04T00:00:00Z", p: 748.15, s: 10 })).toBe(748.15);
    expect(extractAlpacaPrice({ t: "2026-08-04T00:00:00Z", o: 747, h: 749, l: 746, c: 748.15, v: 1000 })).toBe(748.15);
  });
});
