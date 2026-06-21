📈 AI-Powered Algorithmic Trading Agent

An intelligent, autonomous trading assistant built with TypeScript, Node.js, and the Google Gemini 2.5 Flash API. This agent utilizes the Human-in-the-Loop (HITL) pattern, combining real-time market data retrieval via Function Calling with LLM-based sentiment and technical analysis.

🚀 Features

Real-time Market Data: Integrates with financial APIs (Yahoo Finance) to fetch live quotes, currencies, and market states.

Agentic Function Calling: Uses Gemini 2.5 Flash to autonomously decide when to invoke local backend code based on natural language prompts.

Resilient Architecture: Built-in error handling ensures that if external APIs fail, the AI gracefully informs the user without breaking the execution context.

TypeScript Backend: Strongly typed interfaces for LLM responses and API payloads to ensure runtime safety.

🛠️ Tech Stack

Runtime: Node.js

Language: TypeScript

AI/LLM: @google/generative-ai (Gemini 2.5 Flash)

Data Parsing: yahoo-finance2

Environment: dotenv

📦 Installation & Setup

Clone the repository:

git clone https://github.com/Alexul-AI/ai-trading-agent.git
cd ai-trading-agent/backend

Install dependencies:

npm install
npm install -D tsx typescript @types/node

Environment Variables:
Create a .env file in the root of the backend directory and add your Google AI Studio API key. Note: .env must be added to .gitignore.

GEMINI_API_KEY=your_api_key_here

Run the Agent:

npx tsx agent.ts

🧠 Architecture (ReAct Pattern)

User Prompt: "What is the current price of AAPL?"

LLM Evaluation: Gemini identifies missing market context and generates a JSON Tool Call.

Local Execution: Node.js intercepts the call, fetches data from the broker/API, and returns the raw JSON to the LLM.

Synthesis: The AI generates a comprehensive, human-readable market update based on the injected data.

📄 License

MIT License. See LICENSE for more information.
