# PRD: AI Trading Agent как система дополнительного пассивного дохода

Живой продуктовый документ. Обновляется по мере прохождения gates и появления новых research-находок. Технические детали конкретных находок (числа, окна, конфиги) живут в `CLAUDE.md` и `GOLIVE_CRITERIA.md` — этот файл не дублирует их, а ссылается.

## 1. Vision

Создать личную систему алгоритмического инвестирования, которая со временем сможет давать дополнительный пассивный доход для семьи, не являясь основным источником жизни.

Основной доход и финансовая устойчивость пользователя не должны зависеть от торгового бота. Бот — это satellite-project вокруг финансовых рынков: исследование, небольшая автоматизация, контроль риска и постепенный переход от dry-run к paper trading и только затем к маленькому live capital.

Финансовая философия проекта:
- основной капитал не должен подвергаться риску экспериментов;
- бот должен сначала доказать поведение в тестовой среде;
- увеличение капитала должно быть заслужено результатами;
- главная метрика — не "сколько заработал", а "сколько заработал на единицу риска";
- доходность 1–3%/год недостаточна как цель, но попытка любой ценой поднять доходность не должна превращать проект в казино.

Внешняя рамка: инвестиционный риск нельзя устранить полностью; SEC/Investor.gov и FINRA отдельно подчёркивают, что asset allocation, diversification и понимание risk tolerance — базовые инструменты управления риском, а day trading несёт повышенный риск.

## 2. Current State

### 2.1 Что уже есть

Проект сейчас включает: backend на Node/Express/TypeScript, frontend на React/Vite/TypeScript, интеграцию с Alpaca, paper/live режимы, strategy engine на RSI/MACD/Bollinger, server-side risk limits, bucket concentration cap, sticky portfolio circuit breaker, daily kill switch, order idempotency, worker lock, decision journal, portfolio-level backtest, next-open execution model, multi-window validation, Telegram alerts, audit log, circuit-breaker review endpoint, frontend banner/review/reset UI.

README описывает систему как autonomous/manual algorithmic trading system с modular architecture, confluence-based technical engine, paper/live режимами и telemetry.

### 2.2 Текущее стратегическое ограничение

Базовая стратегия `v1.2-confluence-scoring` исторически показывала около 1.4–2%/год в старых backtest'ах, с сильным отставанием от buy-and-hold на трендовых тикерах. `GOLIVE_CRITERIA.md` прямо фиксирует, что это не growth strategy: она меняет upside на smaller drawdowns.

Portfolio-level backtest дал более полезную картину, чем старые per-ticker тесты: один shared cash pool, bucket cap, circuit breaker, sell throttle и daily kill switch. Но next-open execution показал, что full-system результат может резко ухудшиться из-за взаимодействия исполнения на следующий день и sticky circuit breaker.

### 2.3 Главное понимание

Проблема уже не в том, что "бот технически сырой". Проблема теперь в другом:

> Бот стал достаточно защищённым и наблюдаемым, но пока не доказал устойчивый источник доходности выше 1–3%/год.

## 3. Product Goals

### 3.1 Бизнес-цели

1. Построить систему, которая потенциально сможет давать дополнительный доход от финансовых рынков.
2. Не ставить под риск основной капитал семьи.
3. Довести систему от dry-run до paper execution, затем до small live tranche.
4. Улучшить стратегическую доходность выше 1–3%/год только через проверяемые research-гипотезы.
5. Сделать проект portfolio-grade: его можно показывать как серьёзный AI/fintech/risk-engineering проект.

### 3.2 Финансовые ориентиры

Цель "200 ₪/месяц" означает примерно 2,400 ₪/год до налогов, комиссий, валютных эффектов и просадок.

| Капитал | 200 ₪/мес требует |
| --------: | ----------------: |
| 10,000 ₪ | 24%/год |
| 25,000 ₪ | 9.6%/год |
| 50,000 ₪ | 4.8%/год |
| 100,000 ₪ | 2.4%/год |

Вывод: на маленьком капитале цель 200 ₪/месяц требует слишком высокой доходности. Поэтому на этапах $100–$1,000 цель не "пассивный доход", а **доказательство механики**. Реальный денежный смысл появляется ближе к $10,000+ или при очень стабильной стратегии.

