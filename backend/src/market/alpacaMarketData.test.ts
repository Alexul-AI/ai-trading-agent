import { describe, expect, it, vi } from "vitest";

import { createAlpacaMarketData } from "./alpacaMarketData.js";
import type { AlpacaLike } from "../types/serverTypes.js";

// Scoped narrowly to getEstimatedPrice, per PR #62's plan - the rest of
// this module's functions (market clock, watchlist quotes, chart bars)
// are a separate concern for a future pass, not mixed in here.

function makeMarketData(getLatestTrade: AlpacaLike["getLatestTrade"]) {
  const alpaca = { getLatestTrade } as unknown as AlpacaLike;

  return createAlpacaMarketData({
    alpaca,
    isLiveMode: false,
    alpacaDataFeed: "iex",
    paperKeyId: "test-key",
    paperSecretKey: "test-secret",
  });
}

describe("getEstimatedPrice", () => {
  it("returns the fallback price immediately, without calling Alpaca, when it's positive", async () => {
    const getLatestTrade = vi.fn(async () => {
      throw new Error("getLatestTrade should never be called when a valid fallback is given.");
    });
    const marketData = makeMarketData(getLatestTrade);

    const price = await marketData.getEstimatedPrice("SPY", 748.15);

    expect(price).toBe(748.15);
    expect(getLatestTrade).not.toHaveBeenCalled();
  });

  it("ignores a zero or negative fallback and queries Alpaca instead", async () => {
    const getLatestTrade = vi.fn(async () => ({ p: 748.15 }));
    const marketData = makeMarketData(getLatestTrade);

    expect(await marketData.getEstimatedPrice("SPY", 0)).toBe(748.15);
    expect(await marketData.getEstimatedPrice("SPY", -5)).toBe(748.15);
    expect(getLatestTrade).toHaveBeenCalledTimes(2);
  });

  it("queries Alpaca and returns the extracted price when no fallback is given", async () => {
    const getLatestTrade = vi.fn(async () => ({ p: 748.15 }));
    const marketData = makeMarketData(getLatestTrade);

    const price = await marketData.getEstimatedPrice("SPY");

    expect(price).toBe(748.15);
    expect(getLatestTrade).toHaveBeenCalledWith("SPY");
  });

  it("throws (not a silent fake fallback) when Alpaca's quote yields a non-positive price - the documented historical bug this guards against", async () => {
    const getLatestTrade = vi.fn(async () => ({}));
    const marketData = makeMarketData(getLatestTrade);

    await expect(marketData.getEstimatedPrice("UNKNOWNTICKER")).rejects.toThrow(
      "Cannot estimate price for UNKNOWNTICKER: no valid quote from Alpaca.",
    );
  });

  it("propagates a genuine Alpaca fetch failure rather than swallowing it", async () => {
    const getLatestTrade = vi.fn(async () => {
      throw new Error("network error");
    });
    const marketData = makeMarketData(getLatestTrade);

    await expect(marketData.getEstimatedPrice("SPY")).rejects.toThrow("network error");
  });
});
