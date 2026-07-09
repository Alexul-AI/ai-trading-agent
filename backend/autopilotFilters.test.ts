import { describe, expect, it } from "vitest";

import {
  evaluateInsiderVeto,
  evaluateSentimentVeto,
} from "./autopilotWorker.js";

describe("evaluateSentimentVeto", () => {
  it("blocks on BEARISH sentiment", () => {
    const result = evaluateSentimentVeto("AAPL", "BEARISH", "bad earnings");

    expect(result.blocked).toBe(true);
    expect(result.note).toContain("BEARISH");
    expect(result.note).toContain("bad earnings");
  });

  it("does not block on BULLISH sentiment", () => {
    const result = evaluateSentimentVeto("AAPL", "BULLISH", "good news");

    expect(result.blocked).toBe(false);
  });

  it("does not block on NEUTRAL sentiment", () => {
    const result = evaluateSentimentVeto("AAPL", "NEUTRAL", "no strong news");

    expect(result.blocked).toBe(false);
  });
});

describe("evaluateInsiderVeto", () => {
  it("blocks on a sell cluster (2+) with zero offsetting buys", () => {
    const result = evaluateInsiderVeto("AAPL", 0, 2);

    expect(result.blocked).toBe(true);
    expect(result.note).toContain("2 open-market insider sells");
  });

  it("does not block on a single sale (weak/noisy signal)", () => {
    const result = evaluateInsiderVeto("AAPL", 0, 1);

    expect(result.blocked).toBe(false);
  });

  it("does not block when there is at least one offsetting buy", () => {
    const result = evaluateInsiderVeto("AAPL", 1, 3);

    expect(result.blocked).toBe(false);
  });

  it("does not block when there are no insider transactions at all", () => {
    const result = evaluateInsiderVeto("AAPL", 0, 0);

    expect(result.blocked).toBe(false);
  });
});
