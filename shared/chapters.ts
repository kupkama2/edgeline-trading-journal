/**
 * Starting over without throwing anything away.
 *
 * After a blow-up the useful thing is a clean slate: a journal whose first
 * page is today, whose statistics have no memory of last month, whose review
 * queue is empty. The DESTRUCTIVE way to get one — delete the record — also
 * deletes the only evidence of what went wrong, and the record of a bad month
 * is worth more than the record of a good one.
 *
 * So a fresh start is a date, not a deletion. Every trade stays stored.
 * Everything entered from that moment on is the current chapter, and that is
 * all any page shows by default. The chapters before it are still there,
 * complete, one switch away in the stats — on their own, or alongside
 * everything since — and the switch resets on every visit, so the slate is
 * clean each time the journal is opened and the past is a choice.
 *
 * One rule, shared by every page: a trade belongs to the chapter its entry
 * falls in. A position still open belongs to NOW whatever its date, because
 * starting over does not close it, and a journal that hid a live position
 * from its owner would be lying about the one thing that matters most.
 */
import type { Chapter } from "./schema";

export type { Chapter };

export interface ChapterSpan {
  /** 0 for the record before any fresh start; otherwise the chapter's id. */
  id: number;
  /** 1-based, oldest first — what the chapter is called when it has no name. */
  index: number;
  name: string | null;
  /** Epoch ms; -Infinity for the beginning of the record. */
  from: number;
  /** Epoch ms of the next chapter's start; null for the one still being written. */
  to: number | null;
  current: boolean;
}

/** Which chapter a page is looking at. The default is always the current one. */
export type ChapterView = { kind: "current" } | { kind: "all" } | { kind: "chapter"; id: number };
export const CURRENT: ChapterView = { kind: "current" };

const at = (iso: string) => Date.parse(iso);

/**
 * The chapters as spans of time, oldest first.
 *
 * No fresh start, no spans: the record is one unbroken chapter and nothing
 * needs a name. One fresh start makes two — the record before it, which is
 * unnamed and begins at the beginning, and the chapter it opened.
 */
export function chapterSpans(chapters: ReadonlyArray<Chapter>): ChapterSpan[] {
  const starts = chapters
    .map((c) => ({ c, t: at(c.startedAt) }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t || a.c.id - b.c.id);
  if (starts.length === 0) return [];
  const spans: ChapterSpan[] = [
    { id: 0, index: 1, name: null, from: Number.NEGATIVE_INFINITY, to: starts[0].t, current: false },
  ];
  starts.forEach(({ c, t }, i) => {
    spans.push({
      id: c.id,
      index: i + 2,
      name: c.name?.trim() || null,
      from: t,
      to: i + 1 < starts.length ? starts[i + 1].t : null,
      current: i + 1 === starts.length,
    });
  });
  return spans;
}

/** The span a view names, or the current one when it names nothing that exists. */
export function spanFor(spans: ReadonlyArray<ChapterSpan>, view: ChapterView): ChapterSpan | null {
  if (spans.length === 0 || view.kind === "all") return null;
  if (view.kind === "chapter") {
    const found = spans.find((s) => s.id === view.id);
    if (found) return found;
  }
  return spans[spans.length - 1];
}

/** A trade still being traded, which no fresh start can put in the past. */
const live = (status: string) => status === "open" || status === "pending";

/** Whether a trade is part of a span, by its entry — or by being open, for the current one. */
export function inSpan(t: { entryTime: string; status: string }, span: ChapterSpan): boolean {
  const when = at(t.entryTime);
  const within = when >= span.from && (span.to == null || when < span.to);
  return within || (span.current && live(t.status));
}

/** The trades a view shows. Everything, when there are no chapters or the view asks for all. */
export function chapterTrades<T extends { entryTime: string; status: string }>(
  trades: ReadonlyArray<T>,
  chapters: ReadonlyArray<Chapter>,
  view: ChapterView,
): T[] {
  const span = spanFor(chapterSpans(chapters), view);
  return span ? trades.filter((t) => inSpan(t, span)) : trades.slice();
}

/** "Chapter 2", or the name it was given. */
export const spanLabel = (span: ChapterSpan) => span.name ?? `Chapter ${span.index}`;

/**
 * Whether a fresh start may begin at this instant: any time up to now, with
 * a minute's grace for a clock that is slightly ahead. A start in the future
 * would empty the journal of everything but its open positions until the
 * date arrived, which is never what anyone meant.
 */
export function freshStartRefusal(startedAt: string, now = Date.now()): string | null {
  const t = at(startedAt);
  if (!Number.isFinite(t)) return "That is not a date.";
  if (t > now + 60_000) return "A fresh start begins now or earlier, not in the future.";
  return null;
}
