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
- [ ] If `AUTOPILOT_ALLOW_FRACTIONAL_SHARES` is enabled (built 2026-07-11, off by default): at least one fractional/notional BUY has gone through paper trading, and its cycle-based STOP_LOSS/TAKE_PROFIT exit (no broker-side bracket for these positions) has been observed firing correctly - this is a genuinely different exit mechanism than the whole-share bracket path and needs its own live verification, not just unit-test coverage

These are trading-behavior gates. A separate, platform/ops-level checklist - deploy topology, restart/persistence behavior, order-idempotency durability, emergency stop - lives in `docs/ops/PAPER_INFRASTRUCTURE_GATE.md` and must also clear before `AUTOPILOT_EXECUTE_TRADES=true`, not just before live capital. As of 2026-07-15: circuit-breaker and order-idempotency restart persistence are code-fixed and regression-tested (simulated locally on real files, not yet observed against a real Render redeploy or a real order); the Render single-instance question is still open and can only be confirmed by looking at the Render dashboard, not from this repo.

### 4. Experimental filters excluded from the readiness decision
- [ ] `AUTOPILOT_SENTIMENT_FILTER` and `AUTOPILOT_INSIDER_FILTER` are either left off, or their block events are tracked and evaluated separately from the core strategy's results
- These signals cannot be backtested (the underlying APIs only return current data, not point-in-time history), so their effect on readiness must never be assumed positive by default.