## 4. Non-Goals

Проект не должен:
- торговать основным капиталом;
- давать обещание дохода;
- становиться day-trading/scalping системой;
- требовать ежедневного ручного управления;
- использовать LLM как окончательного исполнителя сделок;
- включать live trading из-за одного красивого backtest;
- повышать риск только ради красивой доходности;
- включать auto-reset circuit breaker без доказательств;
- использовать sentiment/insider-фильтры как доказанные сигналы, пока нет point-in-time истории.

## 5. Target Operating Model

### 5.1 Personal Financial Context

Это не требование к системе, а контекст, объясняющий, почему бот должен оставаться ограниченной satellite-аллокацией и не трогать основной капитал.

| Слой | Назначение | Риск |
| --- | --- | --- |
| Core capital | Индексы / долгосрочный капитал семьи | Низко-средний |
| Satellite trading bot (этот проект) | Маленький экспериментальный капитал | Средний |
| Crypto/staking lab (отдельный проект) | Отдельный высокорисковый эксперимент | Высокий |

Бот не обязан технически отслеживать весь семейный портфель — он просто проектируется с учётом того, что core capital не трогаем, и не конкурирует с индексным портфелем как "основной двигатель капитала". Его роль — маленькая тактическая добавка и исследовательская платформа.

### 5.2 Operating modes

| Mode | Описание | Цель |
| --- | --- | --- |
| Dry-run | Бот считает решения, но не отправляет paper orders | Проверка сигналов и observability |
| Paper execution | Бот реально отправляет paper orders | Проверка execution, stops, caps |
| Micro live | Очень маленький live capital | Проверка реального брокера/психологии/операций |
| Scaled live | Увеличение капитала по результатам | Только после gates |

## 6. Roadmap

Roadmap намеренно "lean": не строить сразу всю research-платформу и все strategy families. Сначала — минимальный scorecard и один strategy candidate (ETF Rotation), доведённый до конца через все gates. Остальные направления (Trend Participation, Hybrid Allocator) — опциональны и рассматриваются только если первый кандидат недостаточен.

### Phase 0 — Clean Baseline

**Цель:** зафиксировать текущую систему как безопасную baseline-платформу.

- PR #23 merged (требует отдельного явного подтверждения — не мержится автоматически как часть roadmap-работы).
- Документация (`CLAUDE.md`, `GOLIVE_CRITERIA.md`) отражает актуальное состояние после merge.
- Stop/park criteria добавлены (см. Phase 6).
- Tax/infrastructure риски добавлены (см. Phase 0.5 и Phase 3).
- Crypto-секция сокращена (см. раздел 14).

**Acceptance:** `main` clean, CI green, PR #23 merged, нет open claims "strategy validated", явно написано, что live trading не включён.

### Phase 0.5 — Tax & Reporting Readiness Gate

До любого live capital — не только перед масштабированием, а перед самым первым $100–$250 tranche.

Для резидента Израиля, торгующего через зарубежного брокера (USD-активы, возможные capital gains, dividends, FX conversion), это реальный, не чисто технический риск. На сайте רשות המסים есть отдельная категория для foreign income/assets и capital gains по foreign/Israeli securities; есть официальный сервис подачи годового отчёта для физических лиц. Общий принцип (PwC и др.): резиденты Израиля в целом платят capital gains tax при продаже активов независимо от того, где актив находится — но это не заменяет консультацию с רואה חשבון.

Чеклист:
1. Поговорить с רואה חשבון, который понимает foreign broker trading.
2. Понять, какие отчёты нужны по foreign securities.
3. Понять, как считать USD/ILS conversion.
4. Понять, как учитывать dividends, realized gains/losses.
5. Понять, создаёт ли частая торговля лишнюю отчётную нагрузку.
6. Добавить export для `trades.csv` / realized P&L / FX notes.
7. Оценить, не съедает ли учёт/бухгалтерия весь смысл маленького live account.

Это не юридическая консультация от бота или от Claude — только PM-risk чеклист.

### Phase 1 — Minimal Scorecard

