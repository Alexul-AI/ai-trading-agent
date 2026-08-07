// Env-var/config resolution for autopilotWorker.ts - extracted in the
// autopilotWorker refactor Slice 2 (2026-08-07, see
// docs/ops/AUTOPILOT_WORKER_MAP.md). Pure move: every default value,
// fail-soft/fail-loud behavior, and env var name is unchanged from before
// this extraction - only the file each expression lives in changed.
//
// Excluded on purpose (stayed in autopilotWorker.ts, not config
// resolution): WORKER_OWNER_ID (randomUUID(), runtime process identity,
// zero env involvement), TICKER_TO_BUCKET (fully static domain data),
// REGIME_BUCKETS (mostly static domain data - see
// AUTOPILOT_REGIME_EXEMPT_HIGH_BETA_DEFAULT below for the one env-derived
// field pulled out of it), ETF_ROTATION_WARMUP_TRADING_DAYS (hardcoded 210,
// zero env involvement).
import { DEFAULT_STRATEGY_CONFIG } from "./strategyEngine.js";
import { createStrategyConfigHash } from "./decisionJournal.js";
import {
  ETF_ROTATION_CONFIG_VARIANTS,
  resolveEtfRotationConfigVariant,
  type EtfRotationConfig,
} from "./etfRotationStrategy.js";
import {
  resolveEtfRotationSellFillTimingMs,
  resolveMaxAllowedPositions,
  resolveRampMaxPositionEquityPercent,
} from "./etfRotationExecution.js";
import { resolveTimeZone } from "./src/utils/time.js";
import type { AutopilotStrategyKind } from "./src/types/autopilotTypes.js";

// No existing shared int/float-with-default helper exists anywhere in
// backend/ - these two are new, but small and self-contained, modeled
// directly on this codebase's own established resolveXxx(raw, ...)
// convention (resolveTimeZone, resolveRampMaxPositionEquityPercent,
// resolveMaxAllowedPositions, resolveEtfRotationSellFillTimingMs).
//
// Deliberately as lenient as Number.parseInt/parseFloat themselves are -
// an invalid string (e.g. "garbage") silently produces NaN, exactly
// matching every one of these values' pre-extraction behavior. Not adding
// new validation here, even though a NaN interval/threshold is a real
// latent footgun (e.g. setInterval(fn, NaN) coerces to a 0ms interval) -
// fixing that is a deliberate non-goal of this pure-relocation PR.
export function parseIntWithDefault(
  raw: string | undefined,
  defaultValue: number,
): number {
  return Number.parseInt(raw || String(defaultValue), 10);
}

export function parseFloatWithDefault(
  raw: string | undefined,
  defaultValue: number,
): number {
  return Number.parseFloat(raw || String(defaultValue));
}

export function resolveAutopilotTickers(raw: string | undefined): string[] {
  return (raw || "AMD,NVDA,AAPL,MSFT,TSLA,JPM,JNJ,XOM,PG,SPY,GLD,TLT,EFA")
    .split(",")
    .map((ticker) => ticker.trim().toUpperCase())
    .filter(Boolean);
}

export function resolveAutopilotStrategy(
  raw: string | undefined,
): AutopilotStrategyKind {
  return raw === "etf_rotation" ? "etf_rotation" : "baseline";
}

// --- Wiring: the actual process.env reads, in the same order as the
// pre-extraction file for easy diffing. ---

export const APCA_API_KEY_ID = process.env.APCA_API_KEY_ID ?? "";
export const APCA_API_SECRET_KEY = process.env.APCA_API_SECRET_KEY ?? "";

// Strategy decisions are computed from daily bars (RSI/MACD/BB don't change
// intraday), so polling every 60s previously just re-evaluated the same
// inputs ~390 times between meaningful data changes - added log/journal
// noise and API calls, not information. Hourly gives 24 evaluations/day
// instead, still frequent enough to react same-day, without the churn.
export const AUTOPILOT_INTERVAL_MS = parseIntWithDefault(
  process.env.AUTOPILOT_INTERVAL_MS,
  3600000,
);

