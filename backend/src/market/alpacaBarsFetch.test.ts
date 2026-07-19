import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchAlpacaDailyBarsPaginated } from "./alpacaBarsFetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function bar(dateKey: string, close: number) {
  return { t: `${dateKey}T00:00:00Z`, o: close, h: close, l: close, c: close, v: 1 };
}

describe("fetchAlpacaDailyBarsPaginated", () => {
  it("follows next_page_token across pages and returns bars sorted ascending by date", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ bars: [bar("2026-01-02", 101)], next_page_token: "p2" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ bars: [bar("2026-01-01", 100)], next_page_token: null }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchAlpacaDailyBarsPaginated({
      ticker: "SPY",
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-01-02"),
      feed: "iex",
      keyId: "key",
      secretKey: "secret",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bars.map((b) => b.t)).toEqual(["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"]);
    expect(new URL(fetchMock.mock.calls[1]![0] as string).searchParams.get("page_token")).toBe("p2");
  });

  it("throws a labeled error on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" }),
    );

    await expect(
      fetchAlpacaDailyBarsPaginated({
        ticker: "SPY",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-01-02"),
        feed: "iex",
        keyId: "key",
        secretKey: "secret",
        errorLabel: "Alpaca chart bars",
      }),
    ).rejects.toThrow("Alpaca chart bars request failed for SPY: HTTP 500 boom");
  });
});
