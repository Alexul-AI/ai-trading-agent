# Go-Live Criteria

Checklist for deciding when this bot is ready to trade with real capital (`TRADE_MODE=live`). Written 2026-07-09.

## Why this exists

"It's been running a while and looks fine" is not a decision process. A ~$13,444 realized loss from an automated trading incident on 2026-06-22 to 2026-06-29 happened under exactly that kind of informal judgment, before this checklist existed. This document replaces gut-feel with measurable, checkable gates.

## Status: dry-run started, early

The scheduled autopilot loop started running continuously on 2026-07-09 and is still going as of 2026-07-11 (~2 days in) - a small fraction of the 4-6 week target in gate 1. `AUTOPILOT_EXECUTE_TRADES` is still `false`, so gate 2's trade-count clock hasn't started yet either. Every other gate below starts from zero except gate 5, built 2026-07-11 (see below).

## Gates (all must pass before going live)

### 1. Continuous dry-run operation
- [ ] Autopilot running in scheduled mode (not manual triggers) for **4-6 consecutive weeks**
- [ ] Covers more than one kind of market condition, not just a single trending or single flat stretch

### 2. Sample size
- [ ] At least **20-30 closed paper trades** with `AUTOPILOT_EXECUTE_TRADES=true` (still paper mode)
- Below this, results are statistically indistinguishable from noise. Confirmed today in our own backtest-sweep experiments: 5-8 trade samples showed "improvements" that vanished once the sample grew.

### 3. Risk mechanisms verified live, not just in backtest
- [ ] Stop-loss has fired at least once in paper mode and behaved correctly
- [ ] Take-profit has fired at least once in paper mode and behaved correctly
- [ ] Position/cash caps have been observed blocking an over-sized buy at least once
- [ ] Bucket concentration cap (built 2026-07-11) has been observed blocking a same-bucket over-concentration at least once
- [ ] Portfolio circuit breaker (built 2026-07-11) has been observed tripping at least once and correctly blocking new BUYs while still allowing SELLs

### 4. Experimental filters excluded from the readiness decision
- [ ] `AUTOPILOT_SENTIMENT_FILTER` and `AUTOPILOT_INSIDER_FILTER` are either left off, or their block events are tracked and evaluated separately from the core strategy's results
- These signals cannot be backtested (the underlying APIs only return current data, not point-in-time history), so their effect on readiness must never be assumed positive by default.

### 5. Account-level circuit breaker
- [x] A maximum portfolio drawdown threshold is defined and enforced (-15% equity from peak, `AUTOPILOT_MAX_DRAWDOWN_FROM_PEAK_PERCENT`, halts new BUYs automatically - built 2026-07-11)
- Blocks new BUYs only, never SELLs, same as the existing per-trade stop-loss philosophy. Peak equity is derived each cycle from Alpaca's own account history rather than tracked in a local file we could lose. See `CLAUDE.md`'s "Architecture facts" for the full design. Still needs to actually *fire* at least once in paper mode before this counts as verified, not just built - see gate 3.

### 6. Capital increases are earned, not scheduled
- [ ] Each tranche ($100 -> $1,000 -> $10,000) is unlocked by the previous tranche's own track record clearing these same gates again - not by a calendar date

## Reference numbers from the 2026-07-09 backtesting session (extended 2026-07-11)

- Baseline strategy (`v1.2-confluence-scoring`), 10 tickers, 900-day window: roughly +1.4% to +2%/year on average, highly variable by ticker (-1.4% to +6%)
- No parameter tweak tested that day (wider position sizing, post-stop-loss cooldown, trend-level filter, trend-slope filter) produced a robust, validated improvement over baseline
- Buy-and-hold outperformed the strategy substantially on trending tickers (e.g. AMD +206%, TSLA +87% over 900 days vs. the strategy's single-digit returns) - this strategy trades upside for smaller drawdowns, it is not a growth strategy, and that tradeoff should inform expectations, not just the go-live decision
- **2026-07-11**: ticker universe expanded to 13 (sector/asset-class diversified) - performance held in the same ballpark on the same window. ATR-based stops and a portfolio regime filter were both built and backtested (two non-overlapping 900-day windows for the regime filter, one covering the 2022 bear market) - neither showed strong enough, consistent-enough evidence to become the default; both ship off. Full numbers in `CLAUDE.md`'s "Strategy performance reality" section - not duplicated here to avoid the two files drifting out of sync with each other.

## Log

- 2026-07-09: Checklist created after a session that added news sentiment, fundamentals, and insider-activity signals (with two off-by-default BUY filters), fixed an indicator warm-up bug in the backtest tooling, added the first unit tests, and traced the paper account's historical loss to a pre-existing automated-trading incident unrelated to the current strategy code.
- 2026-07-11: Scheduled dry-run confirmed running continuously since 2026-07-09 (gate 1 clock officially started). Expanded ticker universe from 5 to 13 (sector/asset-class diversified). Set up real CI (backend typecheck+tests, frontend lint+build) - previously the only PR check was Vercel's deploy preview. Built and backtested ATR-based stops and a portfolio regime filter (both ship off by default - mixed/inconclusive evidence, see "Reference numbers" above). Built portfolio-level concentration cap and circuit breaker (gate 5 - both ship always-on, not opt-in). Added a best-effort worker lock and order-submission idempotency (`client_order_id`). Discussed and deferred risk-based position sizing until capital reaches the $10,000 tranche (whole-share-only execution is the binding constraint below that, not the sizing formula - see `CLAUDE.md`'s "Deliberately not built").
