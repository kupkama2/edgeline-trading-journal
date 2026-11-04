import { useEffect } from "react";
import { queryClient } from "./queryClient";
import { invalidateTrades } from "./data";

/**
 * The page kept current without a refresh.
 *
 * One long-lived connection to /api/events; the server says "trades" when
 * anything wrote to the record — a position the tracker found, a stop
 * moved, a fill — and "settings" when a relay came or went. Each word is a
 * cue to ask for that data again; nothing is pushed but the cue. The
 * browser reconnects on its own when the connection drops.
 */
export function useLiveUpdates(): void {
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const es = new EventSource("/api/events");
    const trades = () => {
      invalidateTrades();
      void queryClient.invalidateQueries({ queryKey: ["/api/terminal/trades"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/marks"] });
    };
    const settings = () => void queryClient.invalidateQueries({ queryKey: ["/api/account-settings"] });
    es.addEventListener("trades", trades);
    es.addEventListener("settings", settings);
    return () => es.close();
  }, []);
}
