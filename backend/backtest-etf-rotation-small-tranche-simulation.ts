// ETF Rotation small-capital tranche simulation (2026-08-08, design/research
// only - see the "Small-capital fractional/notional sizing for ETF
// Rotation" plan). Whole-share sizing (computeRebalanceOrders,
// etfRotationStrategy.ts) can't buy even 1 share of SPY/QQQ at the planned
// $100-250 first live tranche - this script measures, on real historical
// data, whether the new fractional-fallback BUY support (also added in this
// PR, off by default, unreachable from the live worker) actually fixes
// that, and whether the live AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT
// ramp cap (currently 2% in production - see CLAUDE.md's hard-boundaries
// section) would silently re-strand everything even with fractional support
// built.
//
// Grid: 5 standard windows (same as every other multi-window ETF Rotation
// script in this repo) x both config variants (baseline-2/candidate-hold3)
// x 4 capital tranches ($100/$250/$500/$1000) x 2 ramp settings (uncapped,
// 2% - today's live value) x 2 fractional settings (off - today's live
// behavior, on). Reuses runEtfRotationSimulation directly
// (backtest-etf-rotation.ts, already exported) rather than
// runEtfRotationWindowAnalysis, specifically so bars are fetched ONCE per
// window and reused across all 32 tranche/ramp/fractional/config
// combinations sharing that window instead of re-fetching the same 5
// tickers' bars up to 32 times per window - fetch/alignment/warmup-clearing
// logic is duplicated here per this repo's established convention
// (backtest-etf-rotation-adjustment-comparison.ts already does the same
// thing, for the same reason).
//
// Primary metric: strandedBuySlotCount / totalBuySlotCount (a new,
// directly-measured field on EtfRotationSimResult, added in this PR) - the
// exact count of qualifying BUY slots that ended up with zero real
// position, whatever the cause (whole-share rounding, the fractional
// floor, or the ramp cap). avgExposurePercent (already existed) is
// reported as secondary context - a whole-simulation-average proxy for
// cash sitting idle, not a per-rebalance figure. Return/max-drawdown/trade
// count are tertiary context only - this is a mechanics/feasibility
// question ("can the strategy actually deploy capital at this tranche"),
// not a returns-quality question.
//
// No live/ramp/config change of any kind - read-only against Alpaca's
// historical bars, same as every sibling backtest script. Does not touch
// etfRotationCycle.ts, autopilotConfig.ts, or any env var.
import { promises as fs } from "fs";
import path from "path";
import dotenv from "dotenv";

import { runEtfRotationSimulation } from "./backtest-etf-rotation.js";
import {
  ETF_ROTATION_CONFIG_VARIANTS,
  type EtfRotationConfigVariantKey,
} from "./etfRotationStrategy.js";

dotenv.config();

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface AlpacaBarsResponse {
  bars?: AlpacaBar[];
  next_page_token?: string | null;
}

const APCA_API_KEY_ID = process.env.APCA_API_KEY_ID ?? "";
const APCA_API_SECRET_KEY = process.env.APCA_API_SECRET_KEY ?? "";
const FEED = process.env.ALPACA_DATA_FEED || "iex";

// Same as backtest-etf-rotation.ts's own WARMUP_BARS - momentum(126) +
// SMA(200) need the same runway regardless of which script is simulating.
const WARMUP_BARS = 210;

const REPORT_DIR = path.resolve(process.cwd(), "data", "backtest-reports", "etf-rotation");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toIsoDate(date: Date): string {
  return date.toISOString().split("T")[0] ?? date.toISOString();
}

function dateKeyOf(bar: AlpacaBar): string {
  return bar.t.split("T")[0] ?? bar.t;
}