// Best-effort, same-host-only protection (see autopilotWorkerLock.ts for
// the honest limitation) - default 3x the cycle interval, long enough that
// a normal cycle never falsely looks stale, short enough that a crashed
// process doesn't block recovery for long.
export const AUTOPILOT_LOCK_STALE_AFTER_MS = parseIntWithDefault(
  process.env.AUTOPILOT_LOCK_STALE_AFTER_MS,
  AUTOPILOT_INTERVAL_MS * 3,
);

export const AUTOPILOT_BARS_DAYS = parseIntWithDefault(
  process.env.AUTOPILOT_BARS_DAYS,
  180,
);

export const AUTOPILOT_MIN_CONFIDENCE = parseFloatWithDefault(
  process.env.AUTOPILOT_MIN_CONFIDENCE,
  0.75,
);

export const AUTOPILOT_COOLDOWN_MINUTES = parseIntWithDefault(
  process.env.AUTOPILOT_COOLDOWN_MINUTES,
  60,
);

export const AUTOPILOT_TELEGRAM_COOLDOWN_MINUTES = parseIntWithDefault(
  process.env.AUTOPILOT_TELEGRAM_COOLDOWN_MINUTES,
  30,
);

// Timezone the daily circuit-breaker/off-target reminders' "once per
// calendar day" boundary is computed in (2026-08-07) - previously always
// UTC (lastRunAt.slice(0, 10)), which meant a reminder just after UTC
// midnight read as a same-night "duplicate" to a user in a non-UTC
// timezone even though it was technically a new UTC day. Defaults to
// Asia/Jerusalem (this deployment's actual user), not UTC, since the whole
// point is for "once a day" to match the day the user experiences it on.
// Cosmetic only - see resolveTimeZone's own doc comment for why an invalid
// value fails soft to UTC instead of crashing the worker.
export const AUTOPILOT_REMINDER_TIMEZONE = resolveTimeZone(
  process.env.AUTOPILOT_REMINDER_TIMEZONE,
  "Asia/Jerusalem",
);

export const ALPACA_DATA_FEED = process.env.ALPACA_DATA_FEED || "iex";

export const AUTOPILOT_TICKERS = resolveAutopilotTickers(
  process.env.AUTOPILOT_TICKERS,
);

export const AUTOPILOT_EXECUTE_TRADES =
  process.env.AUTOPILOT_EXECUTE_TRADES === "true";

export const AUTOPILOT_ALLOW_BUY = process.env.AUTOPILOT_ALLOW_BUY === "true";
export const AUTOPILOT_ALLOW_SELL = process.env.AUTOPILOT_ALLOW_SELL === "true";

// Off by default: this signal cannot be backtested (news APIs only return
// current data, not point-in-time history), so enabling it is an explicit,
// unvalidated opt-in rather than a proven improvement.
export const AUTOPILOT_SENTIMENT_FILTER_ENABLED =
  process.env.AUTOPILOT_SENTIMENT_FILTER === "true";

// Same rationale as the sentiment filter: unbacktestable, off by default.
export const AUTOPILOT_INSIDER_FILTER_ENABLED =
  process.env.AUTOPILOT_INSIDER_FILTER === "true";

// Off by default: backtest-validated (see backtest-sweep.ts's
// regime-filter-* variants), but "roughly matches baseline" isn't strong
// enough evidence to flip a new filter on by default - same standard
// already applied to useAtrStops.
export const AUTOPILOT_REGIME_FILTER_ENABLED =
  process.env.AUTOPILOT_REGIME_FILTER === "true";

