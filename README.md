# AI Trading Agent 📈

An autonomous and manual algorithmic trading system built with Node.js, React, and the Alpaca Trade API. It features a strict modular architecture, real-time observability, and a confluence-based technical analysis engine.

## 🚀 Overview

The AI Trading Agent is designed to operate in both `paper` and `live` trading environments. It evaluates market conditions every minute using a custom scoring algorithm (`v1.2-confluence-scoring`) based on RSI, MACD, and Bollinger Bands.

The system prioritizes **capital preservation** and **observability**. It includes mathematical risk limits (position caps, cash fraction limits) and generates verbose telemetry reports explaining the exact causality behind every `BUY`, `SELL`, or `HOLD` decision.

## 🏗 Architecture

The codebase strictly adheres to modular and clean architecture principles, utilizing Dependency Injection and Custom Hooks to separate business logic from the presentation layer.

### Backend (Node.js / Express / TypeScript)

- **`server.ts`**: The main orchestrator and router. Contains no business logic.
- **`src/market/alpacaMarketData.ts`**: Isolated Alpaca API client for fetching quotes, bars, and market clocks.
- **`src/auth/adminAuth.ts`**: Secure session management and API endpoint protection.
- **`strategyEngine.ts`**: The core quantitative math engine. Calculates signal confluence and enforces risk limits.

### Frontend (React / Vite / TypeScript)

- **`App.tsx`**: The main UI orchestrator. Completely stateless.
- **Custom Hooks (`src/hooks/`)**:
  - `useDashboardData.ts`: Polls portfolio and watchlist states.
  - `useAutopilotStream.ts`: Manages Server-Sent Events (SSE) for real-time trade execution logs.
  - `useManualOrder.ts`: Handles UI-driven trades with built-in safety locks.
  - `useAdminSessionFetch.ts`: HTTP interceptor for seamless credential management.

## ⚙️ Environment Variables (`.env`)

Create a `.env` file in the `backend` directory before running the project. Do not commit it to Git:

```env
# Server & Mode
PORT=3000
FRONTEND_ORIGIN=http://localhost:5173
TRADE_MODE=paper # 'paper' or 'live'

# Broker (Alpaca)
APCA_API_KEY_ID=PK...
APCA_API_SECRET_KEY=...

# AI & Alerts
OPENAI_API_KEY=sk-proj-...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

# Security & Admin
ADMIN_API_TOKEN=your_secure_token
ADMIN_PASSWORD=your_secure_password
ADMIN_SESSION_SECRET=your_random_secret_string
ALLOW_MANUAL_TRADES=false
🛡 Risk Management & Strategy
The bot utilizes a multi-factor technical strategy:

Buy Confluence: Requires momentum shifts (MACD rising, RSI oversold) and price proximity to lower Bollinger Bands.

Sell Confluence: Triggered by overbought conditions, trailing stop-losses, or strict take-profit percentages.

Risk Limits:

maxPositionEquityFraction: Prevents any single asset from dominating the portfolio (e.g., max 20%).

maxBuyCashFraction: Limits cash exposure per single trade.

🔬 Telemetry & Diagnostics
Observability is a first-class citizen. If the bot stops trading or behaves unexpectedly, you do not need to read raw server logs.

Run the diagnostics collector to generate a human-readable telemetry archive:

Bash
node ./scripts/collect-diagnostics.cjs --limit=500 --zip-only
This generates a flat .zip file containing:

decisions.report.md: A human-readable markdown summary of the latest portfolio state, risk caps, and closest signals.

latest-decision-summary.csv: The most recent actions evaluated by the engine.

health.json & status.json: Core system metadata and build markers.

⚙️ Setup & Development
Installation
Clone the repository.

Install dependencies for both frontend and backend:

Bash
cd backend && npm install
cd ../frontend && npm install
Start the development servers:

Bash
# Terminal 1 (Backend)
cd backend && npm run dev

# Terminal 2 (Frontend)
cd frontend && npm run dev
⚠️ Disclaimer
This system is currently optimized for Paper Trading & Validation. Do not use with live funds without thoroughly backtesting your strategy configuration and verifying the strict server-side risk management limits.
```
