# Project context for Claude

This file is loaded automatically at the start of every session in this repo. Read [README.md](README.md) for architecture and [GOLIVE_CRITERIA.md](GOLIVE_CRITERIA.md) for the live-trading readiness checklist before making strategy/risk changes.

## Who the user is

Not a financial/trading expert — explain things in plain terms, not jargon. Wants the bot to eventually run with minimal ongoing effort from them (see goals below). Prefers direct, honest engineering assessments over cheerleading — has explicitly asked to be told when something won't work rather than encouraged to keep trying anyway.

## Goals

- Near-term: passive income above 200 ILS/month from this bot.
- Long-term: grow that with **minimal manual effort** — the bot should run unattended, not need babysitting.
- Planned capital path: $100 → $1,000 → $10,000, but **each increase should be earned by the previous tranche's track record, not by a calendar date**. See GOLIVE_CRITERIA.md.

## Hard boundaries (do not cross these)

- **Never execute a trade** (paper or live) on the user's behalf, even if explicitly asked — this is a standing rule, not a one-time refusal. Direct the user to do it themselves (Alpaca dashboard or the app's manual-order UI, currently disabled by the user on purpose).
- **Never give personalized investment advice** ("should I buy X", "is now a good time"). Give math, backtested facts, and mechanics; the decision is always the user's.
- Currently `TRADE_MODE=paper` and `AUTOPILOT_EXECUTE_TRADES=false` (dry-run only) — do not change either without the user explicitly asking, and treat flipping `AUTOPILOT_EXECUTE_TRADES` to `true` as a meaningful step worth confirming even though it's still paper money.

## Workflow rule (starting 2026-07-10)

Work on `claude/<feature-name>` branches and open a PR (`gh pr create`) instead of pushing directly to `main`. **Do not merge a PR without the user's explicit approval**, even if typecheck/tests/build all pass. (Everything committed before 2026-07-10 went straight to `main` — that history doesn't need to be redone, this rule applies going forward.)

## Live infrastructure

- Backend: Render, `https://ai-trading-agent-i4nr.onrender.com`, auto-deploys on push to `main`. Admin token protection is **enabled** in prod (unlike local dev) — admin-gated endpoints need a session/token there.
- Frontend: Vercel, `https://alexul-ai-trading-agent.vercel.app`, auto-deploys on push to `main`.
- Render's disk **persists across deploys** for this service (confirmed empirically — the journal survived ~10 redeploys in one session). Not guaranteed by Render's docs for all plans, but observed true here.
- `.env` is local-only and gitignored — **new env vars added locally must also be added in the Render dashboard manually**, or the deployed instance silently runs without them. This already caused a production bug once (`ALPHA_VANTAGE_API_KEY`).

## Architecture facts that aren't obvious from the code alone

