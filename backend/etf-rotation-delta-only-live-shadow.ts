// ETF Rotation delta-only live-portfolio shadow (2026-08-12, read-only,
// research-only) - the agreed next step after PR #83 (backtest feasibility)
// and PR #84 (live-semantics design spec). Answers a different question
// than either of those: given the REAL current Alpaca portfolio and the
// REAL targets the live full-liquidate cycle already decided this month,
// what would computeDeltaRebalanceOrders (etfRotationStrategy.ts) have done
// differently, at thresholds [0,1,2,5]%? A one-cycle counterfactual against
// the real (full-liquidate-managed) portfolio - NOT a compounding
// delta-only-only simulation (that question is already answered by PR #83's
// own backtest grid).
//
// Design points agreed during scoping, each with a concrete reason:
// 1. Targets are read from the real, already-persisted live decision (via
//    the public GET /api/autopilot/etf-rotation/review endpoint - see
//    below), never recomputed independently. Recomputing momentum/SMA here
//    could drift from what the live cycle actually saw (a different bar
//    forming), which would contaminate "mechanism differs" with "signal
//    differs" - this shadow must hold the signal constant and vary only the
//    rebalance mechanism.
// 2. One-cycle counterfactual, not a running simulation - every observation
//    starts from whatever the real full-liquidate-managed portfolio
//    actually holds that day, not an accumulated delta-only history.
// 3. Only the active live config variant (configVariantKey from real state)
//    - candidate-hold3 has no real live-decided signal to hold constant.
// 4. All 4 thresholds [0,1,2,5]% per observation, matching PR #83 - no
//    picking a "winner" threshold ahead of evidence.
// 5. A real off-target gap (e.g. a missing BUY leg) is read as-is, not
//    special-cased - computeDeltaRebalanceOrders naturally computes a
//    full-target BUY for a ticker currently at 0 shares (delta = target -
//    0), the same magnitude a fresh full-liquidate rebuild would.
// 6. Uses PR #84's proposed legType vocabulary (increase_target/
//    decrease_target/open_new/exit_removed) read-only and dormant here -
//    this is NOT etfRotationOrderAuditLog.ts's real deriveLegType and does
//    not touch the real audit log.
//
// Key infra point: etf-rotation-worker-state.json lives on Render's
// persistent disk, not in git - a GitHub-hosted script cannot read it as a
// local file. The already-deployed, PUBLIC (not behind requireAdminToken -
// confirmed by reading server.ts directly) GET /api/autopilot/etf-rotation/review
// already returns everything needed (status, rebalanceMonthKey,
// configVariantKey, targets, plannedOrders, real positions/cash/equity) in
// one HTTPS call - no new live endpoint, no server.ts change of any kind.
//
// No live/execution/config change - this script never calls executeSafeTrade,
// the repair endpoint, or any order-submission code. Does not touch
// etfRotationCycle.ts, etfRotationExecution.ts, etfRotationReview.ts,
// etfRotationRepair.ts, etfRotationOrderAuditLog.ts, or any env var.
import { promises as fs } from "fs";
import path from "path";
import dotenv from "dotenv";

import {
  computeDeltaRebalanceOrders,
  ETF_ROTATION_CONFIG_VARIANTS,
  type EtfRotationConfigVariantKey,
  type RebalanceOrder,
  type RotationTarget,
} from "./etfRotationStrategy.js";

dotenv.config();

const RENDER_REVIEW_URL =
  process.env.ETF_ROTATION_REVIEW_URL ??
  "https://ai-trading-agent-i4nr.onrender.com/api/autopilot/etf-rotation/review";

const APCA_API_KEY_ID = process.env.APCA_API_KEY_ID ?? "";
const APCA_API_SECRET_KEY = process.env.APCA_API_SECRET_KEY ?? "";
const FEED = process.env.ALPACA_DATA_FEED || "iex";

