import OpenAI from "openai";
import dotenv from "dotenv";

import { createAlpacaNews } from "./src/market/alpacaNews.js";
import { createNewsSentimentAnalyzer } from "./src/market/newsSentiment.js";
import { createAlphaVantageFundamentals } from "./src/market/alphaVantageFundamentals.js";
import {
  getRecentInsiderTransactions,
  getRecentPersonnelFilings,
} from "./src/market/secEdgar.js";
import { createPersonnelSummarizer } from "./src/market/personnelSummary.js";
import type {
  NewsSentimentResult,
  FundamentalResult,
  InsiderActivityResult,
} from "./src/types/serverTypes.js";

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

export type SentimentData = NewsSentimentResult;

export type FundamentalData = FundamentalResult;

export type InsiderActivityData = InsiderActivityResult;

export interface AgentResponse {
  text: string;
  chartData?: ChartPoint[];
  ticker?: string;
  portfolio?: PortfolioAllocation[];
  technicalData?: TechnicalData;
  sentimentData?: SentimentData;
  fundamentalData?: FundamentalData;
  insiderActivityData?: InsiderActivityData;
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

const alpacaNews = createAlpacaNews({
  keyId: process.env.APCA_API_KEY_ID ?? "",
  secretKey: process.env.APCA_API_SECRET_KEY ?? "",
});

const newsSentimentAnalyzer = createNewsSentimentAnalyzer(openai);

const alphaVantageFundamentals = createAlphaVantageFundamentals({
  apiKey: process.env.ALPHA_VANTAGE_API_KEY ?? "",
});

const personnelSummarizer = createPersonnelSummarizer(openai);

const SYSTEM_PROMPT = `You are Alexul-AI Trading Agent.

Yahoo Finance has been removed from this project.
The backend uses Alpaca as the source of truth for account, positions, orders, execution and watchlist prices.

Rules:
1. Do not claim you checked Yahoo Finance.
2. Do not claim you checked live news, sentiment, fundamentals, RSI, MACD, Bollinger Bands or historical charts unless that data is explicitly present in the user's message or came back from a tool call in this conversation.
3. If current Alpaca account/watchlist context is included in the user message, use it.
4. If the user asks about news, sentiment, or what is happening with a stock, call get_news_sentiment instead of answering from memory.
5. If the user asks about fundamentals, valuation, P/E, dividends, or analyst ratings, call get_fundamentals instead of answering from memory.
6. If the user asks about insider trading, insider buying/selling, or executive/leadership changes, call get_insider_activity instead of answering from memory.
7. If the user asks to trade, never pretend execution in plain text. Use execute_trade.
8. The backend RiskManager has final authority and can reject or reduce trades.
9. Default to conservative paper-trading behavior.
10. Keep answers practical and concise.`;

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
          takeProfit: { type: "number" },
        },
        required: ["ticker", "action", "shares"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_transaction_history",
      description: "Returns local paper-trading transaction history.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
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
          budget: { type: "number" },
        },
        required: ["tickers", "budget"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_news_sentiment",
      description:
        "Fetches real recent news headlines for a ticker from Alpaca and classifies overall sentiment as BULLISH, BEARISH, or NEUTRAL, plus notable events like product launches, earnings, or leadership changes explicitly mentioned in the headlines.",
      parameters: {
        type: "object",
        properties: {
          ticker: { type: "string" },
        },
        required: ["ticker"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_fundamentals",
      description:
        "Fetches real company fundamentals for a ticker from Alpha Vantage: market cap, P/E ratio, forward P/E, dividend yield, 52-week high/low, and analyst consensus rating.",
      parameters: {
        type: "object",
        properties: {
          ticker: { type: "string" },
        },
        required: ["ticker"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_insider_activity",
      description:
        "Fetches real SEC EDGAR filings for a ticker: recent Form 4 insider transactions (flagging open-market purchases/sales separately from routine option exercises and tax withholding) and recent 8-K Item 5.02 filings summarizing executive/director departures or appointments.",
      parameters: {
        type: "object",
        properties: {
          ticker: { type: "string" },
        },
        required: ["ticker"],
      },
    },
  },
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
  return history.flatMap(
    (item): OpenAI.Chat.Completions.ChatCompletionMessageParam[] => {
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
    },
  );
}

/**
 * Standalone news sentiment lookup, usable outside the chat tool loop
 * (e.g. a REST endpoint or a future dashboard panel).
 */
export async function getNewsSentiment(
  ticker: string,
): Promise<NewsSentimentResult> {
  const articles = await alpacaNews.fetchRecentNews(ticker, 8);

  return newsSentimentAnalyzer.analyzeSentiment(ticker, articles);
}

/**
 * Standalone fundamentals lookup, usable outside the chat tool loop
 * (e.g. a REST endpoint or a future dashboard panel).
 */
export async function getFundamentals(
  ticker: string,
): Promise<FundamentalResult> {
  return alphaVantageFundamentals.fetchFundamentals(ticker);
}

/**
 * Standalone insider activity lookup, usable outside the chat tool loop
 * (e.g. a REST endpoint or a future dashboard panel). Combines Form 4
 * insider transactions with LLM-summarized 8-K Item 5.02 personnel filings.
 */
export async function getInsiderActivity(
  ticker: string,
): Promise<InsiderActivityResult> {
  const [transactions, rawPersonnelFilings] = await Promise.all([
    getRecentInsiderTransactions(ticker),
    getRecentPersonnelFilings(ticker),
  ]);

  const personnelFilings = await Promise.all(
    rawPersonnelFilings.map((filing) => personnelSummarizer.summarize(filing)),
  );

  return {
    ticker: ticker.toUpperCase(),
    transactions,
    personnelFilings,
  };
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
  let latestSentimentData: NewsSentimentResult | undefined;
  let latestFundamentalData: FundamentalResult | undefined;
  let latestInsiderActivityData: InsiderActivityResult | undefined;

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
          const orderType = toStringValue(
            args.orderType,
            "market",
          ).toLowerCase();
          const limitPrice =
            args.limitPrice === undefined
              ? undefined
              : toNumberValue(args.limitPrice);
          const stopLoss =
            args.stopLoss === undefined
              ? undefined
              : toNumberValue(args.stopLoss);
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
      } else if (functionName === "get_news_sentiment") {
        const ticker = toStringValue(args.ticker).toUpperCase();

        if (!ticker) {
          toolResult = { error: "Ticker is required." };
        } else {
          try {
            const articles = await alpacaNews.fetchRecentNews(ticker, 8);
            const result = await newsSentimentAnalyzer.analyzeSentiment(
              ticker,
              articles,
            );

            latestSentimentData = result;
            toolResult = result;
          } catch (error) {
            toolResult = {
              error:
                error instanceof Error
                  ? error.message
                  : "Failed to fetch news sentiment.",
            };
          }
        }
      } else if (functionName === "get_fundamentals") {
        const ticker = toStringValue(args.ticker).toUpperCase();

        if (!ticker) {
          toolResult = { error: "Ticker is required." };
        } else {
          try {
            const result =
              await alphaVantageFundamentals.fetchFundamentals(ticker);

            latestFundamentalData = result;
            toolResult = result;
          } catch (error) {
            toolResult = {
              error:
                error instanceof Error
                  ? error.message
                  : "Failed to fetch fundamentals.",
            };
          }
        }
      } else if (functionName === "get_insider_activity") {
        const ticker = toStringValue(args.ticker).toUpperCase();

        if (!ticker) {
          toolResult = { error: "Ticker is required." };
        } else {
          try {
            const result = await getInsiderActivity(ticker);

            latestInsiderActivityData = result;
            toolResult = result;
          } catch (error) {
            toolResult = {
              error:
                error instanceof Error
                  ? error.message
                  : "Failed to fetch insider activity.",
            };
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
    sentimentData: latestSentimentData,
    fundamentalData: latestFundamentalData,
    insiderActivityData: latestInsiderActivityData,
  };
}
