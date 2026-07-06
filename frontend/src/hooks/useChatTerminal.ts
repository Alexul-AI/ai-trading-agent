import { useEffect, useRef, useState, type SyntheticEvent } from "react";

import type { ChatMessage, ChatResponse } from "../types";
import { getErrorMessage } from "../utils";

type FetchWithAdminSession = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;

const INITIAL_CHAT_HISTORY: ChatMessage[] = [
  {
    id: "1",
    role: "agent",
    content:
      "Alexul-AI is online. Dashboard uses Alpaca as source of truth. Autopilot starts in dry-run mode and will not execute trades unless explicitly enabled on the backend.",
    timestamp: new Date().toLocaleTimeString(),
  },
];

export function useChatTerminal(fetchWithAdminSession: FetchWithAdminSession) {
  const [chatInput, setChatInput] = useState("");
  const [chatHistory, setChatHistory] =
    useState<ChatMessage[]>(INITIAL_CHAT_HISTORY);
  const [isWaitingOnAI, setIsWaitingOnAI] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory]);

  async function handleSendMessage(event: SyntheticEvent) {
    event.preventDefault();
    if (!chatInput.trim() || isWaitingOnAI) return;

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: "user",
      content: chatInput,
      timestamp: new Date().toLocaleTimeString(),
    };

    setChatHistory((prev) => [...prev, userMsg]);
    setChatInput("");
    setIsWaitingOnAI(true);

    try {
      const response = await fetchWithAdminSession("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMsg.content,
          history: chatHistory.map((msg) => ({
            role: msg.role,
            content: msg.content,
          })),
        }),
      });

      if (!response.ok) throw new Error(`Chat failed: ${response.status}`);
      const data = (await response.json()) as ChatResponse;

      setChatHistory((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: "agent",
          content: data.reply || "Processing complete.",
          timestamp: new Date().toLocaleTimeString(),
        },
      ]);
    } catch (error) {
      setChatHistory((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          role: "agent",
          content: `API connection error: ${getErrorMessage(error)}`,
          timestamp: new Date().toLocaleTimeString(),
        },
      ]);
    } finally {
      setIsWaitingOnAI(false);
    }
  }

  return {
    chatInput,
    chatHistory,
    isWaitingOnAI,
    chatEndRef,
    setChatInput,
    handleSendMessage,
  };
}
