import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

export interface ChartPoint {
  date: string;
  time: string;
  price: number;
}

export interface PortfolioAllocation {
  ticker: string;
  percentage: number;
  amount: number;
  reasoning: string;
}

export interface TechnicalData {
  rsi: number;
  macd: number;
  signal: number;
  histogram: number;
  bb: { lower: number; sma: number; upper: number };
  state: string;
}

export interface SentimentData {
  sentiment: "BULLISH" | "BEARISH" | "NEUTRAL";
  summary: string;
}

export interface FundamentalData {
  ticker: string;
  marketCap: string;
  peRatio: string;
  forwardPE: string;
  dividendYield: string;
  fiftyTwoWeekHigh: string;
  fiftyTwoWeekLow: string;
  analystRating: string;
}

export interface AgentResponse {
  text: string;
  chartData?: ChartPoint[];
  ticker?: string;
  portfolio?: PortfolioAllocation[];
  technicalData?: TechnicalData;
  sentimentData?: SentimentData;
  fundamentalData?: FundamentalData;
}

type ExecuteTradeCallback = (
  ticker: string,
  action: string,
  shares: number,
  orderType: string,
  limitPrice?: number,
  stopLoss?: number,
  takeProfit?: number,
) => Promise<unknown>;

type ToolArguments = Record<string, unknown>;

interface HistoryItem {
  role?: unknown;
  content?: unknown;
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SYSTEM_PROMPT = `You are Alexul-AI Trading Agent.

Yahoo Finance has been removed from this project.
The backend uses Alpaca as the source of truth for account, positions, orders, execution and watchlist prices.

Rules:
1. Do not claim you checked Yahoo Finance.
2. Do not claim you checked live news, fundamentals, RSI, MACD, Bollinger Bands or historical charts unless that data is explicitly present in the user's message.
3. If current Alpaca account/watchlist context is included in the user message, use it.
4. If the user asks to trade, never pretend execution in plain text. Use execute_trade.
5. The backend RiskManager has final authority and can reject or reduce trades.
6. Default to conservative paper-trading behavior.
7. Keep answers practical and concise.`;

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "execute_trade",
      description:
        "Executes a paper-trading order through the backend. Backend uses Alpaca and RiskManager.",
      parameters: {
        type: "object",
        properties: {
          ticker: { type: "string" },
          action: { type: "string", enum: ["BUY", "SELL"] },
          shares: { type: "number" },
          orderType: { type: "string", enum: ["market", "limit"] },
          limitPrice: { type: "number" },
          stopLoss: { type: "number" },
          takeProfit: { type: "number" }
        },
        required: ["ticker", "action", "shares"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_transaction_history",
      description: "Returns local paper-trading transaction history.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "analyze_portfolio",
      description:
        "Creates a simple allocation suggestion based only on user-provided tickers and budget. This does not fetch external data.",
      parameters: {
        type: "object",
        properties: {
          tickers: { type: "array", items: { type: "string" } },
          budget: { type: "number" }
        },
        required: ["tickers", "budget"]
      }
    }
  }
];

function parseToolArguments(rawArguments: string | undefined): ToolArguments {
  if (!rawArguments) return {};

  try {
    const parsed: unknown = JSON.parse(rawArguments);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as ToolArguments)
      : {};
  } catch {
    return {};
  }
}

function toStringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function toNumberValue(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: "Could not serialize tool result" });
  }
}