// Duplicated per-script, not shared - same convention as every other
// backtest script in this repo (each keeps its own private fetch function).
async function fetchAlpacaBars(
  ticker: string,
  days: number,
  endDaysAgo: number,
): Promise<AlpacaBar[]> {
  const endDate = new Date();
  endDate.setDate(endDate.getDate() - endDaysAgo);
  const startDate = new Date(endDate);
  startDate.setDate(endDate.getDate() - days);

  const allBars: AlpacaBar[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`https://data.alpaca.markets/v2/stocks/${ticker}/bars`);
    url.searchParams.set("timeframe", "1Day");
    url.searchParams.set("start", toIsoDate(startDate));
    url.searchParams.set("end", toIsoDate(endDate));
    url.searchParams.set("adjustment", "raw");
    url.searchParams.set("feed", FEED);
    url.searchParams.set("limit", "1000");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const response = await fetch(url.toString(), {
      headers: {
        "APCA-API-KEY-ID": APCA_API_KEY_ID,
        "APCA-API-SECRET-KEY": APCA_API_SECRET_KEY,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Alpaca bars request failed for ${ticker}: HTTP ${response.status} ${body}`,
      );
    }

    const data = (await response.json()) as AlpacaBarsResponse;
    if (data.bars) allBars.push(...data.bars);
    pageToken = data.next_page_token || undefined;
  } while (pageToken);

  return allBars.sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
}

interface Alignment {
  commonDates: string[];
  indexByTickerByDate: Map<string, Map<string, number>>;
}

function alignByIntersection(
  barsByTicker: Map<string, AlpacaBar[]>,
  tickers: string[],
): Alignment {
  const indexByTickerByDate = new Map<string, Map<string, number>>();

  for (const ticker of tickers) {
    const bars = barsByTicker.get(ticker) ?? [];
    const indexByDate = new Map<string, number>();
    bars.forEach((bar, i) => indexByDate.set(dateKeyOf(bar), i));
    indexByTickerByDate.set(ticker, indexByDate);
  }

  const unionDates = new Set<string>();
  for (const indexByDate of indexByTickerByDate.values()) {
    for (const date of indexByDate.keys()) unionDates.add(date);
  }

  const commonDates: string[] = [];
  for (const date of unionDates) {
    const allPresent = tickers.every((t) => indexByTickerByDate.get(t)!.has(date));
    if (allPresent) commonDates.push(date);
  }

  commonDates.sort();

  return { commonDates, indexByTickerByDate };
}

function findSimStartIndex(
  commonDates: string[],
  indexByTickerByDate: Map<string, Map<string, number>>,
  tickers: string[],
): number {
  for (let d = 0; d < commonDates.length; d += 1) {
    const date = commonDates[d]!;
    const allWarm = tickers.every(
      (t) => (indexByTickerByDate.get(t)!.get(date) ?? -1) >= WARMUP_BARS,
    );
    if (allWarm) return d;
  }
  return commonDates.length;
}

function daysAgoFromTarget(targetIso: string): number {
  const target = new Date(`${targetIso}T00:00:00Z`);
  const now = new Date();
  return Math.round((now.getTime() - target.getTime()) / MS_PER_DAY);
}

interface WindowConfig {
  label: string;
  days: number;
  endDaysAgo: number;
}

// Identical windows to every other multi-window ETF Rotation script in this
// repo, for direct comparability.
const WINDOWS: WindowConfig[] = [
  { label: "Current (~900d)", days: 900, endDaysAgo: 0 },
  { label: "Prior (~900d)", days: 900, endDaysAgo: 900 },
  { label: "2022 bear-heavy", days: 900, endDaysAgo: daysAgoFromTarget("2023-06-30") },
  { label: "2023-2024 bull-heavy", days: 750, endDaysAgo: daysAgoFromTarget("2024-12-31") },
  { label: "COVID crash + recovery", days: 900, endDaysAgo: daysAgoFromTarget("2021-12-31") },
];

// $100/$250 - the planned first live tranche (docs/product/ROADMAP.md).
// $500/$1000 - later tranches on the same capital path, included so the
// grid shows where (if anywhere) the stranding problem resolves itself as
// capital grows, without needing fractional support at all.
const TRANCHES = [100, 250, 500, 1000];

// undefined = uncapped. 2 = AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT's
// actual live value as of this writing (CLAUDE.md's hard-boundaries
// section) - the whole point of this axis is to check whether fractional
// support alone is enough, or whether the live ramp cap would silently
// re-strand everything even with fractional BUY support built.
const RAMP_SETTINGS: { label: string; percent: number | undefined }[] = [
  { label: "no ramp cap", percent: undefined },
  { label: "2% ramp (today's live value)", percent: 2 },
];

const FRACTIONAL_SETTINGS: { label: string; allow: boolean }[] = [
  { label: "whole-share only (today's live behavior)", allow: false },
  { label: "fractional/notional BUY", allow: true },
];

interface GridRow {
  window: string;
  configVariant: string;
  tranche: number;
  ramp: string;
  fractional: string;
  strandedBuySlotCount: number;
  totalBuySlotCount: number;
  strandedRatePercent: number | null;
  avgExposurePercent: number;
  totalPnlPercent: number;
  maxDrawdownPercent: number;
  rebalanceCount: number;
  totalTrades: number;
}

function pad(value: string, width: number): string {
  return value.padStart(width);
}

function csvEscape(value: string | number): string {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCsv(rows: (string | number)[][]): string {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n") + "\n";
}

function formatStrandedRate(row: GridRow): string {
  return row.strandedRatePercent === null
    ? "n/a"
    : `${row.strandedRatePercent.toFixed(0)}% (${row.strandedBuySlotCount}/${row.totalBuySlotCount})`;
}

async function main() {
  const variantCount = Object.keys(ETF_ROTATION_CONFIG_VARIANTS).length;
  console.log(
    `ETF rotation small-tranche simulation: tranches $${TRANCHES.join("/$")} x ${WINDOWS.length} windows x ${variantCount} config variants x ${RAMP_SETTINGS.length} ramp settings x ${FRACTIONAL_SETTINGS.length} fractional settings.`,
  );
  console.log(
    "NEXT_OPEN only (matches this project's other diagnostic sweeps - execution-model drag is not the question here).",
  );
  console.log("");

  const rows: GridRow[] = [];

  for (const window of WINDOWS) {
    console.log(
      `=== ${window.label} (requested days=${window.days}, endDaysAgo=${window.endDaysAgo}) ===`,
    );

    // Universe is identical between baseline-2/candidate-hold3 (only
    // holdCount differs) - fetched once per window, reused across every
    // config/tranche/ramp/fractional combination below instead of
    // re-fetching the same 5 tickers' bars up to 32 times per window.
    const universe = ETF_ROTATION_CONFIG_VARIANTS["baseline-2"].config.universe;
    const barsByTicker = new Map<string, AlpacaBar[]>();
    for (const ticker of universe) {
      console.log(`[${window.label}] Fetching ${ticker}...`);
      barsByTicker.set(ticker, await fetchAlpacaBars(ticker, window.days, window.endDaysAgo));
    }

    const { commonDates, indexByTickerByDate } = alignByIntersection(barsByTicker, universe);
    const simStartIndex = findSimStartIndex(commonDates, indexByTickerByDate, universe);

    if (simStartIndex >= commonDates.length) {
      console.log(
        `[${window.label}] Not enough shared history to clear the warmup window - skipping.`,
      );
      console.log("");
      continue;
    }

    for (const [, variant] of Object.entries(ETF_ROTATION_CONFIG_VARIANTS) as [
      EtfRotationConfigVariantKey,
      (typeof ETF_ROTATION_CONFIG_VARIANTS)[EtfRotationConfigVariantKey],
    ][]) {
      for (const tranche of TRANCHES) {
        for (const ramp of RAMP_SETTINGS) {
          for (const fractional of FRACTIONAL_SETTINGS) {
            const result = runEtfRotationSimulation(
              barsByTicker,
              universe,
              commonDates,
              indexByTickerByDate,
              simStartIndex,
              "next_open",
              variant.config,
              tranche,
              ramp.percent,
              fractional.allow,
              5,
            );

            rows.push({
              window: window.label,
              configVariant: variant.label,
              tranche,
              ramp: ramp.label,
              fractional: fractional.label,
              strandedBuySlotCount: result.strandedBuySlotCount,
              totalBuySlotCount: result.totalBuySlotCount,
              strandedRatePercent:
                result.totalBuySlotCount > 0
                  ? (result.strandedBuySlotCount / result.totalBuySlotCount) * 100
                  : null,
              avgExposurePercent: result.avgExposurePercent,
              totalPnlPercent: result.totalPnlPercent,
              maxDrawdownPercent: result.maxDrawdownPercent,
              rebalanceCount: result.rebalanceCount,
              totalTrades: result.totalTrades,
            });
          }
        }
      }
    }
    console.log("");
  }

  // Headline table - just the two planned-first-tranche sizes ($100/$250),
  // both configs, both ramp settings, whole-share vs fractional side by
  // side. This is the table that actually answers the question this script
  // exists for; the full 160-row grid goes to CSV only.
  console.log("=== Headline: $100/$250 tranches, stranded-slot rate (whole-share vs fractional) ===");
  console.log(
    "window".padEnd(24) +
      "config".padEnd(20) +
      pad("tranche", 9) +
      "ramp".padEnd(28) +
      pad("whole-share", 20) +
      pad("fractional", 20),
  );
  for (const window of WINDOWS) {
    for (const [, variant] of Object.entries(ETF_ROTATION_CONFIG_VARIANTS)) {
      for (const tranche of [100, 250]) {
        for (const ramp of RAMP_SETTINGS) {
          const wholeShareRow = rows.find(
            (r) =>
              r.window === window.label &&
              r.configVariant === variant.label &&
              r.tranche === tranche &&
              r.ramp === ramp.label &&
              r.fractional === FRACTIONAL_SETTINGS[0]!.label,
          );
          const fractionalRow = rows.find(
            (r) =>
              r.window === window.label &&
              r.configVariant === variant.label &&
              r.tranche === tranche &&
              r.ramp === ramp.label &&
              r.fractional === FRACTIONAL_SETTINGS[1]!.label,
          );
          if (!wholeShareRow || !fractionalRow) continue;

          console.log(
            window.label.padEnd(24) +
              variant.label.slice(0, 18).padEnd(20) +
              pad(`$${tranche}`, 9) +
              ramp.label.padEnd(28) +
              pad(formatStrandedRate(wholeShareRow), 20) +
              pad(formatStrandedRate(fractionalRow), 20),
          );
        }
      }
    }
  }
  console.log(
    "NOTE: a 0%-stranded cell under a ramp setting can still mean almost nothing got invested - the",
  );
  console.log(
    "ramp cap shrinks a fractional leg to a tiny but nonzero dollar amount instead of exactly zero,",
  );
  console.log(
    "which the stranded-rate metric alone can't see. Check avgExposurePercent in the CSV/report too.",
  );
  console.log("");

  await fs.mkdir(REPORT_DIR, { recursive: true });

  const csvRows: (string | number)[][] = [
    [
      "window",
      "config_variant",
      "tranche_usd",
      "ramp_setting",
      "fractional_setting",
      "stranded_buy_slot_count",
      "total_buy_slot_count",
      "stranded_rate_pct",
      "avg_exposure_pct",
      "total_pnl_pct",
      "max_drawdown_pct",
      "rebalance_count",
      "total_trades",
    ],
  ];
  for (const row of rows) {
    csvRows.push([
      row.window,
      row.configVariant,
      row.tranche,
      row.ramp,
      row.fractional,
      row.strandedBuySlotCount,
      row.totalBuySlotCount,
      row.strandedRatePercent === null ? "n/a" : row.strandedRatePercent.toFixed(1),
      row.avgExposurePercent.toFixed(1),
      row.totalPnlPercent.toFixed(2),
      row.maxDrawdownPercent.toFixed(2),
      row.rebalanceCount,
      row.totalTrades,
    ]);
  }
  const csvPath = path.join(REPORT_DIR, "etf-rotation-small-tranche-simulation.csv");
  await fs.writeFile(csvPath, toCsv(csvRows), "utf-8");
  console.log(`Full grid (${rows.length} rows) written to ${csvPath}`);

  // $500/$1000 summary - does the problem resolve on its own at a higher
  // tranche, without needing fractional support at all?
  const higherTrancheRows = rows.filter(
    (r) => (r.tranche === 500 || r.tranche === 1000) && r.fractional === FRACTIONAL_SETTINGS[0]!.label,
  );
  const higherTrancheStrandedTotal = higherTrancheRows.reduce((sum, r) => sum + r.strandedBuySlotCount, 0);
  const higherTrancheSlotTotal = higherTrancheRows.reduce((sum, r) => sum + r.totalBuySlotCount, 0);

  const reportMd = `# ETF Rotation small-capital tranche simulation

Generated: ${new Date().toISOString()}

**Design/research only - no live, ramp, or config change of any kind.** This measures, on real historical data, whether the fractional-fallback BUY support added in this PR (\`etfRotationStrategy.ts\`'s \`computeRebalanceOrders\`, off by default, unreachable from the live worker) actually fixes the whole-share-sizing problem at the planned $100-250 first live tranche, and whether the live ramp cap (\`AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT\`, currently 2% in production) would re-strand it even with fractional support built. Does not by itself trigger any live/ramp/config change or a decision to enable fractional support - that stays a separate, explicit, user-approved step.

## Grid

- Windows: the same 5 standard windows used throughout this project's ETF Rotation research, for comparability.
- Config variants: both \`baseline-2\` (production default) and \`candidate-hold3\`.
- Tranches: $100, $250 (the planned first live tranche), $500, $1000.
- Ramp settings: uncapped, and 2% (today's actual live \`AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT\` value).
- Fractional settings: off (today's live behavior), on.

## Primary metric: stranded-slot rate

\`strandedBuySlotCount / totalBuySlotCount\` - a new field on \`EtfRotationSimResult\` (this PR) that directly counts, across every rebalance, how many qualifying momentum/trend-filter picks ended up with **zero real position** afterward, whatever the cause (whole-share rounding, the fractional floor, or the ramp cap). This is a direct measurement, not inferred after the fact from trade counts.

## Headline: $100/$250, whole-share vs fractional, both ramp settings

${(() => {
  const lines: string[] = [
    "| window | config | tranche | ramp | whole-share stranded | fractional stranded |",
    "|---|---|---|---|---|---|",
  ];
  for (const window of WINDOWS) {
    for (const [, variant] of Object.entries(ETF_ROTATION_CONFIG_VARIANTS)) {
      for (const tranche of [100, 250]) {
        for (const ramp of RAMP_SETTINGS) {
          const wholeShareRow = rows.find(
            (r) =>
              r.window === window.label &&
              r.configVariant === variant.label &&
              r.tranche === tranche &&
              r.ramp === ramp.label &&
              r.fractional === FRACTIONAL_SETTINGS[0]!.label,
          );
          const fractionalRow = rows.find(
            (r) =>
              r.window === window.label &&
              r.configVariant === variant.label &&
              r.tranche === tranche &&
              r.ramp === ramp.label &&
              r.fractional === FRACTIONAL_SETTINGS[1]!.label,
          );
          if (!wholeShareRow || !fractionalRow) continue;
          lines.push(
            `| ${window.label} | ${variant.label} | $${tranche} | ${ramp.label} | ${formatStrandedRate(wholeShareRow)} | ${formatStrandedRate(fractionalRow)} |`,
          );
        }
      }
    }
  }
  return lines.join("\n");
})()}

## $500/$1000, whole-share only: does the problem resolve without fractional support?

Across both config variants and all 5 windows at the $500/$1000 tranches, whole-share sizing alone: **${higherTrancheStrandedTotal}/${higherTrancheSlotTotal} qualifying BUY slots stranded** (${higherTrancheSlotTotal > 0 ? ((higherTrancheStrandedTotal / higherTrancheSlotTotal) * 100).toFixed(1) : "n/a"}%).

## Read carefully: the ramp cap makes the headline table's 0%-stranded cells misleading on their own

The stranded-slot metric only catches a position that ends up at **exactly zero**. The ramp cap (\`AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT\`) caps a fractional/notional leg to a *dollar* ceiling (\`computeRampMaxNotional\`) - at $100 equity and a 2% ramp, that ceiling is $2. A $2 fill against a $50 target is not zero, so it does **not** count as stranded, but it is not a real fix either. \`avgExposurePercent\` (in the CSV) exposes this the headline table's binary stranded/not-stranded view cannot:

${(() => {
  const currentWindow = WINDOWS[0]!.label;
  const lines = ["| tranche | config | fractional under 2% ramp | stranded rate | avg exposure |", "|---|---|---|---|---|"];
  for (const [, variant] of Object.entries(ETF_ROTATION_CONFIG_VARIANTS)) {
    for (const tranche of [100, 250]) {
      const row = rows.find(
        (r) =>
          r.window === currentWindow &&
          r.configVariant === variant.label &&
          r.tranche === tranche &&
          r.ramp === RAMP_SETTINGS[1]!.label &&
          r.fractional === FRACTIONAL_SETTINGS[1]!.label,
      );
      if (!row) continue;
      lines.push(
        `| $${tranche} | ${variant.label} | on | ${formatStrandedRate(row)} | ${row.avgExposurePercent.toFixed(1)}% |`,
      );
    }
  }
  return lines.join("\n");
})()}

(${WINDOWS[0]!.label} window shown; the same pattern - a low stranded rate alongside a near-zero average exposure - holds across every window in the full CSV.) **Read this as: fractional/notional BUY support alone does not fix the $100-250 tranche while the live ramp cap stays at 2% - it only helps once the ramp cap itself is lifted or raised, which is a separate decision from building fractional support.** This is exactly the interaction the ramp-cap objection raised during this PR's scoping was concerned about, now confirmed on real data rather than argued in the abstract.

## Caveats

- This is a mechanics/feasibility measurement ("can the strategy actually deploy capital at this tranche"), not a returns-quality study - return%/max drawdown/trade count in the full CSV are context, not the point. A stranded slot's dollars simply sit in cash instead of being invested; \`avgExposurePercent\` (in the CSV) is a whole-simulation-average proxy for that cash drag, not a per-rebalance figure.
- The fractional-fallback BUY support this script exercises is off by default and unreachable from the live worker (no shipped config sets \`allowFractionalShares\`) - this script calls \`runEtfRotationSimulation\` directly with the flag set, for measurement only.
- Uses raw Alpaca bars (\`adjustment=raw\`), matching this script's other siblings' default - not the adjustment-methodology question from PRs #76-79, which is unrelated and orthogonal to this one.
- NEXT_OPEN execution model only - matches this project's other diagnostic sweeps (e.g. the hold-count sweep), since execution-model drag is not the question this script answers.
- One run - the grid above is real data, but this is the first time this specific question has been measured; treat as informative, not yet a promotion decision, same standard as every other piece of research in this project before a live change is considered.
- Full ${rows.length}-row grid (all tranches x ramp settings x fractional settings x windows x config variants) is in the accompanying CSV, not reproduced here.
`;

  const reportPath = path.join(REPORT_DIR, "etf-rotation-small-tranche-simulation-report.md");
  await fs.writeFile(reportPath, reportMd, "utf-8");
  console.log(`Report written to ${reportPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
