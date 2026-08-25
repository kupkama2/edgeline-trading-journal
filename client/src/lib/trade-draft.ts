/**
 * Unsaved edits, kept.
 *
 * The trade editor used to hold everything typed in React state and nowhere
 * else, which meant two ways to lose it. The loud one: anything that refetched
 * the trade — logging a partial, a background invalidation — handed the editor
 * a new object, its hydrate effect fired, and every field snapped back to the
 * stored row mid-sentence. The quiet one: closing the panel to go check a
 * chart threw the work away with no warning at all.
 *
 * So the draft outlives the component. It is written on every keystroke,
 * restored when the trade is opened again, and dropped the moment a save
 * succeeds — at which point the stored row IS the draft and keeping a copy
 * would only be a way for the two to disagree later.
 *
 * The one rule that keeps this from becoming its own bug: a draft is stored
 * only while it DIFFERS from the trade as saved. Round-tripping through the
 * editor without changing anything must leave nothing behind, or every trade
 * ever opened would come back wearing a "restored unsaved edits" banner.
 */

import type { TradeWithTags } from "@shared/schema";
import { store } from "@/lib/scoped-storage";
import { parseExtraTargets } from "@shared/schema";
import { parseHighlights } from "@shared/highlights";
import { typedSymbol } from "@shared/symbols";
import { parseTags, toLocalInput } from "@/components/trade-shared";

export interface TradeDraft {
  /** The text fields, exactly as the editor holds them. */
  f: Record<string, string>;
  direction: "long" | "short";
  exitReason: string | null;
  nmo: string | null;
  selectedTags: number[];
  extraTps: string[];
  highlights: string[];
  grades: { entry: string | null; stop: string | null; exit: string | null };
  account: string;
  source: string;
  styleId: number | null;
  sizeUnit: "base" | "quote";
  lifecycle: "pending" | "open" | "closed";
}

export interface StoredDraft {
  draft: TradeDraft;
  /** When it was last typed into, for the banner. */
  savedAt: string;
}

/*
 * Scoped to the signed-in account by lib/scoped-storage, and that is not
 * housekeeping: trade ids are global, so an unscoped draft key meant opening
 * YOUR trade 42 could restore somebody else's unsaved edits into the editor
 * and let you save them onto it.
 */
const key = (tradeId: number) => `edgeline.draft.trade.${tradeId}`;

/**
 * Is this draft actually different from what is saved?
 *
 * Compared field by field rather than by JSON string so key order and the
 * shape the editor happens to build cannot make an identical draft look
 * changed. Arrays compare as ordered lists, which is right: the order of
 * scale-out levels is meaningful, and the order tags were picked in is what
 * the editor will write back.
 */
export function draftDiffers(a: TradeDraft, b: TradeDraft): boolean {
  const keys = Array.from(new Set(Object.keys(a.f).concat(Object.keys(b.f))));
  for (const k of keys) {
    // Absent and empty are the same thing in a text field — a field the
    // editor never populated must not read as an edit.
    if ((a.f[k] ?? "") !== (b.f[k] ?? "")) return true;
  }
  if (a.direction !== b.direction) return true;
  if (a.exitReason !== b.exitReason) return true;
  if (a.nmo !== b.nmo) return true;
  if (a.account !== b.account) return true;
  if (a.source !== b.source) return true;
  if (a.styleId !== b.styleId) return true;
  if (a.sizeUnit !== b.sizeUnit) return true;
  if (a.lifecycle !== b.lifecycle) return true;
  if (a.grades.entry !== b.grades.entry) return true;
  if (a.grades.stop !== b.grades.stop) return true;
  if (a.grades.exit !== b.grades.exit) return true;
  if (!sameList(a.selectedTags, b.selectedTags)) return true;
  if (!sameList(a.extraTps, b.extraTps)) return true;
  if (!sameList(a.highlights, b.highlights)) return true;
  return false;
}