const DATA_DIR = path.resolve(process.cwd(), "data");
const REPORT_DIR = path.resolve(process.cwd(), "data", "backtest-reports", "etf-rotation");
const SHADOW_STATE_PATH = path.join(DATA_DIR, "etf-rotation-delta-only-live-shadow-state.json");
const REPORT_PATH = path.join(REPORT_DIR, "etf-rotation-delta-only-live-shadow-report.md");
const LOG_CSV_PATH = path.join(REPORT_DIR, "etf-rotation-delta-only-live-shadow-log.csv");

// Exactly the 4 threshold points from PR #83 - no wider sweep here either.
const THRESHOLD_PERCENTAGES = [0, 1, 2, 5];

// Mirrors etfRotationWorkerState.ts's TERMINAL_SUCCESS_STATUSES - duplicated
// as a plain literal rather than imported, since this script deliberately
// never imports etfRotationWorkerState.ts (it has no access to the real
// state file at all - see the file-level comment above).
const TERMINAL_SUCCESS_STATUSES = new Set(["executed", "partial"]);

interface PortfolioPositionSnapshotLike {
  shares: number;
  avgPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
}

interface EtfRotationReviewResponse {
  stateReadError: boolean;
  status: string | null;
  rebalanceMonthKey: string | null;
  configVariantKey: string | null;
  targets: RotationTarget[] | null;
  plannedOrders: RebalanceOrder[] | null;
  positions: Record<string, PortfolioPositionSnapshotLike>;
  cash: number;
  currentEquity: number;
}

interface ShadowState {
  lastShadowedRebalanceMonthKey?: string;
}

async function readShadowState(): Promise<ShadowState> {
  try {
    const raw = await fs.readFile(SHADOW_STATE_PATH, "utf-8");
    return JSON.parse(raw) as ShadowState;
  } catch {
    return {};
  }
}

