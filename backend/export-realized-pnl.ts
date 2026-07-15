import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

// Same TRADE_MODE-based key selection as server.ts:187-193, so this script
// works unchanged against the current paper account or a future live one.
// Deliberately reads the trading API directly (fetch, same per-script
// convention as every backtest-*.ts script here) instead of the
// @alpacahq/alpaca-trade-api SDK - avoids duplicating server.ts's ESM
// default-export interop shim for a script this small.
const IS_LIVE_MODE = process.env.TRADE_MODE === "live";
const APCA_API_KEY_ID = IS_LIVE_MODE
  ? (process.env.APCA_API_KEY_ID_LIVE ?? "")
  : (process.env.APCA_API_KEY_ID ?? "");
const APCA_API_SECRET_KEY = IS_LIVE_MODE
  ? (process.env.APCA_API_SECRET_KEY_LIVE ?? "")
  : (process.env.APCA_API_SECRET_KEY ?? "");
const TRADING_API_BASE = IS_LIVE_MODE
  ? "https://api.alpaca.markets"
  : "https://paper-api.alpaca.markets";

const REPORT_DIR = path.resolve(process.cwd(), "data", "tax-reports");
const TRADES_CSV_PATH = path.join(REPORT_DIR, "realized-trades.csv");
const DIVIDENDS_CSV_PATH = path.join(REPORT_DIR, "dividends.csv");
const REPORT_PATH = path.join(REPORT_DIR, "realized-pnl-report.md");

const AUTH_HEADERS = {
  "APCA-API-KEY-ID": APCA_API_KEY_ID,
  "APCA-API-SECRET-KEY": APCA_API_SECRET_KEY,
};

interface AlpacaOrderRecord {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  status: string;
  filled_qty: string;
  filled_avg_price: string | null;
  filled_at: string | null;
  submitted_at: string;
}

interface AlpacaActivityRecord {
  id: string;
  activity_type: string;
  symbol?: string;
  date?: string;
  net_amount?: string;
  qty?: string;
  per_share_amount?: string;
}

// Paginates via the last order's submitted_at as the next `after` cursor,
// deduping by order id across pages - safer than trusting timestamp
// boundaries to be exclusive/inclusive exactly right when multiple orders
// share a timestamp (plausible given the runaway-script incident on this
// account produced 1,100+ fills seconds apart - see CLAUDE.md).
async function fetchAllClosedOrders(): Promise<AlpacaOrderRecord[]> {
  const seenIds = new Set<string>();
  const orders: AlpacaOrderRecord[] = [];
  let after: string | undefined;

  for (;;) {
    const url = new URL(`${TRADING_API_BASE}/v2/orders`);
    url.searchParams.set("status", "closed");
    url.searchParams.set("direction", "asc");
    url.searchParams.set("limit", "500");
    if (after) url.searchParams.set("after", after);

    const response = await fetch(url.toString(), { headers: AUTH_HEADERS });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Alpaca orders request failed: HTTP ${response.status} ${body}`);
    }

    const page = (await response.json()) as AlpacaOrderRecord[];
    if (page.length === 0) break;

    for (const order of page) {
      if (!seenIds.has(order.id)) {
        seenIds.add(order.id);
        orders.push(order);
      }
    }

    if (page.length < 500) break;
    after = page[page.length - 1]!.submitted_at;
  }

  return orders;
}

async function fetchDividendActivities(): Promise<AlpacaActivityRecord[]> {
  const url = new URL(`${TRADING_API_BASE}/v2/account/activities`);
  url.searchParams.set("activity_types", "DIV");
  url.searchParams.set("direction", "asc");
  url.searchParams.set("page_size", "100");

  const response = await fetch(url.toString(), { headers: AUTH_HEADERS });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Alpaca activities request failed: HTTP ${response.status} ${body}`);
  }

  return (await response.json()) as AlpacaActivityRecord[];
}

export interface Fill {
  timestamp: string;
  ticker: string;
  action: "BUY" | "SELL";
  shares: number;
  price: number;
}

export interface MatchedRow {
  ticker: string;
  action: "BUY" | "SELL";
  date: string;
  shares: number;
  priceUsd: number;
  grossAmountUsd: number;
  matchedBuyDate: string | null;
  matchedBuyPriceUsd: number | null;
  realizedPnlUsd: number | null;
}

interface OpenLot {
  date: string;
  shares: number;
  price: number;
}

export interface FifoMatchResult {
  rows: MatchedRow[];
  openLotsByTicker: Map<string, OpenLot[]>;
  warnings: string[];
}

