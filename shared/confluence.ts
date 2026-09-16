/**
 * How many reasons a trade had.
 *
 * A journal should lead you to trade well, and the cheapest rule that does
 * is confluence: one reason is a hunch, two is a setup, three is a trade.
 * The reasons are the setup tags — the ones tapped on the card and the
 * ones pulled out of the rationale on save — so the count costs nothing
 * extra to keep, and it is the same number the breakdown slices on.
 */
import type { TradeWithTags } from "./schema";
import { normalizeSetupTags } from "./setups";

/** Two reasons lining up is where a hunch becomes a setup. */
export const CONFLUENCE_MIN = 2;

/** The reasons on a stored trade: the tags, deduped the way the picker dedupes them. */
export function confluencesOf(t: Pick<TradeWithTags, "rationaleTags">): string[] {
  if (!t.rationaleTags) return [];
  try {
    const parsed = JSON.parse(t.rationaleTags);
    if (!Array.isArray(parsed)) return [];
    return normalizeSetupTags(parsed.filter((s): s is string => typeof s === "string"));
  } catch {
    return [];
  }
}

export type ConfluenceBucket = "none" | "one" | "two" | "three-plus";

export function confluenceBucket(n: number): ConfluenceBucket {
  return n <= 0 ? "none" : n === 1 ? "one" : n === 2 ? "two" : "three-plus";
}

export const CONFLUENCE_LABELS: Record<ConfluenceBucket, string> = {
  none: "No reason named",
  one: "One reason",
  two: "Two reasons",
  "three-plus": "Three or more",
};

/** What the card says under the reasons, at the moment of the decision. */
export function confluenceNudge(n: number): string {
  if (n <= 0) return "No reason named yet. What is the setup?";
  if (n === 1) return "One reason is a hunch. What else lines up?";
  if (n === 2) return "Two reasons — a setup.";
  return `${n} reasons — a trade.`;
}
