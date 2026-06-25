🖥️ Frontend UI - AI Trading OS

This directory contains the user interface for the AI Trading OS. It is a modern React application built with Vite, designed to display real-time portfolio updates, interactive charts, and communicate with the AI agent.

📦 Tech Stack

Framework: React, Vite

Language: TypeScript

Styling: Tailwind CSS

Icons: Lucide React

Charting: Lightweight Charts (TradingView)

🔑 Environment Variables

Create a .env file in the frontend directory. This tells the UI where to find the backend server.

VITE_API_BASE_URL=http://localhost:3000

🚀 Installation & Scripts

Install dependencies:

npm install

Available scripts:

npm run dev - Starts the Vite development server (usually on port 5173).

npm run build - Compiles the TypeScript code and builds the app for production.

npm run preview - Locally previews the production build.

🔌 Connection

Ensure the backend server is running simultaneously so the dashboard can fetch portfolio data, connect to the SSE stream, and send chat prompts to the AI.