// Pure FIFO cost-basis matcher, no I/O - a documented default for this
// export, not a tax determination. Whether Israeli tax treatment of foreign
// securities requires FIFO or another method (e.g. average cost) is an
// accountant question (docs/product/ROADMAP.md Phase 0.5, items 1-3), not
// something decided here.
export function computeFifoRealizedPnl(fills: Fill[]): FifoMatchResult {
  const sorted = [...fills].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const openLotsByTicker = new Map<string, OpenLot[]>();
  const rows: MatchedRow[] = [];
  const warnings: string[] = [];

  for (const fill of sorted) {
    const date = fill.timestamp.split("T")[0] ?? fill.timestamp;

    if (fill.action === "BUY") {
      const lots = openLotsByTicker.get(fill.ticker) ?? [];
      lots.push({ date, shares: fill.shares, price: fill.price });
      openLotsByTicker.set(fill.ticker, lots);
      rows.push({
        ticker: fill.ticker,
        action: "BUY",
        date,
        shares: fill.shares,
        priceUsd: fill.price,
        grossAmountUsd: fill.shares * fill.price,
        matchedBuyDate: null,
        matchedBuyPriceUsd: null,
        realizedPnlUsd: null,
      });
      continue;
    }

    const lots = openLotsByTicker.get(fill.ticker) ?? [];
    if (lots.length === 0) {
      warnings.push(
        `${fill.ticker} ${date}: SELL of ${fill.shares} shares with no tracked open lots (position likely opened before this export's fetch window) - realized P&L for this sell could not be computed.`,
      );
    }

    let remaining = fill.shares;
    while (remaining > 0 && lots.length > 0) {
      const lot = lots[0]!;
      const matchedShares = Math.min(remaining, lot.shares);
      const realizedPnlUsd = matchedShares * (fill.price - lot.price);
      rows.push({
        ticker: fill.ticker,
        action: "SELL",
        date,
        shares: matchedShares,
        priceUsd: fill.price,
        grossAmountUsd: matchedShares * fill.price,
        matchedBuyDate: lot.date,
        matchedBuyPriceUsd: lot.price,
        realizedPnlUsd,
      });
      lot.shares -= matchedShares;
      remaining -= matchedShares;
      if (lot.shares <= 0) lots.shift();
    }

    if (remaining > 0) {
      rows.push({
        ticker: fill.ticker,
        action: "SELL",
        date,
        shares: remaining,
        priceUsd: fill.price,
        grossAmountUsd: remaining * fill.price,
        matchedBuyDate: null,
        matchedBuyPriceUsd: null,
        realizedPnlUsd: null,
      });
      warnings.push(
        `${fill.ticker} ${date}: SELL exceeded tracked open lots by ${remaining} share(s) - that portion's realized P&L could not be computed (likely a position opened before this export's fetch window).`,
      );
    }
  }

  return { rows, openLotsByTicker, warnings };
}