- `strategyEngine.ts`'s `decideTradeSignal` is the single source of truth for BUY/SELL/HOLD. Used live via `autopilotWorker.ts` and in `backtest.ts` / `backtest-sweep.ts`. Any strategy change must be reasoned about in both contexts.
- **RSI/MACD warm-up bug**: both use recursive/Wilder smoothing seeded from `bars[0]` and need ~150 bars of runway before they're numerically accurate — a short series gives biased or literally-wrong values, not just "less precise" ones. This existed in three separate places and was fixed in all three: `backtest.ts`, `backtest-sweep.ts`, and the live ticker chart (`src/market/alpacaMarketData.ts` fetches extra warm-up history, `src/market/chartPoints.ts` trims after computing, not before). **If you add any new code that computes RSI/MACD over a bar series, apply the same pattern** — fetch/compute with 150+ bars of history before the window you actually care about, don't just fetch exactly what you plan to display. ATR (`indicators.ts` `calculateATR`) follows the same convention.
- Three BUY-side filters/toggles now exist, all **off by default on purpose**: `AUTOPILOT_SENTIMENT_FILTER` and `AUTOPILOT_INSIDER_FILTER` (unbacktestable - the underlying APIs only return current data, not point-in-time history - both fail open on fetch errors and cache 24h per ticker) and `AUTOPILOT_REGIME_FILTER` (backtestable, but results across two non-overlapping 900-day windows were mixed - see "Strategy performance reality" below). `useAtrStops` in `strategyEngine.ts`'s config is a related but separate toggle (also off by default) for ATR-based vs flat-percent stop-loss/take-profit distance.
- **Fractional/notional BUY fallback** (`AUTOPILOT_ALLOW_FRACTIONAL_SHARES`, added 2026-07-11, off by default): whole-share sizing (`Math.floor(cash / price)`) yields 0 shares for most/all of the 13 tickers below ~$1,000-3,000 of capital, silently blocking BUY signals at the user's actual planned starting capital ($100-$1,000). When enabled, a BUY that would otherwise size to 0 whole shares falls back to a notional dollar order instead (min $5, via `strategyEngine.ts`'s `suggestedNotional` field) - but that order does **not** get Alpaca's broker-side bracket stop_loss/take_profit (unconfirmed whether brackets work with fractional/notional sizing in Alpaca's API), relying solely on `decideTradeSignal`'s own cycle-based STOP_LOSS/TAKE_PROFIT re-evaluation instead. This is why it's opt-in like the sentiment/insider filters, not always-on like the bucket cap - it trades protection for capability, not a pure risk reduction. Whole-share sizing is completely unchanged whenever it yields >= 1 share, so this only ever affects behavior at low capital. Threaded through all four BUY-path layers: `strategyEngine.ts` (sizing) → `autopilotWorker.ts`'s `getSafeBuyNotionalForBucketCap` (bucket cap, dollar-based) → `server.ts`'s `executeSafeTrade` (builds a `notional` order payload with `time_in_force=day`, no `order_class=bracket`) → `riskManager.ts`'s `evaluateTrade` (dollar-based re-check, used by the shared manual+autopilot execution path).
- Portfolio-level risk layers, layered on top of the per-ticker 20%-equity cap: **circuit breaker** (`portfolioCircuitBreaker.ts`, always on, not a toggle) blocks new BUYs when equity drops `AUTOPILOT_MAX_DRAWDOWN_FROM_PEAK_PERCENT` (default -15%) from its peak - peak equity is *derived* each cycle from Alpaca's own `getPortfolioHistory` (not tracked in our own state), so a lost/corrupted local state file only costs a re-bootstrapped tracking window, not a wrong number. **Bucket concentration cap** (`getSafeBuySharesForBucketCap` in `autopilotWorker.ts`, always on) caps combined exposure per asset-class bucket (`TICKER_TO_BUCKET`: `us_broad`/`international`/`bonds`/`commodities`/`high_beta_growth`) at `AUTOPILOT_MAX_BUCKET_EQUITY_FRACTION` (default 40%) - same bucket grouping is reused by the regime filter. Neither of these is a `useAtrStops`/`AUTOPILOT_REGIME_FILTER`-style opt-in; both are always-on downside-only guardrails, same category as the pre-existing per-ticker cap.
- **Worker lock is best-effort, not a true distributed lock** (`autopilotWorkerLock.ts`). Without a shared coordination service (Redis/Postgres), a local lock file only protects against an old/new process overlapping on the same host during a deploy - it provides zero protection if Render ever runs genuinely separate instances with separate disks. Whether Render's persistent disk is shared across instances for this service is an open question, not yet confirmed.
- **Order submission uses a `client_order_id`** (`orderIdempotency.ts`, wired into `server.ts`'s `executeSafeTrade`) to make a same-signal retry safe: the ID is held per ticker+action until a *definitive* outcome (success or a real rejection), not regenerated per call, so a retry after an ambiguous network error reuses the same ID and resolves via Alpaca's own duplicate-ID rejection instead of risking a second real order.
- Alpha Vantage free tier is 25 requests/day **for the whole key**, shared between local dev and production. Fundamentals are cached 24h in `agent.ts` (`getFundamentals`) — don't remove that cache without a replacement.
- SEC EDGAR aggressively rate-limits by IP (Akamai). Don't loop/hammer it during manual testing — a 403 "Request Rate Threshold Exceeded" can persist 30+ minutes and retrying faster only extends it.
- CI (`.github/workflows/ci.yml`, added 2026-07-10) runs backend typecheck + vitest and frontend lint + build on every PR/push to `main` - before that, the only PR check was Vercel's deployment preview, which never ran backend tests at all.

## Risk/safety layers as of 2026-07-11 (quick reference)

| Layer | Default | Scope |
|---|---|---|
| Per-ticker 20% equity cap (`strategyEngine.ts`) | always on | caps one ticker's position size |
| Bucket concentration cap (40%) | always on | caps combined exposure per asset-class bucket |
| Portfolio circuit breaker (-15% from peak) | always on | blocks new BUYs account-wide, never SELLs |
| Order idempotency (`client_order_id`) | always on | prevents a same-signal retry from double-submitting |
| Worker lock (best-effort) | always on | same-host deploy-overlap protection only, see above |
| Sentiment / insider BUY filters | off | unbacktestable, unvalidated opt-in |
| Portfolio regime filter | off | backtested, mixed/inconclusive results |
| ATR-based stop-loss/take-profit | off | backtested, roughly matches flat % |
| Fractional/notional BUY fallback | off | trades bracket stop-loss/take-profit protection for low-capital capability |

## Strategy performance reality (from backtesting done 2026-07-09, extended 2026-07-11)

- Baseline strategy: roughly +1.4% to +2%/year average across 10 large-cap tickers, highly ticker-dependent (-1.4% to +6%).
- Every parameter tweak tried on 2026-07-09 either did nothing real (turned out to be a warm-up-bug artifact) or was a net loss on a risk-adjusted basis (wider position sizing is just leverage, not edge; a cooldown after stop-loss made things worse; trend filters only "worked" by overfitting to specific tickers).
- Buy-and-hold massively outperformed the strategy on trending tickers in the same window (e.g. AMD +206% vs. the strategy's single-digit return). This strategy trades upside for smaller drawdowns by design — it is not a growth strategy, and that tradeoff should inform any discussion of expected returns.
- **2026-07-11**: ticker universe expanded from 5 correlated tech names to 13 spanning sectors/asset classes (`AMD,NVDA,AAPL,MSFT,TSLA,JPM,JNJ,XOM,PG,SPY,GLD,TLT,EFA`) - validated on the same 900-day window, average return held in the same ~1-3%/yr ballpark while the new sector-spread tickers showed meaningfully smaller max drawdowns than the tech-heavy five.
- **ATR-based stops** (`useAtrStops`): first calibration (2.5x stop / 4.5x take-profit ATR multiplier) was a clean net negative (avg return +1.64% vs +3.05% baseline). A wider 3.5x/6x calibration roughly matched baseline on return/drawdown while meaningfully improving win-rate consistency on the most volatile tickers - "roughly matches baseline" wasn't judged strong enough evidence to flip the default on, so it ships off with the 3.5x/6x numbers as `DEFAULT_STRATEGY_CONFIG`'s (unused-unless-enabled) defaults.
- **Portfolio regime filter** (`AUTOPILOT_REGIME_FILTER`): tested on two non-overlapping 900-day windows (one of which - confirmed via SPY's own buy-and-hold, -25.4% max drawdown - included the 2022 bear market) with three variants (exempt high-beta tickers from the filter / don't exempt them / gate high-beta tickers by the broad market's own regime instead of a self-referential composite). Drawdown improved consistently across all three variants and both windows; the effect on *return* was inconsistent between windows and between variants - no clean winner, ships off.
- Don't re-propose "just widen the position size," "just add a trend filter," "just add ATR-based stops," or "just add a regime filter" as improvements without checking `GOLIVE_CRITERIA.md` and this history first — all were already tried and either rejected or shipped off-by-default with mixed/inconclusive evidence.

## Paper account history

Equity dipped from a $100k starting balance (confirmed via Alpaca's JNLC ledger entry) mostly because of a **~$13,444 realized loss from an automated-trading incident, 2026-06-22 to 2026-06-29** (over 1,100 buy/sell fills on AMD alone, executed seconds apart — clearly a runaway script, not `strategyEngine.ts`'s current logic, which has cooldowns that make that firing pattern impossible). This predates this session and is not an ongoing risk. The user disabled manual trading (`ALLOW_MANUAL_TRADES=false`) afterward.

## Testing

`vitest` set up 2026-07-09 (`npm test` in `backend/`, 124 tests as of 2026-07-11). Deliberately scoped to pure, high-risk decision logic, not full coverage: `strategyEngine.decideTradeSignal` (including the fractional/notional fallback), `riskManager.evaluateTrade` (including notional-mode sizing), the two autopilot veto filters, the SEC Form 4 XML parser, chart-indicator trimming, the journal tail-read, and (added 2026-07-11) `portfolioCircuitBreaker` (drawdown evaluation + peak-since-tracking), `portfolioRegimeFilter` (bucket regime + BUY suppression), `getSafeBuySharesForBucketCap`/`getSafeBuyNotionalForBucketCap`, `getSafeSellShares`, `isSignalReadyDecision`, `autopilotWorkerLock` (lock-claim evaluation), and `orderIdempotency` (error classification + client-order-id lifecycle). No tests for API routes, SSE, or the frontend — that's a known, accepted gap, not an oversight (this includes `server.ts`'s notional order-payload construction, verified only via typecheck/manual sanity-check, not a unit test). CI (`.github/workflows/ci.yml`) runs this suite plus typecheck on every PR/push to `main`.

## Deliberately not built (and why, so it isn't re-litigated from scratch)

- **Fundamentals-based BUY filter**: timescale mismatch. P/E and dividend yield change quarterly; this strategy holds positions for days to weeks. Either the filter never fires, or it permanently blocks the exact high-growth tickers (high P/E) that back-tested best.
- **Backtesting the sentiment/insider/fundamentals signals**: not possible with current data sources — Alpaca News, Alpha Vantage, and SEC EDGAR only expose current state, not a point-in-time historical snapshot.
- **Risk-based position sizing** (size by $ risk to stop-loss distance, instead of a flat % of equity): deferred until capital scales up, not rejected. Real prices checked 2026-07-11 against the actual 13-ticker universe: at $100 capital, the 20% single-position cap ($20) can't buy even 1 whole share of any of the 13 tickers (cheapest is TLT at ~$85) — the bot cannot open a position at all at this tranche, regardless of sizing formula. At $1,000 (cap $200), only 4 of 13 (TLT/EFA/XOM/PG) are buyable, and only as a binary 1-share-or-0 choice — there's no gradient for a smarter formula to size. Only at the $10,000 tranche does share count reach a real range (roughly 2-23 shares across the universe at then-current prices) where risk-based sizing would actually produce a different result than the flat equity-fraction cap. Revisit when capital reaches that tranche, not before. (The "no fractional shares anywhere in the codebase" blocker this note originally referenced was addressed the same day - see `AUTOPILOT_ALLOW_FRACTIONAL_SHARES` above - but risk-based sizing itself is still not worth building until share counts are large enough for a formula to matter.)

## Before trusting anything above as still true

Memory files (including this one) are snapshots. Before acting on a specific claim here — a file path, an env var, a numeric threshold — verify it still matches the current code/config, the same way you would for any other memory. Things that can silently drift: whether the sentiment/insider/regime BUY filters and `useAtrStops` are still off, what's actually set in Render's env vars (not visible from local `.env`, including whether `AUTOPILOT_TICKERS` there matches the 13-ticker code default), and today's actual git branch/PR state.