### 5. Account-level circuit breaker
- [x] A maximum portfolio drawdown threshold is defined and enforced (-15% equity from peak, `AUTOPILOT_MAX_DRAWDOWN_FROM_PEAK_PERCENT`, halts new BUYs automatically - built 2026-07-11)
- Blocks new BUYs only, never SELLs, same as the existing per-trade stop-loss philosophy. Peak equity is derived each cycle from Alpaca's own account history rather than tracked in a local file we could lose. See `CLAUDE.md`'s "Architecture facts" for the full design. Still needs to actually *fire* at least once in paper mode before this counts as verified, not just built - see gate 3.
- **2026-07-13**: the sticky/no-auto-recovery design got its first real stress test in `backtest-portfolio.ts`'s next-open model, where it tripped once (2025-04-08) and then locked out new BUYs for 78% of a 406-day window, turning +20.66% into -9.68%. A backtest-only follow-up simulated several reset policies against that same trip - every one tested (reset after 1/3/5/10 trading days, or once drawdown recovered above -10%) turned the result positive (+5% to +8%) with no worse max drawdown than the current sticky policy on that one window.
- **2026-07-13, later same day**: ran the same comparison across 5 windows (`backtest-portfolio-multiwindow.ts`, new), not just the one above - **the single-window finding reverses in a real bear market**. The breaker only tripped under D0 in 2 of 5 windows tested. In the current window, every reset policy still looked good (as above). In a 2022-bear-heavy window, the fixed-timer reset policies (1/3/5/10 trading days) had a *slightly better return* than sticky/no-reset but a **meaningfully worse max drawdown** (-22% to -24% vs. sticky's -16%) - resetting early let the strategy re-enter positions that then kept falling with the broader market. The recovery-gated policy (reset only once drawdown improves above -10%) never triggered in that bear window and matched the sticky default exactly - arguably correct behavior, not a failure. See `CLAUDE.md`'s "Strategy performance reality" for full numbers. This is a genuine argument *against* a simple fixed-timer auto-reset as a default policy, and a mild argument *for* a recovery-gated one over a timer-based one - but still only 2 windows where the breaker actually fired, nowhere near enough to inform a live decision on its own.
- **2026-07-14**: since no reset-timing policy proved reliably safe above, built visibility instead of any auto-reset: a once-per-day Telegram reminder while halted, an audit log (`data/circuit-breaker-audit.jsonl`, trip/reminder/reset events), a required `reason` field + Telegram confirmation on the existing manual reset endpoint, and a new `GET /api/autopilot/circuit-breaker/review` endpoint (halt status, drawdown, days halted, recently-blocked signals, positions/cash) for an eventual dashboard panel. The trip alert and the reset endpoint itself already existed - this only added the reminder, the audit trail, and the review data. No auto-reset of any kind was added. See `CLAUDE.md`'s "Architecture facts" for the full design. Frontend banner/panel UI is a separate follow-up, not built yet.

### 6. Capital increases are earned, not scheduled
- [ ] Each tranche ($100 -> $1,000 -> $10,000) is unlocked by the previous tranche's own track record clearing these same gates again - not by a calendar date

## Reference numbers from the 2026-07-09 backtesting session (extended 2026-07-11)

- Baseline strategy (`v1.2-confluence-scoring`), 10 tickers, 900-day window: roughly +1.4% to +2%/year on average, highly variable by ticker (-1.4% to +6%)
- No parameter tweak tested that day (wider position sizing, post-stop-loss cooldown, trend-level filter, trend-slope filter) produced a robust, validated improvement over baseline
- Buy-and-hold outperformed the strategy substantially on trending tickers (e.g. AMD +206%, TSLA +87% over 900 days vs. the strategy's single-digit returns) - this strategy trades upside for smaller drawdowns, it is not a growth strategy, and that tradeoff should inform expectations, not just the go-live decision
- **2026-07-11**: ticker universe expanded to 13 (sector/asset-class diversified) - performance held in the same ballpark on the same window. ATR-based stops and a portfolio regime filter were both built and backtested (two non-overlapping 900-day windows for the regime filter, one covering the 2022 bear market) - neither showed strong enough, consistent-enough evidence to become the default; both ship off. Full numbers in `CLAUDE.md`'s "Strategy performance reality" section - not duplicated here to avoid the two files drifting out of sync with each other.
- **2026-07-13**: all prior backtests (including the numbers above) simulated each ticker independently with its own $10,000 - none of them modeled the bucket cap, portfolio circuit breaker, sell-fraction throttle, or daily kill switch, since those only exist for a shared account. `backtest-portfolio.ts` (new) runs all 13 tickers as one real portfolio with every one of those layers applied. First 900-day run showed the bucket cap alone binding 184 times - see `CLAUDE.md`'s "Strategy performance reality" for the full numbers. One run, not yet a validated finding.

## Log

- 2026-07-09: Checklist created after a session that added news sentiment, fundamentals, and insider-activity signals (with two off-by-default BUY filters), fixed an indicator warm-up bug in the backtest tooling, added the first unit tests, and traced the paper account's historical loss to a pre-existing automated-trading incident unrelated to the current strategy code.
- 2026-07-11: Scheduled dry-run confirmed running continuously since 2026-07-09 (gate 1 clock officially started). Expanded ticker universe from 5 to 13 (sector/asset-class diversified). Set up real CI (backend typecheck+tests, frontend lint+build) - previously the only PR check was Vercel's deploy preview. Built and backtested ATR-based stops and a portfolio regime filter (both ship off by default - mixed/inconclusive evidence, see "Reference numbers" above). Built portfolio-level concentration cap and circuit breaker (gate 5 - both ship always-on, not opt-in). Added a best-effort worker lock and order-submission idempotency (`client_order_id`). Discussed and deferred risk-based position sizing until capital reaches the $10,000 tranche. Built an opt-in fractional/notional BUY fallback (`AUTOPILOT_ALLOW_FRACTIONAL_SHARES`) so the bot can actually buy something at $100-$1,000 capital (previously 0-4 of 13 tickers were affordable as whole shares) - trades away the broker-side bracket stop-loss/take-profit for those specific positions, added as a new gate-3 item above rather than assumed safe.
- 2026-07-13: Built `backtest-portfolio.ts` - the first backtest that actually models one shared account (all portfolio-level safety layers applied) instead of 13 independent per-ticker runs. Along the way, found and fixed a real gap: the portfolio circuit breaker is sticky (never auto-recovers without a manual reset) and this backtest is the first thing to actually model that correctly. Extracted the bucket-cap/sell-throttle logic out of `autopilotWorker.ts` into `src/strategy/portfolioSafety.ts` (pure move) so it could be safely imported by a standalone script.
- 2026-07-13 (later same day): Added a next-open execution model (signal on close[d], executed at open[d+1]) alongside close-to-close, in the same script - found that the full-system variant's return inverted from +20.66% to -9.68% under next-open, because the choppier equity path tripped the -15% circuit breaker (never happened under close-to-close) and the sticky design then locked out BUYs for 78% of the window. Follow-up PR simulated reset/recovery intervention policies against that same trip (backtest-only, nothing live changed) - every policy tested beat the current sticky default, with no worse drawdown. See gate 5 and `CLAUDE.md` for full numbers.
- 2026-07-13 (later still): Extracted the single-window pipeline into a reusable `runWindowAnalysis` and built `backtest-portfolio-multiwindow.ts` to check the reset-policy finding above across 5 windows instead of one - it didn't hold up uniformly (a 2022-bear-heavy window made the fixed-timer reset policies' max drawdown meaningfully worse, not better). See gate 5 and `CLAUDE.md` for the full finding.
- 2026-07-14: Since no reset-timing policy proved reliably safe, built visibility instead of auto-reset - a daily Telegram reminder while halted, a circuit-breaker audit log, a required reason field + Telegram confirmation on the (pre-existing) manual reset endpoint, and a new review endpoint exposing halt status/drawdown/recently-blocked signals for a future dashboard panel. No auto-reset added. See gate 5 and `CLAUDE.md` for the full design.
