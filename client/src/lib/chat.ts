import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, apiUrl, queryClient } from "./queryClient";
import { TIMEFRAMES, type Timeframe } from "@shared/screener";

export interface ChatModel {
  id: string;
  label: string;
  note: string;
}

export type ChatEffort = "low" | "medium" | "high";

export interface ChatHome {
  enabled: boolean;
  models: ChatModel[];
  defaultModel: string | undefined;
  efforts: ChatEffort[];
  threads: { id: number; title: string; model: string | null; updatedAt: string }[];
  /** What the owner has told the model about themselves; sent with every question. */
  notes: string;
}

export interface ChatChart {
  coin: string;
  timeframe: Timeframe;
  levels: { price: number; label: string; kind?: "entry" | "stop" | "target" | "level" }[];
}

/** A show_chart call's input as the page draws it; null when it is not one. */
export function chartOf(name: string, input: any): ChatChart | null {
  if (name !== "show_chart" || !input || typeof input.coin !== "string") return null;
  const levels = Array.isArray(input.levels) ? input.levels.filter((l: any) => typeof l?.price === "number" && l.price > 0 && typeof l?.label === "string").slice(0, 8) : [];
  return { coin: input.coin, timeframe: (TIMEFRAMES as string[]).includes(input.timeframe) ? input.timeframe : "4h", levels };
}

export interface ChatBubble {
  role: "user" | "assistant";
  text: string;
  tools: string[];
  charts?: ChatChart[];
  at: string;
  model?: string;
  usage?: { input: number; output: number; cached: number };
}

export interface ChatThread {
  id: number;
  title: string;
  model: string | null;
  messages: ChatBubble[];
}

/** What the server says while a turn is on. */
export type ChatEvent =
  | { t: "thread"; id: number; title: string }
  | { t: "text"; d: string }
  | { t: "thinking"; d: string }
  | { t: "tool"; name: string; input: unknown }
  | { t: "tool_done"; name: string; ok: boolean }
  | { t: "done"; model: string; usage: { input: number; output: number; cached: number }; note?: string }
  | { t: "error"; message: string };

export function useChatHome() {
  return useQuery<ChatHome>({ queryKey: ["/api/chat"] });
}

export function useChatThread(id: number | null) {
  return useQuery<ChatThread>({ queryKey: ["/api/chat/threads", String(id)], enabled: id != null });
}

export function useSaveChatNotes() {
  return useMutation({
    mutationFn: async (notes: string) => (await apiRequest("PUT", "/api/chat/notes", { notes })).json() as Promise<{ notes: string }>,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["/api/chat"], exact: true }),
  });
}

export function useDeleteChatThread() {
  return useMutation({
    mutationFn: async (id: number) => (await apiRequest("DELETE", `/api/chat/threads/${id}`)).json(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["/api/chat"] }),
  });
}

/**
 * Send a message and read the answer as it is written. The reply is a
 * stream of events on the request itself; each is handed to `onEvent` as
 * it arrives. Resolves when the stream ends; aborting the signal stops the
 * model too.
 */
export async function streamChat(body: { threadId: number | null; model: string; effort: ChatEffort; message: string }, onEvent: (e: ChatEvent) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch(apiUrl("/api/chat"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    credentials: "include",
    signal,
  });
  if (!res.ok || !res.body) {
    let message = `The server answered ${res.status}.`;
    try {
      message = (await res.json()).message ?? message;
    } catch {
      /* not JSON */
    }
    throw new Error(message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Events are separated by a blank line; the last piece may be half an event.
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          onEvent(JSON.parse(line.slice(5).trim()) as ChatEvent);
        } catch {
          /* a line that is not an event */
        }
      }
    }
  }
}

/** The tools' names as a person would say them. */
export const TOOL_LABEL: Record<string, string> = {
  screener_overview: "Reading the screener",
  screener_coin: "Reading the coin",
  screener_track_record: "Checking the flags' record",
  open_positions: "Reading open positions",
  trades: "Reading trades",
  trade_detail: "Reading a trade",
  trading_stats: "Working out the statistics",
  upcoming_events: "Checking the calendar",
  price_candles: "Reading the candles",
  show_chart: "Drawing a chart",
  web_search: "Searching the web",
};