// Backtest-validated: see backtest-sweep.ts's regime-filter-* variants - an
// unvalidated hypothesis until checked against our own tickers, not
// accepted as a given just because it was suggested. Pulled out of
// autopilotWorker.ts's REGIME_BUCKETS literal (which stays there, mostly
// static domain data) so every env var this worker reads lives in this one
// file, not all-but-one.
export const AUTOPILOT_REGIME_EXEMPT_HIGH_BETA_DEFAULT =
  process.env.AUTOPILOT_REGIME_EXEMPT_HIGH_BETA !== "false";

// Off by default: lets a BUY that would otherwise size to 0 whole shares
// (most/all tickers below ~$1,000-3,000 of capital) fall back to a
// fractional/notional order instead. That order gives up Alpaca's
// broker-side bracket stop_loss/take_profit (see
// strategyEngine.ts's allowFractionalShares doc comment) - an explicit
// capability-for-protection trade-off, not a pure risk reduction, so it's
// opt-in like the sentiment/insider filters rather than always-on like the
// bucket cap.
export const AUTOPILOT_ALLOW_FRACTIONAL_SHARES_ENABLED =
  process.env.AUTOPILOT_ALLOW_FRACTIONAL_SHARES === "true";

// Twice the single-ticker cap (maxPositionEquityFraction is 0.2) - allows up
// to two full-sized positions' worth of concentration in one correlated
// bucket, but blocks the AMD+NVDA+TSLA-all-at-20%-each scenario. Only bites
// for multi-ticker buckets (us_broad, high_beta_growth) - the single-ticker
// buckets never approach 40% since they're already capped at 20% each.
export const AUTOPILOT_MAX_BUCKET_EQUITY_FRACTION = parseFloatWithDefault(
  process.env.AUTOPILOT_MAX_BUCKET_EQUITY_FRACTION,
  0.4,
);

// ETF-first tilt: high_beta_growth (AMD/NVDA/TSLA) gets a tighter cap than
// the other buckets - equal to the single-ticker cap, so the whole bucket
// combined can never exceed what one full-sized individual position would
// already be allowed. Doesn't remove these tickers from the universe, just
// meaningfully reduces how concentrated the bot can get in speculative
// single names versus the ETF-heavy buckets (us_broad/international/
// bonds/commodities), which keep the looser 40% default.
export const AUTOPILOT_HIGH_BETA_BUCKET_EQUITY_FRACTION = parseFloatWithDefault(
  process.env.AUTOPILOT_HIGH_BETA_BUCKET_EQUITY_FRACTION,
  0.2,
);

export const BUCKET_EQUITY_FRACTION_OVERRIDES: Record<string, number> = {
  high_beta_growth: AUTOPILOT_HIGH_BETA_BUCKET_EQUITY_FRACTION,
};

// Default safety behavior:
// normal SELL_SIGNAL should not sell a held position below average entry.
// STOP_LOSS remains allowed to protect capital.
export const AUTOPILOT_BLOCK_SELL_BELOW_AVG =
  process.env.AUTOPILOT_BLOCK_SELL_BELOW_AVG !== "false";

export const AUTOPILOT_ENABLED_DEFAULT =
  process.env.AUTOPILOT_ENABLED_DEFAULT === "true";

export const STRATEGY_VERSION =
  process.env.STRATEGY_VERSION ?? "v1.2-confluence-scoring";

export const STRATEGY_CONFIG_HASH = createStrategyConfigHash(
  DEFAULT_STRATEGY_CONFIG,
);

// Mutually exclusive with the baseline strategy above - never both in the
// same process. See docs/product/ROADMAP.md Phase 3 and the ETF Rotation
// live-integration plan: the baseline's 13-ticker universe and rotation's
// 5-ETF universe overlap (SPY/EFA/TLT/GLD), and neither order idempotency
// (server.ts's client_order_id, keyed only "TICKER:ACTION") nor position
// tracking (ticker-keyed only, no strategy attribution) could safely
// disambiguate two strategies trading the same ticker concurrently.
export const AUTOPILOT_STRATEGY: AutopilotStrategyKind = resolveAutopilotStrategy(
  process.env.AUTOPILOT_STRATEGY,
);

