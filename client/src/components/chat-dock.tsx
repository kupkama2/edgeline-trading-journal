import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Loader2, MessagesSquare } from "lucide-react";
import { usePublicMode } from "@/lib/public-mode";

// The panel brings the charts with it; it is fetched the first time the window is opened.
const ChatPanel = lazy(() => import("@/components/chat-panel"));

const OPEN_KEY = "edgeline.chat.open";

/**
 * The chat, as a window in the bottom right corner of every page: a button
 * that opens it, and a window that folds back into the button. Once opened
 * it stays mounted, folded or not, so the conversation and a half-written
 * answer survive a change of tab. Not drawn in public mode: the answers
 * quote positions and results.
 */
export function ChatDock() {
  const { isPublic } = usePublicMode();
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  // Mounted from the first opening on.
  const [used, setUsed] = useState(open);
  const [busy, setBusy] = useState(false);
  const show = useCallback((next: boolean) => {
    setOpen(next);
    if (next) setUsed(true);
    try {
      localStorage.setItem(OPEN_KEY, next ? "1" : "0");
    } catch {
      /* fine */
    }
  }, []);
  // Escape folds it, from anywhere inside it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && show(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, show]);
  if (isPublic) return null;
  return (
    <>
      {used && (
        <div
          className={`fixed bottom-3 right-3 z-50 flex h-[min(640px,calc(100dvh-5rem))] w-[min(440px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl ${open ? "" : "hidden"}`}
          role="dialog"
          aria-label="Chat"
          data-testid="chat-dock"
        >
          <Suspense fallback={<p className="flex flex-1 items-center justify-center text-xs text-muted-foreground">Loading the chat…</p>}>
            <ChatPanel onFold={() => show(false)} onBusy={setBusy} />
          </Suspense>
        </div>
      )}
      {!open && (
        <button
          type="button"
          onClick={() => show(true)}
          className="fixed bottom-3 right-3 z-50 flex h-11 items-center gap-1.5 rounded-full border border-border bg-card px-4 text-sm font-medium shadow-lg transition-colors hover:border-primary/50"
          title="Open the chat"
          data-testid="chat-open"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin text-sky-400" /> : <MessagesSquare className="h-4 w-4" />}
          {busy ? "Answering…" : "Chat"}
        </button>
      )}
    </>
  );
}