Не строить огромную research platform. Единый стандарт оценки — но только необходимый минимум:
- total return, CAGR, max drawdown, Calmar;
- exposure, trades;
- benchmark vs SPY / equal-weight buy-and-hold;
- next-open как основной результат (close-to-close — только для сравнения, не для решений);
- multi-window summary (обязателен для любого go/no-go решения).

Sharpe/Sortino/profit factor/expectancy — добавляются позже, не блокируют MVP.

**Acceptance:** любая новая стратегия получает один markdown/csv report; нельзя считать стратегию "лучше", если она проверена только на одном окне; next-open всегда выводится как основной результат; strategy change без scorecard не мержится.

**Статус (2026-07-14): реализовано.** `backend/scorecard.ts` — CAGR, max drawdown, Calmar, exposure, trades, benchmark comparison (SPY/equal-weight). Wired в `backtest-portfolio.ts` (markdown-секция "## Scorecard" в существующем отчёте) и `backtest-portfolio-multiwindow.ts` (таблица "Scorecard by window", NEXT_OPEN variant D, добавлена в общий `multi-window-summary.csv`). Sharpe/Sortino/profit factor/expectancy сознательно не реализованы — как и договаривались, не блокируют MVP. Проверено на реальных данных: total return для "Current (~900d)" совпал с уже известным числом (-9.68%), направление annualization подтверждено вручную. Побочная находка: annualизация короткого окна (41 день) даёт математически верный, но вводящий в заблуждение CAGR (+42.71% от +4.08% total return) — добавлено предупреждение в отчёт при `simDays < 180`.

### Phase 2 — ETF Rotation MVP

Первый настоящий income-strategy candidate. Выбран первым (не Trend Participation), потому что: меньше single-stock/earnings-gap risk, меньше сделок, проще налоговый учёт, ближе к пассивному стилю и к реальной цели пользователя — не "быстро разбогатеть", а аккуратно поискать дополнительную доходность.

- Universe: US broad market (SPY-подобный), Nasdaq/growth proxy, international equities, bonds, gold/commodities, cash proxy.
- Частота: раз в неделю или месяц.
- Логика: держать 2–4 сильнейших по relative momentum, если они выше long-term trend filter; иначе частично уходить в defensive/cash.

**Acceptance:** тестируется multi-window next-open; не хуже текущего baseline по risk-adjusted метрикам; drawdown приемлем в bear-окнах; меньше сделок, чем текущий бот; операционно проще. Если доходность ниже SPY, но drawdown сильно ниже — стратегия всё ещё может быть полезна как defensive sleeve.

### Phase 3 — Paper Execution (ETF Rotation only)

Переход от dry-run к paper orders — но только для ETF Rotation, если она прошла Phase 2's gate.

**Paper Infrastructure Gate** (перед `AUTOPILOT_EXECUTE_TRADES=true`) — перенесено сюда с этапа $10K tranche, потому что paper execution должен доказывать live-like поведение, а значит инфраструктура должна быть проверена уже здесь, а не позже:
1. Confirm deployment — ровно один worker instance.
2. Confirm persistent disk behavior.
3. Simulate restart while circuit breaker is tripped.
4. Simulate restart with pending/ambiguous order state.
5. Confirm audit/journal survives deploy.
6. Confirm alerts работают после restart.
7. Confirm no duplicate worker cycles.
8. Emergency stop задокументирован.

Текущий same-host lock (`autopilotWorkerLock.ts`) может быть достаточен для одного Render instance и маленького капитала, но это предположение должно быть проверено, а не принято на веру.

**Paper stage requirements:**
- минимум 4–6 недель scheduled paper execution;
- минимум 20–30 closed paper trades, лучше 50+ перед любыми live-деньгами;
- проверить в paper: stop-loss fired, take-profit fired, bucket cap blocked, circuit breaker tripped or simulated, reset flow tested, no duplicate orders, no order without journal entry, all alerts arrive.

### Phase 4 — Micro Live Capital

**Цель:** проверить реальный рынок минимальной суммой, а не заработать. Только после Phase 0.5 (tax gate) пройдена.