export const ETF_ROTATION_CONFIG_VARIANT_KEY = resolveEtfRotationConfigVariant(
  process.env.ETF_ROTATION_CONFIG,
);
export const ETF_ROTATION_ACTIVE_CONFIG: EtfRotationConfig =
  ETF_ROTATION_CONFIG_VARIANTS[ETF_ROTATION_CONFIG_VARIANT_KEY].config;

export const ETF_ROTATION_STRATEGY_VERSION = `etf-rotation-${ETF_ROTATION_CONFIG_VARIANT_KEY}`;
export const ETF_ROTATION_STRATEGY_CONFIG_HASH = createStrategyConfigHash(
  ETF_ROTATION_ACTIVE_CONFIG,
);

// Momentum(126 trading days) + SMA(200 trading days) need ~210 trading days
// of runway before a decision is numerically valid (same WARMUP_BARS
// convention as backtest-etf-rotation.ts) - far more than the baseline
// path's 180-calendar-day default. 400 calendar days clears that with
// weekend/holiday margin to spare.
export const AUTOPILOT_ETF_ROTATION_BARS_DAYS = parseIntWithDefault(
  process.env.AUTOPILOT_ETF_ROTATION_BARS_DAYS,
  400,
);

// Fails loud at process startup on a bad value (see
// resolveRampMaxPositionEquityPercent's own doc comment) - unset stays
// uncapped (current, unchanged behavior); this is the paper-execution ramp
// gate for the first real BUYs, a sibling of AUTOPILOT_ALLOW_BUY/SELL, not
// a strategy config.
export const AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT =
  resolveRampMaxPositionEquityPercent(
    process.env.AUTOPILOT_ETF_ROTATION_RAMP_MAX_POSITION_PERCENT,
  );

// Independent of the baseline strategy's AUTOPILOT_ALLOW_SELL, which stays
// untouched - this only unblocks the rotation cycle's own liquidate-and-
// rebuy SELL legs (see EtfRotationExecutionGates.allowRebalanceSells's own
// doc comment). Off by default, matching every other new gate in this
// project's history (sentiment/insider filters, regime filter, fractional
// shares, the ramp cap itself) - explicit user approval required in Render
// before ever setting this true (2026-07-19 decision, see CLAUDE.md).
export const AUTOPILOT_ALLOW_REBALANCE_SELLS =
  process.env.AUTOPILOT_ALLOW_REBALANCE_SELLS === "true";

// Always-on guardrail (not opt-in like the ramp cap) - see
// resolveMaxAllowedPositions's own doc comment for why this exists
// alongside allowRebalanceSells rather than instead of it.
export const AUTOPILOT_ETF_ROTATION_MAX_POSITIONS = resolveMaxAllowedPositions(
  process.env.AUTOPILOT_ETF_ROTATION_MAX_POSITIONS,
  ETF_ROTATION_ACTIVE_CONFIG.holdCount,
);

// See EtfRotationExecutionGates.maxAllowedPositions's sibling comment on
// waitForSellFill / etfRotationExecution.ts's file-level 2026-08-04 update
// for why this exists: a liquidate_existing SELL being merely "accepted"
// wasn't safe enough for its paired rebuild BUY (a real production 403).
export const {
  timeoutMs: AUTOPILOT_ETF_ROTATION_SELL_FILL_TIMEOUT_MS,
  pollIntervalMs: AUTOPILOT_ETF_ROTATION_SELL_FILL_POLL_MS,
} = resolveEtfRotationSellFillTimingMs(
  process.env.AUTOPILOT_ETF_ROTATION_SELL_FILL_TIMEOUT_MS,
  process.env.AUTOPILOT_ETF_ROTATION_SELL_FILL_POLL_MS,
);
