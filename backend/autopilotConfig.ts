// Env-var/config resolution for autopilotWorker.ts. Extracted in the
// autopilotWorker refactor Slice 2 (2026-08-07, see
// docs/ops/AUTOPILOT_WORKER_MAP.md) as a pure move - every default value
// and env var name was unchanged from before that extraction. A follow-up
// safety PR the same day upgraded 9 numeric fields' parsing from lenient
// (silent NaN on garbage input) to strict - see
// parseStrictPositiveIntWithDefault/parseStrictFractionWithDefault/
// parseIntWithFallbackWarning below for the fail-loud-vs-bounded-fallback
// split and why each field landed where it did. Default values and env var
// names are still unchanged by that PR - only invalid-input handling
// changed, deliberately.
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

// Strict numeric env parsing (2026-08-07 safety PR, follow-up to Slice 2) -
// three tiers, chosen per field by actually tracing what an invalid value
// does downstream, not applied uniformly:
//
// - parseStrictPositiveIntWithDefault / parseStrictFractionWithDefault:
//   fail loud (throw at module load) for fields where NaN/negative/zero is
//   genuinely dangerous - matches this codebase's own established
//   resolveRampMaxPositionEquityPercent/resolveMaxAllowedPositions
//   convention in etfRotationExecution.ts (regex-validate the trimmed
//   string first, since parseInt/parseFloat silently truncate trailing
//   garbage like "10abc", then range-validate, then throw a descriptive
//   Error naming the env var - or return the parsed value).
// - parseIntWithFallbackWarning: warn + fall back to the default for
//   fields where an invalid value only degrades functionality (a per-
//   ticker error, a defeated cooldown bounded by other safety layers) -
//   no existing precedent in this repo for this exact pattern, genuinely
//   new here, not modeled on prior code.
//
// Parameter order (name, raw, defaultValue) matches the closer existing
// precedent, etfRotationExecution.ts's private, multi-use
// parseStrictPositiveIntEnv(name, raw, defaultValue) - not the single-use
// resolveRampMaxPositionEquityPercent's (raw) order. Duplicated rather
// than imported from that file: small, stateless, matches this codebase's
// own established duplication precedent (getErrorMessage/extractErrorMessage
// independently defined in 5+ files) rather than exporting a private
// helper from a file this PR shouldn't otherwise touch.
export function parseStrictPositiveIntWithDefault(
  name: string,
  raw: string | undefined,
  defaultValue: number,
): number {
  if (raw === undefined) return defaultValue;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid ${name} (${JSON.stringify(raw)}): must be a positive integer, or unset to default to ${defaultValue}.`,
    );
  }
  const parsed = Number(trimmed);
  if (parsed <= 0) {
    throw new Error(
      `Invalid ${name} (${JSON.stringify(raw)}): must be a positive integer, or unset to default to ${defaultValue}.`,
    );
  }
  return parsed;
}

// Range (0, 1] - inclusive of 1, which is a legitimate value for every
// fail-loud fraction field this feeds (confidence is clamped to max 1.0 in
// strategyEngine.ts; a bucket fraction of 1.0 legitimately means "no real
// cap," a valid extreme, not a typo).
export function parseStrictFractionWithDefault(
  name: string,
  raw: string | undefined,
  defaultValue: number,
): number {
  if (raw === undefined) return defaultValue;
  const trimmed = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(
      `Invalid ${name} (${JSON.stringify(raw)}): must be a number greater than 0 and at most 1, or unset to default to ${defaultValue}.`,
    );
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error(
      `Invalid ${name} (${JSON.stringify(raw)}): must be a number greater than 0 and at most 1, or unset to default to ${defaultValue}.`,
    );
  }
  return parsed;
}

// Rejects NaN/non-numeric AND negative/zero uniformly (not just NaN) -
// for AUTOPILOT_COOLDOWN_MINUTES specifically, a negative/zero value
// defeats the cooldown outright (the opposite failure direction from NaN,
// which makes it stick "on" instead - see this PR's own plan/commit
// history for the full trace), so both must fall back to the same
// known-safe default, not just NaN.
export function parseIntWithFallbackWarning(
  name: string,
  raw: string | undefined,
  defaultValue: number,
): number {
  if (raw === undefined) return defaultValue;
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (!/^-?\d+$/.test(trimmed) || parsed <= 0) {
    console.warn(
      `[CONFIG] Invalid ${name} (${JSON.stringify(raw)}) - falling back to default ${defaultValue}.`,
    );
    return defaultValue;
  }
  return parsed;
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
// Fails loud at process startup on a bad value - empirically confirmed
// (2026-08-07): setInterval(fn, NaN | 0 | negative) all fire the autopilot
// cycle essentially immediately and repeatedly, hammering the Alpaca API
// and the worker-lock claim/release cycle.
export const AUTOPILOT_INTERVAL_MS = parseStrictPositiveIntWithDefault(
  "AUTOPILOT_INTERVAL_MS",
  process.env.AUTOPILOT_INTERVAL_MS,
  3600000,
);

// Best-effort, same-host-only protection (see autopilotWorkerLock.ts for
// the honest limitation) - default 3x the cycle interval, long enough that
// a normal cycle never falsely looks stale, short enough that a crashed
// process doesn't block recovery for long. Fails loud on a bad value: NaN
// makes a crashed process's lock unreclaimable forever (matches this
// project's own 2026-07-17 incident); zero/negative makes the lock always
// look stale, letting two processes race/double-claim it continuously -
// both directions dangerous, both rejected.
export const AUTOPILOT_LOCK_STALE_AFTER_MS = parseStrictPositiveIntWithDefault(
  "AUTOPILOT_LOCK_STALE_AFTER_MS",
  process.env.AUTOPILOT_LOCK_STALE_AFTER_MS,
  AUTOPILOT_INTERVAL_MS * 3,
);

// Falls back (with a warning, not a crash) on a bad value - degrades to
// every baseline ticker getting an ANALYSIS_ERROR HOLD decision that
// cycle (an Invalid Date inside fetchAlpacaBarsUncached, caught by the
// existing per-ticker try/catch), not a dangerous outcome.
export const AUTOPILOT_BARS_DAYS = parseIntWithFallbackWarning(
  "AUTOPILOT_BARS_DAYS",
  process.env.AUTOPILOT_BARS_DAYS,
  180,
);

// Fails loud on a bad value: strategyEngine.ts clamps decision.confidence
// to [0,1], so any minConfidence <= 0 (not just NaN) defeats the quality
// gate in analyzeTicker.ts outright - a zero/negative threshold and a NaN
// one have the same dangerous effect (every signal passes uncontested).
export const AUTOPILOT_MIN_CONFIDENCE = parseStrictFractionWithDefault(
  "AUTOPILOT_MIN_CONFIDENCE",
  process.env.AUTOPILOT_MIN_CONFIDENCE,
  0.75,
);

// Falls back (with a warning, not a crash) on a bad value. NaN makes the
// cooldown stick "on" (self-limiting - blocks future buys for that ticker
// until restart); zero/negative does the opposite, defeating the cooldown
// outright (bounded only by other independent safety layers - bucket cap,
// per-ticker cap, cash, circuit breaker) - this function rejects NaN AND
// negative AND zero uniformly, substituting the known-safe default in
// every invalid case, not just guarding against NaN.
export const AUTOPILOT_COOLDOWN_MINUTES = parseIntWithFallbackWarning(
  "AUTOPILOT_COOLDOWN_MINUTES",
  process.env.AUTOPILOT_COOLDOWN_MINUTES,
  60,
);

// Falls back (with a warning, not a crash) on a bad value - only defeats
// the Telegram alert dedup cooldown (spam), zero effect on any trade or
// decision logic.
export const AUTOPILOT_TELEGRAM_COOLDOWN_MINUTES = parseIntWithFallbackWarning(
  "AUTOPILOT_TELEGRAM_COOLDOWN_MINUTES",
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
// Fails loud on a bad value: NaN propagates through the bucket-cap math in
// portfolioSafety.ts's Math.max/Math.min chain all the way to the final
// share count, which becomes NaN itself - not "cap defeated", the
// computed order quantity is corrupted (JSON.stringify({qty: NaN}) is
// "{\"qty\":null}", an unpredictable value to hand to order construction).
export const AUTOPILOT_MAX_BUCKET_EQUITY_FRACTION = parseStrictFractionWithDefault(
  "AUTOPILOT_MAX_BUCKET_EQUITY_FRACTION",
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
// Same NaN-corrupts-the-share-count reasoning as
// AUTOPILOT_MAX_BUCKET_EQUITY_FRACTION above - fails loud on a bad value.
export const AUTOPILOT_HIGH_BETA_BUCKET_EQUITY_FRACTION = parseStrictFractionWithDefault(
  "AUTOPILOT_HIGH_BETA_BUCKET_EQUITY_FRACTION",
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
// Falls back (with a warning, not a crash) on a bad value. Unlike
// AUTOPILOT_BARS_DAYS, the ETF rotation path's bars fetch
// (etfRotationCycle.ts) has no per-ticker try/catch - an Invalid-Date
// throw here aborts the entire rotation cycle for that run (caught only
// by runOnce()'s outer try/catch), not a per-ticker degradation. Still no
// crash and no trade either way, just a coarser-grained failure.
export const AUTOPILOT_ETF_ROTATION_BARS_DAYS = parseIntWithFallbackWarning(
  "AUTOPILOT_ETF_ROTATION_BARS_DAYS",
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
