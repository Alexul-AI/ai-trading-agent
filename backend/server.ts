import express from "express";
import cors from "cors";
import { runTradingAgentStep, getWatchlistQuotes } from "./agent.js";

const app = express();
const PORT = 3000;

app.use(express.json());

app.use(
  cors({
    origin: "http://localhost:5173",
  }),
);

app.post("/api/chat", async (req, res) => {
  const { message, history } = req.body;

  if (!message) {
    res.status(400).json({ error: "Message field is required." });
    return;
  }

  console.log(`\n💬 [SERVER] Received message from user: "${message}"`);

  try {
    const agentResponse = await (runTradingAgentStep as any)(message, history);

    console.log(`✉️ [SERVER] Sending response back to client`);
    res.json({
      reply: agentResponse.text,
      chartData: agentResponse.chartData,
      ticker: agentResponse.ticker,
    });
  } catch (error: any) {
    console.error(`\n❌ [SERVER ERROR]:`, error);
    res.status(500).json({
      error: "Failed to process request with AI Engine.",
      details: error.message || error,
    });
  }
});

app.post("/api/watchlist", async (req, res) => {
  const { tickers } = req.body;

  if (!tickers || !Array.isArray(tickers)) {
    res.status(400).json({ error: "Tickers array is required." });
    return;
  }

  try {
    const quotes = await getWatchlistQuotes(tickers);
    res.json(quotes);
  } catch (error: any) {
    console.error(`\n❌ [SERVER ERROR] Watchlist API failed:`, error);
    res.status(500).json({ error: "Failed to fetch watchlist quotes" });
  }
});

app.listen(PORT, () => {
  console.log(
    `\n🚀 [SERVER] Trading Agent API is running on http://localhost:3000`,
  );
  console.log(`📡 [SERVER] Awaiting requests from frontend...\n`);
});
