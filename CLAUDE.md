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
- **RSI/MACD warm-up bug**: both use recursive/Wilder smoothing seeded from `bars[0]` and need ~150 bars of runway before they're numerically accurate — a short series gives biased or literally-wrong values, not just "less precise" ones. This existed in three separate places and was fixed in all three: `backtest.ts`, `backtest-sweep.ts`, and the live ticker chart (`src/market/alpacaMarketData.ts` fetches extra warm-up history, `src/market/chartPoints.ts` trims after computing, not before). **If you add any new code that computes RSI/MACD over a bar series, apply the same pattern** — fetch/compute with 150+ bars of history before the window you actually care about, don't just fetch exactly what you plan to display.
- Alpha Vantage free tier is 25 requests/day **for the whole key**, shared between local dev and production. Fundamentals are cached 24h in `agent.ts` (`getFundamentals`) — don't remove that cache without a replacement.
- SEC EDGAR aggressively rate-limits by IP (Akamai). Don't loop/hammer it during manual testing — a 403 "Request Rate Threshold Exceeded" can persist 30+ minutes and retrying faster only extends it.
- Two BUY-side filters exist (`AUTOPILOT_SENTIMENT_FILTER`, `AUTOPILOT_INSIDER_FILTER` env vars) — **off by default on purpose**. They cannot be backtested (the underlying APIs only return current data, not point-in-time history), so enabling either is an unvalidated, conscious opt-in, not a proven improvement. Both fail open on fetch errors (never block a trade just because the API call failed) and cache results 24h per ticker.

## Strategy performance reality (from backtesting done 2026-07-09)

- Baseline strategy: roughly +1.4% to +2%/year average across 10 large-cap tickers, highly ticker-dependent (-1.4% to +6%).
- Every parameter tweak tried that day either did nothing real (turned out to be a warm-up-bug artifact) or was a net loss on a risk-adjusted basis (wider position sizing is just leverage, not edge; a cooldown after stop-loss made things worse; trend filters only "worked" by overfitting to specific tickers).
- Buy-and-hold massively outperformed the strategy on trending tickers in the same window (e.g. AMD +206% vs. the strategy's single-digit return). This strategy trades upside for smaller drawdowns by design — it is not a growth strategy, and that tradeoff should inform any discussion of expected returns.
- Don't re-propose "just widen the position size" or "just add a trend filter" as improvements without checking `GOLIVE_CRITERIA.md` and this history first — both were already tried and rejected with evidence.

## Paper account history

Equity dipped from a $100k starting balance (confirmed via Alpaca's JNLC ledger entry) mostly because of a **~$13,444 realized loss from an automated-trading incident, 2026-06-22 to 2026-06-29** (over 1,100 buy/sell fills on AMD alone, executed seconds apart — clearly a runaway script, not `strategyEngine.ts`'s current logic, which has cooldowns that make that firing pattern impossible). This predates this session and is not an ongoing risk. The user disabled manual trading (`ALLOW_MANUAL_TRADES=false`) afterward.

## Testing

`vitest` set up 2026-07-09 (`npm test` in `backend/`). Deliberately scoped to pure, high-risk decision logic, not full coverage: `strategyEngine.decideTradeSignal`, `riskManager.evaluateTrade`, the two autopilot veto filters, the SEC Form 4 XML parser, chart-indicator trimming, and the journal tail-read. No tests for API routes, SSE, or the frontend — that's a known, accepted gap, not an oversight.

## Deliberately not built (and why, so it isn't re-litigated from scratch)

- **Fundamentals-based BUY filter**: timescale mismatch. P/E and dividend yield change quarterly; this strategy holds positions for days to weeks. Either the filter never fires, or it permanently blocks the exact high-growth tickers (high P/E) that back-tested best.
- **Backtesting the sentiment/insider/fundamentals signals**: not possible with current data sources — Alpaca News, Alpha Vantage, and SEC EDGAR only expose current state, not a point-in-time historical snapshot.

## Before trusting anything above as still true

Memory files (including this one) are snapshots. Before acting on a specific claim here — a file path, an env var, a numeric threshold — verify it still matches the current code/config, the same way you would for any other memory. Things that can silently drift: whether the two BUY filters are still off, what's actually set in Render's env vars (not visible from local `.env`), and today's actual git branch/PR state.