Capital tranche 1: $100–$250 максимум, no margin, no options, no crypto внутри этого бота, no leverage, no intraday scalping, no manual override кроме emergency, max loss budget определён заранее.

Цель на этом транше — не доходность, а проверка: реальные fills, slippage, taxes/reporting friction, психология, поведение брокера, alerts, reset workflow, операции.

**Unlock to $1,000** только если: минимум 2–3 месяца live micro-stage без критических инцидентов, no duplicate order, no unreviewed halt, paper/live поведение не расходится драматически, drawdown в ожидаемом диапазоне, monthly review сделан, все сделки объяснимы.

**Unlock to $10,000** только если: $1,000 tranche прошёл минимум 3–6 месяцев, стратегия показывает positive expectancy, max drawdown приемлем, есть стабильный reporting, есть налоговое понимание, есть emergency stop, есть backup plan на случай отказа Render/Vercel/Alpaca.

### Phase 5 — Trend Participation (опционально, только если ETF Rotation недостаточна)

Trend Participation больше не обязательный следующий шаг — это optional second candidate, и он должен рассматриваться скептически, а не как очевидное развитие.

**Важно: это должно быть явно связано с уже проверенной историей.** Уже тестировались ATR-based stop идеи: первая калибровка была отрицательной, более широкая примерно совпала с baseline, но не дала достаточно сильного основания сменить default (см. `CLAUDE.md`, "Strategy performance reality"). Новая гипотеза — это не "просто шире stop / позже exit", а другой режим стратегии: сначала определить, что актив в тренде, и только потом менять exit behavior.

| | Старый ATR-test | Новый Trend Participation |
| --- | --- | --- |
| Что меняет | stop/take-profit механику | сам режим стратегии |
| Когда применяется | почти универсально | только при trend confirmation |
| Механизм | ATR-множитель | SMA/momentum/weekly trend filter |
| Цель | лучше exits | участие в больших трендах |
| Риск | просто шире держать позицию | false trend / late entry |

This rhymes with prior ATR-stop experiments and must be treated skeptically. It is only worth pursuing if trend-regime detection changes outcomes materially versus simply widening exits — то есть это hypothesis with prior negative evidence nearby, не "очевидный next step".

**Условие для запуска этой фазы:** if ETF Rotation cannot pass its research target (Phase 2 acceptance) but the project still shows overall promise, then test Trend Participation as a second candidate. Signals: price > SMA200, SMA50 > SMA200, 3m/6m momentum positive, weekly trend confirms, no fixed take-profit in trend mode, trailing stop instead of early full exit.

**Acceptance:** next-open multi-window CAGR выше baseline; max drawdown не ухудшается непропорционально; Calmar/Sortino лучше или равны baseline; не держит high-beta bucket бесконтрольно.

