import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Check, Loader2, MessageSquarePlus, Square, Trash2, Wrench, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/markdown";
import { usePublicMode } from "@/lib/public-mode";
import { queryClient } from "@/lib/queryClient";
import { streamChat, TOOL_LABEL, useChatHome, useChatThread, useDeleteChatThread, type ChatBubble, type ChatEffort, type ChatThread } from "@/lib/chat";

const MODEL_KEY = "edgeline.chat.model";
const EFFORT_KEY = "edgeline.chat.effort";
const EFFORT_LABEL: Record<ChatEffort, string> = { low: "Quick", medium: "Balanced", high: "Thorough" };

const STARTERS = [
  "Which coins are strongest right now, and is it their own strength or just beta?",
  "Review my open positions: what is the risk, and is anything unprotected?",
  "How have I traded this month? What is working and what is not?",
  "Suggest up to two setups from the screener, with the invalidation for each.",
];

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const keep = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* fine */
  }
};

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** The turn being answered: the question, and the answer as far as it has come. */
interface Live {
  question: string;
  text: string;
  thinking: string;
  tools: { name: string; done: boolean; ok: boolean }[];
  error: string | null;
}

function Bubble({ b, modelLabel }: { b: ChatBubble; modelLabel: (id?: string) => string }) {
  if (b.role === "user") {
    return (
      <div className="flex justify-end" data-testid="chat-user">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary/15 px-3 py-2 text-sm">{b.text}</div>
      </div>
    );
  }
  return (
    <div className="space-y-1.5" data-testid="chat-assistant">
      {b.tools.length > 0 && <ToolChips tools={b.tools.map((name) => ({ name, done: true, ok: true }))} />}
      <Markdown text={b.text} />
      {b.usage && (
        <p className="text-[10px] text-muted-foreground" title="Tokens read (of which served from the cache) and written, across every step of this answer">
          {modelLabel(b.model)} · {k(b.usage.input + b.usage.cached)} read{b.usage.cached ? ` (${k(b.usage.cached)} cached)` : ""} · {k(b.usage.output)} written
        </p>
      )}
    </div>
  );
}

