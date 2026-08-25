import { useEffect, useRef } from "react";
import { store } from "@/lib/scoped-storage";
import { useCheckOutcomes } from "@/lib/data";
import { useToast } from "@/hooks/use-toast";

/**
 * Ask the market, when you open the journal.
 *
 * Two things come back: which level a parked trade would have reached, and
 * the path numbers — MAE, MFE, and what price did after the exit — for any
 * trade that never recorded them.
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
      last = Number(store.get(LAST_KEY) ?? 0);
    } catch {
      /* private mode: check anyway, the server throttle still holds */
    }
    if (Date.now() - last < MIN_GAP_MS) return;
    firedThisMount.current = true;
    try {
      store.set(LAST_KEY, String(Date.now()));
    } catch {
      /* nothing to do */
    }

    check
      .mutateAsync()
      .then((res: any) => {
        const hits = res?.resolved ?? [];
        const measured = res?.measured ?? [];
        if (hits.length === 0) {
          // Nothing settled, but the path may still have been filled in —
          // worth a quieter word, because those numbers appearing on their
          // own would otherwise look like the journal editing itself.
          if (measured.length) {
            toast({
              title: `Filled in the price path on ${measured.length} trade${measured.length === 1 ? "" : "s"}`,
              description: "MAE, MFE and what happened after the exit, read from the candles.",
            });
          }
          return;
        }
        /*
         * One toast for the whole run rather than one per trade. A batch of
         * six on a Monday morning would otherwise stack into a wall nobody
         * reads, and the interesting number is how many resolved, not which
         * fired first — the rows carry the detail.
         */
        const first = hits[0];
        const rest = hits.length - 1;
        const also = measured.length ? ` Path filled in on ${measured.length}.` : "";
        toast({
          title:
            hits.length === 1
              ? `${first.symbol} would have hit its ${first.verdict === "target_first" ? "target" : "stop"}`
              : `${hits.length} trades settled themselves`,
          description:
            (hits.length === 1
              ? `Left alone it reached the ${first.verdict === "target_first" ? "target" : "stop"} on ${new Date(first.hitAt).toLocaleDateString()}. Read from ${first.pair}.`
              : `${first.symbol}${rest ? ` and ${rest} more` : ""} — the market answered what would have happened.`) + also,
        });
      })
      .catch(() => {
        // A price feed being unreachable is not worth interrupting anyone
        // over. The trades simply stay parked, which is where they were.
      });
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps
}
