import { toast } from "@/hooks/use-toast";

/**
 * Say that an action did not happen.
 *
 * One-click actions — a verdict toggle, a delete, a mark — used to fire a
 * mutation with nothing listening for its failure, so a cold start or an
 * expired session left the button looking as if it had worked. This is the
 * one place that says otherwise, in the same words everywhere.
 */
export function reportFailure(what: string, err: unknown): void {
  toast({
    title: `${what} — not saved`,
    description: String((err as any)?.message ?? err).replace(/^\d+:\s*/, "").slice(0, 200),
    variant: "destructive",
  });
}

/** An onError for a mutation call: `update.mutate(v, { onError: failed("Tilt") })`. */
export const failed = (what: string) => (err: unknown) => reportFailure(what, err);