function ToolChips({ tools }: { tools: { name: string; done: boolean; ok: boolean }[] }) {
  return (
    <div className="flex flex-wrap gap-1" data-testid="chat-tools">
      {tools.map((t, i) => (
        <span key={i} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${t.done && !t.ok ? "border-amber-500/50 text-amber-500" : "border-border text-muted-foreground"}`}>
          {!t.done ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : t.ok ? <Check className="h-2.5 w-2.5" /> : <X className="h-2.5 w-2.5" />}
          {TOOL_LABEL[t.name] ?? t.name}
        </span>
      ))}
    </div>
  );
}

/**
 * The owner's chat: a Claude model of their choosing, which reads the
 * screener, the open positions and the journal through the server's own
 * tools and answers from them. It reads; it cannot place or change a trade.
 */
export default function ChatPage() {
  const home = useChatHome();
  const { isPublic } = usePublicMode();
  const [threadId, setThreadId] = useState<number | null>(null);
  const thread = useChatThread(threadId);
  const del = useDeleteChatThread();
  const [model, setModel] = useState<string>(() => read(MODEL_KEY) ?? "");
  const [effort, setEffort] = useState<ChatEffort>(() => (["low", "medium", "high"].includes(read(EFFORT_KEY) ?? "") ? (read(EFFORT_KEY) as ChatEffort) : "medium"));
  const [draft, setDraft] = useState("");
  const [live, setLive] = useState<Live | null>(null);
  const stop = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement | null>(null);

  const models = home.data?.models ?? [];
  // The remembered model while it is still offered; else the server's default.
  const chosen = models.some((m) => m.id === model) ? model : (home.data?.defaultModel ?? models[0]?.id ?? "");
  const modelLabel = (id?: string) => models.find((m) => m.id === id)?.label ?? id ?? "";
  const bubbles = useMemo(() => (threadId != null ? (thread.data?.messages ?? []) : []), [threadId, thread.data]);
  const answering = !!live && !live.error;

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [bubbles.length, live?.text, live?.tools.length, live?.error]);
  // Leaving the page stops the answer: nobody is there to read it.
  useEffect(() => () => stop.current?.abort(), []);

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || answering || !chosen) return;
    setDraft("");
    setLive({ question, text: "", thinking: "", tools: [], error: null });
    const ctl = new AbortController();
    stop.current = ctl;
    let made: number | null = null;
    let answer = "";
    const used: string[] = [];
    let failed: string | null = null;
    let finished: ChatBubble | null = null;
    try {
      await streamChat({ threadId, model: chosen, effort, message: question }, (e) => {
        if (e.t === "thread") made = e.id;
        else if (e.t === "text") {
          answer += e.d;
          setLive((l) => (l ? { ...l, text: l.text + e.d } : l));
        } else if (e.t === "thinking") setLive((l) => (l ? { ...l, thinking: (l.thinking + e.d).slice(-400) } : l));
        else if (e.t === "tool") {
          used.push(e.name);
          setLive((l) => (l ? { ...l, tools: [...l.tools, { name: e.name, done: false, ok: true }] } : l));
        } else if (e.t === "tool_done")
          setLive((l) => {
            if (!l) return l;
            // The first of that name still running: calls of one round finish in the order they were made.
            const i = l.tools.findIndex((t) => t.name === e.name && !t.done);
            return i < 0 ? l : { ...l, tools: l.tools.map((t, j) => (j === i ? { ...t, done: true, ok: e.ok } : t)) };
          });
        else if (e.t === "error") failed = e.message;
        else if (e.t === "done") finished = { role: "assistant", text: answer.trim() + (e.note ? `\n\n_${e.note}_` : ""), tools: used, at: new Date().toISOString(), model: e.model, usage: e.usage };
      }, ctl.signal);
    } catch (err: any) {
      if (!ctl.signal.aborted) failed = String(err?.message ?? err);
    }
    stop.current = null;
    if (finished) {
      const id = made ?? threadId;
      if (id != null) {
        // Put where the conversation is read from, so the answer is on the page without a round trip.
        queryClient.setQueryData<ChatThread>(["/api/chat/threads", String(id)], (old) => ({
          id,
          title: old?.title ?? question.slice(0, 60),
          model: chosen,
          messages: [...(old?.messages ?? []), { role: "user", text: question, tools: [], at: new Date().toISOString() }, finished!],
        }));
        setThreadId(id);
      }
      setLive(null);
      void queryClient.invalidateQueries({ queryKey: ["/api/chat"], exact: true });
      return;
    }
    // Stopped or failed: nothing was stored, so the question goes back in the box.
    setDraft(question);
    setLive(failed ? { question, text: answer, thinking: "", tools: [], error: failed } : null);
  };

  const fresh = () => {
    stop.current?.abort();
    setThreadId(null);
    setLive(null);
  };

  if (isPublic) {
    return (
      <div className="space-y-4" data-testid="page-chat">
        <h1 className="text-xl font-bold tracking-tight">Chat</h1>
        <p className="text-sm text-muted-foreground">Hidden in public mode: the answers quote your positions and results.</p>
      </div>
    );
  }

  const select = "h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring";
  const empty = bubbles.length === 0 && !live;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3" data-testid="page-chat">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Chat</h1>
          <p className="text-[11px] text-muted-foreground">Reads your screener, positions and journal to answer. It cannot place or change a trade.</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <select className={`${select} max-w-[11rem]`} value={threadId ?? ""} onChange={(e) => (e.target.value ? (stop.current?.abort(), setLive(null), setThreadId(Number(e.target.value))) : fresh())} aria-label="Conversation" data-testid="chat-thread">
            <option value="">New conversation</option>
            {(home.data?.threads ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
          <Button size="sm" variant="ghost" className="h-8 px-2" onClick={fresh} title="Start a new conversation" data-testid="chat-new">
            <MessageSquarePlus className="h-4 w-4" />
          </Button>
          {threadId != null && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-muted-foreground hover:text-red-400"
              disabled={del.isPending || answering}
              onClick={() => {
                if (!window.confirm("Delete this conversation?")) return;
                del.mutate(threadId, { onSuccess: fresh });
              }}
              title="Delete this conversation"
              data-testid="chat-delete"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {home.data && !home.data.enabled && (
        <Card className="border-amber-500/40 bg-card p-3 text-xs text-amber-500" data-testid="chat-disabled">
          The chat needs ANTHROPIC_API_KEY set on the server (the same key the screener's AI read uses).
        </Card>
      )}

      <Card className="flex min-h-[50vh] flex-col border-card-border bg-card p-3 sm:p-4">
        <div className="flex-1 space-y-4" data-testid="chat-messages">
          {empty && (
            <div className="space-y-2 py-6">
              <p className="text-sm text-muted-foreground">Ask about the screener, your positions or your trading. For example:</p>
              <div className="flex flex-col gap-1.5">
                {STARTERS.map((s) => (
                  <button key={s} type="button" disabled={!home.data?.enabled} onClick={() => void send(s)} className="rounded-md border border-border px-3 py-2 text-left text-xs text-foreground/90 transition-colors hover:border-primary/40 disabled:opacity-50" data-testid="chat-starter">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {threadId != null && thread.isLoading && <p className="text-xs text-muted-foreground">Loading the conversation…</p>}
          {bubbles.map((b, i) => (
            <Bubble key={i} b={b} modelLabel={modelLabel} />
          ))}
          {live && (
            <>
              <Bubble b={{ role: "user", text: live.question, tools: [], at: "" }} modelLabel={modelLabel} />
              <div className="space-y-1.5" data-testid="chat-live">
                {live.tools.length > 0 && <ToolChips tools={live.tools} />}
                {live.text && <Markdown text={live.text} />}
                {!live.error && !live.text && (
                  <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin" />
                    <span className="line-clamp-2">{live.thinking ? live.thinking.split("\n").filter(Boolean).pop() : live.tools.length ? "Reading the data…" : "Thinking…"}</span>
                  </p>
                )}
                {live.error && (
                  <p className="text-xs text-amber-500" data-testid="chat-error">
                    {live.error} Your message is back in the box.
                  </p>
                )}
              </div>
            </>
          )}
          <div ref={end} />
        </div>

        <form
          className="mt-3 border-t border-border/60 pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send(draft);
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter is a new line. Not while an input method is composing a character.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(draft);
              }
            }}
            rows={2}
            placeholder={home.data?.enabled === false ? "No Anthropic key on the server" : "Ask about the screener, a coin, your positions, your trading…"}
            disabled={home.data?.enabled === false}
            className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
            aria-label="Message"
            data-testid="chat-input"
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <select
                className={select}
                value={chosen}
                onChange={(e) => {
                  setModel(e.target.value);
                  keep(MODEL_KEY, e.target.value);
                }}
                aria-label="Model"
                title={models.find((m) => m.id === chosen)?.note}
                data-testid="chat-model"
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id} title={m.note}>
                    {m.label}
                  </option>
                ))}
              </select>
              <select
                className={select}
                value={effort}
                onChange={(e) => {
                  setEffort(e.target.value as ChatEffort);
                  keep(EFFORT_KEY, e.target.value);
                }}
                aria-label="How hard it thinks"
                title="How hard the model thinks before answering: quicker and cheaper, or slower and more careful"
                data-testid="chat-effort"
              >
                {(home.data?.efforts ?? (["low", "medium", "high"] as ChatEffort[])).map((x) => (
                  <option key={x} value={x}>
                    {EFFORT_LABEL[x]}
                  </option>
                ))}
              </select>
              <span className="hidden text-[10px] text-muted-foreground sm:inline">{models.find((m) => m.id === chosen)?.note}</span>
            </div>
            {answering ? (
              <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => stop.current?.abort()} data-testid="chat-stop">
                <Square className="mr-1 h-3 w-3" /> Stop
              </Button>
            ) : (
              <Button type="submit" size="sm" className="h-8" disabled={!draft.trim() || !chosen || home.data?.enabled === false} data-testid="chat-send">
                <ArrowUp className="mr-1 h-3.5 w-3.5" /> Send
              </Button>
            )}
          </div>
        </form>
      </Card>
      <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
        <Wrench className="h-3 w-3" /> Answers come from the site's own data at the moment you ask. Billed to the server's Anthropic key per message; longer conversations and the larger models cost more.
      </p>
    </div>
  );
}
