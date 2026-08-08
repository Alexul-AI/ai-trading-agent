// Adjusted-shadow forward-validation track (2026-08-08, PRs #76-78's
// decision plan) - shadow-tracks baseline-2/candidate-hold3 under
// adjustment=all, on its own separate clock, alongside the existing
// raw-production track in backtest-etf-rotation-forward-validation.ts
// (whose own clock and output files this script never touches).
//
// This is methodology evidence for whether adjustment=all should ever
// become the live default - it does NOT validate/invalidate candidate-hold3
// vs baseline-2 under the current (raw) production methodology, and does
// not by itself trigger any live or config change. See
// docs/product/ROADMAP.md Phase 2 for the full decision plan this is part
// of, and PRs #76/#77 for the research that motivated it (adjustment=raw
// vs all changes ETF Rotation's picks on 10.7-13.1% of rebalance dates,
// verdict "adjusted likely better" by pre-declared criteria).
//
// Reuses runForwardValidationTrack (the exact same read-criteria logic and
// simulation engine as the raw-production track - only the adjustment,
// anchor date, and output paths differ) rather than a hand-copied second
// implementation that could silently drift from it on how results are
// read.
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

import { runForwardValidationTrack } from "./backtest-etf-rotation-forward-validation.js";

dotenv.config();

// The date adjusted-shadow-tracking was decided (PRs #76-78's risk-tiered
// decision plan) - a fixed historical fact, not a tunable knob, same
// "pin to a real decision date" convention as
// backtest-etf-rotation-forward-validation.ts's own FORWARD_VALIDATION_ANCHOR_DATE.
// Deliberately a DIFFERENT anchor and a DIFFERENT clock from that script's
// 2026-07-14 anchor - this track's rebalance_count starts fresh from here,
// it is not backdated and does not inherit the raw-production track's
// already-accumulated history.
const ADJUSTED_SHADOW_ANCHOR_DATE = "2026-08-08";

const REPORT_DIR = path.resolve(process.cwd(), "data", "backtest-reports", "etf-rotation");
const REPORT_PATH = path.join(
  REPORT_DIR,
  "etf-rotation-forward-validation-adjusted-shadow-report.md",
);
const LOG_CSV_PATH = path.join(
  REPORT_DIR,
  "etf-rotation-forward-validation-adjusted-shadow-log.csv",
);

async function main() {
  await runForwardValidationTrack({
    trackKind: "adjusted-shadow",
    anchorDate: ADJUSTED_SHADOW_ANCHOR_DATE,
    adjustment: "all",
    reportPath: REPORT_PATH,
    logCsvPath: LOG_CSV_PATH,
  });
}

// Same guard as every sibling backtest script - importing
// runForwardValidationTrack above must not also trigger
// backtest-etf-rotation-forward-validation.ts's own main() (it already has
// this same guard), and this file's own main() must only run when this
// file is the actual entry point.
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
