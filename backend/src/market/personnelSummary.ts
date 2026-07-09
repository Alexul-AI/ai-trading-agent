// Personnel filing summarizer.
// Turns a real SEC 8-K Item 5.02 filing excerpt into a one-sentence
// summary of the leadership change it describes.

import type OpenAI from "openai";
import type { PersonnelFiling } from "../types/serverTypes.js";
import type { RawPersonnelFiling } from "./secEdgar.js";

const SUMMARY_PROMPT = `You are a corporate filings summarizer. You will be given a real excerpt from an SEC 8-K filing, Item 5.02 (departure/appointment of directors or officers).

Summarize the leadership or personnel change described in one concise sentence: who left, who joined, what role, and the effective date if mentioned. Base your answer only on the provided text.

Respond with strict JSON only, no prose: {"summary": "one sentence summary"}`;

function parseSummaryJson(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { summary?: unknown };

    return typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim()
      : "Could not summarize this filing.";
  } catch {
    return "Could not summarize this filing.";
  }
}

export function createPersonnelSummarizer(openai: OpenAI) {
  async function summarize(
    filing: RawPersonnelFiling,
  ): Promise<PersonnelFiling> {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SUMMARY_PROMPT },
        { role: "user", content: filing.rawText },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? "{}";

    return {
      filingDate: filing.filingDate,
      itemCodes: filing.itemCodes,
      summary: parseSummaryJson(raw),
      filingUrl: filing.filingUrl,
    };
  }

  return { summarize };
}