const sameList = <T>(a: T[], b: T[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Keep the draft if it says something, drop it if it doesn't.
 *
 * One function rather than a save and a separate clear, because "it matches
 * the saved trade now" and "there is no draft" have to be the same state.
 * Two call sites deciding that independently is how a stale draft survives
 * being undone by hand.
 */
export function stashDraft(tradeId: number, draft: TradeDraft, saved: TradeDraft): void {
  try {
    if (!draftDiffers(draft, saved)) {
      store.remove(key(tradeId));
      return;
    }
    const stored: StoredDraft = { draft, savedAt: new Date().toISOString() };
    store.set(key(tradeId), JSON.stringify(stored));
  } catch {
    // A full or blocked localStorage must never take the editor down with it.
    // Losing the draft is the old behaviour; losing the session is worse.
  }
}

export function readDraft(tradeId: number): StoredDraft | null {
  try {
    const raw = store.get(key(tradeId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Anything that isn't the shape we wrote is treated as absent rather than
    // spread over the form — a half-restored draft is worse than none.
    if (!parsed?.draft?.f || typeof parsed.draft.f !== "object") return null;
    return parsed as StoredDraft;
  } catch {
    return null;
  }
}

export function clearDraft(tradeId: number): void {
  try {
    store.remove(key(tradeId));
  } catch {
    /* nothing to do — the draft is advisory */
  }
}

/** "3 minutes ago" for the restored-edits banner. */
export function agoLabel(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!isFinite(then)) return "earlier";
  const mins = Math.round((now - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * The trade as stored, in the editor's own shape.
 *
 * Both the thing the form loads and the thing a draft is compared against, on
 * purpose. Two functions — one to hydrate, one to decide "has anything
 * changed" — is how a form ends up permanently dirty over a field that only
 * one of them formats: every trade opened would then be handed back wearing
 * a restored-edits banner it never earned.
 */
export function draftFromTrade(trade: TradeWithTags): TradeDraft {
  const str = (v: number | null | undefined) => (v != null ? String(v) : "");
  return {
    f: {
      // The contract as written when there was one — see typedSymbol. Showing
      // the rollup here is what made editing an MBTZ6 trade save it as "BTC".
      symbol: typedSymbol(trade),
      size: String(trade.size),
      entryPrice: String(trade.entryPrice),
      // Pending trades have no stop/target yet — String(null) would put the
      // literal text "null" in the field for the user to delete by hand.
      initialStop: str(trade.initialStop),
      initialTarget: str(trade.initialTarget),
      entryTime: toLocalInput(trade.entryTime),
      exitPrice: str(trade.exitPrice),
      exitTime: toLocalInput(trade.exitTime),
      mae: str(trade.mae),
      mfe: str(trade.mfe),
      postExitPeak: str(trade.postExitPeak),
      postExitAdverse: str(trade.postExitAdverse),
      rationale: trade.rationale ?? "",
      rationaleTags: parseTags(trade.rationaleTags).join(", "),
      notes: trade.notes ?? "",
      account: trade.account ?? "",
      fees: str(trade.fees),
    },
    direction: trade.direction === "short" ? "short" : "long",
    exitReason: trade.exitReason ?? null,
    nmo: trade.noManagementOutcome ?? null,
    selectedTags: trade.mistakeTagIds,
    extraTps: parseExtraTargets(trade.extraTargets).map(String),
    highlights: parseHighlights(trade.highlights),
    grades: {
      entry: trade.entryGrade ?? null,
      stop: trade.stopGrade ?? null,
      exit: trade.exitGrade ?? null,
    },
    account: trade.account ?? "",
    source: trade.source ?? "",
    styleId: trade.styleId ?? null,
    sizeUnit: trade.sizeUnit === "quote" ? "quote" : "base",
    lifecycle:
      trade.status === "pending" ? "pending" : trade.status === "closed" ? "closed" : "open",
  };
}