async function writeShadowState(state: ShadowState): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(SHADOW_STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

async function fetchReview(): Promise<EtfRotationReviewResponse> {
  const response = await fetch(RENDER_REVIEW_URL, { headers: { "Cache-Control": "no-store" } });
  if (!response.ok) {
    throw new Error(`ETF Rotation review fetch failed: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as EtfRotationReviewResponse;
}

// Duplicated per-script, not shared - same convention as every other
// backtest/research script in this repo (each keeps its own private fetch
// function). Latest-quote only, not historical bars - this shadow needs
// "what would it cost right now," not a time series.
async function fetchLatestPrice(ticker: string): Promise<number> {
  const url = `https://data.alpaca.markets/v2/stocks/${ticker}/bars/latest?feed=${FEED}`;
  const response = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID": APCA_API_KEY_ID,
      "APCA-API-SECRET-KEY": APCA_API_SECRET_KEY,
    },
  });
  if (!response.ok) {
    throw new Error(`Latest price fetch failed for ${ticker}: HTTP ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as { bar?: { c?: number } };
  return data.bar?.c ?? 0;
}

// Read-only, dormant classification using PR #84's proposed vocabulary -
// NOT etfRotationOrderAuditLog.ts's real deriveLegType, does not touch the
// real audit log. wasHeldBefore/isStillTarget are both derived from data
// already in hand (the real portfolio snapshot and the real targets list),
// not recomputed.
type ShadowLegType = "increase_target" | "decrease_target" | "open_new" | "exit_removed";

function classifyShadowLeg(
  order: RebalanceOrder,
  wasHeldBefore: boolean,
  isStillTarget: boolean,
): ShadowLegType {
  if (order.action === "BUY") {
    return wasHeldBefore ? "increase_target" : "open_new";
  }
  return isStillTarget ? "decrease_target" : "exit_removed";
}

// Dollar value of a set of orders at current prices - deliberately a local,
// direct computation rather than reusing riskTaxMetrics.ts's
// computeTurnoverStats, which expects a dated multi-day trade log (holding
// period, annualization) that doesn't fit a single-point-in-time order
// list. Both sides of every comparison in this script are valued at the
// SAME current price map, so the $ comparison stays apples-to-apples even
// though it isn't the exact price either the real cycle or a hypothetical
// delta-only cycle would have actually traded at.
function computeGrossValueUsd(orders: RebalanceOrder[], priceByTicker: Map<string, number>): number {
  return orders.reduce((sum, order) => {
    if (order.notional !== undefined) return sum + order.notional;
    const price = priceByTicker.get(order.ticker) ?? 0;
    return sum + order.shares * price;
  }, 0);
}

function csvEscape(value: string | number): string {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

async function appendLogRows(rows: (string | number)[][]): Promise<void> {
  await fs.mkdir(REPORT_DIR, { recursive: true });
  let needsHeader = false;
  try {
    await fs.access(LOG_CSV_PATH);
  } catch {
    needsHeader = true;
  }
  const header = [
    "rebalance_month_key",
    "observed_at",
    "config_variant",
    "threshold_pct",
    "real_full_liquidate_gross_usd",
    "delta_only_gross_usd",
    "gross_reduction_pct",
    "leg_count",
  ];
  const lines = (needsHeader ? [header, ...rows] : rows)
    .map((row) => row.map(csvEscape).join(","))
    .join("\n") + "\n";
  await fs.appendFile(LOG_CSV_PATH, lines, "utf-8");
}

async function main() {
  console.log(`Fetching live review state from ${RENDER_REVIEW_URL}...`);
  const review = await fetchReview();

  if (review.stateReadError) {
    console.log("Real live state is unreadable/corrupt per the review endpoint - nothing safe to shadow. No-op.");
    return;
  }

  const shadowState = await readShadowState();

  const isTerminalSuccess = review.status !== null && TERMINAL_SUCCESS_STATUSES.has(review.status);
  const alreadyShadowed =
    review.rebalanceMonthKey !== null && review.rebalanceMonthKey === shadowState.lastShadowedRebalanceMonthKey;

  if (!isTerminalSuccess) {
    console.log(
      `No-op: real live status is "${review.status ?? "null"}", not a terminal success (executed/partial) yet this cycle.`,
    );
    return;
  }

  if (alreadyShadowed) {
    console.log(`No-op: rebalanceMonthKey "${review.rebalanceMonthKey}" was already shadowed.`);
    return;
  }

  if (!review.targets || review.targets.length === 0 || !review.rebalanceMonthKey || !review.configVariantKey) {
    console.log("No-op: real state is missing targets/rebalanceMonthKey/configVariantKey - nothing to shadow.");
    return;
  }

  // === Meaningful observation: a new, real, terminal rebalance month ===
  console.log(`New meaningful observation: rebalanceMonthKey "${review.rebalanceMonthKey}". Building shadow comparison...`);

  const variantKey = review.configVariantKey as EtfRotationConfigVariantKey;
  const variant = ETF_ROTATION_CONFIG_VARIANTS[variantKey];
  if (!variant) {
    throw new Error(`Unknown configVariantKey from live state: "${review.configVariantKey}" - refusing to guess a universe.`);
  }

  const targets = review.targets;
  const currentEquity = review.currentEquity;

  // Real current shares, decimals preserved (fractional support is dormant
  // but the read path should not assume whole shares).
  const currentSharesByTicker = new Map<string, number>();
  for (const [ticker, position] of Object.entries(review.positions)) {
    if (position.shares > 0) currentSharesByTicker.set(ticker, position.shares);
  }

  console.log(`Fetching current prices for ${targets.length} target ticker(s)...`);
  const currentPriceByTicker = new Map<string, number>();
  for (const target of targets) {
    currentPriceByTicker.set(target.ticker, await fetchLatestPrice(target.ticker));
  }

  const realFullLiquidateGrossUsd = computeGrossValueUsd(review.plannedOrders ?? [], currentPriceByTicker);

  interface ThresholdResult {
    thresholdPercent: number;
    orders: RebalanceOrder[];
    classified: { order: RebalanceOrder; legType: ShadowLegType }[];
    grossUsd: number;
  }

  const thresholdResults: ThresholdResult[] = THRESHOLD_PERCENTAGES.map((thresholdPercent) => {
    const orders = computeDeltaRebalanceOrders(
      targets,
      currentEquity,
      currentSharesByTicker,
      currentPriceByTicker,
      variant.config.universe,
      thresholdPercent,
    );

    const targetTickers = new Set(targets.map((t) => t.ticker));
    const classified = orders.map((order) => ({
      order,
      legType: classifyShadowLeg(order, currentSharesByTicker.has(order.ticker), targetTickers.has(order.ticker)),
    }));

    return {
      thresholdPercent,
      orders,
      classified,
      grossUsd: computeGrossValueUsd(orders, currentPriceByTicker),
    };
  });

  // Per-ticker current vs. target weight, independent of threshold - makes
  // "would this threshold trade or leave it within tolerance" self-evident
  // from the table without inventing a synthetic "skipped" event.
  interface TickerDeviationRow {
    ticker: string;
    currentWeightPercent: number;
    targetWeightPercent: number;
    deviationPercent: number;
  }
  const deviationRows: TickerDeviationRow[] = targets.map((target) => {
    const shares = currentSharesByTicker.get(target.ticker) ?? 0;
    const price = currentPriceByTicker.get(target.ticker) ?? 0;
    const currentWeightPercent = currentEquity > 0 ? ((shares * price) / currentEquity) * 100 : 0;
    return {
      ticker: target.ticker,
      currentWeightPercent,
      targetWeightPercent: target.weightPercent,
      deviationPercent: Math.abs(currentWeightPercent - target.weightPercent),
    };
  });

  // Explains, not just discloses, a low reduction number - PR #83's
  // backtest found 55-85% turnover reduction, but that number assumes a
  // portfolio already close to target. If the real live portfolio is
  // currently far from target (e.g. because AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT
  // is keeping real position sizes well below their nominal weight), the
  // delta to trade is nearly as large as the full target, so delta-only has
  // little left to save THIS cycle - not a contradiction of PR #83, a
  // demonstration of exactly the interaction PR #84's point 4 flagged
  // (delta-only's benefit and the ramp-cap decision are not independent).
  // Threshold: half of PR #83's own low end (55%/2 = 27.5%), so this only
  // fires when the reduction is meaningfully below what a target-tracking
  // portfolio would show, not on ordinary noise.
  const avgDeviationPercent =
    deviationRows.length > 0
      ? deviationRows.reduce((sum, r) => sum + r.deviationPercent, 0) / deviationRows.length
      : 0;
  const minReductionPercent = Math.min(
    ...thresholdResults.map((tr) =>
      realFullLiquidateGrossUsd > 0 ? ((realFullLiquidateGrossUsd - tr.grossUsd) / realFullLiquidateGrossUsd) * 100 : 100,
    ),
  );
  const lowReductionExplainerLine =
    minReductionPercent < 27.5
      ? `\n**Read this reduction number carefully**: it is well below PR #83's backtest range (55-85%). Average deviation from target this cycle is ${avgDeviationPercent.toFixed(1)}pp - the real live portfolio is currently far from its target weights (see the per-ticker table above), likely due to the live ramp cap (\`AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT\`) constraining real position sizes. When a portfolio is this far from target, the delta to trade is nearly as large as the full target itself, so delta-only has little turnover left to save. This is not a contradiction of PR #83 - it is the real-data confirmation of PR #84's point 4: delta-only's benefit and the ramp-cap decision are not independent questions.\n`
      : "";

  const observedAt = new Date().toISOString();

  await appendLogRows(
    thresholdResults.map((tr) => [
      review.rebalanceMonthKey!,
      observedAt,
      variant.label,
      tr.thresholdPercent,
      realFullLiquidateGrossUsd.toFixed(2),
      tr.grossUsd.toFixed(2),
      realFullLiquidateGrossUsd > 0
        ? (((realFullLiquidateGrossUsd - tr.grossUsd) / realFullLiquidateGrossUsd) * 100).toFixed(2)
        : "n/a",
      tr.orders.length,
    ]),
  );

  const reportMd = `# ETF Rotation delta-only live-portfolio shadow

Generated: ${observedAt}
Rebalance month: ${review.rebalanceMonthKey}
Config variant: ${variant.label}

**Read-only, research-only - no live, execution, or config change.** This is a **one-cycle counterfactual**: given the REAL current Alpaca portfolio and the REAL targets the live full-liquidate cycle already decided this month, what would \`computeDeltaRebalanceOrders\` have done differently - NOT a continuous delta-only simulation (see PR #83's backtest grid for that question). Targets are read from the real, already-persisted live decision (never recomputed independently), so this measures "mechanism differs," not "signal differs." Prices are current market quotes at run time, not the exact price the real cycle traded at - a minor, disclosed timing difference, not a mechanism difference. A real off-target gap (a target ticker currently holding 0 shares) is read as-is, not special-cased - \`computeDeltaRebalanceOrders\` naturally computes a full-target BUY for it, the same magnitude a fresh full-liquidate rebuild would.

## Per-ticker current weight vs. target

| ticker | current weight | target weight | deviation |
|---|---|---|---|
${deviationRows.map((r) => `| ${r.ticker} | ${r.currentWeightPercent.toFixed(2)}% | ${r.targetWeightPercent.toFixed(2)}% | ${r.deviationPercent.toFixed(2)}pp |`).join("\n")}

## Real full-liquidate (this cycle's actual plan) vs. delta-only at each threshold

Real full-liquidate planned gross value: **$${realFullLiquidateGrossUsd.toFixed(2)}** (${(review.plannedOrders ?? []).length} legs).

| threshold | delta-only gross value | reduction vs. real | legs |
|---|---|---|---|
${thresholdResults
  .map(
    (tr) =>
      `| ${tr.thresholdPercent}% | $${tr.grossUsd.toFixed(2)} | ${
        realFullLiquidateGrossUsd > 0
          ? `${(((realFullLiquidateGrossUsd - tr.grossUsd) / realFullLiquidateGrossUsd) * 100).toFixed(1)}%`
          : "n/a"
      } | ${tr.orders.length} |`,
  )
  .join("\n")}
${lowReductionExplainerLine}
## Delta-only legs by threshold (PR #84's proposed legType vocabulary - dormant, read-only, not the real audit log)

${thresholdResults
  .map(
    (tr) => `### Threshold ${tr.thresholdPercent}%

${
  tr.classified.length === 0
    ? "No legs - every target ticker within this threshold's tolerance band, or already exactly at target."
    : tr.classified
        .map((c) => `- ${c.legType}: ${c.order.action} ${c.order.ticker} - ${c.order.shares} share(s)${c.order.notional !== undefined ? ` ($${c.order.notional.toFixed(2)} notional)` : ""}`)
        .join("\n")
}`,
  )
  .join("\n\n")}

## Caveats

- One-cycle counterfactual against the real, full-liquidate-managed portfolio - not a compounding delta-only simulation.
- Targets/plannedOrders read from the real live state via \`GET /api/autopilot/etf-rotation/review\` - never recomputed.
- Prices are current market quotes at run time, not the real cycle's actual trade prices - both sides of every $ comparison use the same price map, so the comparison stays internally consistent even though it isn't the exact historical price.
- \`legType\` values here are PR #84's proposed, dormant vocabulary for a possible future live audit log - this report does not write to \`etf-rotation-order-audit.jsonl\` and does not affect it in any way.
- No orders were submitted. This script never calls \`executeSafeTrade\` or any repair/execution endpoint.
`;

  await fs.mkdir(REPORT_DIR, { recursive: true });
  await fs.writeFile(REPORT_PATH, reportMd, "utf-8");
  console.log(`Report written to ${REPORT_PATH}`);
  console.log(`Log row(s) appended to ${LOG_CSV_PATH}`);

  await writeShadowState({ lastShadowedRebalanceMonthKey: review.rebalanceMonthKey });
  console.log(`Shadow state updated: lastShadowedRebalanceMonthKey = ${review.rebalanceMonthKey}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
