/**
 * Which open trades still want your attention.
 *
 * An open list that treats every position alike puts a runner with a third
 * left and its stop at breakeven beside a full-size trade a hair from its
 * stop, and the one that needs a decision is lost among the ones that have
 * had theirs. So an open trade counts as MANAGED — lower priority, still
 * open, still counted — when any of these is true:
 *
 *   marked     you said so: "majority out", one click, no numbers.
 *   scaled     the recorded partials leave a third of the position or less.
 *   risk-off   the stop is at or through the entry: nothing left to lose.
 *
 * Only the mark is yours to take back; the other two are read off the record
 * and change when the record does.
 */
import type { Trade, TradeFill } from "./schema";
import { baseQty, positionLedger } from "./fills";
import { riskLeft } from "./stops";

export type ManagedWhy = "marked" | "scaled" | "risk-off";

/** A third or less of what went on is still on. */
export const RUNNER_SHARE = 1 / 3;

type T = Trade & { fills?: TradeFill[] };

export function managedBy(t: T): ManagedWhy | null {
  if (t.status !== "open") return null;
  if (t.managedAt) return "marked";
  if ((t.fills ?? []).some((f) => f.kind === "partial")) {
    const led = positionLedger(t);
    const added = (t.fills ?? [])
      .filter((f) => f.kind === "add")
      .reduce((s, f) => s + baseQty(f.size, t.sizeUnit, f.price), 0);
    const total = led.initialQty + added;
    if (total > 0 && led.openQty / total <= RUNNER_SHARE + 1e-9) return "scaled";
  }
  if (riskLeft(t) === 0) return "risk-off";
  return null;
}

export const MANAGED_LABEL: Record<ManagedWhy, { badge: string; title: string }> = {
  marked: { badge: "majority out", title: "Marked as majority out — the rest is running." },
  scaled: { badge: "⅓ or less left", title: "The partials you recorded leave a third of the position or less." },
  "risk-off": { badge: "risk off", title: "The stop is at or through the entry, so this cannot lose from here." },
};

/** Open trades split into the ones that want a decision and the ones that have had one. */
export function splitOpen<U extends T>(open: U[]): { toManage: U[]; managed: { t: U; why: ManagedWhy }[] } {
  const toManage: U[] = [];
  const managed: { t: U; why: ManagedWhy }[] = [];
  for (const t of open) {
    const why = managedBy(t);
    if (why) managed.push({ t, why });
    else toManage.push(t);
  }
  return { toManage, managed };
}
