// SEC EDGAR service.
// Ticker -> CIK resolution, recent Form 4 (insider transactions) and
// 8-K Item 5.02 (personnel change) filings. Free, public, no API key -
// SEC only requires a descriptive User-Agent and reasonable request rates.

import { XMLParser } from "fast-xml-parser";
import type { InsiderTransaction } from "../types/serverTypes.js";

const USER_AGENT =
  process.env.SEC_EDGAR_USER_AGENT ??
  "ai-trading-agent research (github.com/Alexul-AI/ai-trading-agent)";

const TICKER_TO_CIK_URL = "https://www.sec.gov/files/company_tickers.json";

interface CompanyTickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

let cikByTickerCache: Map<string, string> | null = null;
let cikByTickerCachePromise: Promise<Map<string, string>> | null = null;

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });

  if (!response.ok) {
    throw new Error(
      `SEC EDGAR request failed: HTTP ${response.status} for ${url}`,
    );
  }

  return (await response.json()) as T;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });

  if (!response.ok) {
    throw new Error(
      `SEC EDGAR request failed: HTTP ${response.status} for ${url}`,
    );
  }

  return response.text();
}

async function loadCikMap(): Promise<Map<string, string>> {
  if (cikByTickerCache) return cikByTickerCache;

  if (!cikByTickerCachePromise) {
    cikByTickerCachePromise = fetchJson<Record<string, CompanyTickerEntry>>(
      TICKER_TO_CIK_URL,
    ).then((data) => {
      const map = new Map<string, string>();

      for (const entry of Object.values(data)) {
        map.set(
          entry.ticker.toUpperCase(),
          String(entry.cik_str).padStart(10, "0"),
        );
      }

      cikByTickerCache = map;

      return map;
    });
  }

  return cikByTickerCachePromise;
}

export async function getCikForTicker(ticker: string): Promise<string | null> {
  const map = await loadCikMap();

  return map.get(ticker.toUpperCase()) ?? null;
}

interface SecSubmissionsResponse {
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      form: string[];
      items: string[];
      primaryDocument: string[];
    };
  };
}

async function fetchSubmissions(cik: string): Promise<SecSubmissionsResponse> {
  return fetchJson<SecSubmissionsResponse>(
    `https://data.sec.gov/submissions/CIK${cik}.json`,
  );
}

const TRANSACTION_CODE_LABELS: Record<string, string> = {
  P: "Open market purchase",
  S: "Open market sale",
  A: "Grant / award",
  D: "Sale to issuer",
  F: "Tax withholding",
  M: "Option exercise",
  C: "Derivative conversion",
  G: "Gift",
  I: "Discretionary transaction",
  J: "Other",
  W: "Inherited / will",
  X: "In-the-money exercise",
};

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  isArray: (name) =>
    name === "nonDerivativeTransaction" || name === "reportingOwner",
});

interface Form4Document {
  ownershipDocument?: {
    reportingOwner?: Array<{
      reportingOwnerId?: { rptOwnerName?: string };
      reportingOwnerRelationship?: {
        isOfficer?: unknown;
        isDirector?: unknown;
        isTenPercentOwner?: unknown;
        officerTitle?: string;
      };
    }>;
    nonDerivativeTable?: {
      nonDerivativeTransaction?: Array<{
        transactionDate?: { value?: string };
        transactionCoding?: { transactionCode?: string };
        transactionAmounts?: {
          transactionShares?: { value?: unknown };
          transactionPricePerShare?: { value?: unknown };
          transactionAcquiredDisposedCode?: { value?: string };
        };
        postTransactionAmounts?: {
          sharesOwnedFollowingTransaction?: { value?: unknown };
        };
      }>;
    };
  };
}

function toNumberOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;

  const num = Number(value);

  return Number.isFinite(num) ? num : null;
}