Hybrid Allocator (несколько sleeve'ов с разными весами) откладывается ещё дальше — рассматривается только если и ETF Rotation, и Trend Participation по отдельности доказали ценность.

### Phase 6 — Stop / Park Decision

Это симметричный gate к gates роста — без него roadmap однобокий: если всё хорошо, наращиваем капитал; если всё плохо, просто продолжаем исследовать бесконечно. Это опасно.

**Проект остаётся research-only и не переходит в live (или замораживается на текущей стадии), если выполняется хотя бы одно:**

1. После 3–6 месяцев paper execution лучшая стратегия не показывает преимущества над простым ETF/индексным benchmark по risk-adjusted метрикам.
2. После 3 полноценных strategy-итераций ни одна стратегия не проходит minimum target (next-open multi-window результат стабильно лучше baseline; max drawdown приемлем; strategy не ломается в bear window; результат не держится только на одном окне).
3. Operational overhead становится слишком высоким: нужно ежедневно проверять, часто ломается data/API, слишком много ручных решений, алерты превращаются в постоянный стресс.
4. Налоговая/учётная сложность (Phase 0.5) делает маленький live capital бессмысленным.
5. Paper/live поведение расходится настолько, что backtest перестаёт быть полезным.
6. Проект начинает мешать основным юридическим/медицинским процессам, связанным с инвалидностью, תקנה 9 или אובדן כושר עבודה.

**Вывод в таком случае:** live trading ambition parked. Проект остаётся research/portfolio/demo tool. Капитал не увеличивается.

Это не "сдаться". Это нормальный PM-gate: проект может быть полезен как GitHub/fintech/research проект, даже если не становится денежной машиной.

## 7. Revenue / Return Targets

### 7.1 Minimum acceptable goal

1–3%/год не стоит технического риска, если это требует постоянной поддержки.

```
Strategy should target at least 6–8% annualized in next-open multi-window portfolio backtests,
with max drawdown materially lower than equal-weight buy-and-hold,
or with clearly better risk-adjusted metrics.
```

### 7.2 Stretch target

```
8–12% annualized with max drawdown controlled under ~15–20% in harsh windows.
```

Это не guarantee и не promise — только research target.

### 7.3 Reject condition

Стратегия отклоняется, если:
- выигрывает только в одном окне;
- ухудшает bear-market drawdown;
- требует постоянного ручного reset;
- делает слишком много сделок;
- получает доходность только через larger position sizing;
- хуже SPY по доходности и не лучше по drawdown;
- слишком чувствительна к close-to-close assumption;
- ломается на next-open.

## 8. Risk Management Requirements

### Always-on protections

Per-position cap, bucket cap, daily kill switch, sticky portfolio circuit breaker, order idempotency, SELL allowed even when BUY blocked, audit trail, Telegram alert, frontend halted banner, manual reset with reason.

### Policies not approved yet

Fixed-timer auto-reset, automatic recovery reset, staged re-entry, changing -15% threshold, increasing max bucket exposure, margin, options, crypto execution.

### Important lesson from research

Fixed-timer reset looked good in one current window, but failed in 2022 bear-heavy by worsening max drawdown. Recovery-gated reset behaved more conservatively, but there are too few breaker-trip windows to approve it.

Therefore: live product should keep sticky manual breaker, but make it visible and reviewable (уже реализовано через PR #22/#23).

## 9. UX Requirements

### Dashboard must show

Mode (dry-run/paper execution/live), trade mode (paper/live), execution enabled, circuit breaker status, cash, exposure, equity, drawdown, last run, next run, last decision, active positions, blocked signals, alerts status.

### Circuit breaker panel

Реализовано через PR #22/#23: halted banner, review panel, blocked signals, positions/cash, reset form with reason, no auto-reset.

### Future UX

"Research dashboard" отдельно от "Live dashboard"; monthly performance report; strategy comparison charts; capital tranche progress; "Can increase capital?" checklist; "Why no trade?" explanation.

## 10. Engineering Roadmap

- **PR A — Safety baseline release**: merge PR #23, update docs, tag `v0.3-safety-review-workflow`.
- **PR B — Minimal strategy scorecard**: CAGR/max drawdown/Calmar/exposure/trades + benchmark comparison, next-open primary, multi-window summary mandatory.
- **PR C — ETF Rotation MVP**: universe, weekly/monthly rebalance, relative momentum ranking, defensive/cash state, compare vs SPY/equal-weight.
- **PR D — Paper execution gate**: paper infrastructure gate (restart/disk/lock simulation), UI switch for paper execution status, daily paper report.
- **PR E — Micro live gate**: live-mode checklist screen, hard capital cap, max monthly loss cap, "live enabled until date" expiring permission, emergency stop button.
- **PR F — Trend Participation (optional)**: только если PR C не проходит Phase 2's acceptance — strategyMode, SMA50/SMA200, momentum, trailing stop, полная multi-window next-open валидация с явной ссылкой на прошлый ATR-эксперимент.

Детали каждой стратегии — в разделе 6 (Phase 2, Phase 5), не дублируются здесь.

## 11. Success Metrics

### Research metrics

Next-open CAGR, max drawdown, Sortino, Calmar, exposure, turnover, profit factor, expectancy, benchmark comparison, multi-window consistency. (Phase 1 поставляет подмножество — CAGR/max drawdown/Calmar/exposure/trades/benchmark — Sharpe/Sortino/profit factor/expectancy добавляются позже, не блокируют MVP.)

### Operational metrics

Uptime, missed cycles, stale data incidents, rejected orders, duplicate prevention events, alert delivery success, audit log completeness.

### Financial metrics

Realized P&L, unrealized P&L, monthly return, rolling 3-month return, max drawdown, income withdrawn, high-water mark.

## 12. Decision Gates

### Gate 1 — Research Candidate

Стратегия может стать paper candidate только если: тестирована на multi-window next-open; превосходит baseline по risk-adjusted метрикам; не ломается катастрофически в bear window; результаты задокументированы; код использует тот же `strategyEngine` путь, что и live.

### Gate 2 — Paper Candidate

Paper execution можно включить только если: safety workflow завершён; audit + alerts работают; paper account настроен; нет open critical bugs; manual stop path задокументирован.

### Gate 3 — Micro Live Candidate

Live на $100–$250 можно начать только если: 4–6 недель paper execution; 20–30+ closed paper trades; risk mechanisms наблюдались; нет необъяснённых ордеров; нет критических инцидентов; Phase 0.5 (tax gate) пройден; пользователь явно одобряет.

### Gate 4 — Capital Increase

Капитал можно увеличивать только если: предыдущий транш прошёл свой собственный track record; не по календарю; drawdown приемлем; live-поведение соответствует research-ожиданиям; пользователь эмоционально готов к просадке; нет конфликта с юридическими/льготными процессами. См. также Phase 6 — если срабатывает любой stop/park критерий, капитал не увеличивается независимо от прочих условий.

## 13. Strategy Priority Order

Путь к доходности выше 1–3% — не через больше индикаторов, больше сделок, больший размер позиции или больший риск. Путь — через новые strategy families, лучшее участие в трендах, ETF rotation, portfolio allocation, лучшие exits, более высокую exposure только в благоприятных режимах.

Приоритет (обновлён — ETF Rotation теперь первый кандидат, Trend Participation опционален):

1. **ETF Rotation** — первый и основной кандидат (Phase 2).
2. **Trend Participation** — только если ETF Rotation не проходит research target (Phase 5), и обязательно с явной ссылкой на прошлый ATR-эксперимент.
3. **Hybrid Allocator** — откладывается ещё дальше; рассматривается только если оба предыдущих направления по отдельности доказали ценность.
4. Risk-based position sizing — позже, только около $10,000 транша.
5. Sentiment/insider signals — только как telemetry, не как торговый фильтр.
6. Crypto/staking — отдельный research-проект, не часть этого бота (см. раздел 14).

## 14. Crypto / Staking Project Positioning

Crypto/staking dashboard (`agentic-staking-dashboard-poc`) — отдельный high-risk research проект. Он не должен быть частью income-плана или capital-allocation gates этого бота. Подробный risk-list (smart contract/protocol/token/liquidity/bridge risk) — в отдельном PRD для staking dashboard, не здесь.

## 15. Final Recommendation

1. Закончить safety/ops loop (Phase 0, включая merge PR #23 с явным подтверждением).
2. Пройти Tax & Reporting Readiness Gate до первого live-транша (Phase 0.5).
3. Построить минимальный scorecard (Phase 1) — не полную research-платформу.
4. Довести ETF Rotation (Phase 2) до конца через все gates первым.
5. Валидировать всё multi-window с next-open как основным результатом.
6. Только затем включить paper execution (Phase 3), с проверенной инфраструктурой.
7. Только после paper evidence — начать маленький live capital (Phase 4).
8. Увеличивать капитал только по пройденным gates (Gate 4), с постоянной проверкой Phase 6 (stop/park criteria).
9. Trend Participation и Hybrid Allocator — опциональны, рассматриваются только если ETF Rotation недостаточна.

Проект не должен гнаться за 1–3% — это слишком мало для операционной сложности. Но он также не должен гнаться за 20–30% через безрассудную автоматизацию.

Реалистичная цель продукта:

> Построить маленькую, контролируемую, evidence-based рыночную систему, которая может со временем давать 6–10%+ годовых на маленькой satellite-аллокации, с drawdown и операциями под контролем настолько, чтобы это не угрожало основной финансовой устойчивости семьи — и с честным критерием остановки, если это не получается.
