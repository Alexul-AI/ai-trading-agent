# Go-Live Criteria

Checklist for deciding when this bot is ready to trade with real capital (`TRADE_MODE=live`). Written 2026-07-09.

## Why this exists

"It's been running a while and looks fine" is not a decision process. A ~$13,444 realized loss from an automated trading incident on 2026-06-22 to 2026-06-29 happened under exactly that kind of informal judgment, before this checklist existed. This document replaces gut-feel with measurable, checkable gates.

## Status: not started

The scheduled autopilot loop has never run continuously (`AUTOPILOT_ENABLED_DEFAULT=false` as of 2026-07-09) - only manual "Run Once" triggers so far. Every gate below starts from zero.

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

### 4. Experimental filters excluded from the readiness decision
- [ ] `AUTOPILOT_SENTIMENT_FILTER` and `AUTOPILOT_INSIDER_FILTER` are either left off, or their block events are tracked and evaluated separately from the core strategy's results
- These signals cannot be backtested (the underlying APIs only return current data, not point-in-time history), so their effect on readiness must never be assumed positive by default.

### 5. Account-level circuit breaker
- [ ] A maximum portfolio drawdown threshold is defined and enforced (e.g. -15% equity from peak halts the autopilot automatically)
- Today there is only a per-trade stop-loss. There is no portfolio-level automatic stop yet - this needs to be built before go-live, not just decided.

### 6. Capital increases are earned, not scheduled
- [ ] Each tranche ($100 -> $1,000 -> $10,000) is unlocked by the previous tranche's own track record clearing these same gates again - not by a calendar date

## Reference numbers from the 2026-07-09 backtesting session

- Baseline strategy (`v1.2-confluence-scoring`), 10 tickers, 900-day window: roughly +1.4% to +2%/year on average, highly variable by ticker (-1.4% to +6%)
- No parameter tweak tested that day (wider position sizing, post-stop-loss cooldown, trend-level filter, trend-slope filter) produced a robust, validated improvement over baseline
- Buy-and-hold outperformed the strategy substantially on trending tickers (e.g. AMD +206%, TSLA +87% over 900 days vs. the strategy's single-digit returns) - this strategy trades upside for smaller drawdowns, it is not a growth strategy, and that tradeoff should inform expectations, not just the go-live decision

## Log

- 2026-07-09: Checklist created after a session that added news sentiment, fundamentals, and insider-activity signals (with two off-by-default BUY filters), fixed an indicator warm-up bug in the backtest tooling, added the first unit tests, and traced the paper account's historical loss to a pre-existing automated-trading incident unrelated to the current strategy code.
