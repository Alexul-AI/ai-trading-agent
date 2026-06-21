import express from "express";
import cors from "cors";
import { runTradingAgentStep } from "./agent.js"; // Keep .js extension for ES Modules resolution

const app = express();
const PORT = process.env.PORT || 3000;

// Configure CORS security rules to allow requests from the React frontend (running on port 5173)
app.use(
  cors({
    origin: "http://localhost:5173",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  }),
);

app.use(express.json());

// Main API endpoint for processing chat requests from the frontend
app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    console.log(`\n💬 [SERVER] Received message from user: "${message}"`);

    // Execute a single turn of the Gemini AI Trading Agent
    const agentResponse = await runTradingAgentStep(message);

    console.log(`✉️ [SERVER] Sending response back to client`);
    res.json({ response: agentResponse });
  } catch (error: any) {
    console.error("❌ [SERVER ERROR]:", error);
    res
      .status(500)
      .json({ error: "Internal Server Error", details: error.message });
  }
});

// Start the Express HTTP server
app.listen(PORT, () => {
  console.log(
    `\n🚀 [SERVER] Trading Agent API is running on http://localhost:${PORT}`,
  );
  console.log(`📡 [SERVER] Awaiting requests from frontend...`);
});
