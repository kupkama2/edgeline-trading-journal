import { createContext, useContext, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BookOpen } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest, queryClient } from "./queryClient";
import {
  CURRENT,
  chapterSpans,
  spanFor,
  spanLabel,
  type Chapter,
  type ChapterSpan,
  type ChapterView,
} from "@shared/chapters";
import type { InsertChapter } from "@shared/schema";

export { CURRENT, spanLabel, type Chapter, type ChapterSpan, type ChapterView };

/**
 * Which chapter the journal is showing.
 *
 * The rule is in shared/chapters.ts; this holds the chapters and the choice.
 * The choice is deliberately NOT remembered: a fresh start means the slate
 * is clean every time the journal is opened, and looking back is something
 * you do on purpose, from the stats or the calendar, and leave behind when you navigate away
 * or reload. There is a chip in the header the whole time it is on.
 */
const Ctx = createContext<{
  chapters: Chapter[];
  spans: ChapterSpan[];
  /** The chapter being written now; null when there has never been a fresh start. */
  current: ChapterSpan | null;
  /** The span on screen; null when every chapter is. */
  shown: ChapterSpan | null;
  view: ChapterView;
  setView: (v: ChapterView) => void;
}>({
  chapters: [],
  spans: [],
  current: null,
  shown: null,
  view: CURRENT,
  setView: () => {},
});

export const useChapters = () => useContext(Ctx);

export function ChapterProvider({ children }: { children: React.ReactNode }) {
  const { data: chapters = [] } = useQuery<Chapter[]>({ queryKey: ["/api/chapters"] });
  const [view, setView] = useState<ChapterView>(CURRENT);
  const value = useMemo(() => {
    const spans = chapterSpans(chapters);
    return {
      chapters,
      spans,
      current: spans.length ? spans[spans.length - 1] : null,
      shown: spanFor(spans, view),
      view,
      setView,
    };
  }, [chapters, view]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/chapters"] });

export function useStartChapter() {
  return useMutation({
    mutationFn: async (c: InsertChapter) => (await apiRequest("POST", "/api/chapters", c)).json() as Promise<Chapter>,
    onSuccess: invalidate,
  });
}

export function useUpdateChapter() {
  return useMutation({
    mutationFn: async (v: { id: number } & InsertChapter) => {
      const { id, ...patch } = v;
      return (await apiRequest("PATCH", `/api/chapters/${id}`, patch)).json() as Promise<Chapter>;
    },
    onSuccess: invalidate,
  });
}

export function useDeleteChapter() {
  return useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/chapters/${id}`);
    },
    onSuccess: invalidate,
  });
}

const day = (ms: number) => {
  const d = new Date(ms);
  const thisYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(thisYear ? {} : { year: "numeric" }) });
};

/** "since 13 Oct", "3 Aug – 13 Oct", "until 3 Aug" — the span in words. */
export function spanRange(span: ChapterSpan): string {
  if (!Number.isFinite(span.from)) return span.to == null ? "everything" : `until ${day(span.to)}`;
  return span.to == null ? `since ${day(span.from)}` : `${day(span.from)} – ${day(span.to)}`;
}

/**
 * The one switch, on the stats page and the calendar.
 *
 * Newest chapter first, then the record before any fresh start, then
 * everything at once. Absent until there has been a fresh start: a journal
 * with one chapter has nothing to switch between, and a control that does
 * nothing is a question nobody asked.
 */
export function ChapterSwitch() {
  const { spans, view, setView } = useChapters();
  if (spans.length === 0) return null;
  const value = view.kind === "all" ? "all" : view.kind === "current" ? "current" : `c:${view.id}`;
  const pick = (v: string) =>
    setView(v === "all" ? { kind: "all" } : v === "current" ? CURRENT : { kind: "chapter", id: Number(v.slice(2)) });
  return (
    <Select value={value} onValueChange={pick}>
      <SelectTrigger
        className="h-8 w-auto gap-1.5 text-xs"
        aria-label="Which chapter to show"
        data-testid="select-chapter"
      >
        <BookOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {[...spans].reverse().map((s) => (
          <SelectItem key={s.id} value={s.current ? "current" : `c:${s.id}`} data-testid={`option-chapter-${s.id}`}>
            {spanLabel(s)} <span className="text-muted-foreground">· {spanRange(s)}</span>
          </SelectItem>
        ))}
        <SelectItem value="all" data-testid="option-chapter-all">
          Everything <span className="text-muted-foreground">· all chapters</span>
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
