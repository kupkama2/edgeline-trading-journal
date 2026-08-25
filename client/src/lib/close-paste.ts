import { useEffect, useRef, useState } from "react";
import { fileToDownscaledDataUrl, parseScreenshot } from "@/lib/data";
import { normalizeCloseCard, type CloseCard } from "@shared/close-card";
import type { TradeWithTags } from "@shared/schema";

/**
 * Ctrl-V on a live trade means "here is how it ended".
 *
 * The exchange already knows the average fill and the exact second, and
 * re-typing them off a screenshot is both the dullest part of journalling and
 * where the numbers quietly drift from what happened. On a trade that is still
 * running there is only one thing a pasted image can sensibly be, so it is
 * read as a closed-position card without asking which kind it is.
 *
 * Only while the trade is live. Pasting on a closed trade is how you attach a
 * chart, and hijacking that to re-close an already-closed trade would take a
 * working gesture away to guess at an intention nobody had.
 */
export function useCloseCardPaste({
  trade,
  enabled,
  onCard,
  onError,
}: {
  trade: TradeWithTags | null;
  enabled: boolean;
  onCard: (card: CloseCard) => void;
  onError?: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  // The handler is installed once per enablement, so it must not close over a
  // stale trade: an editor left open while the row refetches would send the
  // model context from a minute ago.
  const live = useRef({ trade, onCard, onError });
  live.current = { trade, onCard, onError };

  useEffect(() => {
    if (!enabled) return;

    async function read(file: File) {
      const { trade: t, onCard: hit, onError: fail } = live.current;
      if (!t) return;
      setBusy(true);
      try {
        const dataUrl = await fileToDownscaledDataUrl(file);
        const raw = await parseScreenshot(dataUrl, "close", {
          symbol: t.symbol,
          direction: t.direction,
          entryPrice: t.entryPrice,
        });
        hit(normalizeCloseCard(raw));
      } catch (err: any) {
        fail?.(String(err?.message ?? err).slice(0, 160));
      } finally {
        setBusy(false);
      }
    }

    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (!items[i].type.startsWith("image/")) continue;
        const file = items[i].getAsFile();
        if (!file) return;
        e.preventDefault();
        void read(file);
        return;
      }
    }

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [enabled]);

  return { busy };
}