function csvEscape(value: string | number): string {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCsv(rows: (string | number)[][]): string {
  return `${rows.map((row) => row.map(csvEscape).join(",")).join("\n")}\n`;
}

const NON_ADVICE_NOTE =
  "FIFO cost-basis realized P&L in USD - a documented default for this export, NOT a tax determination and NOT tax advice. Israeli tax treatment of foreign securities (matching method, USD/ILS conversion date/rate) should be confirmed with a licensed accountant (docs/product/ROADMAP.md Phase 0.5) before relying on these numbers for any filing. trade_date is provided so the correct historical FX rate can be looked up separately - no conversion is computed here.";

async function main() {
  console.log(`Realized P&L export - mode: ${IS_LIVE_MODE ? "live" : "paper"}, base: ${TRADING_API_BASE}`);
  console.log(NON_ADVICE_NOTE);
  console.log("");

  const orders = await fetchAllClosedOrders();
  const filledOrders = orders.filter(
    (o) => o.status === "filled" && Number.parseFloat(o.filled_qty) > 0 && o.filled_at,
  );
  console.log(`Fetched ${orders.length} closed order(s), ${filledOrders.length} actually filled.`);

  const fills: Fill[] = filledOrders.map((o) => ({
    timestamp: o.filled_at!,
    ticker: o.symbol,
    action: o.side === "buy" ? "BUY" : "SELL",
    shares: Number.parseFloat(o.filled_qty),
    price: Number.parseFloat(o.filled_avg_price ?? "0"),
  }));

  const { rows, openLotsByTicker, warnings } = computeFifoRealizedPnl(fills);

  if (warnings.length > 0) {
    console.log("");
    console.log("=== Data-integrity warnings ===");
    for (const w of warnings) console.log(`- ${w}`);
  }

  const totalRealizedPnlUsd = rows.reduce((sum, r) => sum + (r.realizedPnlUsd ?? 0), 0);
  const openLotCount = [...openLotsByTicker.values()].reduce((sum, lots) => sum + lots.length, 0);

  console.log("");
  console.log(`Total realized P&L (USD, FIFO): ${totalRealizedPnlUsd.toFixed(2)}`);
  console.log(`Still-open lots (not yet closed): ${openLotCount}`);

  const dividendActivities = await fetchDividendActivities();
  const totalDividendsUsd = dividendActivities.reduce(
    (sum, a) => sum + Number.parseFloat(a.net_amount ?? "0"),
    0,
  );
  console.log(`Dividend activities found: ${dividendActivities.length} (total USD ${totalDividendsUsd.toFixed(2)})`);

  await fs.mkdir(REPORT_DIR, { recursive: true });

  const tradesCsvHeader = [
    "trade_date",
    "ticker",
    "action",
    "shares",
    "fill_price_usd",
    "gross_amount_usd",
    "matched_buy_date",
    "matched_buy_price_usd",
    "realized_pnl_usd",
    "cost_basis_method",
  ];
  const tradesCsvRows: (string | number)[][] = [
    tradesCsvHeader,
    // Padded to the same column count as the header, not a lone 1-column
    // row - CSV has no universal "comment row" convention, and a short row
    // mixed into an otherwise-rectangular table risks being read as a
    // malformed data row by strict parsers/accounting-software imports.
    [`# ${NON_ADVICE_NOTE}`, ...Array(tradesCsvHeader.length - 1).fill("")],
  ];
  for (const r of rows) {
    tradesCsvRows.push([
      r.date,
      r.ticker,
      r.action,
      r.shares,
      r.priceUsd.toFixed(4),
      r.grossAmountUsd.toFixed(2),
      r.matchedBuyDate ?? "n/a",
      r.matchedBuyPriceUsd !== null ? r.matchedBuyPriceUsd.toFixed(4) : "n/a",
      r.realizedPnlUsd !== null ? r.realizedPnlUsd.toFixed(2) : "n/a",
      "FIFO",
    ]);
  }
  await fs.writeFile(TRADES_CSV_PATH, toCsv(tradesCsvRows), "utf-8");
  console.log(`\nTrades CSV written to ${TRADES_CSV_PATH}`);

  const dividendCsvRows: (string | number)[][] = [
    ["date", "ticker", "shares", "per_share_amount_usd", "net_amount_usd"],
  ];
  for (const a of dividendActivities) {
    dividendCsvRows.push([
      a.date ?? "n/a",
      a.symbol ?? "n/a",
      a.qty ?? "n/a",
      a.per_share_amount ?? "n/a",
      a.net_amount ?? "0",
    ]);
  }
  await fs.writeFile(DIVIDENDS_CSV_PATH, toCsv(dividendCsvRows), "utf-8");
  console.log(`Dividends CSV written to ${DIVIDENDS_CSV_PATH}`);

  const reportMd = `# Realized P&L export report

Generated: ${new Date().toISOString()}
Mode: ${IS_LIVE_MODE ? "live" : "paper"}

## Non-advice notice
${NON_ADVICE_NOTE}

## Summary
- Closed orders fetched: ${orders.length} (${filledOrders.length} filled)
- Total realized P&L (USD, FIFO): ${totalRealizedPnlUsd.toFixed(2)}
- Still-open lots not yet closed: ${openLotCount}
- Dividend activities found: ${dividendActivities.length} (total USD ${totalDividendsUsd.toFixed(2)})

## Data-integrity warnings
${warnings.length > 0 ? warnings.map((w) => `- ${w}`).join("\n") : "_(none)_"}

## Files
- \`realized-trades.csv\` - one row per BUY fill and per FIFO-matched SELL chunk.
- \`dividends.csv\` - raw dividend activity, if any.

## What this deliberately does not do
- No USD/ILS conversion is computed - \`trade_date\` is provided so the correct historical rate can be looked up per whatever convention the accountant confirms (docs/product/ROADMAP.md Phase 0.5, item 3).
- FIFO is a documented default, not a tax election - confirm the correct matching method for Israeli tax treatment of foreign securities with a licensed accountant before relying on these numbers for any filing.
- This script performs no trades and touches no live/paper execution path - it only reads Alpaca's own order/activity history.
`;
  await fs.writeFile(REPORT_PATH, reportMd, "utf-8");
  console.log(`Report written to ${REPORT_PATH}`);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
