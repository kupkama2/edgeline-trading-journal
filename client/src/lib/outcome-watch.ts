import { useEffect, useRef } from "react";
import { useCheckOutcomes } from "@/lib/data";
import { useToast } from "@/hooks/use-toast";

/**
 * Ask the market, when you open the journal.
 *
 * Not a cron. A scheduled worker would need to stay awake on a host that
 * sleeps when nobody is using it, to answer a question nobody is looking at
 * the answer to — the trades this settles are ones you find out about the
 * next time you open the app either way. Checking on load gets the same
 * result with no infrastructure, and it means the moment you have the app
 * open is the moment the list is right.
 *
 * Throttled twice over: once here so navigating around the app does not
 * re-ask, and once on the server so an individual trade is not re-read more
 * than hourly however often this fires.
 */
const MIN_GAP_MS = 15 * 60 * 1000;
const LAST_KEY = "edgeline.outcomes.lastCheck";

export function useOutcomeWatch(enabled: boolean) {
  const check = useCheckOutcomes();
  const { toast } = useToast();
  // Survives the effect being re-run; the localStorage stamp survives reloads.
  const firedThisMount = useRef(false);

  useEffect(() => {
    if (!enabled || firedThisMount.current) return;
    let last = 0;
    try {
      last = Number(localStorage.getItem(LAST_KEY) ?? 0);
    } catch {
      /* private mode: check anyway, the server throttle still holds */
    }
    if (Date.now() - last < MIN_GAP_MS) return;
    firedThisMount.current = true;
    try {
      localStorage.setItem(LAST_KEY, String(Date.now()));
    } catch {
      /* nothing to do */
    }

    check
      .mutateAsync()
      .then((res: any) => {
        const hits = res?.resolved ?? [];
        if (hits.length === 0) return;
        /*
         * One toast for the whole run rather than one per trade. A batch of
         * six on a Monday morning would otherwise stack into a wall nobody
         * reads, and the interesting number is how many resolved, not which
         * fired first — the rows carry the detail.
         */
        const first = hits[0];
        const rest = hits.length - 1;
        toast({
          title:
            hits.length === 1
              ? `${first.symbol} would have hit its ${first.verdict === "target_first" ? "target" : "stop"}`
              : `${hits.length} trades settled themselves`,
          description:
            hits.length === 1
              ? `Left alone it reached the ${first.verdict === "target_first" ? "target" : "stop"} on ${new Date(first.hitAt).toLocaleDateString()}. Filled in from ${first.pair}.`
              : `${first.symbol}${rest ? ` and ${rest} more` : ""} — the market answered what would have happened. Filled in from Binance.`,
        });
      })
      .catch(() => {
        // A price feed being unreachable is not worth interrupting anyone
        // over. The trades simply stay parked, which is where they were.
      });
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps
}