export function parseForm4Xml(
  xml: string,
  filingUrl: string,
): InsiderTransaction[] {
  const parsed = xmlParser.parse(xml) as Form4Document;
  const doc = parsed.ownershipDocument;

  if (!doc) return [];

  const owner = doc.reportingOwner?.[0];
  const ownerName = owner?.reportingOwnerId?.rptOwnerName ?? "Unknown";
  const relationship = owner?.reportingOwnerRelationship;

  const isOfficer = String(relationship?.isOfficer) === "true";
  const isDirector = String(relationship?.isDirector) === "true";
  const isTenPercentOwner = String(relationship?.isTenPercentOwner) === "true";

  const title =
    (isOfficer && relationship?.officerTitle) ||
    (isDirector && "Director") ||
    (isTenPercentOwner && "10% owner") ||
    "Reporting person";

  const transactions = doc.nonDerivativeTable?.nonDerivativeTransaction ?? [];

  return transactions.map((tx) => {
    const code = tx.transactionCoding?.transactionCode ?? "";
    const acquiredOrDisposed =
      (tx.transactionAmounts?.transactionAcquiredDisposedCode?.value as
        | "A"
        | "D"
        | undefined) ?? "A";

    return {
      reportingOwnerName: ownerName,
      title: String(title),
      transactionDate: tx.transactionDate?.value ?? "",
      transactionCode: code,
      transactionCodeLabel: TRANSACTION_CODE_LABELS[code] ?? code,
      isOpenMarket: code === "P" || code === "S",
      shares:
        toNumberOrNull(tx.transactionAmounts?.transactionShares?.value) ?? 0,
      pricePerShare: toNumberOrNull(
        tx.transactionAmounts?.transactionPricePerShare?.value,
      ),
      acquiredOrDisposed,
      sharesOwnedAfter: toNumberOrNull(
        tx.postTransactionAmounts?.sharesOwnedFollowingTransaction?.value,
      ),
      filingUrl,
    };
  });
}

export async function getRecentInsiderTransactions(
  ticker: string,
  filingLimit = 6,
): Promise<InsiderTransaction[]> {
  const cik = await getCikForTicker(ticker);

  if (!cik) throw new Error(`No SEC CIK found for ${ticker}.`);

  const submissions = await fetchSubmissions(cik);
  const recent = submissions.filings.recent;
  const cikNoLeadingZeros = String(Number(cik));

  const form4Indices = recent.form
    .map((form, index) => ({ form, index }))
    .filter((entry) => entry.form === "4")
    .slice(0, filingLimit);

  const results: InsiderTransaction[] = [];

  for (const { index } of form4Indices) {
    const accessionNumber = recent.accessionNumber[index];
    const primaryDocument = recent.primaryDocument[index];

    if (!accessionNumber || !primaryDocument) continue;

    const accessionNoDashes = accessionNumber.replace(/-/g, "");
    const rawFileName = primaryDocument.split("/").pop() ?? primaryDocument;
    const filingRoot = `https://www.sec.gov/Archives/edgar/data/${cikNoLeadingZeros}/${accessionNoDashes}`;

    try {
      const xml = await fetchText(`${filingRoot}/${rawFileName}`);
      const viewUrl = `${filingRoot}/${primaryDocument}`;

      results.push(...parseForm4Xml(xml, viewUrl));
    } catch (error) {
      console.warn(
        `[SEC] Failed to parse Form 4 ${accessionNumber} for ${ticker}:`,
        error,
      );
    }
  }

  return results.sort((a, b) =>
    b.transactionDate.localeCompare(a.transactionDate),
  );
}

export interface RawPersonnelFiling {
  filingDate: string;
  itemCodes: string;
  filingUrl: string;
  rawText: string;
}

export async function getRecentPersonnelFilings(
  ticker: string,
  limit = 3,
): Promise<RawPersonnelFiling[]> {
  const cik = await getCikForTicker(ticker);

  if (!cik) throw new Error(`No SEC CIK found for ${ticker}.`);

  const submissions = await fetchSubmissions(cik);
  const recent = submissions.filings.recent;
  const cikNoLeadingZeros = String(Number(cik));

  const filingIndices = recent.form
    .map((form, index) => ({ form, index }))
    .filter(
      (entry) =>
        entry.form === "8-K" &&
        (recent.items[entry.index] ?? "").split(",").includes("5.02"),
    )
    .slice(0, limit);

  const results: RawPersonnelFiling[] = [];

  for (const { index } of filingIndices) {
    const accessionNumber = recent.accessionNumber[index];
    const primaryDocument = recent.primaryDocument[index];

    if (!accessionNumber || !primaryDocument) continue;

    const accessionNoDashes = accessionNumber.replace(/-/g, "");
    const filingUrl = `https://www.sec.gov/Archives/edgar/data/${cikNoLeadingZeros}/${accessionNoDashes}/${primaryDocument}`;

    try {
      const html = await fetchText(filingUrl);
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&#\d+;/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();

      const itemIndex = text.indexOf("Item 5.02");
      const excerpt =
        itemIndex >= 0
          ? text.slice(itemIndex, itemIndex + 3000)
          : text.slice(0, 3000);

      results.push({
        filingDate: recent.filingDate[index] ?? "",
        itemCodes: recent.items[index] ?? "",
        filingUrl,
        rawText: excerpt,
      });
    } catch (error) {
      console.warn(
        `[SEC] Failed to fetch 8-K ${accessionNumber} for ${ticker}:`,
        error,
      );
    }
  }

  return results;
}
