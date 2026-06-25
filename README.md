📈 AI-Powered Algorithmic Trading OS

An autonomous trading system driven by LLM (OpenAI GPT-4o-mini), designed for market scanning, technical/fundamental analysis, and risk-managed trade execution via Alpaca API.

🚀 Current Architecture (v0.8)

LLM Engine: OpenAI API (gpt-4o-mini) using Parallel Function Calling.

Backend: Node.js, TypeScript, Express, Server-Sent Events (SSE) for live streaming.

Frontend: React, Vite, TailwindCSS, Lightweight Charts.

Broker: Alpaca Paper Trading API.

Market Data: Yahoo Finance API (yahoo-finance2).

Alerts: Telegram Bot API.

⚙️ Environment Variables (.env)

Create a .env file in the backend directory:

PORT=3000
OPENAI_API_KEY=sk-proj-...
APCA_API_KEY_ID=PK...
APCA_API_SECRET_KEY=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

# TRADE_MODE=paper # Future use

🛠️ Scripts (Backend)

npm run dev - Starts the backend server with live reload (tsx).

npm run test:backtest - Runs the isolated backtesting engine.

⚠️ Disclaimer

This is currently in the Paper Trading & Validation Phase. Do not use with live funds without implementing strict server-side Risk Management (Zod validation, daily loss limits, database journaling).