function normalizeHistory(
  history: unknown[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return history.flatMap((item): OpenAI.Chat.Completions.ChatCompletionMessageParam[] => {
    const record =
      typeof item === "object" && item !== null ? (item as HistoryItem) : {};

    const role = toStringValue(record.role);
    const content = toStringValue(record.content);

    if (!content) return [];

    if (role === "user") {
      return [{ role: "user", content }];
    }

    if (role === "agent" || role === "assistant") {
      return [{ role: "assistant", content }];
    }

    return [];
  });
}

/**
 * Backwards compatibility for server.ts.
 * Yahoo screener has been removed; this is now a static default watchlist.
 */
export async function getTrendingStocks(): Promise<string[]> {
  return ["NVDA", "AAPL", "TSLA", "MSFT", "AMD"];
}

/**
 * Backwards compatibility for older server.ts versions.
 * Prefer Alpaca watchlist quotes in server.ts.
 */
export async function getWatchlistQuotes(tickers: string[]) {
  return tickers.map((ticker) => ({
    ticker: ticker.toUpperCase(),
    name: ticker.toUpperCase(),
    price: 0,
    change: 0,
    isUp: true,
  }));
}

export async function runTradingAgentStep(
  userMessage: string,
  history: unknown[] = [],
  transactionHistory: unknown[] = [],
  executeTradeCallback?: ExecuteTradeCallback,
): Promise<AgentResponse> {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...normalizeHistory(history),
    { role: "user", content: userMessage },
  ];

  let response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages,
    tools,
  });

  let message = response.choices[0]?.message;
  let iterations = 0;
  const maxIterations = 3;

  while (
    message?.tool_calls &&
    message.tool_calls.length > 0 &&
    iterations < maxIterations
  ) {
    iterations += 1;

    messages.push(
      message as OpenAI.Chat.Completions.ChatCompletionMessageParam,
    );

    for (const toolCall of message.tool_calls) {
      if (toolCall.type !== "function") continue;

      const functionName = toolCall.function.name;
      const args = parseToolArguments(toolCall.function.arguments);

      let toolResult: unknown;

      if (functionName === "get_transaction_history") {
        toolResult =
          transactionHistory.length === 0
            ? { result: "No trades executed yet." }
            : { result: transactionHistory };
      } else if (functionName === "analyze_portfolio") {
        const tickersRaw = args.tickers;
        const budget = toNumberValue(args.budget);

        const tickers = Array.isArray(tickersRaw)
          ? tickersRaw
              .map((ticker) => toStringValue(ticker).toUpperCase())
              .filter(Boolean)
          : [];

        if (tickers.length === 0 || budget <= 0) {
          toolResult = {
            error: "Please provide tickers and a positive budget.",
          };
        } else {
          const equalPercentage = Math.floor(100 / tickers.length);
          const equalAmount = budget / tickers.length;

          toolResult = {
            portfolio: tickers.map((ticker) => ({
              ticker,
              percentage: equalPercentage,
              amount: Number(equalAmount.toFixed(2)),
              reasoning:
                "Equal-weight placeholder allocation. External Yahoo data has been removed.",
            })),
          };
        }
      } else if (functionName === "execute_trade") {
        if (!executeTradeCallback) {
          toolResult = {
            status: "rejected",
            reason: "Trade execution callback is not available.",
          };
        } else {
          const ticker = toStringValue(args.ticker).toUpperCase();
          const action = toStringValue(args.action).toUpperCase();
          const shares = toNumberValue(args.shares);
          const orderType = toStringValue(args.orderType, "market").toLowerCase();
          const limitPrice =
            args.limitPrice === undefined
              ? undefined
              : toNumberValue(args.limitPrice);
          const stopLoss =
            args.stopLoss === undefined ? undefined : toNumberValue(args.stopLoss);
          const takeProfit =
            args.takeProfit === undefined
              ? undefined
              : toNumberValue(args.takeProfit);

          if (!ticker || !["BUY", "SELL"].includes(action) || shares <= 0) {
            toolResult = {
              status: "rejected",
              reason: "Invalid trade request.",
            };
          } else {
            toolResult = await executeTradeCallback(
              ticker,
              action,
              shares,
              orderType,
              limitPrice,
              stopLoss,
              takeProfit,
            );
          }
        }
      } else {
        toolResult = {
          error: `Unknown tool: ${functionName}`,
        };
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: safeJson(toolResult),
      });
    }

    response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages,
      tools,
    });

    message = response.choices[0]?.message;
  }

  return {
    text:
      typeof message?.content === "string" && message.content.trim()
        ? message.content
        : "Done.",
  };
}
