⚙️ Backend API - AI Trading OS

This directory contains the Node.js/Express server that powers the AI Trading OS. It acts as the bridge between the OpenAI LLM, the Alpaca Broker API, and the React frontend.

📦 Tech Stack

Runtime: Node.js, TypeScript

Framework: Express

AI/LLM: OpenAI SDK (gpt-4o-mini)

Market Data: yahoo-finance2

Broker: @alpacahq/alpaca-trade-api

Real-time: Server-Sent Events (SSE)

🔑 Environment Variables

Create a .env file in the backend directory with the following keys:

PORT=3000

# AI Configuration

OPENAI_API_KEY=sk-proj-...

# Alpaca Broker (Paper Trading)

APCA_API_KEY_ID=PK...
APCA_API_SECRET_KEY=...

# Notifications

TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

🚀 Installation & Scripts

Install dependencies:

npm install

Available scripts:

npm run dev - Starts the backend server with live reload on port 3000.

npm run test:backtest - Runs the isolated backtesting engine (historical data simulation).

🛡️ Security Note

Never commit your .env file. Ensure it is listed in your .gitignore.
