import React, { useState, useRef, useEffect } from "react";
import {
  Send,
  Bot,
  User,
  Activity,
  TrendingUp,
  AlertTriangle,
} from "lucide-react";

interface Message {
  id: string;
  role: "user" | "agent" | "system";
  content: string;
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "1",
      role: "system",
      content:
        "AI Trading Engine initialized. Connected to Gemini 2.5 Flash & Yahoo Finance API. Ready for queries.",
    },
  ]);
  const [inputMessage, setInputMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputMessage.trim()) return;

    const newUserMsg: Message = {
      id: Date.now().toString(),
      role: "user",
      content: inputMessage.trim(),
    };

    setMessages((prev) => [...prev, newUserMsg]);
    setInputMessage("");
    setIsLoading(true);

    try {
      // Подключаемся к нашему Express бэкенду
      const response = await fetch("http://localhost:3000/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: newUserMsg.content }),
      });

      if (!response.ok) {
        throw new Error("Network response was not ok");
      }

      const data = await response.json();

      const newAgentMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: "agent",
        content: data.reply || "No response received from the engine.",
      };

      setMessages((prev) => [...prev, newAgentMsg]);
    } catch (error) {
      console.error("Error sending message:", error);

      const errorMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: "system",
        content:
          "Connection Error: Unable to reach the backend server on port 3000.",
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0B0F19] text-slate-300 font-sans flex items-center justify-center p-4 selection:bg-blue-500/30">
      {/* Main Terminal Container */}
      <div className="w-full max-w-5xl bg-[#111827] rounded-xl shadow-2xl border border-slate-800 flex flex-col h-[90vh] overflow-hidden relative">
        {/* Decorative Grid Background overlay */}
        <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-5 pointer-events-none"></div>

        {/* Header */}
        <header className="bg-[#1F2937] border-b border-slate-800 px-6 py-4 flex items-center justify-between z-10">
          <div className="flex items-center space-x-4">
            <div className="w-10 h-10 bg-blue-600/20 rounded-lg flex items-center justify-center border border-blue-500/30">
              <Activity className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-white tracking-wide">
                Alexul-AI Trading Terminal
              </h1>
              <div className="flex items-center space-x-2">
                <span className="flex w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
                <p className="text-xs text-slate-400 font-medium">
                  System Online • Gemini 2.5 Engine
                </p>
              </div>
            </div>
          </div>
          <div className="hidden sm:flex items-center space-x-3 text-xs text-slate-500">
            <span className="flex items-center bg-[#0B0F19] px-3 py-1.5 rounded border border-slate-800">
              <TrendingUp className="w-3 h-3 mr-2 text-emerald-400" />
              Live Data
            </span>
          </div>
        </header>

        {/* Chat Area */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 scroll-smooth z-10 custom-scrollbar">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-xl px-5 py-3.5 shadow-sm flex items-start space-x-4 ${
                  msg.role === "user"
                    ? "bg-blue-600 text-white ml-auto rounded-br-sm"
                    : msg.role === "system"
                      ? "bg-rose-500/10 border border-rose-500/20 text-rose-300 w-full justify-center"
                      : "bg-[#1F2937] border border-slate-700 text-slate-200 rounded-bl-sm"
                }`}
              >
                {msg.role === "agent" && (
                  <div className="w-8 h-8 rounded-md bg-blue-500/20 border border-blue-500/30 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Bot className="w-4 h-4 text-blue-400" />
                  </div>
                )}
                {msg.role === "system" && (
                  <AlertTriangle className="w-5 h-5 mr-2" />
                )}

                <div className="flex-1">
                  <p className="text-[14px] leading-relaxed whitespace-pre-wrap">
                    {msg.content}
                  </p>
                </div>

                {msg.role === "user" && (
                  <div className="w-8 h-8 rounded-md bg-slate-800 border border-slate-700 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <User className="w-4 h-4 text-slate-400" />
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* Loading Indicator */}
          {isLoading && (
            <div className="flex justify-start">
              <div className="bg-[#1F2937] border border-slate-700 text-slate-200 rounded-xl rounded-bl-sm px-5 py-4 shadow-sm flex items-center space-x-4">
                <div className="w-8 h-8 rounded-md bg-blue-500/20 border border-blue-500/30 flex items-center justify-center flex-shrink-0">
                  <Bot className="w-4 h-4 text-blue-400" />
                </div>
                <div className="flex space-x-1.5 items-center h-full">
                  <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce"></div>
                  <div
                    className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce"
                    style={{ animationDelay: "0.15s" }}
                  ></div>
                  <div
                    className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce"
                    style={{ animationDelay: "0.3s" }}
                  ></div>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div className="p-4 bg-[#111827] border-t border-slate-800 z-10">
          <form
            onSubmit={handleSendMessage}
            className="flex items-center space-x-3 bg-[#1F2937] border border-slate-700 rounded-xl px-2 py-2 focus-within:ring-2 focus-within:ring-blue-500/40 focus-within:border-blue-500 transition-all duration-200"
          >
            <input
              type="text"
              value={inputMessage}
              onChange={(e) => setInputMessage(e.target.value)}
              placeholder="Enter ticker or ask for analysis (e.g., 'What is the price of TSLA?')..."
              disabled={isLoading}
              className="flex-1 bg-transparent border-none focus:outline-none text-[14px] text-white placeholder-slate-500 px-4 py-2"
            />
            <button
              type="submit"
              disabled={isLoading || !inputMessage.trim()}
              className="bg-blue-600 text-white px-4 py-2.5 rounded-lg hover:bg-blue-500 disabled:opacity-50 disabled:hover:bg-blue-600 transition-colors shadow-sm flex items-center"
            >
              <Send className="w-4 h-4 mr-2" />
              <span className="text-sm font-medium">Send</span>
            </button>
          </form>
        </div>
      </div>

      {/* Optional Custom Scrollbar CSS hiding */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #475569; }
      `,
        }}
      />
    </div>
  );
}
