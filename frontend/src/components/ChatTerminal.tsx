import type { FormEvent, RefObject } from "react";
import type { ChatMessage } from "../types";

interface ChatTerminalProps {
  chatHistory: ChatMessage[];
  chatInput: string;
  isWaitingOnAI: boolean;
  chatEndRef: RefObject<HTMLDivElement | null>;
  onInputChange: (value: string) => void;
  onSendMessage: (event: FormEvent) => void;
}

export function ChatTerminal({
  chatHistory,
  chatInput,
  isWaitingOnAI,
  chatEndRef,
  onInputChange,
  onSendMessage,
}: ChatTerminalProps) {
  return (
    <div className="bg-slate-900/60 rounded-2xl border border-slate-800 flex flex-col min-h-[420px] overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-800/80 flex items-center justify-between bg-slate-900/40">
        <span className="text-xs font-black tracking-widest text-slate-400">
          CHAT TERMINAL
        </span>
        <span className="text-[10px] text-slate-500">OpenAI via backend</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {chatHistory.map((msg) => (
          <div
            key={msg.id}
            className={`flex flex-col ${
              msg.role === "user" ? "items-end" : "items-start"
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] text-slate-500 font-bold">
                {msg.timestamp}
              </span>
              <span
                className={`text-[9px] font-black tracking-wider uppercase px-1.5 rounded ${
                  msg.role === "user"
                    ? "bg-slate-800 text-slate-300"
                    : "bg-blue-900/50 text-blue-300"
                }`}
              >
                {msg.role === "user" ? "Operator" : "AI Agent"}
              </span>
            </div>

            <div
              className={`p-3 rounded-2xl text-xs max-w-[90%] leading-relaxed ${
                msg.role === "user"
                  ? "bg-slate-800 text-white rounded-tr-none"
                  : "bg-slate-950/60 text-slate-200 rounded-tl-none border border-slate-800/60"
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}

        {isWaitingOnAI && (
          <div className="p-3 bg-slate-950/60 text-slate-500 rounded-2xl border border-slate-800/60 text-xs animate-pulse">
            AI analyzing current Alpaca snapshot...
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      <form
        onSubmit={onSendMessage}
        className="p-3 bg-slate-950 border-t border-slate-800/80 flex gap-2"
      >
        <input
          type="text"
          value={chatInput}
          onChange={(event) => onInputChange(event.target.value)}
          placeholder="Ask about positions, signals, or risk..."
          className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-slate-700"
        />

        <button
          type="submit"
          disabled={isWaitingOnAI}
          className="p-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-500 text-white transition-all"
        >
          →
        </button>
      </form>
    </div>
  );
}
