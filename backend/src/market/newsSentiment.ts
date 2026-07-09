// News sentiment service.
// Turns real, fetched headlines into a structured BULLISH/BEARISH/NEUTRAL
// read plus notable events (product launches, earnings, leadership changes).
// Never invents sentiment from a ticker symbol alone - if there is no news,
// it returns NEUTRAL with an explicit "no recent news" summary.

import type OpenAI from "openai";
import type { AlpacaNewsArticle, NewsSentimentResult } from "../types/serverTypes.js";

const SENTIMENT_PROMPT = `You are a financial news classifier. You will be given real, recently-fetched headlines and summaries for one stock ticker.

Classify the overall short-term market sentiment implied by these headlines as BULLISH, BEARISH, or NEUTRAL.
Also extract up to 3 notable events (product announcements, earnings, leadership/personnel changes, major partnerships or lawsuits) explicitly mentioned in the headlines. If none are present, return an empty list.

Respond with strict JSON only, no prose, in this exact shape:
{"sentiment": "BULLISH" | "BEARISH" | "NEUTRAL", "summary": "one or two sentence summary", "notableEvents": ["short event description", ...]}

Base your answer only on the provided headlines. Do not use outside knowledge about the company.`;

function buildHeadlinesBlock(articles: AlpacaNewsArticle[]): string {
  return articles
    .map(
      (article, index) =>
        `${index + 1}. [${article.createdAt}] ${article.headline}${
          article.summary ? ` — ${article.summary}` : ""
        } (source: ${article.source})`,
    )
    .join("\n");
}

function parseSentimentJson(raw: string): {
  sentiment: NewsSentimentResult["sentiment"];
  summary: string;
  notableEvents: string[];
} {
  try {
    const parsed = JSON.parse(raw) as {
      sentiment?: unknown;
      summary?: unknown;
      notableEvents?: unknown;
    };

    const sentiment =
      parsed.sentiment === "BULLISH" || parsed.sentiment === "BEARISH"
        ? parsed.sentiment
        : "NEUTRAL";

    const summary =
      typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim()
        : "No summary available.";

    const notableEvents = Array.isArray(parsed.notableEvents)
      ? parsed.notableEvents.filter(
          (event): event is string => typeof event === "string",
        )
      : [];

    return { sentiment, summary, notableEvents };
  } catch {
    return {
      sentiment: "NEUTRAL",
      summary: "Could not parse sentiment from news headlines.",
      notableEvents: [],
    };
  }
}

export function createNewsSentimentAnalyzer(openai: OpenAI) {
  async function analyzeSentiment(
    ticker: string,
    articles: AlpacaNewsArticle[],
  ): Promise<NewsSentimentResult> {
    if (articles.length === 0) {
      return {
        ticker,
        sentiment: "NEUTRAL",
        summary: `No recent news found for ${ticker}.`,
        notableEvents: [],
        articleCount: 0,
        articles: [],
      };
    }

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SENTIMENT_PROMPT },
        {
          role: "user",
          content: `Ticker: ${ticker}\n\nHeadlines:\n${buildHeadlinesBlock(articles)}`,
        },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const { sentiment, summary, notableEvents } = parseSentimentJson(raw);

    return {
      ticker,
      sentiment,
      summary,
      notableEvents,
      articleCount: articles.length,
      articles,
    };
  }

  return { analyzeSentiment };
}
