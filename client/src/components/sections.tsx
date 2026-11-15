import { Children, isValidElement, useState, type ReactElement, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ChevronUp, GripVertical } from "lucide-react";

/**
 * One named part of a page, inside <Sections>. It draws nothing by itself:
 * the list around it gives it a header to fold it by and to move it with.
 */
export function Section(_props: { id: string; title: string; hint?: string; defaultOpen?: boolean; children: ReactNode }): null {
  return null;
}
type SectionEl = ReactElement<Parameters<typeof Section>[0]>;

const read = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
};
const write = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* a browser that keeps nothing still shows the page */
  }
};

/** The order to draw in: the kept order first, then anything it does not mention, where the page put it. */
export function orderOf(ids: string[], kept: string[]): string[] {
  const known = kept.filter((id) => ids.includes(id));
  return [...known, ...ids.filter((id) => !known.includes(id))];
}

/** `id` taken out and put back before or after `target`. */
export function moved(order: string[], id: string, target: string, after: boolean): string[] {
  if (id === target) return order;
  const rest = order.filter((x) => x !== id);
  const at = rest.indexOf(target);
  if (at < 0) return order;
  rest.splice(at + (after ? 1 : 0), 0, id);
  return rest;
}

const DRAG_TYPE = "application/x-edgeline-section";

/**
 * A page's sections, each folding away under its name and movable: dragged
 * by its header, or stepped up and down with the arrows (which is how it is
 * done on a phone, where dragging scrolls). The order and what is folded
 * are kept in the browser, per list. A section the page does not draw this
 * time keeps its place for when it is back.
 */
export function Sections({ id, children }: { id: string; children: ReactNode }) {
  const orderKey = `edgeline.sections.${id}.order`;
  const foldKey = `edgeline.sections.${id}.folded`;
  const items = Children.toArray(children).filter((c): c is SectionEl => isValidElement(c) && c.type === Section);
  const ids = items.map((c) => c.props.id);
  const [kept, setKept] = useState<string[]>(() => read<string[]>(orderKey, []));
  const [folded, setFolded] = useState<Record<string, boolean>>(() => read<Record<string, boolean>>(foldKey, {}));
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);

  const order = orderOf(ids, kept);
  const save = (next: string[]) => {
    // Sections not on the page now stay in the kept order, after the ones that are.
    const full = [...next, ...kept.filter((k) => !next.includes(k))];
    setKept(full);
    write(orderKey, full);
  };
  const toggle = (sid: string, open: boolean) => {
    const next = { ...folded, [sid]: open };
    setFolded(next);
    write(foldKey, next);
  };
  const step = (sid: string, by: -1 | 1) => {
    const at = order.indexOf(sid);
    const to = at + by;
    if (to < 0 || to >= order.length) return;
    save(moved(order, sid, order[to], by > 0));
  };

  return (
    <div className="space-y-4" data-testid={`sections-${id}`}>
      {order.map((sid, i) => {
        const el = items.find((c) => c.props.id === sid)!;
        const { title, hint, defaultOpen = true } = el.props;
        const isFolded = sid in folded ? folded[sid] : !defaultOpen;
        const target = over?.id === sid && dragging && dragging !== sid;
        return (
          <section
            key={sid}
            data-testid={`section-${sid}`}
            data-open={isFolded ? "0" : "1"}
            className={`relative ${dragging === sid ? "opacity-50" : ""}`}
            onDragOver={(e) => {
              if (!dragging || !Array.from(e.dataTransfer.types).includes(DRAG_TYPE)) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              const after = e.clientY > r.top + r.height / 2;
              if (over?.id !== sid || over.after !== after) setOver({ id: sid, after });
            }}
            onDrop={(e) => {
              if (!dragging) return;
              e.preventDefault();
              if (over) save(moved(order, dragging, over.id, over.after));
              setDragging(null);
              setOver(null);
            }}
          >
            {target && <div className={`pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded bg-primary ${over!.after ? "-bottom-2" : "-top-2"}`} />}
            <div
              className={`group flex items-center gap-1 ${isFolded ? "rounded-lg border border-border bg-card px-2 py-2" : "mb-1.5 px-0.5"}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, sid);
                e.dataTransfer.effectAllowed = "move";
                setDragging(sid);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
            >
              <span className="hidden cursor-grab text-muted-foreground/60 hover:text-foreground active:cursor-grabbing sm:inline" title="Drag to move this section" aria-hidden>
                <GripVertical className="h-3.5 w-3.5" />
              </span>
              <button
                type="button"
                onClick={() => toggle(sid, !isFolded)}
                aria-expanded={!isFolded}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
                title={isFolded ? `Open ${title}` : `Fold ${title} away`}
                data-testid={`section-toggle-${sid}`}
              >
                {isFolded ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
                <span className="shrink-0">{title}</span>
                {isFolded && hint && <span className="truncate font-normal normal-case tracking-normal">· {hint}</span>}
              </button>
              <span className="flex shrink-0 items-center text-muted-foreground/70 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:focus-within:opacity-100">
                <button type="button" className="rounded p-1 hover:bg-secondary hover:text-foreground disabled:opacity-30" onClick={() => step(sid, -1)} disabled={i === 0} title="Move up" aria-label={`Move ${title} up`} data-testid={`section-up-${sid}`}>
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button type="button" className="rounded p-1 hover:bg-secondary hover:text-foreground disabled:opacity-30" onClick={() => step(sid, 1)} disabled={i === order.length - 1} title="Move down" aria-label={`Move ${title} down`} data-testid={`section-down-${sid}`}>
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
            {!isFolded && el.props.children}
          </section>
        );
      })}
    </div>
  );
}
