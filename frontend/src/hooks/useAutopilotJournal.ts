import { useCallback, useState } from "react";

import { API_BASE_URL } from "../api/client";
import type { JournalResponse, JournalRun, JournalSummary } from "../types";
import { getErrorMessage } from "../utils";

type AddLog = (message: string) => void;

export function useAutopilotJournal(addAutopilotLog: AddLog) {
  const [journalRuns, setJournalRuns] = useState<JournalRun[]>([]);
  const [journalSummary, setJournalSummary] = useState<JournalSummary | null>(
    null,
  );
  const [journalFile, setJournalFile] = useState<string>("");
  const [isLoadingJournal, setIsLoadingJournal] = useState(false);

  const refreshAutopilotJournal = useCallback(async () => {
    setIsLoadingJournal(true);

    try {
      const [journalResponse, summaryResponse] = await Promise.all([
        fetch(`${API_BASE_URL}/api/autopilot/journal?limit=20`, {
          cache: "no-store",
        }),
        fetch(`${API_BASE_URL}/api/autopilot/journal/summary?limit=200`, {
          cache: "no-store",
        }),
      ]);

      if (!journalResponse.ok) {
        throw new Error(`Journal request failed: ${journalResponse.status}`);
      }

      if (!summaryResponse.ok) {
        throw new Error(`Journal summary failed: ${summaryResponse.status}`);
      }

      const journal = (await journalResponse.json()) as JournalResponse;
      const summary = (await summaryResponse.json()) as JournalSummary;

      setJournalRuns(journal.runs);
      setJournalFile(journal.file);
      setJournalSummary(summary);
    } catch (error) {
      addAutopilotLog(`Journal refresh failed: ${getErrorMessage(error)}`);
      console.warn("Autopilot journal refresh failed:", error);
    } finally {
      setIsLoadingJournal(false);
    }
  }, [addAutopilotLog]);

  return {
    journalRuns,
    journalSummary,
    journalFile,
    isLoadingJournal,
    refreshAutopilotJournal,
  };
}
