// Shared low-level Alpaca daily-bars fetch: pagination + sort only. Each
// caller (autopilotWorker.ts's fetchAlpacaBarsUncached, alpacaMarketData.ts's
// fetchDailyBarsForChart) keeps its own date-range/warmup-window policy and
// auth resolution - only the actually-identical HTTP+pagination+sort core
// moves here, so no warmup/date-range behavior changes for either caller.
import type { AlpacaBar, AlpacaBarsResponse } from "../types/serverTypes.js";
import { toIsoDate } from "../utils/time.js";

export interface FetchAlpacaDailyBarsParams {
  ticker: string;
  startDate: Date;
  endDate: Date;
  feed: string;
  keyId: string;
  secretKey: string;
  /** Prefix for the thrown error message on a non-ok response, e.g. "Alpaca bars" vs "Alpaca chart bars". */
  errorLabel?: string;
}

export async function fetchAlpacaDailyBarsPaginated(
  params: FetchAlpacaDailyBarsParams,
): Promise<AlpacaBar[]> {
  const { ticker, startDate, endDate, feed, keyId, secretKey, errorLabel = "Alpaca bars" } = params;
  const allBars: AlpacaBar[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`https://data.alpaca.markets/v2/stocks/${ticker}/bars`);

    url.searchParams.set("timeframe", "1Day");
    url.searchParams.set("start", toIsoDate(startDate));
    url.searchParams.set("end", toIsoDate(endDate));
    url.searchParams.set("adjustment", "raw");
    url.searchParams.set("feed", feed);
    url.searchParams.set("limit", "1000");

    if (pageToken) {
      url.searchParams.set("page_token", pageToken);
    }

    const response = await fetch(url.toString(), {
      headers: {
        "APCA-API-KEY-ID": keyId,
        "APCA-API-SECRET-KEY": secretKey,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `${errorLabel} request failed for ${ticker}: HTTP ${response.status} ${body}`,
      );
    }

    const data = (await response.json()) as AlpacaBarsResponse;

    if (data.bars) {
      allBars.push(...data.bars);
    }

    pageToken = data.next_page_token || undefined;
  } while (pageToken);

  return allBars.sort(
    (a, b) => new Date(a.t).getTime() - new Date(b.t).getTime(),
  );
}
